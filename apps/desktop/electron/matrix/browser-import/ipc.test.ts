import { describe, expect, it, vi } from 'vitest'

import { MATRIX_BROWSER_IMPORT as channels } from '../../../shared/matrix-browser-import'

import { registerBrowserImportIpc } from './ipc'
import type { BrowserImportService } from './service'

function setup(requireCaller: (event: unknown) => void = () => {}) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

  const ipc = {
    handle: vi.fn(
      (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void handlers.set(channel, handler)
    ),
    removeHandler: vi.fn((channel: string) => void handlers.delete(channel))
  }

  const service = {
    status: vi.fn(async () => ({ state: 'ready' as const })),
    run: vi.fn(async () => ({ outcome: 'declined' as const }))
  }

  const dispose = registerBrowserImportIpc(
    ipc as never,
    service as unknown as BrowserImportService,
    requireCaller as never
  )

  return { handlers, ipc, service, dispose }
}

describe('the import IPC', () => {
  it('has exactly two fixed channels', () => {
    const { handlers } = setup()

    expect([...handlers.keys()].sort()).toEqual([channels.run, channels.status].sort())
  })

  it('passes nothing the page sends to the service: no browser, profile, site or agent can be named', async () => {
    const { handlers, service } = setup()

    await handlers.get(channels.run)!(
      {},
      { browser: 'safari', profile: 'Profile 9', sites: ['chase.com'], agentPrincipal: 'x' },
      'extra'
    )
    await handlers.get(channels.status)!({}, { anything: true })

    expect(service.run).toHaveBeenCalledExactlyOnceWith()
    expect(service.status).toHaveBeenCalledExactlyOnceWith()
  })

  it('checks the caller first and refuses without touching the service', async () => {
    const refuse = () => {
      throw new Error('matrix_ipc_denied')
    }

    const { handlers, service } = setup(refuse)

    expect(() => handlers.get(channels.run)!({})).toThrow('matrix_ipc_denied')
    expect(() => handlers.get(channels.status)!({})).toThrow('matrix_ipc_denied')
    expect(service.run).not.toHaveBeenCalled()
    expect(service.status).not.toHaveBeenCalled()
  })

  it('returns the service’s answer and removes both handlers on dispose', async () => {
    const { handlers, dispose } = setup()

    await expect(handlers.get(channels.status)!({})).resolves.toEqual({ state: 'ready' })
    await expect(handlers.get(channels.run)!({})).resolves.toEqual({ outcome: 'declined' })
    dispose()
    expect(handlers.size).toBe(0)
  })
})
