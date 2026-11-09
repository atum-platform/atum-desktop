import { describe, expect, it, vi } from 'vitest'

import {
  ATUM_AUTH_WINDOW_HEIGHT,
  ATUM_AUTH_WINDOW_WIDTH,
  type Bounds,
  computeAuthWindowBounds,
  createAtumWindowModeController,
  normalizeWindowMode
} from './atum-window-mode'

const WORK_AREA = { height: 1000, width: 1600, x: 0, y: 25 }
const NORMAL: Bounds = { height: 800, width: 1220, x: 120, y: 90 }

function fakeWindow(initial: Bounds = NORMAL) {
  const state = {
    bounds: { ...initial },
    destroyed: false,
    fullScreen: false,
    maximizable: true,
    maximized: false,
    minimumWidth: 400,
    minimumHeight: 620,
    resizable: true
  }

  const win = {
    getBounds: () => ({ ...state.bounds }),
    isDestroyed: () => state.destroyed,
    isFullScreen: () => state.fullScreen,
    isMaximized: () => state.maximized,
    isResizable: () => state.resizable,
    maximize: () => {
      state.maximized = true
    },
    setBounds: vi.fn((bounds: Bounds) => {
      state.bounds = {
        ...bounds,
        width: Math.max(bounds.width, state.minimumWidth),
        height: Math.max(bounds.height, state.minimumHeight)
      }
    }),
    setMinimumSize: vi.fn((width: number, height: number) => {
      state.minimumWidth = width
      state.minimumHeight = height
    }),
    setWindowButtonPosition: vi.fn(),
    setMaximizable: (value: boolean) => {
      state.maximizable = value
    },
    setResizable: (value: boolean) => {
      state.resizable = value
    },
    unmaximize: () => {
      state.maximized = false
    }
  }

  return { state, win }
}

function controllerFor(win: ReturnType<typeof fakeWindow>['win'], sender: unknown = 'primary') {
  const changes: string[] = []

  const controller = createAtumWindowModeController({
    getWindow: () => win,
    getWorkArea: () => WORK_AREA,
    isOwnerSender: candidate => candidate === sender,
    onModeChanged: mode => changes.push(mode)
  })

  return {
    changes,
    controller,
    set: (mode: unknown, from: unknown = sender) => controller.handleSetMode({ sender: from }, { mode })
  }
}

describe('computeAuthWindowBounds', () => {
  it('centres the compact window in the display work area', () => {
    expect(computeAuthWindowBounds(NORMAL, WORK_AREA)).toEqual({
      height: ATUM_AUTH_WINDOW_HEIGHT,
      width: ATUM_AUTH_WINDOW_WIDTH,
      x: Math.round((1600 - ATUM_AUTH_WINDOW_WIDTH) / 2),
      y: 25 + Math.round((1000 - ATUM_AUTH_WINDOW_HEIGHT) / 2)
    })
  })

  it('is compact — never the default product window size', () => {
    const bounds = computeAuthWindowBounds(NORMAL, WORK_AREA)

    expect(bounds.width).toBeLessThan(NORMAL.width)
    expect(bounds.height).toBeLessThan(NORMAL.height)
    // Above window-state.ts's MIN_WIDTH/MIN_HEIGHT, so it never fights the
    // primary window's own minimum size.
    // Atum Shell v2 (SPEC §4): 460×600. The controller lowers the window's
    // minimum size for the compact mode and restores 400×620 afterwards.
    expect(bounds.width).toBeGreaterThanOrEqual(400)
    expect(bounds.height).toBeGreaterThanOrEqual(600)
  })

  it('stays inside a work area smaller than the compact size', () => {
    const tiny = { height: 500, width: 380, x: 0, y: 0 }
    const bounds = computeAuthWindowBounds(NORMAL, tiny)

    expect(bounds.width).toBe(380)
    expect(bounds.height).toBe(500)
    expect(bounds.x).toBe(0)
    expect(bounds.y).toBe(0)
  })

  it('falls back to centring on the window when no work area is known', () => {
    const bounds = computeAuthWindowBounds(NORMAL, null)

    expect(bounds.width).toBe(ATUM_AUTH_WINDOW_WIDTH)
    expect(bounds.x).toBe(120 + Math.round((1220 - ATUM_AUTH_WINDOW_WIDTH) / 2))
  })
})

describe('normalizeWindowMode', () => {
  it.each([['auth'], ['normal']])('accepts %s', mode => {
    expect(normalizeWindowMode(mode)).toBe(mode)
  })

  it.each([[''], ['AUTH'], [null], [undefined], [{}], [0], ['__proto__']])('rejects %s', raw => {
    expect(normalizeWindowMode(raw)).toBeNull()
  })
})

// The full state lifecycle the renderer drives (see use-auth-window-mode.ts):
// loading → (auth view unmounted, no mode change at all)
// signed_out → auth; signing_in / error / expired → still auth (no thrash);
// signed_in restored → normal, with the user's geometry intact.
describe('auth window mode lifecycle', () => {
  it('shrinks and centres on entering the gate, and restores exactly on leaving', () => {
    const { state, win } = fakeWindow()
    const { controller, set } = controllerFor(win)

    expect(set('auth')).toEqual({ mode: 'auth', ok: true })
    expect(controller.isAuthMode()).toBe(true)
    expect(state.bounds.width).toBe(ATUM_AUTH_WINDOW_WIDTH)
    expect(state.bounds.height).toBe(ATUM_AUTH_WINDOW_HEIGHT)
    expect(win.setMinimumSize).toHaveBeenCalledWith(460, 600)
    expect(win.setMinimumSize.mock.invocationCallOrder[0]).toBeLessThan(win.setBounds.mock.invocationCallOrder[0])

    if (process.platform === 'darwin') {
      expect(win.setWindowButtonPosition).toHaveBeenLastCalledWith({ x: 18, y: 18 })
    }

    // A fixed-size credential window: no edge-drag on empty transparent gutter.
    expect(state.resizable).toBe(false)
    expect(state.maximizable).toBe(false)

    expect(set('normal')).toEqual({ mode: 'normal', ok: true })
    expect(controller.isAuthMode()).toBe(false)
    expect(state.bounds).toEqual(NORMAL)
    expect(state.resizable).toBe(true)
    expect(state.maximizable).toBe(true)
    expect(win.setMinimumSize).toHaveBeenLastCalledWith(400, 620)
    expect(win.setMinimumSize.mock.invocationCallOrder[1]).toBeLessThan(win.setBounds.mock.invocationCallOrder[1])

    if (process.platform === 'darwin') {
      expect(win.setWindowButtonPosition).toHaveBeenLastCalledWith({ x: 20, y: 17 })
    } else {
      expect(win.setWindowButtonPosition).not.toHaveBeenCalled()
    }
  })

  it('does not resize again while signing_in / error / expired keep the gate mounted', () => {
    const { state, win } = fakeWindow()
    const { changes, set } = controllerFor(win)

    set('auth')
    const afterEnter = { ...state.bounds }

    expect(set('auth')).toEqual({ mode: 'auth', ok: true })
    expect(state.bounds).toEqual(afterEnter)
    // A repeated request is a no-op, not a second transition.
    expect(changes).toEqual(['auth'])
  })

  it('restores a maximized window as maximized, with its pre-maximize frame intact', () => {
    const { state, win } = fakeWindow()

    state.maximized = true
    state.bounds = { height: 1000, width: 1600, x: 0, y: 25 }

    const { set } = controllerFor(win)

    // Entering un-maximizes first, so the captured frame is the user's real
    // geometry rather than the maximized rect.
    state.bounds = { ...NORMAL }
    set('auth')

    expect(state.maximized).toBe(false)
    expect(state.bounds.width).toBe(ATUM_AUTH_WINDOW_WIDTH)

    set('normal')

    expect(state.maximized).toBe(true)
    expect(state.bounds).toEqual(NORMAL)
  })

  it('leaves a full-screen window alone but still suppresses geometry persistence', () => {
    const { state, win } = fakeWindow()

    state.fullScreen = true

    const { controller, set } = controllerFor(win)

    set('auth')

    expect(controller.isAuthMode()).toBe(true)
    expect(state.bounds).toEqual(NORMAL)
    expect(state.resizable).toBe(true)

    set('normal')

    expect(controller.isAuthMode()).toBe(false)
    expect(state.bounds).toEqual(NORMAL)
    expect(win.setMinimumSize).not.toHaveBeenCalled()
    expect(win.setWindowButtonPosition).not.toHaveBeenCalled()
  })

  it('takes a full-screen window out of full screen, then compacts it, and gives full screen back', () => {
    const { state, win } = fakeWindow()
    const left: Array<() => void> = []

    const full = Object.assign(win, {
      setFullScreen: vi.fn((flag: boolean) => {
        // Entering is immediate here; leaving finishes when macOS's animation ends.
        if (flag) {
          state.fullScreen = true
        }
      }),
      once: vi.fn((_event: 'leave-full-screen', listener: () => void) => left.push(listener))
    })

    state.fullScreen = true
    state.bounds = { height: 1000, width: 1600, x: 0, y: 25 }
    const { controller, set } = controllerFor(full)

    expect(set('auth')).toEqual({ mode: 'auth', ok: true })
    expect(controller.isAuthMode()).toBe(true)
    expect(full.setFullScreen).toHaveBeenCalledWith(false)
    // No bounds while the space animation runs: macOS would ignore them.
    expect(win.setBounds).not.toHaveBeenCalled()

    state.fullScreen = false
    state.bounds = { ...NORMAL }
    left.splice(0).forEach(listener => listener())
    expect(state.bounds.width).toBe(ATUM_AUTH_WINDOW_WIDTH)
    expect(state.bounds.height).toBe(ATUM_AUTH_WINDOW_HEIGHT)
    expect(state.resizable).toBe(false)

    set('normal')
    expect(state.bounds).toEqual(NORMAL)
    expect(state.resizable).toBe(true)
    expect(full.setFullScreen).toHaveBeenLastCalledWith(true)
    expect(state.fullScreen).toBe(true)
  })

  it('compacts nothing when full screen ends after the account steps already finished', () => {
    const { state, win } = fakeWindow()
    const left: Array<() => void> = []

    const full = Object.assign(win, {
      setFullScreen: vi.fn(),
      once: vi.fn((_event: 'leave-full-screen', listener: () => void) => left.push(listener))
    })

    state.fullScreen = true
    const { set } = controllerFor(full)

    set('auth')
    set('normal')
    state.fullScreen = false
    left.splice(0).forEach(listener => listener())
    expect(win.setBounds).not.toHaveBeenCalled()
    expect(state.resizable).toBe(true)
  })

  it('logs a compact frame that fails after full screen, rather than swallowing it', () => {
    const { state, win } = fakeWindow()
    const left: Array<() => void> = []
    const log = vi.fn()

    const full = Object.assign(win, {
      setFullScreen: vi.fn(),
      once: vi.fn((_event: 'leave-full-screen', listener: () => void) => left.push(listener))
    })

    win.setBounds.mockImplementation(() => {
      throw new Error('display gone')
    })
    state.fullScreen = true

    const controller = createAtumWindowModeController({
      getWindow: () => full,
      getWorkArea: () => WORK_AREA,
      isOwnerSender: () => true,
      log
    })

    controller.handleSetMode({ sender: 'primary' }, { mode: 'auth' })
    left.splice(0).forEach(listener => listener())
    expect(log).toHaveBeenCalledWith(expect.stringContaining('display gone'))
  })

  it('signals main only on a committed transition so real geometry is re-flushed', () => {
    const { win } = fakeWindow()
    const { changes, set } = controllerFor(win)

    set('auth')
    set('normal')

    expect(changes).toEqual(['auth', 'normal'])
  })
})

describe('auth window mode safety', () => {
  it('rejects any sender that is not the primary window — pop-outs cannot resize the app', () => {
    const { state, win } = fakeWindow()
    const { controller, set } = controllerFor(win)

    expect(set('auth', 'session-popout')).toEqual({ error: 'not-main-window', ok: false })
    expect(controller.isAuthMode()).toBe(false)
    expect(state.bounds).toEqual(NORMAL)
  })

  it('rejects a destroyed window', () => {
    const { state, win } = fakeWindow()

    state.destroyed = true

    expect(controllerFor(win).set('auth')).toEqual({ error: 'not-main-window', ok: false })
  })

  it('rejects a malformed mode without touching the window', () => {
    const { state, win } = fakeWindow()
    const { set } = controllerFor(win)

    expect(set('maximize')).toEqual({ error: 'invalid-mode', ok: false })
    expect(state.bounds).toEqual(NORMAL)
  })

  it('reports a failed transition instead of stranding the window in auth mode', () => {
    const { win } = fakeWindow()

    win.setBounds.mockImplementation(() => {
      throw new Error('nope')
    })

    const log = vi.fn()

    const controller = createAtumWindowModeController({
      getWindow: () => win,
      getWorkArea: () => WORK_AREA,
      isOwnerSender: () => true,
      log
    })

    expect(controller.handleSetMode({ sender: 'primary' }, { mode: 'auth' })).toEqual({
      error: 'transition-failed',
      ok: false
    })
    expect(log).toHaveBeenCalledOnce()
  })

  it('reset() drops a stale auth mode so a recreated window persists geometry again', () => {
    const { win } = fakeWindow()
    const { controller, set } = controllerFor(win)

    set('auth')
    expect(controller.isAuthMode()).toBe(true)

    controller.reset()
    expect(controller.isAuthMode()).toBe(false)
  })
})
