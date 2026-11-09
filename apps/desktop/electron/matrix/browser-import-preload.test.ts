import { expect, it, vi } from 'vitest'

import { MATRIX_BROWSER_IMPORT as channels, type MatrixBrowserImportBridge } from '../../shared/matrix-browser-import'

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn() }))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke }
}))

import { exposeMatrixBrowserImport } from './browser-import-preload'

it('exposes only a status read and a run, and forwards nothing the page passes', async () => {
  expect(electron.exposeInMainWorld).not.toHaveBeenCalled()
  exposeMatrixBrowserImport()

  const [name, value] = electron.exposeInMainWorld.mock.calls[0]!
  const bridge = value as MatrixBrowserImportBridge

  expect(name).toBe('atumBrowserImport')
  expect(Object.keys(bridge).sort()).toEqual(['run', 'status'])
  expect(electron.invoke).not.toHaveBeenCalled()

  await bridge.status()
  // A page that tries to name a browser, profile, site or agent reaches main with none of it.
  await (bridge.run as (...args: unknown[]) => Promise<unknown>)({
    browser: 'safari',
    sites: ['chase.com'],
    agentPrincipal: 'x'
  })

  expect(electron.invoke.mock.calls).toEqual([[channels.status], [channels.run]])
})
