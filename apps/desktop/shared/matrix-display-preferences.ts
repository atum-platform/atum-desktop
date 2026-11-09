import { type DesktopLocale, isDesktopLocale } from './desktop-locale'

/** Human-owned desktop choices, never agent configuration or execution authority. */
export type MatrixAppearanceMode = 'system' | 'light' | 'dark'
export type MatrixTextSize = 90 | 100 | 110
export const MATRIX_DISPLAY_EVENTS = {
  appearance: 'io.atum.desktop.appearance',
  textSize: 'io.atum.desktop.text_size',
  language: 'io.atum.desktop.language',
  notifications: 'io.atum.desktop.notifications',
  sound: 'io.atum.desktop.sound',
  shareActivity: 'io.atum.desktop.share_activity'
} as const

export function matrixDisplayMode(preference: MatrixAppearanceMode = 'system', systemDark: boolean) {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
}

export interface MatrixDisplayPreferences {
  appearance: { value: MatrixAppearanceMode; writable: boolean }
  textSize: { value: MatrixTextSize; writable: boolean }
  language?: { value: DesktopLocale; writable: boolean }
  notifications?: { value: boolean; writable: boolean }
  sound?: { value: boolean; writable: boolean }
  /** Preserve user-visible identity, state and recovery behavior across connection changes. */
  shareActivity?: { value: boolean; writable: boolean }
}

export type MatrixDisplayPreferenceChange =
  | { field: 'appearance'; value: MatrixAppearanceMode }
  | { field: 'textSize'; value: MatrixTextSize }
  | { field: 'language'; value: DesktopLocale }
  | { field: 'notifications' | 'sound' | 'shareActivity'; value: boolean }

export function matrixDisplayPreferenceChange(field: unknown, value: unknown): MatrixDisplayPreferenceChange {
  if (field === 'appearance' && (value === 'system' || value === 'light' || value === 'dark')) {
    return { field, value }
  }

  if (field === 'textSize' && (value === 90 || value === 100 || value === 110)) {
    return { field, value }
  }

  if (field === 'language' && isDesktopLocale(value)) {
    return { field, value }
  }

  if (
    (field === 'notifications' || field === 'sound' || field === 'shareActivity') &&
    typeof value === 'boolean'
  ) {
    return { field, value }
  }

  throw new Error('matrix_display_preference_invalid')
}
