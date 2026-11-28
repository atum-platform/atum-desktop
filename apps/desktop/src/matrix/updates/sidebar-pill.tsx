import { useEffect, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tip } from '@/components/ui/tooltip'
import type { Locale } from '@/i18n'
import { AlertCircle, CircleArrowDown, Download, Refresh, Spinner } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixDesktopServicesBridge } from '../../../shared/matrix-desktop-services'
import { resolveDesktopUpdateButtonAction } from '../../../vendor/t3-updates/apps/web/src/components/desktopUpdate.logic'
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

/** The one glyph the rail shows for the update, by state. */
export type RailUpdateGlyph = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'restarting' | 'error'

interface Props {
  state: DesktopUpdateState
  locale: Locale
  busy: boolean
  bridge: Required<Pick<MatrixDesktopServicesBridge, 'checkUpdates' | 'downloadUpdate' | 'restart'>>
  openReleaseHistory: () => void
}

/**
 * The update control at the rail's foot: one rail-sized button with one kit glyph, drawn like the
 * destinations above it (Phosphor Light, muted ink, the same 36px target). Only a downloaded update
 * raises it to full ink with the rail's ink dot, and only a failure takes the danger colour. The
 * restart choices, the countdown and what's new live in the dialog it opens, never in the rail.
 */
export function SidebarUpdatePill({ state, locale, busy, bridge, openReleaseHistory }: Props) {
  const copy = updateCopy(locale)
  const action = resolveDesktopUpdateButtonAction(state)
  const [confirming, setConfirming] = useState(false)
  const [confirmedVersion, setConfirmedVersion] = useState<string | null>(null)
  const [deadline, setDeadline] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

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
      setConfirming(false)
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
  const failed = failure !== null || state.errorContext !== null

  const label = activeCountdown
    ? restartCountdown[locale](seconds)
    : !state.enabled ? copy.unavailable
      : state.status === 'checking' ? copy.checking
        : state.status === 'downloading' ? copy.downloading(state.downloadPercent)
          : failure ?? (action === 'install' ? (state.errorContext === 'install' ? copy.installFailed : copy.readyLabel)
            : state.errorContext ? copy.retry
              : action === 'download' ? copy.available : state.status === 'up-to-date' ? copy.upToDate : copy.check)

  const glyph: RailUpdateGlyph = activeCountdown || (pending && action === 'install')
    ? 'restarting'
    : state.status === 'checking' || (pending && action === 'none') ? 'checking'
      : state.status === 'downloading' ? 'downloading'
        : failed ? 'error'
          : action === 'install' ? 'ready' : action === 'download' ? 'available' : 'idle'

  const handleAction = async () => {
    if (disabled) {return}
    setFailure(null)

    if (action === 'install') {
      setConfirmedVersion(state.downloadedVersion)
      setConfirming(true)

      return
    }

    setPending(true)

    try {
      if (action === 'download') {
        if (!await bridge.downloadUpdate()) {setFailure(copy.error)}
      } else if (!await bridge.checkUpdates()) {setFailure(copy.checkFailed)}
    } catch {
      setFailure(action === 'download' ? copy.error : copy.checkFailed)
    } finally {
      setPending(false)
    }
  }

  const ready = Boolean(confirmedVersion) && confirmedVersion === state.downloadedVersion && !busy

  const restartNow = () => {
    setConfirming(false)

    if (ready) {void restart(confirmedVersion!)}
  }

  const restartAfterCountdown = () => {
    if (!ready) {return}
    const start = Date.now()
    setNow(start)
    setDeadline(start + UPDATE_RESTART_DELAY_MS)
  }

  // Closing the dialog during the countdown is "Later": nothing restarts behind a closed dialog.
  const close = () => {
    setDeadline(null)
    setConfirming(false)
  }

  const status = failure ?? state.message ?? (busy ? copy.restartBusy : copy.installFailed)

  const showStatus = failure !== null || Boolean(state.notAppliedVersion) || state.errorContext === 'install' ||
    (busy && action === 'install')

  return (
    <div className="relative" data-atum-update-pill={state.status}>
      <Tip label={label} side="right" sideOffset={8}>
        <button
          aria-disabled={disabled || undefined}
          aria-label={label}
          className={cn(
            'atum-nav-item relative',
            glyph === 'ready' && 'text-(--atum-ink)',
            glyph === 'error' && 'text-(--atum-danger)',
            disabled && 'cursor-default'
          )}
          data-atum-update-glyph={glyph}
          data-icon-only
          onClick={() => void handleAction()}
          type="button"
        >
          <RailUpdateGlyphMark glyph={glyph} percent={state.downloadPercent} />
          {glyph === 'ready' && (
            <span aria-hidden className="absolute top-1 right-1 size-2 rounded-full bg-(--atum-ink)" data-atum-nav-badge="unread" />
          )}
        </button>
      </Tip>
      {showStatus && <span className="sr-only" role="status">{status}</span>}
      <Dialog onOpenChange={open => {if (!open) {close()}}} open={confirming}>
        <DialogContent className="max-w-sm">
          <BrandMark className="size-9" />
          <DialogTitle>{copy.restartToUpdate}</DialogTitle>
          <DialogDescription>{copy.ready(confirmedVersion)}</DialogDescription>
          {state.releaseNotes.length > 0 && (
            <div className="max-h-48 overflow-auto text-xs text-(--atum-ink-muted)" data-update-notes>
              {state.releaseNotes.map(note => (
                <section className="mb-2" key={note.version}>
                  <h3 className="font-medium text-(--atum-ink)">{copy.currentVersion(note.version)}</h3>
                  <ul className="list-inside list-disc">{note.items.map((item, index) => <li key={index}>{item}</li>)}</ul>
                </section>
              ))}
              <Button onClick={openReleaseHistory} size="sm" variant="ghost">{copy.downloadAtum}</Button>
            </div>
          )}
          {activeCountdown ? (
            <div className="flex items-center justify-end gap-3">
              <span className="text-sm text-(--atum-ink-muted)" role="status">{label}</span>
              <Button autoFocus onClick={() => setDeadline(null)} variant="ghost">{copy.later}</Button>
            </div>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={close} variant="ghost">{copy.later}</Button>
              <Button disabled={!ready} onClick={restartAfterCountdown} variant="secondary">{everythingLabel[locale]}</Button>
              <Button autoFocus disabled={!ready} onClick={restartNow}>{copy.restart}</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function RailUpdateGlyphMark({ glyph, percent }: { glyph: RailUpdateGlyph; percent: number | null }) {
  switch (glyph) {
    case 'checking':

    case 'restarting':
      return <Spinner aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />

    case 'downloading':
      return <Spinner aria-hidden className="size-4" value={percent} />

    case 'available':
      return <Download aria-hidden className="size-4" />

    case 'ready':
      return <CircleArrowDown aria-hidden className="size-4" />

    case 'error':
      return <AlertCircle aria-hidden className="size-4" />

    default:
      return <Refresh aria-hidden className="size-4" />
  }
}

export const UPDATE_RELEASE_HISTORY = ATUM_LINKS.download
