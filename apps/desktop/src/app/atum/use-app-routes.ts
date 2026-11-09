import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { type AppRoutes, atumAppSurfaceClient, isAppSurfaceFailure } from '@/lib/atum-app-surfaces'
import { $atumAccountScopeId } from '@/store/atum-messaging'

/**
 * The last routes each app answered, for this account, in this window. Main
 * fetches the manifest over the network and caches it only briefly, so
 * without this every return to an app leaves its panel blank for as long as
 * that round trip takes — during which the panel showed the generic launcher,
 * which is indistinguishable from the previous conversation's workspace.
 *
 * A remembered answer is shown immediately and always revalidated. It carries
 * labels and route ids only: never an origin, a path, or anything a launch is
 * decided from, all of which main resolves again at open time.
 */
const remembered = new Map<string, AppRoutes>()
$atumAccountScopeId.listen(() => remembered.clear())

function cacheKey(accountId: string | null, app: string): string {
  return `${accountId ?? 'none'}:${app}`
}

/** Test seam: the cache outlives components by design, so tests must clear it. */
export function resetRememberedAppRoutesForTests(): void {
  remembered.clear()
}

export interface AppRoutesState {
  routes: AppRoutes | null
  /** True while the first answer for this app is still outstanding. */
  pending: boolean
}

/**
 * The routes an app declares, as main projects them from the server-authored
 * manifest: ids, labels, icons, placements, and whether a session is
 * required. Never a path or an origin — an app view is opened from
 * `{app, route_id}` and main resolves the rest.
 */
export function useAppRoutes(app: string | null | undefined): AppRoutesState {
  const accountId = useStore($atumAccountScopeId)
  // `routes: null` records an app that answered with a refusal, which is not
  // the same as not having asked yet: it must survive the cache being dropped.
  const [resolved, setResolved] = useState<{ accountId: string | null; app: string; routes: AppRoutes | null } | null>(null)

  useEffect(() => {
    let active = true

    if (!app) {
      setResolved(null)

      return () => {active = false}
    }

    const key = cacheKey(accountId, app)

    setResolved(null)
    void atumAppSurfaceClient().routes(app).then(result => {
      if (!active) {return}

      if (isAppSurfaceFailure(result)) {
        // The app is gone or refused for this account: stop showing a menu
        // that no longer exists rather than leaving the remembered one up.
        remembered.delete(key)

        setResolved({ accountId, app, routes: null })

        return
      }

      remembered.set(key, result)

      setResolved({ accountId, app, routes: result })
    }).catch(() => undefined)

    return () => {active = false}
  }, [accountId, app])

  // Read during render, not in the effect: an effect answers a frame late,
  // which is the whole gap this cache exists to close. The key carries the
  // app, so a remembered answer can only ever be this app's.
  const cached = app ? remembered.get(cacheKey(accountId, app)) ?? null : null

  // State clears on change, but it clears in an effect, which runs after the
  // render that already moved to the next app. A caller acting in that render
  // — the DM view pins the app menu for whatever it is handed — would pin one
  // app's menu into another conversation. The answer is therefore bound to
  // the app it was fetched for and withheld until the two agree.
  const answered = resolved && resolved.app === app && resolved.accountId === accountId ? resolved : null
  const routes = answered ? answered.routes : cached

  return { routes, pending: Boolean(app) && routes === null }
}
