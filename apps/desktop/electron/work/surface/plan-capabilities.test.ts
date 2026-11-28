import { describe, expect, it, vi } from 'vitest'

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

  it('reports a safe diagnostic for each built-in plan without publishing a failed native probe', () => {
    const log = vi.fn()

    expect(projectPlanCapabilities([
      { ...provider('antigravity', 'oauth-personal'), status: 'error' },
      { ...provider('claudeAgent', 'pro'), auth: { status: 'unauthenticated' } }
    ], log)).toEqual({ claude: { state: 'disconnected' } })
    expect(log.mock.calls).toEqual([
      ['codex', 'unknown', 'native_status_missing'],
      ['claude', 'disconnected', 'signed_out'],
      ['antigravity', 'unknown', 'probe_error']
    ])
  })
})

describe('projectPlanLabels (first run)', () => {
  it('reads the four connections and T3 plan names, never an address', async () => {
    const { projectPlanLabels } = await import('./plan-capabilities')
    const provider = (instanceId: string, extra: Record<string, unknown>) => ({
      instanceId, driver: instanceId, enabled: true, installed: true, status: 'ready', models: [], auth: { status: 'authenticated' }, ...extra
    })

    expect(projectPlanLabels([
      provider('claudeAgent', { auth: { status: 'authenticated', type: 'claude.ai', label: 'Claude Pro' } }),
      provider('codex', { auth: { status: 'authenticated', type: 'chatgpt', label: ['owner', 'mail.test'].join(String.fromCharCode(64)) } }),
      provider('antigravity', { installed: false }),
      provider('opencode', { auth: { status: 'unauthenticated' } }),
      provider('cursor', {})
    ])).toEqual({
      claude: { state: 'ready', label: 'Claude Pro' },
      codex: { state: 'ready' },
      antigravity: { state: 'not_installed' },
      opencode: { state: 'signed_out' }
    })
  })
})
