import { useState } from 'react'

import { useI18n } from '@/i18n'
import { AlertCircle, Check, Clock, type IconComponent, Minus, Robot, Sparkles, Trash2 } from '@/lib/icons'

import type {
  MatrixAgentProposalCard,
  MatrixAgentProposalOperation,
  MatrixAgentProposalsBridge
} from '../../shared/matrix-agent-proposals'

import { matrixAgentProposalCopy } from './agent-proposal-copy'
import { takeAgentProposal, useAgentProposals } from './agent-proposals-store'
import { matrixWalletCopy } from './wallet-copy'

const MARKS: Record<MatrixAgentProposalOperation, IconComponent> = { create: Sparkles, hire: Robot, retire: Trash2 }

/**
 * One kit ask (STYLE.md §13 "Ask") for what the main agent proposed about the person's other
 * agents: the question naming the agent, the price only when it costs Protons, Confirm and a
 * quiet Not now. Once answered it settles into one quiet `.ak-ask-line`. Every field comes from
 * main's projection of the platform record; the window only names the proposal back.
 */
export function MatrixAgentProposalAsk({
  bridge,
  onTopUp,
  card
}: {
  onTopUp?: () => Promise<void>
  bridge: Pick<MatrixAgentProposalsBridge, 'confirm' | 'decline'>
  card: MatrixAgentProposalCard
}) {
  const { locale } = useI18n()
  const copy = matrixAgentProposalCopy[locale]
  const [busy, setBusy] = useState<'confirm' | 'decline' | null>(null)
  const [lost, setLost] = useState(false)
  const failed = card.state === 'failed' || lost
  const funds = card.state === 'failed' && card.failure === 'funds'
  const topUp = () => {
    setBusy('confirm')
    void (onTopUp ?? (() => window.atumMatrix.openTopUp()))()
      .catch(() => setLost(true))
      .finally(() => setBusy(null))
  }

  const answer = (action: 'confirm' | 'decline') => {
    setBusy(action)
    setLost(false)
    void bridge[action](card.id)
      .then(takeAgentProposal, () => setLost(true))
      .finally(() => setBusy(null))
  }

  if (card.state === 'confirmed' || card.state === 'declined' || card.state === 'expired') {
    const [Glyph, text, tone] =
      card.state === 'confirmed'
        ? [Check, copy.confirmed[card.operation](card.agentName), 'ak-ask-line--ok']
        : card.state === 'declined'
          ? [Minus, copy.declined[card.operation](card.agentName), '']
          : [Clock, copy.expired, '']

    return (
      <p
        aria-label={copy.label}
        className={`ak-ask-line ${tone} max-w-full self-start`}
        data-matrix-agent-proposal={card.state}
        role="status"
      >
        <Glyph aria-hidden className="ak-icon shrink-0" />
        <span className="min-w-0 truncate">{text}</span>
      </p>
    )
  }

  const Mark = MARKS[card.operation]

  const price =
    card.protons === undefined
      ? undefined
      : copy.price(new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(card.protons))

  return (
    <section
      aria-label={copy.label}
      className="ak-ask w-full text-start"
      data-matrix-agent-proposal={failed ? 'failed' : 'pending'}
      role="group"
    >
      <div className="ak-ask-head">
        <span className="ak-ask-mark">
          <Mark aria-hidden className="ak-icon" />
        </span>
        <div className="min-w-0">
          <h3 className="ak-ask-title break-words">{copy.ask[card.operation](card.agentName)}</h3>
          {failed ? (
            <p className="ak-ask-body flex items-center gap-(--ak-s1)" role="status">
              <AlertCircle aria-hidden className="ak-icon ak-icon--sm text-(--ak-danger)" />
              {card.failure === 'funds' ? copy.short : copy.failed}
            </p>
          ) : (
            price && <p className="ak-ask-body">{price}</p>
          )}
        </div>
      </div>
      <div className="ak-ask-actions">
        <button
          aria-busy={busy === 'confirm' || undefined}
          className={`ak-btn ak-btn--sm ${card.operation === 'retire' ? 'ak-btn--danger' : 'ak-btn--primary'}`}
          disabled={busy !== null}
          onClick={() => funds ? topUp() : answer('confirm')}
          type="button"
        >
          {funds ? matrixWalletCopy(locale).topUpMore : failed ? copy.tryAgain : copy.confirm}
        </button>
        <button
          className="ak-btn ak-btn--plain ak-btn--sm"
          disabled={busy !== null}
          onClick={() => answer('decline')}
          type="button"
        >
          {copy.notNow}
        </button>
      </div>
    </section>
  )
}

/** The confirm cards placed under one of the agent's messages; nothing when none arrived. */
export function MatrixAgentProposalCards({
  bridge = window.atumMatrix?.agentProposals,
  eventId,
  onTopUp,
  roomId
}: {
  onTopUp?: () => Promise<void>
  bridge?: MatrixAgentProposalsBridge
  eventId: string
  roomId: string
}) {
  const cards = useAgentProposals(bridge, roomId, eventId)

  if (!bridge || cards.length === 0) {
    return null
  }

  return (
    <div className="mt-(--ak-s2) flex flex-col items-start gap-(--ak-s2)" data-matrix-agent-proposals>
      {cards.map(card => (
        <MatrixAgentProposalAsk bridge={bridge} card={card} key={card.id} onTopUp={onTopUp} />
      ))}
    </div>
  )
}
