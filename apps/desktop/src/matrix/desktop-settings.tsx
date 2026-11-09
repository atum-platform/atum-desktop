import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { writeClipboardText } from '@/components/ui/copy-button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Info } from '@/lib/icons'

import { ATUM_LINKS } from './atum-links'
import { $matrixDesktopServices, useMatrixDesktopServicesCopy } from './desktop-services'
import { useMatrixSettingsCopy } from './settings-copy'
import { SettingsLinkRow, SettingsRow, SettingsSection } from './settings-row'
import { SoftwareUpdate, UpdateAffordance } from './updates/presentation'

/** The feedback sheet: opened from the account menu or Settings, mounted once by the rail. */
export const $matrixFeedbackOpen = atom(false)

/** The one install-wide choice: whether usage counts and error details are shared. */
function useUsageSharing() {
  const status = useStore($matrixDesktopServices)
  const [writing, setWriting] = useState(false)
  const [failed, setFailed] = useState(false)

  const set = async (enabled: boolean) => {
    if (writing) {
      return
    }

    setWriting(true)
    setFailed(false)

    try {
      $matrixDesktopServices.set(await window.atumDesktopServices!.setEnabled(enabled))
    } catch {
      setFailed(true)
    } finally {
      setWriting(false)
    }
  }

  return { failed, set, status, writing }
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function MatrixUsageSharing() {
  const copy = useMatrixDesktopServicesCopy()
  const { failed, set, status, writing } = useUsageSharing()

  if (!status || !window.atumDesktopServices) {
    return null
  }

  return (
    <div className="min-w-0" data-matrix-usage-sharing>
      <div className="flex min-w-0 items-center gap-0.5 text-(length:--atum-t-caption) text-(--atum-ink-muted)">
        <label className="flex min-w-0 cursor-pointer items-center gap-2 transition-colors hover:text-(--atum-ink-soft)">
          <Switch
            aria-label={copy.share}
            checked={status.reporting.enabled}
            disabled={writing}
            onCheckedChange={enabled => void set(enabled)}
            size="xs"
          />
          <span className="truncate">{copy.share}</span>
        </label>
        <Tip label={copy.shareHelp}>
          <button
            aria-label={copy.shareHelp}
            className="grid size-6 shrink-0 place-items-center rounded-full transition-colors hover:bg-(--atum-hover) hover:text-(--atum-ink-soft)"
            type="button"
          >
            <Info aria-hidden className="size-3.5" />
          </button>
        </Tip>
      </div>
      {failed && (
        <p className="mt-1 text-(length:--atum-t-caption) text-(--atum-danger)" role="status">
          {copy.preferenceFailed}
        </p>
      )}
    </div>
  )
}

/**
 * Settings › Help: "Updates" (the software update with the version) and "Help improve Atum"
 * (sharing, and the way to send feedback). Feedback opens its own sheet, so Settings steps
 * aside. Start at login lives in Settings › General.
 */
export function MatrixDesktopSettings({ onOpenFeedback }: { onOpenFeedback(): void }) {
  const copy = useMatrixDesktopServicesCopy()
  const settings = useMatrixSettingsCopy()
  const { failed, set, status, writing } = useUsageSharing()
  const { locale } = useI18n()

  if (!status || !window.atumDesktopServices) {
    return null
  }

  return (
    <>
      <SettingsSection data-matrix-desktop-services title={settings.updates}>
        <SoftwareUpdate
          busy={status.busy}
          checkNow={() => window.atumDesktopServices!.checkUpdates()}
          currentVersion={status.version}
          locale={locale}
          openDownload={() => window.atumMatrix.openLink(ATUM_LINKS.download).then(() => true)}
          restart={() => window.atumDesktopServices!.restart()}
          setChannel={channel => window.atumDesktopServices!.setUpdateChannel(channel)}
          status={status.update}
        />
      </SettingsSection>

      <SettingsSection title={settings.improve}>
        <div className="atum-settings-item">
          <SettingsRow
            as="label"
            control={
              <Switch
                aria-label={copy.share}
                checked={status.reporting.enabled}
                disabled={writing}
                onCheckedChange={enabled => void set(enabled)}
              />
            }
            help={copy.shareHelp}
            title={copy.share}
          />
          {failed && (
            <NoticeBand role="status" tone="notice">
              {copy.preferenceFailed}
            </NoticeBand>
          )}
        </div>
        {status.reporting.configured && (
          <SettingsLinkRow data-matrix-open-feedback onClick={onOpenFeedback}>
            {copy.feedbackOpen}
          </SettingsLinkRow>
        )}
      </SettingsSection>
    </>
  )
}

/**
 * The feedback note itself: a short message, sent as it is. Nothing else is attached; the
 * diagnostic ID support may ask for is one quiet "copy" away, never printed. A reply that
 * arrives after the form is gone belongs to no one. Used by the sheet below, and in place
 * where a sheet would sit under the surface that asks (the launch).
 */
export function MatrixFeedbackForm({ onClose }: { onClose(): void }) {
  const status = useStore($matrixDesktopServices)
  const copy = useMatrixDesktopServicesCopy()
  const { t } = useI18n()
  const [message, setMessage] = useState('')

  const [state, setState] = useState<'failed' | 'idle' | 'sending' | 'sent'>('idle')

  const [copied, setCopied] = useState(false)
  const live = useRef(true)

  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
    }
  }, [])

  useEffect(() => {
    if (!copied) {
      return
    }

    const timer = setTimeout(() => setCopied(false), 1800)

    return () => clearTimeout(timer)
  }, [copied])

  const send = async () => {
    if (state === 'sending' || !message.trim()) {
      return
    }

    let result: 'failed' | 'sent'

    setState('sending')

    try {
      result = (await window.atumDesktopServices!.feedback(message.trim())).sent ? 'sent' : 'failed'
    } catch {
      result = 'failed'
    }

    if (live.current) {
      setState(result)
    }
  }

  const diagnosticId = status?.reporting.diagnosticId

  if (state === 'sent') {
    return (
      <div data-matrix-feedback-sent>
        <p className="mt-2 text-(length:--atum-t-body) text-(--atum-ink-muted)" role="status">
          {copy.feedbackSent}
        </p>
        <div className="mt-6 flex justify-end">
          <Button onClick={onClose}>{t.common.done}</Button>
        </div>
      </div>
    )
  }

  return (
    <div data-matrix-feedback-form>
      <Textarea
        aria-label={copy.feedback}
        autoFocus
        className="atum-input atum-feedback-text mt-4"
        disabled={state === 'sending'}
        maxLength={4000}
        onChange={event => setMessage(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void send()
          }
        }}
        placeholder={copy.feedbackPlaceholder}
        value={message}
      />
      {state === 'failed' && (
        <NoticeBand className="mt-3" role="status" tone="notice">
          {copy.feedbackFailed}
        </NoticeBand>
      )}
      <div className="mt-5 flex items-center gap-2">
        <span className="min-w-0 flex-1">
          {diagnosticId && (
            <Button
              data-matrix-copy-diagnostic
              onClick={() => {
                void writeClipboardText(diagnosticId)
                  .then(() => live.current && setCopied(true))
                  .catch(() => {})
              }}
              size="inline"
              variant="text"
            >
              {copied ? copy.diagnosticCopied : copy.copyDiagnostic}
            </Button>
          )}
        </span>
        <Button onClick={onClose} variant="text">
          {t.common.cancel}
        </Button>
        <Button disabled={state === 'sending' || !message.trim()} onClick={() => void send()}>
          {copy.feedbackSend}
        </Button>
      </div>
    </div>
  )
}

/** Send feedback as a sheet of its own. Closing it discards the draft. */
export function MatrixFeedbackDialog() {
  const open = useStore($matrixFeedbackOpen)
  const status = useStore($matrixDesktopServices)
  const copy = useMatrixDesktopServicesCopy()

  if (!status?.reporting.configured || !window.atumDesktopServices) {
    return null
  }

  const close = () => $matrixFeedbackOpen.set(false)

  return (
    <Dialog onOpenChange={value => $matrixFeedbackOpen.set(value)} open={open}>
      <DialogContent className="atum-feedback-sheet" data-matrix-feedback>
        <DialogTitle>{copy.feedback}</DialogTitle>
        <DialogDescription className="sr-only">{copy.feedbackPlaceholder}</DialogDescription>
        <MatrixFeedbackForm onClose={close} />
      </DialogContent>
    </Dialog>
  )
}

/** One native-authoritative update control at the rail foot. */
export function MatrixUpdateFooter({ onOpenUpdates }: { onOpenUpdates(): void }) {
  const status = useStore($matrixDesktopServices)
  const { locale } = useI18n()

  if (!status || !window.atumDesktopServices) {
    return null
  }

  return (
    <UpdateAffordance
      busy={status.busy}
      checkNow={() => window.atumDesktopServices!.checkUpdates()}
      locale={locale}
      openDownload={() => window.atumMatrix.openLink(ATUM_LINKS.download).then(() => true)}
      openUpdates={onOpenUpdates}
      restart={() => window.atumDesktopServices!.restart()}
      status={status.update}
    />
  )
}
