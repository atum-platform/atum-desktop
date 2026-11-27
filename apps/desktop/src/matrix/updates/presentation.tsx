import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import type { Locale } from '@/i18n'

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
