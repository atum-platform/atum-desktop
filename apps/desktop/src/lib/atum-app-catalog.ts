import { atom } from 'nanostores'

export interface DesktopAppCatalogEntry {
  app: string; app_id: string; app_version_id: string
  name: { vi: string; en: string }; subtitle: { vi: string; en: string } | null
  icon: { url: string; sha256: string } | null; verified: boolean
  availability: 'available' | 'unavailable'
  supported_modes: Array<'direct' | 'private_group' | 'shared_group'>
  link: { mode: 'none' | 'external_account'; state: 'never_linked' | 'linked' | 'unlinked' }
}
type BridgeResult = { error: string } | { apps: DesktopAppCatalogEntry[] }
type CatalogBridge = { catalog(force?: boolean): Promise<BridgeResult> }

/** Server-approved registration projected through Electron main. There is no
 * executable client roster: an unfamiliar compliant provider is first-class. */
export type AtumAppCatalogState =
  | { accountId: null; apps: []; state: 'idle' }
  | { accountId: string; apps: DesktopAppCatalogEntry[]; state: 'loading' | 'ready' | 'stale' | 'error' }
export const $atumAppCatalog = atom<AtumAppCatalogState>({ accountId: null, apps: [], state: 'idle' })
let catalogGeneration = 0

function bridge(): CatalogBridge | null {
  const host = globalThis as typeof globalThis & { hermesDesktop?: { appSurface?: CatalogBridge }; window?: { hermesDesktop?: { appSurface?: CatalogBridge } } }

  return host.hermesDesktop?.appSurface ?? host.window?.hermesDesktop?.appSurface ?? null
}

export function clearAtumAppCatalog(accountId?: string | null): void {
  const current = $atumAppCatalog.get()

  if (accountId && current.accountId !== accountId) {return}
  catalogGeneration += 1
  $atumAppCatalog.set({ accountId: null, apps: [], state: 'idle' })
}

/** Fetch only through the main-owned app-surface bridge. The account fence
 * makes a late prior-account reply unable to publish into the current UI. */
export async function refreshAtumAppCatalog(accountId: string, force = false): Promise<DesktopAppCatalogEntry[]> {
  const generation = catalogGeneration
  const prior = $atumAppCatalog.get()
  const retained = prior.accountId === accountId ? prior.apps : []
  $atumAppCatalog.set({ accountId, apps: retained, state: retained.length ? 'stale' : 'loading' })
  const client = bridge()
  let result: BridgeResult

  try {
    result = client ? await client.catalog(force) : { error: 'app_surface_unavailable' }
  } catch (error) {
    if (catalogGeneration === generation && $atumAppCatalog.get().accountId === accountId) {
      $atumAppCatalog.set({ accountId, apps: retained, state: retained.length ? 'stale' : 'error' })
    }

    throw error
  }

  if (catalogGeneration !== generation || $atumAppCatalog.get().accountId !== accountId) {return []}

  if ('error' in result) {
    if (catalogGeneration === generation) {
      $atumAppCatalog.set({ accountId, apps: retained, state: retained.length ? 'stale' : 'error' })
    }

    throw new Error(result.error)
  }

  $atumAppCatalog.set({ accountId, apps: result.apps, state: 'ready' })

  return result.apps
}

export function appSupportsDirect(app: DesktopAppCatalogEntry | undefined): boolean {
  return Boolean(app && app.availability === 'available' && app.supported_modes.includes('direct'))
}

export function appDisplayName(app: DesktopAppCatalogEntry, locale: string): string { return app.name[locale === 'vi' ? 'vi' : 'en'] }

export function appSubtitle(app: DesktopAppCatalogEntry, locale: string): string { return app.subtitle?.[locale === 'vi' ? 'vi' : 'en'] ?? '' }
