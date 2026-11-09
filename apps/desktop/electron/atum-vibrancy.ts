// atum-vibrancy.ts — main-process half of the panel-local glass bridge.
//
// The renderer measures each top-level frosted Atum surface (rim, rail,
// roster, chat, workspace, auth, startup) and posts top-left-origin CSS-point
// rects here, each tagged with the density band it wants. This module
// validates and clamps that renderer-supplied geometry, then forwards it to
// the native `atum_vibrancy` addon, which reconciles one NSVisualEffectView
// per surface BEHIND the web content. The same rectangles subtract those
// panels from one low-alpha, neutral effect view, leaving real optical
// softening only in inter-panel seams. Its outer envelope is the union of the
// panel bounds, so the outer window gutter remains raw transparent.
//
// Interior surfaces (the composer, which lives inside the transcript plate)
// are deliberately absent: native glass sits behind ALL web content, so it
// cannot blur the transcript scrolling above the composer, and stacking it
// under two painted CSS tints only darkens the panel.
//
// Everything Electron-shaped (ipcMain, BrowserWindow, the window getter) is
// injected so the normalization, lifecycle, and fallback logic run under
// plain node in the test suite.

import { existsSync } from 'node:fs'
import { createRequire as createNodeRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Density bands the renderer may ask for; see src/app/atum/vibrancy.ts. */
export type AtumVibrancyMaterial = 'regular' | 'thick' | 'thin'

/**
 * Wire ordinals for the density bands. The renderer speaks names (self-
 * describing across an IPC boundary and in a devtools payload dump); the addon
 * reads a small integer, so an unknown or hostile string can never reach a
 * `NSVisualEffectMaterial` lookup. Ordinals are ordered thin → thick.
 */
export const ATUM_VIBRANCY_MATERIALS: Readonly<Record<AtumVibrancyMaterial, number>> = {
  regular: 1,
  thick: 2,
  thin: 0
}

/** An older renderer sends no material; mid-band is the safe, neutral default. */
export const DEFAULT_VIBRANCY_MATERIAL = ATUM_VIBRANCY_MATERIALS.regular

export interface AtumVibrancyRegion {
  height: number
  material: number
  radius: number
  width: number
  x: number
  y: number
}

export interface AtumVibrancyFrame {
  dark: boolean
  regions: AtumVibrancyRegion[]
}

/** The N-API surface of native/atum-vibrancy (see src/atum_vibrancy.mm). */
export interface AtumVibrancyBridge {
  attach: (handle: Buffer) => boolean
  detach: (handle: Buffer) => void
  setRegions: (handle: Buffer, regions: AtumVibrancyRegion[], dark: boolean) => boolean
}

/** Minimal window shape the controller needs — a BrowserWindow satisfies it. */
export interface AtumVibrancyWindow {
  getContentSize: () => [number, number]
  getNativeWindowHandle: () => Buffer
  isDestroyed: () => boolean
}

interface IpcMainLike {
  handle: (channel: string, listener: (_event: unknown, ...args: any[]) => unknown) => void
  removeHandler?: (channel: string) => void
}

export const ATUM_VIBRANCY_IPC_CHANNEL = 'atum:vibrancy:set-regions'

/** Hard cap against a hostile/buggy renderer flooding the native reconcile. */
export const MAX_VIBRANCY_REGIONS = 24

/** The product radius (`--atum-r-surface`) when a region omits one. */
export const DEFAULT_VIBRANCY_RADIUS = 14

const round3 = (value: number): number => Math.round(value * 1000) / 1000

/** Allowlist-only: anything that is not an exact band name is mid-band. Uses
 *  an own-property check so `constructor`/`toString` cannot smuggle a value. */
function normalizeMaterial(raw: unknown): number {
  if (typeof raw !== 'string' || !Object.hasOwn(ATUM_VIBRANCY_MATERIALS, raw)) {
    return DEFAULT_VIBRANCY_MATERIAL
  }

  return ATUM_VIBRANCY_MATERIALS[raw as AtumVibrancyMaterial]
}

/**
 * Validate and clamp one renderer payload against the live content size.
 * Returns null only when the payload is structurally not a frame at all
 * (non-object, missing/non-array `regions`); individual bad entries are
 * dropped so one malformed region can never strip the rest of the glass.
 */
export function normalizeVibrancyRegions(payload: unknown, content: { height: number; width: number }): AtumVibrancyFrame | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }

  const record = payload as Record<string, unknown>

  if (!Array.isArray(record.regions)) {
    return null
  }

  const regions: AtumVibrancyRegion[] = []

  for (const entry of record.regions.slice(0, MAX_VIBRANCY_REGIONS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue
    }

    const raw = entry as Record<string, unknown>
    const x = Number(raw.x)
    const y = Number(raw.y)
    const width = Number(raw.width)
    const height = Number(raw.height)

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      continue
    }

    if (width <= 0 || height <= 0) {
      continue
    }

    // Clamp to the content bounds; a rect pushed fully outside drops away
    // rather than pinning glass over a seam it no longer matches.
    const left = Math.min(Math.max(x, 0), content.width)
    const top = Math.min(Math.max(y, 0), content.height)
    const right = Math.min(Math.max(x + width, 0), content.width)
    const bottom = Math.min(Math.max(y + height, 0), content.height)

    if (right - left <= 0 || bottom - top <= 0) {
      continue
    }

    let radius = Number(raw.radius)

    if (!Number.isFinite(radius) || radius < 0) {
      radius = DEFAULT_VIBRANCY_RADIUS
    }

    // A radius beyond half the smaller edge is not a rounded rect — AppKit
    // would render a stadium that spills past the panel's own border-radius.
    radius = Math.min(radius, (right - left) / 2, (bottom - top) / 2)

    regions.push({
      height: round3(bottom - top),
      material: normalizeMaterial(raw.material),
      radius: round3(radius),
      width: round3(right - left),
      x: round3(left),
      y: round3(top)
    })
  }

  return { dark: record.dark === true, regions }
}

/**
 * Where the compiled addon can live, in trust order:
 *   1. dist/node_modules — the staged copy (`stage-native-deps.mjs`), which is
 *      what packaged builds and `npm run build`-prepared dev runs load.
 *   2. native/atum-vibrancy/build/Release — a direct in-tree node-gyp build.
 * `baseDir` is injectable so tests can point at a fixture tree.
 */
export function vibrancyBinaryCandidates(baseDir?: string): string[] {
  const here = baseDir ?? dirname(fileURLToPath(import.meta.url))

  return [
    resolve(here, 'node_modules/atum-vibrancy/build/Release/atum_vibrancy.node'),
    resolve(here, '../native/atum-vibrancy/build/Release/atum_vibrancy.node')
  ]
}

type RequireLike = (id: string) => unknown

/** Load the first candidate that exists, exports the full N-API surface, and
 *  actually `require()`s. Anything else falls through to the CSS fallback. */
export function loadAtumVibrancyBridge(
  candidates: string[] = vibrancyBinaryCandidates(),
  requireImpl: RequireLike = createNodeRequire(import.meta.url)
): AtumVibrancyBridge | null {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue
    }

    try {
      const mod = requireImpl(candidate) as Partial<AtumVibrancyBridge>

      if (
        typeof mod.attach === 'function' &&
        typeof mod.setRegions === 'function' &&
        typeof mod.detach === 'function'
      ) {
        return mod as AtumVibrancyBridge
      }
    } catch {
      continue
    }
  }

  return null
}

interface AtumVibrancyControllerDeps {
  getWindow: () => AtumVibrancyWindow | null
  isMac: boolean
  isOwnerSender: (sender: unknown) => boolean
  loadBridge?: () => AtumVibrancyBridge | null
  log?: (message: string) => void
}

export interface AtumVibrancyController {
  detach: () => void
  handleSetRegions: (event: { sender: unknown }, payload: unknown) => { error?: string; ok: boolean; regions?: number }
}

export function createAtumVibrancyController(deps: AtumVibrancyControllerDeps): AtumVibrancyController {
  const loadBridge = deps.loadBridge ?? (() => loadAtumVibrancyBridge())
  // `undefined` = not probed yet; the probe result is cached for the process.
  let bridge: AtumVibrancyBridge | null | undefined
  let attachedHandle: Buffer | null = null
  let warnedUnavailable = false

  const probe = (): AtumVibrancyBridge | null => {
    if (bridge === undefined) {
      bridge = loadBridge()

      if (!bridge && !warnedUnavailable) {
        warnedUnavailable = true
        deps.log?.('[vibrancy] native atum_vibrancy module unavailable — keeping CSS-only glass fallback')
      }
    }

    return bridge ?? null
  }

  const handleSetRegions: AtumVibrancyController['handleSetRegions'] = (event, payload) => {
    if (!deps.isMac) {
      return { error: 'unsupported-platform', ok: false }
    }

    const win = deps.getWindow()

    // Only the primary window hosts the Atum shell. Session pop-outs and peer
    // instance windows keep the CSS fallback rather than attaching glass to a
    // window the renderer did not measure.
    if (!win || win.isDestroyed() || !deps.isOwnerSender(event?.sender)) {
      return { error: 'not-main-window', ok: false }
    }

    const [width, height] = win.getContentSize()
    const frame = normalizeVibrancyRegions(payload, { height, width })

    if (!frame) {
      return { error: 'invalid-payload', ok: false }
    }

    const native = probe()

    if (!native) {
      return { error: 'native-unavailable', ok: false }
    }

    try {
      const handle = win.getNativeWindowHandle()

      if (!attachedHandle || !attachedHandle.equals(handle)) {
        // Window recreation (dock re-activate) lands here: the old views died
        // with the old window, so attach is validation, not double-attachment.
        if (!native.attach(handle)) {
          return { error: 'attach-failed', ok: false }
        }

        attachedHandle = handle
      }

      if (!native.setRegions(handle, frame.regions, frame.dark)) {
        return { error: 'native-rejected', ok: false }
      }

      return { ok: true, regions: frame.regions.length }
    } catch (error) {
      deps.log?.(`[vibrancy] native call failed: ${error instanceof Error ? error.message : String(error)}`)

      return { error: 'native-error', ok: false }
    }
  }

  const detach = (): void => {
    if (attachedHandle && bridge) {
      try {
        bridge.detach(attachedHandle)
      } catch (error) {
        deps.log?.(`[vibrancy] native detach failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    attachedHandle = null
  }

  return { detach, handleSetRegions }
}

export function registerAtumVibrancyIpc(ipc: IpcMainLike, controller: AtumVibrancyController): () => void {
  ipc.handle(ATUM_VIBRANCY_IPC_CHANNEL, controller.handleSetRegions)

  return () => ipc.removeHandler?.(ATUM_VIBRANCY_IPC_CHANNEL)
}
