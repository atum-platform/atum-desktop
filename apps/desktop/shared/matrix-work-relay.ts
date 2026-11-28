/** Plans available to the cloud relay. Copilot and Kiro are interactive Work only. */
export const WORK_RELAY_PLANS = ['codex', 'claude', 'antigravity'] as const
export type WorkRelayPlan = (typeof WORK_RELAY_PLANS)[number]
export const WORK_RELAY_PROVIDER = {
  codex: { picker: 'openai-codex', notice: 'chatgpt' },
  claude: { picker: 'claude-plan', notice: 'claude' },
  antigravity: { picker: 'antigravity', notice: 'antigravity' }
} as const

export function workRelayNoticePlan(notice: string | undefined): WorkRelayPlan | undefined {
  return WORK_RELAY_PLANS.find(plan => WORK_RELAY_PROVIDER[plan].notice === notice)
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
