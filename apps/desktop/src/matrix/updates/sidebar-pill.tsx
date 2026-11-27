import { useEffect, useState } from 'react'
import type { ComponentProps } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tip } from '@/components/ui/tooltip'
import type { Locale } from '@/i18n'
import { FileText, X } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixDesktopServicesBridge } from '../../../shared/matrix-desktop-services'
import { resolveDesktopUpdateButtonAction } from '../../../vendor/t3-updates/apps/web/src/components/desktopUpdate.logic'
import { DesktopUpdateStatusIcon } from '../../../vendor/t3-updates/apps/web/src/components/sidebar/DesktopUpdateStatusIcon'
import { UPDATE_RESTART_DELAY_MS } from '../../../vendor/t3-updates/apps/web/src/components/sidebar/useUpdateEverything'
import type { DesktopUpdateState } from '../../../vendor/t3-updates/packages/contracts/src/desktopUpdates'
import { ATUM_LINKS } from '../atum-links'

import { updateCopy } from './copy'

const everythingLabel: Record<Locale, string> = {
  en: 'Update everything',
  vi: 'Cập nhật tất cả',
  ja: 'すべて更新',
  zh: '全部更新',
  'zh-hant': '全部更新'
}

const restartCountdown: Record<Locale, (seconds: number) => string> = {
  en: seconds => `Restarting in ${seconds}s`,
  vi: seconds => `Khởi động lại sau ${seconds} giây`,
  ja: seconds => `${seconds} 秒後に再起動`,
  zh: seconds => `${seconds} 秒后重新启动`,
  'zh-hant': seconds => `${seconds} 秒後重新啟動`
}

interface Props {
  state: DesktopUpdateState
  locale: Locale
  busy: boolean
  rail?: boolean
  bridge: Required<Pick<MatrixDesktopServicesBridge, 'checkUpdates' | 'downloadUpdate' | 'restart'>>
  openReleaseHistory: () => void
}

export function SidebarUpdatePill({ state, locale, busy, bridge, openReleaseHistory, rail = false }: Props) {
  const copy = updateCopy(locale)
  const action = resolveDesktopUpdateButtonAction(state)
  const [confirmation, setConfirmation] = useState<'restart' | 'everything' | null>(null)
  const [confirmedVersion, setConfirmedVersion] = useState<string | null>(null)
  const [deadline, setDeadline] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const [checkLatched, setCheckLatched] = useState(false)

  const restart = async (expectedVersion: string) => {
    setPending(true)
    try {
      if (!await bridge.restart(expectedVersion)) {setFailure(copy.restartBusy)}
    } catch {
      setFailure(copy.restartFailed)
    } finally {
      setPending(false)
    }
  }

  useEffect(() => {
    if (deadline === null || confirmedVersion === null || confirmedVersion !== state.downloadedVersion ) {return}
    const interval = setInterval(() => setNow(Date.now()), 100)
    const timeout = setTimeout(() => {
      setDeadline(null)
      setPending(true)
      void bridge.restart(confirmedVersion)
        .then(accepted => {if (!accepted) {setFailure(copy.restartBusy)}})
        .catch(() => setFailure(copy.restartFailed))
        .finally(() => setPending(false))
    }, Math.max(0, deadline - Date.now()))

    return () => {
      clearInterval(interval)
      clearTimeout(timeout)
    }
  }, [bridge, confirmedVersion, copy.restartBusy, copy.restartFailed, deadline, state.downloadedVersion])

  const activeCountdown = deadline !== null && confirmedVersion === state.downloadedVersion
  const disabled = !state.enabled || state.status === 'checking' || state.status === 'downloading' ||
    pending || activeCountdown || (busy && action === 'install')

  const seconds = activeCountdown ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0
  const label = activeCountdown
    ? restartCountdown[locale](seconds)
    : !state.enabled ? copy.unavailable
      : state.status === 'checking' ? copy.checking
        : state.status === 'downloading' ? copy.downloading(state.downloadPercent)
          : action === 'install' ? (state.errorContext === 'install' ? copy.installFailed : copy.readyLabel)
            : state.errorContext ? copy.retry
              : action === 'download' ? copy.available : state.status === 'up-to-date' ? copy.upToDate : copy.check
  const icon: ComponentProps<typeof DesktopUpdateStatusIcon>['status'] = checkLatched || state.status === 'checking'
    ? 'checking'
    : state.status === 'downloading' ? 'downloading'
      : action === 'install' ? 'downloaded' : action === 'download' ? 'available' : 'idle'

  const handleAction = async () => {
    if (disabled) {return}
    setFailure(null)
    if (action === 'install') {
      setConfirmedVersion(state.downloadedVersion)
      setConfirmation('restart')

      return
    }
    setPending(true)
    try {
      if (action === 'download') {
        if (!await bridge.downloadUpdate()) {setFailure(copy.error)}
      } else {
        setCheckLatched(!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
        if (!await bridge.checkUpdates()) {setFailure(copy.checkFailed)}
      }
    } catch {
      setFailure(action === 'download' ? copy.error : copy.checkFailed)
    } finally {
      setPending(false)
    }
  }

  const confirm = () => {
    const kind = confirmation
    setConfirmation(null)
    if (!confirmedVersion || confirmedVersion !== state.downloadedVersion || busy) {return}
    if (kind === 'everything') {
      const start = Date.now()
      setNow(start)
      setDeadline(start + UPDATE_RESTART_DELAY_MS)
    } else {
      void restart(confirmedVersion)
    }
  }

  return (
    <div className={cn('relative flex max-w-full items-center gap-1', rail ? 'flex-col' : 'ml-auto')} data-atum-update-pill={state.status}>
      <Tip label={label}>
        <button
          aria-disabled={disabled || undefined}
          aria-label={label}
          className={cn(
            'inline-flex size-8 shrink-0 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset',
            action !== 'none' || state.status === 'downloading'
              ? 'bg-(--atum-hover) text-(--atum-ink)'
              : 'text-(--atum-ink-muted)',
            disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-(--atum-hover)',
            !state.enabled && 'opacity-60'
          )}
          onClick={() => void handleAction()}
          type="button"
        >
          <DesktopUpdateStatusIcon
            downloadPercent={state.downloadPercent}
            isCheckAnimating={icon === 'checking'}
            onCheckAnimationIteration={() => setCheckLatched(state.status === 'checking')}
            status={icon}
          />
        </button>
      </Tip>
      {activeCountdown ? (
        <>
          <span className="truncate text-xs" role="status">
            {rail ? <><span aria-hidden>{seconds}</span><span className="sr-only">{label}</span></> : label}
          </span>
          <Button aria-label={copy.later} onClick={() => setDeadline(null)} size={rail ? 'icon-sm' : 'sm'}>
            {rail ? <X aria-hidden /> : copy.later}
          </Button>
        </>
      ) : action === 'install' && (
        <Tip label={everythingLabel[locale]}>
          <button
            aria-label={everythingLabel[locale]}
            className="grid size-8 shrink-0 place-items-center rounded-full hover:bg-(--atum-hover) focus-visible:ring-2"
            disabled={disabled}
            onClick={() => {
              setConfirmedVersion(state.downloadedVersion)
              setConfirmation('everything')
            }}
            type="button"
          >
            <DesktopUpdateStatusIcon status="everything" />
          </button>
        </Tip>
      )}
      {!activeCountdown && state.releaseNotes.length > 0 && (
        <Button aria-expanded={notesOpen} aria-label={copy.whatsNew} onClick={() => setNotesOpen(!notesOpen)} size={rail ? 'icon-sm' : 'sm'} variant="ghost">
          {rail ? <FileText aria-hidden /> : copy.whatsNew}
        </Button>
      )}
      {notesOpen && state.releaseNotes.length > 0 && (
        <div className={cn('absolute z-30 max-h-72 w-56 overflow-auto rounded-xl border bg-background p-3 shadow-md',
          rail ? 'bottom-0 left-full ml-2' : 'bottom-full right-0 mb-2')}>
          {state.releaseNotes.map(note => (
            <section className="mb-2 text-xs" key={note.version}>
              <h3 className="font-medium">{copy.currentVersion(note.version)}</h3>
              <ul className="list-inside list-disc">{note.items.map((item, index) => <li key={index}>{item}</li>)}</ul>
            </section>
          ))}
          <Button onClick={openReleaseHistory} size="sm" variant="ghost">{copy.downloadAtum}</Button>
        </div>
      )}
      {(failure || state.notAppliedVersion || state.errorContext === 'install' || (busy && action === 'install')) && (
        <span className={cn('truncate text-xs text-(--atum-ink-muted)', rail ? 'sr-only' : 'max-w-32')} role="status">{failure ?? state.message ?? (busy ? copy.restartBusy : copy.installFailed)}</span>
      )}
      <Dialog onOpenChange={open => {if (!open) {setConfirmation(null)}}} open={confirmation !== null}>
        <DialogContent className="max-w-sm">
          <BrandMark className="size-9" />
          <DialogTitle>{confirmation === 'everything' ? everythingLabel[locale] : copy.restartToUpdate}</DialogTitle>
          <DialogDescription>{copy.ready(confirmedVersion)}</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirmation(null)} variant="ghost">{copy.later}</Button>
            <Button autoFocus disabled={!confirmedVersion || confirmedVersion !== state.downloadedVersion || busy} onClick={confirm}>{confirmation === 'everything' ? everythingLabel[locale] : copy.restart}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export const UPDATE_RELEASE_HISTORY = ATUM_LINKS.download
