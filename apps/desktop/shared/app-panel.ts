import { z } from 'zod'

import glyphs from './app-panel-glyphs.json'
import type { AppManifestRoute } from './app-view/protocol'

// atum-platform afc65f8a6c: spec/app-panel/v1 and packages/protocol/src/app-panel.ts.
export const APP_PANEL_PROFILE = 'atum.app-panel/1'
export const APP_PANEL_NEGOTIATION_HEADER = 'Atum-App-Panel-Profile'
const routeId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const tagText = z
  .string()
  .min(1)
  .refine(value => [...value].length <= 10 && !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value))
const schema = z
  .object({
    profile: z.literal(APP_PANEL_PROFILE),
    default_page: routeId.optional(),
    pages: z
      .array(
        z
          .object({
            route_id: routeId,
            glyph: z.string().refine(value => glyphs.names.includes(value)),
            tag: z.object({ vi: tagText, en: tagText }).strict().optional()
          })
          .strict()
      )
      .min(1)
      .max(12)
  })
  .strict()

export interface AppPanelPages {
  pages: Array<{ routeId: string; glyph: string; tag?: { vi: string; en: string } }>
  defaultPage?: string
}

/** Optional presentation cannot invalidate the manifest. Log only a closed code, never raw input. */
export function decodeAppPanel(
  value: unknown,
  routes: readonly AppManifestRoute[],
  openRouteId?: string | null,
  log?: (line: string) => void
): AppPanelPages | null {
  if (value === undefined) {
    return null
  }
  const parsed = schema.safeParse(value)
  if (parsed.success) {
    const panel = parsed.data
    const ids = panel.pages.map(page => page.route_id)
    if (
      new Set(ids).size === ids.length &&
      panel.pages.every(page =>
        routes.some(route => route.id === page.route_id && route.placements.includes('menu'))
      ) &&
      (panel.default_page === undefined || (ids.includes(panel.default_page) && panel.default_page !== openRouteId))
    ) {
      return {
        pages: panel.pages.map(page => ({
          routeId: page.route_id,
          glyph: page.glyph,
          ...(page.tag ? { tag: page.tag } : {})
        })),
        ...(panel.default_page === undefined ? {} : { defaultPage: panel.default_page })
      }
    }
  }
  log?.('app_panel ignored reason=invalid')

  return null
}
