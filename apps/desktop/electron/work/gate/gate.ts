import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { answerForRow } from './answers'
import {
  sha256Hex,
  WORK_DERIVED_TITLE_MAX_CODE_POINTS,
  WORK_GRANT_RANDOM_BYTES,
  WORK_PROVISIONAL,
  WORK_REJECTION_REASONS,
  WORK_THREAD_STATUSES,
  type WorkAdmissionErrorType,
  type WorkConsentSnapshot,
  workDeadline,
  workEntitlementsFresh,
  workExpectedThreadId,
  type WorkGateId,
  type WorkLaunchArguments,
  workOwnerEventAge,
  workParamsHash,
  workPlanLaunchDecision,
  type WorkPlanLaunchInput,
  type WorkPlanRefusalReason,
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

/**
 * Gate 4b-1, compiled in: the ONE plan instance a launch may ever be set to. It is not read from a setting, a caller or a
 * project default. Claude and Antigravity are absent on purpose: they join only when their makers confirm background use in
 * writing, and that is a code change here, not a switch. The Atum instance is the other value a launch can carry (`delegated`).
 */
export const WORK_PLAN_INSTANCE_IDS: readonly string[] = ['codex']

export type GatePhaseHook = (point: string, key: string) => Promise<void> | void

import { type RelayHistory, type RelaySelection, WorkRelay } from './relay'

export interface GateOptions {
  relayHistory?: RelayHistory
  relaySelection?(principal: string): RelaySelection | undefined
  relayProvision?(principal: string, threadId: string): Promise<{ projectId: string; personaRevision: number }>

  relayLimit?(): { state: 'unknown' | 'available' | 'exhausted'; resetAt?: number }
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
const REJECTIONS = new Set<string>(WORK_REJECTION_REASONS)

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
  readonly relay: WorkRelay
  readonly statusReader: RequestStatusReader
  private readonly ledger: GateLedger
  private readonly listeners = new Set<Listener>()
  private readonly locks = new Map<string, Mutex>()
  private readonly now: () => number
  private readonly monotonic: () => number
  private readonly modeLimit: string
  private lastGoodSync: number | undefined
  private headRegressed = false
  /** The consent snapshot the Mac applied last, and when (monotonic). After a restart the time is unknown: stale until a pull. */
  private consentSnapshot: WorkConsentSnapshot | undefined
  private consentAt: number | undefined
  private settling: Promise<void> | undefined
  private settleAgain = false
  private closed = false

  constructor(private readonly options: GateOptions) {
    this.ledger = options.ledger
    this.now = options.now ?? Date.now
    this.monotonic = options.monotonic ?? (() => performance.now())
    this.modeLimit = options.modeLimit ?? 'approval-required/default'
    this.consentSnapshot = this.ledger.consent()
    this.relay = new WorkRelay({
      gateId: () => this.gateId(),
      localSwitch: () => this.planSwitchOn(),
      consent: () => {
        const c = this.ledger.consent()

        return c
          ? { ...c, devices: c.state === 'on' ? [options.deviceServiceId] : [] }
          : { provider: 'codex', state: 'off', agents: [], devices: [], alsoWhenScheduled: false, revision: 0 }
      },
      ...options,
      history: options.relayHistory,
      selection: options.relaySelection,
      provision: options.relayProvision,
      limit: options.relayLimit,
      now: this.now,
      modeLimit: this.modeLimit,
      resetAuthority: ctx => this.countersCurrent(ctx) && this.entitlementsFresh() && !options.held(),
      authority: ctx =>
        this.countersCurrent(ctx) &&
        this.entitlementsFresh() &&
        !options.held() &&
        !this.ledger.scopeBlocked(ctx.principal),
      fence: ctx =>
        this.countersCurrent(ctx) &&
        this.entitlementsFresh() &&
        !options.held() &&
        !this.ledger.scopeBlocked(ctx.principal) &&
        this.planDecision(ctx.principal, false) === 'allowed'
    })
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

  // ---- gate 4b: the plan (Codex) and its consent (contract 1.2)
  /** The snapshot, once it was applied durably with a page: its age counts from now on this Mac's monotonic clock. */
  noteConsent(snapshot: WorkConsentSnapshot): void {
    this.consentSnapshot = snapshot
    this.consentAt = this.monotonic()
    this.emit({ type: 'change' })
  }

  /**
   * The platform can no longer carry consent (contract 1.1 fallback): the snapshot held is of unknown age, so plan launches are
   * refused as stale at once, not after the remaining life of the last snapshot. Only a snapshot applied from a valid 1.2 page
   * (`noteConsent`) restores it. The stored snapshot stays: it is what the ledger keeps for the next 1.2 pull.
   */
  invalidateConsent(): void {
    if (this.consentAt === undefined) {
      return
    }

    this.consentAt = undefined
    this.emit({ type: 'change' })
  }

  /** The revision this Mac durably applied (the ack carries it), or undefined when no snapshot was ever applied. */
  consentRevision(): number | undefined {
    return this.ledger.consent()?.revision
  }

  /** What the owner's consent says about plan launches, for the screen: `unknown` while the snapshot is missing or stale. */
  planConsentState(): 'on' | 'off' | 'unknown' {
    const snapshot = this.consentSnapshot

    if (
      !snapshot ||
      this.consentAgeSeconds() > WORK_PROVISIONAL.entitlementFreshnessBoundSeconds ||
      this.headRegressed
    ) {
      return 'unknown'
    }

    return snapshot.state
  }

  private consentAgeSeconds(): number {
    return this.consentAt === undefined ? Number.POSITIVE_INFINITY : (this.monotonic() - this.consentAt) / 1000
  }

  planSwitchOn(): boolean {
    return this.ledger.planSwitchOn()
  }

  /**
   * The Mac's whole plan rule (the platform's `workPlanLaunchDecision`), evaluated NOW from what this Mac holds: the snapshot,
   * its age on the monotonic clock, the head regression, the local switch. `scheduled` is the caller's: see `admitAndForward`.
   */
  planDecision(principal: string, scheduled: boolean): 'allowed' | WorkPlanRefusalReason {
    const snapshot = this.consentSnapshot

    const input: WorkPlanLaunchInput = {
      consent: snapshot?.state ?? 'off',
      agentNamed: snapshot?.agents.includes(principal) ?? false,
      macNamed: (snapshot?.agents.length ?? 0) > 0,
      snapshotAgeSeconds: this.consentAgeSeconds(),
      headRegressed: this.headRegressed,
      localSwitch: this.ledger.planSwitchOn(),
      scheduled,
      alsoWhenScheduled: snapshot?.alsoWhenScheduled ?? false
    }

    return workPlanLaunchDecision(input)
  }

  /**
   * Apply a consent snapshot in the caller's transaction (the page that carried it): store it, and cut off the plan threads of every
   * assistant it no longer names (or all of them when it says off). Returns what `finishConsent` needs once the page is durable.
   */
  beginConsent(snapshot: WorkConsentSnapshot): CutoffResult[] {
    this.ledger.setConsent(snapshot)
    const named = snapshot.state === 'on' ? new Set(snapshot.agents) : new Set<string>()

    return [
      ...this.ledger.planCutoff(
        this.ledger.planPrincipals().filter(principal => !named.has(principal)),
        snapshot.state === 'on' ? 'plan_consent_scope' : 'plan_consent_off'
      ),
      ...(snapshot.alsoWhenScheduled ? [] : this.ledger.planCutoff(
        this.ledger.planPrincipals().filter(principal => named.has(principal)), 'plan_not_scheduled', true
      ))
    ]
  }

  finishConsent(snapshot: WorkConsentSnapshot, results: CutoffResult[]): void {
    this.noteConsent(snapshot)
    this.finishPlanCutoff(results, snapshot.state === 'on' ? 'plan_consent_scope' : 'plan_consent_off')
  }

  /** "Agents may use my ChatGPT plan here": off interrupts every plan thread at once; on changes nothing that runs. */
  setPlanSwitch(on: boolean): void {
    const results = this.ledger.tx(() => {
      this.ledger.setPlanSwitch(on)

      return on ? [] : this.ledger.planCutoff(this.ledger.planPrincipals(), 'plan_switch_off')
    })

    this.finishPlanCutoff(results, 'plan_switch_off')
    this.emit({ type: 'change' })
  }

  private finishPlanCutoff(results: CutoffResult[], reason: string): void {
    for (const result of results) {
      this.options.log?.('plan_revoked', { reason, owed: result.owed })
      this.emit({ type: 'revoked', scope: 'agent', principal: null, reason, revocationId: result.revocationId })
    }

    if (results.length > 0) {
      this.emit({ type: 'change' })
      void this.scheduleSettle()
    }
  }

  /** Whether a call names an instance this gate may ever send to: the Atum instance, or (for a plan row) the compiled-in plan one. */
  private selectionAllowed(call: WorkT3LaunchCall, plan: string | null): boolean {
    const instance = call.modelSelection.instanceId

    return plan === null
      ? instance === this.options.delegated.instanceId
      : plan === 'codex' && WORK_PLAN_INSTANCE_IDS.includes(instance)
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
  silence<T extends { class?: string }>(ctx: CallContext, answer: T, revoked: () => T): T {
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

    if (row.paramsHash !== workParamsHash(args.projectId, args.task, args.ownerEvent, args.plan) || row.notAfter !== args.notAfter) {
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
      const { read, incarnation } = await this.confirmedStatusRead(row)

      if (read.kind === 'found') {
        this.observeThread(row, read)

        return answerForRow(this.gateId(), this.ledger.receipt(row.principal, row.requestId) as ReceiptRow)
      }

      if (read.kind !== 'absent') {
        return answerForRow(this.gateId(), this.ledger.receipt(row.principal, row.requestId) as ReceiptRow)
      }

      const proven = this.commitProvenRejection(row, incarnation)

      if (proven) {
        return proven
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
    const paramsHash = workParamsHash(args.projectId, args.task, args.ownerEvent, args.plan)

    const refuse = (reason: string, extra: { eventId?: string } = {}) =>
      this.refuse(principal, args.requestId, reason, { paramsHash, notAfter: args.notAfter, ...extra })

    // 1. the deadline: open, and bounded by the Mac (a caller cannot buy a long one)
    const deadline = workDeadline((args.notAfter - this.now()) / 1000)

    if (deadline !== 'ok') {
      return refuse(deadline)
    }

    // 1b. a plan launch (gate 4b-3), after the shape and deadline checks and before anything is read from T3 or Matrix: the Mac's
    //     snapshot, then the consent, then the local switch. The first failure is a refused receipt, whatever else is true. The
    //     fourth check (`plan_not_scheduled`) needs the owner's message and is made at step 5.
    if (args.plan) {
      const decision = this.planDecision(principal, false)

      if (decision !== 'allowed') {
        return refuse(decision)
      }
    }

    // 2. nothing in the scope still owes a stop
    if (this.ledger.scopeBlocked(principal)) {
      return { ...head, class: 'revocation_pending', receipt: 'none' }
    }

    // 3. the provider is ready (not a receipt: a moment must not become a permanent refusal). A plan launch asks T3 for the plan's
    //    own status; the instance and model it sets come from the compiled-in allow-list and T3's advertised list, never the caller.
    let session: GateSession
    let selection = this.options.delegated

    try {
      session = await this.options.sessions.agent(principal)

      if (args.plan) {
        const plan = await this.options.t3
          .prepare(session.token)
          .then(ready => (ready ? this.options.t3.planProvider?.(session.token) : undefined))

        if (
          plan?.status !== 'connected' ||
          !plan.selection ||
          !WORK_PLAN_INSTANCE_IDS.includes(plan.selection.instanceId)
        ) {
          return { ...head, class: 'unavailable', receipt: 'none', reason: 'provider_not_ready' }
        }

        selection = plan.selection
      } else if (
        !(await this.options.t3.prepare(session.token)) ||
        !(await this.options.t3.providerReady(session.token))
      ) {
        return { ...head, class: 'unavailable', receipt: 'none', reason: 'provider_not_ready' }
      }
    } catch {
      return { ...head, class: 'unavailable', receipt: 'none', reason: 'provider_not_ready' }
    }

    // 4. the owner's balance, read from the Mac's proxy. A plan launch debits no Protons, so it never reads it.
    if (!args.plan) {
      const access = await this.options.modelAccess().catch((): ModelAccess => 'unavailable')

      if (access === 'empty') {
        return refuse('balance_empty')
      }

      if (access === 'unavailable') {
        return { ...head, class: 'unavailable', receipt: 'none', reason: 'provider_not_ready' }
      }
    }

    // 5. the owner's own message, fetched by the gate itself
    const event = await this.options.owner.fetch({ agentPrincipal: principal, eventId: args.ownerEvent }).catch(() => ({ kind: 'unreachable' }) as const)

    if (event.kind === 'unreachable') {
      return { ...head, class: 'unavailable', receipt: 'none', reason: 'owner_event_unverifiable' }
    }

    const age = event.kind === 'ok' ? workOwnerEventAge((this.now() - event.originServerTs) / 1000) : undefined

    // "Scheduled" (gate 4b-3, defined here once): the launch is NOT backed by a fresh, verified, unclaimed message of the owner. That is
    // the very test the slice-A claim applies (the message exists and is the owner's, is within its age bound, and no other launch
    // holds it). A plan launch that is not so backed needs the consent's "also when scheduled"; without it it is refused
    // `plan_not_scheduled`, in place of the owner-event reason, because the plan check comes first (order fixed by the contract).
    // With the consent it still meets the owner-event checks below: slice A has no standing permit, every launch consumes a message.
    if (args.plan) {
      const backed = event.kind === 'ok' && age === 'ok' && !this.ledger.eventClaimed(args.ownerEvent)
      const decision = this.planDecision(principal, !backed)

      if (decision !== 'allowed') {
        return refuse(decision, { eventId: args.ownerEvent })
      }
    }

    if (event.kind === 'invalid') {
      return refuse(event.reason, { eventId: args.ownerEvent })
    }

    if (age !== 'ok') {
      return refuse(age as 'owner_event_too_old' | 'owner_event_future', { eventId: args.ownerEvent })
    }

    if (this.ledger.eventClaimed(args.ownerEvent)) {
      return refuse('event_already_used', { eventId: args.ownerEvent })
    }

    // 6. ONE synchronous section: the fence again (everything above was async), then the claim on the event and the
    //    `admitted` row in one durable transaction. Nothing is sent to T3 here.
    if (!this.countersCurrent(ctx) || !this.entitlementsFresh() || this.options.held() || this.ledger.scopeBlocked(principal)) {
      throw new GateAdmissionError(this.countersCurrent(ctx) ? 'stale_entitlements' : 'revoked')
    }

    // the consent as of THIS step, not as of step 1b: it may have been withdrawn while the awaits above ran
    if (args.plan) {
      const decision = this.planDecision(principal, false)

      if (decision !== 'allowed') {
        return refuse(decision, { eventId: args.ownerEvent })
      }
    }

    if (this.options.sessions.agentSessionId(principal) !== session.sessionId || this.now() > args.notAfter) {
      return { ...head, class: 'unavailable', receipt: 'none', reason: 'provider_not_ready' }
    }

    const call = buildLaunchCall({
      args,
      ownerBody: (event as Extract<typeof event, { kind: 'ok' }>).body,
      delegated: selection
    })

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
      generation: ctx.generation,
      ...(args.plan ? { plan: args.plan } : {})
    })

    if (admitted.ok === false) {
      return admitted.reason === 'event_already_used'
        ? refuse('event_already_used', { eventId: args.ownerEvent })
        : answerForRow(gateId, this.ledger.receipt(principal, args.requestId) as ReceiptRow)
    }

    await this.point('admitted', `${principal}|${args.requestId}`)

    return this.dispatch(principal, args.requestId)
  }

  /**
   * A read found this row's thread. Gate 4b-3: the provider it runs on NOW is compared with the one the gate set, and a difference is
   * logged (the owner may move their own view of it in Work, so this is a note and not a stop). The thread is never sent to again:
   * every path that could send reads first, and a thread that exists ends the send.
   */
  private observeThread(row: ReceiptRow, read: Extract<ThreadRead, { kind: 'found' }>): void {
    const selected = row.callJson ? (JSON.parse(row.callJson) as WorkT3LaunchCall).modelSelection.instanceId : undefined

    if (read.provider !== undefined && selected !== undefined && read.provider !== selected) {
      this.options.log?.('thread_provider_changed', { plan: row.plan !== null })
    }

    this.statusReader.observe(row, read)
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

    // Gate 4b-3, "re-read the thread's current provider before each send": a send to a launch's own thread (a resend) first reads
    // the thread. A thread that exists is never sent to again, and one whose provider is not the row's own selection is logged.
    const before = this.ledger.receipt(principal, requestId) as ReceiptRow

    if (before.forwarded) {
      const reread = await this.options.t3
        .read(session.token, before.threadId as string)
        .catch((): ThreadRead => ({ kind: 'transport' }))

      if (reread.kind === 'found') {
        this.observeThread(before, reread)

        return answerForRow(this.gateId(), this.ledger.receipt(principal, requestId) as ReceiptRow)
      }

      if (reread.kind !== 'absent') {
        return answerForRow(this.gateId(), this.ledger.receipt(principal, requestId) as ReceiptRow)
      }
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
        this.ledger.tx(() => {
          this.ledger.update(principal, requestId, { state: 'refused', reason: 'expired', settled: 'never_sent' })
          this.ledger.releaseClaim(row.eventId)
        })

        return answer(same())
      }

      return answer({ gateId, requestId, class: 'ambiguous', receipt: 'admitted', forwarded: true, cause: 'deadline_passed' })
    }

    // b2. gate 4b, as of THIS step: the call's provider must be one this gate may ever send to (a row can only hold such a call, but a
    //     tampered ledger must not become a way to a provider outside the compiled list), and a plan row needs the consent, its
    //     snapshot's freshness and the local switch right now. Revoked means refused for good when no byte left, and held otherwise.
    const refuseUnsent = (reason: string) => {
      this.ledger.tx(() => {
        this.ledger.update(principal, requestId, { state: 'refused', reason, settled: 'never_sent' })
        this.ledger.releaseClaim(row.eventId)
      })

      return answer(same())
    }

    if (!this.selectionAllowed(call, row.plan)) {
      return row.forwarded ? hold() : refuseUnsent('invalid_field')
    }

    if (row.plan) {
      const decision = this.planDecision(principal, false)

      if (decision !== 'allowed') {
        return row.forwarded ? hold() : refuseUnsent(decision)
      }
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
      if (row.forwardCount > 1) {
        // T3 refused THIS send, but an earlier send of the same request was never answered and may have started the
        // thread. A refusal of the retry says nothing about it: the claim on the owner's event and the stop owed stay
        // until a read proves the whole request's outcome (`commitProvenRejection`, or the cleanup's own read). This send
        // is answered, so the process that must be gone is the earlier send's, not this one's.
        this.ledger.tx(() => {
          this.ledger.update(principal, requestId, { reason })
          this.ledger.resolveSend(principal, requestId)
        })

        return owed ? answerForRow(gateId, this.ledger.receipt(principal, requestId) as ReceiptRow) : pending
      }

      this.ledger.tx(() => {
        this.ledger.update(principal, requestId, { state: 'rejected', reason })
        this.ledger.releaseClaim(row.eventId)
      })

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

  /**
   * A read of a row's thread together with the T3 process that answered it. The process id is sampled before and after the
   * read: a read that straddled a restart, or ran while none served, has no process to credit (undefined), and proves nothing.
   */
  private async confirmedRead(read: () => Promise<ThreadRead>): Promise<{ read: ThreadRead; incarnation: string | undefined }> {
    const before = this.options.t3.incarnation()
    const result = await read()
    const after = this.options.t3.incarnation()

    return { read: result, incarnation: before !== undefined && before === after ? after : undefined }
  }

  private confirmedStatusRead(row: ReceiptRow) {
    return this.confirmedRead(() => this.statusReader.read(row))
  }

  /**
   * The proof that nothing started: the thread is absent on a read made by a confirmed T3 process OTHER than the one the last
   * unresolved send went to. While that process lives, the send may still be running in it, and absence means only "not yet".
   */
  private absenceProven(row: ReceiptRow, confirmed: string | undefined): boolean {
    return confirmed !== undefined && row.incarnation !== null && confirmed !== row.incarnation
  }

  /**
   * A rejection that was parked because an earlier send's outcome was unknown becomes final only when the thread is
   * absent on a read made by ANOTHER (confirmed) T3 process than the one that earlier send went to (the same proof the
   * cleanup uses). The rejection and the release of the claim are one durable write. Undefined: not proven, nothing changes.
   */
  private commitProvenRejection(row: ReceiptRow, confirmed: string | undefined): WorkRequestAnswer | undefined {
    const current = this.ledger.receipt(row.principal, row.requestId) as ReceiptRow

    if (current.state !== 'admitted' || current.stopScope || !current.reason || !REJECTIONS.has(current.reason)) {
      return undefined
    }

    if (!this.absenceProven(current, confirmed)) {
      return undefined
    }

    this.ledger.tx(() => {
      this.ledger.update(current.principal, current.requestId, { state: 'rejected', reason: current.reason })
      this.ledger.releaseClaim(current.eventId)
    })

    return answerForRow(this.gateId(), this.ledger.receipt(current.principal, current.requestId) as ReceiptRow)
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

      if (reply.transport !== 'ok' || reply.isError || !reply.data) {
        return false
      }

      // T3's own pagination, validated: one complete page (no cursor, and a total that is exactly what came back).
      const { threads, total, nextCursor } = reply.data

      if (!Array.isArray(threads) || (nextCursor !== null && nextCursor !== undefined) || (total !== undefined && total !== threads.length)) {
        return false
      }

      return threads.every(item => {
        const thread = item as { status?: unknown; blockedOnThreadWait?: unknown; pendingBackgroundTasks?: unknown } | null

        return (
          typeof thread?.status === 'string' &&
          THREAD_STATUS.has(thread.status) &&
          !BUSY_RUN(thread.status) &&
          thread.blockedOnThreadWait !== true &&
          (thread.pendingBackgroundTasks === undefined || (Array.isArray(thread.pendingBackgroundTasks) && thread.pendingBackgroundTasks.length === 0))
        )
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

  /** What follows a committed cutoff: the log line, the event and the cleanup (steps 3 to 6). */
  finishRevoke(input: RevokeInput, result: CutoffResult): void {
    // The `mac_event` for the platform was queued inside the cutoff's own transaction (`GateLedger.cutoff`).
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

        const { read, incarnation } = await this.confirmedRead(() => t3.read((owner as GateSession).token, row.threadId as string))

        if (read.kind === 'found') {
          // `stopped` is claimed only after a native Stop that T3 accepted and a read AFTER it that shows nothing in
          // flight: an idle first read proves nothing about a run that is about to start or a stop that never landed.
          if (!(await this.stopAndVerify(owner.token, row.threadId as string))) {
            break
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

        // absent, and a byte may have crossed: settle only on a read made by a confirmed T3 process other than the one the last
        // unresolved send went to (a retry that went to a newer process is still running there, and an absent read proves nothing)
        if (this.absenceProven(row, incarnation)) {
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

  /** A native Stop through main's owner session, then a validated read after it. False: the stop is still owed. */
  private async stopAndVerify(token: string, threadId: string): Promise<boolean> {
    const { t3 } = this.options
    const stop = await t3.interrupt(token, threadId, { stop: true })

    // An explicit success only: T3 answered 200 with a result, not an error. A reply that is neither (a proxy page, a
    // JSON-RPC error, no body) is not a Stop that landed, whatever a later read shows.
    if (stop.transport !== 'ok' || stop.status !== 200 || stop.isError || stop.code) {
      return false
    }

    let seen = await t3.read(token, threadId)
    const polls = this.options.stopPolls ?? 40

    for (let i = 0; i < polls && seen.kind === 'found' && threadBusy(seen); i++) {
      await (this.options.sleep ?? ((ms: number) => delay(ms)))(this.options.stopPollMs ?? 250)
      seen = await t3.read(token, threadId)
    }

    return seen.kind === 'found' && !threadBusy(seen)
  }

  /** Step 6: only when every row in scope is stopped or settled AND the revoked callers' sessions are revoked. */
  private acknowledgeSettled(): void {
    for (const revocation of this.ledger.openRevocations()) {
      if (this.ledger.meta(`sessions_revoked_${revocation.id}`) === undefined) {
        continue
      }

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

        if (fresh.relayJson || fresh.state !== 'admitted' || fresh.stopScope || fresh.settled) {
          return
        }

        if (fresh.forwarded) {
          const { read, incarnation } = await this.confirmedStatusRead(fresh)

          if (read.kind === 'found') {
            this.observeThread(fresh, read)

            return
          }

          if (read.kind !== 'absent' || this.commitProvenRejection(fresh, incarnation)) {
            return
          }

          if (!this.statusReader.resendable(fresh).ok || fresh.forwardCount >= 2) {
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

