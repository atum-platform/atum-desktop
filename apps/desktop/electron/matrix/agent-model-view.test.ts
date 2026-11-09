import { describe, expect, it } from 'vitest'

import type { MatrixConnectedModel } from '../../shared/matrix-models'

import { matrixAgentModelView } from './agent-model-view'

const chatgpt = { provider: 'openai-codex', model: 'gpt-6-luna' } as unknown as MatrixConnectedModel

describe('which AI an agent chat says it answers with', () => {
  it('shows the person’s own model for an agent that answers on this Mac', () => {
    expect(matrixAgentModelView({ managedModel: true, ownModel: true, connectedModel: chatgpt, cloud: false })).toEqual({
      atumModel: false,
      ownModel: true,
      connectedModel: chatgpt
    })
  })

  it('shows Atum’s AI for an agent that answers in the cloud, whatever this Mac remembers', () => {
    expect(matrixAgentModelView({ managedModel: true, ownModel: true, connectedModel: chatgpt, cloud: true })).toEqual({
      atumModel: true,
      ownModel: false
    })
  })

  it('keeps a cloud agent’s own Mac model while the saved policy keeps this Mac a destination', () => {
    expect(
      matrixAgentModelView({
        managedModel: true,
        ownModel: true,
        connectedModel: chatgpt,
        cloud: true,
        local: true
      })
    ).toEqual({ atumModel: true, ownModel: false, localModel: chatgpt })
  })

  it('never offers a local model for a cloud-only agent', () => {
    expect(
      matrixAgentModelView({
        managedModel: true,
        ownModel: true,
        connectedModel: chatgpt,
        cloud: true,
        local: false
      })
    ).toEqual({ atumModel: true, ownModel: false })
  })

  it('never claims Atum’s AI when the build has none', () => {
    expect(matrixAgentModelView({ managedModel: false, ownModel: undefined, connectedModel: undefined, cloud: true })).toEqual({
      atumModel: false,
      ownModel: false
    })
  })
})
