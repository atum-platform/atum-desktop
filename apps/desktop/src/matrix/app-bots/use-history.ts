import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { appBotDisclosureVersion } from '../../../shared/app-catalog'
import type { MatrixAppHistoryEntry } from '../../../shared/app-history'
import type { MatrixRoom, MatrixSnapshot } from '../../../shared/matrix'

import { directAppBotForRoom } from './direct-app'

interface HistoryState {
  key: string
  entries: MatrixAppHistoryEntry[]
  nextCursor: string | null
  hasMore: boolean
  loading: boolean
  error: unknown | null
}

const EMPTY: Omit<HistoryState, 'key'> = {
  entries: [],
  nextCursor: null,
  hasMore: false,
  loading: false,
  error: null
}

export function useAppBotHistory(snapshot: MatrixSnapshot, room: MatrixRoom | undefined) {
  const app = directAppBotForRoom(snapshot, room)
  const bridge = window.atumMatrix.apps
  // Bot API conversations already persist in the Matrix room. Provider history belongs only
  // to the legacy linked-app transport; calling it for Bot API duplicates the authority and can
  // turn an obsolete endpoint failure into a banner over a healthy native conversation.
  const supported = Boolean(app?.has_history && app.bot?.transport_mode !== 'bot_api')

  const ready = Boolean(
    supported &&
    app &&
    bridge &&
    snapshot.state === 'ready' &&
    snapshot.apps?.state === 'ready' &&
    app.availability === 'available' &&
    app.link.state === 'linked' &&
    app.bot?.state === 'active' &&
    app.bot.device &&
    app.bot.consent === 'accepted' &&
    app.bot.disclosure_version === appBotDisclosureVersion(app)
  )
  const authority = useRef({ ready, serial: 0 })

  if (authority.current.ready !== ready) {
    authority.current = { ready, serial: authority.current.serial + 1 }
  }

  // Snapshots arrive as fresh clones; keying off ids keeps the loader stable across emissions.
  const appId = app?.app_id
  const appVersionId = app?.app_version_id
  const key = app
    ? `${snapshot.petScope ?? ''}\u0000${snapshot.identity?.userId ?? ''}\u0000${room?.id ?? ''}\u0000${app.app_id}\u0000${app.app_version_id}\u0000${authority.current.serial}`
    : ''
  const [state, setState] = useState<HistoryState | null>(null)
  const request = useRef(0)

  const load = useCallback(
    async (cursor: string | null, replace: boolean) => {
      if (!appId || !appVersionId || !bridge || !ready) {
        return false
      }

      const serial = ++request.current
      setState(current =>
        current?.key === key
          // A refresh retries the remote read; it must not erase confirmed history while waiting
          // or when that read fails. A successful replacement still replaces it below.
          ? { ...current, loading: true, error: null }
          : { key, ...EMPTY, loading: true }
      )
      try {
        const page = await bridge.history(appId, cursor)

        if (serial !== request.current || page.appId !== appId || page.appVersionId !== appVersionId) {
          return false
        }

        setState(current => {
          const prior = !replace && current?.key === key ? current.entries : []
          const byId = new Map([...page.entries, ...prior].map(entry => [entry.id, entry]))
          const entries = [...byId.values()].sort(
            (left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id)
          )

          return { key, entries, nextCursor: page.nextCursor, hasMore: page.hasMore, loading: false, error: null }
        })

        return page.hasMore
      } catch (error) {
        if (serial === request.current) {
          setState(current =>
            current?.key === key ? { ...current, loading: false, error } : { key, ...EMPTY, error }
          )
        }

        return false
      }
    },
    [appId, appVersionId, bridge, key, ready]
  )

  useEffect(() => {
    request.current += 1

    if (ready) {
      void load(null, true)
    }

    return () => {
      request.current += 1
    }
  }, [key, load, ready])

  const visible = useMemo<HistoryState>(
    () => (ready && state?.key === key ? state : { key, ...EMPTY }),
    [key, ready, state]
  )
  const loadEarlier = useCallback(
    () => (visible.hasMore && visible.nextCursor ? load(visible.nextCursor, false) : Promise.resolve(false)),
    [load, visible.hasMore, visible.nextCursor]
  )
  const retry = useCallback(() => load(null, true), [load])
  const failed = visible.error !== null

  return useMemo(
    () => ({ ...visible, failed, ready, supported, loadEarlier, retry }),
    [failed, loadEarlier, ready, retry, supported, visible]
  )
}
