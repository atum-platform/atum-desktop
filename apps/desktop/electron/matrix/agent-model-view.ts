import type { MatrixConnectedModel } from '../../shared/matrix-models'

/**
 * Which AI an agent's chat says it answers with. A model of the person's own (a ChatGPT
 * plan, an API key, a local model) lives in this Mac's Hermes for that agent. A cloud agent
 * never uses that model in the cloud (cloud own-model access is not built yet), but the saved
 * execution policy may still keep this Mac as a destination (R5): then the local model is a
 * real choice for the turns this Mac runs, and the picker shows it beside the cloud's Atum
 * routes. A cloud-only agent keeps Atum's AI and offers no local model.
 *
 * `localModel` is the cloud agent's own connection on this Mac; `connectedModel` stays the
 * model an agent that answers on this Mac uses. Keeping them separate means the existing
 * setModel path still writes the platform's cloud choice for a cloud agent.
 */
export function matrixAgentModelView(input: {
  managedModel: boolean
  ownModel: boolean | undefined
  connectedModel: MatrixConnectedModel | undefined
  cloud: boolean
  /** The saved policy keeps this Mac as a destination (answering or standing by). */
  local?: boolean
}): { atumModel: boolean; ownModel: boolean; connectedModel?: MatrixConnectedModel; localModel?: MatrixConnectedModel } {
  const own = Boolean(input.ownModel) && !input.cloud

  const local =
    Boolean(input.ownModel) && Boolean(input.connectedModel) && (!input.cloud || Boolean(input.local))

  return {
    atumModel: input.managedModel && !own,
    ownModel: own,
    ...(own && input.connectedModel ? { connectedModel: input.connectedModel } : {}),
    ...(local && input.cloud && input.connectedModel ? { localModel: input.connectedModel } : {})
  }
}
