import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { suggestHandle } from '@/lib/atum-handle'
import { atumMessagingClient } from '@/lib/atum-messaging-client'
import { $atumAccountStatus, refreshAtumAccountStatus } from '@/store/atum-messaging'

import { type HandleAvailabilityState, handleSaveFailure, useHandleAvailability } from './use-handle-availability'

const SKIP_KEY_PREFIX = 'hermes.desktop.atum.usernameGate.skipped:'

function skipped(accountId: string): boolean {
  try {
    return window.localStorage.getItem(`${SKIP_KEY_PREFIX}${accountId}`) === 'true'
  } catch {
    return false
  }
}

function rememberSkip(accountId: string): void {
  try {
    window.localStorage.setItem(`${SKIP_KEY_PREFIX}${accountId}`, 'true')
  } catch {
    // Private mode or blocked storage: the gate simply returns next launch.
  }
}

/**
 * The one-time "choose your username" step. The hosted plane mints every
 * account a placeholder handle (`binh-sen-4821`) and tells the client whether
 * the person has ever chosen their own via `handle_customized`; the first
 * choice is free, every later change waits 30 days. So this shows exactly once
 * per account after the plane says `false`, prefilled from the person's name,
 * and it can be skipped — the placeholder is a real, working username.
 *
 * A plane that does not project the field yields `null`, and `null` never
 * opens the gate: it must not nag an account it cannot reason about.
 */
export function AtumUsernameGate() {
  const { t } = useI18n()
  const account = useStore($atumAccountStatus)
  const identity = account.account
  const signedIn = account.state === 'signed_in' || account.state === 'refreshing'
  const accountId = identity?.id ?? null
  const currentHandle = identity?.handle ?? null

  const eligible = signedIn && accountId !== null && currentHandle !== null && identity?.handleCustomized === false

  const [skippedFor, setSkippedFor] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveFailure, setSaveFailure] = useState<HandleAvailabilityState | null>(null)

  useEffect(() => {
    if (accountId && skipped(accountId)) {
      setSkippedFor(accountId)
    }
  }, [accountId])

  const open = eligible && skippedFor !== accountId
  const handle = draft ?? (suggestHandle(identity?.displayName) || currentHandle || '')
  const availability = useHandleAvailability(handle, { enabled: open, currentHandle })
  const state = saveFailure ?? availability.state

  const message =
    state === 'checking'
      ? t.atum.account.handleChecking
      : state === 'available'
        ? t.atum.account.handleAvailable
        : state === 'current'
          ? t.atum.account.handleCurrent
          : state === 'invalid'
            ? t.atum.account.handleInvalid
            : state === 'taken'
              ? t.atum.account.handleTaken
              : state === 'reserved'
                ? t.atum.account.handleReserved
                : state === 'cooldown'
                  ? t.atum.account.handleCooldown
                  : state === 'failed'
                    ? t.atum.account.handleFailed
                    : t.atum.account.handleHint

  if (!open || !accountId || !currentHandle) {
    return null
  }

  const keep = () => {
    rememberSkip(accountId)
    setSkippedFor(accountId)
  }

  const save = async () => {
    if (availability.state !== 'available' || saving) {
      return
    }

    setSaving(true)
    setSaveFailure(null)

    try {
      await atumMessagingClient().renameHandle(availability.value)
      // The plane answered with the whole identity and main adopted it; the
      // refreshed status carries `handleCustomized: true`, which closes this.
      await refreshAtumAccountStatus()
    } catch (error) {
      setSaveFailure(handleSaveFailure(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open>
      <DialogContent
        className="max-w-[27.5rem]"
        data-atum-username-gate
        onEscapeKeyDown={event => event.preventDefault()}
        onInteractOutside={event => event.preventDefault()}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{t.atum.usernameGate.title}</DialogTitle>
          <DialogDescription>{t.atum.usernameGate.body}</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="sr-only" htmlFor="atum-username-gate-input">
            {t.atum.usernameGate.label}
          </label>
          {/* Mock 2d: one 42px sunk field with the @ inside it. */}
          <div className="atum-input flex items-center gap-1.5">
            <span aria-hidden className="text-(--atum-ink-faint)">@</span>
            <input
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-[0.875rem] text-(--atum-ink) outline-none"
              id="atum-username-gate-input"
              maxLength={33}
              onChange={event => {
                setSaveFailure(null)
                setDraft(event.target.value.toLowerCase())
              }}
              spellCheck={false}
              value={handle}
            />
          </div>
          <p aria-live="polite" className="mt-2 text-(length:--atum-t-body) text-(--atum-ink-muted)">
            {message}
          </p>
          <p className="mt-1 text-(length:--atum-t-body) text-(--atum-ink-faint)">{t.atum.usernameGate.cooldownNote}</p>
          <div className="mt-[1.375rem] flex flex-wrap justify-end gap-2">
            <Button onClick={keep} type="button" variant="ghost">
              {t.atum.usernameGate.keep(currentHandle)}
            </Button>
            <Button aria-busy={saving} disabled={availability.state !== 'available' || saving} type="submit">
              {t.atum.usernameGate.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
