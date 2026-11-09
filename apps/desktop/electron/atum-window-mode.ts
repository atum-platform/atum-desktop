// atum-window-mode.ts — the reversible renderer↔Electron window-mode contract.
//
// The Atum sign-in gate used to render a 400px card in the middle of whatever
// size the product window happened to be (1220x800 by default). Because the
// BrowserWindow is transparent and frameless, the result was a huge invisible
// rectangle that swallowed clicks meant for the desktop behind it, with a small
// form floating in the void. An OS-level sign-in surface should be an OS-level
// window: compact, centered, and obviously intentional.
//
// So entering the auth gate resizes the PRIMARY window to a compact centered
// size, and leaving it restores exactly what was there before. Two invariants
// make that safe:
//
//   1. The compact bounds are NEVER persisted. `window-state.json` is the
//      user's product geometry; overwriting it with 460x640 would shrink the
//      app permanently for anyone who ever signed out. main.ts suppresses
//      persistence while `mode === 'auth'` and flushes the real bounds again
//      on restore.
//   2. Restore is total: bounds, maximized, full screen and resizability all
//      come back. A full-screen window first leaves full screen (macOS ignores
//      new bounds during the space animation), then takes the compact frame;
//      signing in puts it back in full screen. A window that cannot leave full
//      screen keeps its size, and the auth plate stays max-width bounded.
//
// Only the primary window has a mode. Secondary session/instance windows never
// host the gate (they render a single chat), and the IPC handler rejects any
// sender that is not the primary, so a pop-out can never resize the app.
//
// Everything Electron-shaped is injected so the geometry and lifecycle logic
// run under plain node in the test suite.

export type AtumWindowMode = 'auth' | 'normal'

export const ATUM_WINDOW_MODE_IPC_CHANNEL = 'atum:window:set-mode'

/**
 * The compact sign-in window, in CSS points.
 *
 * Sized for the real form — brand mark, heading, one line of body copy, the
 * Google button, the "or" divider, identifier + password fields, the submit
 * button, and the terms line — plus the 10px floating-glass gutter and the
 * macOS traffic-light band. 460 is wide enough that "fixture-8d12b7f58c@example.invalid · 0912…"
 * placeholder text does not truncate and narrow enough to read as a dialog
 * rather than an app window; 600 fits the tallest state (Google + password +
 * an error band + the cancel affordance) with the content scrolling if needed.
 *
 * Atum Shell v2 (SPEC §4) fixes the compact window at 460×600. That is shorter
 * than window-state.ts's MIN_HEIGHT (620), so the controller lowers the
 * minimum size while auth mode is on and restores 400×620 afterwards.
 */
export const ATUM_AUTH_WINDOW_WIDTH = 460
export const ATUM_AUTH_WINDOW_HEIGHT = 600
/** window-state.ts MIN_WIDTH/MIN_HEIGHT, restored when the product window returns. */
export const ATUM_PRODUCT_MIN_WIDTH = 400
export const ATUM_PRODUCT_MIN_HEIGHT = 620

export interface Bounds {
  height: number
  width: number
  x: number
  y: number
}

export interface WorkArea {
  height: number
  width: number
  x: number
  y: number
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * Centre the compact auth window on the display the window is currently on.
 *
 * "Currently on" is resolved from the window's CENTER, not its origin, so a
 * window straddling two monitors lands on the one it mostly occupies. The
 * result is clamped inside the chosen work area, so the compact window can
 * never open under a menu bar / dock / taskbar even on a small display.
 */
export function computeAuthWindowBounds(current: Bounds | null, workArea: WorkArea | null): Bounds {
  const width = Math.min(ATUM_AUTH_WINDOW_WIDTH, workArea && finite(workArea.width) ? workArea.width : Infinity)
  const height = Math.min(ATUM_AUTH_WINDOW_HEIGHT, workArea && finite(workArea.height) ? workArea.height : Infinity)

  // No work area (headless / odd display state): centre on the window we have.
  if (!workArea || !finite(workArea.x) || !finite(workArea.y) || !finite(workArea.width) || !finite(workArea.height)) {
    if (!current) {
      return { height, width, x: 0, y: 0 }
    }

    return {
      height,
      width,
      x: Math.round(current.x + (current.width - width) / 2),
      y: Math.round(current.y + (current.height - height) / 2)
    }
  }

  const x = Math.round(workArea.x + (workArea.width - width) / 2)
  const y = Math.round(workArea.y + (workArea.height - height) / 2)

  return {
    height,
    width,
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height))
  }
}

/** Only these two values are a mode; anything else is a protocol error. */
export function normalizeWindowMode(raw: unknown): AtumWindowMode | null {
  return raw === 'auth' || raw === 'normal' ? raw : null
}

/** The subset of BrowserWindow the controller drives. */
export interface AtumModeWindow {
  getBounds: () => Bounds
  isDestroyed: () => boolean
  isFullScreen: () => boolean
  isMaximized: () => boolean
  isResizable?: () => boolean
  maximize: () => void
  /** Leaving full screen before the compact frame, re-entering it on restore. */
  setFullScreen?: (flag: boolean) => void
  once?: (event: 'leave-full-screen', listener: () => void) => unknown
  setBounds: (bounds: Bounds, animate?: boolean) => void
  setMaximizable?: (maximizable: boolean) => void
  setResizable?: (resizable: boolean) => void
  /** The auth window is shorter than the product window's own minimum. */
  setMinimumSize?: (width: number, height: number) => void
  /** macOS traffic lights: 18/18 in the compact auth window, on the top row's centre line in the product shell. */
  setWindowButtonPosition?: (position: { x: number; y: number }) => void
  unmaximize: () => void
}

/**
 * The shell's top row — `--atum-l-header` in styles.css. Every column of the
 * shell (rail, roster, chat, workspace) aligns to this continuous chrome band.
 */
export const ATUM_SHELL_HEADER_HEIGHT = 48
/** The macOS traffic-light group is 14px tall. */
export const MACOS_TRAFFIC_LIGHTS_HEIGHT = 14

/**
 * The ONE place the product window's light position is decided. `main.ts`
 * creates the window with it and this controller restores it after the auth
 * window; both used to hold their own copy, and the copies drifted — leaving
 * the auth window put the lights back 7px below the row that had been laid
 * out for them.
 *
 * x: 20 puts the native group in the persistent 52px destination rail. y
 * centres the 14px group in the shared 48px chrome band: (48 - 14) / 2 = 17.
 */
export const ATUM_SHELL_WINDOW_BUTTON_POSITION = {
  x: 20,
  y: (ATUM_SHELL_HEADER_HEIGHT - MACOS_TRAFFIC_LIGHTS_HEIGHT) / 2
}
/** The compact auth window (mock 1c): 18/18, no title band. */
export const ATUM_AUTH_WINDOW_BUTTON_POSITION = { x: 18, y: 18 }

interface AtumWindowModeDeps {
  /** The live primary window, or null when it does not exist yet. */
  getWindow: () => AtumModeWindow | null
  /** The work area of the display the given bounds sit on. */
  getWorkArea: (bounds: Bounds) => WorkArea | null
  /** Only the primary window's renderer may drive the mode. */
  isOwnerSender: (sender: unknown) => boolean
  log?: (message: string) => void
  /** Called after every committed transition so main.ts can flush geometry. */
  onModeChanged?: (mode: AtumWindowMode) => void
  /** Release transient product geometry before auth records its restore frame. */
  beforeAuth?: () => void
}

export interface AtumWindowModeController {
  /** True while the compact auth window is up — geometry MUST NOT persist. */
  isAuthMode: () => boolean
  handleSetMode: (
    event: { sender: unknown },
    payload: unknown
  ) => { error?: string; mode?: AtumWindowMode; ok: boolean }
  /** Force back to normal (window teardown / renderer reload) without IPC. */
  reset: () => void
}

interface RestoreState {
  /** Null while a full-screen window is still leaving its space. */
  bounds: Bounds | null
  maximized: boolean
  resizable: boolean
  fullScreen?: boolean
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createAtumWindowModeController(deps: AtumWindowModeDeps): AtumWindowModeController {
  let mode: AtumWindowMode = 'normal'
  let restore: RestoreState | null = null
  /** Bumped on every transition, so a full-screen exit that lands late compacts nothing. */
  let transition = 0

  const applyNormal = (win: AtumModeWindow): void => {
    const target = restore

    mode = 'normal'
    restore = null
    transition++

    if (!target) {
      return
    }

    win.setResizable?.(target.resizable)
    win.setMaximizable?.(true)
    win.setMinimumSize?.(ATUM_PRODUCT_MIN_WIDTH, ATUM_PRODUCT_MIN_HEIGHT)

    if (process.platform === 'darwin') {
      win.setWindowButtonPosition?.(ATUM_SHELL_WINDOW_BUTTON_POSITION)
    }

    if (target.bounds) {
      if (target.maximized) {
        // Maximized is a window STATE, not bounds: restore the pre-maximize
        // frame first so un-maximizing later still lands where the user sized it.
        win.setBounds(target.bounds)
        win.maximize()
      } else {
        if (win.isMaximized()) {
          win.unmaximize()
        }

        win.setBounds(target.bounds)
      }
    }

    // The person had the product full screen before the account steps: give it back.
    if (target.fullScreen) {
      win.setFullScreen?.(true)
    }
  }

  const applyAuth = (win: AtumModeWindow): void => {
    // A full-screen window would show the sign-in form across the whole screen.
    // Leave full screen first; macOS ignores new bounds until its ~1 s space
    // animation ends, so the compact frame follows on 'leave-full-screen'.
    if (win.isFullScreen()) {
      if (!win.setFullScreen || !win.once) {
        // Nothing to leave full screen with: keep the size, suppress persistence.
        mode = 'auth'
        restore = null

        return
      }

      const resizable = win.isResizable?.() ?? true
      const pending = ++transition

      win.once('leave-full-screen', () => {
        if (pending !== transition || mode !== 'auth' || win.isDestroyed()) {
          return
        }

        try {
          compact(win, { fullScreen: true, resizable })
        } catch (error) {
          deps.log?.(`[window-mode] compact frame after full screen failed: ${errorText(error)}`)
        }
      })
      win.setFullScreen(false)
      mode = 'auth'
      restore = { bounds: null, maximized: false, resizable, fullScreen: true }

      return
    }

    transition++
    compact(win)
  }

  /** The compact centred frame, recording what restore puts back. */
  const compact = (win: AtumModeWindow, from?: { fullScreen: true; resizable: boolean }): void => {
    const maximized = win.isMaximized()

    // getBounds() on a maximized window returns the maximized frame, which is
    // not what we want to come back to. Un-maximize first so we capture the
    // user's real geometry, exactly like getNormalBounds() would.
    if (maximized) {
      win.unmaximize()
    }

    const current = win.getBounds()
    const frame = { height: current.height, width: current.width, x: current.x, y: current.y }

    const next: RestoreState = {
      bounds: frame,
      maximized,
      resizable: from?.resizable ?? win.isResizable?.() ?? true,
      ...(from ? { fullScreen: true } : {})
    }

    // A fixed-size credential window: there is nothing to reflow, and a
    // resizable transparent frame invites edge-drags on empty gutter pixels.
    win.setResizable?.(false)
    win.setMaximizable?.(false)
    const authBounds = computeAuthWindowBounds(frame, deps.getWorkArea(frame))

    // Lower the native minimum BEFORE setting bounds; Electron otherwise
    // clamps the 600px auth card to the product's 620px minimum. Use the
    // computed size so small-display clamping remains effective as well.
    win.setMinimumSize?.(authBounds.width, authBounds.height)

    if (process.platform === 'darwin') {
      win.setWindowButtonPosition?.(ATUM_AUTH_WINDOW_BUTTON_POSITION)
    }

    win.setBounds(authBounds)

    // Committed last: if any call above throws, the controller stays in
    // 'normal' and geometry persistence is NOT left suppressed forever.
    restore = next
    mode = 'auth'
  }

  const handleSetMode: AtumWindowModeController['handleSetMode'] = (event, payload) => {
    const next = normalizeWindowMode((payload as { mode?: unknown } | null)?.mode ?? payload)

    if (!next) {
      return { error: 'invalid-mode', ok: false }
    }

    const win = deps.getWindow()

    if (!win || win.isDestroyed() || !deps.isOwnerSender(event?.sender)) {
      return { error: 'not-main-window', ok: false }
    }

    if (next === mode) {
      return { mode, ok: true }
    }

    try {
      if (next === 'auth') {
        deps.beforeAuth?.()
        applyAuth(win)
      } else {
        applyNormal(win)
      }
    } catch (error) {
      deps.log?.(`[window-mode] ${next} transition failed: ${errorText(error)}`)

      // A half-applied auth entry must not leave the product window pinned
      // non-resizable. Bounds may be wrong, but the window stays usable.
      if (next === 'auth') {
        try {
          win.setResizable?.(true)
          win.setMaximizable?.(true)
          win.setMinimumSize?.(ATUM_PRODUCT_MIN_WIDTH, ATUM_PRODUCT_MIN_HEIGHT)

          if (process.platform === 'darwin') {
            win.setWindowButtonPosition?.(ATUM_SHELL_WINDOW_BUTTON_POSITION)
          }
        } catch {
          // Nothing further to try; the failure is already logged.
        }
      }

      return { error: 'transition-failed', ok: false }
    }

    deps.onModeChanged?.(mode)

    return { mode, ok: true }
  }

  return {
    handleSetMode,
    isAuthMode: () => mode === 'auth',
    reset: () => {
      mode = 'normal'
      restore = null
      transition++
    }
  }
}

interface IpcMainLike {
  handle: (channel: string, listener: (event: any, ...args: any[]) => unknown) => void
  removeHandler?: (channel: string) => void
}

export function registerAtumWindowModeIpc(ipc: IpcMainLike, controller: AtumWindowModeController): () => void {
  ipc.handle(ATUM_WINDOW_MODE_IPC_CHANNEL, controller.handleSetMode)

  return () => ipc.removeHandler?.(ATUM_WINDOW_MODE_IPC_CHANNEL)
}
