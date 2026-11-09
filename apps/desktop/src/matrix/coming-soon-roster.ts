import type { AppDescriptor, AppLocalizedCopy } from '../../shared/app-catalog'

/** One inert, catalog-driven coming-soon row. It carries presentation only: no route, bot,
 * room, consent or launch field exists here by design. */
export interface MatrixRosterPlaceholder {
  app: string
  /** The catalog's hashed icon URL, or the owned local asset for a stable placeholder slug. */
  icon: string | null
  /** The catalog's localized copy; the row picks the active locale with an English fallback. */
  name: AppLocalizedCopy
}

/** Existing owned brand tiles for the four stable slugs. The catalog icon wins when present;
 * this keeps the reviewed local artwork as a fallback rather than a second row list. */
const OWNED_ASSETS: Readonly<Record<string, string>> = {
  vneid: './specialists/vneid.png',
  vssid: './specialists/vssid.png',
  'etax-mobile': './specialists/etax-mobile.png',
  'that-space': './specialists/that-space.png'
}

export function matrixRosterPlaceholder(app: AppDescriptor): MatrixRosterPlaceholder {
  return {
    app: app.app,
    icon: app.icon?.url ?? OWNED_ASSETS[app.app] ?? null,
    name: app.name
  }
}
