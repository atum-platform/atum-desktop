import { EventEmitter } from 'node:events'

import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_PROMPT_MAX } from '../../shared/matrix'
import { MATRIX_PET_OVERLAY_IPC as IPC } from '../../shared/matrix-pet-overlay'

import {
  matrixPetOverlayBubble,
  type MatrixPetOverlayData,
  type MatrixPetOverlayHost,
  MatrixPetOverlays
} from './pet-overlay'

const url = 'file:///bundled/matrix-pet.html'
const sprite = { enabled: true, spritesheetBase64: 'test-sheet', scale: 1 }

const data: MatrixPetOverlayData = {
  agentKey: 'native-owner:agent-a',
  sprite,
  locale: 'vi',
  work: 'idle',
  reducedMotion: true,
  recent: [],
  unsaved: []
}

class WindowDouble extends EventEmitter {
  destroyed = false
  bounds: { x: number; y: number; width: number; height: number }
  wc = Object.assign(new EventEmitter(), {
    mainFrame: { url },
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
  })
  get webContents() {
    return this.wc
  }
  setAlwaysOnTop = vi.fn()
  setVisibleOnAllWorkspaces = vi.fn()
  setIgnoreMouseEvents = vi.fn()
  setFocusable = vi.fn()
  showInactive = vi.fn()
  focus = vi.fn()
  loadURL = vi.fn(async () => undefined)
  constructor(readonly options: BrowserWindowConstructorOptions) {
    super()
    this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 0, height: options.height ?? 0 }
  }
  getBounds() {
    return { ...this.bounds }
  }
  setBounds(bounds: typeof this.bounds) {
    this.bounds = bounds
  }
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    this.destroyed = true
    this.emit('closed')
  }
}

function setup() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, value?: unknown) => Promise<void>>()
  const windows: WindowDouble[] = []

  const screen = {
    getAllDisplays: vi.fn(() => [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 24, width: 1920, height: 1020 } }
    ]),
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 }))
  }

  const host = {
    createWindow: (options: BrowserWindowConstructorOptions) => {
      const window = new WindowDouble(options)
      windows.push(window)

      return window
    },
    ipc: {
      handle: (name: string, handler: typeof handlers extends Map<string, infer H> ? H : never) =>
        handlers.set(name, handler),
      removeHandler: vi.fn((name: string) => handlers.delete(name))
    },
    screen,
    preload: '/bundled/matrix-pet-preload.js',
    url,
    signed: true,
    submit: vi.fn(async () => undefined),
    action: vi.fn(async () => undefined),
    restore: vi.fn(() => ({ x: 100, y: 700 })),
    remember: vi.fn(),
    now: () => Date.now()
  }

  const controller = new MatrixPetOverlays(host as unknown as MatrixPetOverlayHost)

  const open = (value = data) => {
    controller.open(value)
    const window = windows.at(-1)!
    window.wc.emit('did-finish-load')

    return window
  }

  const event = (window: WindowDouble) =>
    ({ sender: window.wc, senderFrame: window.wc.mainFrame }) as unknown as IpcMainInvokeEvent

  const receive = (window: WindowDouble, channel: string, value?: unknown) =>
    handlers.get(channel)!(event(window), value)

  return { controller, host, handlers, windows, open, event, receive }
}

let current: ReturnType<typeof setup>
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  current = setup()
})
afterEach(() => {
  current.controller.dispose()
  vi.useRealTimers()
})

describe('Matrix pet overlay boundary', () => {
  it('owns a sandboxed panel with denied navigation, windows and permissions', () => {
    const window = current.open()
    expect(window.options).toMatchObject({
      frame: false,
      transparent: true,
      type: 'panel',
      focusable: false,
      hiddenInMissionControl: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        partition: 'persist:matrix-pet',
        devTools: false
      }
    })
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
    expect(window.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    })
    expect(window.wc.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' })

    for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview']) {
      const preventDefault = vi.fn()
      window.wc.emit(name, { preventDefault })
      expect(preventDefault).toHaveBeenCalled()
    }

    const allowed = vi.fn()
    window.wc.session.setPermissionRequestHandler.mock.calls[0]![0](window.wc, 'camera', allowed)
    expect(allowed).toHaveBeenCalledWith(false)
    expect(window.wc.session.setPermissionCheckHandler.mock.calls[0]![0]()).toBe(false)
  })

  it('rejects a wrong sender, subframe or URL before dispatch', async () => {
    const window = current.open()
    const handler = current.handlers.get(IPC.click)!
    await expect(handler({ ...current.event(window), sender: {} } as IpcMainInvokeEvent)).rejects.toThrow(
      'matrix_ipc_denied'
    )
    await expect(handler({ ...current.event(window), senderFrame: {} } as IpcMainInvokeEvent)).rejects.toThrow(
      'matrix_ipc_denied'
    )
    window.wc.mainFrame.url = 'https://foreign.invalid/'
    await expect(handler(current.event(window))).rejects.toThrow('matrix_ipc_denied')
    expect(current.host.submit).not.toHaveBeenCalled()
  })

  it('resolves submit to its registered native agent and rejects target/coordinate payloads', async () => {
    const window = current.open()
    await current.receive(window, IPC.click)
    await current.receive(window, IPC.submit, 'Wave please')
    expect(current.host.submit).toHaveBeenCalledExactlyOnceWith(data.agentKey, 'Wave please')

    for (const value of [{ text: 'Hi', agentKey: 'other' }, '', 'x'.repeat(MATRIX_PROMPT_MAX + 1)]) {
      await expect(current.receive(window, IPC.submit, value)).rejects.toThrow('matrix_pet_overlay_invalid')
    }

    await expect(current.receive(window, IPC.drag, { x: 9, y: 8, agentKey: 'other' })).rejects.toThrow(
      'matrix_pet_overlay_invalid'
    )
    await expect(current.receive(window, IPC.menu, 'generalRpc')).rejects.toThrow('matrix_pet_overlay_invalid')
    expect(current.host.submit).toHaveBeenCalledTimes(1)
  })

  it('click-through follows native cursor geometry, ignoring a renderer hint', async () => {
    const window = current.open()
    await current.receive(window, IPC.setInteractive, true)
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    const bounds = window.getBounds()
    // Just under the 384 px chat panel: over the pet itself.
    current.host.screen.getCursorScreenPoint.mockReturnValue({ x: bounds.x + bounds.width / 2, y: bounds.y + 392 })
    await current.receive(window, IPC.setInteractive, false)
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
    await current.receive(window, IPC.drag, 'start')
    current.host.screen.getCursorScreenPoint.mockReturnValue({ x: -500, y: -500 })
    vi.advanceTimersByTime(80)
    expect(window.getBounds().x).toBeGreaterThanOrEqual(0)
    expect(window.getBounds().y).toBeGreaterThanOrEqual(24)
    await current.receive(window, IPC.drag, 'end')
    expect(current.host.remember).toHaveBeenCalledWith(
      data.agentKey,
      expect.objectContaining({ x: expect.any(Number) })
    )
  })

  it('has one window per native key, cap5 and complete teardown', async () => {
    const first = current.open()
    current.controller.open(data)
    expect(current.windows).toHaveLength(1)

    for (let i = 1; i <= 5; i += 1) {
      current.open({ ...data, agentKey: `owner:agent-${i}` })
    }

    expect(first.destroyed).toBe(true)
    expect(current.windows.filter(window => !window.destroyed)).toHaveLength(5)
    const last = current.windows.at(-1)!
    const stale = current.handlers.get(IPC.submit)!
    current.controller.dispose()
    expect(current.windows.every(window => window.destroyed)).toBe(true)
    expect(current.handlers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await expect(stale(current.event(last), 'Late')).rejects.toThrow('matrix_ipc_denied')
  })

  it('tears down every window even when cosmetic position persistence fails', () => {
    current.open()
    current.open({ ...data, agentKey: 'owner:second' })
    current.host.remember.mockImplementation(() => {
      throw new Error('disk unavailable')
    })
    current.controller.dispose()
    expect(current.windows.every(window => window.destroyed)).toBe(true)
    expect(current.handlers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a window for an equivalent fresh sprite snapshot and replaces changed art', () => {
    const window = current.open()
    current.controller.update({ ...data, sprite: { ...sprite }, work: 'waiting' })
    expect(current.windows).toHaveLength(1)
    expect(window.wc.send.mock.calls.at(-1)![1].bubble).toEqual({ kind: 'yourTurn' })
    current.controller.update({ ...data, sprite: { ...sprite, spritesheetRevision: 'next' } })
    expect(window.destroyed).toBe(true)
    expect(current.windows).toHaveLength(2)
  })

  it('reclamps a removed display and follows a changed work-area floor without anchor oscillation', () => {
    const window = current.open({ ...data, sprite: { ...sprite, frameH: 208, anchor: { footY: 180, centerX: 96 } } })
    const initial = window.getBounds()
    vi.advanceTimersByTime(800)
    expect(window.getBounds()).toEqual(initial)
    current.host.screen.getAllDisplays.mockReturnValue([
      { bounds: { x: -1200, y: 0, width: 1200, height: 900 }, workArea: { x: -1200, y: 24, width: 1200, height: 800 } }
    ])
    vi.advanceTimersByTime(80)
    const moved = window.getBounds()
    expect(moved.x).toBeLessThan(0)
    expect(moved.x).toBeGreaterThanOrEqual(-1200)
    // The chat panel (PANEL_HEIGHT) sits above the sprite; the pet's feet land on the work area's floor.
    const panel = 384
    expect(moved.y + panel + ((moved.height - panel) * 180) / 208).toBeCloseTo(824, 0)
    vi.advanceTimersByTime(800)
    expect(window.getBounds()).toEqual(moved)
    current.host.screen.getAllDisplays.mockReturnValue([])
    vi.advanceTimersByTime(80)
    expect(window.destroyed).toBe(true)
  })

  it('expires the actual rendered status even when the pet is resting', () => {
    const window = current.open({ ...data, reply: { text: 'private reply', at: Date.now() } })
    expect(window.wc.send.mock.calls.at(-1)![1].bubble).toEqual({ kind: 'done' })
    vi.advanceTimersByTime(12_000)
    expect(window.wc.send.mock.calls.at(-1)![1].bubble).toBeUndefined()
  })

  it('sends status only by default; excerpt is opt-in, bounded and expires', () => {
    const value = { ...data, reply: { text: 'private words '.repeat(100), at: 10_000 } }
    const window = current.open(value)
    const snapshot = () => window.wc.send.mock.calls.at(-1)![1]
    expect(snapshot().bubble).toEqual({ kind: 'done' })
    expect(snapshot()).not.toHaveProperty('agentKey')
    expect(snapshot()).not.toHaveProperty('reply')
    current.controller.setShowReplyExcerpt(true)
    expect(snapshot().bubble.text).toHaveLength(160)
    current.controller.setShowReplyExcerpt(false)
    expect(JSON.stringify(snapshot())).not.toContain('private words')
    expect(matrixPetOverlayBubble(value, true, 22_001)).toBeUndefined()
    expect(matrixPetOverlayBubble(value, true, 9_999)).toBeUndefined()
    expect(matrixPetOverlayBubble({ ...value, work: 'waiting' }, true, 10_000)).toEqual({ kind: 'yourTurn' })
  })
})
