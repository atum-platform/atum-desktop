import type { GuiAuthorizeRequest } from './gui-broker'

export interface ConsentRegion { x: number; y: number; width: number; height: number }

/** Keyboard shortcuts and AX identifiers can reach any answer in the target window. */
export function hitsConsent(request: GuiAuthorizeRequest, regions: readonly ConsentRegion[]): boolean {
  if (!regions.length) { return false }
  const point = request.destination

  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) { return true }

  if (!['click', 'double_click', 'right_click', 'mouse_down', 'mouse_up', 'drag'].includes(request.action)) { return true }

  return regions.some(r => point.x >= r.x && point.y >= r.y && point.x <= r.x + r.width && point.y <= r.y + r.height)
}

/** Holds the existing pause until the last native modal is dismissed. */
export function createModalPause(paused: () => boolean, setPaused: (value: boolean) => void) {
  let depth = 0
  let restore = false

  return async <T>(present: () => Promise<T>): Promise<T> => {
    if (depth++ === 0) { restore = paused(); setPaused(true) }

    try { return await present() } finally { if (--depth === 0) { setPaused(restore) } }
  }
}

/** Native consent hosts register before display and release only on destruction. */
export const nativeConsentWindows = new Set<number>()

export function registerNativeConsent(window: { getMediaSourceId(): string; once(event: 'closed', listener: () => void): unknown }) {
  const id = Number(window.getMediaSourceId().split(':')[1])
  nativeConsentWindows.add(id)
  window.once('closed', () => nativeConsentWindows.delete(id))
}
