import { expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke }
}))

import { MATRIX_DEVICE_IPC, type MatrixDeviceBridge, parseMatrixDeviceAction } from './bridge'
import { exposeMatrixDeviceBridge } from './bridge-preload'

it('exposes status, grants and Stop on one channel, and every request it sends is one main accepts', async () => {
  exposeMatrixDeviceBridge()
  const [name, value] = electron.exposeInMainWorld.mock.calls[0]!
  const bridge = value as MatrixDeviceBridge
  expect(name).toBe('atumDevice')
  expect(Object.keys(bridge).sort()).toEqual(['addGrant', 'revokeGrant', 'status', 'stop'])

  await bridge.status()
  await bridge.addGrant('ssh_agent', '@t:atumplatform.com')
  await bridge.revokeGrant('g1')
  await bridge.stop()

  for (const [channel, request] of electron.invoke.mock.calls) {
    expect(channel).toBe(MATRIX_DEVICE_IPC)
    expect(parseMatrixDeviceAction(request)).toEqual(request)
  }

  expect(electron.invoke).toHaveBeenCalledTimes(4)
})
