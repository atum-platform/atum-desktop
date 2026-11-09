/**
 * The one table of HTTP routes the desktop calls for `atum.agent-home/2.5` placement and connection models.
 * `connection-routes.json` is plain data so the platform's own checks can read the same rows; this module only
 * types it and fills in a row's placeholders. `PlacementConnectionPlatform` has no other source of method or path.
 */
import table from './connection-routes.json'

export const PLACEMENT_CONNECTION_ROUTE_TABLE = table

export type PlacementRouteId = keyof typeof table.routes

export type PlacementRouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

export interface PlacementRoute {
  id: PlacementRouteId
  method: PlacementRouteMethod
  /** Relative to the agent: always starts with `/home/`. */
  path: string
}

/** A route with its `{placeholder}` segments replaced by validated UUIDs; null when one is missing or malformed. */
export function placementRoute(id: PlacementRouteId, params: Readonly<Record<string, string>> = {}): PlacementRoute | null {
  const row = table.routes[id]
  let ok = true
  const path = row.path.replace(/\{([A-Za-z]+)\}/gu, (_whole, name: string) => {
    const value = params[name]

    if (typeof value !== 'string' || !UUID.test(value)) {
      ok = false

      return ''
    }

    return encodeURIComponent(value)
  })

  return ok ? { id, method: row.method as PlacementRouteMethod, path } : null
}
