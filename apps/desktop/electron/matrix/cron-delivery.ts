/**
 * Scheduled jobs into rooms, the app's side (
 * §4.5; Hermes's side is tui_gateway/host_delivery.py).
 *
 * A Hermes backend's cron ticker asks this app to post a run's result
 * (`cron.delivery.request`). The app posts as the agent, only into that agent's own room
 * with its owner, and at most once per run:
 * - a pending record is kept from before the post until it settles;
 * - a quit in between is resumed at the next start. The room is read back first
 *   (`findTurn`, marker `cron`), and the result is posted only when it is absent.
 * The receipt goes back with `cron.delivery.respond`, so Hermes records a real
 * delivery error.
 */
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { ConversationUnavailableError, EarlierConversationError } from '../../shared/agent-conversation'
import type { MatrixTurnLookup } from '../../shared/matrix'
import { matrixCronRunId, matrixTurnId } from '../../shared/matrix-turn'

export interface MatrixCronRequest {
  requestId: string
  roomId: string
  text: string
  jobId: string
  runId: string
}

export type MatrixCronReceipt = { status: 'delivered'; event_id: string } | { status: 'failed'; error: string }

/** A post between the request and its settlement: what a resumed attempt needs. */
export interface MatrixCronPost {
  roomId: string
  text: string
  jobId: string
  runId: string
  /** When the request arrived; the read-back must reach before it to prove absence. */
  since: number
  /** A background sweep is sealed before platform settlement and cannot publish until admitted. */
  held?: true
  /** Stable reference supplied to the sweep settlement. */
  outboxId?: string
  bodySha256?: string
  /** Managed recovery belongs to this outbox, including the publication receipt. */
  occurrence?: MatrixCronOccurrence
  publishedEvent?: string
  settled?: true
  /** The home that ran it can no longer publish it (moved, new term, or past the horizon). Never published again. */
  stranded?: true
}

/** The D1 home that executed a managed occurrence. Only that exact home/term may publish or settle it
 * (0384 `job_occurrence_fence`); a later home, including this Mac under a new epoch or term, never does. */
export interface MatrixCronOccurrenceHome {
  homeId: string
  homeEpoch: number
  executorTerm: number
  leaseId: string
}

export interface MatrixCronOccurrence {
  assistantId: string
  executorId: string
  occurrenceId: string
  computeSeconds: number
  home: MatrixCronOccurrenceHome
}

/** Thrown by a managed dependency when the current home is not the one bound to the post. */
export const MATRIX_CRON_STRANDED = 'matrix_cron_stranded'

export interface MatrixCronSealedPost {
  outboxId: string
  bodySha256: string
}

export interface MatrixCronStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface MatrixCronGateway {
  on(type: string, handler: (event: { payload?: unknown }) => void): () => void
  request<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>
}

export interface MatrixCronDeliveryDeps {
  /** The agent's own vault: the root for the default agent, its scope for any other
   * ( §2.6), so each agent's pending list stays
   * apart. */
  store: MatrixCronStore
  /** Throws unless the room is this agent's own room with its owner. */
  requireRoom(roomId: string): Promise<void>
  /** Posts as the agent (`publishCron`) and returns the event ID. A managed post carries the attempt's bound. */
  publish(post: MatrixCronPost, signal?: AbortSignal): Promise<string>
  /** Reads the room back for the run's post (`findTurn`, marker `cron`). */
  find(post: MatrixCronPost): Promise<MatrixTurnLookup>
  /** Must use the signed occurrence route; retry with the same occurrence/event identity. */
  settleManaged?(post: MatrixCronPost, eventId: string, signal?: AbortSignal): Promise<void>
  /** Recheck current occurrence/home authority immediately before a new publication. Both throw
   * `MATRIX_CRON_STRANDED` when the current home is not `post.occurrence.home`. */
  authorizeManaged?(post: MatrixCronPost, signal?: AbortSignal): Promise<void>
  now?: () => number
  log(line: string): void
}

export const MATRIX_CRON_PENDING_KEY = 'matrix-cron-pending'
/** Posts are small and rare; a long outage keeps at most this many. */
const MAX_PENDING = 32
/** A result a day old is no longer worth posting. */
const PENDING_TTL_MS = 24 * 60 * 60_000
/** A finished managed record is kept this long so a repeated host request for its run cannot publish twice. */
const MANAGED_RETAIN_MS = 2 * PENDING_TTL_MS
/** Background retries of one managed record back off to this; a D1 drain ignores the backoff. */
const MANAGED_RETRY_MAX_MS = 60_000
/** Failures that no retry can fix: nothing was sent, so nothing is kept. A check-in the app
 * declined to post (check-ins.ts: a repeat, over the day's cap, the owner first) is one. */
const DEFINITIVE = new Set(['matrix_command_invalid', 'matrix_encrypted_room_required', 'matrix_check_in_suppressed', 'matrix_earlier_conversation'])

export function parseCronDeliveryRequest(payload: unknown): MatrixCronRequest | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const value = payload as Record<string, unknown>
  const runId = matrixCronRunId(value.execution_id) ?? matrixTurnId(value.execution_id)

  if (
    typeof value.request_id !== 'string' ||
    !/^(?:[\da-f]{1,64}|srq-[\da-f]{12})$/.test(value.request_id) ||
    value.platform !== 'matrix' ||
    typeof value.room_id !== 'string' ||
    !/^!.+/.test(value.room_id) ||
    value.room_id.length > 1024 ||
    typeof value.text !== 'string' ||
    !value.text.trim() ||
    typeof value.job_id !== 'string' ||
    !value.job_id ||
    value.job_id.length > 200 ||
    !runId
  ) {
    return null
  }

  return { requestId: value.request_id, roomId: value.room_id, text: value.text, jobId: value.job_id, runId }
}

export class MatrixCronDelivery {
  /** Serializes the pending list's read-modify-write. */
  private queue: Promise<unknown> = Promise.resolve()
  /** This process's pending posts: the truth here even when the vault cannot be written. */
  private pending?: MatrixCronPost[]
  private managedQueue: Promise<unknown> = Promise.resolve()
  /** In-memory backoff for background managed retries, by run. */
  private managedRetry = new Map<string, { at: number; failures: number }>()

  constructor(private readonly deps: MatrixCronDeliveryDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  /** Answers every delivery request on one backend connection until the returned stop. */
  listen(gateway: MatrixCronGateway, occurrence?: NonNullable<MatrixCronPost['occurrence']>): () => void {
    const answer = (requestId: string, receipt: MatrixCronReceipt) =>
      gateway
        .request('cron.delivery.respond', { request_id: requestId, result: JSON.stringify(receipt) }, 10_000)
        .catch(() => this.deps.log('[Matrix] cron delivery receipt not acknowledged'))

    return gateway.on('cron.delivery.request', event => {
      const request = parseCronDeliveryRequest(event.payload)

      if (!request) {
        const requestId = (event.payload as { request_id?: unknown } | undefined)?.request_id
        this.deps.log('[Matrix] cron delivery request refused: malformed')

        // Hermes is waiting for this answer: say so at once instead of letting it time out.
        if (typeof requestId === 'string' && /^(?:[\da-f]{1,64}|srq-[\da-f]{12})$/.test(requestId)) {
          void answer(requestId, { status: 'failed', error: 'malformed request' })
        }

        return
      }

      if (occurrence) {
        void this.deliverManaged(request, { ...occurrence }).then(receipt => answer(request.requestId, receipt)).catch(error => {
          const code = error instanceof Error && error.message === 'matrix_cron_vault_unavailable'
            ? 'durable_delivery_unavailable' : 'managed_delivery_pending'

          this.deps.log(`[Matrix] managed cron delivery failed: ${code}`)

          return answer(request.requestId, { status: 'failed', error: code })
        })
      } else {
        void this.deliver(request).then(receipt => answer(request.requestId, receipt), () =>
          answer(request.requestId, { status: 'failed', error: 'vault_unavailable' }))
      }
    })
  }

  async deliver(request: MatrixCronRequest): Promise<MatrixCronReceipt> {
    try {
      await this.deps.requireRoom(request.roomId)
    } catch (error) {
      return { status: 'failed', error: error instanceof EarlierConversationError || error instanceof ConversationUnavailableError ? error.message : "not this agent's room" }
    }

    const post: MatrixCronPost = {
      roomId: request.roomId,
      text: request.text,
      jobId: request.jobId,
      runId: request.runId,
      since: this.now()
    }

    await this.update(pending => [...pending.filter(item => item.runId !== post.runId), post])

    return this.attempt(post)
  }

  /** Persist before publishing or acknowledging the native delivery. Retain settled
   * receipts so a repeated host request cannot publish a second event. */
  deliverManaged(request: MatrixCronRequest, occurrence: NonNullable<MatrixCronPost['occurrence']>): Promise<MatrixCronReceipt> {
    return this.serializeManaged(async () => {
      if (request.runId !== occurrence.occurrenceId) {throw new Error('matrix_cron_occurrence_mismatch')}
      await this.deps.requireRoom(request.roomId)
      const items = await this.update(pending => pending, true)
      let post = items.find(item => item.runId === request.runId)

      if (post && (JSON.stringify(post.occurrence) !== JSON.stringify(occurrence) ||
          post.text !== request.text || post.roomId !== request.roomId || post.jobId !== request.jobId)) {
        throw new Error('matrix_cron_occurrence_conflict')
      }

      if (post?.stranded) {throw new Error('managed_delivery_pending')}

      if (!post) {
        post = { roomId: request.roomId, text: request.text, jobId: request.jobId,
          runId: request.runId, since: this.now(), occurrence }
        const saved = post
        await this.update(pending => [...pending, saved], true)
      }

      return this.attemptManaged(post).catch(() => { throw new Error('managed_delivery_pending') })
    })
  }

  private serializeManaged<T>(run: () => Promise<T>): Promise<T> {
    const next = this.managedQueue.then(run)
    this.managedQueue = next.catch(() => {})

    return next
  }

  private async attemptManaged(post: MatrixCronPost, signal?: AbortSignal): Promise<MatrixCronReceipt> {
    try {
      return await this.publishManaged(post, signal)
    } catch (error) {
      const stranded = error instanceof Error && error.message === MATRIX_CRON_STRANDED

      // Another home (or this Mac under a later epoch/term) never publishes what an earlier one ran; past the
      // horizon the platform has settled the occurrence itself (`uncertain` on expiry). Kept, never sent.
      if (stranded || this.now() - post.since >= PENDING_TTL_MS) {
        await this.update(items => items.map(item => item.runId === post.runId ? { ...item, stranded: true as const } : item), true)
        this.managedRetry.delete(post.runId)
        this.deps.log(`[Matrix] managed cron post left with its home run=${post.runId.slice(0, 8)} reason=${stranded ? 'other_home' : 'expired'}`)
      }

      throw error
    }
  }

  private async publishManaged(post: MatrixCronPost, signal?: AbortSignal): Promise<MatrixCronReceipt> {
    if (!this.deps.settleManaged || !this.deps.authorizeManaged) {throw new Error('matrix_cron_settlement_unavailable')}
    let eventId = post.publishedEvent

    if (!eventId) {
      signal?.throwIfAborted()
      const lookup = await this.deps.find(post)

      if (lookup.state === 'unknown') {throw new Error('matrix_cron_delivery_uncertain')}
      await this.deps.requireRoom(post.roomId)

      if (lookup.state === 'absent') {await this.deps.authorizeManaged(post, signal)}
      // Completed now: the enqueue is not cut by a drain deadline. D1 itself refuses it once the drain is
      // acknowledged, so finishing it only narrows the window where an answered run has no event.
      eventId = lookup.state === 'found' ? lookup.eventId : await this.deps.publish(post)
      const published = { ...post, publishedEvent: eventId }
      await this.update(items => items.map(item => item.runId === post.runId ? published : item), true)
      post = published
    }

    if (!post.settled) {
      await this.deps.settleManaged(post, eventId, signal)
      const settled = { ...post, settled: true as const }
      await this.update(items => items.map(item => item.runId === post.runId ? settled : item), true)
    }

    this.managedRetry.delete(post.runId)

    return { status: 'delivered', event_id: eventId }
  }

  /** Background retry of one managed record: never throws, backs off per run. */
  private async retryManaged(post: MatrixCronPost): Promise<void> {
    const retry = this.managedRetry.get(post.runId)

    if (retry && this.now() < retry.at) {return}

    try {
      await this.attemptManaged(post)
    } catch (error) {
      const failures = (retry?.failures ?? 0) + 1
      this.managedRetry.set(post.runId, { at: this.now() + Math.min(MANAGED_RETRY_MAX_MS, 1000 * 2 ** failures), failures })
      this.deps.log(`[Matrix] managed cron resume run=${post.runId.slice(0, 8)} reason=${error instanceof Error ? error.message : 'failed'}`)
    }
  }

  /** Durably prepare a background result without sending it. */
  async seal(request: MatrixCronRequest): Promise<MatrixCronSealedPost> {
    await this.deps.requireRoom(request.roomId)
    const outboxId = cronOutboxId(request.runId)
    const bodySha256 = createHash('sha256').update(request.text, 'utf8').digest('hex')
    const current = (await this.update(pending => pending)).find(item => item.runId === request.runId)

    if (current) {
      if (
        current.roomId !== request.roomId ||
        current.jobId !== request.jobId ||
        current.text !== request.text ||
        current.outboxId !== outboxId ||
        current.bodySha256 !== bodySha256
      ) {
        throw new Error('matrix_cron_seal_conflict')
      }

      return { outboxId, bodySha256 }
    }

    await this.update(pending => [
      ...pending,
      {
        roomId: request.roomId,
        text: request.text,
        jobId: request.jobId,
        runId: request.runId,
        since: this.now(),
        held: true,
        outboxId,
        bodySha256
      }
    ])

    return { outboxId, bodySha256 }
  }

  /** Persist publication admission before sending, so a crash resumes the same transaction. */
  async admit(runId: string): Promise<MatrixCronReceipt> {
    const pending = await this.update(items =>
      items.map(item => item.runId === runId ? (({ held: _held, ...post }) => post)(item) : item)
    )

    const post = pending.find(item => item.runId === runId)

    return post ? this.attempt(post) : { status: 'failed', error: 'sealed post not found' }
  }

  /** A suppressed offer is definitively unpublished and can leave the local outbox. */
  async discard(runId: string): Promise<void> {
    await this.forget(runId)
  }

  /** D1 drain: this home publishes and settles its managed deliveries, serialized behind any native host
   * delivery and bounded by the drain's `deadline`. Never rejects for one record: it answers how many are left,
   * and those stay this home's (the move proceeds; the platform's expiry settles them, never a new home). */
  async resumeManaged(deadline: AbortSignal): Promise<{ left: number }> {
    const drain = this.serializeManaged(async () => {
      const pending = await this.update(items => items, true)

      for (const post of pending.filter(unsettledManaged)) {
        if (deadline.aborted) {break}

        await this.attemptManaged(post, deadline).catch(error => {
          this.deps.log(`[Matrix] managed cron drain run=${post.runId.slice(0, 8)} reason=${error instanceof Error ? error.message : 'failed'}`)
        })
      }

      // Stranded records are not this home's to finish; only what it still owes counts.
      return (await this.update(items => items, true)).filter(unsettledManaged).length
    })

    const overrun = new Promise<'overrun'>(resolve => {
      if (deadline.aborted) {resolve('overrun')}
      deadline.addEventListener('abort', () => resolve('overrun'), { once: true })
    })

    const result = await Promise.race([drain.catch(() => 'vault' as const), overrun])

    if (result === 'overrun' || result === 'vault') {
      // What is still in flight carries the aborted deadline; count every record the drain did not settle.
      const items = await this.update(entries => entries, true).catch(() => null)

      return { left: items ? items.filter(unsettledManaged).length : -1 }
    }

    return { left: result }
  }

  /** At start, and whenever the agent can post again: settle what a quit left pending. */
  async resume(): Promise<void> {
    const pending = await this.update(items =>
      items.filter(item => {
        // A managed record stays until it settles or is stranded; then only for the replay window.
        const fresh = item.occurrence
          ? unsettledManaged(item) || this.now() - item.since < MANAGED_RETAIN_MS
          : this.now() - item.since < PENDING_TTL_MS

        if (!fresh) {
          this.deps.log(`[Matrix] cron post dropped run=${item.runId.slice(0, 8)} reason=expired`)
        }

        return fresh
      })
    )

    for (const post of pending) {
      if (post.occurrence) {
        // One managed record that cannot settle never blocks the posts after it, or the scheduler that resumes here.
        await this.serializeManaged(async () => {
          const current = (await this.update(items => items, true)).find(item => item.runId === post.runId)

          if (current && unsettledManaged(current)) {await this.retryManaged(current)}
        }).catch(() => this.deps.log('[Matrix] managed cron resume deferred: vault_unavailable'))

        continue
      }

      if (post.held) {
        continue
      }

      const lookup = await this.deps.find(post).catch((): MatrixTurnLookup => ({ state: 'unknown' }))

      if (lookup.state === 'found') {
        await this.forget(post.runId)
      } else if (lookup.state === 'absent') {
        await this.attempt(post)
      }

      // `unknown` never re-sends: it stays for the next resume, or until it expires.
      this.deps.log(`[Matrix] cron resume run=${post.runId.slice(0, 8)} lookup=${lookup.state}`)
    }
  }

  private async attempt(post: MatrixCronPost): Promise<MatrixCronReceipt> {
    if (post.held) {
      return { status: 'failed', error: 'sealed post not admitted' }
    }

    try {
      // A resumed post may have become Earlier since it was recorded.
      await this.deps.requireRoom(post.roomId)
      const eventId = await this.deps.publish(post)
      await this.forget(post.runId)
      this.deps.log(`[Matrix] cron delivered run=${post.runId.slice(0, 8)}`)

      return { status: 'delivered', event_id: eventId }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'matrix_send_failed'

      if (DEFINITIVE.has(code)) {
        await this.forget(post.runId)
      }

      // Anything else may have reached the room: the record stays, and the next
      // resume reads the room before posting again.
      this.deps.log(`[Matrix] cron delivery failed run=${post.runId.slice(0, 8)} reason=${code}`)

      return { status: 'failed', error: code }
    }
  }

  private forget(runId: string) {
    return this.update(pending => pending.filter(item => item.runId !== runId))
  }

  private update(change: (pending: MatrixCronPost[]) => MatrixCronPost[], strict = false): Promise<MatrixCronPost[]> {
    const next = this.queue.then(async () => {
      const changed = change((this.pending ??= this.read(strict)))
      const unmanaged = changed.filter(item => !item.occurrence).slice(-MAX_PENDING)
      const pending = changed.filter(item => item.occurrence || unmanaged.includes(item))

      for (const dropped of changed.slice(0, changed.length - pending.length)) {
        this.deps.log(`[Matrix] cron post dropped run=${dropped.runId.slice(0, 8)} reason=too_many_pending`)
      }

      const durable = strict || changed.some(item => item.occurrence) || this.pending?.some(item => item.occurrence)

      try {
        const bytes = JSON.stringify(pending)

        for (let attempt = 0; ; attempt++) {
          try {
            this.deps.store.setItem(MATRIX_CRON_PENDING_KEY, bytes)

            break
          } catch (error) {
            if (!durable || attempt === 3) {throw error}
            await delay(50 * 2 ** attempt)
          }
        }
      } catch {
        if (durable) {throw new Error('matrix_cron_vault_unavailable')}
        // Kept in memory for this run; a quit before it settles loses it.
        this.deps.log('[Matrix] cron pending record not saved: vault_unavailable')
      }

      this.pending = pending

      return pending
    })

    this.queue = next.catch(() => {})

    return next
  }

  private read(strict = false): MatrixCronPost[] {
    try {
      const value: unknown = JSON.parse(this.deps.store.getItem(MATRIX_CRON_PENDING_KEY) ?? '[]')

      if (strict && (!Array.isArray(value) || !value.every(isPost))) {throw new Error('matrix_cron_vault_unavailable')}

      // A lenient (unmanaged) read keeps today's behaviour, but never silently drops a managed record.
      if (Array.isArray(value) && value.some(item => !isPost(item) && Boolean(item) && typeof item === 'object' && 'occurrence' in item)) {
        throw new Error('matrix_cron_vault_unavailable')
      }

      return Array.isArray(value) ? value.filter(isPost) : []
    } catch (error) {
      if (strict || (error instanceof Error && error.message === 'matrix_cron_vault_unavailable')) {
        throw new Error('matrix_cron_vault_unavailable')
      }

      return []
    }
  }
}

function isPost(value: unknown): value is MatrixCronPost {
  const post = value as MatrixCronPost

  return (
    Boolean(post) &&
    typeof post.roomId === 'string' &&
    typeof post.text === 'string' &&
    typeof post.jobId === 'string' &&
    typeof post.runId === 'string' &&
    Number.isFinite(post.since) &&
    (post.occurrence === undefined || (typeof post.occurrence.assistantId === 'string' &&
      typeof post.occurrence.executorId === 'string' && post.occurrence.occurrenceId === post.runId &&
      Number.isInteger(post.occurrence.computeSeconds) && post.occurrence.computeSeconds >= 0 && post.occurrence.computeSeconds <= 86400 &&
      isOccurrenceHome(post.occurrence.home))) &&
    (post.publishedEvent === undefined || (typeof post.publishedEvent === 'string' && post.publishedEvent.startsWith('$'))) &&
    (post.settled === undefined || (post.settled === true && Boolean(post.publishedEvent))) &&
    (post.stranded === undefined || (post.stranded === true && Boolean(post.occurrence))) &&
    (post.held === undefined || post.held === true) &&
    (post.outboxId === undefined || /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(post.outboxId)) &&
    (post.bodySha256 === undefined || /^[0-9a-f]{64}$/u.test(post.bodySha256))
  )
}

function isOccurrenceHome(home: unknown): home is MatrixCronOccurrenceHome {
  const value = home as MatrixCronOccurrenceHome

  return Boolean(value) && typeof value.homeId === 'string' && typeof value.leaseId === 'string' &&
    Number.isSafeInteger(value.homeEpoch) && Number.isSafeInteger(value.executorTerm)
}

/** A managed record this home still has to publish or settle. */
function unsettledManaged(post: MatrixCronPost): boolean {
  return Boolean(post.occurrence) && !post.settled && !post.stranded
}

/** Stable lowercase v4 UUID for the local outbox row of one occurrence. */
function cronOutboxId(runId: string): string {
  const bytes = createHash('sha256').update(`atum background sweep outbox ${runId}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
