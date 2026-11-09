import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { AuthFrame } from '@/app/atum/auth-frame'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'

import { useMatrixCopy } from './copy'
import { $matrixDesktopServices } from './desktop-services'
import { MatrixFeedbackForm } from './desktop-settings'
import { MatrixLanguageSettings } from './language'
import { useLaunchCopy } from './launch-copy'
import { useSignInCopy } from './sign-in-copy'
import { MatrixSignOutConfirm } from './sign-out'
import { MATRIX_ENGINE_ERRORS } from './startup-screen'

/** The renderer could not read main's first snapshot: nothing is known about an account. */
export const MATRIX_SNAPSHOT_UNAVAILABLE = 'matrix_snapshot_unavailable'

/** Errors about the account saved on this Mac (or about not knowing it), never the outcome
 * of a sign-in just tried. Never a session that is over: Try again could not bring it back,
 * so an ended session (`matrix_session_ended`) gets the sign-in with its notice (sign-in.tsx),
 * and a refused token alone (`matrix_signed_out`) is a question main puts to the sign-in
 * server before anything is shown . */
const ACCOUNT_ERRORS = new Set([
  MATRIX_SNAPSHOT_UNAVAILABLE,
  'matrix_sign_out_pending',
  'matrix_vault_unavailable',
  'matrix_sdk_start_failed',
  'matrix_sdk_stopped',
  'matrix_disk_full'
])

/**
 * Whether the window, with no account it can open, is about an account saved here rather
 * than signing in: its session is in error with one of the account's own errors. Then it
 * shows MatrixAccountUnavailable, never the ways in, which a saved record would refuse
 * anyway (`matrix_sign_out_first`), or when the renderer could not read main's first
 * snapshot at all (then only Try again). Any other error, before or after a way in was
 * tried, is not about a saved account (a Mac that never signed in has none), so the sign-in
 * window shows it as a notice (sign-in.tsx).
 */
export function matrixAccountUnavailable({ error, state }: Pick<MatrixSnapshot, 'error' | 'state'>): boolean {
  return (state === 'error' || state === 'offline') && ACCOUNT_ERRORS.has(error ?? '')
}

/**
 * The compact window for an account it can't open: the saved sign-in can't be read, its
 * session can't be reached before anything is known about it, or a sign-out didn't finish
 * its cleanup. One heading, one sentence, one main action (Try again, or Sign out to finish
 * signing out) and, under it, the quiet way to start over: signing out, confirmed in place.
 */
export function MatrixAccountUnavailable({
  onRetry,
  onSignOut,
  snapshot
}: {
  onRetry(): Promise<unknown>
  onSignOut(): Promise<unknown>
  snapshot: MatrixSnapshot
}) {
  const { t } = useI18n()
  const copy = useMatrixCopy()
  const words = useSignInCopy()
  const launch = useLaunchCopy()
  const services = useStore($matrixDesktopServices)
  const [pending, setPending] = useState(false)
  const [panel, setPanel] = useState<'feedback' | 'sign-out' | null>(null)
  const signOutPending = snapshot.error === 'matrix_sign_out_pending'
  // Nothing known about an account here: a Mac that never signed in has nothing to sign out.
  const unknown = snapshot.error === MATRIX_SNAPSHOT_UNAVAILABLE
  const feedback = Boolean(services?.reporting.configured && window.atumDesktopServices)

  const { help, title } = signOutPending
    ? { title: words.signOutPendingTitle, help: words.signOutPendingHelp }
    : snapshot.error === 'matrix_vault_unavailable'
      ? { title: words.vaultTitle, help: words.vaultHelp }
      : MATRIX_ENGINE_ERRORS.has(snapshot.error ?? '')
        ? {
            title: launch.engineTitle,
            help: snapshot.error === 'matrix_disk_full' ? launch.diskFullHelp : launch.engineHelp
          }
        : { title: words.unavailableTitle, help: words.unavailableHelp }

  const act = () => {
    setPending(true)
    void (signOutPending ? onSignOut() : onRetry()).finally(() => setPending(false))
  }

  return (
    <AuthFrame
      align="top"
      aside={
        <div className="flex justify-end">
          <MatrixLanguageSettings quiet />
        </div>
      }
      brand={
        <BrandMark className="size-10 rounded-[var(--atum-r-sidebar)] shadow-[0_0_0_1px_var(--atum-line-strong)]" />
      }
      description={help}
      title={title}
    >
      <div className="mt-7 flex flex-col gap-3" data-matrix-account-unavailable>
        <Button
          aria-busy={pending || undefined}
          className="h-11 w-full rounded-[var(--atum-r-input)] text-[0.875rem]"
          disabled={pending}
          onClick={act}
          type="button"
        >
          {signOutPending ? copy.signOut : t.matrixShell.turnRetry}
        </Button>
        {panel === 'sign-out' ? (
          <div className="rounded-[var(--atum-r-card)] bg-(--atum-sunk) px-4 py-3.5">
            <MatrixSignOutConfirm onCancel={() => setPanel(null)} snapshot={snapshot} />
          </div>
        ) : panel === 'feedback' ? (
          <div className="rounded-[var(--atum-r-card)] bg-(--atum-sunk) px-4 py-3.5" data-matrix-account-feedback>
            <p className="text-(length:--atum-t-control) font-semibold text-(--atum-ink)">{launch.feedback}</p>
            <MatrixFeedbackForm onClose={() => setPanel(null)} />
          </div>
        ) : (
          // The quiet ways out: tell Atum, or start over (confirmed in place).
          <div className="flex items-center justify-center gap-4">
            {feedback && (
              <Button onClick={() => setPanel('feedback')} size="sm" type="button" variant="text">
                {launch.feedback}
              </Button>
            )}
            {!signOutPending && !unknown && (
              <Button onClick={() => setPanel('sign-out')} size="sm" type="button" variant="text">
                {copy.signOut}
              </Button>
            )}
          </div>
        )}
      </div>
    </AuthFrame>
  )
}
