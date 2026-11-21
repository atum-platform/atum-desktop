import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { answerForRow } from './answers'
import {
  sha256Hex,
  WORK_DERIVED_TITLE_MAX_CODE_POINTS,
  WORK_GRANT_RANDOM_BYTES,
  WORK_PROVISIONAL,
  WORK_THREAD_STATUSES,
  type WorkAdmissionErrorType,
  workDeadline,
  workEntitlementsFresh,
  workExpectedThreadId,
  type WorkGateId,
  type WorkLaunchArguments,
  workOwnerEventAge,
  workParamsHash,
  type WorkRejectionReason,
  type WorkRequestAnswer,
  type WorkScope,
  type WorkT3LaunchCall,
  type WorkThreadAnswer,
  type WorkThreadStatus
} from './contract'
import type { CutoffResult, GateLedger, ReceiptRow, Settlement } from './ledger'
import type { GateSession, GateSessions, ModelAccess, OwnerEventVerifier, StopReport, T3Port, T3Reply, ThreadRead } from './ports'
import { RequestStatusReader, threadBusy } from './status'

// The Work gate's core (plan §6.4, §11.3, §11.4; review round 4 R4-1, R4-2). Three rules shape this file.
//
// 1. The final admission check and the handoff to T3 are ONE synchronous section (`handoff`), and so is the
//    revocation cutoff (`GateLedger.cutoff`). JavaScript runs a synchronous section to its end, so the cutoff
//    either runs before the section (the fence sees the stop owed, nothing is sent, the row settles as never
//    sent) or after it (the forwarded mark is durable, the row owes a stop, the reply is silenced). A callback
//    parked on a provider, balance or Matrix check cannot dispatch: it passes through `handoff` like every
//    other path, including a resend and a recovery.
//
// 2. `request` status is read-only (status.ts). Recovery that can dispatch is `launch` on an existing admitted row
//    and `recover()`: both go through `dispatch` and so through `handoff`.
//
// 3. A revocation is a cutoff, then a cleanup, and it is complete only when the cleanup is (step 6). The cleanup
//    uses main's own owner session, never the agent's.

export type GatePhaseHook = (point: string, key: string) => Promise<void> | void

export interface GateOptions {
  accountId: string
  deviceServiceId: string
  ledger: GateLedger
  t3: T3Port
  sessions: GateSessions
  owner: OwnerEventVerifier
  /** The balance read from the Mac's proxy (lane S's `readModelAccess`). */
  modelAccess(): Promise<ModelAccess>
  delegated: { instanceId: string; model: string }
  /** T3's per-call ceiling for a delegated task, `<runtimeMode>/<interactionMode>`. */
  modeLimit?: string
  /** True while an update or an owed auth reset holds the account (lane R's `WorkSession.held()`). */
  held(): boolean
  now?(): number
  /** A monotonic clock, for the freshness of the entitlement list. */
  monotonic?(): number
  /** Test-only pause points. Absent from release builds. */
  hooks?: GatePhaseHook
  sleep?(ms: number): Promise<void>
  log?(event: string, fields?: Record<string, string | number | boolean | null>): void
  stopPollMs?: number
  stopPolls?: number
}

export class GateAdmissionError extends Error {
  constructor(readonly type: WorkAdmissionErrorType) {
    super(type)
    this.name = 'GateAdmissionError'
  }
}

export interface RevokeInput {
  scope: WorkScope
  principal?: string
  reason: string
  sourceSeq?: number
}

export interface CallContext {
  principal: string
  routeEpoch: number
  generation: number
}

export type GateEvent =
  | { type: 'change' }
  | { type: 'revoked'; scope: WorkScope; principal: string | null; reason: string; revocationId: number }
  /** Step 6: nothing of this scope is running any more. The assistant tells its owner once (D19). */
  | { type: 'acknowledged'; scope: WorkScope; principal: string | null; revocationId: number; requestIds: string[] }

type Listener = (event: GateEvent) => void

export interface GateAgentState {
  principal: string
  generation: number
  entitled: boolean
  hasGrant: boolean
  running: number
  stopOwed: number
}

/** What the Settings and enrollment surfaces read (lane DW). Read-only: asking never dispatches anything. */
export interface GateState {
  phase: 'closed' | 'holding' | 'stale' | 'open'
  workGrantAccepted: boolean
  routeOpen: boolean
  routeEpoch: number
  entitlementsFresh: boolean
  lastSyncAgeSeconds: number | null
  appliedSeq: number
  settledSeq: number
  agents: GateAgentState[]
  stopsOwed: { total: number; routeWide: boolean; agents: string[] }
  /** Restart continuation for T3: kept OFF in slice A (plan §8.5). */
  continuation: false
  undeliveredReports: number
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => undefined)

    return next
  }
}

const NO_THREAD_CODES: Record<string, WorkRejectionReason> = {
  invalid_request: 't3_invalid_request',
  model_unavailable: 't3_model_unavailable',
  runtime_mode_escalation_denied: 't3_runtime_mode_escalation_denied'
}

const OWNER_BODY_MAX = 6000

const codePointSlice = (value: string, max: number) => [...value].slice(0, max).join('')

/** Title from the assistant's task: its first line, bounded. The caller never names one. */
export function deriveTitle(task: string): string {
  const line = task.split('\n').find(item => item.trim()) ?? ''
  const clean = line.replace(/\s+/gu, ' ').trim()

  return codePointSlice(clean || 'Task from an assistant', WORK_DERIVED_TITLE_MAX_CODE_POINTS)
}

export function buildLaunchCall(options: {
  args: WorkLaunchArguments
  ownerBody: string
  delegated: { instanceId: string; model: string }
}): WorkT3LaunchCall {
  const { args, ownerBody, delegated } = options

  return {
    projectId: args.projectId,
    workspaceStrategy: { type: 'root' },
    modelSelection: { instanceId: delegated.instanceId, model: delegated.model },
    message: `OWNER (verified, event ${args.ownerEvent}):\n${codePointSlice(ownerBody, OWNER_BODY_MAX)}\n\nASSISTANT (unverified):\n${args.task}`,
    title: deriveTitle(args.task),
    clientRequestId: args.requestId
  }
}

const THREAD_STATUS = new Set<string>(WORK_THREAD_STATUSES)

export function threadStatusOf(read: Extract<ThreadRead, { kind: 'found' }>): WorkThreadStatus {
  if (THREAD_STATUS.has(read.status) && read.status !== 'no_run_yet') {
    return read.status as WorkThreadStatus
  }

  if (read.activeRunId) {
    return 'running'
  }

  return read.runs.length === 0 ? 'no_run_yet' : 'idle'
}

export class WorkGate {
  readonly statusReader: RequestStatusReader
  private readonly ledger: GateLedger
  private readonly listeners = new Set<Listener>()
  private readonly locks = new Map<string, Mutex>()
  private readonly now: () => number
  private readonly monotonic: () => number
  private readonly modeLimit: string
  private lastGoodSync: number | undefined
  private headRegressed = false
  private settling: Promise<void> | undefined
  private settleAgain = false
  private closed = false

  constructor(private readonly options: GateOptions) {
    this.ledger = options.ledger
    this.now = options.now ?? Date.now
    this.monotonic = options.monotonic ?? (() => performance.now())
    this.modeLimit = options.modeLimit ?? 'approval-required/default'
    this.statusReader = new RequestStatusReader({
      ledger: this.ledger,
      reader: options.t3,
      sessions: options.sessions,
      gateId: () => this.gateId(),
      now: this.now,
      fingerprintFor: row => this.fingerprintOf(JSON.parse(row.callJson as string) as WorkT3LaunchCall)
    })
  }

  // ---- identity, counters, freshness
  gateId(): WorkGateId {
    return { deviceServiceId: this.options.deviceServiceId, accountId: this.options.accountId, routeEpoch: this.ledger.routeEpoch() }
  }

  /** Policy for lane R's `continuation()`: T3's restart-continuation stays OFF for the whole of slice A (plan §8.5). */
  continuation(): false {
    return false
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)

    return () => void this.listeners.delete(listener)
  }

  private emit(event: GateEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // a listener never breaks the gate
      }
    }
  }

  routeOpen(): boolean {
    return this.ledger.meta('route_open') === '1'
  }

  workGrantAccepted(): boolean {
    return this.ledger.meta('work_grant_accepted_at') !== undefined
  }

  /** The Mac's freshness rule: age on its monotonic clock since the last good, durably applied pull, and no head regression. */
  entitlementsFresh(): boolean {
    return (
      this.lastGoodSync !== undefined &&
      workEntitlementsFresh((this.monotonic() - this.lastGoodSync) / 1000, this.headRegressed)
    )
  }

  /** Called by the sync client after a page was applied durably (R4-5: fresh means applied, not received). */
  noteGoodSync(): void {
    this.lastGoodSync = this.monotonic()
    this.headRegressed = false
    this.emit({ type: 'change' })
  }

  noteHeadRegressed(): void {
    this.headRegressed = true
    this.emit({ type: 'change' })
  }

  // ---- admission (the part after the assertion): the bearer, the counters, the list
  checkGrant(bearer: string): { ok: true; ctx: CallContext } | { ok: false; error: WorkAdmissionErrorType } {
    const grant = this.ledger.grantByHash(sha256Hex(bearer))

    if (!grant || grant.expiresAt < this.now()) {
      return { ok: false, error: 'unknown_grant' }
    }

    const agent = this.ledger.agent(grant.principal)

    if (
      grant.dead ||
      grant.routeEpoch !== this.ledger.routeEpoch() ||
      !agent ||
      !agent.entitled ||
      grant.generation !== agent.generation ||
      !this.routeOpen()
    ) {
      return { ok: false, error: 'revoked' }
    }

    // fresh list, and not held by an update or an owed auth reset: the gate admits nothing while either is open
    if (!this.entitlementsFresh() || this.options.held()) {
      return { ok: false, error: 'stale_entitlements' }
    }

    return { ok: true, ctx: { principal: grant.principal, routeEpoch: grant.routeEpoch, generation: grant.generation } }
  }

  countersCurrent(ctx: CallContext): boolean {
    const agent = this.ledger.agent(ctx.principal)

    return (
      this.routeOpen() &&
      this.ledger.routeEpoch() === ctx.routeEpoch &&
      Boolean(agent?.entitled) &&
      agent?.generation === ctx.generation
    )
  }

  /**
   * Step 2, bound to actual response release: the check and the write of the response are one synchronous section
   * (http.ts), so a reply for a call admitted under an old counter is replaced by a typed `revoked` with no thread
   * content. Anything after the bytes are out is the cleanup, not this.
   */
  silence<T extends { class: string }>(ctx: CallContext, answer: T, revoked: () => T): T {
    return this.countersCurrent(ctx) ? answer : revoked()
  }

  revokedScope(ctx: CallContext): WorkScope {
    return this.ledger.routeEpoch() !== ctx.routeEpoch || !this.routeOpen() ? 'route' : 'agent'
  }

  // ---- tools
  private lock(key: string): Mutex {
    let mutex = this.locks.get(key)

    if (!mutex) {
      mutex = new Mutex()
      this.locks.set(key, mutex)
    }

    return mutex
  }

  /** Test-only pause points (plan §11.6). They run only under a test runner: a release build never calls them. */
  private async point(name: string, key: string): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      await this.options.hooks?.(name, key)
    }
  }

  private fingerprintOf(call: WorkT3LaunchCall): string {
    return sha256Hex(
      JSON.stringify([this.options.t3.settingsFingerprint(), this.modeLimit, call.projectId, call.modelSelection.instanceId, call.modelSelection.model])
    )
  }

  private refuse(principal: string, requestId: string, reason: string, extra: { paramsHash?: string; eventId?: string; notAfter?: number }): WorkRequestAnswer {
    this.ledger.refuse(principal, requestId, reason, extra)

    return answerForRow(this.gateId(), this.ledger.receipt(principal, requestId) as ReceiptRow)
  }

  /** A launch whose body failed the schema is refused, not trimmed. An existing row answers first. */
  shapeRefusal(ctx: CallContext, requestId: string, reason: 'unknown_field' | 'invalid_field'): WorkRequestAnswer {
    const existing = this.ledger.receipt(ctx.principal, requestId)

    return existing ? answerForRow(this.gateId(), existing) : this.refuse(ctx.principal, requestId, reason, {})
  }

  async launch(ctx: CallContext, args: WorkLaunchArguments): Promise<WorkRequestAnswer> {
    const { principal } = ctx

    return this.lock(`${principal}|${args.requestId}`).run(async () => {
      const existing = this.ledger.receipt(principal, args.requestId)

      if (existing) {
        return this.answerExisting(ctx, existing, args)
      }

      return this.admitAndForward(ctx, args)
    })
  }

  /** The row answers first (rule 4). A retry that changes what ran is refused, and says nothing about the row. */
  private async answerExisting(ctx: CallContext, row: ReceiptRow, args: WorkLaunchArguments): Promise<WorkRequestAnswer> {
    const gateId = this.gateId()

    if (row.state !== 'admitted' || row.stopScope) {
      return answerForRow(gateId, row)
    }

    if (row.paramsHash !== workParamsHash(args.projectId, args.task, args.ownerEvent) || row.notAfter !== args.notAfter) {
      return { gateId, requestId: args.requestId, class: 'refused', receipt: 'refused', reason: 'params_mismatch' }
    }

    return this.reconcile(row)
  }

  /**
   * `launch` on an existing admitted row is the helper's explicit retry, so it MAY dispatch the gate's own stored
   * call (rule 4). It reads first, with the status reader, and only a found thread ends it; otherwise it goes
   * through `dispatch` and so through the same fence.
   */
  private async reconcile(row: ReceiptRow): Promise<WorkRequestAnswer> {
    if (row.forwarded) {
      const read = await this.statusReader.read(row)

      if (read.kind === 'found') {
        this.statusReader.observe(row, read)

        return answerForRow(this.gateId(), this.ledger.receipt(row.principal, row.requestId) as ReceiptRow)
      }

      if (read.kind !== 'absent') {
        return answerForRow(this.gateId(), this.ledger.receipt(row.principal, row.requestId) as ReceiptRow)
      }

      const can = this.statusReader.resendable(row)

      if (!can.ok || row.forwardCount >= 2) {
        return {
          gateId: this.gateId(),
          requestId: row.requestId,
          class: 'ambiguous',
          receipt: 'admitted',
          forwarded: true,
          cause: can.ok === false ? can.cause : 'not_found'
        }
      }
    }

    return this.dispatch(row.principal, row.requestId)
  }

  private async admitAndForward(ctx: CallContext, args: WorkLaunchArguments): Promise<WorkRequestAnswer> {
    const { principal } = ctx
    const gateId = this.gateId()
    const head = { gateId, requestId: args.requestId }
    const paramsHash = workParamsHash(args.projectId, args.task, args.ownerEvent)

    const refuse = (reason: string, extra: { eventId?: string } = {}) =>
      this.refuse(principal, args.requestId, reason, { paramsHash, notAfter: args.notAfter, ...extra })

    // 1. the deadline: open, and bounded by the Mac (a caller cannot buy a long one)
    const deadline = workDeadline((args.notAfter - this.now()) / 1000)

    if (deadline !== 'ok') {
      return refuse(deadline)
    }

    // 2. nothing in the scope still owes a stop
    if (this.ledger.scopeBlocked(principal)) {
      return { ...head, class: 'revocation_pending', receipt: 'none' }
    }

    // 3. the provider is ready (not a receipt: a moment must not become a permanent refusal)
    let session: GateSession

    try {
      session = await this.options.sessions.agent(principal)

      if (!(await this.options.t3.prepare(session.token)) || !(await this.options.t3.providerReady(session.token))) {
        return { ...head, class: 'unavailable', receipt: 'none', reason: 'provider_not_ready' }
      }
    } catch {
      return { ...head, class: 'unavailable', receipt: 'none', reason: 'provider_not_ready' }
    }

    // 4. the owner's balance, read from the Mac's proxy
    const access = await this.options.modelAccess().catch((): ModelAccess => 'unavailable')

    if (access === 'empty') {
      return refuse('balance_empty')
    }

    if (access === 'unavailable') {
      return { ...head, class: 'unavailable', receipt: 'none', reason: 'provider_not_ready' }
    }

    // 5. the owner's own message, fetched by the gate itself
    const event = await this.options.owner.fetch({ agentPrincipal: principal, eventId: args.ownerEvent }).catch(() => ({ kind: 'unreachable' }) as const)

    if (event.kind === 'unreachable') {
      return { ...head, class: 'unavailable', receipt: 'none', reason: 'owner_event_unverifiable' }
    }

    if (event.kind === 'invalid') {
      return refuse(event.reason, { eventId: args.ownerEvent })
    }

    const age = workOwnerEventAge((this.now() - event.originServerTs) / 1000)

    if (age !== 'ok') {
      return refuse(age, { eventId: args.ownerEvent })
    }

    if (this.ledger.eventClaimed(args.ownerEvent)) {
      return refuse('event_already_used', { eventId: args.ownerEvent })
    }

    // 6. ONE synchronous section: the fence again (everything above was async), then the claim on the event and the
    //    `admitted` row in one durable transaction. Nothing is sent to T3 here.
    if (!this.countersCurrent(ctx) || !this.entitlementsFresh() || this.options.held() || this.ledger.scopeBlocked(principal)) {
      throw new GateAdmissionError(this.countersCurrent(ctx) ? 'stale_entitlements' : 'revoked')
    }

    if (this.options.sessions.agentSessionId(principal) !== session.sessionId || this.now() > args.notAfter) {
      return { ...head, class: 'unavailable', receipt: 'none', reason: 'provider_not_ready' }
    }

    const call = buildLaunchCall({ args, ownerBody: event.body, delegated: this.options.delegated })

    const admitted = this.ledger.admit({
      principal,
      requestId: args.requestId,
      paramsHash,
      callJson: JSON.stringify(call),
      fingerprint: this.fingerprintOf(call),
      sessionId: session.sessionId,
      threadId: workExpectedThreadId(session.sessionId, args.requestId),
      eventId: args.ownerEvent,
      notAfter: args.notAfter,
      epoch: ctx.routeEpoch,
      generation: ctx.generation
    })

    if (admitted.ok === false) {
      return admitted.reason === 'event_already_used'
        ? refuse('event_already_used', { eventId: args.ownerEvent })
        : answerForRow(gateId, this.ledger.receipt(principal, args.requestId) as ReceiptRow)
    }

    await this.point('admitted', `${principal}|${args.requestId}`)

    return this.dispatch(principal, args.requestId)
  }

  /** Every path that can put a launch into T3: the first send, the helper's retry and recovery. */
  private async dispatch(principal: string, requestId: string): Promise<WorkRequestAnswer> {
    const key = `${principal}|${requestId}`
    let session: GateSession

    try {
      session = await this.options.sessions.agent(principal)
      await this.options.t3.prepare(session.token)
    } catch {
      return answerForRow(this.gateId(), this.ledger.receipt(principal, requestId) as ReceiptRow)
    }

    await this.point('before_handoff', key)
    const handed = this.handoff(principal, requestId, session)

    if (handed.kind === 'answer') {
      return handed.answer
    }

    await this.point('handed_off', key)
    const reply = await handed.inflight
    await this.point('reply_in', key)

    return this.absorb(principal, requestId, reply)
  }

  /**
   * THE FENCE AND THE HANDOFF: one synchronous section (R4-2). Every check reads the state as it is NOW; the forwarded
   * mark is committed and the request is started in the same step, so a cutoff cannot fall between them.
   */
  private handoff(principal: string, requestId: string, session: GateSession): { kind: 'answer'; answer: WorkRequestAnswer } | { kind: 'sent'; inflight: Promise<T3Reply> } {
    const gateId = this.gateId()
    const row = this.ledger.receipt(principal, requestId) as ReceiptRow
    const answer = (value: WorkRequestAnswer) => ({ kind: 'answer', answer: value }) as const
    const same = () => answerForRow(gateId, this.ledger.receipt(principal, requestId) as ReceiptRow)

    if (row.state !== 'admitted') {
      return answer(same())
    }

    // a. a cutoff won: if no byte ever left, it settles now
    if (row.stopScope) {
      if (!row.forwarded) {
        this.settle(row, 'never_sent')
      }

      return answer(same())
    }

    const agent = this.ledger.agent(principal)
    const incarnation = this.options.t3.incarnation()
    const call = JSON.parse(row.callJson as string) as WorkT3LaunchCall
    const hold = () => answer({ gateId, requestId, class: 'pending', receipt: 'admitted', forwarded: row.forwarded })

    // b. the deadline: past it, an unsent launch is refused for good (safe at any time: no byte ever left); a sent one is never resent
    if (this.now() > (row.notAfter as number)) {
      if (!row.forwarded) {
        this.ledger.update(principal, requestId, { state: 'refused', reason: 'expired', settled: 'never_sent' })
        this.ledger.releaseClaim(row.eventId)

        return answer(same())
      }

      return answer({ gateId, requestId, class: 'ambiguous', receipt: 'admitted', forwarded: true, cause: 'deadline_passed' })
    }

    // c. the account, counters, list, hold, process: any failure leaves the row as it is and sends nothing
    if (
      this.options.held() ||
      !this.routeOpen() ||
      !this.entitlementsFresh() ||
      this.ledger.scopeBlocked(principal) ||
      !agent?.entitled ||
      agent.generation !== row.generationAtAdmit ||
      this.ledger.routeEpoch() !== row.epochAtAdmit ||
      incarnation === undefined
    ) {
      return hold()
    }

    // d. the session and the settings the launch was admitted under
    if (session.sessionId !== row.sessionId) {
      return row.forwarded
        ? answer({ gateId, requestId, class: 'ambiguous', receipt: 'admitted', forwarded: true, cause: 'session_replaced' })
        : hold()
    }

    if (row.fingerprint !== this.fingerprintOf(call)) {
      return row.forwarded
        ? answer({ gateId, requestId, class: 'ambiguous', receipt: 'admitted', forwarded: true, cause: 'setting_changed' })
        : hold()
    }

    if (row.forwardCount >= 2) {
      return answer({ gateId, requestId, class: 'ambiguous', receipt: 'admitted', forwarded: true, cause: 'not_found' })
    }

    // e. commit the mark, then start the request: no await between the two
    this.ledger.markForwarded(principal, requestId, incarnation)
    const inflight = this.options.t3.launch(session.token, call, this.modeLimit)

    return { kind: 'sent', inflight }
  }

  /** Store T3's answer, then decide what the caller may see (one synchronous section). */
  private absorb(principal: string, requestId: string, reply: T3Reply): WorkRequestAnswer {
    const row = this.ledger.receipt(principal, requestId) as ReceiptRow
    const gateId = this.gateId()

    if (row.state !== 'admitted') {
      return answerForRow(gateId, row)
    }

    const owed = row.stopScope !== null
    const pending: WorkRequestAnswer = { gateId, requestId, class: 'pending', receipt: 'admitted', forwarded: true }

    const reject = (reason: WorkRejectionReason): WorkRequestAnswer => {
      this.ledger.update(principal, requestId, { state: 'rejected', reason })
      this.ledger.releaseClaim(row.eventId)

      if (owed) {
        this.settle(this.ledger.receipt(principal, requestId) as ReceiptRow, 'nothing_started')
      }

      return answerForRow(gateId, this.ledger.receipt(principal, requestId) as ReceiptRow)
    }

    if (reply.transport === 'failed') {
      return owed ? answerForRow(gateId, row) : pending
    }

    if (reply.status === 401 || reply.status === 403) {
      return reject('t3_unauthorized')
    }

    const threadId = reply.data?.threadId

    if (reply.status === 200 && !reply.isError && typeof threadId === 'string') {
      const runId = typeof reply.data?.runId === 'string' ? (reply.data.runId as string) : null

      this.ledger.update(principal, requestId, { state: 'launched', thread_id: threadId, ...(runId ? { run_id: runId } : {}) })

      if (owed) {
        this.scheduleSettle()
      }

      return answerForRow(gateId, this.ledger.receipt(principal, requestId) as ReceiptRow)
    }

    const code = reply.code ?? ''

    if (NO_THREAD_CODES[code]) {
      return reject(NO_THREAD_CODES[code])
    }

    if (reply.status === 400) {
      return reject(code === 'invalid_mode_limit' ? 't3_invalid_mode_limit' : 't3_schema_error')
    }

    return owed ? answerForRow(gateId, row) : pending
  }

  /** Settle one row: write it, release the claim only when nothing could have been sent, queue the content-free report. */
  private settle(row: ReceiptRow, outcome: Settlement): void {
    this.ledger.tx(() => {
      this.ledger.update(row.principal, row.requestId, { settled: outcome })

      if (outcome === 'never_sent') {
        this.ledger.releaseClaim(row.eventId)
      }

      if (row.stopScope && row.revocationId !== null) {
        const report: StopReport = {
          agentPrincipal: row.principal,
          requestId: row.requestId,
          routeEpochAtAdmit: row.epochAtAdmit ?? 0,
          agentGenerationAtAdmit: row.generationAtAdmit ?? 0,
          scope: row.stopScope,
          outcome,
          revocationId: row.revocationId,
          settledAt: this.now()
        }

        this.ledger.enqueue('stop_report', report)
      }
    })
    this.acknowledgeSettled()
  }

  // ---- request: status is read-only; void is the gate's own ledger
  // Neither takes the per-request lock: a status must answer while a launch for the same id is still checking (it is
  // read-only), and a void and an admit are single-winner synchronous writes on one key (`GateLedger.admit` and
  // `void` each check and write in one step), so they cannot both win.
  async request(ctx: CallContext, args: { requestId: string; action: 'status' | 'void' }): Promise<WorkRequestAnswer> {
    if (args.action === 'void') {
      if (!this.ledger.receipt(ctx.principal, args.requestId)) {
        this.ledger.void(ctx.principal, args.requestId)
      }

      return answerForRow(this.gateId(), this.ledger.receipt(ctx.principal, args.requestId) as ReceiptRow)
    }

    return this.statusReader.status(ctx.principal, args.requestId)
  }

  // ---- thread tools
  private threadRevoked(ctx: CallContext, threadId?: string): WorkThreadAnswer {
    return { gateId: this.gateId(), class: 'revoked', scope: this.revokedScope(ctx), ...(threadId ? { threadId } : {}) }
  }

  private t3Error(code: string | null | undefined, threadId?: string): WorkThreadAnswer {
    const clean = /^[a-z0-9_]{1,64}$/u.test(code ?? '') ? (code as string) : 't3_failed'

    return { gateId: this.gateId(), class: 't3_error', code: clean, ...(threadId ? { threadId } : {}) }
  }

  async interrupt(ctx: CallContext, args: { threadId: string }): Promise<WorkThreadAnswer> {
    const gateId = this.gateId()
    const row = this.ledger.receiptByThread(ctx.principal, args.threadId)

    if (!row) {
      return { gateId, class: 'refused', reason: 'not_in_ledger', threadId: args.threadId }
    }

    if (row.stopScope) {
      return this.threadRevoked(ctx, args.threadId)
    }

    // only a thread launched under the agent's CURRENT session; the owner can always continue an earlier one in Work
    if (row.sessionId !== this.options.sessions.agentSessionId(ctx.principal)) {
      return { gateId, class: 'refused', reason: 'thread_from_earlier_session', threadId: args.threadId }
    }

    const session = await this.options.sessions.agent(ctx.principal)
    const reply = await this.options.t3.interrupt(session.token, args.threadId, { stop: true })

    if (reply.transport !== 'ok' || reply.isError) {
      return this.t3Error(reply.code, args.threadId)
    }

    const read = await this.options.t3.read(session.token, args.threadId)

    if (read.kind !== 'found') {
      return this.t3Error('thread_not_found', args.threadId)
    }

    this.statusReader.observe(row, read)

    return { gateId: this.gateId(), class: 'ok', threadId: args.threadId, stopped: !threadBusy(read), status: threadStatusOf(read) }
  }

  async read(ctx: CallContext, args: { threadId: string }): Promise<WorkThreadAnswer> {
    const session = await this.options.sessions.agent(ctx.principal)
    const read = await this.options.t3.read(session.token, args.threadId)

    if (read.kind === 'transport' || read.kind === 'error') {
      return this.t3Error(read.kind === 'error' ? read.code : 't3_unavailable', args.threadId)
    }

    if (read.kind === 'absent') {
      return this.t3Error('thread_not_found', args.threadId)
    }

    const row = this.ledger.receiptByThread(ctx.principal, args.threadId)

    if (row) {
      this.statusReader.observe(row, read)
    }

    const encoded = Buffer.byteLength(JSON.stringify(read.raw))

    return {
      gateId: this.gateId(),
      class: 'ok',
      threadId: args.threadId,
      status: threadStatusOf(read),
      ...(read.activeRunId ? { activeRunId: read.activeRunId } : {}),
      runs: read.runs.slice(0, 100).map(run => ({ runId: run.runId, ordinal: run.ordinal, status: THREAD_STATUS.has(run.status) ? run.status : 'idle' })),
      t3: encoded <= 262_144 ? read.raw : { truncated: true, bytes: encoded }
    }
  }

  async wait(ctx: CallContext, args: { threadId: string; timeoutMs?: number }): Promise<WorkThreadAnswer> {
    const started = this.monotonic()
    const session = await this.options.sessions.agent(ctx.principal)
    const first = await this.options.t3.read(session.token, args.threadId)

    if (first.kind === 'absent') {
      return this.t3Error('thread_not_found', args.threadId)
    }

    if (first.kind !== 'found') {
      return this.t3Error('t3_unavailable', args.threadId)
    }

    // The run to wait on is the launch's own (ordinal 1); until it exists the answer is `no_run_yet`, never `idle`
    const row = this.ledger.receiptByThread(ctx.principal, args.threadId)
    const run = row ? first.runs.find(item => item.ordinal === 1) : (first.activeRunId ? first.runs.find(item => item.runId === first.activeRunId) : undefined)

    if (row && !run) {
      return { gateId: this.gateId(), class: 'ok', threadId: args.threadId, status: 'no_run_yet', waitedMs: 0 }
    }

    if (run && BUSY_RUN(run.status)) {
      const reply = await this.options.t3.wait(session.token, args.threadId, run.runId, Math.min(args.timeoutMs ?? 50_000, 50_000))

      if (reply.transport !== 'ok' || reply.isError) {
        return this.t3Error(reply.code, args.threadId)
      }
    }

    const after = await this.options.t3.read(session.token, args.threadId)

    if (after.kind !== 'found') {
      return this.t3Error('t3_unavailable', args.threadId)
    }

    if (row) {
      this.statusReader.observe(row, after)
    }

    const final = run ? (after.runs.find(item => item.runId === run.runId)?.status ?? after.status) : threadStatusOf(after)
    const status = (THREAD_STATUS.has(final) ? final : threadStatusOf(after)) as WorkThreadStatus

    return {
      gateId: this.gateId(),
      class: 'ok',
      threadId: args.threadId,
      status,
      ...(run ? { runId: run.runId } : {}),
      waitedMs: Math.min(55_000, Math.max(0, Math.round(this.monotonic() - started)))
    }
  }

  async list(ctx: CallContext, args: { limit?: number; cursor?: string }): Promise<WorkThreadAnswer> {
    const session = await this.options.sessions.agent(ctx.principal)
    const reply = await this.options.t3.list(session.token, { limit: args.limit ?? 50, ...(args.cursor ? { cursor: args.cursor } : {}) })

    if (reply.transport !== 'ok' || reply.isError) {
      return this.t3Error(reply.code)
    }

    const raw = ((reply.data?.threads ?? reply.data?.items ?? []) as Record<string, unknown>[]).slice(0, args.limit ?? 50)

    const threads = raw.flatMap(item => {
      const threadId = (item.threadId ?? item.id) as unknown

      if (typeof threadId !== 'string' || !/^[A-Za-z0-9:._-]{1,200}$/u.test(threadId)) {
        return []
      }

      const status = typeof item.status === 'string' && THREAD_STATUS.has(item.status) ? item.status : 'idle'
      const title = typeof item.title === 'string' && item.title ? codePointSlice(item.title, 200) : undefined

      return [{ threadId, status, mine: Boolean(this.ledger.receiptByThread(ctx.principal, threadId)), ...(title ? { title } : {}) }]
    })

    const next = reply.data?.nextCursor

    return {
      gateId: this.gateId(),
      class: 'ok',
      threads,
      ...(typeof next === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(next) ? { nextCursor: next } : {})
    }
  }

  /**
   * Main's check before it restarts the session server on its own (`restartWhenIdle`): true only when T3 answered
   * through main's own owner session, the list fits one page, and no thread in it has a run in flight or a status this
   * code does not know. Anything else is "not idle": a restart that is declined is retried, one that interrupts the
   * person's own run is not recoverable.
   */
  async ownerRunsIdle(): Promise<boolean> {
    try {
      const session = await this.options.sessions.owner()
      const reply = await this.options.t3.list(session.token, { limit: 200 })

      if (reply.transport !== 'ok' || reply.isError || reply.data?.nextCursor) {
        return false
      }

      const raw = reply.data?.threads ?? reply.data?.items ?? []

      return Array.isArray(raw) && raw.every(item => {
        const status = (item as { status?: unknown } | null)?.status

        return typeof status === 'string' && THREAD_STATUS.has(status) && !BUSY_RUN(status)
      })
    } catch {
      return false
    }
  }

  // ---- grants and the switch
  /**
   * The Mac mints the grant: 32 random bytes, kept only as a hash; one live grant per agent. The bearer goes to the
   * platform (`carry`), never to a log. Refused while the route is closed, the agent is not entitled, or a stop is owed.
   */
  mintGrant(principal: string): { bearer: string; hash: string; generation: number; mintedAt: number; expiresAt: number } {
    const agent = this.ledger.agent(principal)

    if (!this.workGrantAccepted() || !this.routeOpen() || !agent?.entitled || this.ledger.scopeBlocked(principal) || this.options.held()) {
      throw new GateAdmissionError('revoked')
    }

    const bearer = randomBytes(WORK_GRANT_RANDOM_BYTES).toString('base64url')
    const hash = sha256Hex(bearer)
    const mintedAt = this.now()
    const expiresAt = mintedAt + WORK_PROVISIONAL.grantLifetimeSeconds * 1000

    this.ledger.insertGrant({ hash, principal, routeEpoch: this.ledger.routeEpoch(), generation: agent.generation, mintedAt, expiresAt })

    return { bearer, hash, generation: agent.generation, mintedAt, expiresAt }
  }

  // ---- revocation (plan §6.4)
  /** Steps 1 and 2: the cutoff, in one durable write. From here the gate refuses the scope whatever the edge still lets through. */
  revoke(input: RevokeInput): CutoffResult {
    const result = this.beginRevoke(input)
    this.finishRevoke(input, result)

    return result
  }

  /** The durable part alone, so a caller can put it in one transaction with its own writes (the sync client does). */
  beginRevoke(input: RevokeInput): CutoffResult {
    return this.ledger.cutoff(input)
  }

  /** What follows a committed cutoff: the report owed to the platform, the event, and the cleanup (steps 3 to 6). */
  finishRevoke(input: RevokeInput, result: CutoffResult): void {
    this.ledger.enqueue('mac_event', {
      kind: input.scope === 'route' ? 'route_closed' : 'agent_closed',
      routeEpoch: result.routeEpoch,
      at: this.now(),
      ...(input.principal ? { agentPrincipal: input.principal, agentGeneration: result.generation } : {})
    })
    this.options.log?.('revoked', { scope: input.scope, reason: input.reason, owed: result.owed })
    this.emit({ type: 'revoked', scope: input.scope, principal: input.principal ?? null, reason: input.reason, revocationId: result.revocationId })
    this.emit({ type: 'change' })
    void this.scheduleSettle()
  }

  /** Steps 3 to 6, serialized. Safe to call at any time and after a restart: it picks up what is owed. */
  scheduleSettle(): Promise<void> {
    if (this.closed) {
      return Promise.resolve()
    }

    if (this.settling) {
      this.settleAgain = true

      return this.settling
    }

    this.settling = (async () => {
      try {
        do {
          this.settleAgain = false
          await this.runSettle()
        } while (this.settleAgain && !this.closed)
      } catch (error) {
        // a gate that was stopped (the app is going away) leaves the cleanup owed in the ledger; nothing else is hidden
        if (!this.closed) {
          throw error
        }
      } finally {
        this.settling = undefined
      }
    })()

    return this.settling
  }

  private async runSettle(): Promise<void> {
    const { sessions, t3 } = this.options

    // step 3: the revoked caller's own session is revoked, so the same launch cannot be retried into T3
    for (const revocation of this.ledger.openRevocations()) {
      const flag = `sessions_revoked_${revocation.id}`

      if (this.ledger.meta(flag) === undefined) {
        try {
          await (revocation.scope === 'route'
            ? sessions.revokeAll(this.ledger.agents().map(agent => agent.principal))
            : sessions.revokeAgent(revocation.principal as string))
          this.ledger.setMeta(flag, '1')
        } catch {
          // retried on the next pass; the cutoff already holds
        }
      }
    }

    let owner: GateSession | undefined
    let restarted = false

    for (const first of this.ledger.owedRows()) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const row = this.ledger.receipt(first.principal, first.requestId) as ReceiptRow

        if (row.settled) {
          break
        }

        try {
          owner ??= await sessions.owner()
        } catch {
          return
        }

        // a row whose forwarded mark is unset never reached T3: settles at once, no restart
        if (!row.forwarded && row.state === 'admitted') {
          this.settle(row, 'never_sent')

          break
        }

        const read = await t3.read(owner.token, row.threadId as string)

        if (read.kind === 'found') {
          if (threadBusy(read)) {
            await t3.interrupt(owner.token, row.threadId as string, { stop: true })

            let seen = read
            const polls = this.options.stopPolls ?? 40

            for (let i = 0; i < polls && threadBusy(seen); i++) {
              await (this.options.sleep ?? ((ms: number) => delay(ms)))(this.options.stopPollMs ?? 250)
              const again = await t3.read(owner.token, row.threadId as string)

              if (again.kind !== 'found') {
                break
              }

              seen = again
            }

            if (threadBusy(seen)) {
              break
            }
          }

          if (row.state === 'admitted') {
            this.ledger.update(row.principal, row.requestId, { state: 'launched' })
          }

          this.settle(this.ledger.receipt(row.principal, row.requestId) as ReceiptRow, 'stopped')

          break
        }

        if (read.kind !== 'absent') {
          break
        }

        // absent, and a byte may have crossed: settle only on a read made after another T3 process is ready
        const now = t3.incarnation()

        if (now !== undefined && now !== row.incarnation) {
          this.settle(row, 'nothing_started')

          break
        }

        if (!restarted && t3.restartWhenIdle) {
          restarted = true

          if ((await t3.restartWhenIdle()) === 'restarted') {
            owner = undefined

            continue
          }
        }

        break
      }
    }

    this.acknowledgeSettled()
  }

  /** Step 6: only when every row in scope is stopped or settled. */
  private acknowledgeSettled(): void {
    for (const revocation of this.ledger.openRevocations()) {
      const open = this.ledger.receipts('stop_scope IS NOT NULL AND settled IS NULL AND revocation_id <= ?', revocation.id)

      if (open.length > 0) {
        continue
      }

      const rows = this.ledger.receipts('revocation_id = ?', revocation.id)

      this.ledger.ackRevocation(revocation.id)
      this.emit({
        type: 'acknowledged',
        scope: revocation.scope,
        principal: revocation.principal,
        revocationId: revocation.id,
        requestIds: rows.map(row => row.requestId)
      })
    }

    this.emit({ type: 'change' })
  }

  // ---- lifecycle
  /**
   * After the session server is up: settle what is owed (the gate admits nothing in that scope until then), then
   * recover launches that were admitted and not yet answered. Read-only status never calls `recover`.
   */
  async start(): Promise<void> {
    this.closed = false
    this.ledger.pruneGrants(this.now() - 86_400_000)
    await this.scheduleSettle()
    await this.recover()
  }

  stop(): void {
    this.closed = true
  }

  /**
   * Recovery that CAN dispatch (the review's second requirement). It resends only the gate's own stored call, only
   * through `dispatch` and so through `handoff`, and only for a row that is not owed a stop.
   */
  async recover(): Promise<void> {
    if (this.options.held() || this.options.t3.incarnation() === undefined) {
      return
    }

    for (const row of this.ledger.receipts("state = 'admitted' AND settled IS NULL AND stop_scope IS NULL")) {
      await this.lock(`${row.principal}|${row.requestId}`).run(async () => {
        const fresh = this.ledger.receipt(row.principal, row.requestId) as ReceiptRow

        if (fresh.state !== 'admitted' || fresh.stopScope || fresh.settled) {
          return
        }

        if (fresh.forwarded) {
          const read = await this.statusReader.read(fresh)

          if (read.kind === 'found') {
            this.statusReader.observe(fresh, read)

            return
          }

          if (read.kind !== 'absent' || !this.statusReader.resendable(fresh).ok || fresh.forwardCount >= 2) {
            return
          }
        }

        await this.dispatch(fresh.principal, fresh.requestId)
      })
    }
  }

  /** lane R's "reset done": every session died with the reset. Threads from before stay read-only to the agent (§11.2). */
  async onResetDone(): Promise<void> {
    this.options.sessions.forgetAll()
    this.revoke({ scope: 'route', reason: 'rollback_restore' })
    await this.scheduleSettle()
  }

  // ---- state for the Settings and enrollment surfaces
  state(): GateState {
    const agents = this.ledger.agents().map(agent => ({
      principal: agent.principal,
      generation: agent.generation,
      entitled: agent.entitled,
      hasGrant: Boolean(this.ledger.liveGrant(agent.principal)),
      running: this.ledger.receipts("principal = ? AND state IN ('admitted', 'launched') AND finished = 0 AND settled IS NULL AND stop_scope IS NULL", agent.principal).length,
      stopOwed: this.ledger.owedRows().filter(row => row.principal === agent.principal).length
    }))

    const owed = this.ledger.owedRows()
    const fresh = this.entitlementsFresh()

    return {
      phase: !this.routeOpen() ? 'closed' : this.options.held() || owed.some(row => row.stopScope === 'route') ? 'holding' : fresh ? 'open' : 'stale',
      workGrantAccepted: this.workGrantAccepted(),
      routeOpen: this.routeOpen(),
      routeEpoch: this.ledger.routeEpoch(),
      entitlementsFresh: fresh,
      lastSyncAgeSeconds: this.lastGoodSync === undefined ? null : Math.round((this.monotonic() - this.lastGoodSync) / 1000),
      appliedSeq: this.ledger.appliedSeq(),
      settledSeq: this.ledger.settledSeq(),
      agents,
      stopsOwed: {
        total: owed.length,
        routeWide: owed.some(row => row.stopScope === 'route'),
        agents: [...new Set(owed.filter(row => row.stopScope === 'agent').map(row => row.principal))]
      },
      continuation: false,
      undeliveredReports: this.ledger.pending('stop_report').length
    }
  }
}

const BUSY_RUN = (status: string) => ['running', 'starting', 'preparing', 'waiting', 'queued'].includes(status)

