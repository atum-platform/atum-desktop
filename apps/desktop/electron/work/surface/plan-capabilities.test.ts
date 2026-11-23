import { describe, expect, it } from 'vitest'

import { projectPlanCapabilities } from './plan-capabilities'

const model = { slug: 'model-id', name: 'Model Name', isCustom: false }

const provider = (driver: string, type: string) => ({
  driver, instanceId: driver, enabled: true, installed: true, status: 'ready',
  auth: { status: 'authenticated', type, email: 'fixture@invalid' },
  models: [model]
})

describe('projecting T3 plan capabilities', () => {
  it('uses the three built-in authenticated instances and publishes only native model ids and labels', () => {
    const codex = provider('codex', 'chatgpt')
    const custom = { slug: 'custom-model', name: 'Custom', isCustom: true }
    const namedWithEmail = { slug: 'safe-id', name: 'fixture@invalid', isCustom: false }

    expect(projectPlanCapabilities([
      { ...codex, models: [model, model, custom, namedWithEmail, { ...model, slug: 'fixture@invalid' }] },
      provider('claudeAgent', 'pro'),
      provider('antigravity', 'oauth-personal'),
      { ...codex, instanceId: 'another-instance' }
    ])).toEqual({
      codex: { state: 'connected', models: [{ id: 'model-id', displayName: 'Model Name' }, { id: 'safe-id', displayName: 'safe-id' }] },
      claude: { state: 'connected', models: [{ id: 'model-id', displayName: 'Model Name' }] },
      antigravity: { state: 'connected', models: [{ id: 'model-id', displayName: 'Model Name' }] }
    })
  })

  it('takes sign-out and disablement from native status even if T3 still lists models', () => {
    const codex = provider('codex', 'chatgpt')

    expect(projectPlanCapabilities([
      { ...codex, auth: { status: 'unauthenticated' } },
      { ...provider('claudeAgent', 'pro'), enabled: false },
      provider('antigravity', 'gemini-api-key')
    ])).toEqual({
      codex: { state: 'disconnected' },
      claude: { state: 'disconnected' },
      antigravity: { state: 'disconnected' }
    })
  })

  it('leaves unknown statuses alone and reports an authenticated plan with a pending catalog', () => {
    expect(projectPlanCapabilities([
      { ...provider('codex', 'chatgpt'), auth: { status: 'unknown' } },
      { ...provider('claudeAgent', 'pro'), models: [] },
      null
    ])).toEqual({ claude: { state: 'connected' } })
    expect(projectPlanCapabilities(undefined)).toEqual({})
  })
})
