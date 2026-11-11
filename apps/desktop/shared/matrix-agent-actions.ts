import { AGENT_HOMES_CLOUD_ONLY } from './agent-home-cloud-only'
import type { MatrixAgentView } from './matrix'

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export interface MatrixAgentActions {
  group: boolean
  photo: boolean
  move: boolean
}

type ActionAgent = Pick<MatrixAgentView, 'ready' | 'answering' | 'macRole' | 'executionPolicy'>

/** Whether this Mac hosts the assistant: a local one, or a cloud-route one this Mac answers for. */
function servedHere(agent: ActionAgent): boolean {
  return agent.answering !== 'cloud' || agent.macRole === 'answering'
}

/**
 * Whether the assistant has a runtime on this Mac its own pages (Connections, tools) can manage:
 * a local one, or a cloud-route one the saved policy keeps ready here, answering or standing by.
 * A cloud assistant no policy keeps here has no pages on this Mac (its page would only say it
 * cannot open), which is what the old `answering !== 'cloud'` check meant.
 */
export function matrixAgentRunsHere(agent: Pick<MatrixAgentView, 'answering' | 'macRole'>): boolean {
  return agent.answering !== 'cloud' || agent.macRole !== undefined
}

/** Whether a not-ready assistant still needs this Mac's local runtime setup. */
export function matrixAgentNeedsLocalSetup(
  agent: Pick<MatrixAgentView, 'answering' | 'macRole'>,
  cloudOnly: boolean = AGENT_HOMES_CLOUD_ONLY
): boolean {
  return cloudOnly ? !matrixAgentAnswersInCloud(agent) : matrixAgentRunsHere(agent)
}

/** The reply-settings dialog only controls the retired local-listening path. */
export function matrixAssistantReplySettingsShown(cloudOnly: boolean = AGENT_HOMES_CLOUD_ONLY): boolean {
  return !cloudOnly
}

/**
 * A cloud assistant not answered by this Mac uses the cloud route for this chat. A standby Mac
 * may keep a local runtime for failover, but its optional local provider readiness must not
 * replace the healthy cloud destination. Only a Mac holding the answering term is local here.
 */
export function matrixAgentAnswersInCloud(agent: Pick<MatrixAgentView, 'answering' | 'macRole'>): boolean {
  // Runtime counterpart: electron/matrix/cloud-agent-placement.ts matrixCloudAgentAnswersInCloud.
  return agent.answering === 'cloud' && agent.macRole !== 'answering'
}

export function matrixAgentActions(agent: ActionAgent): MatrixAgentActions {
  const hosted = agent.ready === true && servedHere(agent)

  return {
    group: hosted,
    photo: true,
    // A cloud-route agent already answers through the cloud route and a saved policy owns where it
    // runs: the legacy switch would refuse both.
    move: hosted && agent.answering !== 'cloud' && agent.executionPolicy?.policy.source !== 'saved'
  }
}

/**
 * How the group picker treats an assistant: `offered` (it can join), `blocked` (listed but not
 * ready yet: a local assistant still being set up), or `hidden` (not listed at all: a cloud
 * assistant no Mac answers for, which has no host here to join through, so no row names where it
 * answers).
 */
export type MatrixAgentGroupOffer = 'offered' | 'blocked' | 'hidden'

export function matrixAgentGroupOffer(agent: ActionAgent): MatrixAgentGroupOffer {
  if (matrixAgentActions(agent).group) {
    return 'offered'
  }

  return servedHere(agent) ? 'blocked' : 'hidden'
}
