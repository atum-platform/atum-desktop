import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Check, Spinner } from '@/lib/icons'

import type { MatrixSubscriptionsBridge } from '../../shared/matrix'
import {
  MATRIX_SUBSCRIPTION_PROVIDERS,
  type MatrixSubscriptionProvider,
  matrixSubscriptionProviderLabel,
  type MatrixSubscriptionProviderStatus,
  type MatrixSubscriptionSignIn,
  type MatrixSubscriptionsStatus
} from '../../shared/matrix-subscriptions'

import { useMatrixSettingsCopy } from './settings-copy'
import {
  matrixChatGptNeedsCloudSetup,
  type MatrixSubscriptionCloudSetup,
  type MatrixSubscriptionView,
  matrixSubscriptionView
} from './subscription-view'

/** The bridge, or none in a test/older main: Settings still draws both rows disabled. */
export function useSubscriptionsBridge(): MatrixSubscriptionsBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.atumMatrix?.subscriptions
}

/** One account-level read, shared by every assistant of this account. The window also owns its
 * own cloud setup attempt: one per relay revision while Connections is open, then one more each
 * time the person presses Try again. Native main owns the bounded retries in between. */
export function useMatrixSubscriptions(scopeKey?: string) {
  const bridge = useSubscriptionsBridge()
  const [status, setStatus] = useState<MatrixSubscriptionsStatus | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const [cloudSetup, setCloudSetup] = useState<MatrixSubscriptionCloudSetup>('idle')
  const live = useRef(true)
  const relayRepair = useRef<string | null>(null)

  const reload = useCallback(async () => {
    if (!bridge) {
      return null
    }

    try {
      const next = await bridge.status()

      if (live.current) {
        setStatus(next)
        setReadFailed(false)
      }

      return next
    } catch {
      if (live.current) {
        setReadFailed(true)
      }

      return null
    }
  }, [bridge])

  useEffect(() => {
    live.current = true
    void reload()

    return () => {
      live.current = false
    }
  }, [reload, scopeKey])

  const setUpCloud = useCallback(async () => {
    if (!bridge) {
      return
    }

    setCloudSetup('working')

    try {
      const result = await bridge.useThisMacForChatGpt(true)

      if (!live.current) {
        return
      }

      setCloudSetup(result.status === 'applied' ? 'idle' : 'failed')

      if (result.status === 'applied') {
        await reload()
      }
    } catch {
      if (live.current) {
        setCloudSetup('failed')
      }
    }
  }, [bridge, reload])

  // A saved account plan whose relay is not enabled is honest-but-degraded. Pull one setup
  // attempt forward while Connections is open; native main owns the bounded retries after it.
  const chatgpt = subscriptionProviderStatus(status, 'openai-codex')
  const needsCloudSetup = matrixChatGptNeedsCloudSetup(chatgpt)
  const repairKey = needsCloudSetup ? `${scopeKey ?? 'account'}:${chatgpt?.relay?.revision ?? 'unknown'}` : null

  useEffect(() => {
    if (!bridge || !repairKey) {
      relayRepair.current = null

      return
    }

    if (relayRepair.current === repairKey) {
      return
    }

    relayRepair.current = repairKey
    void setUpCloud()
  }, [bridge, repairKey, setUpCloud])

  const view = matrixSubscriptionView({ status, readFailed, cloudSetup })

  return { bridge, reload, retryCloud: setUpCloud, status, view }
}

export function subscriptionProviderStatus(
  status: MatrixSubscriptionsStatus | null,
  provider: MatrixSubscriptionProvider
): MatrixSubscriptionProviderStatus | undefined {
  return status?.providers.find(each => each.id === provider)
}

type ChatGptState =
  | { kind: 'starting' }
  | { kind: 'waiting'; signIn: MatrixSubscriptionSignIn }
  | { kind: 'failed' }

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export const MATRIX_CONNECTABLE_SERVICES: readonly MatrixSubscriptionProvider[] = MATRIX_SUBSCRIPTION_PROVIDERS

/** The chooser sheet: one row per connectable service, with its state when it is linked already. */
export function SubscriptionChooser({
  onChoose,
  onOpenChange,
  open,
  providers
}: {
  onChoose(provider: MatrixSubscriptionProvider): void
  onOpenChange(open: boolean): void
  open: boolean
  /** The account's current state, so a linked or signed-out service says so. */
  providers?: readonly MatrixSubscriptionProviderStatus[]
}) {
  const copy = useMatrixSettingsCopy()

  return (
    <ConsentBoundary><Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="ak-sheet max-w-none gap-0 overflow-hidden border-0 p-0" data-matrix-subscription-chooser>
        <div className="ak-sheet-head">
          <DialogTitle className="ak-sheet-title">{copy.yourSubscription}</DialogTitle>
          <DialogDescription className="sr-only">{copy.subscriptionHelp}</DialogDescription>
        </div>
        <div className="ak-sheet-body">
          {MATRIX_CONNECTABLE_SERVICES.map(candidate => {
            const state = providers?.find(each => each.id === candidate)
            const linked = state?.connected === true || state?.localConnected === true

            return (
              <button
                className="ak-row w-full text-left"
                data-matrix-subscription-choice={candidate}
                key={candidate}
                onClick={() => onChoose(candidate)}
                type="button"
              >
                <span className="ak-row-main">
                  <span>{matrixSubscriptionProviderLabel(candidate)}</span>
                  <span className="ak-row-meta">
                    {linked
                      ? copy.connected
                      : state?.needsSignIn
                        ? copy.chatgptSignedOut
                        : candidate === 'openai-codex'
                          ? copy.chatgptHelp
                          : copy.opencodeHelp}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog></ConsentBoundary>
  )
}

/** The rail's Connect: choose a service, then its own native sign-in or key, all in place. */
export function SubscriptionConnectFlow({
  bridge,
  onClose,
  onConnected,
  providers
}: {
  bridge?: MatrixSubscriptionsBridge
  onClose(): void
  onConnected(): void
  providers?: readonly MatrixSubscriptionProviderStatus[]
}) {
  const [chosen, setChosen] = useState<MatrixSubscriptionProvider | null>(null)

  return (
    <ConsentBoundary><>
      <SubscriptionChooser
        onChoose={setChosen}
        onOpenChange={next => {
          if (!next && !chosen) {
            onClose()
          }
        }}
        open={!chosen}
        providers={providers}
      />
      {chosen && (
        <SubscriptionConnectDialog
          bridge={bridge}
          onClose={onClose}
          onConnected={onConnected}
          open
          provider={chosen}
        />
      )}
    </></ConsentBoundary>
  )
}

/** The one compact native sign-in: one code, one link, and the note. */
export function SubscriptionConnectDialog({
  bridge: override,
  onClose,
  onConnected,
  open,
  provider
}: {
  /** A surface that brings its own subscriptions bridge (the picker on the assistant card). */
  bridge?: MatrixSubscriptionsBridge
  onClose(): void
  onConnected(): void
  open: boolean
  provider: MatrixSubscriptionProvider
}) {
  const copy = useMatrixSettingsCopy()
  const windowBridge = useSubscriptionsBridge()
  const bridge = override ?? windowBridge
  const [chatgpt, setChatgpt] = useState<ChatGptState>({ kind: 'starting' })
  const [key, setKey] = useState('')
  const [pendingKey, setPendingKey] = useState(false)
  const [keyError, setKeyError] = useState(false)
  const session = useRef<string | null>(null)
  const disposed = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeRef = useRef(onClose)
  const connectedRef = useRef(onConnected)
  closeRef.current = onClose
  connectedRef.current = onConnected

  const stopPolling = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const cancel = useCallback(() => {
    const active = session.current
    session.current = null
    stopPolling()

    if (active) {
      void bridge?.cancelChatGpt(active).catch(() => undefined)
    }
  }, [bridge, stopPolling])

  const start = useCallback(async () => {
    if (!bridge) {
      setChatgpt({ kind: 'failed' })

      return
    }

    setChatgpt({ kind: 'starting' })

    try {
      const result = await bridge.startChatGpt()

      if (disposed.current) {
        return
      }

      if (result.status === 'cancelled') {
        closeRef.current()

        return
      }

      if (result.status === 'connected') {
        connectedRef.current()
        closeRef.current()

        return
      }

      session.current = result.session
      setChatgpt({ kind: 'waiting', signIn: result })
    } catch {
      if (!disposed.current) {
        setChatgpt({ kind: 'failed' })
      }
    }
  }, [bridge])

  // A fresh dialog starts a fresh flow; closing it cancels the backend's session.
  useEffect(() => {
    disposed.current = false

    if (!open) {
      cancel()
      setChatgpt({ kind: 'starting' })
      setKey('')
      setKeyError(false)

      return
    }

    if (provider === 'openai-codex') {
      void start()
    }

    return () => {
      disposed.current = true
      cancel()
    }
  }, [cancel, open, provider, start])

  // Poll the opaque native handle at the interval Hermes asked for.
  useEffect(() => {
    if (chatgpt.kind !== 'waiting' || !bridge) {
      return
    }

    const signIn = chatgpt.signIn
    const deadline = Date.now() + signIn.expiresIn * 1000

    const poll = async () => {
      if (disposed.current || session.current !== signIn.session) {
        return
      }

      if (Date.now() > deadline) {
        session.current = null
        setChatgpt({ kind: 'failed' })

        return
      }

      try {
        const result = await bridge.pollChatGpt(signIn.session)

        if (disposed.current || session.current !== signIn.session) {
          return
        }

        if (result.status === 'connected') {
          session.current = null
          connectedRef.current()
          closeRef.current()

          return
        }

        if (result.status === 'cancelled') {
          session.current = null
          closeRef.current()

          return
        }

        if (result.status === 'failed') {
          session.current = null
          setChatgpt({ kind: 'failed' })

          return
        }
      } catch {
        if (!disposed.current && session.current === signIn.session) {
          session.current = null
          setChatgpt({ kind: 'failed' })
        }

        return
      }

      timer.current = setTimeout(() => void poll(), signIn.pollInterval * 1000)
    }

    timer.current = setTimeout(() => void poll(), signIn.pollInterval * 1000)

    return stopPolling
  }, [bridge, chatgpt, stopPolling])

  const saveKey = async () => {
    if (!bridge || pendingKey || key.trim().length === 0) {
      return
    }

    setPendingKey(true)
    setKeyError(false)

    try {
      const result = await bridge.connectOpenCode(key)

      if (result.status === 'applied') {
        connectedRef.current()
        closeRef.current()

        return
      }
    } catch {
      if (!disposed.current) {
        setKeyError(true)
      }
    } finally {
      // The key lives in this input for the length of one save, never in app state.
      setKey('')
      setPendingKey(false)
    }
  }

  const providerLabel = matrixSubscriptionProviderLabel(provider)

  return (
    <ConsentBoundary><Dialog onOpenChange={next => !next && onClose()} open={open}>
      <DialogContent className="max-w-sm" data-matrix-subscription-dialog={provider}>
        <DialogHeader>
          <DialogTitle>{providerLabel}</DialogTitle>
          <DialogDescription className="sr-only">{provider === 'openai-codex' ? copy.chatgptHelp : copy.opencodeHelp}</DialogDescription>
        </DialogHeader>
        {provider === 'openai-codex' ? (
          <div className="grid gap-3">
            {chatgpt.kind === 'starting' && (
              <p className="flex items-center gap-2 text-sm text-(--ui-text-secondary)" role="status">
                <Spinner aria-hidden className="size-4 animate-spin" />
                {copy.working}
              </p>
            )}
            {chatgpt.kind === 'waiting' && (
              <>
                <p className="text-sm text-(--ui-text-secondary)">{copy.codeLabel}</p>
                <p
                  className="rounded-md border border-border px-3 py-2 text-center font-mono text-lg tracking-[0.2em] select-text"
                  data-matrix-subscription-code
                >
                  {chatgpt.signIn.userCode}
                </p>
                <Button
                  aria-label={copy.openPage}
                  className="h-auto justify-start px-0 text-xs"
                  onClick={() => void window.atumMatrix.openLink(chatgpt.signIn.url).catch(() => undefined)}
                  size="sm"
                  variant="link"
                >
                  {chatgpt.signIn.url.replace(/^https?:\/\//u, '')}
                </Button>
                <p className="flex items-center gap-2 text-xs text-(--ui-text-tertiary)" role="status">
                  <Spinner aria-hidden className="size-3.5 animate-spin" />
                  {copy.waiting}
                </p>
                <details className="text-xs text-(--ui-text-tertiary)" data-matrix-subscription-steps>
                  <summary className="cursor-pointer select-none">{copy.howItWorks}</summary>
                  <ol className="mt-2 grid list-decimal gap-1 ps-4">
                    {copy.chatgptSteps.map(step => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </details>
                <Button onClick={onClose} size="sm" variant="ghost">
                  {copy.cancel}
                </Button>
              </>
            )}
            {chatgpt.kind === 'failed' && (
              <>
                <NoticeBand role="alert" tone="failure">
                  {copy.failed}
                </NoticeBand>
                <div className="flex gap-2">
                  <Button onClick={() => void start()} size="sm">
                    {copy.tryAgain}
                  </Button>
                  <Button onClick={onClose} size="sm" variant="ghost">
                    {copy.cancel}
                  </Button>
                </div>
              </>
            )}
            <p className="text-xs text-(--ui-text-tertiary)" data-matrix-subscription-note>
              {copy.chatgptNote}
            </p>
          </div>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={event => {
              event.preventDefault()
              void saveKey()
            }}
          >
            <Input
              aria-label={copy.keyLabel}
              autoComplete="off"
              data-matrix-subscription-key
              onChange={event => setKey(event.target.value)}
              placeholder={copy.keyPlaceholder}
              spellCheck={false}
              type="password"
              value={key}
            />
            {keyError && (
              <NoticeBand role="alert" tone="failure">
                {copy.failed}
              </NoticeBand>
            )}
            <div className="flex gap-2">
              <Button disabled={pendingKey || key.trim().length === 0} size="sm" type="submit">
                {pendingKey ? copy.working : copy.save}
              </Button>
              <Button onClick={onClose} size="sm" type="button" variant="ghost">
                {copy.cancel}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog></ConsentBoundary>
  )
}

/** The one line a ChatGPT state reads as, in Settings' row and in its dialog. */
export function matrixChatGptStateLine(
  copy: ReturnType<typeof useMatrixSettingsCopy>,
  state: MatrixSubscriptionView['state']
): string | undefined {
  switch (state) {
    case 'ready':
      return copy.chatgptReady
    case 'cloud_setting_up':
      return copy.chatgptCloudSettingUp
    case 'cloud_failed':
      return copy.chatgptCloudFailed
    case 'needs_sign_in':
      return copy.chatgptSignedOut
    case 'unavailable':
      return copy.statusUnavailable
    default:
      return undefined
  }
}

/** Manage: one honest state line, at most one act that fixes it, and the quiet way out. */
export function SubscriptionManageDialog({
  onChanged,
  onClose,
  onReconnect,
  onRetryCloud,
  open,
  provider,
  status,
  view
}: {
  onChanged(): void
  onClose(): void
  onReconnect(): void
  /** ChatGPT only: one more cloud setup attempt (the row's Try again). */
  onRetryCloud?(): void
  open: boolean
  provider: MatrixSubscriptionProvider
  status?: MatrixSubscriptionProviderStatus
  view?: MatrixSubscriptionView
}) {
  const copy = useMatrixSettingsCopy()
  const bridge = useSubscriptionsBridge()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const relay = status?.relay
  const chatgpt = provider === 'openai-codex'
  const state = chatgpt ? (view?.state ?? 'ready') : 'ready'

  const disconnect = async () => {
    if (!bridge || pending) {
      return
    }

    setPending(true)
    setFailed(false)

    try {
      if (chatgpt) {
        await bridge.disconnectChatGpt()
      } else {
        await bridge.disconnectOpenCode()
      }

      onChanged()
      onClose()
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <ConsentBoundary><Dialog onOpenChange={next => !next && onClose()} open={open}>
      <DialogContent className="max-w-sm" data-matrix-subscription-manage={provider}>
        <DialogHeader>
          <DialogTitle>{matrixSubscriptionProviderLabel(provider)}</DialogTitle>
          <DialogDescription className="sr-only">{chatgpt ? copy.chatgptHelp : copy.opencodeHelp}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {chatgpt ? (
            <>
              <p
                className="flex items-start gap-2 text-sm font-medium text-(--ui-text)"
                data-matrix-subscription-state={state}
                role="status"
              >
                {state === 'ready' ? (
                  <Check aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={2.4} />
                ) : state === 'cloud_setting_up' ? (
                  <Spinner aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin" />
                ) : null}
                <span>{matrixChatGptStateLine(copy, state)}</span>
              </p>
              {state === 'ready' && relay?.state === 'enabled' && (
                <p className="text-xs text-(--ui-text-tertiary)">{relay.thisMac ? copy.relayOn : copy.relayOnAnotherMac}</p>
              )}
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 text-sm font-medium text-(--ui-text)" data-matrix-subscription-connected>
                <Check aria-hidden className="size-4" strokeWidth={2.4} />
                {copy.connected}
              </p>
              <p className="text-sm text-(--ui-text-secondary)">{copy.accountWide}</p>
            </>
          )}
          {failed && (
            <NoticeBand role="alert" tone="failure">
              {copy.failed}
            </NoticeBand>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {chatgpt && view?.fix === 'retry_cloud' && onRetryCloud && (
              <Button disabled={pending} onClick={onRetryCloud} size="sm">
                {copy.tryAgain}
              </Button>
            )}
            {!chatgpt && (
              <Button disabled={pending} onClick={onReconnect} size="sm" variant="secondary">
                {copy.reconnect}
              </Button>
            )}
            <Button disabled={pending} onClick={() => void disconnect()} size="sm" variant="text">
              {pending ? copy.working : copy.disconnect}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog></ConsentBoundary>
  )
}
