import { useEffect, useRef, useState } from 'react'

import type { MatrixIdentity, MatrixSnapshot } from '../../shared/matrix'

import { matrixStarterCopy } from './starter-copy'
import { wholeProtons } from './wallet-ui'

interface MatrixStarterOffer {
  amount: number
  identity: MatrixIdentity
  kind: 'founding' | 'standard'
  scope: string
}

const APPROXIMATE_PROTONS_PER_CHAT = 2_500

export function starterChatEstimate(amountMicro: number): number {
  return Math.max(1, Math.floor(wholeProtons(amountMicro) / APPROXIMATE_PROTONS_PER_CHAT))
}

function starterOffer(snapshot: MatrixSnapshot): MatrixStarterOffer | null {
  const { identity, petScope, starter } = snapshot

  if (
    snapshot.starterMarker !== 'unseen' ||
    snapshot.state !== 'ready' ||
    (snapshot.readiness?.phase !== 'ready' && snapshot.readiness?.phase !== 'degraded') ||
    !identity ||
    typeof petScope !== 'string' ||
    petScope.length === 0 ||
    !starter ||
    !Number.isSafeInteger(starter.amount) ||
    starter.amount <= 0 ||
    (starter.kind !== 'founding' && starter.kind !== 'standard')
  ) {
    return null
  }

  return { ...starter, identity, scope: petScope }
}

interface MatrixStarterNoticeProps {
  /** The selected room is the synced default assistant chat and can show its welcome line. */
  defaultAssistantChat: boolean
  locale: string
  snapshot: MatrixSnapshot
}

/**
 * A presentation-only record of the native starter grant. The native account-data
 * marker remains the once-per-account authority; this component holds no durable state.
 */
export function MatrixStarterNotice({ defaultAssistantChat, locale, snapshot }: MatrixStarterNoticeProps) {
  const offer = defaultAssistantChat ? starterOffer(snapshot) : null
  const identityUserId = offer?.identity.userId
  const identityDeviceId = offer?.identity.deviceId
  const scope = offer?.scope
  const kind = offer?.kind
  const amountMicro = offer?.amount

  const offerKey =
    identityUserId && identityDeviceId && scope && kind && amountMicro
      ? `${identityUserId}:${identityDeviceId}:${scope}:${kind}:${amountMicro}`
      : null

  const line = useRef<HTMLParagraphElement>(null)
  const pending = useRef<string | null>(null)
  // Retain the already presented historical fact for this chat visit. A fast
  // durable acknowledgement must not erase the welcome before it can be read.
  const [presented, setPresented] = useState<{ key: string; offer: MatrixStarterOffer } | null>(null)
  const [acknowledged, setAcknowledged] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const sameVisit = Boolean(
    defaultAssistantChat &&
    snapshot.state === 'ready' &&
    (snapshot.readiness?.phase === 'ready' || snapshot.readiness?.phase === 'degraded') &&
    presented?.offer.scope === snapshot.petScope &&
    presented?.offer.identity.userId === snapshot.identity?.userId &&
    presented?.offer.identity.deviceId === snapshot.identity?.deviceId
  )

  const displayed = offer ?? (sameVisit ? presented?.offer : null)
  const displayedKey = offerKey ?? (sameVisit ? presented?.key : null)

  useEffect(() => {
    if (offer && offerKey) {
      setPresented(current => (current?.key === offerKey ? current : { key: offerKey, offer }))
    } else if (!sameVisit) {
      setPresented(null)
    }
  }, [offer, offerKey, sameVisit])

  useEffect(() => {
    if (
      !identityUserId ||
      !identityDeviceId ||
      !scope ||
      !offerKey ||
      acknowledged === offerKey ||
      !line.current?.isConnected
    ) {
      return
    }

    let live = true
    pending.current = offerKey
    setFailed(current => (current === offerKey ? null : current))

    void window.atumMatrix
      .command({ kind: 'starterSeen', identity: { userId: identityUserId, deviceId: identityDeviceId }, scope })
      .then(() => {
        if (live && pending.current === offerKey) {
          setAcknowledged(offerKey)
        }
      })
      .catch(() => {
        if (live && pending.current === offerKey) {
          setFailed(offerKey)
        }
      })
      .finally(() => {
        if (pending.current === offerKey) {
          pending.current = null
        }
      })

    return () => {
      live = false

      if (pending.current === offerKey) {
        pending.current = null
      }
    }
  }, [acknowledged, attempt, identityDeviceId, identityUserId, offerKey, scope])

  if (!displayed || !displayedKey) {
    return null
  }

  const copy = matrixStarterCopy(locale)
  const chatEstimate = starterChatEstimate(displayed.amount)
  const chats = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(chatEstimate)
  const acknowledgementFailed = failed === displayedKey && acknowledged !== displayedKey

  return (
    // A composer notice (STYLE.md §10): inside the composer's glass, above the text.
    <div className="flex items-center gap-(--ak-s2) px-1 pb-1" data-matrix-starter-notice>
      <span className="min-w-0 flex-1">
        <p className="[font:var(--ak-t-body-strong)] text-(--ak-ink)">{copy.title}</p>
        <p className="[font:var(--ak-t-caption)] text-(--ak-ink-3)" ref={line}>
          {copy.body(chats)}
        </p>
      </span>
      {acknowledgementFailed && (
        <button
          className="ak-btn ak-btn--plain ak-btn--sm"
          onClick={() => setAttempt(value => value + 1)}
          type="button"
        >
          {copy.retry}
        </button>
      )}
    </div>
  )
}
