import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { CalendarMarks, DriveMark, GmailMark } from '@/components/brand/utility-marks'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { ExternalLink } from '@/lib/external-link'
import { $atumAccountStatus } from '@/store/atum-messaging'
import { isPrimaryProfile } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { isSecondaryWindow } from '@/store/windows'

import { UTILITY_COPY } from './copy'
import {
  $utilities,
  cancelUtilityConnection,
  connectUtility,
  disconnectUtility,
  refreshUtilities,
  setUtilityEnabled
} from './store'

export interface UtilityConnectionCardProps {
  manage?: boolean
}

export function UtilityConnectionCard({ manage = false }: UtilityConnectionCardProps) {
  const account = useStore($atumAccountStatus)
  const profile = useStore($activeGatewayProfile)

  if (isSecondaryWindow() || (!manage && !isPrimaryProfile(profile))) {
    return null
  }

  if (!account.account || !['signed_in', 'refreshing'].includes(account.state)) {
    return null
  }

  return <ConnectionCard key={`${account.account.id}:${account.current?.sessionGeneration ?? 0}`} manage={manage} />
}

function ConnectionCard({ manage }: UtilityConnectionCardProps) {
  const { locale } = useI18n()
  const copy = UTILITY_COPY[locale]
  const { status, loading, busy, operation, error } = useStore($utilities)
  const [picker, setPicker] = useState(false)
  const [disclosure, setDisclosure] = useState<null | 'google' | 'drive'>(null)
  const sources = status?.sources ?? []
  const emailConnected = sources.some(source => source.kind === 'email' && source.state === 'connected')
  const calendarConnected = sources.some(source => source.kind === 'calendar' && source.state === 'connected')
  const driveConnected = sources.some(source => source.kind === 'drive' && source.state === 'connected')
  const complete = emailConnected && calendarConnected && driveConnected

  if (complete && !manage && !error && !busy && !status?.calendarSelectionRequired) {
    return null
  }

  const errorText = error === 'reconnect' ? copy.reconnectError : error ? copy[error] : null
  const groups = [...new Set([...sources.map(source => source.accountKey), ...(status?.appleConnected ? [null] : [])])]

  const showGoogleDisclosure = (service: 'google' | 'drive') => {
    setPicker(false)
    setDisclosure(service)
  }

  const continueGoogle = () => {
    const service = disclosure
    setDisclosure(null)

    if (service === 'drive') {
      void connectUtility({ provider: 'google', service: 'drive' })
    } else if (service === 'google') {
      void connectUtility({ provider: 'google' })
    }
  }

  return (
    <section
      aria-label={copy.management}
      className="relative z-4 mb-2 text-(--atum-ink)"
      data-slot="utility-connection-card"
      onKeyDown={event => {
        if (event.target instanceof HTMLInputElement && event.key !== 'Escape') {
          event.stopPropagation()
        }

        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault()
        }
      }}
      onPointerDown={event => event.stopPropagation()}
    >
      {manage && (
        <>
          <div className="text-sm font-medium">{copy.management}</div>
          <p className="mt-1 text-xs leading-relaxed text-(--atum-ink-muted)">{copy.readOnly}</p>
          {status?.workspaceProtected && <p className="mt-2 text-xs leading-relaxed text-(--atum-ink-muted)">{copy.workspaceProtectedNote} {copy.workspaceLocalOnly}</p>}
        </>
      )}
      {loading && (
        <p className="mt-2 text-xs" role="status">
          {copy.checking}
        </p>
      )}
      {status?.calendarSelectionRequired && (
        <p className="my-2 text-xs" role="status">
          {copy.selectionChanged}{' '}
          {!manage && (
            <a className="underline" href="#/settings">
              {copy.reviewCalendars}
            </a>
          )}
        </p>
      )}
      {status && (
        <div className={`flex flex-wrap gap-2 ${manage ? 'mt-3' : ''}`}>
          <Button
            className="rounded-full px-3 py-2"
            disabled={busy || !status.available.google || (!manage && emailConnected)}
            onClick={() => showGoogleDisclosure('google')}
            type="button"
            variant="outline"
          >
            <GmailMark />
            <span>
              {manage ? copy.addGoogle : emailConnected ? `${copy.emailLabel} · ${copy.connected}` : copy.email}
            </span>
          </Button>
          <Button
            aria-expanded={picker}
            className="rounded-full px-3 py-2"
            disabled={busy || (!manage && calendarConnected)}
            onClick={() => {
              setDisclosure(null)
              setPicker(!picker)
            }}
            type="button"
            variant="outline"
          >
            <CalendarMarks />
            <span>{!manage && calendarConnected ? `${copy.calendarLabel} · ${copy.connected}` : copy.calendar}</span>
          </Button>
          <Button
            className="rounded-full px-3 py-2"
            disabled={busy || !status.available.google || (!manage && driveConnected)}
            onClick={() => showGoogleDisclosure('drive')}
            type="button"
            variant="outline"
          >
            <DriveMark />
            <span>
              {manage ? copy.addDrive : driveConnected ? `${copy.driveLabel} · ${copy.connected}` : copy.drive}
            </span>
          </Button>
        </div>
      )}
      {manage &&
        groups.map(key => {
          const items = sources.filter(source => source.accountKey === key)

          const label = key
            ? (items.find(source => source.kind === 'email' || source.kind === 'drive')?.label ?? items[0]?.detail)
            : copy.appleCalendar

          return (
            <fieldset className="mt-5 min-w-0 border-t border-(--atum-line) pt-3" key={key ?? 'apple'}>
              <legend className="max-w-full truncate px-1 text-sm font-medium">{label}</legend>
              {items.length === 0 && <p className="my-2 text-xs text-(--atum-ink-muted)">{copy.noCalendars}</p>}
              <div className="space-y-2">
                {items.map(source => (
                  <label className="flex items-center gap-2 text-sm" key={source.id}>
                    <input
                      checked={source.enabled}
                      disabled={busy}
                      onChange={event => void setUtilityEnabled([{ id: source.id, enabled: event.target.checked }])}
                      type="checkbox"
                    />
                    <span className="min-w-0 break-words">
                      {source.kind === 'email'
                        ? copy.emailLabel
                        : source.kind === 'drive'
                          ? copy.driveLabel
                          : source.label}
                      {source.detail && !key ? ` · ${source.detail}` : ''}
                      {source.state === 'reconnect' ? ` · ${copy.reconnect}` : ''}
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {items.some(source => source.kind !== 'drive' && source.state === 'reconnect') && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      key ? showGoogleDisclosure('google') : void connectUtility({ provider: 'apple-calendar' })
                    }
                    size="sm"
                    type="button"
                    variant="text"
                  >
                    {copy.reconnect}
                  </Button>
                )}
                {items.some(source => source.kind === 'drive' && source.state === 'reconnect') && (
                  <Button
                    disabled={busy}
                    onClick={() => showGoogleDisclosure('drive')}
                    size="sm"
                    type="button"
                    variant="text"
                  >
                    {copy.reconnect} · {copy.driveLabel}
                  </Button>
                )}
                <Button
                  aria-label={`${copy.disconnect} ${label}`}
                  disabled={busy}
                  onClick={() =>
                    void disconnectUtility(
                      key ? { provider: 'google', accountKey: key } : { provider: 'apple-calendar' }
                    )
                  }
                  size="sm"
                  type="button"
                  variant="text"
                >
                  {copy.disconnect}
                </Button>
              </div>
            </fieldset>
          )
        })}
      {manage && sources.length > 0 && (
        <p className="mt-3 text-xs leading-relaxed text-(--atum-ink-muted)">{copy.sourceNote}</p>
      )}
      {manage && sources.some(source => source.provider === 'google') && (
        <p className="mt-2 text-xs leading-relaxed text-(--atum-ink-muted)">{copy.disconnectGoogleNote}</p>
      )}
      {disclosure && !busy && status && (
        <div className="mt-3 space-y-3">
          <p className="text-xs leading-relaxed text-(--atum-ink-muted)">
            {disclosure === 'drive' ? copy.driveDisclosure : copy.googleDisclosure}
            {' '}{copy.workspaceProtectedNote}
            {' '}{copy.workspaceLocalOnly}
          </p>
          <p className="text-xs leading-relaxed text-(--atum-ink-muted)">
            <ExternalLink href="https://www.atumplatform.com/privacy" showExternalIcon={false}>
              {copy.privacy}
            </ExternalLink>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!status.available.google} onClick={continueGoogle} type="button" variant="outline">
              {copy.continue}
            </Button>
            <Button onClick={() => setDisclosure(null)} type="button" variant="text">
              {copy.cancelDisclosure}
            </Button>
          </div>
          {!status.available.google && <p className="text-xs text-(--atum-ink-muted)">{copy.googleUnavailable}</p>}
        </div>
      )}
      {picker && !busy && status && (
        <div className="mt-3 space-y-3">
          <p className="text-xs leading-relaxed text-(--atum-ink-muted)">{copy.googleNote}</p>
          <Button
            disabled={!status.available.google}
            onClick={() => showGoogleDisclosure('google')}
            type="button"
            variant="outline"
          >
            {copy.google}
          </Button>
          {!status.available.google && <p className="text-xs text-(--atum-ink-muted)">{copy.googleUnavailable}</p>}
          <p className="text-xs leading-relaxed text-(--atum-ink-muted)">{copy.appleNote}</p>
          <div>
            <Button
              disabled={!status.available['apple-calendar']}
              onClick={() => {
                setPicker(false)
                void connectUtility({ provider: 'apple-calendar' })
              }}
              type="button"
              variant="outline"
            >
              {copy.appleCalendar}
            </Button>
          </div>
          {!status.available['apple-calendar'] && (
            <p className="text-xs text-(--atum-ink-muted)">{copy.appleUnavailable}</p>
          )}
          <Button onClick={() => setPicker(false)} type="button" variant="text">
            {copy.back}
          </Button>
        </div>
      )}
      {busy && (
        <div className="mt-3 flex items-center gap-3">
          <span className="text-xs" role="status">
            {operation === 'disconnect'
              ? copy.disconnecting
              : operation === 'setEnabled'
                ? copy.saving
                : copy.connecting}
          </span>
          {operation === 'connect' && (
            <Button onClick={() => void cancelUtilityConnection()} type="button" variant="text">
              {copy.cancel}
            </Button>
          )}
        </div>
      )}
      {busy && operation === 'connect' && <p className="mt-2 text-xs text-(--atum-ink-muted)">{copy.googleNote}</p>}
      {status?.degraded && (
        <p className="mt-2 text-xs" role="status">
          {copy.network}
        </p>
      )}
      {errorText && (
        <div className="mt-3 text-xs">
          <p role="alert">{errorText}</p>
          <Button className="mt-2" onClick={() => void refreshUtilities()} type="button" variant="text">
            {copy.retry}
          </Button>
        </div>
      )}
    </section>
  )
}
