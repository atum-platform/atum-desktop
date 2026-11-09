import { describe, expect, it, vi } from 'vitest'

import { MATRIX_PAGES_IPC, type MatrixHermesPagesBridge } from '../../shared/matrix-pages'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke }
}))

import './pages-preload'

function bridge(): MatrixHermesPagesBridge {
  return electron.exposeInMainWorld.mock.calls.find(
    ([name]) => name === 'atumHermesPages'
  )?.[1] as MatrixHermesPagesBridge
}

describe('Matrix pages preload', () => {
  it('exposes only its scoped operations and rejects sanitized IPC failures', async () => {
    const pages = bridge()

    expect(Object.keys(pages).sort()).toEqual([
      'api',
      'close',
      'context',
      'navigateConnections',
      'openExternal',
      'readMedia'
    ])
    electron.invoke.mockResolvedValueOnce({ error: 'backend token leaked: secret-value' })
    await expect(pages.api({ path: '/api/cron' })).rejects.toThrow('matrix_pages_failed')
    electron.invoke.mockResolvedValueOnce({ error: 'matrix_pages_unavailable' })
    await expect(pages.readMedia('artifact.png')).rejects.toThrow('matrix_pages_unavailable')
    electron.invoke.mockResolvedValueOnce({ error: 'provider_terms_blocked' })
    await expect(pages.api({ path: '/api/provider-settings/oauth/start', method: 'POST', body: { provider: 'copilot' } }))
      .rejects.toThrow('provider_terms_blocked')
    electron.invoke.mockResolvedValueOnce({ page: 'providers' })
    await expect(pages.navigateConnections('providers')).resolves.toEqual({ page: 'providers' })
    expect(electron.invoke).toHaveBeenLastCalledWith(MATRIX_PAGES_IPC.navigateConnections, 'providers')
    electron.invoke.mockResolvedValueOnce(undefined)
    await expect(pages.close()).resolves.toBeUndefined()
    expect(electron.invoke).toHaveBeenLastCalledWith(MATRIX_PAGES_IPC.dismiss)
  })
})
