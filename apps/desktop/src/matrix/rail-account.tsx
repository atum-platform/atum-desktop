import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useId, useState } from 'react'

import { ProtonMark } from '@/components/brand/proton-mark'
import { StatusDot, type StatusTone } from '@/components/status-dot'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { LogOut, MessageCircle, MoodSmile, RefreshCw, Settings } from '@/lib/icons'

import type { MatrixSnapshot } from '../../shared/matrix'
import { matrixPresenceCopy } from '../../shared/matrix-presence-copy'

import { useConversationCopy } from './conversation-copy'
import { useMatrixCopy } from './copy'
import { $matrixDesktopServices, useMatrixDesktopServicesCopy } from './desktop-services'
import { $matrixFeedbackOpen, MatrixFeedbackDialog } from './desktop-settings'
import { useOwnMatrixHandle } from './person-handles'
import { matrixPersonLabel, matrixPersonName } from './person-name'
import { MatrixProfileAvatar } from './profile-avatar'
import { $matrixSignOutOpen, MatrixSignOutDialog } from './sign-out'
import { MatrixStatusEditor } from './status-editor'
import type { ProtonsWalletData } from './store/protons-pane'
import { matrixWalletCopy } from './wallet-copy'

const ITEM = 'gap-2.5 rounded-md px-2.5 py-1.5 text-[13px]'

/**
 * The signed-in person as the window shows them: the name they set (kept once seen), else
 * their @handle, else the word for someone unnamed; never their Matrix ID, which is opaque
 * for new people (ledger AC8). `handle` is the directory's answer for them, once it came.
 */
export function useOwnName(snapshot: MatrixSnapshot): { handle?: string; name: string } {
  const userId = snapshot.identity?.userId ?? ''
  const member = matrixPersonName(snapshot.members?.find(value => value.userId === userId)?.name, userId)
  const [known, setKnown] = useState<{ userId: string; name: string } | null>(null)
  const handle = useOwnMatrixHandle(userId || undefined, Boolean(snapshot.domainEnabled))
  const { unnamed } = useConversationCopy()

  useEffect(() => {
    if (member && (known?.userId !== userId || known.name !== member)) {
      setKnown({ userId, name: member })
    }
  }, [known, member, userId])

  const profileName =
    snapshot.ownProfile?.userId === userId ? matrixPersonName(snapshot.ownProfile.displayName, userId) : undefined

  const name =
    profileName ??
    (known?.userId === userId ? known.name : undefined) ??
    matrixPersonLabel({ handle, ownerUserId: userId, unnamed, userId }).name

  return { handle, name }
}

/** The @handle line under a name, only when it says something the name does not. */
export function ownHandleLine({ handle, name }: { handle?: string; name: string }): string | undefined {
  return handle && `@${handle}` !== name ? `@${handle}` : undefined
}

/** Healthy is quiet: a dot only while the account is not connected. */
export function accountTone(state: MatrixSnapshot['state']): StatusTone | null {
  if (state === 'error') {
    return 'bad'
  }

  return state === 'offline' || state === 'connecting' ? 'warn' : null
}

export function OwnAvatar({ className, snapshot }: { className: string; snapshot: MatrixSnapshot }) {
  const { name } = useOwnName(snapshot)

  return (
    <MatrixProfileAvatar
      className={className}
      id={snapshot.identity?.userId ?? ''}
      name={name}
      profile={snapshot.ownProfile}
      ready={snapshot.state === 'ready'}
      scopeKey={`${snapshot.petScope ?? ''}/${snapshot.identity?.userId}/${snapshot.identity?.deviceId}`}
      target={{ kind: 'human' }}
    />
  )
}

/** An entry a feature adds to the account's menu or Settings: its own words and icon. */
export interface MatrixAccountEntry {
  icon: ReactNode
  label: string
  onOpen(): void
}

/**
 * The account at the foot of the rail, where the old roster footer was: who is signed
 * in, Settings (⌘,), the phone, Protons once there is a wallet, feedback, and signing
 * out (confirmed first; with no recovery key saved, setting one up is offered first).
 * Status shows only when something is wrong, with the one thing to do about it.
 */
export function MatrixRailAccount({
  balance,
  fail,
  onOpenChange,
  onOpenProtons,
  onOpenRecovery,
  onOpenSettings,
  onTopUp,
  open,
  phone,
  snapshot
}: {
  /** The wallet, once its provider exists: the Protons row opens Settings. No balance is shown here. */
  balance?: ProtonsWalletData
  fail: () => void
  onOpenChange(open: boolean): void
  onOpenProtons?(): void
  /** Settings › Privacy & Security, where the recovery key is set up. */
  onOpenRecovery?(): void
  onOpenSettings(): void
  /** The top-up beside the Protons row, the same one Settings → Protons and the Store open. */
  onTopUp?(): void
  open: boolean
  /** "Use on phone", owned by the phone feature. */
  phone?: MatrixAccountEntry
  snapshot: MatrixSnapshot
}) {
  const copy = useMatrixCopy()
  const { locale, t } = useI18n()
  const shell = t.matrixShell
  const own = useOwnName(snapshot)
  const { name } = own
  const handleLine = ownHandleLine(own)
  const tone = accountTone(snapshot.state)
  const services = useStore($matrixDesktopServices)
  const feedbackCopy = useMatrixDesktopServicesCopy()
  // Feedback is offered only where it can be delivered.
  const feedback = Boolean(services?.reporting.configured && window.atumDesktopServices)
  const [statusOpen, setStatusOpen] = useState(false)

  const statusId = useId()

  const status =
    snapshot.state === 'offline'
      ? copy.offline
      : snapshot.state === 'connecting'
        ? copy.connecting
        : snapshot.state === 'error'
          ? shell.accountDisconnected
          : null

  return (
    <>
      <DropdownMenu onOpenChange={onOpenChange} open={open}>
        {/* A constant label: dropping the tip while open would remount the trigger. */}
        <Tip label={name} side="right">
          <DropdownMenuTrigger asChild>
            <button
              aria-describedby={status ? statusId : undefined}
              aria-label={`${shell.account}: ${name}`}
              className="atum-nav-item atum-rail-account"
              data-matrix-rail-account
              type="button"
            >
              <span className="atum-rail-account-face grid size-7 place-items-center">
                <OwnAvatar className="size-7 rounded-(--atum-r-control) text-[0.75rem]" snapshot={snapshot} />
              </span>
              {/* Trouble is named accessibly and in the opened account menu, not marked on the face. */}
              {status && (
                <span className="sr-only" id={statusId}>
                  {status}
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent
          align="end"
          className="atum-account-menu w-64 rounded-xl p-1.5"
          data-matrix-account-menu
          side="right"
          sideOffset={10}
        >
          <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-2">
            <OwnAvatar className="size-9 shrink-0 rounded-(--atum-r-button) text-sm" snapshot={snapshot} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-(--atum-ink)">{name}</span>
              {/* The handle only when it says something the name does not. */}
              {handleLine && <span className="block truncate text-xs text-(--atum-ink-muted)">{handleLine}</span>}
            </span>
          </div>
          {status && (
            <div className="mx-1 mb-1 flex items-center gap-2 rounded-lg bg-(--atum-sunk) px-2 py-1.5" role="status">
              {tone && <StatusDot tone={tone} />}
              <span className="min-w-0 flex-1 truncate text-xs text-(--atum-ink-soft)">{status}</span>
            </div>
          )}
          {(snapshot.state === 'offline' || snapshot.state === 'error') && (
            <DropdownMenuItem className={ITEM} onSelect={() => void window.atumMatrix.retry().catch(fail)}>
              <RefreshCw aria-hidden />
              {copy.retry}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator className="my-1" />
          {snapshot.identity && snapshot.state === 'ready' && (
            <DropdownMenuItem className={ITEM} data-matrix-set-status onSelect={() => setStatusOpen(true)}>
              <MoodSmile aria-hidden />
              {matrixPresenceCopy(locale).status}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className={ITEM} data-matrix-open-settings onSelect={onOpenSettings}>
            <Settings aria-hidden />
            {shell.settings}
            <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
          </DropdownMenuItem>
          {phone && (
            <DropdownMenuItem className={ITEM} data-matrix-open-phone onSelect={phone.onOpen}>
              {phone.icon}
              {phone.label}
            </DropdownMenuItem>
          )}
          {balance && (
            // Protons opens Settings → Protons; the trailing "Top up" opens the top-up.
            <div className="flex items-center gap-1" role="none">
              <DropdownMenuItem
                className={`${ITEM} min-w-0 flex-1`}
                data-matrix-open-protons
                onSelect={onOpenProtons ?? onOpenSettings}
              >
                <ProtonMark />
                {t.atum.protons.title}
              </DropdownMenuItem>
              {onTopUp && (
                <DropdownMenuItem className="atum-account-topup" data-matrix-account-topup onSelect={onTopUp}>
                  {matrixWalletCopy(locale).topUpShort}
                </DropdownMenuItem>
              )}
            </div>
          )}
          {feedback && (
            <DropdownMenuItem className={ITEM} data-matrix-open-feedback onSelect={() => $matrixFeedbackOpen.set(true)}>
              <MessageCircle aria-hidden />
              {feedbackCopy.feedbackOpen}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator className="my-1" />
          <DropdownMenuItem className={ITEM} data-matrix-sign-out onSelect={() => $matrixSignOutOpen.set(true)}>
            <LogOut aria-hidden />
            {copy.signOut}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <MatrixFeedbackDialog />
      <MatrixStatusEditor onOpenChange={setStatusOpen} open={statusOpen} snapshot={snapshot} />
      <MatrixSignOutDialog onSetUpRecovery={onOpenRecovery} snapshot={snapshot} />
    </>
  )
}
