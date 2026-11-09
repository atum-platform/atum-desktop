import type { AppDescriptor } from '../../../shared/app-catalog'
import type { LookPackGround } from '../../../shared/look-pack'
import { groundStyle, type LookCssProperties } from '../look/resolve-look'

/** Panel art is independent of chat art (look-pack v1.1). Missing panel data uses Kit. */
export interface ResolvedAppPanelLook {
  ground: LookPackGround | null
  tone?: LookPackGround['tone']
  /** Kit theme for an open page's host: follows the page base, not the ground (a dark ground may sit over a paper page). */
  pageTone?: 'light' | 'dark'
  accent: string | null
  style: LookCssProperties
}

export function resolveAppPanelLook(
  app: Pick<AppDescriptor, 'look'>,
  appearance: 'light' | 'dark'
): ResolvedAppPanelLook {
  const pack = app.look ?? null
  const panel = pack?.panel
  // One ground for the whole panel: the declared panel background; a pack that declares only
  // v1.2 chrome paints that instead. Each comes with its own ramps, never a ramp from the other.
  const grounds = panel?.background ?? panel?.chrome ?? null
  const ramps = panel?.background ? panel.derived : panel?.chrome_derived
  const ground = grounds?.[appearance] ?? grounds?.light ?? null
  const derived = appearance === 'dark' && grounds?.dark ? ramps?.dark : ramps?.light
  const accent = pack?.accent
    ? appearance === 'dark'
      ? (pack.accent.dark ?? pack.accent.light)
      : pack.accent.light
    : null
  const style: LookCssProperties = ground ? groundStyle(ground, derived) : {}

  const pageBase =
    panel?.page_base?.[appearance] ?? panel?.page_base?.light ?? (ground?.tone === 'light' ? ground.base : null)

  if (pageBase) {
    style['--app-panel-page-base'] = pageBase
  }

  const pageTone = pageBase ? hexTone(pageBase) : undefined

  if (accent) {
    style['--look-accent'] = accent
  }

  return { ground, tone: ground?.tone, ...(pageTone ? { pageTone } : {}), accent, style }
}

/** WCAG relative luminance: a page ground is light when black ink out-contrasts white on it. */
function hexTone(hex: string): 'light' | 'dark' {
  const [r, g, b] = [1, 3, 5].map(index => {
    const c = parseInt(hex.slice(index, index + 2), 16) / 255

    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!

  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? 'light' : 'dark'
}
