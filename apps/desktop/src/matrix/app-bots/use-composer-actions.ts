import { useEffect, useState } from 'react'

import { requiresPlatformConnection } from '../../../shared/app-view/protocol'
import type { MatrixAppMenu, MatrixRoom, MatrixSnapshot } from '../../../shared/matrix'

import { directAppBotForRoom } from './direct-app'

// Gaps before the "+" menu is asked for again after the platform could not build it (a timeout or
// a 503 once left a linked Moon chat with no "+" until the room was reopened).
const MENU_RETRY_MS = [3_000, 10_000, 30_000] as const

interface ResolvedActions {
  key: string
  menu: MatrixAppMenu
}

/**
 * Composer-placed app routes for one canonical app DM. Main remains authoritative:
 * the renderer receives labels/icons/route ids only, then launches by `{app, route_id}`.
 */
export function useAppBotComposerActions(snapshot: MatrixSnapshot, room: MatrixRoom, botApiRoom: boolean) {
  const app = directAppBotForRoom(snapshot, room)
  const bridge = window.atumMatrix.apps
  // Every snapshot arrives as a fresh clone, so the app descriptor's identity changes on each
  // emission. The read keys off ids only; otherwise the effect asks for the same menu again
  // several times a second and drains the platform's shared read budget.
  const appId = app?.app_id
  const appVersionId = app?.app_version_id

  const key = app
    ? `${snapshot.petScope ?? ''}\u0000${snapshot.identity?.userId ?? ''}\u0000${room.id}\u0000${app.app_id}\u0000${app.app_version_id}`
    : ''

  const [resolved, setResolved] = useState<ResolvedActions | null>(null)
  const [attempt, setAttempt] = useState(0)

  const ready = Boolean(
    app &&
    bridge &&
    snapshot.state === 'ready' &&
    snapshot.apps?.state === 'ready' &&
    app.availability === 'available' &&
    (!requiresPlatformConnection(app.link) || botApiRoom) &&
    app.bot?.state === 'active' &&
    app.bot.device
  )

  useEffect(() => {
    let live = true

    if (!appId || !appVersionId || !bridge || !ready) {
      return () => {
        live = false
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined

    void bridge.menu(appId).then(
      value => {
        if (live && value.app.app_id === appId && value.app.app_version_id === appVersionId) {
          setResolved({ key, menu: value })
        }
      },
      () => {
        const delay = MENU_RETRY_MS[attempt]

        if (live && delay !== undefined) {
          timer = setTimeout(() => setAttempt(count => count + 1), delay)
        }
      }
    )

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [appId, appVersionId, attempt, bridge, key, ready])

  // A different chat or app version starts its own run of looks.
  useEffect(() => setAttempt(0), [key])

  return {
    app,
    // The app DM is already its canonical chat. Composer features mirror the app's "+" menu,
    // not a second way to open the same chat. Compare only the catalog-declared route id; paths
    // remain main-owned and never cross this boundary.
    actions: ready && resolved?.key === key
      ? (resolved.menu.actions ?? []).filter(action => action.id !== app?.bot?.open_route_id)
      : []
  }
}
