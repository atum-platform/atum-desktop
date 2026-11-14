import { Fragment, useEffect, useState } from 'react'

import { AuthFrame } from '@/app/atum/auth-frame'
import { BrandMark } from '@/components/brand-mark'
import { GoogleMark } from '@/components/brand/google-mark'
import { Button } from '@/components/ui/button'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { Mail, Spinner } from '@/lib/icons'

import type { MatrixEmailSignIn, MatrixSignInMethod, MatrixSnapshot } from '../../shared/matrix'

import { ATUM_LINKS } from './atum-links'
import { useMatrixCopy } from './copy'
import { MatrixLanguageSettings } from './language'
import { useSignInCopy } from './sign-in-copy'
import { MatrixSignOutConfirm } from './sign-out'

export interface MatrixSignInProps {
  /** Main's session state and error code (`snapshot.state`, `snapshot.error`). */
  state: MatrixSnapshot['state']
  error: string | null
  /** A bridge call from this window failed. */
  failed: boolean
  /** Whether a way in was chosen in this window: an error after it is that sign-in failing. */
  attempted?: boolean
  /** Whether the server takes email sign-in (`snapshot.signInMethods.email`). Only
   * `unavailable` hides the email ways; `unknown` keeps them, and the sign-in still refuses.
   * Email sign-in is live (2026-10-25), so before the probe answers the window draws what the
   * server almost always confirms: drawing Google alone first would flash the email ways in. */
  email?: MatrixEmailSignIn
  /** An earlier Hermes enrollment still needs an administrator (`snapshot.agentCleanupRequired`). */
  cleanupRequired?: boolean
  /** The browser is back and the sign-in finishes here (`snapshot.signInReturned`). */
  returned?: boolean
  /** The browser has opened for the sign-in (`snapshot.signInBrowser`; absent means it has). */
  browser?: boolean
  onCancel(): void
  /** Google, email, or a new account by email; every way runs in the browser. */
  onSignIn(method: MatrixSignInMethod): void
}

/** The terms line with its two links, in each language's own word order. */
function LegalLine() {
  const words = useSignInCopy()

  return (
    <ConsentBoundary><p className="text-(length:--atum-t-caption) leading-[1.5] text-pretty text-(--atum-ink-muted)" data-matrix-legal>
      {words.legal.split(/(\{terms\}|\{privacy\})/).map((part, index) =>
        part === '{terms}' || part === '{privacy}' ? (
          <Button
            className="text-(length:--atum-t-caption) text-(--atum-ink-soft) underline decoration-current/35 underline-offset-2 hover:text-(--atum-ink)"
            key={part}
            onClick={() =>
              void window.atumMatrix
                ?.openLink(part === '{terms}' ? ATUM_LINKS.terms : ATUM_LINKS.privacy)
                .catch(() => {})
            }
            size="inline"
            type="button"
            variant="text"
          >
            {part === '{terms}' ? words.terms : words.privacy}
          </Button>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        )
      )}
    </p></ConsentBoundary>
  )
}

/** The approved first-run board keeps one legal line and the language at the foot. */
function SignInFooter() {
  return (
    <ConsentBoundary><div className="flex flex-col gap-2" data-matrix-auth-footer>
      <LegalLine />
      <div className="flex min-h-7 items-center justify-end gap-3">
        <div className="ms-auto">
          <MatrixLanguageSettings quiet />
        </div>
      </div>
    </div></ConsentBoundary>
  )
}

/**
 * The sign-in window, for a Mac with no account signed in: the welcome and one sentence on
 * what Atum is (`dm.brandLine`: an AI assistant), the ways in, and a quiet footer: the
 * assistant's cloud sentence with the privacy policy, the terms, usage sharing (one small
 * switch, on unless the person turns it off; the same install-wide setting as Settings ›
 * Help) and the language. **Continue with Google**
 * opens Google's account picker in the browser; **Continue with email** opens the sign-in
 * server's own Atum-styled sign-in page, and **Create an account** its registration page
 * (main picks the page: sign-in-entry.ts). Both come back here by themselves; nothing else
 * is asked first. The window only ever offers ways in that work: when main has learned the
 * server takes no email sign-in (`email: 'unavailable'`), Google is the only button and the
 * line under it says Google also creates an account. A sign-in that did not finish says
 * which way failed (trying it again is the same button). An account already saved on this
 * Mac never lands here: when it can't be opened or reached, MatrixAccountUnavailable or the
 * launch says so. Escape cancels a sign-in in progress and does nothing else.
 *
 * One saved account does land here: one whose session the sign-in server ended
 * (`matrix_session_ended`, ). The window says so in
 * one sentence over the same ways in, since signing in again with that account brings
 * everything back. Signing in with another account is refused (`matrix_account_mismatch`),
 * and only then does the window offer a quiet Sign out, confirmed in place: the explicit way to
 * switch accounts.
 */
export function MatrixSignIn({
  attempted = false,
  cleanupRequired = false,
  email = 'unknown',
  error,
  failed,
  onCancel,
  onSignIn,
  returned = false,
  browser = true,
  state
}: MatrixSignInProps) {
  const { t } = useI18n()
  const copy = useMatrixCopy()
  const words = useSignInCopy()
  // Which way in the browser is open for; the window shows the wait on that button.
  const [chosen, setChosen] = useState<MatrixSignInMethod>('google')
  const [signingOut, setSigningOut] = useState(false)
  const pending = state === 'signing_in'
  const mismatch = error === 'matrix_account_mismatch' && !pending

  // The confirmation belongs to the refusal that offered it.
  useEffect(() => {
    if (!mismatch) {
      setSigningOut(false)
    }
  }, [mismatch])
  const unavailable = pending || state === 'connecting'
  const emailWays = email !== 'unavailable'
  const waitingOn = pending ? (chosen === 'google' || !emailWays ? 'google' : 'email') : null

  const start = (method: MatrixSignInMethod) => {
    setChosen(method)
    onSignIn(method)
  }

  const failure = { google: words.failedGoogle, email: words.failedEmail, create: words.failedCreate }

  const notice =
    error === 'matrix_login_timed_out'
      ? words.timedOut
      : error === 'matrix_password_unavailable'
        ? chosen === 'create'
          ? words.createUnavailable
          : words.passwordUnavailable
        : mismatch
          ? words.accountMismatch
          : !pending && (failed || state === 'error')
            ? attempted
              ? failure[chosen]
              : words.notConnected
            : error === 'matrix_session_ended' && !pending
              ? words.sessionEnded
              : null

  // The person is in the browser while this waits, so focus may be anywhere when they
  // come back: listen on the window, not on the frame.
  useEffect(() => {
    if (!pending) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) {
        event.preventDefault()
        onCancel()
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel, pending])

  // The button the browser is open for keeps its full ink and says what it waits for, with
  // the Kit's spinner ring (the atom only means the assistant is at work): it is a status,
  // not a dead control. The other way in is disabled. Once
  // the browser is back (the window is in front again), it says the sign-in is finishing here;
  // before the browser has opened, that it is opening.
  const waiting = (
    <>
      <Spinner className="size-4 animate-spin" />
      {returned ? words.returning : browser ? words.waiting : words.opening}
    </>
  )

  return (
    <ConsentBoundary><AuthFrame
      aside={<SignInFooter />}
      // Atum Kit sign-in board: one centred column, the eclipse on a raised circle. The welcome
      // story's mark lands here.
      brand={
        <span className="atum-auth-mark-plate" data-matrix-auth-mark-plate>
          <BrandMark className="size-12 rounded-full" data-matrix-auth-mark />
        </span>
      }
      centred
      description={words.tagline}
      title={t.atum.auth.title}
    >
      {cleanupRequired && (
        <NoticeBand className="mt-5" tone="notice">
          {copy.enrollmentOrphaned}
        </NoticeBand>
      )}
      {notice && (
        <NoticeBand className="mt-5" role="status" tone="notice">
          {notice}
        </NoticeBand>
      )}
      {mismatch && signingOut ? (
        // Deciding to sign out: the confirmation takes the ways in's place; Cancel brings them back.
        <div className="mt-5 rounded-[var(--atum-r-card)] bg-(--atum-sunk) px-4 py-3.5" data-matrix-sign-in-sign-out>
          <MatrixSignOutConfirm onCancel={() => setSigningOut(false)} snapshot={{}} />
        </div>
      ) : (
        <>
          {mismatch && (
            <div className="mt-2 flex justify-end">
              <Button
                data-matrix-switch-account
                onClick={() => setSigningOut(true)}
                size="sm"
                type="button"
                variant="text"
              >
                {copy.signOut}
              </Button>
            </div>
          )}
          <div className="mt-7 flex w-full flex-col gap-2.5" data-matrix-ways-in>
            <Button
              aria-busy={waitingOn === 'google' || undefined}
              aria-disabled={waitingOn === 'google' || undefined}
              className="atum-google-button h-10 w-full rounded-full text-[0.875rem]"
              data-matrix-sign-in
              data-waiting={waitingOn === 'google' || undefined}
              disabled={unavailable && waitingOn !== 'google'}
              onClick={() => !unavailable && start('google')}
              type="button"
              variant="secondary"
            >
              {waitingOn === 'google' ? (
                waiting
              ) : (
                <>
                  <GoogleMark className="size-[18px] shrink-0" />
                  {t.dm.continueWithGoogle}
                </>
              )}
            </Button>
            {emailWays && (
              <Button
                aria-busy={waitingOn === 'email' || undefined}
                aria-disabled={waitingOn === 'email' || undefined}
                className="atum-email-button h-10 w-full rounded-full text-[0.875rem]"
                data-matrix-sign-in-email
                data-waiting={waitingOn === 'email' || undefined}
                disabled={unavailable && waitingOn !== 'email'}
                onClick={() => !unavailable && start('email')}
                type="button"
                variant="ghost"
              >
                {waitingOn === 'email' ? (
                  waiting
                ) : (
                  <>
                    <Mail aria-hidden className="size-[18px] shrink-0" />
                    {words.continueWithEmail}
                  </>
                )}
              </Button>
            )}
          </div>
          {pending ? (
            <Button className="mt-3 w-full" onClick={onCancel} type="button" variant="text">
              {t.dm.cancelSignIn}
            </Button>
          ) : !emailWays ? (
            // No email on this server: Google is how a new account starts too.
            <p
              className="mt-4 text-center text-(length:--atum-t-body) leading-(--atum-lh-body) text-(--atum-ink-muted)"
              data-matrix-new-with-google
            >
              {words.newHereGoogle}
            </p>
          ) : null}
        </>
      )}
    </AuthFrame></ConsentBoundary>
  )
}
