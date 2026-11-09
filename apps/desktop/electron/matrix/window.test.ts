import { describe, expect, it, vi } from 'vitest'

import { MATRIX_WINDOW_CHANNELS, type MatrixWindowAppearance } from '../../shared/matrix-window'
import { ATUM_AUTH_WINDOW_HEIGHT, ATUM_AUTH_WINDOW_WIDTH, type Bounds } from '../atum-window-mode'

import {
  installMatrixWindow,
  MATRIX_WINDOW_DEFAULT_HEIGHT,
  MATRIX_WINDOW_DEFAULT_WIDTH,
  MATRIX_WINDOW_TRANSPARENT_BACKGROUND,
  MATRIX_WINDOW_VIBRANCY,
  matrixWindowOptions
} from './window'

const NORMAL: Bounds = { height: 800, width: 1220, x: 100, y: 80 }
const WORK_AREA = { height: 900, width: 1600, x: 0, y: 20 }

function fakeWindow(initial: Bounds = NORMAL) {
  const listeners = new Map<string, Set<() => void>>()

  const state = {
    bounds: { ...initial },
    destroyed: false,
    fullscreen: false,
    maximized: false,
    minimumHeight: 620,
    minimumWidth: 400,
    resizable: true
  }

  const window = {
    getBounds: () => ({ ...state.bounds }),
    getWindowButtonPosition: () => ({ x: 12, y: 13 }),
    isDestroyed: () => state.destroyed,
    isFullScreen: () => state.fullscreen,
    isMaximized: () => state.maximized,
    isResizable: () => state.resizable,
    maximize: vi.fn(() => {
      state.maximized = true
    }),
    on: vi.fn((event: string, listener: () => void) => {
      const rows = listeners.get(event) ?? new Set()
      rows.add(listener)
      listeners.set(event, rows)
    }),
    removeListener: vi.fn((event: string, listener: () => void) => listeners.get(event)?.delete(listener)),
    setBounds: vi.fn((bounds: Bounds) => {
      state.bounds = {
        ...bounds,
        width: Math.max(bounds.width, state.minimumWidth),
        height: Math.max(bounds.height, state.minimumHeight)
      }
    }),
    setMaximizable: vi.fn(),
    setMinimumSize: vi.fn((width: number, height: number) => {
      state.minimumWidth = width
      state.minimumHeight = height
    }),
    setResizable: vi.fn((value: boolean) => {
      state.resizable = value
    }),
    setWindowButtonPosition: vi.fn(),
    unmaximize: vi.fn(() => {
      state.maximized = false
    })
  }

  return {
    emit: (event: string) => listeners.get(event)?.forEach(listener => listener()),
    state,
    window
  }
}

function installed(
  sender: unknown = 'ui',
  log?: (message: string) => void,
  setNativeAppearance: (appearance: MatrixWindowAppearance) => void = () => {},
  onModeChosen?: () => void
) {
  const instance = fakeWindow()
  const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()

  const ipc = {
    handle: vi.fn((channel: string, handler: (event: { sender: unknown }, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel))
  }

  const published: unknown[] = []

  const helper = installMatrixWindow({
    getWindow: () => instance.window,
    getWorkArea: () => WORK_AREA,
    ipc,
    isUiSender: candidate => candidate === sender,
    overlayWidth: () => 144,
    platform: 'darwin',
    publishFacts: facts => published.push(facts),
    setNativeAppearance,
    ...(log ? { log } : {}),
    ...(onModeChosen ? { onModeChosen } : {})
  })

  return {
    ...instance,
    callFacts: (from: unknown = sender) => handlers.get(MATRIX_WINDOW_CHANNELS.facts)!({ sender: from }),
    callMode: (mode: unknown, from: unknown = sender) =>
      handlers.get(MATRIX_WINDOW_CHANNELS.setMode)!({ sender: from }, mode),
    callAppearance: (appearance: unknown, from: unknown = sender) =>
      handlers.get(MATRIX_WINDOW_CHANNELS.setAppearance)!({ sender: from }, appearance),
    handlers,
    helper,
    ipc,
    published
  }
}

describe('matrixWindowOptions', () => {
  it('uses current product dimensions and Atum native chrome/material', () => {
    const options = matrixWindowOptions({
      platform: 'darwin',
      title: 'Atum',
      titleBarOverlay: { height: 40 },
      webPreferences: { preload: '/matrix-preload.js' }
    })

    expect(options).toMatchObject({
      width: MATRIX_WINDOW_DEFAULT_WIDTH,
      height: MATRIX_WINDOW_DEFAULT_HEIGHT,
      minWidth: 400,
      minHeight: 620,
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 20, y: 17 },
      transparent: false,
      vibrancy: MATRIX_WINDOW_VIBRANCY,
      backgroundColor: MATRIX_WINDOW_TRANSPARENT_BACKGROUND
    })
  })

  it('keeps native overlay input and an opaque product ground outside macOS', () => {
    const options = matrixWindowOptions({
      backgroundColor: '#17181C',
      platform: 'linux',
      title: 'Atum',
      titleBarOverlay: false,
      webPreferences: {}
    })

    expect(options.titleBarOverlay).toBe(false)
    expect(options.vibrancy).toBeUndefined()
    expect(options.trafficLightPosition).toBeUndefined()
    expect(options.backgroundColor).toBe('#17181C')
  })
})

describe('installMatrixWindow', () => {
  it('publishes only minimal native facts and rejects a foreign sender', () => {
    const subject = installed()

    expect(subject.callFacts()).toEqual({
      platform: 'darwin',
      isFullscreen: false,
      windowButtonPosition: { x: 12, y: 13 },
      overlayWidth: 144
    })
    expect(() => subject.callFacts('sdk-host')).toThrow('matrix_window_not_authorized')
    expect(subject.callMode('auth', 'sdk-host')).toEqual({ error: 'not-main-window', ok: false })
    expect(subject.state.bounds).toEqual(NORMAL)
  })

  it('logs a refused size request instead of leaving the window silently at the wrong size', () => {
    const log = vi.fn()
    const subject = installed('ui', log)

    subject.callMode('auth', 'sdk-host')
    subject.callMode('fullscreen')
    expect(log).toHaveBeenCalledTimes(2)
    expect(log.mock.calls[0]![0]).toContain('not-main-window')
    expect(log.mock.calls[1]![0]).toContain('invalid-mode')
    subject.callMode('auth')
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('says when the window has chosen its size, so main can show it at that size', () => {
    const chosen = vi.fn()
    const subject = installed('ui', undefined, undefined, chosen)

    // A foreign sender or a value that is not a mode chooses nothing.
    subject.callMode('auth', 'sdk-host')
    subject.callMode('fullscreen')
    expect(chosen).not.toHaveBeenCalled()

    // The product window it already has counts: nothing to resize, but the choice is made.
    expect(subject.callMode('normal')).toEqual({ mode: 'normal', ok: true })
    expect(chosen).toHaveBeenCalledOnce()
    subject.callMode('auth')
    expect(chosen).toHaveBeenCalledTimes(2)
  })

  it('enters compact auth and restores normal product geometry', () => {
    const subject = installed()
    const initialPublishes = subject.published.length

    expect(subject.callMode('auth')).toEqual({ mode: 'auth', ok: true })
    expect(subject.helper.isAuthMode()).toBe(true)
    expect(subject.state.bounds.width).toBe(ATUM_AUTH_WINDOW_WIDTH)
    expect(subject.state.bounds.height).toBe(ATUM_AUTH_WINDOW_HEIGHT)
    expect(subject.published).toHaveLength(initialPublishes + 1)

    expect(subject.callMode('normal')).toEqual({ mode: 'normal', ok: true })
    expect(subject.helper.isAuthMode()).toBe(false)
    expect(subject.state.bounds).toEqual(NORMAL)
    expect(subject.published).toHaveLength(initialPublishes + 2)
  })

  it('preserves maximized and fullscreen user-owned window state', () => {
    const maximized = installed()
    maximized.state.maximized = true

    expect(maximized.callMode('auth')).toEqual({ mode: 'auth', ok: true })
    expect(maximized.callMode('normal')).toEqual({ mode: 'normal', ok: true })
    expect(maximized.state.maximized).toBe(true)
    expect(maximized.state.bounds).toEqual(NORMAL)

    const fullscreen = installed()
    fullscreen.state.fullscreen = true
    expect(fullscreen.callMode('auth')).toEqual({ mode: 'auth', ok: true })
    expect(fullscreen.state.bounds).toEqual(NORMAL)
    expect(fullscreen.callMode('normal')).toEqual({ mode: 'normal', ok: true })
    expect(fullscreen.state.bounds).toEqual(NORMAL)
  })

  it("pins the native appearance to the shell's choice, from the UI only and only to a known value", () => {
    const pin = vi.fn()
    const subject = installed('ui', undefined, pin)

    for (const appearance of ['dark', 'light', 'system'] as const) {
      subject.callAppearance(appearance)
    }

    expect(pin.mock.calls).toEqual([['dark'], ['light'], ['system']])

    pin.mockClear()
    expect(() => subject.callAppearance('dark', 'sdk-host')).toThrow('matrix_window_not_authorized')

    for (const invalid of ['', 'auto', 'DARK', 1, null, undefined, { appearance: 'dark' }]) {
      expect(() => subject.callAppearance(invalid)).toThrow('matrix_window_appearance_invalid')
    }

    expect(pin).not.toHaveBeenCalled()
  })

  it('publishes fullscreen updates and removes all handlers/listeners on dispose', () => {
    const subject = installed()
    const initialPublishes = subject.published.length

    subject.state.fullscreen = true
    subject.emit('enter-full-screen')
    expect(subject.published).toHaveLength(initialPublishes + 1)
    expect(subject.published.at(-1)).toMatchObject({ isFullscreen: true })

    subject.helper.dispose()
    expect(subject.handlers.size).toBe(0)
    expect(subject.ipc.removeHandler).toHaveBeenCalledWith(MATRIX_WINDOW_CHANNELS.facts)
    expect(subject.ipc.removeHandler).toHaveBeenCalledWith(MATRIX_WINDOW_CHANNELS.setMode)
    expect(subject.ipc.removeHandler).toHaveBeenCalledWith(MATRIX_WINDOW_CHANNELS.setAppearance)
    expect(subject.window.removeListener).toHaveBeenCalledTimes(2)
    expect(subject.helper.isAuthMode()).toBe(false)
  })
})
