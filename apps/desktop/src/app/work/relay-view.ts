/**
 * The session-handoff relay's owner chrome, as data (relay slice R1, lane U1; plan 2026-11-22 §3.1, §3.4, §3.6, §6, O4, O12–O14).
 *
 * Pure functions from the 1.3 status fields `{selection, openOperation, limits, consent, connected, localSwitch}`, the account's plan
 * facts and the receipt classes to what the owner sees: whether a plan model can be picked, the one line (and at most one action)
 * on a message, the composer chip's warning, the plan usage line and the shared-context line. No copy here: `relay-copy.ts` words
 * each state. Status is UI chrome, never an agent message.
 */

import {
  WORK_RELAY_ENABLED_PLANS,
  type WorkRelayConsent,
  type WorkRelayFact,
  type WorkRelayFallbackReason,
  type WorkRelayLimit,
  type WorkRelayOperation,
  type WorkRelayPlan,
  type WorkRelayReceipt,
  type WorkRelaySelection,
  type WorkRelayTurnChrome
} from '../../../shared/matrix-work-relay'

/** The UI wait for a plan turn (plan §3.6, proposed): after it, a running turn reads "Waiting for your Mac". It changes chrome only. */
export const WORK_RELAY_UI_WAIT_MS = 10 * 60_000

// ---------------------------------------------------------------------------------------------------------------------------------
// The picker (§3.1, O1, O4, O9)

/** Why a plan's rows are greyed. Only `connect` and `allow` have a fixing action in R1. */
export type WorkRelayGreyed = 'connect' | 'allow' | 'google' | 'encrypted'
export type WorkRelayFix = 'connect' | 'allow'

export interface WorkRelayPickerInput {
  plan: WorkRelayPlan
  /** The assistant whose picker this is. */
  agentPrincipal: string
  /** The account's consent and every Mac's plan fact. Undefined while not read yet: nothing is drawn, so nothing flaps. */
  account?: { consent: WorkRelayConsent; facts: readonly WorkRelayFact[] }
  /** The agent's current selection (`status.selection` or the 1.3 sync's). */
  selection: WorkRelaySelection | null
  /** O1 test scope: an assistant that holds Google keeps the plan rows greyed. */
  holdsGoogle?: boolean
  /** O9: an end-to-end encrypted conversation cannot use a plan model. */
  encrypted?: boolean
  /** The plan's reported limit, when known. */
  limit?: WorkRelayLimit
  /** The chrome of the agent's latest turn here, for the composer chip. */
  lastTurn?: WorkRelayTurnChrome
}

/** The composer chip's red warning (owner rule 11-11), only while the selection names this plan. Never for a held run. */
export type WorkRelayChip =
  | { kind: 'greyed'; greyed: WorkRelayGreyed }
  | { kind: 'limit'; resetsAt?: number }
  | { kind: 'fallback'; reason: WorkRelayFallbackReason }

export interface WorkRelayPickerView {
  plan: WorkRelayPlan
  /** `hidden`: not this release's plan, or not read yet. */
  rows: 'hidden' | 'selectable' | 'greyed'
  greyed?: WorkRelayGreyed
  /** The one action that fixes `greyed`, when one exists. */
  fix?: WorkRelayFix
  /** The selected model of this plan, if the selection names it. */
  currentModel?: string
  chip?: WorkRelayChip
}

/** A Mac whose plan is connected, as far as the account knows. An asleep or offline Mac (a stale fact) still counts (RT4). */
function planMacs(plan: WorkRelayPlan, facts: readonly WorkRelayFact[]): string[] {
  return facts.filter(fact => fact.provider === plan && fact.status !== 'disconnected').map(fact => fact.deviceServiceId)
}

/**
 * Whether a plan's models can be picked for this assistant. Greyed ONLY when no Mac has the plan connected and consented for it
 * (plus the O1 and O9 scopes); a Mac that is merely asleep or offline never greys it: that turn falls back before dispatch.
 */
export function workRelayPickerView(input: WorkRelayPickerInput): WorkRelayPickerView {
  const { plan } = input
  const currentModel = input.selection?.plan === plan ? input.selection.model : undefined
  const base: WorkRelayPickerView = { plan, rows: 'hidden', ...(currentModel ? { currentModel } : {}) }

  if (!WORK_RELAY_ENABLED_PLANS.includes(plan) || !input.account) {
    return base
  }

  const greyed: WorkRelayGreyed | undefined = input.encrypted
    ? 'encrypted'
    : input.holdsGoogle
      ? 'google'
      : (() => {
          const macs = planMacs(plan, input.account.facts)

          if (macs.length === 0) {
            return 'connect'
          }

          return undefined
        })()

  const view: WorkRelayPickerView = greyed
    ? { ...base, rows: 'greyed', greyed, ...(greyed === 'connect' ? { fix: greyed } : {}) }
    : { ...base, rows: 'selectable' }

  const chip = currentModel ? workRelayChip(greyed, input.limit, input.lastTurn) : undefined

  return chip ? { ...view, chip } : view
}

function workRelayChip(
  greyed: WorkRelayGreyed | undefined,
  limit: WorkRelayLimit | undefined,
  lastTurn: WorkRelayTurnChrome | undefined
): WorkRelayChip | undefined {
  if (greyed) {
    return { kind: 'greyed', greyed }
  }

  if (limit?.state === 'exhausted') {
    return { kind: 'limit', ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}) }
  }

  return lastTurn?.kind === 'fallback' ? { kind: 'fallback', reason: lastTurn.reason } : undefined
}

// ---------------------------------------------------------------------------------------------------------------------------------
// One turn's line (§3.4 outcomes, §3.6 held, stop and late, O4, O12, O13)

export type { WorkRelayTurnChrome } from '../../../shared/matrix-work-relay'

export type WorkRelayTurnKind = WorkRelayTurnChrome['kind']

export interface WorkRelayTurnInput {
  /** `status.openOperation`, when it is this message's (`eventId` matches). */
  operation?: WorkRelayOperation | null
  /** This message's latest receipt, when read. */
  receipt?: WorkRelayReceipt
  /** The Atum model answered before dispatch, and why (from the reply's presentation notice or a non-dispatch receipt). */
  fallback?: WorkRelayFallbackReason
  /** This message waits in the queue behind an open operation. */
  queued?: boolean
  /** When the owner sent it (ms). Decides whether an answer is late. */
  sentAt?: number
  /** Now (ms), for the UI wait. */
  now?: number
  /** The plan's limit, for the reset time of a held run. */
  limit?: WorkRelayLimit
  /** The owner is on the Mac the run is bound to, so the OK can be given right here. */
  onBoundMac?: boolean
}

const NONE: WorkRelayTurnChrome = { kind: 'none' }

/**
 * Map a fallback code to the owner's short reason. Accepts the relay's own codes, the gate's 1.2/1.3 refusal reasons and the
 * agent-turns/1.7 fallback reasons; anything else is `other`. A stale snapshot is not "consent off": it reads as `other`.
 */
export function workRelayFallbackReason(code: string): WorkRelayFallbackReason {
  switch (code) {
    case 'mac_off':

    case 'mac_offline':

    case 'offline':

    case 'unreachable':

    case 'timeout':
      return 'mac_off'

    case 'consent_off':

    case 'plan_consent_off':
      return 'consent_off'

    case 'switch_off':

    case 'plan_switch_off':
      return 'switch_off'

    case 'limit':

    case 'plan_limit':

    case 'rate_limited':

    case 'exhausted':
      return 'limit'

    default:
      return 'other'
  }
}

function operationChrome(operation: WorkRelayOperation, input: WorkRelayTurnInput): WorkRelayTurnChrome {
  if (operation.stopOwed || operation.hold === 'stop_pending') {
    return { kind: 'stopping', at: 'message' }
  }

  switch (operation.phase) {
    case 'held':
      if (operation.hold === 'question' || operation.hold === 'question_invalid') {
        return { kind: 'waiting', at: 'message', action: 'stop', waitingForAnswer: true,
          ...(operation.hold === 'question_invalid' ? { invalidAnswer: true } : {}) }
      }

      if (operation.hold === 'approval') {
        return { kind: 'needs_ok', at: 'message', action: input.onBoundMac ? 'open_work' : 'stop' }
      }

      if (operation.hold === 'plan_limit') {
        const resetsAt = input.limit?.state === 'exhausted' ? input.limit.resetsAt : undefined

        return { kind: 'limit', at: 'message', action: 'stop', ...(resetsAt !== undefined ? { resetsAt } : {}) }
      }

      return { kind: 'waiting', at: 'message', action: 'stop' }

    case 'admitted':

    case 'running':
      // Working normally: the assistant's own typing state says so. After the UI wait, one line and Stop.
      return input.sentAt !== undefined && input.now !== undefined && input.now - input.sentAt >= WORK_RELAY_UI_WAIT_MS
        ? { kind: 'waiting', at: 'message', action: 'stop' }
        : NONE

    case 'answered':
      return NONE

    case 'stopped':

    case 'cut':
      return { kind: 'stopped', at: 'message' }

    case 'failed':
      return { kind: 'failed', at: 'message' }

    case 'empty':
      return { kind: 'empty', at: 'message' }
  }
}

function receiptChrome(receipt: WorkRelayReceipt, input: WorkRelayTurnInput): WorkRelayTurnChrome | undefined {
  switch (receipt.class) {
    case 'closed':

    case 'none':
      return undefined

    case 'pending':

    case 'accepted':
      return operationChrome(receipt.operation, input)

    // Proven never forwarded: the Atum model answered, and says why.
    case 'refused':
      return { kind: 'fallback', at: 'reply', reason: workRelayFallbackReason(receipt.reason) }

    // Hold, never fall back.
    case 'ambiguous':
      return { kind: 'waiting', at: 'message', action: 'stop' }

    case 'revoked':
      return receipt.stopConfirmed ? { kind: 'stopped', at: 'message' } : { kind: 'stopping', at: 'message' }

    case 'completed':
      return input.sentAt !== undefined && receipt.answer.finishedAt - input.sentAt >= WORK_RELAY_UI_WAIT_MS
        ? { kind: 'late', at: 'reply', finishedAt: receipt.answer.finishedAt }
        : NONE

    case 'terminal':
      if (receipt.receipt === 'empty') {
        return { kind: 'empty', at: 'message' }
      }

      if (receipt.receipt === 'failed') {
        return { kind: 'failed', at: 'message' }
      }

      return receipt.stopConfirmed ? { kind: 'stopped', at: 'message' } : { kind: 'stopping', at: 'message' }
  }
}

/** One turn's chrome. The order is the safety order: a real fallback, then the queue, then the receipt, then the open operation. */
export function workRelayTurnChrome(input: WorkRelayTurnInput): WorkRelayTurnChrome {
  if (input.fallback) {
    return { kind: 'fallback', at: 'reply', reason: input.fallback }
  }

  if (input.queued) {
    return { kind: 'queued', at: 'message' }
  }

  const fromReceipt = input.receipt ? receiptChrome(input.receipt, input) : undefined

  if (fromReceipt) {
    return fromReceipt
  }

  return input.operation ? operationChrome(input.operation, input) : NONE
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The plan usage line (§3.10, §6): shown, never blocking; never a cost or a balance.

export type WorkRelayUsage =
  | { kind: 'used'; percent: number; resetsAt?: number }
  | { kind: 'limit'; resetsAt?: number }
  | { kind: 'unknown' }

export function workRelayUsage(limit: WorkRelayLimit | undefined): WorkRelayUsage {
  if (!limit || limit.state === 'unknown') {
    return { kind: 'unknown' }
  }

  const resets = limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}

  if (limit.state === 'exhausted') {
    return { kind: 'limit', ...resets }
  }

  return limit.usedPercent === undefined
    ? { kind: 'unknown' }
    : { kind: 'used', percent: Math.round(Math.min(100, Math.max(0, limit.usedPercent))), ...resets }
}

/** The plan's own row in `status.limits`, if the gate reported one. */
export function workRelayLimitFor(limits: readonly WorkRelayLimit[], plan: WorkRelayPlan): WorkRelayLimit | undefined {
  return limits.find(limit => limit.plan === plan)
}

// ---------------------------------------------------------------------------------------------------------------------------------
// O14: the shared-context line in Work

/**
 * The assistants whose chat runs in a thread on this Mac, in the order given, deduplicated. Empty: no line. What the owner types
 * there can show up in those assistants' answers in the chat, so Work says so, once, in one line.
 */
export function workRelaySharedContext(principals: readonly string[]): string[] {
  return [...new Set(principals)]
}
