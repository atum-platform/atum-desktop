import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gatewayForProfile } = vi.hoisted(() => ({ gatewayForProfile: vi.fn() }))

vi.mock('@/store/gateway', () => ({ gatewayForProfile }))

import { handleAtumAdvisorySearch } from './atum-advisory-search'

describe('Atum advisory history source bridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    gatewayForProfile.mockReset()
  })

  it('uses the event profile socket for a background advisor and forwards no model-controlled search fields', async () => {
    const request = vi.fn(async () => undefined)
    const search = vi.fn(async () => ({ status: 'empty', results: [], next_reference: null, previous_reference: null }))
    gatewayForProfile.mockReturnValue({ request })
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { advisoryRunner: { search } } })

    await expect(
      handleAtumAdvisorySearch({
        type: 'atum.advisory.search.request',
        session_id: 'background-runtime-session',
        profile: 'moon-profile',
        payload: {
          request_id: 'request-1',
          turn_id: 'turn-1',
          query: 'must not cross renderer bridge',
          target_assistant_id: 'must not cross renderer bridge'
        }
      })
    ).resolves.toBe(true)

    expect(search).toHaveBeenCalledWith({
      request_id: 'request-1',
      session_id: 'background-runtime-session',
      turn_id: 'turn-1',
      profile: 'moon-profile'
    })
    expect(gatewayForProfile).toHaveBeenCalledWith('moon-profile')
    expect(request).toHaveBeenCalledWith('atum.advisory.search.respond', {
      request_id: 'request-1',
      session_id: 'background-runtime-session',
      turn_id: 'turn-1',
      result: JSON.stringify({ status: 'empty', results: [], next_reference: null, previous_reference: null })
    })
  })

  it('returns unavailable through the source socket when the bridge fails', async () => {
    const request = vi.fn(async () => undefined)
    gatewayForProfile.mockReturnValue({ request })
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { advisoryRunner: { search: vi.fn(async () => Promise.reject(new Error('offline'))) } }
    })

    await handleAtumAdvisorySearch({
      type: 'atum.advisory.search.request',
      session_id: 'session-1',
      profile: 'andy-profile',
      payload: { request_id: 'request-2', turn_id: 'turn-2' }
    })

    expect(request).toHaveBeenCalledWith('atum.advisory.search.respond', {
      request_id: 'request-2',
      session_id: 'session-1',
      turn_id: 'turn-2',
      result: JSON.stringify({ status: 'unavailable', results: [], next_reference: null, previous_reference: null })
    })
  })
})
