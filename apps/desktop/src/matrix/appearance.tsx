import { useEffect } from 'react'

import { useMediaQuery } from '@/hooks/use-media-query'
import { applyTheme, baseColors } from '@/themes/appearance'
import { BUILTIN_THEMES, DEFAULT_SKIN_NAME, DEFAULT_TYPOGRAPHY } from '@/themes/presets'

import { type MatrixAppearanceMode, matrixDisplayMode } from '../../shared/matrix-display-preferences'

/** Called by the bundled module; no inline script or weaker CSP required. */
export function applyMatrixMaterial(platform = navigator.platform) {
  if (/mac/i.test(platform)) {
    document.documentElement.dataset.atumVibrancy = 'sidebar'
  }
}

/**
 * The Atum palette, applied whole (the window and its Workplace pages). The old theme chain
 * mixes every card, popover and input with its own warm neutrals — cream #fbf8f3 in light,
 * a warm black in dark — which leaked Hermes cream into shared controls (the jump-to-latest
 * button, keycaps, input fields, the expert pages' cards). Here the neutrals are Atum's own
 * seeds, so every `--dt-*` / `--ui-*` surface lands on the shell's grey-blue ramp.
 */
export function applyMatrixPalette(mode: 'light' | 'dark') {
  const seed = BUILTIN_THEMES[DEFAULT_SKIN_NAME]
  const colors = baseColors(seed, mode)
  // The isolated UI has no external network capability. Use the existing
  // bundled/system fonts, not applyTheme's legacy Nous Google-font fallback.
  applyTheme({ ...seed, typography: { ...DEFAULT_TYPOGRAPHY, fontUrl: undefined }, colors }, mode)

  const root = document.documentElement
  root.style.setProperty('--theme-neutral-chrome', colors.background)
  root.style.setProperty('--theme-neutral-sidebar', colors.sidebarBackground ?? colors.background)
  root.style.setProperty('--theme-neutral-card', colors.card)
}

/** Same Atum palette/application, without the old profile/gateway synchronizer. */
export function MatrixAppearance({ preference = 'system' }: { preference?: MatrixAppearanceMode }) {
  const dark = useMediaQuery('(prefers-color-scheme: dark)')
  useEffect(() => applyMatrixPalette(matrixDisplayMode(preference, dark)), [dark, preference])

  // The glass under the shell is the window's own material, which follows the native appearance, not this
  // palette. Pin the native appearance to the same choice (`system` stays `system`, so the OS keeps driving
  // both); otherwise a dark palette over a light-mode Mac sits on the light material and reads far too bright.
  useEffect(() => {
    void Promise.resolve(window.atumMatrix?.setWindowAppearance?.(preference)).catch(() => {})
  }, [preference])

  return null
}
