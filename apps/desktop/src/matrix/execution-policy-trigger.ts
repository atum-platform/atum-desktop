import { AGENT_HOMES_CLOUD_ONLY } from '../../shared/agent-home-cloud-only'
import type { ExecutionDestinationView, MatrixExecutionPolicyView } from '../../shared/execution-policy'
import { executionDestinationViews } from '../../shared/execution-policy'

import { executionMachineName } from './execution-machines-copy'
import { executionPolicyEditorCopy } from './execution-policy-editor-copy'

/** The one destination the closed title-bar trigger speaks for, or why it has none to name yet. */
export type ExecutionPolicyTrigger =
  | { kind: 'destination'; destination: ExecutionDestinationView; tooltip: string }
  | { kind: 'paused'; tooltip: string }
  | { kind: 'loading'; tooltip: string }

/** A destination that can actually take a turn now: not offline, turned off, or needing attention. */
function reachable(destination: ExecutionDestinationView): boolean {
  return destination.state !== 'offline' && destination.state !== 'disabled' && destination.state !== 'degraded'
}

/** Whether the assistant can answer anywhere, for surfaces that must not read one Mac's runtime
 * for an agent another destination answers: `unknown` is no fact (a stale cache, no status yet),
 * never "down". */
export type ExecutionPolicyAvailability = 'answering' | 'paused' | 'unavailable' | 'unknown'

/**
 * The roster dot's read of where an assistant answers (2026-10-20): a cloud-answering agent is
 * green while any enabled destination can take its turn, and grey only when the owner paused
 * every destination or none of them is reachable. It is the same status the trigger paints, so
 * the dot and the title bar never disagree.
 */
export function executionPolicyAvailability(view: MatrixExecutionPolicyView | undefined): ExecutionPolicyAvailability {
  if (!view || view.stale || !view.status) {
    return 'unknown'
  }

  if (view.status.state === 'paused' || view.policy.order.every(id => view.policy.disabled.includes(id))) {
    return 'paused'
  }

  return executionDestinationViews(view.status).some(destination => destination.enabled && reachable(destination))
    ? 'answering'
    : 'unavailable'
}

/** Local/cloud placement follows the saved execution policy and current lease. */
export function executionPolicyOffersChoice(
  view: Pick<MatrixExecutionPolicyView, 'policy'>,
  cloudOnly: boolean = AGENT_HOMES_CLOUD_ONLY
): boolean {
  return !cloudOnly && view.policy.order.filter(id => id !== 'cloud').length > 1
}

/** Local/cloud placement follows the saved execution policy and current lease. */
export function executionPolicyTrigger(locale: string, view: MatrixExecutionPolicyView): ExecutionPolicyTrigger {
  const copy = executionPolicyEditorCopy(locale)

  if (view.stale || !view.status) {
    return { kind: 'loading', tooltip: copy.title }
  }

  if (view.policy.order.every(id => view.policy.disabled.includes(id))) {
    return { kind: 'paused', tooltip: copy.paused }
  }

  const destinations = executionDestinationViews(view.status)
  const answering = destinations.find(destination => destination.current)

  const chosen =
    answering ??
    destinations.find(destination => destination.desired) ??
    destinations.find(destination => destination.enabled && reachable(destination))

  // The policy has an enabled row and the status describes that same policy, so this is unreachable
  // for a validated snapshot; it is the honest fallback rather than naming a destination we cannot.
  if (!chosen) {
    return { kind: 'loading', tooltip: copy.title }
  }

  const name = executionMachineName(locale, chosen, view.deviceNames)

  return {
    destination: chosen,
    kind: 'destination',
    tooltip: answering ? copy.answeringOn(name) : copy.aboutToAnswerOn(name)
  }
}

/** The assistant card's "Nơi trả lời" row reads the same rule as the closed trigger (§9.4), so the
 * row and the title bar can never name different places. Its label already says "where it
 * answers", so the value is only the place (a Mac's name, the cloud) or "Paused". A stale cache
 * says so plainly; the trigger's own headline would only repeat the row's label. */
export interface ExecutionPolicyRowSummary {
  kind: 'destination' | 'paused' | 'unavailable'
  text: string
}

export function executionPolicyRowSummary(locale: string, view: MatrixExecutionPolicyView): ExecutionPolicyRowSummary {
  const trigger = executionPolicyTrigger(locale, view)

  const copy = executionPolicyEditorCopy(locale)

  if (trigger.kind === 'destination') {
    return { kind: 'destination', text: executionMachineName(locale, trigger.destination, view.deviceNames) }
  }

  if (trigger.kind === 'paused') {
    return { kind: 'paused', text: copy.rowPaused }
  }

  return { kind: 'unavailable', text: copy.statusUnavailable }
}

/**
 * The roster's line for an assistant this Mac cannot run right now (§9.6): where the policy
 * answers instead, as a short "On Mac mini" (the row has little room, and the name is the point;
 * the title bar's tooltip carries the full sentence). A pause, a stale
 * cache, or a policy whose destinations are all offline says nothing here — then no destination
 * can answer, and the roster keeps its own "Not ready yet".
 */
export function executionPolicyRosterLine(
  locale: string,
  view: MatrixExecutionPolicyView,
  cloudOnly: boolean = AGENT_HOMES_CLOUD_ONLY
): string | undefined {
  if (cloudOnly) {
    return undefined
  }

  const trigger = executionPolicyTrigger(locale, view)

  if (trigger.kind !== 'destination') {
    return undefined
  }

  // `desired` alone is enough: the status names the destination next in line. The trigger's last
  // resort (first enabled row) says only what the policy would try, not that anyone can answer.
  return trigger.destination.current || trigger.destination.desired
    ? executionPolicyEditorCopy(locale).rosterOn(executionMachineName(locale, trigger.destination, view.deviceNames))
    : undefined
}
