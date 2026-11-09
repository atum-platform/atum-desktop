import { parseAppCatalog } from './app-catalog'
import { type AtumStoreDiscoveryResult, queryStoreCatalog } from './atum-discovery'
import { appListingLink } from './discovery-links'
import { storeCatalog } from './matrix-store-contract'

/** A model selects listing filters, never the host's account or transport. */
export async function agentStoreDiscovery(input: {
  payload: unknown
  read(): Promise<unknown>
  current(): boolean
}): Promise<AtumStoreDiscoveryResult | { error: string }> {
  const value = input.payload as Record<string, unknown> | null
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !['search', 'inspect'].includes(String(value.operation)) ||
    Object.keys(value).some(
      key => !['operation', 'query', 'kind', 'itemId', 'limit', 'turn_id', 'request_id'].includes(key)
    ) ||
    (value.operation === 'inspect' && (typeof value.itemId !== 'string' || !value.itemId))
  ) {
    return { error: 'Invalid Store discovery request.' }
  }
  if (!input.current()) {
    return { error: 'The Store request is no longer current.' }
  }
  try {
    const items = storeCatalog(await input.read())
    if (!input.current()) {
      return { error: 'The Store request is no longer current.' }
    }
    const result = queryStoreCatalog(
      items,
      Object.fromEntries(Object.entries(value).filter(([key]) => ['query', 'kind', 'itemId', 'limit'].includes(key)))
    )
    return result.outcome === 'error' ? { error: result.message } : result
  } catch {
    return { error: 'The current Store catalog is unavailable. No purchase or installation was attempted.' }
  }
}

/** Account-filtered app descriptions only, never app content or launch credentials. */
export async function agentAppsDiscovery(input: {
  read(): Promise<unknown>
  current(): boolean
  appId?: unknown
  open?: (appId: string) => Promise<void>
}): Promise<unknown> {
  if (!input.current()) {
    return { error: 'The app request is no longer current.' }
  }
  try {
    const catalog = parseAppCatalog(await input.read())
    if (!input.current()) {
      return { error: 'The app request is no longer current.' }
    }
    const apps = catalog.apps.map(app => ({
      id: app.app,
      appId: app.app_id,
      version: app.app_version_id,
      name: app.name.en ?? app.name.vi ?? app.app,
      description: app.description ?? app.subtitle ?? {},
      availability: app.availability,
      supportedModes: app.supported_modes,
      connection: app.link,
      destination: { surface: 'discover', shelf: 'apps', appId: app.app_id },
      listingLink: appListingLink(app.app_id)
    }))
    if (input.appId === undefined) {
      return { apps }
    }
    const appId = typeof input.appId === 'string' ? input.appId.trim().toLowerCase() : ''
    const app = apps.find(each => each.id === appId)
    if (!app) {
      return { error: 'Unknown app id. List the current apps first.', switched: false }
    }
    if (!input.open) {
      return {
        switched: false,
        destination: app.destination,
        message: 'App destination only; no desktop UI was opened.'
      }
    }
    if (app.availability !== 'available') {
      return { error: 'This app is not available.', switched: false }
    }
    await input.open(app.appId)
    if (!input.current()) {
      return { error: 'The account or turn changed; navigation was not confirmed.', switched: false }
    }
    return { switched: true, app: { id: app.id, name: app.name } }
  } catch {
    return { error: 'The current app catalog or navigation is unavailable.', switched: false }
  }
}
