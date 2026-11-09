import { beforeEach, expect, it, vi } from 'vitest'

import { MATRIX_PET_OVERLAY_IPC as IPC } from '../../shared/matrix-pet-overlay'

const native = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), expose: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: native, contextBridge: { exposeInMainWorld: native.expose } }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

it('exposes only fixed pet intents and replays the latest snapshot to a late listener', async () => {
  await import('./pet-overlay-preload')
  expect(native.expose.mock.calls[0]![0]).toBe('atumMatrixPetOverlay')
  const bridge = native.expose.mock.calls[0]![1]
  expect(Object.keys(bridge).sort()).toEqual([
    'click',
    'drag',
    'menu',
    'onSnapshot',
    'popIn',
    'setInteractive',
    'submit'
  ])
  expect(native.on).toHaveBeenCalledExactlyOnceWith(IPC.snapshot, expect.any(Function))
  const receive = native.on.mock.calls[0]![1]
  const snapshot = { sprite: { enabled: true }, chatOpen: false }
  receive({}, snapshot)
  const callback = vi.fn()
  const stop = bridge.onSnapshot(callback)
  expect(callback).toHaveBeenCalledExactlyOnceWith(snapshot)
  stop()
  receive({}, { chatOpen: true })
  expect(callback).toHaveBeenCalledTimes(1)
  bridge.drag('start')
  bridge.click()
  bridge.menu('wave')
  bridge.popIn()
  bridge.setInteractive(true)
  bridge.submit('Hi')
  expect(native.invoke.mock.calls).toEqual([
    [IPC.drag, 'start'],
    [IPC.click],
    [IPC.menu, 'wave'],
    [IPC.popIn],
    [IPC.setInteractive, true],
    [IPC.submit, 'Hi']
  ])
})
