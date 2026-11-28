import { describe, expect, it, vi } from 'vitest'

import { parseMatrixWorkRequest } from '../../../shared/matrix-work'
import { WORK_RELAY_PLANS } from '../../../shared/matrix-work-relay'

import { projectLocalPlanStates, setupWorkLocalPlan } from './local-plans'

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
    const action = plan === 'kiro' ? 'setup-github' : 'setup'
    expect(parseMatrixWorkRequest({ kind: 'localPlanAction', action, plan })).toEqual({
      kind: 'localPlanAction', action, plan
    })
    expect(parseMatrixWorkRequest({ kind: 'readPlanConsent', plan })).toBeNull()
  })

  it('sends the selected Kiro method and carries Work’s failure message through the owner socket', async () => {
    const detail = 'Free up 1.5 GB of disk space to install Kiro.'
    const requests: unknown[] = []
    class OwnerSocket extends EventTarget {
      constructor() {
        super()
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }

      send(value: string) {
        const request = JSON.parse(value) as { _tag: string; tag?: string }
        if (request._tag !== 'Request') {return}
        requests.push(request)
        const state = { instanceId: 'kiro', flowId: 'new-flow' }
        const frame = request.tag === 'provider.auth.start'
          ? { _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: { ...state, phase: 'starting' } } }
          : { _tag: 'Chunk', requestId: '2', values: [
            { ...state, flowId: 'old-flow', phase: 'failed', message: 'Old result' },
            { ...state, phase: 'failed', message: detail }
          ] }
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
      }

      close() {}
    }

    vi.stubGlobal('WebSocket', OwnerSocket)
    try {
      const owner = { fetch: async () => Response.json({ ticket: 'fixture' }) }
      const signal = new AbortController().signal

      await expect(setupWorkLocalPlan('http://127.0.0.1:1234', owner, 'kiro', 'setup-github', signal)).resolves.toBe(detail)
      expect(requests[0]).toMatchObject({
        tag: 'provider.auth.start', payload: { instanceId: 'kiro', methodId: 'github' }
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
