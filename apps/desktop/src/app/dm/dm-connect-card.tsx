import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { atumAppSurfaceClient, isAppSurfaceFailure } from '@/lib/atum-app-surfaces'

import { clearAppConnectionState, refreshAppConnection } from '../atum/app-connection-state'
import { useAppConnection } from '../atum/use-app-connection'

interface DmConnectCardProps {
  appId: string
  appName: string
  accountId: string
  enabled: boolean
}

export const LINKED_RECEIPT_MS = 8_000
const deferred = new Set<string>()

export function resetDmConnectCardSessionState(): void {
  deferred.clear()
  clearAppConnectionState()
}

/** One manual connection journey. Matching never runs as a side effect of opening a chat. */
export function DmConnectCard(props: DmConnectCardProps) {
  return <ConnectCard key={`${props.accountId}:${props.appId}`} {...props} />
}

function ConnectCard({ accountId, appId, appName, enabled }: DmConnectCardProps) {
  const { t } = useI18n()
  const result = useAppConnection(accountId, appId, enabled)
  const [browser, setBrowser] = useState<'idle' | 'opening' | 'waiting'>('idle')
  const [checking, setChecking] = useState(false)
  const [failure, setFailure] = useState<'open' | 'check' | null>(null)
  const [receipt, setReceipt] = useState(false)
  const key = `${accountId}:${appId}`
  const [hidden, setHidden] = useState(() => deferred.has(key))
  const generation = useRef(0)
  const busy = useRef(false)
  const success = useRef<HTMLParagraphElement>(null)
  const linked = result && !isAppSurfaceFailure(result) && result.status === 'linked'
  const cleanupPending =
    result && !isAppSurfaceFailure(result) && result.status === 'unlinked' && result.cleanup === 'pending'
  const required = result && !isAppSurfaceFailure(result) && result.connectionRequired === true
  const connectClosed = result && !isAppSurfaceFailure(result) && result.connectAvailable === false
  const finishing = required && linked && result.available !== false && result.readiness === 'pending'
  const ready = linked && result.available !== false && (!required || result.readiness === 'ready')

  const unavailable =
    result &&
    !isAppSurfaceFailure(result) &&
    (result.available === false || (required && result.readiness === 'unavailable') || (!linked && connectClosed))

  useEffect(() => {
    generation.current += 1
    busy.current = false
    setChecking(false)
    setBrowser('idle')

    return () => {
      generation.current += 1
    }
  }, [enabled])

  useEffect(() => {
    if (
      enabled &&
      browser === 'idle' &&
      !ready &&
      result &&
      !isAppSurfaceFailure(result) &&
      result.browserStep === 'in_progress'
    ) {
      setBrowser('waiting')
    }
  }, [browser, enabled, ready, result])

  useEffect(() => {
    if (ready && browser === 'waiting') {
      setBrowser('idle')
      setFailure(null)
      setReceipt(true)
    }
  }, [browser, ready])

  useEffect(() => {
    if (failure === 'check' && result && !isAppSurfaceFailure(result)) {
      setFailure(null)
    }
  }, [failure, result])

  useEffect(() => {
    if (!receipt) {
      return
    }
    success.current?.focus()
    const timer = window.setTimeout(() => setReceipt(false), LINKED_RECEIPT_MS)

    return () => window.clearTimeout(timer)
  }, [receipt])

  useEffect(() => {
    if (!enabled || (!finishing && !cleanupPending && browser !== 'waiting')) {
      return
    }
    let attempts = 0
    let timer: ReturnType<typeof setTimeout>
    let cancelled = false

    const poll = async () => {
      await refreshAppConnection(accountId, appId)

      if (!cancelled) {
        attempts += 1
        timer = setTimeout(() => void poll(), Math.min(2_000 * 2 ** Math.min(attempts, 3), 15_000))
      }
    }

    timer = setTimeout(() => void poll(), 2_000)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [accountId, appId, enabled, finishing, cleanupPending, browser])

  const check = async () => {
    if (busy.current) {
      return
    }
    busy.current = true
    const expectedGeneration = generation.current
    setChecking(true)
    const current = await refreshAppConnection(accountId, appId)

    if (generation.current === expectedGeneration) {
      setFailure(isAppSurfaceFailure(current) ? 'check' : null)
      setChecking(false)
    }

    if (generation.current === expectedGeneration) {
      busy.current = false
    }
  }

  const connect = async () => {
    if (busy.current) {
      return
    }
    busy.current = true
    const expectedGeneration = generation.current
    setFailure(null)
    setBrowser('opening')

    try {
      const opened = await atumAppSurfaceClient().connectStart(appId)

      if (generation.current === expectedGeneration) {
        setFailure(isAppSurfaceFailure(opened) ? 'open' : null)
        setBrowser(isAppSurfaceFailure(opened) ? 'idle' : 'waiting')
      }
    } catch {
      if (generation.current === expectedGeneration) {
        setFailure('open')
        setBrowser('idle')
      }
    } finally {
      if (generation.current === expectedGeneration) {
        busy.current = false
      }
    }
  }

  if (!enabled || !accountId || !appId || (hidden && !required) || (ready && !receipt)) {
    return null
  }

  if (connectClosed && !required && result && !isAppSurfaceFailure(result) && result.status === 'never_linked') {
    return null
  }

  if (result && isAppSurfaceFailure(result) && ['not_found', 'app_surface_unavailable'].includes(result.error)) {
    return null
  }

  const statusError = result && isAppSurfaceFailure(result)
  const reconnect = result && !isAppSurfaceFailure(result) && result.status === 'unlinked'
  const awaitingBrowser = browser === 'waiting'
  const mustCheck = statusError || finishing || unavailable || linked || awaitingBrowser

  const title = receipt
    ? t.dm.connect.linkedTitle(appName)
    : reconnect
      ? t.dm.connect.reconnectTitle(appName)
      : t.dm.connect.title(appName)

  const error =
    failure === 'open'
      ? t.dm.connect.failed
      : failure === 'check'
        ? t.dm.connect.checkFailed
        : statusError
          ? t.dm.connect.statusUnavailable
          : ''

  const status = receipt
    ? t.dm.connect.linked(appName)
    : finishing
      ? t.dm.connect.finishing(appName)
      : unavailable
        ? t.dm.connect.unavailable(appName)
        : awaitingBrowser
          ? t.dm.connect.browserHint
          : reconnect
            ? result.cleanup === 'complete'
              ? t.atum.account.disconnectComplete
              : t.atum.account.disconnectPending
            : ''

  const pending = browser === 'opening' || checking || !result

  const label =
    browser === 'opening'
      ? t.dm.connect.starting
      : checking || !result
        ? t.dm.connect.checking
        : statusError
          ? t.dm.connect.retryStatus
          : mustCheck
            ? t.dm.connect.checkAgain
            : reconnect
              ? t.dm.connect.reconnect
              : t.dm.connect.connect

  return (
    <aside aria-label={title} className="mx-auto mt-4 w-full max-w-3xl px-4 py-3.5">
      <h2 className="text-(length:--atum-t-title) font-semibold text-(--atum-ink)">{title}</h2>
      {!receipt && (
        <p className="mt-1.5 text-(length:--atum-t-body) text-(--atum-ink-muted)">
          {t.dm.connect.manualDescription(appName)}
        </p>
      )}
      <p
        className={status ? 'mt-2 text-(length:--atum-t-body) text-(--atum-ink-soft)' : 'sr-only'}
        ref={success}
        role="status"
        tabIndex={receipt ? -1 : undefined}
      >
        {status}
      </p>
      <NoticeBand className="mt-2" quiet={!error} role="alert">
        {error}
      </NoticeBand>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {receipt ? (
          <Button onClick={() => setReceipt(false)} size="sm" variant="text">
            {t.dm.connect.done}
          </Button>
        ) : (
          <Button
            aria-busy={pending}
            disabled={pending}
            onClick={() => void (mustCheck ? check() : connect())}
            size="sm"
          >
            {label}
          </Button>
        )}
        {!receipt && !pending && !awaitingBrowser && !finishing && !required && (
          <Button
            onClick={() => {
              deferred.add(key)
              setHidden(true)
            }}
            size="sm"
            variant="text"
          >
            {t.dm.connect.notNow}
          </Button>
        )}
      </div>
    </aside>
  )
}
