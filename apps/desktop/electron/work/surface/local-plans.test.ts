import { describe, expect, it } from 'vitest'

import { parseMatrixWorkRequest } from '../../../shared/matrix-work'
import { WORK_RELAY_PLANS } from '../../../shared/matrix-work-relay'

import { projectLocalPlanStates } from './local-plans'

describe('Work-only plan status', () => {
  it('derives status and free allowance from the exact Work instances', () => {
    const provider = (instanceId: string, driver: string, installed: boolean, status: string, type?: string) => ({
      instanceId, driver, enabled: true, installed, auth: { status, type }
    })
    const ready = provider('openrouter-free', 'opencode', true, 'authenticated')
    expect(projectLocalPlanStates([
      provider('copilot', 'acpRegistry', false, 'unknown'),
      provider('kiro', 'kiro', true, 'authenticated', 'api_key'),
      provider('opencode', 'opencode', true, 'authenticated'),
      { ...ready, usageLimits: { windows: [{ id: 'openrouter-free-daily', label: '8 free requests left today' }] } }
    ])).toEqual({
      copilot: { state: 'not_installed' },
      kiro: { state: 'signed_out' },
      'openrouter-free': { state: 'ready', allowance: '8 free requests left today' }
    })
  })

  it.each(['copilot', 'kiro', 'openrouter-free'])('accepts a local action for %s only', plan => {
    expect(WORK_RELAY_PLANS).not.toContain(plan)
    expect(parseMatrixWorkRequest({ kind: 'localPlanAction', action: 'setup', plan })).toEqual({
      kind: 'localPlanAction', action: 'setup', plan
    })
    expect(parseMatrixWorkRequest({ kind: 'readPlanConsent', plan })).toBeNull()
  })
})
