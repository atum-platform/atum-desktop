import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import type { Locale } from '@/i18n'
import { CircleArrowDownFilled } from '@/lib/icons'

import type { AtumUpdateChannel, AtumUpdateStatus } from '../../../shared/atum-update-flow'
import { SettingsRow } from '../settings-row'

import { updateCopy, updateStateLabel } from './copy'

type UpdateAction = () => boolean | Promise<boolean>
type SetUpdateChannel = (channel: AtumUpdateChannel) => boolean | Promise<boolean>

export interface SoftwareUpdateProps {
  busy: boolean
  checkNow: UpdateAction
  currentVersion: string | null
  locale: Locale
  openDownload: UpdateAction
  restart: UpdateAction
  setChannel: SetUpdateChannel
  status: AtumUpdateStatus
}

export interface UpdateAffordanceProps {
  busy: boolean
  checkNow: UpdateAction
  locale: Locale
  openDownload: UpdateAction
  openUpdates(): void
  restart: UpdateAction
  status: AtumUpdateStatus
}

/** Plain text only, with a UI-level cap even if an older native bridge is malformed. */
export function updateNotes(notes: readonly string[]): readonly string[] {
  return notes
    .filter((note): note is string => typeof note === 'string')
    .map(note => {
      const plainText = Array.from(note, character => {
        const code = character.codePointAt(0) ?? 0

        return code < 32 || code === 127 ? ' ' : character
      })
        .join('')
        .replace(/\s+/g, ' ')
        .trim()

      return Array.from(plainText).slice(0, 140).join('')
    })
    .filter(Boolean)
    .slice(0, 3)
}

function updateFailureMessage(status: AtumUpdateStatus, text: ReturnType<typeof updateCopy>): string {
  if (status.error?.code === 'disk_space' && Number.isFinite(status.error.requiredBytes) && status.error.requiredBytes! > 0) {
    return text.diskSpaceNeeded((Math.ceil(status.error.requiredBytes! / 1e8) / 10).toFixed(1))
  }

  if (status.error?.recovery === 'manual_download') {return text.stagingStalled}
  if (status.error?.stage === 'install' && status.error.code === 'failed') {return text.installFailed}
  if (status.error?.code === 'failed' && status.error.stage === 'check') {return text.checkFailed}

  return {
    disk_space: text.diskSpace,
    failed: text.error,
    hash_mismatch: text.hashMismatch,
    transport: text.transport
  }[status.error?.code ?? 'failed']
}

function usable(action: UpdateAction): Promise<boolean> {
  return Promise.resolve()
    .then(action)
    .catch(() => false)
}

/** The Settings row is the only place download progress and retry detail appear. */
export function SoftwareUpdate({
  busy,
  checkNow,
  currentVersion,
  locale,
  openDownload,
  restart,
  setChannel,
  status
}: SoftwareUpdateProps) {
  const text = updateCopy(locale)
  const [checking, setChecking] = useState(false)
  const [checkFailed, setCheckFailed] = useState(false)
  const [changingChannel, setChangingChannel] = useState(false)
  const [channelFailed, setChannelFailed] = useState(false)
  const [restartFailed, setRestartFailed] = useState(false)
  const actionRef = useRef(false)

  const pendingCheck = checking || ['checking', 'downloading', 'preparing'].includes(status.state)
  const pendingRestart = status.state === 'restarting'
  const actionPending = pendingCheck || changingChannel || pendingRestart

  const stateLabel = checkFailed
    ? text.checkFailed
    : status.state === 'error'
      ? updateFailureMessage(status, text)
      : updateStateLabel(status.state, text, status.progress, status.checkedAt)

  const runCheck = async () => {
    if (busy || pendingCheck || actionRef.current || status.state === 'unavailable') {
      return
    }

    actionRef.current = true
    setChecking(true)
    setCheckFailed(false)
    setCheckFailed(!(await usable(checkNow)))
    setChecking(false)
    actionRef.current = false
  }

  const runRestart = async () => {
    if (busy || actionRef.current || status.state !== 'downloaded') {
      return false
    }

    actionRef.current = true
    setRestartFailed(false)
    const restarted = await usable(restart)
    setRestartFailed(!restarted)
    actionRef.current = false

    return restarted
  }

  const changeChannel = async (channel: AtumUpdateChannel) => {
    if (
      busy ||
      actionPending ||
      actionRef.current ||
      channel === status.channel ||
      (status.state !== 'idle' && status.state !== 'error')
    ) {
      return
    }

    actionRef.current = true
    setChangingChannel(true)
    setChannelFailed(false)
    const changed = await usable(() => setChannel(channel))
    setChannelFailed(!changed)
    setChangingChannel(false)
    actionRef.current = false
  }

  const canRestart = status.state === 'downloaded'
  const manualRecovery = status.state === 'error' && status.error?.recovery === 'manual_download'
  const showProgress = status.state === 'downloading'

  return (
    <div data-software-update>
      <SettingsRow
        control={
          canRestart ? (
            <Button disabled={busy} onClick={() => void runRestart()} size="sm">
              {text.restartToUpdate}
            </Button>
          ) : (
            <Button
              disabled={busy || pendingCheck || pendingRestart || status.state === 'unavailable'}
              onClick={() => void (manualRecovery ? usable(openDownload) : runCheck())}
              size="sm"
              variant="secondary"
            >
              {manualRecovery ? text.downloadAtum : status.state === 'error' || checkFailed ? text.retry : text.check}
            </Button>
          )
        }
        help={
          <span data-update-status role="status">
            {status.state === 'downloaded' && status.version
              ? text.versionReady(status.version)
              : currentVersion
                ? `${text.currentVersion(currentVersion)} · ${stateLabel}`
                : stateLabel}
          </span>
        }
        title={text.softwareUpdate}
      />
      {showProgress && (
        <div className="atum-settings-item-note" data-update-progress>
          <progress aria-label={text.download} max={100} value={status.progress ?? 0} />
          <span>{text.downloading(status.progress)}</span>
        </div>
      )}
      {(busy && canRestart) || restartFailed ? (
        <p className="atum-settings-item-note" role="status">
          {restartFailed ? text.restartFailed : text.restartBusy}
        </p>
      ) : null}
      <SettingsRow
        as="label"
        control={
          <Switch
            aria-label={text.beta}
            checked={status.channel === 'beta'}
            disabled={busy || actionPending || (status.state !== 'idle' && status.state !== 'error')}
            onCheckedChange={checked => void changeChannel(checked ? 'beta' : 'latest')}
          />
        }
        help={text.betaHelp}
        title={text.beta}
      />
      {channelFailed && (
        <p className="atum-settings-item-note" role="status">
          {text.channelFailed}
        </p>
      )}
    </div>
  )
}

/** The rail stays quiet until a downloaded update needs a deliberate restart. */
export function UpdateAffordance({
  busy,
  checkNow,
  locale,
  openDownload,
  openUpdates,
  restart,
  status
}: UpdateAffordanceProps) {
  const text = updateCopy(locale)
  const [open, setOpen] = useState(false)
  const [restartFailed, setRestartFailed] = useState(false)
  const restartRef = useRef(false)
  const ready = status.state === 'downloaded' || status.state === 'restarting'
  const warning = status.state === 'error' && ['download', 'install'].includes(status.error?.stage ?? 'check')
  const manualRecovery = status.state === 'error' && status.error?.recovery === 'manual_download'

  const runRestart = async () => {
    if (busy || restartRef.current || status.state !== 'downloaded') {
      return
    }

    restartRef.current = true
    setRestartFailed(false)
    setRestartFailed(!(await usable(restart)))
    restartRef.current = false
  }

  if (!ready) {
    if (warning) {
      return (
        <Popover onOpenChange={setOpen} open={open}>
          <Tip label={text.updateProblem} side="right" sideOffset={8}>
            <PopoverTrigger asChild>
              <button
                aria-label={text.updateProblem}
                className="grid size-9 place-items-center"
                data-update-warning
                type="button"
              >
                <span aria-hidden className="size-1.5 rounded-full bg-(--atum-ink-muted)" />
              </button>
            </PopoverTrigger>
          </Tip>
          <PopoverContent align="end" className="atum-update-popover w-64 p-3" side="right">
            <p className="text-(length:--atum-t-control) font-medium text-(--atum-ink)" role="status">
              {updateFailureMessage(status, text)}
            </p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Button
                onClick={() => {
                  setOpen(false)
                  openUpdates()
                }}
                size="sm"
                variant="text"
              >
                {text.openSettings}
              </Button>
              <Button onClick={() => void usable(openDownload)} size="sm" variant="text">
                {text.downloadAtum}
              </Button>
              {!manualRecovery && (
                <Button disabled={busy} onClick={() => void usable(checkNow)} size="sm" variant="secondary">
                  {text.retry}
                </Button>
              )}
            </div>
          </PopoverContent>
        </Popover>
      )
    }

    return null
  }

  const notes = updateNotes(status.notes)
  const restartDisabled = busy || status.state === 'restarting'

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tip label={text.readyLabel} side="right" sideOffset={8}>
        <PopoverTrigger asChild>
          <button
            aria-label={text.readyLabel}
            className="atum-rail-update"
            data-state={open ? 'open' : 'closed'}
            data-update-attention
            type="button"
          >
            <CircleArrowDownFilled aria-hidden className="size-5" />
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="atum-update-popover w-64 p-3" side="right">
        <p className="text-(length:--atum-t-control) font-medium text-(--atum-ink)" role="status">
          {restartFailed ? text.restartFailed : status.state === 'restarting' ? text.restarting : text.ready(status.version)}
        </p>
        {notes.length > 0 && (
          <div className="mt-3" data-update-notes>
            <p className="text-(length:--atum-t-caption) font-medium text-(--atum-ink-soft)">{text.whatsNew}</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-(length:--atum-t-caption) text-(--atum-ink-muted)">
              {notes.map((note, index) => (
                <li key={`${index}:${note}`}>{note}</li>
              ))}
            </ul>
          </div>
        )}
        {restartDisabled && status.state !== 'restarting' && (
          <p className="mt-1 text-(length:--atum-t-caption) text-(--atum-ink-muted)">{text.restartBusy}</p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={() => setOpen(false)} size="sm" variant="text">
            {text.later}
          </Button>
          <Button disabled={restartDisabled} onClick={() => void runRestart()} size="sm">
            {text.restart}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
