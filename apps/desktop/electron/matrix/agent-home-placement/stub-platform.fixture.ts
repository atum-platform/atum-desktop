/**
 * An in-memory stand-in for atum-platform PR #653 at its final state (`6934c498`,
 * `supabase/migrations/0280_agent_home_slice1_platform.sql` and `apps/shell/src/lib/matrix-agent-home.ts`),
 * for tests only. It answers the six Shell routes the Mac calls, through a `fetch`, with the statuses,
 * bodies and state machine the SQL implements:
 *
 *   - the placement is created lazily from the live executor lease and never guessed (503 without one);
 *   - a move is requested -> draining (drain ack `quiesced`) -> ready_to_commit (a checkpoint RESERVED
 *     AFTER the drain ack commits, from the drain's own operation) -> committed (one CAS that advances the
 *     home epoch and the placement revision); a drain that is not `quiesced` aborts it; the second manual
 *     request supersedes the first; a move from the cloud is out of this slice (400);
 *   - every signed frame is admitted by the Shell (zero future skew, at most two hours, the placement's
 *     exact Mac, its pinned key, the signature) and again in SQL against the platform-trusted lease (lease
 *     id and exact expiry, executor term), the home epoch and, while a move drains, the operation the drain
 *     recorded. Checkpoints and drains do not look an invocation up. A nonce, command id or sequence is
 *     admitted once per device, until its frame can no longer be live, and is spent even when the
 *     operation is then refused: a frame is never sent twice;
 *   - checkpoints reserve exactly `selectedGeneration + 1`, bind to the draining move, expire after 15
 *     minutes of platform time, commit only verified bytes, advance the placement revision once, and a
 *     failure leaves the previous generation selected.
 *
 * The authority decision is the protocol's own function (`decideAgentHomeAuthorityAdmission`, ported verbatim and run
 * against every `authority.*` fixture of the vendored pack by `platform.test.ts`).
 *
 * On top of that, the completion of slice 1 (atum-platform PR #664 at `cc433d9a`, migration 0284 and
 * `apps/shell/src/lib/agent-home-archive.ts`), which the routes at the end answer the way the Shell does:
 *
 *   - `POST …/home/key` and `POST …/checkpoints/{generation}/archive` (`begin` | `finalize` | `download`): strict JSON
 *     bodies with a signed `meta` and a `fence`, admitted by DEVICE (the placement's Mac, or the target of its one active
 *     move) and checked against the placement's owner, agent, home and epoch only, never against a lease. Bytes never pass
 *     through the Shell: `begin` mints a 90-second upload attempt (a server-built object path, a signed Storage token, 6 MiB
 *     chunks) for a resumable TUS upload straight to the object store (`stub-storage.fixture.ts`), `finalize` records the
 *     Mac-declared digest once Storage's own metadata shows the declared size, and `download` hands out a 90-second signed
 *     URL with the digests. A verified checkpoint commit needs the finalized archive's receipt; the key route has the
 *     sealing root's own scope (`rootVersion`, a key id that is not the key's digest);
 *   - a publication enqueued while a move is only `requested` (before the drain acknowledgement) is admitted and tagged
 *     with that move, and the worker may still publish it afterwards; after the acknowledgement nothing new enters;
 *   - a move commit waits (409 `agent_home_publication_in_flight`) for every queued/admitted/sending row of the home
 *     and for every unpublished row tagged to the move;
 *   - a changed replay is 409 `agent_home_publication_changed_replay`, a saturated queue 429
 *     `agent_home_publication_queue_full` with `Retry-After: 60`, and an accepted row is published before the answer
 *     (`inlineMatrix`), the worker's minute being only the recovery.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'

import { canonicalJson } from '../device/canonical'

import {
  AGENT_HOME_WIRE_HEADER,
  AGENT_HOME_WIRE_VERSION,
  type ExecutorSignedMeta,
  type HomeAuthorityFence,
  type HomeLocation,
  type HomeMove,
  type HomeRefusalReason,
  isUuid,
  type MoveIntent,
  type MoveStatus,
  type PublicationEventType,
  publicationPayloadBytes,
  type PublicationReason,
  type PublicationState,
  sameLocation,
  SIGNED_MESSAGE_MAX_MS,
  validAuthorityFence,
  validExecutorMeta,
  validLeaseFence,
  validPublicationEnvelope
} from './contract'
import { STORAGE_BUCKET, StubStorage, TUS_CHUNK_BYTES } from './stub-storage.fixture'

const NUL = String.fromCharCode(0)
const RESERVATION_MS = 15 * 60_000
const ZERO_UUID = '00000000-0000-4000-8000-db8055e0e030'

export interface StubDevice {
  deviceServiceId: string
  /** `b64url(sha256(SPKI))`. */
  keyId: string
  /** The SPKI DER, base64url. */
  publicKey: string
  status: 'active' | 'retired'
}

export interface StubLease {
  executorDevice: string
  leaseId: string
  expiresAt: number
  /** The executor term: `cloud_lease_generations.generation`, which the Mac's own lease grant also carries as `selection.generation`. */
  term: number
}

interface StubMove {
  moveId: string
  idempotencyKey: string
  intent: MoveIntent
  status: MoveStatus
  source: HomeLocation
  target: HomeLocation
  expectedHomeEpoch: number
  expectedPlacementRevision: number
  requestedAt: number
  drainResult: 'quiesced' | 'timed_out' | 'unreachable' | null
  drainAckedAt: number | null
  drainOperation: { kind: 'invocation' | 'job'; id: string } | null
  checkpointGeneration: number | null
  supersededBy: string | null
  committedHomeEpoch: number | null
  committedPlacementRevision: number | null
  committedAt: number | null
}

type FailureReason = 'reservation_expired' | 'move_started' | 'move_aborted' | 'stale_epoch' | 'verification_failed'

interface StubCheckpoint {
  checkpointId: string
  generation: number
  parentGeneration: number
  producingHomeEpoch: number
  expectedPlacementRevision: number
  moveId: string | null
  state: 'reserved' | 'committed' | 'failed'
  failure: FailureReason | null
  manifestSha256: string | null
  reservedAt: number
}

/** One row of the platform's publication outbox (`agent_home_publication_outbox` plus its payload). */
export interface StubOutboxRow {
  outboxId: string
  homeEpoch: number
  placementRevision: number
  executorTerm: number
  operation: { kind: 'invocation' | 'job'; id: string }
  roomId: string
  transactionId: string
  payloadSha256: string
  eventType: PublicationEventType
  payload: Buffer
  partIndex: number
  partCount: number
  state: PublicationState
  eventId: string | null
  reason: PublicationReason | null
  attempts: number
  createdAt: number
  /** Platform time (ms) the row was created: compared with the drain acknowledgement. */
  createdAtMs: number
  /** The move that was only `requested` when the row was admitted (0284 `source_move_id`), or null. */
  sourceMoveId: string | null
}

/** A homeserver as the platform's worker sees it: events by transaction, so a retried PUT is the same event. */
export class StubMatrixServer {
  readonly events: Array<{ roomId: string; eventType: string; transactionId: string; bytes: Buffer; eventId: string }> = []
  /** The next PUTs fail this way: `retry` (a 5xx before anything was stored), `permanent` (a 4xx), `lost` (stored, answer lost). */
  failNext: Array<'retry' | 'permanent' | 'lost'> = []
  private counter = 0

  put(roomId: string, eventType: string, transactionId: string, bytes: Buffer): string {
    const failure = this.failNext.shift()

    if (failure === 'retry') {
      throw new Error('matrix_retryable')
    }

    if (failure === 'permanent') {
      throw new Error('matrix_permanent')
    }

    let found = this.events.find(event => event.roomId === roomId && event.transactionId === transactionId)

    if (!found) {
      this.counter += 1
      found = { roomId, eventType, transactionId, bytes, eventId: `$stub-event-${this.counter}:atum.example` }
      this.events.push(found)
    }

    if (failure === 'lost') {
      throw new Error('matrix_response_lost')
    }

    return found.eventId
  }
}

interface StubAgent {
  agentPrincipal: string
  homeId: string
  location: HomeLocation
  homeEpoch: number
  placementRevision: number
  selectedGeneration: number
  rollbackFloorGeneration: number
  activeMoveId: string | null
  policyRevision: number
  erased: boolean
  /** False until the first read makes the placement from the live executor lease. */
  created: boolean
  moves: Map<string, StubMove>
  checkpoints: Map<string, StubCheckpoint>
  lease: StubLease | null
  term: number
  readiness: { receivedAt: number; lastReadyAt: number | null; reachable: boolean; powerState: string; homeEpoch: number } | null
  /** The publication outbox, by outbox id. */
  outbox: Map<string, StubOutboxRow>
  /** The invocation and occurrence ledgers: an operation exists, and the event the worker recorded for it. */
  ledger: Map<string, { published: string | null }>
}

interface ReplayRow {
  nonce: string
  commandId: string
  sequence: number
  expiresAt: number
}

/** `agent_home_checkpoint_archives`: one row per checkpoint, rewritten by each upload attempt until it is ready. */
interface ArchiveAttempt {
  checkpointId: string
  homeId: string
  generation: number
  path: string
  byteSize: number
  /** The attempt's id (the `uploadToken` of the finalize call). */
  attemptId: string
  /** Platform time (ms) the 90-second attempt ends. */
  expiresAt: number
  state: 'uploading' | 'ready'
  /** The digest the Mac declared at finalize. */
  sha256: string | null
}

class StubHttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason?: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(`stub_${status}${reason ? `_${reason}` : ''}`)
  }
}

export interface StubRequestLog {
  method: string
  path: string
  /** Moves: the operation; signed routes: the frame's action. */
  action?: string
  status: number
}

/** The protocol's `decideAgentHomeAuthorityAdmission`, verbatim (packages/protocol/src/agent-home-placement.ts). */
export function decideAuthorityAdmission(
  presented: { meta: ExecutorSignedMeta; fence: HomeAuthorityFence },
  trusted: {
    ownerUserId: string
    agentPrincipal: string
    homeId: string
    homeEpoch: number
    executorTerm: number
    leaseId: string
    leaseExpiresAtPlatform: number
    operation: { kind: 'invocation' | 'job'; id: string }
    placement: HomeLocation
    pinnedSignerKeyId: string
    signatureValid: boolean
    nowPlatform: number
  }
): { outcome: 'accepted'; reason: 'current_authority' } | { outcome: 'refused'; reason: HomeRefusalReason } {
  const { fence, meta } = presented

  if (fence.ownerUserId !== trusted.ownerUserId) {return { outcome: 'refused', reason: 'wrong_owner' }}

  if (fence.agentPrincipal !== trusted.agentPrincipal) {return { outcome: 'refused', reason: 'wrong_agent' }}

  if (fence.homeId !== trusted.homeId) {return { outcome: 'refused', reason: 'wrong_home' }}

  if (fence.homeEpoch !== trusted.homeEpoch) {return { outcome: 'refused', reason: 'stale_home_epoch' }}

  if (fence.executorTerm !== trusted.executorTerm) {return { outcome: 'refused', reason: 'stale_executor_term' }}

  if (fence.operation.kind !== trusted.operation.kind || fence.operation.id !== trusted.operation.id) {
    return { outcome: 'refused', reason: 'wrong_operation' }
  }

  if (fence.leaseId !== trusted.leaseId || fence.leaseExpiresAtPlatform !== trusted.leaseExpiresAtPlatform) {
    return { outcome: 'refused', reason: 'wrong_lease' }
  }

  if (trusted.leaseExpiresAtPlatform <= trusted.nowPlatform) {return { outcome: 'refused', reason: 'lease_expired' }}

  if (
    meta.issuedAt > trusted.nowPlatform ||
    meta.expiresAt <= trusted.nowPlatform ||
    meta.expiresAt > meta.issuedAt + SIGNED_MESSAGE_MAX_MS
  ) {
    return { outcome: 'refused', reason: 'signature_expired' }
  }

  const signerMatches =
    trusted.placement.kind === 'cloud'
      ? meta.signer === 'cloud_workload'
      : meta.signer === 'mac_executor' && meta.deviceServiceId === trusted.placement.deviceServiceId

  if (!signerMatches) {return { outcome: 'refused', reason: 'wrong_signer_location' }}

  if (meta.signerKeyId !== trusted.pinnedSignerKeyId) {return { outcome: 'refused', reason: 'unpinned_signer_key' }}

  if (!trusted.signatureValid) {return { outcome: 'refused', reason: 'bad_signature' }}

  return { outcome: 'accepted', reason: 'current_authority' }
}

/** The Shell's signed bytes, written as `agentHomeSignedBytes` in matrix-agent-home.ts writes them. */
function shellSignedBytes(action: string, input: { meta: object }): Buffer {
  const unsigned = { ...input, meta: { ...input.meta } } as { meta: Record<string, unknown> }
  delete unsigned.meta.signature

  return Buffer.from(`atum.agent-home/2.1${NUL}${action}${NUL}${canonicalJson(unsigned)}`, 'utf8')
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const keysOf = (value: unknown, keys: readonly string[]): boolean => {
  const row = record(value)

  return Boolean(row) && Object.keys(row!).sort().join(',') === [...keys].sort().join(',')
}

export interface StubHomePlatformOptions {
  now?(): number
  ownerUserId?: string
}

type Finish = (status: number, body: unknown, headers?: Record<string, string>) => Response

export class StubHomePlatform {
  readonly ownerUserId: string
  readonly token = 'stub-bearer-token'
  readonly requests: StubRequestLog[] = []
  /** The headers of the last request, lower-cased (for the wire-level assertions). */
  lastHeaders: Record<string, string> = {}
  /** The archive objects by home and generation, as the object store holds them once an upload is finalized (see the bottom of this file). */
  readonly archives = new Map<string, Buffer>()
  /**
   * `agent_home_checkpoint_archives`: the durable receipt of each checkpoint's upload (bytes, digest), by checkpoint id.
   * A verified commit needs it, and sets the manifest digest on it; a read needs the committed one.
   */
  readonly archiveReceipts = new Map<string, { generation: number; homeId: string; bytes: number; sha256: string; manifestSha256: string | null; data: Buffer }>()
  /** Where the object store answers (Supabase Storage's host): the Shell's `begin` and `download` point the Mac there. A test that serves the stub over a real socket moves it. */
  storageOrigin = 'https://storage.test'
  /** The object store the Mac uploads to and downloads from directly (never through the Shell). */
  readonly storage: StubStorage
  /** The owner's principal, the first folder of an object's server-built path (the owner's Matrix user id is `ownerUserId`). */
  readonly ownerPrincipal = '00000000-0000-4000-8000-87d96e07d1bf'
  /** The service-role Storage client exists (`begin` and `download` need it); without it they answer 503 `not_configured`. */
  storageConfigured = true
  /** When set, the routes answer as a platform that does not have them (the capability check). */
  unsupported: 'absent' | 'not_configured' | null = null
  /** The archive and key routes exist (atum-platform #664); without them the Shell answers its framework's page. */
  archiveRoutes = true
  /** The publications route exists (atum-platform PR #658); without it the Shell answers its framework's page. */
  publicationsRoute = true
  /**
   * The publication worker is switched on (`ATUM_AGENT_HOME_PUBLICATION_ENABLED`). Off, the enqueue route answers
   * exactly 503 `{error, details: {reason: "publication_disabled"}}` before it looks at the request, as the Shell does.
   */
  publicationsEnabled = true
  /**
   * While the platform clock is before this, a move commit meets a publication the worker is sending and answers
   * exactly 409 `{details: {reason: "agent_home_publication_in_flight"}}`, as 0281's commit does for a live lease.
   */
  publicationSendingUntil: number | null = null
  /**
   * The Shell has a sealing root (`ATUM_AGENT_HOME_SEALING_ROOT`). Off, the key route answers exactly 503
   * `{details: {reason: "not_configured"}}`, as it does before the platform's rollout step 1. (The archive routes need the
   * Storage client, `storageConfigured`, not the root: the root only derives keys.)
   */
  sealingConfigured = true
  /** The agent's queue is saturated: an enqueue answers exactly 429 `agent_home_publication_queue_full` with `Retry-After: 60`. */
  publicationQueueFull = false
  /**
   * The homeserver the Shell publishes to inline: an accepted row is claimed, sent and completed before the enqueue
   * answers (the minute-cron worker being only the recovery). Absent: the row waits for `sweepPublications`.
   */
  inlineMatrix: StubMatrixServer | null = null
  /** The next `begin` meets another live upload of the generation: 409 `agent_home_archive_upload_busy` with the attempt's remaining seconds as `Retry-After`. */
  archiveUploadBusy = false
  /** The next enqueue (and no other call) is answered this way, whatever it said. */
  failNextPublication: { status: number; body?: unknown } | null = null
  /** A checkpoint commit advances the placement revision just before the next enqueue is looked at (the race the revision fence is for). */
  advanceRevisionBeforeNextPublication = false
  /** Tests make the platform fail the next call this way. */
  failNext: { status: number; body?: unknown } | null = null
  /** Tests make the Storage client fail when an upload is begun, after the checkpoint is reserved: 503 `archive_store_unavailable`. */
  archivePutFails = false
  /**
   * The next key or archive call of this action (after it was admitted: signed, pinned, the device allowed) is answered
   * this way instead, once: a named 409 with its `Retry-After`, say, or with a `body`, whatever it says, a 200 that is not
   * what the contract writes. `begin` and `finalize` are different actions.
   */
  failAction: { action: string; status: number; reason?: string; headers?: Record<string, string>; body?: unknown; times?: number } | null = null
  /**
   * The next 200 answer of this action is reshaped by the test: the platform ran the call (so the attempt, the object, the
   * key are as they would be) and says something the contract does not write, as a buggy or hostile one could.
   */
  alterAnswer: { action: string; change(body: Record<string, unknown>): unknown; times?: number } | null = null
  /** The platform applies the next request of this action and then loses the answer on the way back (a 503). */
  loseNextAnswer: string | null = null

  private readonly agents = new Map<string, StubAgent>()
  private readonly devices = new Map<string, StubDevice>()
  private readonly replays = new Map<string, ReplayRow[]>()
  private readonly attempts = new Map<string, ArchiveAttempt>()
  private readonly clock: () => number
  private counter = 0

  constructor(options: StubHomePlatformOptions = {}) {
    this.clock = options.now ?? Date.now
    this.ownerUserId = options.ownerUserId ?? '@owner:atum.example'
    this.storage = new StubStorage({
      origin: () => this.storageOrigin,
      now: () => this.now(),
      // A signed download serves what the database says is stored, which a test may have damaged in `archives`.
      read: path => {
        const attempt = [...this.attempts.values()].find(each => each.path === path)

        return attempt ? this.archives.get(`${attempt.homeId}:${attempt.generation}`) : undefined
      }
    })
  }

  now(): number {
    return this.clock()
  }

  private uuid(): string {
    this.counter += 1

    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`
  }

  // ------------------------------------------------------------------------------ test setup

  addDevice(device: Omit<StubDevice, 'status'> & { status?: StubDevice['status'] }): void {
    this.devices.set(device.deviceServiceId, { status: 'active', ...device })
  }

  retireDevice(deviceServiceId: string): void {
    const device = this.devices.get(deviceServiceId)

    if (device) {
      device.status = 'retired'
    }
  }

  /** An agent whose live executor is on `location` (the lazily-created placement's source). */
  addAgent(agentPrincipal: string, options: { location?: HomeLocation; homeId?: string; term?: number; lazy?: boolean } = {}): void {
    this.agents.set(agentPrincipal, {
      agentPrincipal,
      homeId: options.homeId ?? this.uuid(),
      location: options.location ?? { kind: 'cloud' },
      homeEpoch: 1,
      placementRevision: 1,
      selectedGeneration: 1,
      rollbackFloorGeneration: 1,
      activeMoveId: null,
      policyRevision: 1,
      erased: false,
      created: !options.lazy,
      moves: new Map(),
      checkpoints: new Map(),
      lease: null,
      term: options.term ?? 7,
      readiness: null,
      outbox: new Map(),
      ledger: new Map()
    })
  }

  // ------------------------------------------------------------------- publication: the ledger and the worker

  /** The invocation (or occurrence) exists in the ledger, completed and not yet published: the only thing a publication can name. */
  registerOperation(agentPrincipal: string, operation: { kind: 'invocation' | 'job'; id: string }): void {
    this.agent(agentPrincipal).ledger.set(`${operation.kind}:${operation.id}`, { published: null })
  }

  /** What the ledger says was published for an operation (`published_event`), or null. */
  ledgerPublished(agentPrincipal: string, operation: { kind: 'invocation' | 'job'; id: string }): string | null {
    return this.agent(agentPrincipal).ledger.get(`${operation.kind}:${operation.id}`)?.published ?? null
  }

  outboxRows(agentPrincipal: string): StubOutboxRow[] {
    return [...this.agent(agentPrincipal).outbox.values()]
  }

  /**
   * One sweep of the platform's worker (`agent-home-publication-worker.ts`): each claimable row is checked against the
   * placement once more under its lock, moved to `sending`, PUT to the homeserver with its own transaction id, and
   * published. A row the move no longer admits is refused (a `sending` one becomes `uncertain`); a retryable failure
   * keeps `sending`. This is also the recovery of an inline publish that died after the homeserver took the event.
   */
  sweepPublications(matrix: StubMatrixServer): { published: number; refused: number; uncertain: number; retry: number } {
    const result = { published: 0, refused: 0, uncertain: 0, retry: 0 }

    for (const agent of this.agents.values()) {
      const rows = [...agent.outbox.values()].filter(row => ['queued', 'admitted', 'sending'].includes(row.state)).sort((left, right) => left.createdAt - right.createdAt)

      for (const row of rows) {
        this.publishRow(agent, row, matrix, result)
      }
    }

    return result
  }

  /**
   * `agent_home_publication_move_admitted` (0284): a row created before the drain acknowledgement belongs to the source
   * epoch and may finish while the move runs; one created after it, or for another epoch, may not.
   */
  private moveAdmits(agent: StubAgent, row: StubOutboxRow): boolean {
    if (!agent.activeMoveId) {
      return true
    }

    const move = agent.moves.get(agent.activeMoveId)

    return (
      Boolean(move) &&
      ['requested', 'draining', 'ready_to_commit'].includes(move!.status) &&
      move!.expectedHomeEpoch === row.homeEpoch &&
      (move!.drainAckedAt === null || row.createdAtMs <= move!.drainAckedAt)
    )
  }

  private publishRow(agent: StubAgent, row: StubOutboxRow, matrix: StubMatrixServer, result = { published: 0, refused: 0, uncertain: 0, retry: 0 }): void {
    // The worker's lease rechecks the home epoch, the tombstone and the move; a checkpoint that advanced the placement
    // revision does not move the home, so it does not invalidate a row.
    const stale = agent.erased || row.homeEpoch !== agent.homeEpoch

    if (stale || !this.moveAdmits(agent, row)) {
      if (row.state === 'sending') {
        row.state = 'uncertain'
        row.reason = 'effect_unknown'
        result.uncertain += 1
      } else {
        row.state = 'refused'
        row.reason = stale ? 'stale_authority' : 'move_in_progress'
        result.refused += 1
      }

      return
    }

    row.state = 'sending'
    row.attempts += 1

    try {
      row.eventId = matrix.put(row.roomId, row.eventType, row.transactionId, row.payload)
    } catch (error) {
      if (error instanceof Error && error.message === 'matrix_permanent') {
        row.state = 'refused'
        row.reason = 'matrix_error'
        result.refused += 1
      } else {
        result.retry += 1
      }

      return
    }

    row.state = 'published'
    row.reason = null
    result.published += 1

    // The receipt on the ledger is the last part's event, written once every part of the operation is out.
    const siblings = [...agent.outbox.values()].filter(other => other.operation.kind === row.operation.kind && other.operation.id === row.operation.id)

    if (siblings.every(other => other.state === 'published')) {
      const last = siblings.find(other => other.partIndex === other.partCount - 1)
      const entry = agent.ledger.get(`${row.operation.kind}:${row.operation.id}`)

      if (last && entry) {
        entry.published = last.eventId
      }
    }
  }

  private agent(agentPrincipal: string): StubAgent {
    const agent = this.agents.get(agentPrincipal)

    if (!agent) {
      throw new StubHttpError(403)
    }

    return agent
  }

  /** The platform grants this device the agent's answering lease: a new holder is a new lease id and a new term. */
  grantLease(agentPrincipal: string, deviceServiceId: string, ttlMs = 90_000): StubLease {
    const agent = this.agent(agentPrincipal)
    agent.term += 1
    agent.lease = { executorDevice: deviceServiceId, leaseId: this.uuid(), expiresAt: this.now() + ttlMs, term: agent.term }

    return agent.lease
  }

  /** The holder renews: the same lease id, a later expiry (the Mac's lease protocol keeps its token). */
  renewLease(agentPrincipal: string, ttlMs = 90_000): StubLease {
    const agent = this.agent(agentPrincipal)

    if (!agent.lease) {
      throw new Error('stub_no_lease')
    }

    agent.lease = { ...agent.lease, expiresAt: this.now() + ttlMs }

    return agent.lease
  }

  /** The holder releases (its lease row is deleted). */
  releaseLease(agentPrincipal: string): void {
    this.agent(agentPrincipal).lease = null
  }

  lease(agentPrincipal: string): StubLease | null {
    return this.agent(agentPrincipal).lease
  }

  /** The record exactly as `GET …/home` answers it (the Mac reads state through the route; this is for assertions). */
  placement(agentPrincipal: string) {
    return this.placementJson(this.agent(agentPrincipal))
  }

  /**
   * A Mac→cloud move as the owner's Shell requests it (the Mac's route only names Mac targets). The source half runs
   * the Mac's real flows; `commitCloudMove` then stands in for the cloud participant's commit, under the same rules a
   * Mac target's commit meets here (ready to commit, a committed checkpoint, no publication in flight).
   */
  requestCloudMove(agentPrincipal: string): string {
    const agent = this.agent(agentPrincipal)

    if (agent.activeMoveId || agent.location.kind === 'cloud') {
      throw new Error('stub_cloud_move_refused')
    }

    const move: StubMove = {
      moveId: this.uuid(), idempotencyKey: this.uuid(), intent: 'manual', status: 'requested',
      source: agent.location, target: { kind: 'cloud' },
      expectedHomeEpoch: agent.homeEpoch, expectedPlacementRevision: agent.placementRevision,
      requestedAt: this.now(), drainResult: null, drainAckedAt: null, drainOperation: null, checkpointGeneration: null,
      supersededBy: null, committedHomeEpoch: null, committedPlacementRevision: null, committedAt: null
    }

    agent.moves.set(move.moveId, move)
    agent.activeMoveId = move.moveId

    return move.moveId
  }

  commitCloudMove(agentPrincipal: string): void {
    const agent = this.agent(agentPrincipal)
    const move = agent.activeMoveId ? agent.moves.get(agent.activeMoveId) : undefined
    const checkpoint = [...agent.checkpoints.values()].find(each => each.generation === move?.checkpointGeneration && each.state === 'committed')

    if (!move || move.target.kind !== 'cloud' || move.status !== 'ready_to_commit' || !checkpoint ||
        [...agent.outbox.values()].some(row => row.homeEpoch === agent.homeEpoch &&
          (['queued', 'admitted', 'sending'].includes(row.state) || (row.sourceMoveId === move.moveId && row.state !== 'published')))) {
      throw new Error('stub_cloud_commit_refused')
    }

    this.failReserved(agent, 'stale_epoch')
    agent.location = move.target
    agent.homeEpoch += 1
    agent.placementRevision += 1
    agent.activeMoveId = null
    agent.lease = null
    move.status = 'committed'
    move.committedHomeEpoch = agent.homeEpoch
    move.committedPlacementRevision = agent.placementRevision
    move.committedAt = this.now()
  }

  /** The platform moves the home on its own account (another Mac committed a move): a new location and epoch. */
  hijack(agentPrincipal: string, location: HomeLocation): void {
    const agent = this.agent(agentPrincipal)
    agent.location = location
    agent.homeEpoch += 1
    agent.placementRevision += 1
    agent.activeMoveId = null
    this.failReserved(agent, 'stale_epoch')
  }

  tombstone(agentPrincipal: string): void {
    const agent = this.agent(agentPrincipal)
    agent.erased = true
    agent.activeMoveId = null
  }

  checkpoints(agentPrincipal: string) {
    return [...this.agent(agentPrincipal).checkpoints.values()]
  }

  moves(agentPrincipal: string) {
    return [...this.agent(agentPrincipal).moves.values()]
  }

  readiness(agentPrincipal: string) {
    return this.agent(agentPrincipal).readiness
  }

  // --------------------------------------------------------------------------------- JSON shapes

  private moveJson(move: StubMove): HomeMove {
    return {
      moveId: move.moveId,
      idempotencyKey: move.idempotencyKey,
      intent: move.intent,
      status: move.status,
      source: move.source,
      target: move.target,
      expectedHomeEpoch: move.expectedHomeEpoch,
      expectedPlacementRevision: move.expectedPlacementRevision,
      requestedAtPlatform: move.requestedAt
    }
  }

  private placementJson(agent: StubAgent) {
    const active = agent.activeMoveId ? agent.moves.get(agent.activeMoveId) : undefined

    return {
      ownerUserId: this.ownerUserId,
      agentPrincipal: agent.agentPrincipal,
      homeId: agent.homeId,
      location: agent.location,
      homeEpoch: agent.homeEpoch,
      placementRevision: agent.placementRevision,
      selectedGeneration: agent.selectedGeneration,
      rollbackFloorGeneration: agent.rollbackFloorGeneration,
      activeMove: active ? this.moveJson(active) : null,
      policyRevision: agent.policyRevision
    }
  }

  private failReserved(agent: StubAgent, reason: FailureReason): void {
    for (const checkpoint of agent.checkpoints.values()) {
      if (checkpoint.state === 'reserved') {
        checkpoint.state = 'failed'
        checkpoint.failure = reason
      }
    }
  }

  // ----------------------------------------------------------------------- SQL: authority + replay

  /** `agent_home_authority_admit` for a checkpoint or a drain: the lease and epoch, never an invocation lookup. */
  private admit(
    agent: StubAgent,
    fence: unknown,
    meta: ExecutorSignedMeta,
    /** A publication: the operation must be one the ledger knows (an invocation or occurrence of this agent). */
    publication = false
  ): { outcome: 'accepted' } | { outcome: 'refused'; reason: HomeRefusalReason } {
    if (!validAuthorityFence(fence)) {
      return { outcome: 'refused', reason: 'wrong_operation' }
    }

    if (agent.erased) {
      return { outcome: 'refused', reason: 'wrong_home' }
    }

    const lease = agent.lease
    const device = this.devices.get(agent.location.kind === 'mac' ? agent.location.deviceServiceId : '')

    // The live executor must be at the placement's location, else the signer is in the wrong place.
    if (
      lease &&
      !sameLocation(agent.location, { kind: 'mac', deviceServiceId: lease.executorDevice }) &&
      fence.executorTerm === lease.term &&
      fence.leaseId === lease.leaseId
    ) {
      return { outcome: 'refused', reason: 'wrong_signer_location' }
    }

    // While a move drains, the checkpoint must come from the operation the drain recorded.
    const active = agent.activeMoveId ? agent.moves.get(agent.activeMoveId) : undefined
    let operation = fence.operation

    if (!publication && active && ['draining', 'ready_to_commit'].includes(active.status) && active.drainOperation) {
      operation = active.drainOperation
    }

    // A publication names an operation of the ledger; one that is not there is some other operation.
    if (publication && !agent.ledger.has(`${fence.operation.kind}:${fence.operation.id}`)) {
      operation = { kind: fence.operation.kind, id: ZERO_UUID }
    }

    const decision = decideAuthorityAdmission(
      { meta, fence },
      {
        ownerUserId: this.ownerUserId,
        agentPrincipal: agent.agentPrincipal,
        homeId: agent.homeId,
        homeEpoch: agent.homeEpoch,
        executorTerm: lease?.term ?? 0,
        leaseId: lease?.leaseId ?? ZERO_UUID,
        leaseExpiresAtPlatform: lease?.expiresAt ?? 0,
        // Checkpoints and drains use the lease and the epoch only: any well-formed operation is admitted,
        // except that a draining move pins the drain's own.
        operation,
        placement: agent.location,
        pinnedSignerKeyId: device?.status === 'active' ? device.keyId : '',
        signatureValid: true,
        nowPlatform: this.now()
      }
    )

    return decision.outcome === 'accepted' ? { outcome: 'accepted' } : decision
  }

  /** `agent_home_replay_admit`: a nonce, command id and sequence are admitted once per device while live. */
  private replayAdmit(device: string, meta: ExecutorSignedMeta): 'accepted' | 'replayed' | 'signature_expired' {
    const now = this.now()

    if (meta.issuedAt > now || meta.expiresAt <= now || meta.expiresAt > meta.issuedAt + SIGNED_MESSAGE_MAX_MS) {
      return 'signature_expired'
    }

    const rows = (this.replays.get(device) ?? []).filter(row => row.expiresAt > now)

    if (rows.some(row => row.nonce === meta.nonce || row.commandId === meta.commandId || row.sequence === meta.sequence)) {
      this.replays.set(device, rows)

      return 'replayed'
    }

    rows.push({ nonce: meta.nonce, commandId: meta.commandId, sequence: meta.sequence, expiresAt: meta.expiresAt })
    this.replays.set(device, rows)

    return 'accepted'
  }

  private replayRefusal(agent: StubAgent, meta: ExecutorSignedMeta): { outcome: 'refused'; reason: string } | null {
    const device = agent.location.kind === 'mac' ? agent.location.deviceServiceId : ''
    const result = this.replayAdmit(device, meta)

    return result === 'accepted' ? null : { outcome: 'refused', reason: result }
  }

  // ------------------------------------------------------------------------------- the Shell route

  /** The Shell's signature admission before SQL runs (matrix-agent-home.ts `verified`). */
  private verifiedSignature(agent: StubAgent, action: string, input: { meta: ExecutorSignedMeta } & Record<string, unknown>): void {
    const current = this.now()

    if (input.meta.issuedAt > current || input.meta.expiresAt <= current || input.meta.expiresAt > input.meta.issuedAt + SIGNED_MESSAGE_MAX_MS) {
      throw new StubHttpError(401, 'signature_expired')
    }

    if (agent.location.kind !== 'mac' || agent.location.deviceServiceId !== input.meta.deviceServiceId) {
      throw new StubHttpError(403, 'wrong_signer_location')
    }

    this.pinnedAndSigned(action, input)
  }

  /** The pinned key and the signature, in the Shell's order (`verified` and `verifiedArchiveRoute` both end with these two). */
  private pinnedAndSigned(action: string, input: { meta: ExecutorSignedMeta } & Record<string, unknown>): void {
    const device = this.devices.get(input.meta.deviceServiceId)

    if (!device || device.status !== 'active' || device.keyId !== input.meta.signerKeyId) {
      throw new StubHttpError(403, 'unpinned_signer_key')
    }

    let valid = false

    try {
      const key = createPublicKey({ key: Buffer.from(device.publicKey, 'base64url'), format: 'der', type: 'spki' })
      const signature = Buffer.from(input.meta.signature, 'base64url')

      valid =
        key.asymmetricKeyType === 'ec' &&
        key.asymmetricKeyDetails?.namedCurve === 'prime256v1' &&
        signature.byteLength === 64 &&
        verify('sha256', shellSignedBytes(action, input), { key, dsaEncoding: 'ieee-p1363' }, signature)
    } catch {
      valid = false
    }

    if (!valid) {
      throw new StubHttpError(400, 'bad_signature')
    }
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input as string, init)
    const url = new URL(request.url)

    // The object store is not the Shell: its own host, its own rules, and not one of the Shell's logs or faults.
    if (url.origin === this.storageOrigin) {
      return this.storage.handle(request)
    }

    const log: StubRequestLog = { method: request.method, path: url.pathname, status: 0 }
    this.requests.push(log)
    this.lastHeaders = Object.fromEntries(request.headers.entries())

    const finish: Finish = (status, body, headers = {}) => {
      log.status = status

      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', vary: AGENT_HOME_WIRE_HEADER, ...headers }
      })
    }

    try {
      if (this.failNext) {
        const next = this.failNext
        this.failNext = null

        return finish(next.status, next.body ?? { error: `matrix_${next.status}` })
      }

      if (this.unsupported === 'absent') {
        log.status = 404

        return new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } })
      }

      if (this.unsupported === 'not_configured') {
        throw new StubHttpError(503, 'not_configured')
      }

      const response = await this.route(request, url, log, finish)

      if (this.loseNextAnswer && this.loseNextAnswer === log.action) {
        this.loseNextAnswer = null
        log.status = 503

        return new Response(JSON.stringify({ error: 'matrix_503' }), { status: 503, headers: { 'content-type': 'application/json' } })
      }

      return response
    } catch (error) {
      if (error instanceof StubHttpError) {
        return finish(error.status, { error: `matrix_${error.status}`, ...(error.reason ? { details: { reason: error.reason } } : {}) }, error.headers)
      }

      throw error
    }
  }

  private async route(request: Request, url: URL, log: StubRequestLog, finish: Finish): Promise<Response> {
    if (request.headers.get('authorization') !== `Bearer ${this.token}`) {
      throw new StubHttpError(401)
    }

    const match =
      /\/api\/matrix\/v1\/agents\/([0-9a-f-]{36})\/home(?:\/(moves|drain|checkpoints|readiness|publications|key))?(?:\/(\d+)\/(archive))?$/u.exec(url.pathname)

    if (!match) {
      log.status = 404

      return new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } })
    }

    if (
      request.headers.get(AGENT_HOME_WIRE_HEADER) !== AGENT_HOME_WIRE_VERSION ||
      request.headers.has('cookie') ||
      request.headers.has('x-atum-principal') ||
      url.search ||
      !isUuid(match[1])
    ) {
      throw new StubHttpError(400, 'invalid')
    }

    const agent = this.agent(match[1]!)
    const action = match[2] ?? ''

    // A platform that has #653 but not the two PROPOSED routes (the archive bytes and the data key), or not #658's.
    if ((!this.archiveRoutes && (match[4] === 'archive' || action === 'key')) || (!this.publicationsRoute && action === 'publications')) {
      log.status = 404

      return new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } })
    }

    if (match[4] === 'archive') {
      return this.archiveRoute(request, agent, Number(match[3]), log, finish)
    }

    if (action === 'key') {
      return this.keyRoute(request, agent, log, finish)
    }

    if (action === '') {
      if (request.method !== 'GET' || (await request.text()).length !== 0) {
        throw new StubHttpError(400, 'invalid')
      }

      return finish(200, this.ensure(agent))
    }

    if (request.method !== 'POST' || request.headers.get('content-type') !== 'application/json') {
      throw new StubHttpError(400, 'invalid')
    }

    if (action === 'publications' && !this.publicationsEnabled) {
      throw new StubHttpError(503, 'publication_disabled')
    }

    if (action === 'publications' && this.failNextPublication) {
      const next = this.failNextPublication
      this.failNextPublication = null

      return finish(next.status, next.body ?? { error: `matrix_${next.status}` })
    }

    const text = await request.text()

    // A publication carries the event bytes (base64, up to 174,764 characters); every other body is small.
    if (text.length > (action === 'publications' ? 196_608 : 16_384)) {
      throw new StubHttpError(400, 'invalid')
    }

    let body: Record<string, unknown>

    try {
      const row = record(JSON.parse(text) as unknown)

      if (!row) {
        throw new Error('shape')
      }

      body = row
    } catch {
      throw new StubHttpError(400, 'invalid')
    }

    if (action === 'moves') {
      log.action = String(body.operation)

      return finish(200, this.moveOperation(agent, body))
    }

    if (action === 'drain') {
      log.action = 'DrainAck'

      return this.drain(agent, body, finish)
    }

    if (action === 'checkpoints') {
      log.action = body.operation === 'reserve' ? 'CheckpointReserve' : 'CheckpointCommit'

      return this.checkpoint(agent, body, finish)
    }

    if (action === 'publications') {
      log.action = 'MatrixPublicationEnqueue'

      return this.publication(agent, body, finish)
    }

    log.action = 'ReadinessReport'

    return this.readinessReport(agent, body, finish)
  }

  // ------------------------------------------------------------------------ SQL: publication enqueue

  /**
   * `agent_home_publication_enqueue` (0280) behind the 0281 envelope: the exact bytes are checked against the signed
   * hash, the authority is admitted against the lease, epoch, term and a ledger operation that exists, a move in
   * flight refuses, the placement revision is the one signed, and an enqueue is idempotent by outbox id: the same
   * transaction, bytes and part return the row, anything else is a conflict. Refusals are answered as the frozen
   * receipt (403, `state: "refused"`); a stale authority or a move in progress creates no row.
   */
  private publication(agent: StubAgent, body: Record<string, unknown>, finish: Finish): Response {
    if (!validPublicationEnvelope(body) || body.publication.fence.agentPrincipal !== agent.agentPrincipal) {
      throw new StubHttpError(400, 'invalid')
    }

    const { publication, eventType, payloadBase64, part } = body
    this.verifiedSignature(agent, 'MatrixPublicationEnqueue', publication as unknown as { meta: ExecutorSignedMeta } & Record<string, unknown>)

    if (this.advanceRevisionBeforeNextPublication) {
      this.advanceRevisionBeforeNextPublication = false
      agent.placementRevision += 1
    }

    if (agent.erased) {
      throw new StubHttpError(403)
    }

    // The route answers an authority, move or revision refusal with the SQL's own body, `{outcome: "refused", reason}`,
    // in a 403 and creates no row; only a row that is itself refused is answered as a receipt (below).
    const refuse = (reason: PublicationReason) => finish(403, { outcome: 'refused', reason })

    const replay = this.replayRefusal(agent, publication.meta)

    if (replay) {
      return finish(403, replay)
    }

    const admitted = this.admit(agent, publication.fence, publication.meta, true)

    if (admitted.outcome === 'refused') {
      return refuse('stale_authority')
    }

    // 0284: a move that is only requested (no drain acknowledgement yet) still takes the source term's publications, tagged
    // with it; from the acknowledgement on, nothing new enters.
    let sourceMoveId: string | null = null

    if (agent.activeMoveId) {
      const move = agent.moves.get(agent.activeMoveId)

      if (!move || move.status !== 'requested' || move.drainAckedAt !== null || move.expectedHomeEpoch !== agent.homeEpoch) {
        return refuse('move_in_progress')
      }

      sourceMoveId = move.moveId
    }

    if (agent.placementRevision !== publication.expectedPlacementRevision) {
      return refuse('stale_authority')
    }

    const bytes = publicationPayloadBytes(payloadBase64)!
    const partIndex = part?.index ?? 0
    const partCount = part?.count ?? 1
    let row = agent.outbox.get(publication.outboxId)

    if (row) {
      // The same outbox id under anything else is a changed replay, said so by name.
      if (
        row.transactionId !== publication.transactionId ||
        row.payloadSha256 !== publication.payloadSha256 ||
        row.eventType !== eventType ||
        !row.payload.equals(bytes) ||
        row.partIndex !== partIndex ||
        row.partCount !== partCount ||
        row.roomId !== publication.roomId ||
        row.operation.kind !== publication.fence.operation.kind ||
        row.operation.id !== publication.fence.operation.id
      ) {
        throw new StubHttpError(409, 'agent_home_publication_changed_replay')
      }
    } else {
      if (this.publicationQueueFull) {
        throw new StubHttpError(429, 'agent_home_publication_queue_full', { 'retry-after': '60' })
      }

      row = {
        outboxId: publication.outboxId,
        homeEpoch: publication.fence.homeEpoch,
        placementRevision: agent.placementRevision,
        executorTerm: publication.fence.executorTerm,
        operation: publication.fence.operation,
        roomId: publication.roomId,
        transactionId: publication.transactionId,
        payloadSha256: publication.payloadSha256,
        eventType,
        payload: bytes,
        partIndex,
        partCount,
        state: 'queued',
        eventId: null,
        reason: null,
        attempts: 0,
        createdAt: this.now() * 1000 + agent.outbox.size,
        createdAtMs: this.now(),
        sourceMoveId
      }
      agent.outbox.set(row.outboxId, row)
    }

    // The Shell publishes the accepted row before it answers; the minute-cron worker is only the recovery.
    if (this.inlineMatrix && ['queued', 'admitted', 'sending'].includes(row.state)) {
      this.publishRow(agent, row, this.inlineMatrix)
    }

    const receipt = {
      outboxId: row.outboxId,
      fence: publication.fence,
      moveSerializationRevision: row.placementRevision,
      state: row.state,
      eventId: row.eventId,
      reason: row.reason
    }

    return finish(row.state === 'refused' ? 403 : 200, receipt)
  }

  // --------------------------------------------------------------------------------- SQL: ensure

  private ensure(agent: StubAgent) {
    if (agent.erased) {
      throw new StubHttpError(403)
    }

    // `agent_home_ensure`: with no placement yet one is made from the live executor lease, and with no live
    // executor the platform never guesses a location (503, "agent_home_unavailable").
    if (!agent.created) {
      if (!agent.lease || agent.lease.expiresAt <= this.now()) {
        throw new StubHttpError(503, 'unavailable')
      }

      agent.location = agent.lease.executorDevice === 'cloud' ? { kind: 'cloud' } : { kind: 'mac', deviceServiceId: agent.lease.executorDevice }
      agent.created = true
    }

    return this.placementJson(agent)
  }

  // ----------------------------------------------------------------------------- SQL: move ops

  private moveOperation(agent: StubAgent, body: Record<string, unknown>): unknown {
    switch (body.operation) {
      case 'request':
        return this.moveRequest(agent, body)

      case 'commit':
        return this.moveCommit(agent, body)

      case 'abort':
        return this.moveAbort(agent, body)

      case 'supersede':
        return this.moveSupersede(agent, body)

      default:
        throw new StubHttpError(400, 'invalid')
    }
  }

  private moveRequest(agent: StubAgent, body: Record<string, unknown>): unknown {
    if (
      !keysOf(body, ['operation', 'moveId', 'idempotencyKey', 'intent', 'target', 'expectedHomeEpoch', 'expectedPlacementRevision']) ||
      !isUuid(body.moveId) ||
      !isUuid(body.idempotencyKey) ||
      body.intent !== 'manual' ||
      !Number.isSafeInteger(body.expectedHomeEpoch) ||
      !Number.isSafeInteger(body.expectedPlacementRevision) ||
      !keysOf(body.target, ['kind', 'deviceServiceId'])
    ) {
      throw new StubHttpError(400, 'invalid')
    }

    const target = body.target as { kind: unknown; deviceServiceId: unknown }

    if (target.kind !== 'mac' || !isUuid(target.deviceServiceId)) {
      throw new StubHttpError(400, 'invalid')
    }

    const targetDevice = this.devices.get(target.deviceServiceId)

    if (!targetDevice || targetDevice.status !== 'active') {
      throw new StubHttpError(403)
    }

    if (agent.erased) {
      throw new StubHttpError(403)
    }

    // A move whose source is the cloud is outside slice 1.
    if (agent.location.kind === 'cloud') {
      throw new StubHttpError(400, 'cloud_source_out_of_scope')
    }

    const existing = [...agent.moves.values()].find(move => move.idempotencyKey === body.idempotencyKey)
    const targetLocation: HomeLocation = { kind: 'mac', deviceServiceId: target.deviceServiceId }

    if (existing) {
      if (
        existing.moveId !== body.moveId ||
        !sameLocation(existing.target, targetLocation) ||
        existing.expectedHomeEpoch !== body.expectedHomeEpoch ||
        existing.expectedPlacementRevision !== body.expectedPlacementRevision
      ) {
        throw new StubHttpError(409)
      }

      return { outcome: 'replay', move: this.moveJson(existing), placement: this.placementJson(agent) }
    }

    if (agent.homeEpoch !== body.expectedHomeEpoch || agent.placementRevision !== body.expectedPlacementRevision) {
      throw new StubHttpError(409)
    }

    if (sameLocation(agent.location, targetLocation)) {
      throw new StubHttpError(400)
    }

    if ([...agent.moves.values()].some(move => move.moveId === body.moveId)) {
      throw new StubHttpError(409)
    }

    let superseded = false

    if (agent.activeMoveId) {
      const active = agent.moves.get(agent.activeMoveId)!

      if (!['requested', 'draining', 'ready_to_commit'].includes(active.status)) {
        throw new StubHttpError(409)
      }

      active.status = 'superseded'
      active.supersededBy = body.moveId as string
      this.failReserved(agent, 'move_aborted')
      superseded = true
    }

    const move: StubMove = {
      moveId: body.moveId as string,
      idempotencyKey: body.idempotencyKey as string,
      intent: 'manual',
      status: 'requested',
      source: agent.location,
      target: targetLocation,
      expectedHomeEpoch: body.expectedHomeEpoch as number,
      expectedPlacementRevision: body.expectedPlacementRevision as number,
      requestedAt: this.now(),
      drainResult: null,
      drainAckedAt: null,
      drainOperation: null,
      checkpointGeneration: null,
      supersededBy: null,
      committedHomeEpoch: null,
      committedPlacementRevision: null,
      committedAt: null
    }

    agent.moves.set(move.moveId, move)
    agent.activeMoveId = move.moveId

    return {
      outcome: superseded ? 'superseded_previous' : 'requested',
      move: this.moveJson(move),
      placement: this.placementJson(agent)
    }
  }

  private moveCommit(agent: StubAgent, body: Record<string, unknown>): unknown {
    if (
      !keysOf(body, ['operation', 'moveId', 'idempotencyKey', 'expectedHomeEpoch', 'expectedPlacementRevision']) ||
      !isUuid(body.moveId) ||
      !isUuid(body.idempotencyKey)
    ) {
      throw new StubHttpError(400, 'invalid')
    }

    const move = agent.moves.get(body.moveId as string)

    if (!move || move.idempotencyKey !== body.idempotencyKey) {
      throw new StubHttpError(409)
    }

    if (move.status === 'committed') {
      return {
        outcome: 'already_committed',
        homeEpoch: move.committedHomeEpoch,
        placementRevision: move.committedPlacementRevision,
        committedAtPlatform: move.committedAt
      }
    }

    if (agent.erased) {
      throw new StubHttpError(403)
    }

    // 0281 and 0284: a commit that meets a publication the worker is sending right now waits for its lease to end, and
    // waits for every queued, admitted or sending row of the home and every unpublished row tagged to this move.
    if (
      (this.publicationSendingUntil !== null && this.now() < this.publicationSendingUntil) ||
      [...agent.outbox.values()].some(
        row =>
          row.homeEpoch === agent.homeEpoch &&
          (['queued', 'admitted', 'sending'].includes(row.state) || (row.sourceMoveId === move.moveId && row.state !== 'published'))
      )
    ) {
      throw new StubHttpError(409, 'agent_home_publication_in_flight')
    }

    if (
      agent.activeMoveId !== move.moveId ||
      move.status !== 'ready_to_commit' ||
      agent.homeEpoch !== body.expectedHomeEpoch ||
      agent.placementRevision !== body.expectedPlacementRevision ||
      move.expectedHomeEpoch !== body.expectedHomeEpoch ||
      move.expectedPlacementRevision > (body.expectedPlacementRevision as number)
    ) {
      throw new StubHttpError(409)
    }

    const checkpoint = [...agent.checkpoints.values()].find(each => each.generation === move.checkpointGeneration && each.state === 'committed')

    if (!checkpoint || checkpoint.generation !== agent.selectedGeneration) {
      throw new StubHttpError(409)
    }

    const target = move.target.kind === 'mac' ? this.devices.get(move.target.deviceServiceId) : undefined

    if (!target || target.status !== 'active') {
      throw new StubHttpError(409)
    }

    this.failReserved(agent, 'stale_epoch')
    agent.location = move.target
    agent.homeEpoch += 1
    agent.placementRevision += 1
    agent.activeMoveId = null
    move.status = 'committed'
    move.committedHomeEpoch = agent.homeEpoch
    move.committedPlacementRevision = agent.placementRevision
    move.committedAt = this.now()

    return {
      outcome: 'committed',
      homeEpoch: agent.homeEpoch,
      placementRevision: agent.placementRevision,
      selectedGeneration: agent.selectedGeneration,
      rollbackFloorGeneration: agent.rollbackFloorGeneration,
      committedAtPlatform: move.committedAt,
      placement: this.placementJson(agent)
    }
  }

  private moveAbort(agent: StubAgent, body: Record<string, unknown>): unknown {
    if (
      !keysOf(body, ['operation', 'moveId', 'idempotencyKey', 'expectedHomeEpoch', 'expectedPlacementRevision', 'reason']) ||
      !isUuid(body.moveId) ||
      !isUuid(body.idempotencyKey) ||
      !['drain_failed', 'target_unavailable', 'owner_cancelled', 'sleep_budget_elapsed'].includes(String(body.reason))
    ) {
      throw new StubHttpError(400, 'invalid')
    }

    const move = agent.moves.get(body.moveId as string)

    if (!move || move.idempotencyKey !== body.idempotencyKey) {
      throw new StubHttpError(409)
    }

    if (move.status === 'committed') {return { outcome: 'committed_epoch_preserved' }}

    if (move.status === 'aborted') {return { outcome: 'already_aborted' }}

    if (
      agent.homeEpoch !== body.expectedHomeEpoch ||
      agent.placementRevision !== body.expectedPlacementRevision ||
      agent.activeMoveId !== move.moveId
    ) {
      return { outcome: 'stale_cas' }
    }

    move.status = 'aborted'
    this.failReserved(agent, 'move_aborted')
    agent.activeMoveId = null

    return { outcome: 'aborted' }
  }

  private moveSupersede(agent: StubAgent, body: Record<string, unknown>): unknown {
    if (
      !keysOf(body, ['operation', 'winningMoveId', 'supersededMoveId', 'expectedHomeEpoch', 'expectedPlacementRevision']) ||
      !isUuid(body.winningMoveId) ||
      !isUuid(body.supersededMoveId)
    ) {
      throw new StubHttpError(400, 'invalid')
    }

    const losing = agent.moves.get(body.supersededMoveId as string)
    const winning = agent.moves.get(body.winningMoveId as string)

    if (!losing || !winning) {
      throw new StubHttpError(409)
    }

    if (losing.status === 'committed') {return { outcome: 'committed_epoch_preserved' }}

    if (losing.status === 'superseded' && losing.supersededBy === winning.moveId) {return { outcome: 'already_superseded' }}

    throw new StubHttpError(409)
  }

  // ------------------------------------------------------------------------------- SQL: drain ack

  private drain(agent: StubAgent, body: Record<string, unknown>, finish: Finish): Response {
    if (
      !keysOf(body, ['meta', 'moveId', 'fence', 'result']) ||
      !validExecutorMeta(body.meta) ||
      !isUuid(body.moveId) ||
      !validAuthorityFence(body.fence) ||
      !['quiesced', 'timed_out', 'unreachable'].includes(String(body.result))
    ) {
      throw new StubHttpError(400, 'invalid')
    }

    const meta = body.meta as ExecutorSignedMeta
    this.verifiedSignature(agent, 'DrainAck', body as { meta: ExecutorSignedMeta } & Record<string, unknown>)

    if (agent.erased) {
      throw new StubHttpError(403)
    }

    const move = agent.moves.get(body.moveId as string)

    if (!move || agent.activeMoveId !== move.moveId) {
      throw new StubHttpError(409)
    }

    const admitted = this.admit(agent, body.fence, meta)

    if (admitted.outcome === 'refused') {
      return finish(403, admitted)
    }

    const replay = this.replayRefusal(agent, meta)

    if (replay) {
      return finish(403, replay)
    }

    if (['draining', 'ready_to_commit'].includes(move.status) && move.drainResult === 'quiesced') {
      return finish(200, { outcome: 'replay', move: this.moveJson(move) })
    }

    if (!['requested', 'draining'].includes(move.status)) {
      throw new StubHttpError(409)
    }

    move.drainResult = body.result as StubMove['drainResult']
    move.drainAckedAt = this.now()
    move.drainOperation = (body.fence as HomeAuthorityFence).operation

    if (body.result === 'quiesced') {
      move.status = 'draining'
      this.failReserved(agent, 'move_started')
    } else {
      move.status = 'aborted'
      agent.activeMoveId = null
      this.failReserved(agent, 'move_aborted')
    }

    return finish(200, { outcome: body.result === 'quiesced' ? 'draining' : 'aborted', move: this.moveJson(move) })
  }

  // -------------------------------------------------------------------------- SQL: checkpoints

  private checkpoint(agent: StubAgent, body: Record<string, unknown>, finish: Finish): Response {
    if (body.operation === 'reserve') {
      if (
        !keysOf(body, ['operation', 'meta', 'checkpointId', 'expectedPlacementRevision', 'fence']) ||
        !validExecutorMeta(body.meta) ||
        !isUuid(body.checkpointId) ||
        !Number.isSafeInteger(body.expectedPlacementRevision) ||
        !validAuthorityFence(body.fence)
      ) {
        throw new StubHttpError(400, 'invalid')
      }

      this.verifiedSignature(agent, 'CheckpointReserve', body as { meta: ExecutorSignedMeta } & Record<string, unknown>)

      return this.reserve(agent, body, finish)
    }

    if (body.operation === 'commit') {
      if (
        !keysOf(body, [
          'operation',
          'meta',
          'checkpointId',
          'generation',
          'parentGeneration',
          'expectedHomeEpoch',
          'expectedPlacementRevision',
          'manifestSha256',
          'uploadVerified',
          'fence'
        ]) ||
        !validExecutorMeta(body.meta) ||
        !isUuid(body.checkpointId) ||
        !/^[0-9a-f]{64}$/u.test(String(body.manifestSha256)) ||
        typeof body.uploadVerified !== 'boolean' ||
        !validAuthorityFence(body.fence)
      ) {
        throw new StubHttpError(400, 'invalid')
      }

      this.verifiedSignature(agent, 'CheckpointCommit', body as { meta: ExecutorSignedMeta } & Record<string, unknown>)

      return this.commit(agent, body, finish)
    }

    throw new StubHttpError(400, 'invalid')
  }

  private reserve(agent: StubAgent, body: Record<string, unknown>, finish: Finish): Response {
    const meta = body.meta as ExecutorSignedMeta
    const admitted = this.admit(agent, body.fence, meta)

    if (admitted.outcome === 'refused') {
      return finish(403, admitted)
    }

    if (agent.erased) {
      throw new StubHttpError(403)
    }

    if (agent.placementRevision !== body.expectedPlacementRevision) {
      return finish(200, { outcome: 'stale_revision', placementRevision: agent.placementRevision })
    }

    const replay = this.replayRefusal(agent, meta)

    if (replay) {
      return finish(403, replay)
    }

    for (const each of agent.checkpoints.values()) {
      if (each.state === 'reserved' && each.reservedAt <= this.now() - RESERVATION_MS) {
        each.state = 'failed'
        each.failure = 'reservation_expired'
      }
    }

    const existing = agent.checkpoints.get(body.checkpointId as string)

    if (existing) {
      if (existing.generation !== agent.selectedGeneration + 1 || existing.parentGeneration !== agent.selectedGeneration) {
        throw new StubHttpError(409)
      }

      if (existing.state !== 'reserved') {
        throw new StubHttpError(409)
      }

      return finish(200, {
        outcome: 'reserved',
        replayed: true,
        checkpointId: existing.checkpointId,
        generation: existing.generation,
        parentGeneration: existing.parentGeneration,
        homeEpoch: existing.producingHomeEpoch,
        placementRevision: existing.expectedPlacementRevision
      })
    }

    if ([...agent.checkpoints.values()].some(each => each.state === 'reserved')) {
      throw new StubHttpError(409)
    }

    const active = agent.activeMoveId ? agent.moves.get(agent.activeMoveId) : undefined
    const moveId = active && ['draining', 'ready_to_commit'].includes(active.status) ? active.moveId : null

    const checkpoint: StubCheckpoint = {
      checkpointId: body.checkpointId as string,
      generation: agent.selectedGeneration + 1,
      parentGeneration: agent.selectedGeneration,
      producingHomeEpoch: agent.homeEpoch,
      expectedPlacementRevision: agent.placementRevision,
      moveId,
      state: 'reserved',
      failure: null,
      manifestSha256: null,
      reservedAt: this.now()
    }

    agent.checkpoints.set(checkpoint.checkpointId, checkpoint)

    return finish(200, {
      outcome: 'reserved',
      replayed: false,
      checkpointId: checkpoint.checkpointId,
      generation: checkpoint.generation,
      parentGeneration: checkpoint.parentGeneration,
      homeEpoch: checkpoint.producingHomeEpoch,
      placementRevision: checkpoint.expectedPlacementRevision
    })
  }

  private commit(agent: StubAgent, body: Record<string, unknown>, finish: Finish): Response {
    const meta = body.meta as ExecutorSignedMeta
    const admitted = this.admit(agent, body.fence, meta)

    if (admitted.outcome === 'refused') {
      return finish(403, admitted)
    }

    if (agent.erased) {
      throw new StubHttpError(403)
    }

    const replay = this.replayRefusal(agent, meta)

    if (replay) {
      return finish(403, replay)
    }

    const checkpoint = agent.checkpoints.get(body.checkpointId as string)

    if (!checkpoint) {
      throw new StubHttpError(409)
    }

    if (checkpoint.state === 'reserved' && checkpoint.reservedAt <= this.now() - RESERVATION_MS) {
      checkpoint.state = 'failed'
      checkpoint.failure = 'reservation_expired'

      return finish(200, { outcome: 'reservation_expired', selectedGeneration: agent.selectedGeneration, placementRevision: agent.placementRevision })
    }

    // 0284: a verified commit needs the durable receipt of the upload, and the manifest it names must be the one on it.
    if (body.uploadVerified === true && checkpoint.state !== 'committed') {
      const receipt = this.archiveReceipts.get(checkpoint.checkpointId)

      if (!receipt || (receipt.manifestSha256 !== null && receipt.manifestSha256 !== body.manifestSha256)) {
        if (checkpoint.state === 'reserved') {
          checkpoint.state = 'failed'
          checkpoint.failure = 'verification_failed'
        }

        return finish(200, { outcome: 'verification_failed', selectedGeneration: agent.selectedGeneration, placementRevision: agent.placementRevision })
      }
    }

    if (checkpoint.state === 'committed') {
      if (checkpoint.manifestSha256 !== body.manifestSha256 || body.uploadVerified !== true) {
        throw new StubHttpError(409)
      }

      return finish(200, {
        outcome: 'already_committed',
        checkpointId: checkpoint.checkpointId,
        generation: checkpoint.generation,
        selectedGeneration: agent.selectedGeneration,
        placementRevision: agent.placementRevision,
        manifestSha256: checkpoint.manifestSha256
      })
    }

    if (
      checkpoint.state !== 'reserved' ||
      checkpoint.generation !== agent.selectedGeneration + 1 ||
      checkpoint.parentGeneration !== agent.selectedGeneration ||
      checkpoint.generation !== body.generation ||
      checkpoint.parentGeneration !== body.parentGeneration ||
      agent.homeEpoch !== body.expectedHomeEpoch ||
      agent.placementRevision !== body.expectedPlacementRevision
    ) {
      return finish(200, { outcome: 'stale_cas', selectedGeneration: agent.selectedGeneration, placementRevision: agent.placementRevision })
    }

    if (body.uploadVerified !== true) {
      checkpoint.state = 'failed'
      checkpoint.failure = 'stale_epoch'
      checkpoint.manifestSha256 = body.manifestSha256 as string

      return finish(200, {
        outcome: 'verification_failed',
        selectedGeneration: agent.selectedGeneration,
        placementRevision: agent.placementRevision
      })
    }

    checkpoint.state = 'committed'
    checkpoint.manifestSha256 = body.manifestSha256 as string
    agent.selectedGeneration = checkpoint.generation
    agent.placementRevision += 1

    const receipt = this.archiveReceipts.get(checkpoint.checkpointId)

    if (receipt) {
      receipt.manifestSha256 = checkpoint.manifestSha256
    }

    const move = agent.activeMoveId ? agent.moves.get(agent.activeMoveId) : undefined

    // Only a reservation made after the drain acknowledgement, for this move, readies it.
    if (
      move &&
      move.status === 'draining' &&
      move.drainResult === 'quiesced' &&
      checkpoint.moveId === move.moveId &&
      checkpoint.reservedAt >= (move.drainAckedAt ?? Infinity)
    ) {
      move.status = 'ready_to_commit'
      move.checkpointGeneration = checkpoint.generation
    }

    return finish(200, {
      outcome: 'committed',
      checkpointId: checkpoint.checkpointId,
      generation: checkpoint.generation,
      selectedGeneration: agent.selectedGeneration,
      placementRevision: agent.placementRevision,
      manifestSha256: checkpoint.manifestSha256
    })
  }

  // --------------------------------------------------------------------------- SQL: readiness

  private readinessReport(agent: StubAgent, body: Record<string, unknown>, finish: Finish): Response {
    const checks = record(body.checks)

    if (
      !keysOf(body, ['meta', 'fence', 'reportedAtLocal', 'powerState', 'checks']) ||
      !validExecutorMeta(body.meta) ||
      !validLeaseFence(body.fence) ||
      !Number.isSafeInteger(body.reportedAtLocal) ||
      !['awake', 'asleep_wakeable', 'asleep_not_wakeable', 'unknown'].includes(String(body.powerState)) ||
      !checks ||
      !keysOf(checks, ['homeAccessible', 'runtimeUsable', 'matrixIntakeWorking']) ||
      Object.values(checks).some(value => typeof value !== 'boolean')
    ) {
      throw new StubHttpError(400, 'invalid')
    }

    const meta = body.meta as ExecutorSignedMeta
    this.verifiedSignature(agent, 'ReadinessReport', body as { meta: ExecutorSignedMeta } & Record<string, unknown>)

    if (agent.erased) {
      throw new StubHttpError(403)
    }

    const fence = body.fence as { homeId: string; homeEpoch: number; leaseId: string; executorTerm: number }
    const lease = agent.lease
    const now = this.now()

    if (
      !lease ||
      fence.homeId !== agent.homeId ||
      fence.homeEpoch !== agent.homeEpoch ||
      fence.leaseId !== lease.leaseId ||
      fence.executorTerm !== lease.term ||
      lease.expiresAt <= now
    ) {
      return finish(403, { outcome: 'refused', reason: 'stale_authority' })
    }

    const replay = this.replayRefusal(agent, meta)

    if (replay) {
      return finish(403, replay)
    }

    const ready =
      checks.homeAccessible === true &&
      checks.runtimeUsable === true &&
      checks.matrixIntakeWorking === true &&
      body.powerState !== 'asleep_not_wakeable'

    agent.readiness = {
      receivedAt: now,
      lastReadyAt: ready ? now : (agent.readiness?.lastReadyAt ?? null),
      reachable: ready,
      powerState: String(body.powerState),
      homeEpoch: agent.homeEpoch
    }

    return finish(200, {
      ownerUserId: this.ownerUserId,
      agentPrincipal: agent.agentPrincipal,
      homeId: agent.homeId,
      homeEpoch: agent.homeEpoch,
      receivedAtPlatform: now,
      lastReadyAtPlatform: ready ? now : null,
      reachable: ready,
      powerState: body.powerState,
      basis: 'authenticated_agent_service_readiness'
    })
  }

  // ------------------------------------------------------------- the archive and key routes (#664 at cc433d9a)

  /**
   * `agent_home_archive_device_allowed` (0284): the placement's Mac, or the target of its one active move. The routes admit
   * a DEVICE and say nothing about a lease: a move's target holds none until it is the home.
   */
  private deviceAllowed(agent: StubAgent, device: string): boolean {
    if (!agent.created || agent.erased) {
      return false
    }

    if (agent.location.kind === 'mac' && agent.location.deviceServiceId === device) {
      return true
    }

    const move = agent.activeMoveId ? agent.moves.get(agent.activeMoveId) : undefined

    return Boolean(
      move &&
        move.target.kind === 'mac' &&
        move.target.deviceServiceId === device &&
        ['requested', 'draining', 'ready_to_commit'].includes(move.status)
    )
  }

  /** The body of one key or archive call, field for field as the Shell's `KeyActionSchema` and `ArchiveActionSchema` (all `.strict()`) read it. */
  private parseCustody(body: Record<string, unknown>, route: { key: true } | { generation: number }): Custody {
    const invalid = new StubHttpError(400, 'invalid')
    const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    const { meta, fence } = body

    if (!validExecutorMeta(meta) || !validAuthorityFence(fence)) {
      throw invalid
    }

    if ('key' in route) {
      if (!keysOf(body, ['meta', 'fence'])) {
        throw invalid
      }

      return { operation: 'key', meta, fence }
    }

    const sized = (value: unknown): value is number => positive(value) && value <= 2_147_483_648

    if (body.operation === 'begin') {
      if (
        !keysOf(body, ['operation', 'meta', 'fence', 'checkpointId', 'generation', 'byteSize']) ||
        !isUuid(body.checkpointId) ||
        body.generation !== route.generation ||
        !positive(body.generation) ||
        !sized(body.byteSize)
      ) {
        throw invalid
      }

      return { operation: 'begin', meta, fence, checkpointId: body.checkpointId, generation: body.generation, byteSize: body.byteSize }
    }

    if (body.operation === 'finalize') {
      if (
        !keysOf(body, ['operation', 'meta', 'fence', 'checkpointId', 'generation', 'byteSize', 'uploadToken', 'archiveSha256']) ||
        !isUuid(body.checkpointId) ||
        body.generation !== route.generation ||
        !positive(body.generation) ||
        !sized(body.byteSize) ||
        !isUuid(body.uploadToken) ||
        typeof body.archiveSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(body.archiveSha256)
      ) {
        throw invalid
      }

      return {
        operation: 'finalize',
        meta,
        fence,
        checkpointId: body.checkpointId,
        generation: body.generation,
        byteSize: body.byteSize,
        uploadToken: body.uploadToken,
        archiveSha256: body.archiveSha256
      }
    }

    if (body.operation === 'download') {
      if (!keysOf(body, ['operation', 'meta', 'fence', 'generation']) || body.generation !== route.generation || !positive(body.generation)) {
        throw invalid
      }

      return { operation: 'download', meta, fence, generation: body.generation }
    }

    throw invalid
  }

  /**
   * The Shell's `verifiedArchiveRoute` and 0284's `agent_home_seal_binding`: the signature window, the pinned key, the
   * signature, the device (the placement's or the active move's target), the fence's owner, agent, home and epoch against
   * the placement, and the replay tuple. The fence's lease, term and operation are NOT looked at: only their shape.
   */
  private admitCustody(agent: StubAgent, action: string, custody: Custody, raw: Record<string, unknown>): void {
    const { meta, fence } = custody
    const current = this.now()

    if (meta.issuedAt > current || meta.expiresAt <= current || meta.expiresAt > meta.issuedAt + SIGNED_MESSAGE_MAX_MS) {
      throw new StubHttpError(401, 'signature_expired')
    }

    this.pinnedAndSigned(action, raw as { meta: ExecutorSignedMeta } & Record<string, unknown>)

    if (
      !this.deviceAllowed(agent, meta.deviceServiceId) ||
      fence.ownerUserId !== this.ownerUserId ||
      fence.agentPrincipal !== agent.agentPrincipal ||
      fence.homeId !== agent.homeId ||
      fence.homeEpoch !== agent.homeEpoch
    ) {
      throw new StubHttpError(403)
    }

    if (this.replayAdmit(meta.deviceServiceId, meta) !== 'accepted') {
      throw new StubHttpError(409, 'agent_home_archive_replayed', { 'retry-after': '1' })
    }
  }

  /** A JSON POST of at most 16 KiB with the exact content type, parsed. */
  private async custodyBody(request: Request): Promise<Record<string, unknown>> {
    if (request.method !== 'POST' || request.headers.get('content-type') !== 'application/json') {
      throw new StubHttpError(400, 'invalid')
    }

    const text = await request.text()

    if (text.length > 16_384) {
      throw new StubHttpError(400, 'invalid')
    }

    try {
      const row = record(JSON.parse(text) as unknown)

      if (row) {
        return row
      }
    } catch {
      // Not JSON.
    }

    throw new StubHttpError(400, 'invalid')
  }

  /**
   * `POST …/home/key`, action `HomeKeyRead`: one 32-byte `owner_agent_home` key per home, derived from the sealing root the
   * Shell keeps. Without a root: 503 `not_configured`, after the signature has been checked.
   */
  private async keyRoute(request: Request, agent: StubAgent, log: StubRequestLog, finish: Finish): Promise<Response> {
    const raw = await this.custodyBody(request)
    const custody = this.parseCustody(raw, { key: true })
    log.action = 'HomeKeyRead'
    this.admitCustody(agent, 'HomeKeyRead', custody, raw)

    const injected = this.injected('HomeKeyRead', finish)

    if (injected) {
      return injected
    }

    if (!this.sealingConfigured) {
      throw new StubHttpError(503, 'not_configured')
    }

    return this.altered('HomeKeyRead', finish)(200, this.sealKey(agent))
  }

  /**
   * The key as `agent-home-archive.ts` derives it. The id is NOT the digest of the key: it names the root version, the
   * owner, the agent and the home (`agentHomeSealKeyId`), so a Mac cannot recompute it from the key alone.
   */
  private sealKey(agent: StubAgent) {
    const key = createHash('sha256').update(`stub-sealing-root|${this.ownerUserId}|${agent.agentPrincipal}|${agent.homeId}`).digest()

    const keyId = createHash('sha256')
      .update(Buffer.from([1]))
      .update(`atum.agent-home/2.1${NUL}owner_agent_home${NUL}${this.ownerPrincipal}${NUL}${agent.agentPrincipal}${NUL}${agent.homeId}`, 'utf8')
      .digest('base64url')

    return { v: 1, rootVersion: 1, homeId: agent.homeId, keyId, key: key.toString('base64url') }
  }

  private injected(action: string, finish: Finish): Response | null {
    const fail = this.failAction

    if (!fail || fail.action !== action) {
      return null
    }

    // Once, unless the test asked for more.
    if ((fail.times ?? 1) <= 1) {
      this.failAction = null
    } else {
      fail.times = (fail.times ?? 1) - 1
    }

    if (fail.body !== undefined) {
      return finish(fail.status, fail.body, fail.headers)
    }

    throw new StubHttpError(fail.status, fail.reason, fail.headers)
  }

  /** `finish`, with the test's `alterAnswer` applied to the 200 answer of this action. */
  private altered(action: string, finish: Finish): Finish {
    return (status, body, headers) => {
      const alter = this.alterAnswer

      if (status === 200 && alter && alter.action === action) {
        // Once, unless the test asked for more.
        if ((alter.times ?? 1) <= 1) {
          this.alterAnswer = null
        } else {
          alter.times = (alter.times ?? 1) - 1
        }

        return finish(status, alter.change(body as Record<string, unknown>), headers)
      }

      return finish(status, body, headers)
    }
  }

  /** A 409 as the Shell raises it: `{error, details: {reason}}` and a `Retry-After`. */
  private conflict(reason: string, retryAfterSeconds = 1): StubHttpError {
    return new StubHttpError(409, reason, { 'retry-after': String(retryAfterSeconds) })
  }

  /**
   * `POST …/home/checkpoints/{generation}/archive`: `begin`, `finalize` and `download`, as `agent-home-archive.ts` and 0284's
   * custody functions answer them. No archive byte passes through here.
   */
  private async archiveRoute(request: Request, agent: StubAgent, generation: number, log: StubRequestLog, finish: Finish): Promise<Response> {
    const raw = await this.custodyBody(request)
    const custody = this.parseCustody(raw, { generation })

    log.action = { begin: 'CheckpointArchiveBegin', finalize: 'CheckpointArchiveFinalize', download: 'CheckpointArchiveDownload', key: 'HomeKeyRead' }[custody.operation]
    this.admitCustody(agent, log.action, custody, raw)

    const injected = this.injected(log.action, finish)

    if (injected) {
      return injected
    }

    const answer = this.altered(log.action, finish)

    if (custody.operation === 'begin') {
      return this.archiveBegin(agent, custody, answer)
    }

    if (custody.operation === 'finalize') {
      return this.archiveFinalize(agent, custody, answer)
    }

    if (custody.operation === 'download') {
      return this.archiveDownload(agent, custody, answer)
    }

    throw new StubHttpError(400, 'invalid')
  }

  /** `agent_home_checkpoint_archive_upload_begin`, then the Storage client's `createSignedUploadUrl`. */
  private archiveBegin(agent: StubAgent, custody: Extract<Custody, { operation: 'begin' }>, finish: Finish): Response {
    const checkpoint = agent.checkpoints.get(custody.checkpointId)

    if (!checkpoint || checkpoint.generation !== custody.generation || !['reserved', 'committed'].includes(checkpoint.state)) {
      throw this.conflict('agent_home_archive_conflict')
    }

    const attempt = this.attempts.get(checkpoint.checkpointId)

    // An upload already finalized is immutable: the same size is a replay (the stored digest answers it), another is not.
    if (attempt?.state === 'ready') {
      if (attempt.byteSize !== custody.byteSize) {
        throw this.conflict('agent_home_archive_conflict')
      }

      return finish(200, { outcome: 'stored', checkpointId: checkpoint.checkpointId, generation: checkpoint.generation, bytes: attempt.byteSize, sha256: attempt.sha256, rootVersion: 1 })
    }

    if (checkpoint.state !== 'reserved') {
      throw this.conflict('agent_home_archive_conflict')
    }

    if (this.archiveUploadBusy) {
      throw this.conflict('agent_home_archive_upload_busy', 2)
    }

    if (attempt && attempt.expiresAt > this.now()) {
      throw this.conflict('agent_home_archive_upload_busy', Math.max(1, Math.ceil((attempt.expiresAt - this.now()) / 1000)))
    }

    if (!this.storageConfigured) {
      throw new StubHttpError(503, 'not_configured')
    }

    if (this.archivePutFails) {
      throw new StubHttpError(503, 'archive_store_unavailable')
    }

    // A new attempt: a new id and a new server-built path, so a token from an older attempt can only create an unreferenced object.
    const attemptId = this.uuid()
    const path = `agent-home/v2.1/${this.ownerPrincipal}/${agent.agentPrincipal}/${agent.homeId}/generations/${checkpoint.generation}/${checkpoint.checkpointId}.${attemptId}.sealed`
    const token = this.storage.mintUploadToken(path)
    const expiresAt = this.now() + 90_000

    this.attempts.set(checkpoint.checkpointId, {
      checkpointId: checkpoint.checkpointId,
      homeId: agent.homeId,
      generation: checkpoint.generation,
      path,
      byteSize: custody.byteSize,
      attemptId,
      expiresAt,
      state: 'uploading',
      sha256: null
    })

    return finish(200, {
      outcome: 'upload',
      checkpointId: checkpoint.checkpointId,
      generation: checkpoint.generation,
      rootVersion: 1,
      upload: {
        protocol: 'tus',
        endpoint: `${this.storageOrigin}/storage/v1/upload/resumable`,
        bucket: STORAGE_BUCKET,
        path,
        token,
        attemptId,
        expiresAt,
        chunkBytes: TUS_CHUNK_BYTES,
        headers: { 'x-signature': token, 'x-upsert': 'false' }
      }
    })
  }

  /**
   * `agent_home_checkpoint_archive_upload_check`, Storage's own metadata (`info`), then `..._upload_complete`: the digest
   * recorded is the one the Mac declared in its signed frame, and only the size is Storage's.
   */
  private archiveFinalize(agent: StubAgent, custody: Extract<Custody, { operation: 'finalize' }>, finish: Finish): Response {
    const attempt = this.attempts.get(custody.checkpointId)

    if (!attempt || attempt.generation !== custody.generation || attempt.byteSize !== custody.byteSize) {
      throw this.conflict('agent_home_archive_conflict')
    }

    if (attempt.state === 'ready') {
      if (attempt.sha256 !== custody.archiveSha256) {
        throw this.conflict('agent_home_archive_changed_replay')
      }

      return finish(200, { outcome: 'stored', bytes: attempt.byteSize, sha256: attempt.sha256, rootVersion: 1 })
    }

    if (attempt.attemptId !== custody.uploadToken || attempt.expiresAt <= this.now()) {
      throw this.conflict('agent_home_archive_conflict')
    }

    const stored = this.storage.sizeOf(attempt.path)

    if (stored === null) {
      throw this.conflict('agent_home_archive_upload_incomplete', 2)
    }

    if (stored !== custody.byteSize) {
      throw this.conflict('agent_home_archive_size_mismatch', 2)
    }

    const checkpoint = agent.checkpoints.get(custody.checkpointId)

    if (!checkpoint || checkpoint.state !== 'reserved') {
      throw this.conflict('agent_home_archive_conflict')
    }

    this.makeReady(attempt, this.storage.objects.get(attempt.path)!, custody.archiveSha256)

    return finish(200, { outcome: 'stored', bytes: attempt.byteSize, sha256: custody.archiveSha256, rootVersion: 1 })
  }

  /** The upload is final: what the database holds is the declared digest and the object's size. */
  private makeReady(attempt: ArchiveAttempt, object: Buffer, sha256: string): void {
    attempt.state = 'ready'
    attempt.sha256 = sha256
    this.archives.set(`${attempt.homeId}:${attempt.generation}`, object)
    this.archiveReceipts.set(attempt.checkpointId, {
      generation: attempt.generation,
      homeId: attempt.homeId,
      bytes: attempt.byteSize,
      sha256,
      manifestSha256: null,
      data: object
    })
  }

  /**
   * `agent_home_checkpoint_archive_read`, then `createSignedUrl(..., 90)`: only the committed checkpoint's archive, once its
   * manifest digest is bound to it. Anything else is a JSON 404.
   */
  private archiveDownload(agent: StubAgent, custody: Extract<Custody, { operation: 'download' }>, finish: Finish): Response {
    const committed = [...agent.checkpoints.values()].find(each => each.generation === custody.generation && each.state === 'committed')
    const receipt = committed ? this.archiveReceipts.get(committed.checkpointId) : undefined
    const attempt = committed ? this.attempts.get(committed.checkpointId) : undefined

    if (agent.erased || !committed || !receipt || receipt.manifestSha256 === null || !attempt) {
      throw new StubHttpError(404)
    }

    if (!this.storageConfigured) {
      throw new StubHttpError(503, 'not_configured')
    }

    const token = this.storage.mintDownloadToken(attempt.path)

    return finish(200, {
      url: `${this.storageOrigin}/storage/v1/object/sign/${STORAGE_BUCKET}/${attempt.path}?token=${token}`,
      expiresAt: this.now() + 90_000,
      bytes: receipt.bytes,
      sha256: receipt.sha256,
      manifestSha256: receipt.manifestSha256,
      rootVersion: 1
    })
  }

  /**
   * A shortcut for the tests of the checkpoint route, which need "the sealed bytes of a reserved generation are stored" and
   * not the three calls and the upload that get them there: it leaves the platform as `begin`, a complete upload and
   * `finalize` would. Where no checkpoint of that generation is open for writing, `begin` would refuse, and so does this
   * (nothing is stored, and the answer is false).
   */
  storeArchive(agentPrincipal: string, generation: number, bytes: Buffer): boolean {
    const agent = this.agent(agentPrincipal)
    const checkpoint = [...agent.checkpoints.values()].find(each => each.generation === generation && each.state === 'reserved')

    if (!checkpoint) {
      return false
    }

    const attemptId = this.uuid()
    const path = `agent-home/v2.1/${this.ownerPrincipal}/${agent.agentPrincipal}/${agent.homeId}/generations/${generation}/${checkpoint.checkpointId}.${attemptId}.sealed`
    this.storage.objects.set(path, bytes)

    const attempt: ArchiveAttempt = {
      checkpointId: checkpoint.checkpointId,
      homeId: agent.homeId,
      generation,
      path,
      byteSize: bytes.byteLength,
      attemptId,
      expiresAt: this.now(),
      state: 'uploading',
      sha256: null
    }

    this.attempts.set(checkpoint.checkpointId, attempt)
    this.makeReady(attempt, bytes, createHash('sha256').update(bytes).digest('hex'))

    return true
  }
}

/** A key or archive call, parsed. */
type Custody =
  | { operation: 'key'; meta: ExecutorSignedMeta; fence: HomeAuthorityFence }
  | { operation: 'begin'; meta: ExecutorSignedMeta; fence: HomeAuthorityFence; checkpointId: string; generation: number; byteSize: number }
  | {
      operation: 'finalize'
      meta: ExecutorSignedMeta
      fence: HomeAuthorityFence
      checkpointId: string
      generation: number
      byteSize: number
      uploadToken: string
      archiveSha256: string
    }
  | { operation: 'download'; meta: ExecutorSignedMeta; fence: HomeAuthorityFence; generation: number }
