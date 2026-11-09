import { useMemo, useState } from 'react'

import { NoticeBand } from '@/components/ui/error-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'
import { matrixNotificationCopy } from '../../shared/matrix-notification-copy'
import {
  type MatrixNotificationLevel,
  type MatrixNotificationPolicyChange,
  type MatrixQuietHours,
  matrixSystemTimeZone
} from '../../shared/matrix-notification-policy'

import { SettingsRow } from './settings-row'

const LEVELS: readonly MatrixNotificationLevel[] = ['all', 'mentions', 'nothing']

const toTime = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

function fromTime(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/u.exec(value)
  const hour = Number(match?.[1])
  const minute = Number(match?.[2])

  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? hour * 60 + minute : undefined
}

function timeZones(current: string): string[] {
  try {
    const supported = (Intl as typeof Intl & { supportedValuesOf?(key: 'timeZone'): string[] })
      .supportedValuesOf?.('timeZone') ?? []

    return [...new Set([current, ...supported])].sort()
  } catch {
    return [current]
  }
}

/** Settings › General › Notifications: portable Team space policy, kept beside device switches. */
export function MatrixNotificationPolicySettings({ snapshot }: { snapshot: MatrixSnapshot }) {
  const { locale } = useI18n()
  const copy = matrixNotificationCopy(locale)
  const policy = snapshot.notificationPolicy
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const zone = policy?.quietHours.timeZone ?? matrixSystemTimeZone()
  const zones = useMemo(() => timeZones(zone), [zone])
  const disabled = pending || snapshot.state !== 'ready' || !policy?.writable

  if (!snapshot.identity || !policy) {
    return null
  }

  const save = (change: MatrixNotificationPolicyChange) => {
    if (disabled) {
      return
    }

    setPending(true)
    setFailed(false)
    void window.atumMatrix.command({ kind: 'notificationPolicy', identity: snapshot.identity!, ...change })
      .catch(() => setFailed(true))
      .finally(() => setPending(false))
  }

  const quiet = (change: Partial<MatrixQuietHours>) => save({
    scope: 'quietHours',
    quietHours: { ...policy.quietHours, ...change }
  })

  return (
    <>
      <SettingsRow
        control={
          <Select
            disabled={disabled}
            onValueChange={level => save({ scope: 'account', level: level as MatrixNotificationLevel })}
            value={policy.accountLevel}
          >
            <SelectTrigger aria-label={copy.accountLevel} className="min-w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVELS.map(level => <SelectItem key={level} value={level}>{copy.levels[level]}</SelectItem>)}
            </SelectContent>
          </Select>
        }
        help={copy.accountLevelHelp}
        title={copy.accountLevel}
      />
      <SettingsRow
        control={
          <Switch
            aria-label={copy.quietHours}
            checked={policy.quietHours.enabled}
            disabled={disabled}
            onCheckedChange={enabled => quiet({ enabled })}
          />
        }
        help={copy.quietHoursHelp}
        title={copy.quietHours}
      />
      {policy.quietHours.enabled && (
        <>
          <SettingsRow
            control={
              <input
                aria-label={copy.from}
                className="atum-input h-8 w-28"
                disabled={disabled}
                onChange={event => {
                  const startMinute = fromTime(event.target.value)
                  if (startMinute !== undefined) {quiet({ startMinute })}
                }}
                type="time"
                value={toTime(policy.quietHours.startMinute)}
              />
            }
            title={copy.from}
          />
          <SettingsRow
            control={
              <input
                aria-label={copy.until}
                className="atum-input h-8 w-28"
                disabled={disabled}
                onChange={event => {
                  const endMinute = fromTime(event.target.value)
                  if (endMinute !== undefined) {quiet({ endMinute })}
                }}
                type="time"
                value={toTime(policy.quietHours.endMinute)}
              />
            }
            title={copy.until}
          />
          <SettingsRow
            control={
              <Select disabled={disabled} onValueChange={timeZone => quiet({ timeZone })} value={zone}>
                <SelectTrigger aria-label={copy.timeZone} className="max-w-60 min-w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {zones.map(timeZone => <SelectItem key={timeZone} value={timeZone}>{timeZone}</SelectItem>)}
                </SelectContent>
              </Select>
            }
            title={copy.timeZone}
          />
        </>
      )}
      {(failed || !policy.writable) && (
        <NoticeBand role={failed ? 'alert' : 'status'} tone={failed ? 'failure' : 'notice'}>
          {failed ? copy.failed : copy.readonly}
        </NoticeBand>
      )}
    </>
  )
}
