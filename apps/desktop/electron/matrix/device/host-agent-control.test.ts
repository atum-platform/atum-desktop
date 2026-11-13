import { describe, expect, it, vi } from 'vitest'

import { requestHostAgentControl } from './host-agent-control'

const agent = '00000000-0000-4000-8000-159badba71cd'
const signal = new AbortController().signal
const base = 'https://shell.test/api/matrix/v1'

describe('Shell host agent control', () => {
  it('sends exactly {agent, action} with the owner bearer, origin and contract header', async () => {
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ agent, action: 'pause' })

      return Response.json({ action: 'pause', changed: 2 })
    })

    await expect(requestHostAgentControl(base, 'synthetic-token', agent, { action: 'pause' }, signal, fetcher)).resolves.toEqual({
      action: 'pause',
      changed: 2
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://shell.test/api/host/agent-control',
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        headers: {
          Authorization: 'Bearer synthetic-token',
          'Content-Type': 'application/json',
          Origin: 'https://shell.test',
          'X-Atum-Host-Bridge-Contract': 'atum.s2.host-bridge/1.0.0'
        }
      })
    )
  })

  it('sends the job for a routine, and refuses a routine without one or a pause with one', async () => {
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ agent, action: 'routine_off', job: 'brief' })

      return Response.json({ action: 'routine_off', changed: 1 })
    })

    await requestHostAgentControl(base, 'synthetic-token', agent, { action: 'routine_off', job: 'brief' }, signal, fetcher)
    await expect(
      requestHostAgentControl(base, 'synthetic-token', agent, { action: 'routine_on' } as never, signal, fetcher)
    ).rejects.toThrow('matrix_host_control_invalid')
    await expect(
      requestHostAgentControl(base, 'synthetic-token', agent, { action: 'pause', job: 'brief' } as never, signal, fetcher)
    ).rejects.toThrow('matrix_host_control_invalid')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    [401, 'matrix_s1_authentication'],
    [409, 'matrix_host_control_stopped'],
    [403, 'matrix_host_control_refused'],
    [429, 'matrix_host_control_refused'],
    [503, 'matrix_host_control_refused']
  ])('maps %s to %s', async (status, error) => {
    const fetcher = vi.fn(async () => Response.json({ error: 'private' }, { status: status as number }))
    await expect(requestHostAgentControl(base, 'synthetic-token', agent, { action: 'resume' }, signal, fetcher)).rejects.toThrow(
      error as string
    )
  })

  it('refuses a reply for another action or with a stray field', async () => {
    const ask = (body: unknown) =>
      requestHostAgentControl(base, 'synthetic-token', agent, { action: 'pause' }, signal, async () => Response.json(body))

    await expect(ask({ action: 'resume', changed: 1 })).rejects.toThrow('matrix_host_control_invalid')
    await expect(ask({ action: 'pause', changed: 1, owner: 'x' })).rejects.toThrow('matrix_host_control_invalid')
    await expect(ask({ action: 'pause', changed: -1 })).rejects.toThrow('matrix_host_control_invalid')
  })
})
