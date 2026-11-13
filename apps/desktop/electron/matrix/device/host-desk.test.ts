import { describe, expect, it, vi } from 'vitest'

import { requestHostDesk } from './host-desk'

const agent = '00000000-0000-4000-8000-159badba71cd'
const signal = new AbortController().signal

const files = {
  read: 'files',
  root: 'home',
  path: 'reports',
  rows: [{ name: 'Q4 plan.docx', kind: 'file', size: 48200, modifiedAt: 1763029000000 }],
  truncated: false
}

describe('Shell host desk read', () => {
  it('sends exactly {agent, read, path} with the owner bearer, origin and contract header', async () => {
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ agent, read: 'files', path: 'home/reports' })

      return Response.json(files)
    })

    await expect(
      requestHostDesk('https://shell.test/api/matrix/v1', 'synthetic-token', agent, { read: 'files', path: 'home/reports' }, signal, fetcher)
    ).resolves.toEqual(files)
    expect(fetcher).toHaveBeenCalledWith(
      'https://shell.test/api/host/desk',
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

  it('omits path when none is asked, and never sends an owner', async () => {
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ agent, read: 'schedule' })

      return Response.json({ read: 'schedule', observedAt: 1, jobs: [], truncated: false })
    })

    await requestHostDesk('https://shell.test/api/matrix/v1', 'synthetic-token', agent, { read: 'schedule' }, signal, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 409, 429, 503])('reduces refusal %s to a short safe error', async status => {
    const fetcher = vi.fn(async () => Response.json({ error: 'private\n'.repeat(50) }, { status }))
    await expect(
      requestHostDesk('https://shell.test/api/matrix/v1', 'synthetic-token', agent, { read: 'memory' }, signal, fetcher)
    ).rejects.toThrow(status === 401 ? 'matrix_s1_authentication' : 'matrix_host_desk_refused')
  })

  it('refuses a reply for another read, a stray field, or a path outside its roots', async () => {
    const answer = (body: unknown) => async () => Response.json(body)

    const ask = (body: unknown, request: Parameters<typeof requestHostDesk>[3] = { read: 'files' }) =>
      requestHostDesk('https://shell.test/api/matrix/v1', 'synthetic-token', agent, request, signal, answer(body))

    await expect(ask({ read: 'memory', enabled: { memory: true, user: true }, notes: [], aboutYou: [], modifiedAt: 1, truncated: false })).rejects.toThrow('matrix_host_desk_invalid')
    await expect(ask({ ...files, path: '', owner: 'someone' })).rejects.toThrow('matrix_host_desk_invalid')
    await expect(ask({ ...files, rows: [{ name: '../x', kind: 'file', size: 1, modifiedAt: 1 }], path: '' })).rejects.toThrow('matrix_host_desk_invalid')
    await expect(
      requestHostDesk('https://shell.test/api/matrix/v1', 'synthetic-token', agent, { read: 'files', path: '../etc' }, signal, answer(files))
    ).rejects.toThrow('matrix_host_desk_invalid')
  })
})
