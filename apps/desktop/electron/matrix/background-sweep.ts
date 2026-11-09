import { createHash, randomUUID } from 'node:crypto'

import {
  AGENT_SWEEP_PROFILE_V2,
  type AgentSweepClaimedResponseV2,
  type AgentSweepDeferResponseV2,
  type AgentSweepDispatchResponseV2,
  type AgentSweepReleaseResponseV2
} from '../../../../packages/device-protocol/agent-sweep-v2'
import {
  agentSourceSnapshotHasTag,
  type AgentSourceSweepSnapshot
} from '../../../shared/src/agent-source-sweep'
import {
  followupSweepInsideNormalWindow,
  followupSweepLocalDay,
  type FollowupSweepMode,
  type FollowupSweepSourceStatus,
  followupSweepSuggestionHistory,
  type WarmupNudgeIndex
} from '../../../shared/src/followup-sweep'
import { AGENT_SWEEP_SYSTEM_JOB_ID } from '../../shared/background-sweep'

import type { BackgroundSweepSuggestionStore } from './background-sweep-suggestions'

export const AGENT_SWEEP_PROFILE = 'atum.agent-sweep/1' as const
/** The additive warm-up profile: same request shape, server-derived nudge identity and budget. */
export const AGENT_SWEEP_PROFILE_V11 = 'atum.agent-sweep/1.1' as const
export { AGENT_SWEEP_PROFILE_V2 }
export const FOLLOWUP_SWEEP_RESULT_PROFILE = 'atum.followup-sweep-result/1' as const
export { AGENT_SWEEP_SYSTEM_JOB_ID }
export type { WarmupNudgeIndex }

export interface AgentSweepOwnerEvent {
  eventId: string
  at: number
}

export interface AgentSweepActivity {
  lastOwnerEvent: AgentSweepOwnerEvent | null
  lastDialogueAt: number | null
  busy: boolean
  pendingWork: boolean
  pendingApproval: boolean
  typing: boolean
}

export interface AgentSweepSourceWatermarks {
  googleMail: string | null
  googleCalendar: string | null
  atumChats: string | null
  conversation: string | null
  memory: string | null
}

interface AgentSweepClaimedCommon {
  decision: 'claimed'
  occurrenceId: string
  occurrenceAt: number
  expiresAt: number
  settingsRevision: number
  ownerTimeZone: string
  /** `/1.1` adds the effective cadence after warm-up scaling; `/1` has only the baseline. */
  policy: { sourceIntervalMs: number; effectiveSourceIntervalMs?: number }
  sourceWatermarks: AgentSweepSourceWatermarks
}

export type AgentSweepClaimed =
  | (AgentSweepClaimedCommon & { profile: typeof AGENT_SWEEP_PROFILE })
  | (AgentSweepClaimedCommon & { profile: typeof AGENT_SWEEP_PROFILE_V11; effectiveDueAt: number
      occurrenceKind: 'followup_sweep' })
  | (AgentSweepClaimedCommon & { profile: typeof AGENT_SWEEP_PROFILE_V11; effectiveDueAt: number
      occurrenceKind: 'warmup_nudge'; warmupNudgeIndex: WarmupNudgeIndex })
  | Extract<AgentSweepClaimedResponseV2, { decision: 'claimed' }>

export interface AgentSweepDeferLegacy {
  profile: typeof AGENT_SWEEP_PROFILE | typeof AGENT_SWEEP_PROFILE_V11
  decision: 'defer'
  reason: string
  notBefore: number
}

export type AgentSweepDefer = AgentSweepDeferLegacy | AgentSweepDeferResponseV2
export type AgentSweepProfile =
  | typeof AGENT_SWEEP_PROFILE
  | typeof AGENT_SWEEP_PROFILE_V11
  | typeof AGENT_SWEEP_PROFILE_V2

export interface AgentSweepNativeAuthorization {
  kind: 'native'
  authorizationId: string
  expiresAt: number
  destination: {
    destination: string
    source: string
    model: string
    effort: 'low' | 'medium' | 'high'
  }
  protection:
    | { kind: 'standard' }
    | { kind: 'google_protected'; googlePolicy: 'limited_use_v1'; latchState: 'eligible' | 'latched' }
  attribution: { id: string; lane: 'atum_managed' | 'connected_provider' }
  limits: {
    /** A warm-up nudge receives the funded 1,800-second turn slice; a normal sweep keeps 120. */
    activeComputeSeconds: 120 | 1_800
    calls: 1
    inputTokens: 8_000
    outputTokens: 1_000
    maxModelMicroProtons: number | null
  }
}

export type AgentSweepDispatch =
  | AgentSweepDefer
  | {
      profile: typeof AGENT_SWEEP_PROFILE
      decision: 'dispatched'
      occurrenceId: string
      expiresAt: number
      settingsRevision: number
      authorization: AgentSweepNativeAuthorization | { kind: 'cloud' }
    }
  | AgentSweepDispatchResponseV2
  | {
      profile: typeof AGENT_SWEEP_PROFILE_V11
      decision: 'dispatched'
      occurrenceId: string
      occurrenceKind: 'followup_sweep' | 'warmup_nudge'
      warmupNudgeIndex: WarmupNudgeIndex | null
      expiresAt: number
      settingsRevision: number
      authorization: AgentSweepNativeAuthorization | { kind: 'cloud' }
    }

export interface LegacyFollowupSweepSnapshot {
  profile: 'atum.followup-sweep-evidence/1'
  capturedAt: number
  ownerTimeZone: string
  watermarks: AgentSweepSourceWatermarks
  sources: Array<{ source: string; status: FollowupSweepSourceStatus }>
  entries: Array<{ fresh: boolean }>
  digest: string
}

export type FollowupSweepSnapshot = LegacyFollowupSweepSnapshot | AgentSourceSweepSnapshot

export type FollowupSweepResult =
  | { profile: typeof FOLLOWUP_SWEEP_RESULT_PROFILE; decision: 'silent' }
  | {
      profile: typeof FOLLOWUP_SWEEP_RESULT_PROFILE
      decision: 'offer'
      evidenceIds: string[]
      urgency: 'normal' | 'harm_before_morning'
      text: string
    }

export interface AgentSweepUsage {
  computeSeconds: number
  modelAttempts: 0 | 1
  inputTokens: number
  outputTokens: number
  modelMicroProtons: number
}

export type AgentSweepReleaseReason = 'invalid_result' | 'ambiguous_submission' | 'unusable_claim'

/** The platform's answer to a nudge claim released unconsumed. A retire is terminal. */
export type AgentSweepRelease =
  | {
      profile: typeof AGENT_SWEEP_PROFILE_V11
      decision: 'released'
      occurrenceId: string
      occurrenceKind: 'warmup_nudge'
      warmupNudgeIndex: WarmupNudgeIndex
      releaseCount: 1 | 2
      retryAt: number
    }
  | {
      profile: typeof AGENT_SWEEP_PROFILE_V11
      decision: 'retired'
      occurrenceId: string
      occurrenceKind: 'warmup_nudge'
      warmupNudgeIndex: WarmupNudgeIndex
      releaseCount: 2
      outcome: 'uncertain'
      disposition: 'none'
      receiptId: string
      settingsRevision: number
      nextDueAt: number
      publication: { state: 'none' }
    }
  | AgentSweepReleaseResponseV2

export interface BackgroundSweepCandidate {
  agentPrincipal: string
  assistantId: string
  roomId: string
  /** Owner scope for the one quiet suggestion and its day note; never a credential. */
  ownerPrincipal: string
}

export interface BackgroundSweepLease {
  leaseToken: string
  held(): boolean
  release(): void
}

/** Rollout eligibility and the setting revision that owns it. */
export interface BackgroundSweepEligibility {
  active: boolean
  /** Any setting change (rollout or the per-agent switch) invalidates the local deadline cache. */
  revision?: number
}

export interface BackgroundSweepRunGuard {
  release(): void
}

export interface BackgroundSweepClassifierAnswer {
  value: unknown
  usage: AgentSweepUsage
}

export interface MatrixBackgroundSweepDeps {
  candidates(): readonly BackgroundSweepCandidate[]
  /** Platform rollout plus an active local placement; false preserves the legacy nudge path. */
  probe?(candidate: BackgroundSweepCandidate): Promise<BackgroundSweepEligibility>
  activity(candidate: BackgroundSweepCandidate): Promise<AgentSweepActivity | null>
  hold(candidate: BackgroundSweepCandidate): Promise<BackgroundSweepLease | null>
  acquire(
    candidate: BackgroundSweepCandidate,
    occurrenceId: string,
    signal: AbortSignal
  ): Promise<BackgroundSweepRunGuard | null>
  /** `/2` is selected only after private source discovery succeeds. */
  negotiate?(candidate: BackgroundSweepCandidate, signal: AbortSignal): Promise<AgentSweepProfile>
  claim(
    candidate: BackgroundSweepCandidate,
    lease: BackgroundSweepLease,
    request: {
      profile: AgentSweepProfile
      operation: 'claim'
      requestId: string
      leaseToken: string
      activity: AgentSweepActivity
    },
    signal: AbortSignal
  ): Promise<AgentSweepClaimed | AgentSweepDefer>
  dispatch(
    candidate: BackgroundSweepCandidate,
    lease: BackgroundSweepLease,
    request: {
      profile: AgentSweepProfile
      operation: 'dispatch'
      occurrenceId: string
      leaseToken: string
      activity: AgentSweepActivity
    },
    signal: AbortSignal
  ): Promise<AgentSweepDispatch>
  collect(
    candidate: BackgroundSweepCandidate,
    claimed: AgentSweepClaimed,
    signal: AbortSignal
  ): Promise<FollowupSweepSnapshot>
  needsModel(snapshot: FollowupSweepSnapshot, nudgeIndex?: WarmupNudgeIndex): boolean
  /** Host policy: no fresh finding, the owner-local suggestion window is open, and the owner is known. */
  suggestion(snapshot: FollowupSweepSnapshot): boolean
  prompt(snapshot: FollowupSweepSnapshot, nudgeIndex?: WarmupNudgeIndex, mode?: FollowupSweepMode,
    previousSuggestion?: string): string
  classify(
    candidate: BackgroundSweepCandidate,
    authorization: AgentSweepNativeAuthorization,
    prompt: string,
    signal: AbortSignal
  ): Promise<BackgroundSweepClassifierAnswer>
  validate(
    value: unknown,
    snapshot: FollowupSweepSnapshot,
    nudgeIndex?: WarmupNudgeIndex,
    mode?: FollowupSweepMode,
    ownerPrincipal?: string
  ): { result: FollowupSweepResult; findingHashes: string[] } | Promise<{ result: FollowupSweepResult; findingHashes: string[] }>
  fingerprint(result: FollowupSweepResult): Promise<string>
  stagePublication(
    candidate: BackgroundSweepCandidate,
    occurrenceId: string,
    text: string,
    google: boolean,
    signal: AbortSignal
  ): Promise<{ outboxId: string; bodySha256: string }>
  /** Owner-scoped, day-bounded suggestion note; absent only on an older host. */
  suggestions?: BackgroundSweepSuggestionStore
  release(
    input: {
      candidate: BackgroundSweepCandidate
      lease: BackgroundSweepLease
      profile: Exclude<AgentSweepProfile, typeof AGENT_SWEEP_PROFILE>
      occurrenceId: string
      reason: AgentSweepReleaseReason
      usage?: AgentSweepUsage
    },
    signal: AbortSignal
  ): Promise<AgentSweepRelease>
  settle(
    input: {
      candidate: BackgroundSweepCandidate
      lease: BackgroundSweepLease
      profile: AgentSweepProfile
      occurrenceId: string
      resultFingerprint: string
      usage: AgentSweepUsage
      snapshot: FollowupSweepSnapshot
      ownerEventWatermark: AgentSweepOwnerEvent | null
      outcome: 'answered' | 'failed' | 'stopped' | 'uncertain'
      disposition: 'silent' | 'offer' | 'none'
      urgency?: 'normal' | 'harm_before_morning'
      findingHashes: string[]
      outbox: { outboxId: string; bodySha256: string } | null
    },
    signal: AbortSignal
  ): Promise<{ publication: { state: 'none' | 'suppressed' | 'admitted' } }>
  now?(): number
  log(line: string): void
}

type BackgroundSweepSettlementInput = Parameters<MatrixBackgroundSweepDeps['settle']>[0]

const ZERO_USAGE: AgentSweepUsage = {
  computeSeconds: 0,
  modelAttempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  modelMicroProtons: 0
}

const silent = (): FollowupSweepResult => ({ profile: FOLLOWUP_SWEEP_RESULT_PROFILE, decision: 'silent' })

/** A platform GET at most this often, independent of any sweep deadline. */
const ELIGIBILITY_REFRESH_MS = 10 * 60_000

function warmupIndex(value: AgentSweepClaimed | AgentSweepDispatch): WarmupNudgeIndex | undefined {
  return value.profile !== AGENT_SWEEP_PROFILE && value.decision !== 'defer' &&
    value.occurrenceKind === 'warmup_nudge'
    ? value.warmupNudgeIndex ?? undefined
    : undefined
}

function v2Snapshot(value: FollowupSweepSnapshot): value is AgentSourceSweepSnapshot {
  return value.profile === 'atum.followup-sweep-evidence/2'
}

/** The traffic watermark is the newest owner event, even after the agent has answered it. */
export function backgroundSweepOwnerEvent(
  entries: readonly { eventId: string; role: 'user' | 'assistant' }[],
  at: number
): AgentSweepOwnerEvent | null {
  const owner = entries.find(entry => entry.role === 'user')

  return owner ? { eventId: owner.eventId, at } : null
}

/** Electron-main wake-up driver. Due state, enablement, caps and delivery stay platform-owned. */
export class MatrixBackgroundSweeps {
  // A failed run has no platform deadline, so the host retries on every beat.
  // Preserve those retries while reporting only transitions, never raw exception text.
  private readonly failures = new Map<string, string>()
  private readonly running = new Set<string>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly notBefore = new Map<string, number>()
  private readonly activeOwners = new Set<string>()
  private readonly lastProbeAt = new Map<string, number>()
  private readonly eligibilityRevision = new Map<string, number>()
  constructor(private readonly deps: MatrixBackgroundSweepDeps) {}

  activeForOwner(agentPrincipal: string): boolean {
    return this.activeOwners.has(agentPrincipal)
  }

  /** Rollout changes are noticed even while a platform deadline is still in the future. */
  private probeDue(agentPrincipal: string, now: number): boolean {
    return Boolean(this.deps.probe) &&
      now - (this.lastProbeAt.get(agentPrincipal) ?? 0) >= ELIGIBILITY_REFRESH_MS
  }

  tick(): void {
    const now = this.deps.now?.() ?? Date.now()

    for (const candidate of this.deps.candidates()) {
      const principal = candidate.agentPrincipal
      const due = (this.notBefore.get(principal) ?? 0) <= now

      if (this.running.has(principal) || (!due && !this.probeDue(principal, now))) {
        continue
      }

      this.running.add(principal)
      const abort = new AbortController()
      this.controllers.set(principal, abort)
      void this.run(candidate, abort, due)
        .then(() => { this.failures.delete(principal) })
        .catch(error => {
          if (abort.signal.aborted) {
            return
          }
          const reason = error instanceof Error && /^matrix_background_sweep_[a-z_]{1,64}$/u.test(error.message)
            ? error.message : 'matrix_background_sweep_unavailable'
          if (this.failures.get(principal) !== reason) {
            this.failures.set(principal, reason)
            this.deps.log(`[Matrix] background sweep unavailable agent=${principal.slice(0, 8)} reason=${reason}`)
          }
        })
        .finally(() => {
          this.running.delete(principal)
          if (this.controllers.get(principal) === abort) {
            this.controllers.delete(principal)
          }
        })
    }
  }

  stop(): void {
    for (const abort of this.controllers.values()) {
      abort.abort()
    }
    this.controllers.clear()
  }

  cancel(agentPrincipal: string): void {
    this.controllers.get(agentPrincipal)?.abort()
  }

  private defer(candidate: BackgroundSweepCandidate, response: AgentSweepDefer): void {
    this.notBefore.set(candidate.agentPrincipal, response.notBefore)

    if (response.reason === 'policy_off') {
      this.activeOwners.delete(candidate.agentPrincipal)
      // A cached deadline must not survive the rollout going away.
      this.notBefore.delete(candidate.agentPrincipal)
    }

    if (!['not_due', 'outside_window', 'judgment_backoff'].includes(response.reason)) {
      this.deps.log(
        `[Matrix] background sweep deferred agent=${candidate.agentPrincipal.slice(0, 8)} reason=${response.reason}`
      )
    }
  }

  private async run(candidate: BackgroundSweepCandidate, abort: AbortController, due: boolean): Promise<void> {
    abort.signal.throwIfAborted()
    const principal = candidate.agentPrincipal
    let ready = due

    if (this.deps.probe) {
      const now = this.deps.now?.() ?? Date.now()

      if (this.probeDue(principal, now)) {
        this.lastProbeAt.set(principal, now)
        let observed: BackgroundSweepEligibility

        try {
          observed = await this.deps.probe(candidate)
        } catch {
          // An older/unavailable platform or missing placement keeps the legacy fallback.
          return
        }

        abort.signal.throwIfAborted()
        const previousRevision = this.eligibilityRevision.get(principal)

        if (observed.revision !== undefined) {
          this.eligibilityRevision.set(principal, observed.revision)
        }

        const revisionChanged =
          observed.revision !== undefined && previousRevision !== undefined && observed.revision !== previousRevision

        if (!observed.active) {
          const wasActive = this.activeOwners.delete(principal)
          // A disabled or rolled-back owner is checked again as soon as it returns.
          if (wasActive) {
            this.notBefore.delete(principal)
          }
          return
        }

        const activated = !this.activeOwners.has(principal)
        this.activeOwners.add(principal)

        if (activated || revisionChanged) {
          // A re-enable is a fresh check, not the old two-hour deadline.
          this.notBefore.delete(principal)
          ready = true
        }
      }

      if (!this.activeOwners.has(principal)) {
        return
      }
    }

    if (!ready) {
      return
    }

    const activity = await this.deps.activity(candidate)

    if (!activity || activity.busy || activity.pendingWork || activity.pendingApproval || activity.typing) {
      return
    }

    const lease = await this.deps.hold(candidate)

    if (!lease) {
      return
    }

    let guard: BackgroundSweepRunGuard | null = null

    try {
      // A private source projection is the only positive signal that `/2` exists. A failed
      // negotiation stops this run; only an explicit absence may choose legacy 1.1.
      const negotiated = Boolean(this.deps.negotiate)
      const profile = this.deps.negotiate
        ? await this.deps.negotiate(candidate, abort.signal)
        : AGENT_SWEEP_PROFILE_V11
      const claimed = await this.deps.claim(
        candidate,
        lease,
        {
          profile,
          operation: 'claim',
          requestId: randomUUID(),
          leaseToken: lease.leaseToken,
          activity
        },
        abort.signal
      )
      this.activeOwners.add(candidate.agentPrincipal)

      if (negotiated && claimed.profile !== profile) {
        throw new Error('matrix_background_sweep_profile_mismatch')
      }

      if (claimed.decision === 'defer') {
        this.defer(candidate, claimed)
        return
      }

      if (!lease.held()) {
        return
      }

      const nudgeIndex = warmupIndex(claimed)

      // The platform schedules a nudge inside the owner's 08:00-21:00 window. If a time-zone or
      // clock change moves one outside it, publish nothing and let the server own the slot.
      if (nudgeIndex !== undefined && !followupSweepInsideNormalWindow(claimed.occurrenceAt, claimed.ownerTimeZone)) {
        this.deps.log(
          `[Matrix] background sweep skipped agent=${candidate.agentPrincipal.slice(0, 8)} reason=quiet_hours`
        )
        await this.releaseNudge(candidate, lease, claimed.profile, claimed.occurrenceId,
          'unusable_claim', undefined, abort.signal)
        return
      }

      guard = await this.deps.acquire(candidate, claimed.occurrenceId, abort.signal)

      if (!guard || !lease.held()) {
        return
      }

      let snapshot: FollowupSweepSnapshot

      try {
        snapshot = await this.deps.collect(candidate, claimed, abort.signal)
      } catch (error) {
        if (nudgeIndex !== undefined) {
          await this.releaseNudge(candidate, lease, claimed.profile, claimed.occurrenceId,
            'unusable_claim', undefined, abort.signal)
        }
        throw error
      }

      const currentActivity = await this.deps.activity(candidate)

      if (!currentActivity || !lease.held()) {
        if (nudgeIndex !== undefined && lease.held()) {
          await this.releaseNudge(candidate, lease, claimed.profile, claimed.occurrenceId,
            'unusable_claim', undefined, abort.signal)
        }
        return
      }

      let dispatched: AgentSweepDispatch

      try {
        dispatched = await this.deps.dispatch(
          candidate,
          lease,
          {
            profile: claimed.profile,
            operation: 'dispatch',
            occurrenceId: claimed.occurrenceId,
            leaseToken: lease.leaseToken,
            activity: currentActivity
          },
          abort.signal
        )
      } catch (error) {
        if (nudgeIndex !== undefined) {
          await this.releaseNudge(candidate, lease, claimed.profile, claimed.occurrenceId,
            'unusable_claim', undefined, abort.signal)
        }
        throw error
      }

      if (dispatched.decision === 'defer') {
        this.defer(candidate, dispatched)
        return
      }

      const dispatchedNudge = warmupIndex(dispatched)
      const v2SnapshotChanged = claimed.profile === AGENT_SWEEP_PROFILE_V2 &&
        dispatched.decision === 'dispatched' && dispatched.profile === AGENT_SWEEP_PROFILE_V2 &&
        (dispatched.sourceSnapshotDigest !== claimed.admittedSources.snapshotDigest ||
          dispatched.sourceSnapshotRevision !== claimed.admittedSources.snapshotRevision)
      if (dispatched.profile !== claimed.profile || dispatchedNudge !== nudgeIndex || v2SnapshotChanged) {
        if (nudgeIndex !== undefined) {
          await this.releaseNudge(candidate, lease, claimed.profile, claimed.occurrenceId,
            'unusable_claim', undefined, abort.signal)
        }
        throw new Error('matrix_background_sweep_authorization_invalid')
      }

      if (dispatched.authorization.kind !== 'native' || !lease.held()) {
        if (nudgeIndex !== undefined) {
          await this.releaseNudge(candidate, lease, claimed.profile, claimed.occurrenceId,
            'unusable_claim', undefined, abort.signal)
        }
        throw new Error('matrix_background_sweep_authorization_invalid')
      }

      await this.execute(candidate, lease, claimed, snapshot, currentActivity, dispatched.authorization, abort.signal,
        nudgeIndex)
    } finally {
      guard?.release()
      lease.release()
    }
  }

  /**
   * Return an unusable nudge claim instead of leaving the slot to expire. The platform retries the
   * same index after `retryAt` (honoured locally) and retires it terminally after the release
   * limit. Release never settles and never publishes, and a replay returns the same decision.
   */
  private async releaseNudge(
    candidate: BackgroundSweepCandidate,
    lease: BackgroundSweepLease,
    profile: AgentSweepProfile,
    occurrenceId: string,
    reason: AgentSweepReleaseReason,
    usage: AgentSweepUsage | undefined,
    signal: AbortSignal
  ): Promise<void> {
    const principal = candidate.agentPrincipal

    if (!lease.held() || profile === AGENT_SWEEP_PROFILE) {
      return
    }

    const releaseSignal = signal.aborted ? AbortSignal.timeout(20_000) : signal
    // One durable request object: a retry of a lost response replays exactly these bytes.
    const input = { candidate, lease, profile, occurrenceId, reason, ...(usage ? { usage } : {}) }
    const send = () => this.deps.release(input, releaseSignal)

    let response: AgentSweepRelease

    try {
      response = await send()
    } catch {
      if (releaseSignal.aborted) {
        return
      }
      try {
        response = await send()
      } catch {
        this.deps.log(`[Matrix] background sweep release pending agent=${principal.slice(0, 8)}`)
        return
      }
    }

    if (response.decision === 'retired') {
      // Terminal: uncertain/none, index advanced, nothing published.
      this.notBefore.set(principal, response.nextDueAt)
      this.deps.log(`[Matrix] background sweep retired agent=${principal.slice(0, 8)} index=${response.warmupNudgeIndex}`)
      return
    }

    this.notBefore.set(principal, response.retryAt)
    this.deps.log(`[Matrix] background sweep released agent=${principal.slice(0, 8)} reason=${reason}`)
  }

  private async execute(
    candidate: BackgroundSweepCandidate,
    lease: BackgroundSweepLease,
    claimed: AgentSweepClaimed,
    snapshot: FollowupSweepSnapshot,
    currentActivity: AgentSweepActivity,
    authorization: AgentSweepNativeAuthorization,
    signal: AbortSignal,
    nudgeIndex?: WarmupNudgeIndex
  ): Promise<void> {
    let usage = ZERO_USAGE
    let result = silent()
    let attempted = false
    const nudge = nudgeIndex !== undefined
    // A real finding always wins. Only when the sweep has none, the owner-local mid-day window is
    // open, and the owner is already known may it offer one grounded suggestion instead.
    const fresh = !nudge && this.deps.needsModel(snapshot, nudgeIndex)
    const history = !nudge && candidate.ownerPrincipal
      ? followupSweepSuggestionHistory(snapshot, candidate.ownerPrincipal,
        this.deps.suggestions?.read(candidate.ownerPrincipal) ?? null)
      : { offeredToday: false, previousText: null }
    const suggestion = !nudge && !fresh && currentActivity.lastOwnerEvent !== null &&
      !history.offeredToday && this.deps.suggestion(snapshot)
    const day = suggestion ? followupSweepLocalDay(snapshot.capturedAt, snapshot.ownerTimeZone) : null
    const mode: FollowupSweepMode = suggestion ? 'suggestion' : 'finding'
    const release = (reason: AgentSweepReleaseReason, releaseUsage?: AgentSweepUsage) =>
      this.releaseNudge(candidate, lease, claimed.profile as Exclude<AgentSweepProfile, typeof AGENT_SWEEP_PROFILE>,
        claimed.occurrenceId, reason, releaseUsage, signal)

    if (nudge || fresh || suggestion) {
      let answer: BackgroundSweepClassifierAnswer

      try {
        // A warm-up nudge always takes the deeper turn, even when no source is fresh: it builds on
        // memory and the first-run conversation. A normal sweep stays silent without a finding or
        // a quiet suggestion.
        const previous = history.previousText
        let prompt: string

        try {
          prompt = previous
            ? this.deps.prompt(snapshot, nudgeIndex, mode, previous)
            : this.deps.prompt(snapshot, nudgeIndex, mode)
        } catch (error) {
          // A fitted snapshot can be at the byte cap before yesterday's line is added; the prompt
          // itself stays useful without it, so drop only that optional sentence.
          if (!previous || !(error instanceof Error) ||
              error.message !== 'followup_sweep_prompt_too_large') {
            throw error
          }

          prompt = this.deps.prompt(snapshot, nudgeIndex, mode)
        }

        attempted = true
        answer = await this.deps.classify(candidate, authorization, prompt, signal)
      } catch {
        // An ambiguous submission cannot be settled as a nudge offer; release with the reserved
        // model attempt so the platform can retry the index. Nothing was published.
        if (nudge) {
          await release('ambiguous_submission', attempted ? { ...ZERO_USAGE, modelAttempts: 1 } : undefined)
          return
        }
        const ownerEventWatermark = (await this.deps.activity(candidate))?.lastOwnerEvent ?? null
        const settleSignal = signal.aborted ? AbortSignal.timeout(20_000) : signal
        await this.settle(
          {
            candidate,
            lease,
            profile: claimed.profile,
            occurrenceId: claimed.occurrenceId,
            resultFingerprint: failureFingerprint(claimed.occurrenceId, 'uncertain'),
            usage: attempted ? { ...ZERO_USAGE, modelAttempts: 1 } : ZERO_USAGE,
            snapshot,
            ownerEventWatermark,
            outcome: 'uncertain',
            disposition: 'none',
            findingHashes: [],
            outbox: null
          },
          settleSignal
        )
        return
      }

      usage = answer.usage
      result = (await this.deps.validate(answer.value, snapshot, nudgeIndex, mode, candidate.ownerPrincipal)).result
    }

    if (suggestion && day && result.decision === 'offer') {
      // Written before settlement: a crash or lost response must not spend a second model call
      // today. Admission is marked only when the platform actually settles the offer.
      this.deps.suggestions?.write({ owner: candidate.ownerPrincipal, date: day.date, text: result.text,
        at: this.deps.now?.() ?? Date.now(), admitted: false })
    }

    if (nudge && result.decision !== 'offer') {
      await release('invalid_result', usage)
      return
    }

    let outbox: { outboxId: string; bodySha256: string } | null = null

    if (result.decision === 'offer') {
      if (!lease.held()) {
        if (nudge) {
          await release('unusable_claim', usage)
          return
        }
        result = silent()
      } else {
        const ownerEvent = (await this.deps.activity(candidate))?.lastOwnerEvent

        // A brand-new owner may not have an owner event yet; a nudge still publishes one message.
        if (!ownerEvent && !nudge) {
          result = silent()
        } else {
          try {
            outbox = await this.deps.stagePublication(
              candidate,
              claimed.occurrenceId,
              result.text,
              authorization.protection.kind === 'google_protected' ||
                v2Snapshot(snapshot) && agentSourceSnapshotHasTag(snapshot, 'google-derived'),
              signal
            )
          } catch {
            if (nudge) {
              await release('unusable_claim', usage)
              return
            }
            const ownerEventWatermark = (await this.deps.activity(candidate))?.lastOwnerEvent ?? null
            const settleSignal = signal.aborted ? AbortSignal.timeout(20_000) : signal
            await this.settle({
              candidate,
              lease,
              profile: claimed.profile,
              occurrenceId: claimed.occurrenceId,
              resultFingerprint: failureFingerprint(claimed.occurrenceId, 'publication_uncertain'),
              usage,
              snapshot,
              ownerEventWatermark,
              outcome: 'uncertain',
              disposition: 'none',
              findingHashes: [],
              outbox: null
            }, settleSignal)
            return
          }
        }
      }
    }

    if (nudge && (result.decision !== 'offer' || !outbox)) {
      await release('unusable_claim', usage)
      return
    }
    const admitted = await this.deps.validate(result, snapshot, nudgeIndex, mode, candidate.ownerPrincipal)
    const ownerEventWatermark = (await this.deps.activity(candidate))?.lastOwnerEvent ?? null

    const settleSignal = signal.aborted ? AbortSignal.timeout(20_000) : signal
    const settled = await this.settle(
      {
        candidate,
        lease,
        profile: claimed.profile,
        occurrenceId: claimed.occurrenceId,
        resultFingerprint: await this.deps.fingerprint(result),
        usage,
        snapshot,
        ownerEventWatermark,
        outcome: 'answered',
        disposition: result.decision,
        ...(result.decision === 'offer' ? { urgency: result.urgency } : {}),
        findingHashes: result.decision === 'offer' ? admitted.findingHashes : [],
        outbox: result.decision === 'offer' ? outbox : null
      },
      settleSignal
    )

    if (suggestion && day && result.decision === 'offer' && settled.publication.state === 'admitted') {
      this.deps.suggestions?.admit(candidate.ownerPrincipal, day.date)
    }
  }

  /** A transport failure may follow a committed settle; replay the exact idempotent request once. */
  private async settle(input: BackgroundSweepSettlementInput, signal: AbortSignal) {
    try {
      return await this.deps.settle(input, signal)
    } catch {
      signal.throwIfAborted()
      return this.deps.settle(input, signal)
    }
  }
}

function failureFingerprint(occurrenceId: string, outcome: string): string {
  return createHash('sha256').update(`atum agent sweep ${occurrenceId} ${outcome}`).digest('hex')
}
