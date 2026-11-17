import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'

import type { MatrixSubscriptionsBridge } from '../../shared/matrix'
import type { MatrixVideoConsentStatus } from '../../shared/matrix-video-consent'

import { SettingsRow, SettingsSection } from './settings-row'
import { VideoConsentCard } from './video-consent-card'
import { useVideoConsentCopy } from './video-consent-copy'

type Read = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; value: MatrixVideoConsentStatus }
type TurnOff = 'idle' | 'turning_off' | 'pending' | 'failed'

/** How many times one Turn off waits on the platform before saying "still turning off". */
const TURN_OFF_ROUNDS = 8

/**
 * Settings › Connections › Video generation: one MiniMax row with one switch. On says when video
 * was allowed; off revokes with the key main keeps for it ("Turning off…" until the platform's 200).
 * Turning it back on shows the same explicit card as the conversation, under the row. A failed read
 * is one calm line with Try again, never "off". An older main without the bridge shows nothing.
 */
export function VideoConsentSettings({
  bridge,
  scopeKey
}: {
  bridge?: Pick<MatrixSubscriptionsBridge, 'allowVideoConsent' | 'revokeVideoConsent' | 'videoConsent'>
  scopeKey?: string
}) {
  const words = useVideoConsentCopy()
  const { locale } = useI18n()
  const [read, setRead] = useState<Read>({ kind: 'loading' })
  const [turnOff, setTurnOff] = useState<TurnOff>('idle')
  const [asking, setAsking] = useState(false)
  const live = useRef(true)

  const reload = useCallback(async () => {
    if (!bridge?.videoConsent) {
      return undefined
    }

    try {
      const value = await bridge.videoConsent()

      if (live.current) {
        setRead({ kind: 'ready', value })
      }

      return value
    } catch {
      if (live.current) {
        setRead({ kind: 'failed' })
      }

      return undefined
    }
  }, [bridge])

  const revoke = useCallback(async () => {
    if (!bridge?.revokeVideoConsent) {
      return
    }

    setTurnOff('turning_off')

    try {
      for (let round = 0; round < TURN_OFF_ROUNDS; round += 1) {
        const result = await bridge.revokeVideoConsent()

        if (!live.current) {
          return
        }

        if (result.status === 'revoked') {
          setRead(previous =>
            previous.kind === 'ready'
              ? { kind: 'ready', value: { current: false, locale: previous.value.locale, confirmedAt: null } }
              : previous
          )
          setTurnOff('idle')

          return
        }

        if (result.status !== 'pending') {
          setTurnOff('failed')

          return
        }
      }

      setTurnOff('pending')
    } catch {
      if (live.current) {
        setTurnOff('failed')
      }
    }
  }, [bridge])

  useEffect(() => {
    live.current = true
    setRead({ kind: 'loading' })
    setTurnOff('idle')
    setAsking(false)
    void reload().then(value => {
      // A turn-off still pending from before (another window, or before a restart) finishes with
      // the same key main kept for it, and reads "Turning off…" meanwhile.
      if (value?.revoking && live.current) {
        void revoke()
      }
    })

    return () => {
      live.current = false
    }
  }, [reload, revoke, scopeKey])

  if (!bridge?.videoConsent || read.kind === 'loading') {
    return null
  }

  if (read.kind === 'failed') {
    return (
      <SettingsSection title={words.section}>
        <SettingsRow
          control={
            <Button onClick={() => void reload()} size="sm" variant="ghost">
              {words.tryAgain}
            </Button>
          }
          data-matrix-video-consent-settings="failed"
          help={words.readFailed}
          title="MiniMax"
        />
      </SettingsSection>
    )
  }

  const { value } = read
  const on = value.current || turnOff !== 'idle'

  const help =
    turnOff === 'turning_off'
      ? words.turningOff
      : turnOff === 'pending'
        ? words.turnOffPending
        : turnOff === 'failed'
          ? words.turnOffFailed
          : value.current && value.confirmedAt !== null
            ? words.allowedOn(new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(value.confirmedAt))
            : words.off

  return (
    <SettingsSection title={words.section}>
      <div className="atum-settings-item">
        <SettingsRow
          aria-live="polite"
          control={
            <Switch
              aria-label={words.switchLabel}
              checked={on}
              data-matrix-video-consent-switch
              disabled={turnOff === 'turning_off' || asking}
              onCheckedChange={next => {
                if (!next) {
                  void revoke()
                } else if (!value.current) {
                  setAsking(true)
                }
              }}
            />
          }
          data-matrix-video-consent-settings={
            turnOff !== 'idle' ? turnOff : asking ? 'asking' : value.current ? 'allowed' : 'off'
          }
          help={help}
          title="MiniMax"
        />
        {asking && bridge.allowVideoConsent && (
          <VideoConsentCard
            bridge={bridge}
            onDismiss={() => setAsking(false)}
            onSettled={() => {
              setAsking(false)
              void reload()
            }}
          />
        )}
      </div>
    </SettingsSection>
  )
}
