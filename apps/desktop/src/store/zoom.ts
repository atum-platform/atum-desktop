/**
 * Window text size (zoom).
 *
 * The main process owns the zoom level and persists it (see electron/zoom.ts
 * for the scale). The renderer only mirrors the current percent for the
 * settings UI: preset clicks go to the main process over IPC, and every
 * change comes back through onChanged, including ones made with the
 * Ctrl/Cmd +/-/0 shortcuts or the View menu, so the UI never drifts.
 */

import { atom } from 'nanostores'

import { readKey } from '@/lib/storage'

export const $zoomPercent = atom<number>(100)

// The 34px title rim aligns with native macOS traffic lights, which do not
// participate in Electron zoom. Keep the consumer slider intentionally tight;
// the full power-user zoom controls remain under Advanced.
export const TEXT_SIZE_MIN_PERCENT = 90
export const TEXT_SIZE_MAX_PERCENT = 110
export const TEXT_SIZE_STEP_PERCENT = 10

// Electron persists the zoom *level* in this renderer-owned key. Keep the
// conversion here so account preference sync never reaches into main-process
// persistence or guesses whether the default was a deliberate setting.
const ZOOM_STORAGE_KEY = 'hermes:desktop:zoomLevel'
const ZOOM_FACTOR_BASE = 1.2

export function storedZoomPercent(): null | number {
  const raw = readKey(ZOOM_STORAGE_KEY)
  const level = raw === null ? Number.NaN : Number(raw)

  return Number.isFinite(level) && level >= -9 && level <= 9
    ? Math.round(Math.pow(ZOOM_FACTOR_BASE, level) * 100)
    : null
}

export function normalizeTextSizeSliderPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 100
  }

  return Math.min(TEXT_SIZE_MAX_PERCENT, Math.max(TEXT_SIZE_MIN_PERCENT, Math.round(percent)))
}

export function setZoomPercent(percent: number): void {
  // Update immediately so the range control tracks the pointer even before
  // the native bridge echoes the actually-applied value back. The main process
  // remains authoritative and its onChanged event corrects any difference.
  $zoomPercent.set(percent)
  window.hermesDesktop?.zoom?.setPercent(percent)
}

if (typeof window !== 'undefined' && window.hermesDesktop?.zoom) {
  void window.hermesDesktop.zoom.get().then(({ percent }) => $zoomPercent.set(percent))
  window.hermesDesktop.zoom.onChanged(({ percent }) => $zoomPercent.set(percent))
}
