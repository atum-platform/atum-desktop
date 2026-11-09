import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { $atumAppCatalog, refreshAtumAppCatalog } from '@/lib/atum-app-catalog'
import { atumMessagingClient, type AtumMessagingClient } from '@/lib/atum-messaging-client'
import { $atumAccountScopeId, $atumAccountStatus } from '@/store/atum-messaging'

import { clearAppConnection, refreshAppConnection } from './app-connection-state'

/** Display the connected app using the current account’s approved catalog. */
function LinkedAppTile({ app, name }: { app: string; name: string }) {
  const catalog = useStore($atumAppCatalog)
  const presentation = catalog.apps.find(entry => entry.app === app.toLowerCase())

  if (presentation?.icon?.url) {
    return (
      <img alt="" className="size-[1.625rem] shrink-0 rounded-[0.4375rem] object-cover" src={presentation.icon.url} />
    )
  }

  return (
    <span
      aria-hidden
      className="grid size-[1.625rem] shrink-0 place-items-center rounded-[0.4375rem] bg-(--atum-sunk) text-(length:--atum-t-body) font-semibold text-(--atum-ink-soft)"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** Existing account-bound connection and withdrawal flow, shown in Settings. */
export function LinkedAppsSettings() {
  const { t } = useI18n()
  const account = useStore($atumAccountStatus)
  const identity = account.account
  const signedIn = account.state === 'signed_in' || account.state === 'refreshing'
  const [apps, setApps] = useState<Array<{ app: string; displayName: string }>>([])
  const [appsState, setAppsState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const [disconnectError, setDisconnectError] = useState(false)

  const [disconnectReceipt, setDisconnectReceipt] = useState<'complete' | 'pending' | null>(null)
  const [localCleanupApps, setLocalCleanupApps] = useState<Array<{ app: string; displayName: string }>>([])

  useEffect(() => {
    setDisconnectReceipt(null)
    setLocalCleanupApps([])
    setDisconnecting(null)
    setDisconnectError(false)
  }, [identity?.id])

  useEffect(() => {
    if (!signedIn) {
      setApps([])
      setAppsState('ready')

      return
    }

    if (identity?.id) {
      void refreshAtumAppCatalog(identity.id).catch(() => {})
    }

    let active = true
    setAppsState('loading')
    let client: AtumMessagingClient

    try {
      client = atumMessagingClient()
    } catch {
      setAppsState('ready')

      return
    }

    void client
      .linkedApps()
      .then(value => {
        if (active) {
          setApps(value)
          setAppsState('ready')
        }
      })
      .catch(() => {
        if (active) {
          setAppsState('failed')
        }
      })

    return () => {
      active = false
    }
  }, [signedIn, identity?.id])

  const disconnect = async (app: { app: string; displayName: string }, confirm = true) => {
    if (confirm && !window.confirm(`${t.atum.account.disconnectConfirm(app.displayName)}\n${t.atum.account.disconnectHint}`)) {
      return
    }

    setDisconnecting(app.app)
    setDisconnectError(false)
    setDisconnectReceipt(null)

    try {
      const withdrawal = await atumMessagingClient().disconnectApp(app.app)

      if ($atumAccountScopeId.get() !== identity?.id) {
        return
      }

      setLocalCleanupApps(current => [
        ...current.filter(item => item.app !== app.app),
        ...(withdrawal?.localCleanup === 'unconfirmed' ? [app] : [])
      ])
      setApps(current => current.filter(item => item.app !== app.app))

      if (identity?.id) {
        clearAppConnection(identity.id, app.app)
      }

      const status = identity?.id ? await refreshAppConnection(identity.id, app.app) : null

      if ($atumAccountScopeId.get() !== identity?.id) {
        return
      }

      setDisconnectReceipt(status && !('error' in status) && status.cleanup === 'complete' ? 'complete' : 'pending')
    } catch {
      if ($atumAccountScopeId.get() === identity?.id) {
        setDisconnectError(true)
      }
    } finally {
      if ($atumAccountScopeId.get() === identity?.id) {
        setDisconnecting(null)
      }
    }
  }

  return (
        <section
          aria-labelledby="linked-apps-heading"
          className="text-(--atum-ink)"
        >
          <h3 className="text-(length:--atum-t-ui) font-medium text-(--atum-ink)" id="linked-apps-heading">
            {t.atum.account.linkedApps}
          </h3>
          {appsState === 'loading' ? (
            <p className="mt-3 text-(length:--atum-t-body) text-(--atum-ink-muted)">{t.common.loading}</p>
          ) : appsState === 'failed' ? (
            <NoticeBand className="mt-3" role="alert">
              {t.atum.account.linkedAppsFailed}
            </NoticeBand>
          ) : apps.length === 0 ? (
            <p className="mt-3 text-(length:--atum-t-body) text-(--atum-ink-muted)">{t.atum.account.linkedAppsEmpty}</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2.5">
              {apps.map(app => (
                <li className="flex items-center gap-3 text-(length:--atum-t-ui) text-(--atum-ink)" key={app.app}>
                  <LinkedAppTile app={app.app} name={app.displayName} />
                  <span className="min-w-0 flex-1 truncate">{app.displayName}</span>
                  <button
                    className="shrink-0 text-(length:--atum-t-control) text-(--atum-ink-muted) hover:text-(--atum-ink) disabled:text-(--atum-ink-ghost)"
                    disabled={disconnecting !== null}
                    onClick={() => void disconnect(app)}
                    type="button"
                  >
                    {t.atum.account.disconnect}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {disconnectReceipt && (
            <p className="mt-2 text-(length:--atum-t-body) text-(--atum-ink-muted)" role="status">
              {disconnectReceipt === 'complete' ? t.atum.account.disconnectComplete : t.atum.account.disconnectPending}
            </p>
          )}
          {localCleanupApps.map(localCleanupApp => (
            <div className="mt-2" key={localCleanupApp.app}>
              <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)" role="status">
                {localCleanupApp.displayName}: {t.atum.account.disconnectLocalPending}
              </p>
              <Button disabled={disconnecting !== null} onClick={() => void disconnect(localCleanupApp, false)} size="sm" variant="text">
                {t.atum.account.retryLocalCleanup}
              </Button>
            </div>
          ))}
          {disconnectError && (
            <NoticeBand className="mt-2" role="alert">
              {t.atum.account.disconnectFailed}
            </NoticeBand>
          )}
        </section>

  )
}
