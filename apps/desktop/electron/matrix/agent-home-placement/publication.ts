/**
 * What a migrated agent says in a room (`atum.agent-home/2.1`, `matrix.publication.enqueue`).
 *
 * An agent whose home the placement model governs never sends into a room itself. A send from a Mac that has
 * just lost its home is exactly the double answer the model exists to stop, and a direct send cannot be ordered
 * against a move. So this Mac prepares the final Matrix event (the SDK encrypts it for an encrypted room), hashes
 * and signs it, and hands the exact bytes to the platform, whose worker sends them under the placement lock. The
 * platform's ledger (the invocation or occurrence the result belongs to) records the event once every part is out.
 *
 * What this module promises:
 *
 *   - The bytes are fixed once. The record (outbox id, transaction id, event type, bytes, hash, part) is written
 *     before the first POST and every later attempt, in this run or after a restart, presents it unchanged; the SDK
 *     is never asked to prepare the same publication twice (a second encryption would be different bytes).
 *   - Every attempt is signed fresh against a fresh read of the placement and this Mac's lease; a frame is never
 *     sent twice.
 *   - There is no direct send. A refusal, an uncertain outcome, a platform that has no such route and a platform
 *     that cannot be reached all end in an error, never in a send from here. `refused` and `uncertain` are final
 *     and are said as such; "pending" is only ever "not yet": the caller looks again, or reads the ledger.
 *   - One exception, the rollout's (atum-platform#658): the platform answers `publication_disabled`, exactly, while its
 *     worker is switched off. If, and only if, no outbox row of this result (any part) was ever accepted, the error
 *     says so (`matrix_publication_disabled`) and the caller may send the result itself the way an agent the model
 *     does not govern does; the record is dropped so the legacy acknowledgement is due for it. Once any row of the
 *     result was accepted the platform owns the message: it is `unavailable` (look again), never a direct send.
 */
import { createHash } from 'node:crypto'

import {
  type HomeOperation,
  isMatrixEventId,
  isMatrixRoomId,
  isUuid,
  PUBLICATION_MAX_PAYLOAD_BYTES,
  type PublicationEnvelope,
  type PublicationEventType,
  type PublicationReason,
  type PublicationReceipt
} from './contract'
import type { MacExecutorAuth } from './executor-auth'
import { type LeaseFacts, withOperation } from './fence'
import type { JournalStore } from './journal'
import type { HomePlatform } from './platform-client'
import { failureWord, REFRESHABLE_REFUSALS, signedCall } from './signed-call'
import { type HomeStanding, mayPublish } from './standing'

/** A publication that is not (or not yet) in the room, in one closed code. */
export class PublicationError extends Error {
  constructor(
    readonly code:
      | 'matrix_publication_pending'
      | 'matrix_publication_refused'
      | 'matrix_publication_uncertain'
      | 'matrix_publication_unavailable'
      /** The platform's worker is switched off and nothing of this result was enqueued: the caller may send it directly. */
      | 'matrix_publication_disabled',
    readonly detail: string
  ) {
    super(code)
    this.name = 'PublicationError'
  }
}

/** The error is one of this module's, whatever module realm made it. */
export const isPublicationError = (error: unknown): error is PublicationError =>
  error instanceof Error && error.name === 'PublicationError' && typeof (error as { code?: unknown }).code === 'string'

type RecordState = 'pending' | 'published' | 'refused' | 'uncertain'

/** Why a row is final, from the platform's list or from this Mac's own reading of its answer. */
type FinalReason = PublicationReason | 'conflict' | 'invalid' | 'not_authorized'

interface PublicationRecord {
  v: 1
  agent: string
  operation: HomeOperation
  part: { index: number; count: number } | null
  outboxId: string
  roomId: string
  transactionId: string
  eventType: PublicationEventType
  payloadBase64: string
  payloadSha256: string
  createdAt: number
  state: RecordState
  eventId?: string
  reason?: FinalReason
  /** Answers that said the row does not match what the platform holds: a few are retried, then it is final. */
  conflicts?: number
  /** The platform answered with a row for it (queued, admitted, sending, published or uncertain): it owns the message now. */
  enqueued?: true
}

export interface PublicationStore extends JournalStore {
  /** Every key with the prefix (for pruning); a store without it is never pruned. */
  keys?(prefix?: string): string[]
}

export const PUBLICATION_KEY_PREFIX = 'agent-home-publication-v1:'

export interface PublicationRequest {
  agent: string
  operation: HomeOperation
  roomId: string
  /** The Matrix transaction id: stable per result (and per part), so a retried send is the same event. */
  transactionId: string
  part?: { index: number; count: number }
  /** Builds the final event. Called only when nothing is recorded for this publication. */
  prepare(): Promise<{ eventType: PublicationEventType; content: object }>
}

export interface MacPublicationsOptions {
  platform: HomePlatform
  auth: MacExecutorAuth
  standing: HomeStanding
  leaseFacts(agent: string): LeaseFacts | null
  /** The agent's encrypted store (where its invocation outcomes already live), or null when it has none. */
  store(agent: string): PublicationStore | null
  now?(): number
  uuid?(): string
  /** Between two looks at an enqueued row. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  /** How often an enqueued row is looked at, and how long one call waits for the worker (the platform's cron is a minute). */
  pollMs?: number
  waitMs?: number
  /** Finished records are kept this long (a restart still finds them), then pruned. */
  retentionMs?: number
  log?(line: string): void
}

export const DEFAULT_POLL_MS = 8_000
export const DEFAULT_WAIT_MS = 75_000
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000
/** Answers that the row does not match, before a Mac stops expecting the original to publish. */
const CONFLICT_TRIES = 3

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    const timer = setTimeout(done, ms)

    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }

    signal.addEventListener('abort', done, { once: true })
    timer.unref?.()
  })

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * The outbox id of a publication is a function of what it is (agent, operation, part), not a random draw: a Mac that
 * loses its record and prepares the result again meets the same row on the platform, which holds the original
 * bytes and answers a conflict. A second row for the same result is never made.
 */
function outboxIdOf(agent: string, operation: HomeOperation, index: number): string {
  const hash = createHash('sha256').update(`atum.agent-home/2.1 publication ${agent} ${operation.kind} ${operation.id} ${index}`).digest()
  hash[6] = (hash[6]! & 0x0f) | 0x40
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

const keyOf = (agent: string, operation: HomeOperation, index: number): string =>
  `${PUBLICATION_KEY_PREFIX}${agent}:${operation.kind}:${operation.id}:${index}`

function parseRecord(raw: string | null): PublicationRecord | null {
  if (!raw) {
    return null
  }

  try {
    const row = JSON.parse(raw) as Partial<PublicationRecord> | null

    if (
      !row ||
      row.v !== 1 ||
      !isUuid(row.agent) ||
      !row.operation ||
      (row.operation.kind !== 'invocation' && row.operation.kind !== 'job') ||
      !isUuid(row.operation.id) ||
      !isUuid(row.outboxId) ||
      !isMatrixRoomId(row.roomId) ||
      typeof row.transactionId !== 'string' ||
      row.transactionId.length < 1 ||
      row.transactionId.length > 255 ||
      (row.eventType !== 'm.room.message' && row.eventType !== 'm.room.encrypted') ||
      typeof row.payloadBase64 !== 'string' ||
      typeof row.payloadSha256 !== 'string' ||
      !['pending', 'published', 'refused', 'uncertain'].includes(String(row.state)) ||
      !Number.isSafeInteger(row.createdAt) ||
      (row.state === 'published' && !isMatrixEventId(row.eventId))
    ) {
      return null
    }

    return row as PublicationRecord
  } catch {
    return null
  }
}

export class MacPublications {
  private readonly inflight = new Map<string, Promise<string>>()
  /** When the platform said an agent's queue was full, until when it asked to be left alone (`Retry-After`). */
  private readonly queueFullUntil = new Map<string, number>()

  constructor(private readonly options: MacPublicationsOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * Put one prepared event into its room through the platform and return its Matrix event id once the platform's
   * worker has sent it. Throws `PublicationError`: `pending` (not yet; look again), `refused` / `uncertain` (final),
   * `unavailable` (this Mac cannot present a publication now). A call for a publication already being driven shares it.
   */
  publish(request: PublicationRequest, signal: AbortSignal): Promise<string> {
    const key = keyOf(request.agent, request.operation, request.part?.index ?? 0)
    const running = this.inflight.get(key)

    if (running) {
      return running
    }

    const run = this.drive(request, key, signal)
      .catch((error: unknown) => {
        throw this.withRollout(error, request)
      })
      .finally(() => {
        if (this.inflight.get(key) === run) {
          this.inflight.delete(key)
        }
      })

    this.inflight.set(key, run)

    return run
  }

  /** Whether any part of this operation's result went through the platform's outbox (a record of it exists here). */
  has(agent: string, operation: HomeOperation): boolean {
    const store = this.options.store(agent)

    if (!store?.keys) {
      return false
    }

    return store.keys(`${PUBLICATION_KEY_PREFIX}${agent}:${operation.kind}:${operation.id}:`).length > 0
  }

  /** Where a publication stands, from this Mac's record alone (no network): for tests and for recovery. */
  recorded(agent: string, operation: HomeOperation, index = 0): { state: RecordState; eventId?: string; reason?: string } | null {
    const record = parseRecord(this.options.store(agent)?.getItem(keyOf(agent, operation, index)) ?? null)

    return record ? { state: record.state, ...(record.eventId ? { eventId: record.eventId } : {}), ...(record.reason ? { reason: record.reason } : {}) } : null
  }

  /**
   * A switched-off platform worker, said to the caller exactly when nothing of the result is in the platform's hands;
   * otherwise the result stays the platform's and the caller waits. The records of a result that goes out directly are
   * dropped: it is not an outbox result, and the legacy acknowledgement is due for it.
   */
  private withRollout(error: unknown, request: PublicationRequest): unknown {
    if (!isPublicationError(error) || error.code !== 'matrix_publication_disabled') {
      return error
    }

    const store = this.options.store(request.agent)
    const prefix = `${PUBLICATION_KEY_PREFIX}${request.agent}:${request.operation.kind}:${request.operation.id}:`
    const keys = store?.keys?.(prefix) ?? []
    const records = keys.map(key => parseRecord(store!.getItem(key)))

    if (!store || !store.keys || records.some(record => record === null || record.enqueued === true)) {
      return new PublicationError('matrix_publication_unavailable', 'publication_disabled_after_enqueue')
    }

    for (const key of keys) {
      store.removeItem(key)
    }

    this.options.log?.(`[Home] ${request.agent.slice(0, 8)} publication worker is off: the result goes out directly`)

    return error
  }

  // ------------------------------------------------------------------------------------------------ the drive

  private async drive(request: PublicationRequest, key: string, signal: AbortSignal): Promise<string> {
    const store = this.options.store(request.agent)

    if (!store) {
      throw new PublicationError('matrix_publication_unavailable', 'no_store')
    }

    if (!isMatrixRoomId(request.roomId) || request.transactionId.length < 1 || request.transactionId.length > 255) {
      throw new PublicationError('matrix_publication_refused', 'invalid')
    }

    let record = parseRecord(store.getItem(key))

    if (record && (record.roomId !== request.roomId || record.transactionId !== request.transactionId)) {
      // The same result under another transaction is not a retry of what was prepared: never mix them.
      throw new PublicationError('matrix_publication_refused', 'conflict')
    }

    if (!record) {
      // This Mac is stopping (sign-out, quit): nothing is prepared, and a later run starts it.
      if (signal.aborted) {
        throw new PublicationError('matrix_publication_pending', 'aborted')
      }

      // Nothing is prepared (the SDK would encrypt for the room and share keys) by a Mac that is not the home.
      await this.mayStart(request.agent, signal)
      record = await this.begin(request, store, key)
    }

    const deadline = this.now() + (this.options.waitMs ?? DEFAULT_WAIT_MS)
    const sleep = this.options.sleep ?? realSleep

    for (;;) {
      if (record.state === 'published') {
        return record.eventId!
      }

      if (record.state === 'refused') {
        throw new PublicationError('matrix_publication_refused', record.reason ?? 'refused')
      }

      if (record.state === 'uncertain') {
        throw new PublicationError('matrix_publication_uncertain', record.reason ?? 'effect_unknown')
      }

      // This Mac is stopping (sign-out, quit): the record stays, and a later run picks it up.
      if (signal.aborted) {
        throw new PublicationError('matrix_publication_pending', 'aborted')
      }

      record = await this.attempt(record, store, key, signal)

      if (record.state !== 'pending') {
        continue
      }

      const poll = this.options.pollMs ?? DEFAULT_POLL_MS

      if (this.now() + poll > deadline) {
        throw new PublicationError('matrix_publication_pending', 'worker')
      }

      await sleep(poll, signal)
    }
  }

  /** Whether this Mac may start a publication for the agent: the platform is asked now, not remembered. */
  private async mayStart(agent: string, signal: AbortSignal): Promise<void> {
    const standing = await this.options.standing.check(agent, signal, { fresh: true })

    if (!mayPublish(standing)) {
      throw new PublicationError('matrix_publication_unavailable', `not_home_${standing.state}`)
    }
  }

  /** Prepare once and keep what was prepared before anything is sent. */
  private async begin(request: PublicationRequest, store: PublicationStore, key: string): Promise<PublicationRecord> {
    const prepared = await request.prepare()
    const bytes = Buffer.from(JSON.stringify(prepared.content), 'utf8')

    if (bytes.length < 2 || bytes.length > PUBLICATION_MAX_PAYLOAD_BYTES) {
      throw new PublicationError('matrix_publication_refused', 'too_large')
    }

    if (prepared.eventType !== 'm.room.message' && prepared.eventType !== 'm.room.encrypted') {
      throw new PublicationError('matrix_publication_refused', 'invalid')
    }

    const record: PublicationRecord = {
      v: 1,
      agent: request.agent,
      operation: request.operation,
      part: request.part ?? null,
      outboxId: this.options.uuid?.() ?? outboxIdOf(request.agent, request.operation, request.part?.index ?? 0),
      roomId: request.roomId,
      transactionId: request.transactionId,
      eventType: prepared.eventType,
      payloadBase64: bytes.toString('base64'),
      payloadSha256: sha256(bytes),
      createdAt: this.now(),
      state: 'pending'
    }

    store.setItem(key, JSON.stringify(record))
    this.prune(request.agent, store)

    return record
  }

  /** One signed hand-over (or look) at the platform; the record is updated from its answer. */
  private async attempt(record: PublicationRecord, store: PublicationStore, key: string, signal: AbortSignal): Promise<PublicationRecord> {
    // The platform asked to be left alone for a while: what was prepared stays, and nothing is sent until then.
    if (this.now() < (this.queueFullUntil.get(record.agent) ?? 0)) {
      throw new PublicationError('matrix_publication_unavailable', 'queue_full')
    }

    const result = await signedCall<PublicationReceipt>(
      { standing: this.options.standing, auth: this.options.auth, leaseFacts: agent => this.options.leaseFacts(agent) },
      record.agent,
      record.operation,
      mayPublish,
      ({ placement, lease }) =>
        this.options.auth
          .sign('MatrixPublicationEnqueue', meta => ({
            meta,
            fence: withOperation(lease, record.operation),
            expectedPlacementRevision: placement.placementRevision,
            moveSerializationRevision: placement.placementRevision,
            outboxId: record.outboxId,
            roomId: record.roomId,
            transactionId: record.transactionId,
            payloadSha256: record.payloadSha256
          }))
          .then(frame => {
            const envelope: PublicationEnvelope = {
              publication: frame as PublicationEnvelope['publication'],
              eventType: record.eventType,
              payloadBase64: record.payloadBase64,
              ...(record.part ? { part: record.part } : {})
            }

            return this.options.platform.enqueuePublication(record.agent, envelope, signal)
          }),
      signal
    )

    if (result.ok === true) {
      return this.apply(record, store, key, result.value)
    }

    const failure = result.failure

    // This Mac cannot present a publication now (not the home, no lease term, the platform out of reach or
    // without the route): nothing is lost and nothing is sent from here; the caller looks again.
    if (failure.kind === 'not_home' || failure.kind === 'no_authority') {
      throw new PublicationError('matrix_publication_unavailable', failureWord(failure))
    }

    // The worker is switched off (the rollout): the caller may send the result itself if nothing of it was enqueued.
    if (failure.kind === 'publication_disabled') {
      throw new PublicationError('matrix_publication_disabled', 'publication_disabled')
    }

    if (failure.kind === 'unsupported' || failure.kind === 'unavailable' || failure.kind === 'unauthorized') {
      throw new PublicationError('matrix_publication_unavailable', failure.kind)
    }

    if (failure.kind === 'refused' && REFRESHABLE_REFUSALS.has(failure.reason)) {
      // A lease, term, revision or window that a fresh frame answers, and that three fresh frames did not: not final.
      throw new PublicationError('matrix_publication_unavailable', failure.reason)
    }

    // The drain was acknowledged: no result of the source enters from then on. Said as the receipt says it.
    if (failure.kind === 'refused' && failure.reason === 'move_in_progress') {
      const next: PublicationRecord = { ...record, state: 'refused', reason: 'move_in_progress' }
      store.setItem(key, JSON.stringify(next))
      this.options.log?.(`[Home] ${record.agent.slice(0, 8)} publication refused: move_in_progress`)

      return next
    }

    // Too many rows are waiting for this agent: nothing is lost, and the platform's own minute is respected.
    if (failure.kind === 'publication_queue_full') {
      this.queueFullUntil.set(record.agent, this.now() + failure.retryAfterSeconds * 1000)
      this.options.log?.(`[Home] ${record.agent.slice(0, 8)} publication queue is full: waiting ${failure.retryAfterSeconds} s`)

      throw new PublicationError('matrix_publication_unavailable', 'queue_full')
    }

    // The platform holds this outbox id under other bytes (this Mac lost its record and prepared the result again): the
    // original publishes on its own and the ledger will say so. This attempt is over, and says so at once.
    if (failure.kind === 'publication_changed_replay') {
      const next: PublicationRecord = { ...record, state: 'refused', reason: 'conflict' }
      store.setItem(key, JSON.stringify(next))
      this.options.log?.(`[Home] ${record.agent.slice(0, 8)} publication refused: changed_replay`)

      return next
    }

    if (failure.kind === 'conflict') {
      const conflicts = (record.conflicts ?? 0) + 1

      // The platform holds this outbox id under other bytes (this Mac lost its record) or refused without a row:
      // the original, if any, publishes on its own and the ledger will say so. A few looks, then it is final here.
      const next: PublicationRecord =
        conflicts >= CONFLICT_TRIES ? { ...record, conflicts, state: 'refused', reason: 'conflict' } : { ...record, conflicts }

      store.setItem(key, JSON.stringify(next))

      return next
    }

    const next: PublicationRecord = {
      ...record,
      state: 'refused',
      reason: failure.kind === 'invalid' ? 'invalid' : 'not_authorized'
    }

    store.setItem(key, JSON.stringify(next))
    this.options.log?.(`[Home] ${record.agent.slice(0, 8)} publication refused: ${failureWord(failure)}`)

    return next
  }

  private apply(record: PublicationRecord, store: PublicationStore, key: string, receipt: PublicationReceipt): PublicationRecord {
    let next = record

    if (receipt.state === 'published' && receipt.eventId) {
      next = { ...record, state: 'published', eventId: receipt.eventId, enqueued: true }
    } else if (receipt.state === 'refused') {
      next = { ...record, state: 'refused', reason: receipt.reason ?? 'stale_authority' }
    } else if (receipt.state === 'uncertain') {
      next = { ...record, state: 'uncertain', reason: receipt.reason ?? 'effect_unknown', enqueued: true }
    } else if (!record.enqueued) {
      // queued, admitted or sending: the platform has the row, and with it the message.
      next = { ...record, enqueued: true }
    }

    if (next !== record) {
      store.setItem(key, JSON.stringify(next))
      this.options.log?.(`[Home] ${record.agent.slice(0, 8)} publication ${next.state}${next.reason ? ` reason=${next.reason}` : ''}`)
    }

    return next
  }

  /** Finished records older than the retention are dropped; one that is still pending is never. */
  private prune(agent: string, store: PublicationStore): void {
    if (!store.keys) {
      return
    }

    const cutoff = this.now() - (this.options.retentionMs ?? DEFAULT_RETENTION_MS)

    for (const key of store.keys(`${PUBLICATION_KEY_PREFIX}${agent}:`)) {
      const record = parseRecord(store.getItem(key))

      if (!record || (record.state !== 'pending' && record.createdAt < cutoff)) {
        store.removeItem(key)
      }
    }
  }
}
