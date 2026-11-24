/**
 * The renderer's input for the session-handoff relay (relay slice R1, lane U1): plain mirrors of the fields of
 * `atum.work-route/1.3` the owner's screens read. The contract's strict readers stay in the gate (main) and the cloud; the
 * coordinator parses there and hands the renderer these shapes. Nothing here carries text, a token, a login or a cost.
 *
 * Source of truth: atum-platform `spec/work-route/v1.3/README.md` and `packages/protocol/src/work-relay.ts`.
 */

export interface WorkRelayRoomView {
  account: { consent: WorkRelayConsent; facts: readonly WorkRelayFact[] }
  status: WorkRelayStatus | null
  turns: { eventId: string; plan?: WorkRelayPlan; sentAt: number; receipt: WorkRelayReceipt }[]
}

/** Plan IDs shared by the Work route and renderer. */
export const WORK_RELAY_PLANS = ['codex', 'claude', 'antigravity'] as const
export type WorkRelayPlan = (typeof WORK_RELAY_PLANS)[number]
export const WORK_RELAY_ENABLED_PLANS = WORK_RELAY_PLANS
/** Wire plan IDs map only to these built-in native instances. */
export const WORK_RELAY_PROVIDER = {
  codex: { instanceId: 'atum-relay-codex', picker: 'openai-codex', notice: 'chatgpt', usage: true, mode: {} },
  claude: { instanceId: 'claudeAgent', picker: 'claude-plan', notice: 'claude', usage: true, mode: {} },
  antigravity: { instanceId: 'antigravity', picker: 'antigravity', notice: 'antigravity', usage: false,
    mode: { 'auto-accept-edits': 'approval-required' } }
} as const satisfies Record<WorkRelayPlan, {
  instanceId: string
  picker: string
  notice: string
  usage: boolean
  mode: Partial<Record<string, string>>
}>

export function workRelayPlan(instanceId: string): WorkRelayPlan | undefined {
  return WORK_RELAY_PLANS.find(plan => WORK_RELAY_PROVIDER[plan].instanceId === instanceId)
}

export function workRelayNoticePlan(notice: string | undefined): WorkRelayPlan | undefined {
  return WORK_RELAY_PLANS.find(plan => WORK_RELAY_PROVIDER[plan].notice === notice)
}

export function workRelayModeLimit(plan: WorkRelayPlan, modeLimit: string): string {
  const [runtime, interaction] = modeLimit.split('/')
  const modes: Partial<Record<string, string>> = WORK_RELAY_PROVIDER[plan].mode

  return `${modes[runtime] ?? runtime}/${interaction}`
}

/** `status.selection`: the agent's revisioned model selection. Null when the agent is on an Atum model. */
export interface WorkRelaySelection {
  provider: 'atum-work'
  plan: WorkRelayPlan
  model: string
  revision: number
}

export type WorkRelayPhase = 'admitted' | 'running' | 'held' | 'answered' | 'stopped' | 'failed' | 'empty' | 'cut'
export type WorkRelayHold = 'waiting_for_mac' | 'approval' | 'question' | 'question_invalid' | 'plan_limit' | 'stop_pending'

/** `status.openOperation`: the one open relay operation of this conversation, if any. */
export interface WorkRelayOperation {
  requestId: string
  plan?: WorkRelayPlan
  eventId: string
  roomId: string
  resetEpoch: number
  phase: WorkRelayPhase
  forwarded: boolean
  threadId: string
  runId?: string
  hold?: WorkRelayHold
  stopOwed: boolean
}

/** `status.limits[]`. `unknown` is neither exhausted nor unlimited. Times are ms since the epoch. */
export interface WorkRelayLimit {
  plan: WorkRelayPlan
  state: 'available' | 'exhausted' | 'unknown'
  observedAt: number
  resetsAt?: number
  usedPercent?: number
  scheduledRuns?: number
}

/** The account's scoped consent for one plan (the 1.2 record; `provider` names the plan). Default off. */
export interface WorkRelayConsent {
  provider: WorkRelayPlan
  state: 'on' | 'off'
  /** Assistant principals named. */
  agents: readonly string[]
  /** Mac (device-service) ids named. */
  devices: readonly string[]
  alsoWhenScheduled: boolean
  revision: number
  grantedAt?: number
  revokedAt?: number
}

/** One Mac's plan fact (`work_subscription_read`). `stale` is the last known state of a Mac that has not reported lately. */
export interface WorkRelayFact {
  deviceServiceId: string
  provider: WorkRelayPlan
  status: 'connected' | 'disconnected' | 'stale'
  observedAt?: number
  models?: readonly string[]
  displayName?: string
}

/** `status` for one room on one Mac's gate, as 1.3 returns it. */
export interface WorkRelayStatus {
  scheduledUsage?: { runs: number; windowStart: number; resetsAt?: number }
  selection: WorkRelaySelection | null
  openOperation: WorkRelayOperation | null
  limits: readonly WorkRelayLimit[]
  consent: WorkRelayConsent
  /** The plan is connected on this Mac (T3's own provider status). */
  connected: boolean
  /** "Agents may use my ChatGPT plan here" on this Mac. */
  localSwitch: boolean
}

/** The receipt classes of 1.3. Only the fields the screens read are kept. */
export type WorkRelayReceipt =
  | { class: 'closed' }
  | { class: 'none' }
  | { class: 'pending'; operation: WorkRelayOperation }
  | { class: 'accepted'; operation: WorkRelayOperation }
  | { class: 'refused'; receipt: 'refused' | 'rejected' | 'void'; reason: string }
  | { class: 'ambiguous'; forwarded: boolean; reason: string }
  | { class: 'revoked'; stopConfirmed: boolean }
  | { class: 'completed'; answer: { finishedAt: number } }
  | { class: 'terminal'; receipt: 'empty' | 'failed' | 'stopped' | 'cut'; finishedAt: number; stopConfirmed: boolean; reason?: string }

/**
 * Why the Atum model answered a turn the owner meant for the plan, before anything was sent (O4). The cloud knows the reason (a
 * failed preflight has no receipt), so it travels with the reply's presentation notice. See `workRelayFallbackReason` for the
 * codes it may arrive as.
 */
export type WorkRelayFallbackReason = 'mac_off' | 'consent_off' | 'switch_off' | 'limit' | 'other'

/**
 * The one line a turn shows, and where. `message`: under the owner's own message (held, stopped, or ended with no answer). `reply`: under
 * the answer (the Atum fallback, a late answer). `none`: answered on the plan, or nothing to say.
 */
export type WorkRelayTurnChrome =
  | { kind: 'none' }
  | { kind: 'fallback'; at: 'reply'; reason: WorkRelayFallbackReason }
  | { kind: 'waiting'; at: 'message'; action: 'stop'; waitingForAnswer?: true; invalidAnswer?: true }
  | { kind: 'needs_ok'; at: 'message'; action: 'open_work' | 'stop' }
  | { kind: 'limit'; at: 'message'; action: 'stop'; resetsAt?: number }
  | { kind: 'stopping'; at: 'message' }
  | { kind: 'stopped'; at: 'message' }
  | { kind: 'queued'; at: 'message' }
  | { kind: 'late'; at: 'reply'; finishedAt: number }
  | { kind: 'empty'; at: 'message' }
  | { kind: 'failed'; at: 'message' }
