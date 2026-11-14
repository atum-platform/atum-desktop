import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { AtumAccountForm } from '@/app/chat/sidebar/atum-account-form'
import { GoogleMark } from '@/components/brand/google-mark'
import { Button } from '@/components/ui/button'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { authFailureKind } from '@/lib/atum-auth'
import {
  $atumAccountStatus,
  cancelAtumSignIn,
  retryAtumAccountRestore,
  signInToAtum,
  signInToAtumWithPassword
} from '@/store/atum-messaging'
import { $desktopBoot } from '@/store/boot'

import { canRetryAccountRestore } from '../../../shared/account-recovery'

import { AuthFrame } from './auth-frame'
import { useAuthWindowMode } from './use-auth-window-mode'

/**
 * The Atum sign-in gate — one compact floating-glass OS window, not a card
 * floating over the shell and emphatically not a form crammed into a 268px
 * rail. When it is showing, the rail, roster, chat, and workspace are not in
 * the DOM at all; `shell.test.tsx` asserts that, so the inline-form regression
 * cannot return silently.
 *
 * Geometry is part of the design, not an afterthought. Mounting this view puts
 * the primary BrowserWindow into 'auth' mode (compact + centered) and
 * unmounting restores the user's real geometry — see `use-auth-window-mode.ts`
 * for the full state lifecycle. Before that contract existed, the transparent
 * frameless window stayed at its full product size, so a 400px form sat in the
 * middle of a ~1220x800 invisible rectangle that intercepted every click meant
 * for the desktop behind it.
 *
 * The plate therefore FILLS the window (inside the same 10px transparent gutter
 * the shell uses) rather than being a fixed island: at compact size it is the
 * window, and if the bridge is unavailable — or the window is full screen,
 * which auth mode deliberately leaves alone — the content stays centered and
 * max-width bounded so it still reads correctly.
 *
 * It is deliberately NOT dismissable (DESIGN.md requires that be explicit).
 * `Esc` cancels an in-flight sign-in and does nothing else — one cancel
 * gesture, one action.
 */
export function AtumAuthView({ exiting = false }: { exiting?: boolean }) {
  const { t } = useI18n()

  useAuthWindowMode()

  const account = useStore($atumAccountStatus)
  const boot = useStore($desktopBoot)
  const awaitingAccountStatus = boot.phase === 'renderer.account' && !account.configured
  const [method, setMethod] = useState<'google' | 'password' | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)
  const retryFlight = useRef(false)
  const alertRef = useRef<HTMLDivElement>(null)

  const signingIn = account.state === 'signing_in'
  const expired = account.state === 'expired'
  const failureKind = account.state === 'error' ? authFailureKind(account.errorCode) : null

  const failureCopy =
    failureKind === 'credentials'
      ? t.dm.signInFailed
      : failureKind === 'declined'
        ? t.dm.signInDeclined
        : failureKind === 'browser'
          ? t.dm.signInBrowserIncomplete
          : failureKind === 'network'
            ? t.dm.signInOffline
            : failureKind === 'storage'
              ? t.dm.signInStorage
              : failureKind === 'platform'
                ? t.dm.signInPlatform
                : failureKind === 'local'
                  ? t.dm.signInLocal
                  : failureKind === 'provider'
                    ? t.dm.signInProviderDown
                    : null

  // Whether this window has been *asked* for anything yet. A cold start can
  // arrive here already carrying a failure — the account service was
  // unreachable, or the stored credential had lapsed — and the copy above is
  // written for a rejected attempt. Announcing "Try again in a few minutes"
  // over a form nobody has touched answers a question that was never asked,
  // and names sign-in as the broken thing when sign-in never ran.
  const attempted = method !== null

  // At startup, the only honest claim is that the check itself did not land.
  // Device-class failures (storage, platform, local) are already written as
  // conditions rather than verdicts, so they carry their own copy through.
  const canRetry =
    !attempted && !account.account && account.state === 'error' && canRetryAccountRestore(account.errorCode)

  const startupNotice = canRetry ? (retryFailed ? t.dm.signInRetryFailed : t.dm.signInNotice) : failureCopy
  const noticeCopy = attempted ? failureCopy : startupNotice

  const retryRestore = async () => {
    if (retryFlight.current) {
      return
    }

    retryFlight.current = true
    setRetryFailed(false)
    setRetrying(true)

    try {
      setRetryFailed(!(await retryAtumAccountRestore()))
    } finally {
      retryFlight.current = false
      setRetrying(false)
    }
  }

  // A failure the person just caused is the one thing that must interrupt:
  // move focus to the band so the reason is read before they retype. A
  // startup condition interrupts nothing — it is announced politely and
  // leaves the caret where the user put it.
  useEffect(() => {
    if (noticeCopy && attempted) {
      alertRef.current?.focus()
    }
  }, [attempted, noticeCopy])

  const noProviders = !account.providers.google && !account.providers.password

  return (
    <ConsentBoundary><AuthFrame
      description={expired ? t.atum.auth.expiredBody : t.dm.brandLine}
      exiting={exiting}
      footer={
        <p className="mt-3 text-(length:--atum-t-body) leading-(--atum-lh-body) text-(--atum-ink-faint)">
          {t.atum.auth.terms}
        </p>
      }
      onKeyDown={event => {
        if (event.key === 'Escape' && signingIn) {
          event.preventDefault()
          void cancelAtumSignIn()
        }
      }}
      title={expired ? t.atum.auth.expiredTitle : t.atum.auth.title}
    >
      {noticeCopy && (
        <NoticeBand
          className="mt-3"
          ref={alertRef}
          role={attempted ? 'alert' : 'status'}
          tabIndex={attempted ? -1 : undefined}
          tone={attempted ? 'failure' : 'notice'}
        >
          {noticeCopy}
          {canRetry && (
            <Button
              aria-busy={retrying}
              aria-disabled={retrying}
              className="mt-2 block"
              onClick={() => void retryRestore()}
              size="inline"
              type="button"
              variant="textStrong"
            >
              {retrying ? t.dm.checkingSignIn : t.dm.retrySignInCheck}
            </Button>
          )}
        </NoticeBand>
      )}

      {awaitingAccountStatus ? (
        account.state === 'unconfigured' && (
          <p className="mt-6 text-(length:--atum-t-ui) leading-(--atum-lh-ui) text-(--atum-ink-muted)" role="status">
            {t.dm.checkingSignIn}
          </p>
        )
      ) : !account.configured || noProviders ? (
        <p className="mt-6 text-(length:--atum-t-ui) leading-(--atum-lh-ui) text-(--atum-ink-muted)">
          {t.dm.unavailable}
        </p>
      ) : (
        <div className="mt-3">
          {account.providers.google && (
            <Button
              aria-busy={signingIn && method === 'google'}
              className="h-11 w-full rounded-[var(--atum-r-input)] text-[0.875rem]"
              disabled={signingIn || retrying}
              onClick={() => {
                setMethod('google')
                void signInToAtum()
              }}
              type="button"
              variant="secondary"
            >
              {signingIn && method === 'google' ? (
                t.dm.googlePending
              ) : (
                <>
                  <GoogleMark className="shrink-0" />
                  {t.dm.continueWithGoogle}
                </>
              )}
            </Button>
          )}

          {account.providers.google && account.providers.password && (
            <div className="my-3 flex items-center gap-3 text-(length:--atum-t-body) text-(--atum-ink-faint)">
              <span className="h-px flex-1 bg-(--atum-line)" />
              <span>{t.dm.or}</span>
              <span className="h-px flex-1 bg-(--atum-line)" />
            </div>
          )}

          {account.providers.password && (
            <AtumAccountForm
              appearance="atum"
              autoFocus
              copy={{
                identifier: t.dm.identifier,
                identifierHint: t.dm.identifierHint,
                identifierPlaceholder: t.dm.identifierPlaceholder,
                identifierRequired: t.dm.identifierRequired,
                password: t.dm.password,
                passwordRequired: t.dm.passwordRequired,
                signIn: expired ? t.dm.authExpiredAction : t.dm.signIn,
                signingIn: retrying ? t.dm.checkingSignIn : t.dm.signingIn
              }}
              failureKind={failureKind}
              onSubmit={async credentials => {
                setMethod('password')
                await signInToAtumWithPassword(credentials)
                const next = $atumAccountStatus.get()

                return next.state === 'signed_in' || authFailureKind(next.errorCode) === 'credentials'
              }}
              pending={signingIn || retrying}
            />
          )}

          {signingIn && (
            <Button className="mt-2 w-full" onClick={() => void cancelAtumSignIn()} type="button" variant="text">
              {t.dm.cancelSignIn}
            </Button>
          )}
        </div>
      )}
    </AuthFrame></ConsentBoundary>
  )
}
