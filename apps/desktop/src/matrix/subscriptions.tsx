import { useCallback, useEffect, useRef, useState } from 'react'

import { ACCOUNT_PLAN_NAMES, connectionsCopy } from '@/app/connections/copy'
import { openAccountConnect } from '@/app/connections/store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { Check } from '@/lib/icons'

import { ACCOUNT_PLANS, type AccountPlan } from '../../shared/account-connections'
import type { MatrixSubscriptionsBridge } from '../../shared/matrix'
import {
  type MatrixSubscriptionProvider,
  matrixSubscriptionProviderLabel,
  type MatrixSubscriptionProviderStatus,
  type MatrixSubscriptionsStatus
} from '../../shared/matrix-subscriptions'

import { useMatrixSettingsCopy } from './settings-copy'

/**
 * The account's key-based subscription (OpenCode Go) and the doors into the one connect sheet. Device-held plans (ChatGPT, Claude,
 * Antigravity) are never signed in here: every Connect for them opens the account connect sheet (`@/app/connections`), which runs
 * the maker's own sign-in in Work on this Mac.
 */

/** The bridge, or none in a test/older main. */
export function useSubscriptionsBridge(): MatrixSubscriptionsBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.atumMatrix?.subscriptions
}

/** One account-level read of the key-based subscriptions, shared by every assistant of this account. */
export function useMatrixSubscriptions(scopeKey?: string) {
  const bridge = useSubscriptionsBridge()
  const [status, setStatus] = useState<MatrixSubscriptionsStatus | null>(null)
  const live = useRef(true)

  const reload = useCallback(async () => {
    if (!bridge) {
      return null
    }

    try {
      const next = await bridge.status()

      if (live.current) {
        setStatus(next)
      }

      return next
    } catch {
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

  return { bridge, reload, status }
}

export function subscriptionProviderStatus(
  status: MatrixSubscriptionsStatus | null,
  provider: MatrixSubscriptionProvider
): MatrixSubscriptionProviderStatus | undefined {
  return status?.providers.find(each => each.id === provider)
}

type Choice = AccountPlan | 'opencode-go'

/** The rail's Connect: every plan and the key subscription, one row each, with its state when it is linked already. */
export function SubscriptionChooser({
  onChoose,
  onOpenChange,
  open,
  providers
}: {
  onChoose(choice: Choice): void
  onOpenChange(open: boolean): void
  open: boolean
  /** The account's key-based state, so a linked OpenCode Go says so. */
  providers?: readonly MatrixSubscriptionProviderStatus[]
}) {
  const copy = useMatrixSettingsCopy()
  const { locale } = useI18n()
  const words = connectionsCopy(locale)
  const opencode = providers?.find(each => each.id === 'opencode-go')
  const choices: readonly Choice[] = [...ACCOUNT_PLANS, 'opencode-go']

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="ak-sheet max-w-none gap-0 overflow-hidden border-0 p-0" data-matrix-subscription-chooser>
        <div className="ak-sheet-head">
          <DialogTitle className="ak-sheet-title">{words.subscriptions}</DialogTitle>
          <DialogDescription className="sr-only">{copy.subscriptionHelp}</DialogDescription>
        </div>
        <div className="ak-sheet-body">
          {choices.map(choice => (
            <button
              className="ak-row w-full text-left"
              data-matrix-subscription-choice={choice}
              key={choice}
              onClick={() => onChoose(choice)}
              type="button"
            >
              <span className="ak-row-main">
                <span>{choice === 'opencode-go' ? matrixSubscriptionProviderLabel('opencode-go') : ACCOUNT_PLAN_NAMES[choice]}</span>
                {choice === 'opencode-go' && (
                  <span className="ak-row-meta">{opencode?.connected ? copy.connected : copy.opencodeHelp}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The rail's Connect: choose a service; a plan opens the account connect sheet, OpenCode Go its key field. */
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
  const [key, setKey] = useState(false)

  return (
    <>
      <SubscriptionChooser
        onChoose={choice => {
          if (choice === 'opencode-go') {
            setKey(true)

            return
          }

          onClose()
          openAccountConnect(choice)
        }}
        onOpenChange={next => {
          if (!next && !key) {
            onClose()
          }
        }}
        open={!key}
        providers={providers}
      />
      {key && (
        <SubscriptionConnectDialog bridge={bridge} onClose={onClose} onConnected={onConnected} open provider="opencode-go" />
      )}
    </>
  )
}

/**
 * Connect one subscription. ChatGPT opens the account connect sheet (and this dialog closes at once); OpenCode Go asks for its key
 * here, which lives in the input for the length of one save.
 */
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
  const [key, setKey] = useState('')
  const [pendingKey, setPendingKey] = useState(false)
  const [keyError, setKeyError] = useState(false)
  const disposed = useRef(false)
  const plan = provider === 'openai-codex'

  useEffect(() => {
    disposed.current = false

    if (open && plan) {
      openAccountConnect('codex')
      onClose()
    }

    if (!open) {
      setKey('')
      setKeyError(false)
    }

    return () => {
      disposed.current = true
    }
  }, [onClose, open, plan])

  if (plan) {
    return null
  }

  const saveKey = async () => {
    if (!bridge || pendingKey || key.trim().length === 0) {
      return
    }

    setPendingKey(true)
    setKeyError(false)

    try {
      const result = await bridge.connectOpenCode(key)

      if (result.status === 'applied') {
        onConnected()
        onClose()

        return
      }
    } catch {
      if (!disposed.current) {
        setKeyError(true)
      }
    } finally {
      setKey('')
      setPendingKey(false)
    }
  }

  return (
    <Dialog onOpenChange={next => !next && onClose()} open={open}>
      <DialogContent className="max-w-sm" data-matrix-subscription-dialog={provider}>
        <DialogHeader>
          <DialogTitle>{matrixSubscriptionProviderLabel(provider)}</DialogTitle>
          <DialogDescription className="sr-only">{copy.opencodeHelp}</DialogDescription>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  )
}

/** OpenCode Go's Manage: connected, account-wide, Change key, Disconnect. */
export function SubscriptionManageDialog({
  onChanged,
  onClose,
  onReconnect,
  open
}: {
  onChanged(): void
  onClose(): void
  onReconnect(): void
  open: boolean
}) {
  const copy = useMatrixSettingsCopy()
  const bridge = useSubscriptionsBridge()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  const disconnect = async () => {
    if (!bridge || pending) {
      return
    }

    setPending(true)
    setFailed(false)

    try {
      await bridge.disconnectOpenCode()
      onChanged()
      onClose()
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog onOpenChange={next => !next && onClose()} open={open}>
      <DialogContent className="max-w-sm" data-matrix-subscription-manage="opencode-go">
        <DialogHeader>
          <DialogTitle>{matrixSubscriptionProviderLabel('opencode-go')}</DialogTitle>
          <DialogDescription className="sr-only">{copy.opencodeHelp}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="flex items-center gap-2 text-sm font-medium text-(--ui-text)" data-matrix-subscription-connected>
            <Check aria-hidden className="size-4" strokeWidth={2.4} />
            {copy.connected}
          </p>
          <p className="text-sm text-(--ui-text-secondary)">{copy.accountWide}</p>
          {failed && (
            <NoticeBand role="alert" tone="failure">
              {copy.failed}
            </NoticeBand>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={pending} onClick={onReconnect} size="sm" variant="secondary">
              {copy.reconnect}
            </Button>
            <Button disabled={pending} onClick={() => void disconnect()} size="sm" variant="text">
              {pending ? copy.working : copy.disconnect}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
