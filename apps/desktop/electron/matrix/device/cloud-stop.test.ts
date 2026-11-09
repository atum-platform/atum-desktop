import { describe, expect, it, vi } from 'vitest'

import { hasEnrolledCloudMac, requestS1, type S1Resource } from './cloud-agent'
import { stopCloudTurn } from './cloud-stop'

const agent = '00000000-0000-4000-8000-159badba71cd'
const roomId = '!room:test'
const turnId = '00000000-0000-4000-8000-11e594f48195'
const target = (eventId: string) => ({ kind: 'turn', roomId, eventId })

describe('native cloud Stop authority', () => {
  it.each(['$question', `$atum-occurrence-${turnId}`, `$atum-followup-${turnId}.${turnId}`])(
    'uses the fixed owner-authenticated route for %s and returns only its confirmed state',
    async eventId => {
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        expect(body).toEqual({
          requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          agentPrincipal: agent,
          target: target(eventId)
        })

        return Response.json({ agentPrincipal: agent, target: body.target, state: 'stop_requested', stoppedAt: 1 })
      })

      const call = (resource: S1Resource, signal: AbortSignal) =>
        requestS1('https://api.test/api/matrix/v1', resource, 'test-owner-bearer', signal, fetchImpl as typeof fetch)

      expect(await stopCloudTurn(call, agent, roomId, eventId, new AbortController().signal)).toEqual({
        state: 'stop_requested'
      })
      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.test/api/matrix/v1/cloud/stop')
      expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
        method: 'POST',
        headers: { Authorization: 'Bearer test-owner-bearer', 'Content-Type': 'application/json' }
      })
    }
  )

  it.each(['stopped', 'stop_requested', 'completed'] as const)('keeps %s distinct', async state => {
    const call = vi.fn(async () => ({ agentPrincipal: agent, target: target('$question'), state, stoppedAt: 0 }))
    expect(await stopCloudTurn(call, agent, roomId, '$question', new AbortController().signal)).toEqual({ state })
  })

  it.each([
    { state: 'unknown' },
    { state: ['stopped'] },
    { agentPrincipal: turnId },
    { stoppedAt: -1 },
    { stoppedAt: 1.5 },
    { target: { ...target('$question'), roomId: '!other:test' } },
    { target: { ...target('$question'), eventId: '$other' } },
    { key: 'unexpected' }
  ])('never confirms a mismatched or malformed response %j', async patch => {
    const call = vi.fn(async () => ({
      agentPrincipal: agent,
      target: target('$question'),
      state: 'stopped',
      stoppedAt: 1,
      ...patch
    }))

    await expect(stopCloudTurn(call, agent, roomId, '$question', new AbortController().signal)).rejects.toThrow(
      'matrix_cloud_stop_unconfirmed'
    )
    expect(call).toHaveBeenCalledOnce()
  })

  it.each(['$atum-followup-invalid', '$atum-occurrence-invalid', 'not-an-event'])(
    'rejects %s before a request',
    async eventId => {
      const call = vi.fn()
      await expect(stopCloudTurn(call, agent, roomId, eventId, new AbortController().signal)).rejects.toThrow()
      expect(call).not.toHaveBeenCalled()
    }
  )

  it('does not retry an unknown network outcome, and discards an aborted acknowledgement', async () => {
    const call = vi.fn(async () => {
      throw new Error('network_unknown')
    })

    await expect(stopCloudTurn(call, agent, roomId, '$question', new AbortController().signal)).rejects.toThrow(
      'network_unknown'
    )
    expect(call).toHaveBeenCalledOnce()
    const abort = new AbortController()

    const confirmed = async () => {
      abort.abort()

      return { agentPrincipal: agent, target: target('$question'), state: 'stopped', stoppedAt: 1 }
    }

    await expect(stopCloudTurn(confirmed, agent, roomId, '$question', abort.signal)).rejects.toThrow()
  })

  it('distinguishes an authoritative empty registration list from an unreadable one', async () => {
    expect(await hasEnrolledCloudMac(async () => ({ deviceServices: [] }), new AbortController().signal)).toBe(false)
    await expect(hasEnrolledCloudMac(async () => ({}), new AbortController().signal)).rejects.toThrow()
    await expect(
      hasEnrolledCloudMac(async () => {
        throw new Error('offline')
      }, new AbortController().signal)
    ).rejects.toThrow('offline')
  })
})
