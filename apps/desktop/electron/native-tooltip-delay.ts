/**
 * The rail's tips become the system's own tooltip while the Work view sits beside the rail
 * (`TipNative`, src/components/ui/tooltip.tsx): a native view paints above every DOM node, and
 * only a system tooltip floats above it. AppKit waits about a second before it shows one; the
 * Kit's tips show at once, so the wait is cut to a beat, for this app only.
 */
export const NATIVE_TOOLTIP_DELAY_MS = 120

export interface TooltipPreferences {
  registerDefaults(defaults: Record<string, number>): void
}

export function quickenNativeTooltips(platform: NodeJS.Platform, preferences: TooltipPreferences): boolean {
  if (platform !== 'darwin') {
    return false
  }

  try {
    // The registration domain: the lowest-priority defaults, never a value the person wrote.
    preferences.registerDefaults({ NSInitialToolTipDelay: NATIVE_TOOLTIP_DELAY_MS })

    return true
  } catch {
    return false
  }
}
