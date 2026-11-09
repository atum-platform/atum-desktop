import { type MatrixClient, Method } from 'matrix-js-sdk'

import { APP_UUID, type AppShortcutState, type AppShortcutVisibility } from '../../shared/app-shortcuts'

export type AppShortcutEvent = `io.atum.app_shortcut.${string}`
interface AppShortcutContent {
  version: 1
  visibility: AppShortcutVisibility
  [key: string]: unknown
}

declare module 'matrix-js-sdk' {
  interface AccountDataEvents {
    [key: AppShortcutEvent]: AppShortcutContent
  }
}

const PREFIX = 'io.atum.app_shortcut.'

export function shortcutEvent(appId: string): AppShortcutEvent {
  if (!APP_UUID.test(appId)) {
    throw new Error('matrix_app_id_invalid')
  }

  return `${PREFIX}${appId.toLowerCase()}`
}

function content(value: unknown): AppShortcutContent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const row = value as Record<string, unknown>

  return row.version === 1 && (row.visibility === 'shown' || row.visibility === 'hidden')
    ? (row as AppShortcutContent)
    : null
}

/** SDK owns persistence and sync. This is bounded operation/last-confirmed UI
 * state only; it dies with this SDK/account, never a second preferences store. */
export function appShortcuts(client: MatrixClient, active: () => boolean, changed: () => void, settleMs = 10_000) {
  const confirmed = new Map<string, AppShortcutState['visibility']>()

  const writes = new Map<
    string,
    {
      visibility: AppShortcutVisibility
      status: 'saving' | 'unconfirmed' | 'failed'
      busy: boolean
      echoed: boolean
      timer?: ReturnType<typeof setTimeout>
    }
  >()

  function observed(type: string, raw: unknown) {
    if (!type.startsWith(PREFIX) || !APP_UUID.test(type.slice(PREFIX.length)) || !active()) {
      return
    }

    const id = type.slice(PREFIX.length).toLowerCase()
    const value = content(raw)

    if (!value) {
      return
    }

    confirmed.set(id, value.visibility)
    const pending = writes.get(id)

    if (pending && pending.visibility === value.visibility) {
      pending.echoed = true
      clearTimeout(pending.timer)

      if (!pending.busy) {
        writes.delete(id)
      }
    }
  }

  return {
    observed,
    snapshot(ids: readonly string[], ready: boolean): Record<string, AppShortcutState> {
      return Object.fromEntries(
        ids.map(id => {
          const key = id.toLowerCase()
          const raw = client.getAccountData(shortcutEvent(id))?.getContent()
          const parsed = content(raw)

          if (ready && parsed) {
            confirmed.set(key, parsed.visibility)
          } else if (ready && raw === undefined && !confirmed.has(key)) {
            confirmed.set(key, 'default')
          }

          const status = !ready ? 'loading' : raw !== undefined && !parsed ? 'readonly' : 'ready'
          const pending = writes.get(key)

          return [
            id,
            {
              visibility: confirmed.get(key) ?? 'unknown',
              status: status === 'readonly' || status === 'loading' ? status : (pending?.status ?? status)
            }
          ]
        })
      )
    },
    async change(id: string, visibility: AppShortcutVisibility) {
      id = id.toLowerCase()
      const type = shortcutEvent(id)

      if (!active() || writes.get(id)?.busy) {
        throw new Error('matrix_app_shortcut_pending')
      }

      clearTimeout(writes.get(id)?.timer)

      const pending = {
        visibility,
        status: 'saving' as 'saving' | 'unconfirmed' | 'failed',
        busy: true,
        echoed: false,
        timer: undefined as ReturnType<typeof setTimeout> | undefined
      }

      writes.set(id, pending)
      changed()

      try {
        const raw = await client.http
          .authedRequest<unknown>(
            Method.Get,
            `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${type}`
          )
          .catch(error => {
            if (error?.errcode === 'M_NOT_FOUND') {
              return undefined
            }

            throw error
          })

        const previous = raw === undefined ? {} : content(raw)

        if (!previous) {
          throw new Error('matrix_app_shortcut_readonly')
        }

        if (!active()) {
          throw new Error('matrix_sdk_stopped')
        }

        await client.setAccountDataRaw(type, { ...previous, version: 1, visibility })

        if (!active()) {
          return
        }

        pending.busy = false

        if (pending.echoed) {
          writes.delete(id)
        } else {
          const verify = async () => {
            if (!active() || writes.get(id) !== pending) {
              return
            }

            let current: AppShortcutContent | null = null

            try {
              current = content(
                await client.http.authedRequest<unknown>(
                  Method.Get,
                  `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${type}`
                )
              )
            } catch {
              // This is a safe read of the same account-data key. Keep checking
              // while this SDK owns the pending write instead of turning one
              // delayed sync/read into a permanent uncertain row.
              if (active() && writes.get(id) === pending) {
                pending.timer = setTimeout(() => void verify(), settleMs)
              }

              return
            }

            if (!active() || writes.get(id) !== pending) {
              return
            }

            if (!current) {
              pending.status = 'failed'
            } else {
              confirmed.set(id, current.visibility)
              writes.delete(id)
            }

            changed()
          }

          pending.timer = setTimeout(() => void verify(), settleMs)
        }
      } catch {
        if (active()) {
          pending.busy = false
          pending.status = 'failed'
        }

        throw new Error('matrix_app_shortcut_failed')
      } finally {
        if (active()) {
          changed()
        }
      }
    },
    dispose() {
      for (const pending of writes.values()) {
        clearTimeout(pending.timer)
      }

      writes.clear()
      confirmed.clear()
    }
  }
}
