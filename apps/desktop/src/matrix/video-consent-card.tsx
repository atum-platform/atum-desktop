import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Check, Movie } from '@/lib/icons'

import type { MatrixSubscriptionsBridge } from '../../shared/matrix'
import type { MatrixVideoConsentLocale } from '../../shared/matrix-video-consent'

import { MATRIX_VIDEO_CONSENT_SENTENCES, useVideoConsentCopy } from './video-consent-copy'

export type VideoConsentBridge = Pick<MatrixSubscriptionsBridge, 'allowVideoConsent' | 'videoConsent'>

type Read = { kind: 'checking' } | { kind: 'failed' } | { kind: 'asking'; locale: MatrixVideoConsentLocale } | { kind: 'allowed' }

/**
 * The one-time video-generation consent, as native card chrome in the conversation (and under the
 * Settings row when video is turned back on). One focus and one action: the platform's disclosure,
 * one unticked box with the consent sentence, Allow video (disabled until the box is ticked) and a
 * quiet Not now. The sentences are shown in the language the platform records (`locale`), the
 * buttons and states in the app's language. A failed read is "couldn't reach", never "not
 * consented", and never sends anything. Nothing is posted into the conversation: once allowed, the
 * card settles to one quiet line and closes; the agent tries again on its own.
 */
export function VideoConsentCard({
  bridge,
  onDismiss,
  onSettled,
  settleMs = 1600
}: {
  bridge: VideoConsentBridge
  onDismiss(): void
  /** Consent is current (it already was, or the person just allowed it). */
  onSettled(): void
  settleMs?: number
}) {
  const words = useVideoConsentCopy()
  const [read, setRead] = useState<Read>({ kind: 'checking' })
  const [ticked, setTicked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<'refused' | 'unavailable'>()
  const live = useRef(true)
  const settled = useRef(onSettled)
  const boxId = useId()
  const titleId = useId()

  settled.current = onSettled

  const check = useCallback(async () => {
    setRead({ kind: 'checking' })

    try {
      const status = await bridge.videoConsent!()

      if (!live.current) {
        return
      }

      if (status.current) {
        settled.current()

        return
      }

      setRead({ kind: 'asking', locale: status.locale })
    } catch {
      if (live.current) {
        setRead({ kind: 'failed' })
      }
    }
  }, [bridge])

  useEffect(() => {
    live.current = true
    void check()

    return () => {
      live.current = false
    }
  }, [check])

  useEffect(() => {
    if (read.kind !== 'allowed') {
      return
    }

    const timer = setTimeout(() => settled.current(), settleMs)

    return () => clearTimeout(timer)
  }, [read.kind, settleMs])

  const allow = async () => {
    if (!ticked || saving || !bridge.allowVideoConsent) {
      return
    }

    setSaving(true)
    setNotice(undefined)

    try {
      const result = await bridge.allowVideoConsent()

      if (!live.current) {
        return
      }

      if (result.status === 'allowed') {
        setRead({ kind: 'allowed' })

        return
      }

      // Refused: the platform will not record it for this account or this wording. Untick, calmly.
      if (result.status === 'refused') {
        setTicked(false)
      }

      setNotice(result.status)
    } catch {
      if (live.current) {
        setNotice('unavailable')
      }
    } finally {
      if (live.current) {
        setSaving(false)
      }
    }
  }

  if (read.kind === 'checking') {
    return null
  }

  if (read.kind === 'allowed') {
    return (
      <div className="py-(--ak-s2)" data-matrix-video-consent="allowed">
        <span className="ak-ask-line ak-ask-line--ok" role="status">
          <Check aria-hidden className="ak-icon" />
          {words.allowed}
        </span>
      </div>
    )
  }

  const state = read.kind === 'failed' ? 'unavailable' : saving ? 'saving' : (notice ?? 'asking')

  return (
    <section
      aria-labelledby={titleId}
      className="ak-ask w-full text-start"
      data-matrix-video-consent={state}
      style={{ background: 'var(--ak-ground)', boxShadow: 'none', marginBlock: 'var(--ak-s2)' }}
    >
      <div className="ak-ask-head">
        <span className="ak-ask-mark">
          <Movie aria-hidden className="ak-icon" />
        </span>
        <div>
          <h2 className="ak-ask-title" id={titleId}>
            {words.title}
          </h2>
          {read.kind === 'asking' && (
            <p className="ak-ask-body" data-matrix-video-consent-disclosure lang={read.locale}>
              {MATRIX_VIDEO_CONSENT_SENTENCES[read.locale].disclosure}
            </p>
          )}
        </div>
      </div>

      {read.kind === 'failed' ? (
        <>
          <p className="ak-ask-body ps-11" role="status">
            {words.unavailable}
          </p>
          <div className="ak-ask-actions">
            <Button className="ak-btn ak-btn--sm" data-matrix-video-consent-retry onClick={() => void check()} size="sm" variant="secondary">
              {words.tryAgain}
            </Button>
            <Button className="ak-btn ak-btn--plain ak-btn--sm" data-matrix-video-consent-dismiss onClick={onDismiss} size="sm" variant="text">
              {words.dismiss}
            </Button>
          </div>
        </>
      ) : (
        <>
          <label className="flex cursor-pointer items-start gap-(--ak-s2) ps-11" htmlFor={boxId}>
            <Checkbox
              checked={ticked}
              className={`ak-check mt-0.5 shrink-0 ${ticked ? 'is-on' : ''}`}
              data-matrix-video-consent-checkbox
              disabled={saving || notice === 'refused'}
              id={boxId}
              onCheckedChange={value => {
                setTicked(value === true)
                setNotice(previous => (previous === 'unavailable' ? undefined : previous))
              }}
            />
            <span className="[font:var(--ak-t-body)] text-(--ak-ink)" data-matrix-video-consent-sentence lang={read.locale}>
              {MATRIX_VIDEO_CONSENT_SENTENCES[read.locale].checkbox}
            </span>
          </label>

          {notice && (
            <p className="ak-ask-body ps-11" data-matrix-video-consent-notice={notice} role="status">
              {notice === 'refused' ? words.refused : words.unavailable}
            </p>
          )}

          <div className="ak-ask-actions">
            {notice !== 'refused' && (
              <Button
                aria-busy={saving || undefined}
                className="ak-btn ak-btn--primary ak-btn--sm"
                data-matrix-video-consent-allow
                disabled={!ticked || saving}
                onClick={() => void allow()}
                size="sm"
              >
                {saving ? words.saving : notice === 'unavailable' ? words.tryAgain : words.allow}
              </Button>
            )}
            <Button
              className="ak-btn ak-btn--plain ak-btn--sm"
              data-matrix-video-consent-dismiss
              disabled={saving}
              onClick={onDismiss}
              size="sm"
              variant="text"
            >
              {words.dismiss}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
