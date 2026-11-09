import { expect, it, vi } from 'vitest'

import { MATRIX_LOGIN_STARTUP as channels, type MatrixLoginStartupBridge } from '../../shared/matrix-login-startup'

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke }
}))

import { exposeMatrixLoginStartup } from './login-startup-preload'

it('exposes only fixed OS status, a boolean setting and the fixed Login Items pane and an acknowledgement, not executable or lifecycle controls', async () => {
  expect(electron.exposeInMainWorld).not.toHaveBeenCalled()
  exposeMatrixLoginStartup()
  const [name, value] = electron.exposeInMainWorld.mock.calls[0]!
  const bridge = value as MatrixLoginStartupBridge
  expect(name).toBe('atumLoginStartup')
  expect(Object.keys(bridge).sort()).toEqual(['acknowledge', 'openSettings', 'setEnabled', 'status'])
  expect(electron.invoke).not.toHaveBeenCalled()
  await bridge.status()
  await bridge.setEnabled(true)
  await bridge.setEnabled(false)
  await bridge.openSettings()
  await bridge.acknowledge()
  // openSettings and acknowledge carry nothing: main owns the one destination and the record.
  expect(electron.invoke.mock.calls).toEqual([
    [channels.status],
    [channels.enabled, true],
    [channels.enabled, false],
    [channels.openSettings],
    [channels.acknowledge]
  ])
})
