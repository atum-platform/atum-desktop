import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { type Locale, useI18n } from '@/i18n'
import { Calendar, type IconComponent, Inbox, Mail, PencilLine, Tag } from '@/lib/icons'

import {
  MATRIX_GOOGLE_WRITE_STATUS,
  type MatrixGoogleWorkDraft,
  type MatrixGoogleWorkKind,
  matrixGoogleWorkKind,
  type MatrixGoogleWorkProposal,
  type MatrixGoogleWriteActionAnswer,
  type MatrixGoogleWriteAttachment,
  matrixGoogleWriteDigest,
  type MatrixGoogleWriteEmail,
  type MatrixGoogleWriteEvent,
  type MatrixGoogleWriteGmailDraft,
  type MatrixGoogleWriteMailbox,
  type MatrixGoogleWriteProposal,
  matrixGoogleWriteSlot
} from '../../shared/matrix-google-write-proposal'

import { matrixGoogleWriteCardCopy, type MatrixGoogleWriteCardCopy } from './google-write-card-copy'
import { useNoticePresented } from './notice-presented'

/**
 * Where a card stands in the pending list: still listed, replaced by a newer one, or gone. A Work
 * card that leaves the list unanswered and unreplaced has expired (Shell lists a Work proposal for a day).
 */
export type MatrixGoogleWriteStanding = 'open' | 'superseded' | 'closed' | 'expired'

/** What the card shows. Only `pending` offers the two actions. */
export type MatrixGoogleWriteCardView =
  | 'checking'
  | 'pending'
  | 'approving'
  | 'declining'
  | 'approved'
  | 'declined'
  | 'superseded'
  | 'closed'
  | 'expired'
  | 'changed'

type Settled = Exclude<MatrixGoogleWriteCardView, 'checking' | 'pending' | 'approving' | 'declining'>

type Decision = 'approve' | 'decline'

type Local =
  | { phase: 'sending'; decision: Decision }
  | { phase: 'answered'; decision: Decision; state: MatrixGoogleWriteActionAnswer['state'] }

/**
 * This window's own answers and delivery reports, by proposal: a card that scrolls out of view and
 * back, or a remounted chat, reads the same answer; a decision is never sent twice once Shell
 * accepted one, and never while one is in flight; delivery is reported once per proposal.
 */
const answers = new Map<string, Local>()
const delivered = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function remember(proposalId: string, local: Local) {
  answers.set(proposalId, local)
  version += 1

  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: forget this window's answers and delivery reports. */
export function resetMatrixGoogleWriteAnswers() {
  answers.clear()
  delivered.clear()
}

const ICONS: Record<MatrixGoogleWorkKind, IconComponent> = {
  send_email: Mail,
  create_event: Calendar,
  update_event: Calendar,
  create_draft: PencilLine,
  update_draft: PencilLine,
  mailbox: Inbox,
  create_label: Tag
}

/** The card's question, which is also its accessible name. */
function question(draft: MatrixGoogleWorkDraft, copy: MatrixGoogleWriteCardCopy): string {
  const kind = matrixGoogleWorkKind(draft)

  return kind === 'mailbox' ? copy.mailbox[(draft as MatrixGoogleWriteMailbox).operation] : copy.question[kind]
}

/** An email to send or a Gmail draft: both show the exact message. */
function composed(draft: MatrixGoogleWorkDraft): draft is MatrixGoogleWriteEmail | MatrixGoogleWriteGmailDraft {
  return !('action' in draft) || draft.action === 'create_draft' || draft.action === 'update_draft'
}

/** The one line that names what a settled card was about. */
function summary(draft: MatrixGoogleWorkDraft, copy: MatrixGoogleWriteCardCopy): string {
  if (composed(draft)) {
    return draft.subject
  }

  switch (draft.action) {
    case 'mailbox':
      return draft.labels?.join(', ') ?? question(draft, copy).replace(/[?？]$/u, '')

    case 'create_label':
      return draft.name

    default:
      return draft.title
  }
}

/** A card's proposal: an assistant's, or Work's (which names no agent or room). */
type CardProposal = Pick<MatrixGoogleWriteProposal | MatrixGoogleWorkProposal, 'proposalId' | 'digest'> & {
  draft: MatrixGoogleWorkDraft
}

/** Only Shell's own answer for this exact action reads as accepted. */
function answerOf(value: unknown, decision: Decision): MatrixGoogleWriteActionAnswer['state'] {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  if (row.state === 'ok' && row.status === MATRIX_GOOGLE_WRITE_STATUS[decision]) {
    return 'ok'
  }

  return row.state === 'refused' ? 'refused' : 'unavailable'
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-(--atum-ink-muted)">{label}</dt>
      <dd className="min-w-0 break-words text-(--atum-ink)">{children}</dd>
    </>
  )
}

function Text({ value, muted = false }: { value: string; muted?: boolean }) {
  // Exactly as written: line breaks kept, never markdown, long text scrolls inside the card.
  return (
    <div
      className={`max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm ${muted ? 'text-(--atum-ink-soft)' : 'text-(--atum-ink)'}`}
      data-matrix-google-write-text
    >
      {value}
    </div>
  )
}

const GRID = 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm'

function fileSize(bytes: number, locale: Locale): string {
  const [unit, scale] = bytes >= 1_000_000 ? (['megabyte', 1_000_000] as const) : bytes >= 1_000 ? (['kilobyte', 1_000] as const) : (['byte', 1] as const)

  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(bytes / scale)
}

function files(list: readonly MatrixGoogleWriteAttachment[], locale: Locale): string {
  return list.map(file => `${file.filename} · ${fileSize(file.size, locale)}`).join(', ')
}

function Email({ draft, locale, copy }: { draft: MatrixGoogleWriteEmail; locale: Locale; copy: MatrixGoogleWriteCardCopy }) {
  const labels = copy.labels

  return (
    <>
      <dl className={GRID}>
        {draft.to.length > 0 && <Row label={labels.to}>{draft.to.join(', ')}</Row>}
        {draft.cc && draft.cc.length > 0 && <Row label={labels.cc}>{draft.cc.join(', ')}</Row>}
        {draft.bcc && draft.bcc.length > 0 && <Row label={labels.bcc}>{draft.bcc.join(', ')}</Row>}
        <Row label={labels.subject}>{draft.subject}</Row>
        {draft.forwarded && (
          <Row label={labels.forwarded}>
            {[draft.forwarded.from, draft.forwarded.subject].filter(Boolean).join(' · ')}
          </Row>
        )}
        {draft.attachments.length > 0 && <Row label={labels.attachments}>{files(draft.attachments, locale)}</Row>}
      </dl>
      {(draft.inReplyTo || draft.threadId) && <p className="text-xs text-(--atum-ink-muted)">{labels.inReplyTo}</p>}
      <Text value={draft.body} />
      {draft.quote && (
        <div className="grid gap-1 border-s-2 border-(--atum-line) ps-3">
          <p className="text-xs text-(--atum-ink-muted)">{labels.quote}</p>
          <Text muted value={draft.quote} />
          {draft.forwarded?.truncated && <p className="text-xs text-(--atum-ink-muted)">{labels.truncated}</p>}
        </div>
      )}
    </>
  )
}

function Event({ draft, locale, timeZone, copy }: { draft: MatrixGoogleWriteEvent; locale: Locale; timeZone: string; copy: MatrixGoogleWriteCardCopy }) {
  const labels = copy.labels

  const when = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(Date.parse(value))

  return (
    <>
      <dl className={GRID}>
        <Row label={labels.title}>{draft.title}</Row>
        <Row label={labels.start}>{when(draft.start)}</Row>
        <Row label={labels.end}>{when(draft.end)}</Row>
        {draft.location && <Row label={labels.location}>{draft.location}</Row>}
      </dl>
      {draft.description && <Text value={draft.description} />}
    </>
  )
}

function Mailbox({ draft, copy }: { draft: MatrixGoogleWriteMailbox; copy: MatrixGoogleWriteCardCopy }) {
  const labels = copy.labels

  return (
    <dl className={GRID}>
      <Row label={labels.appliesTo}>{draft.threadId ? labels.conversation : labels.oneEmail}</Row>
      {draft.labels && <Row label={labels.labels}>{draft.labels.join(', ')}</Row>}
    </dl>
  )
}

function Draft({ draft, locale, timeZone, copy }: { draft: MatrixGoogleWorkDraft; locale: Locale; timeZone: string; copy: MatrixGoogleWriteCardCopy }) {
  if (composed(draft)) {
    return <Email copy={copy} draft={draft} locale={locale} />
  }

  switch (draft.action) {
    case 'mailbox':
      return <Mailbox copy={copy} draft={draft} />

    case 'create_label':
      return (
        <dl className={GRID}>
          <Row label={copy.labels.name}>{draft.name}</Row>
        </dl>
      )

    default:
      return <Event copy={copy} draft={draft} locale={locale} timeZone={timeZone} />
  }
}

function useDigest(draft: MatrixGoogleWorkDraft): string | null | undefined {
  const [digest, setDigest] = useState<{ of: MatrixGoogleWorkDraft; value: string | null }>()

  useEffect(() => {
    let live = true

    void matrixGoogleWriteDigest(draft)
      .then(
        value => value,
        () => null
      )
      .then(value => {
        if (live) {
          setDigest({ of: draft, value })
        }
      })

    return () => {
      live = false
    }
  }, [draft])

  return digest?.of === draft ? digest.value : undefined
}

/**
 * One Google write proposal as a native card in its agent's chat (docs/google-write-confirmation.md).
 * It renders the draft, recomputes its digest and offers Approve and Decline only when that digest
 * is the proposal's. Once shown on screen in a focused window it reports delivery, once. Approve
 * confirms; the assistant then carries the request out, so the card never says it was sent.
 * Settled, it folds to one line naming the request and how it ended.
 */
export function MatrixGoogleWriteCard({
  proposal,
  source,
  standing,
  timeZone,
  onAnswered
}: {
  proposal: CardProposal
  /** `work`: the owner's own Work on this Mac asked, not an assistant. */
  source?: 'work'
  standing: MatrixGoogleWriteStanding
  /** The owner's time zone; the system's when absent. */
  timeZone?: string
  /** After Shell answered a decision (accepted or not), so the list can be read again. */
  onAnswered?: () => void
}) {
  const { locale } = useI18n()
  const copy = matrixGoogleWriteCardCopy(locale)
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const id = proposal.proposalId
  const local = useSyncExternalStore(subscribe, () => answers.get(id))
  const digest = useDigest(proposal.draft)
  const kind = matrixGoogleWorkKind(proposal.draft)
  const asked = question(proposal.draft, copy)
  const work = source === 'work'
  const surface = useRef<HTMLElement>(null)

  const accepted = local?.phase === 'answered' && local.state === 'ok' ? local.decision : undefined

  // Shell's acceptance first, then a request in flight; the list and Shell's refusal only ever
  // close a card. Nothing here reads as approved unless Shell said so.
  const view: MatrixGoogleWriteCardView = accepted
    ? accepted === 'approve' ? 'approved' : 'declined'
    : local?.phase === 'sending'
      ? local.decision === 'approve' ? 'approving' : 'declining'
      : standing !== 'open'
        ? standing
        : local?.phase === 'answered' && local.state === 'refused'
          ? 'closed'
          : digest === undefined
            ? 'checking'
            : digest !== proposal.digest
              ? 'changed'
              : 'pending'

  useNoticePresented(
    view === 'pending',
    () => {
      const send = window.atumMatrix?.googleConnections?.writeProposalAction

      // Once per proposal, and only for the draft this card verified and showed.
      if (!send || delivered.has(id) || digest !== proposal.digest) {
        return
      }

      delivered.add(id)
      void Promise.resolve()
        .then(() => send({ proposalId: id, digest, action: 'delivered' }))
        .catch(() => undefined)
    },
    surface
  )

  const decide = (decision: Decision) => {
    const current = answers.get(id)

    // One request at a time, none after Shell accepted one, and only for the draft this card rendered.
    if (view !== 'pending' || current?.phase === 'sending' || (current?.phase === 'answered' && current.state !== 'unavailable') ||
        digest !== proposal.digest) {
      return
    }

    const send = window.atumMatrix?.googleConnections?.writeProposalAction

    if (!send) {
      remember(id, { phase: 'answered', decision, state: 'unavailable' })

      return
    }

    remember(id, { phase: 'sending', decision })

    void Promise.resolve()
      .then(() => send({ proposalId: id, digest, action: decision }))
      .then(
        value => answerOf(value, decision),
        () => 'unavailable' as const
      )
      .then(state => {
        remember(id, { phase: 'answered', decision, state })

        if (state !== 'unavailable') {
          onAnswered?.()
        }
      })
  }

  const Icon = ICONS[kind]
  const open = view === 'checking' || view === 'pending' || view === 'approving' || view === 'declining'
  const sending = view === 'approving' || view === 'declining'

  if (!open) {
    const settled = view as Settled
    const line = work ? copy.work[settled === 'closed' ? 'expired' : settled] : copy[settled === 'expired' ? 'closed' : settled]

    return (
      <section
        aria-label={asked}
        className="grid max-w-[34rem] gap-1 rounded-(--atum-r-card) bg-(--atum-sunk) px-4 py-3"
        data-matrix-google-write={view}
        data-matrix-google-write-source={source}
      >
        <p className="flex min-w-0 items-center gap-2 text-sm text-(--atum-ink-soft)">
          <Icon aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{summary(proposal.draft, copy)}</span>
        </p>
        <p className="text-xs text-(--atum-ink-muted)" role="status">
          {line}
        </p>
      </section>
    )
  }

  return (
    <section
      aria-busy={sending || undefined}
      aria-label={asked}
      className="grid max-w-[34rem] gap-3 rounded-(--atum-r-card) bg-(--atum-card) p-4 shadow-(--atum-glass-edge)"
      data-matrix-google-write={view}
      data-matrix-google-write-source={source}
      ref={surface}
    >
      <div className="grid gap-0.5">
        <p className="flex min-w-0 items-center gap-2 font-medium text-(--atum-ink)">
          <Icon aria-hidden className="size-4 shrink-0" />
          <span>{asked}</span>
        </p>
        {work && <p className="ps-6 text-xs text-(--atum-ink-muted)">{copy.work.source}</p>}
      </div>
      <Draft copy={copy} draft={proposal.draft} locale={locale} timeZone={zone} />
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button disabled={view !== 'pending'} onClick={() => decide('approve')} size="sm" type="button">
          {view === 'approving' ? (
            <>
              <Spinner aria-hidden className="size-3.5 animate-spin" />
              {copy.approving}
            </>
          ) : (
            copy.approve
          )}
        </Button>
        <Button disabled={view !== 'pending'} onClick={() => decide('decline')} size="sm" type="button" variant="text">
          {view === 'declining' ? copy.declining : copy.decline}
        </Button>
      </div>
      {local?.phase === 'answered' && local.state === 'unavailable' && view === 'pending' && (
        <p className="text-xs text-(--atum-ink-muted)" role="status">
          {copy.retry}
        </p>
      )}
    </section>
  )
}

interface Shown {
  proposal: MatrixGoogleWriteProposal
  standing: MatrixGoogleWriteStanding
}

/** Settled cards kept in view (as one line each) until the chat is left. */
const SETTLED_KEPT = 3

/** The next cards for `roomId` from a fresh pending list, given the ones already shown. */
export function matrixGoogleWriteCards(
  previous: readonly Shown[],
  proposals: readonly MatrixGoogleWriteProposal[],
  roomId: string
): Shown[] {
  const current = proposals.filter(proposal => proposal.room === roomId)
  const listed = new Set(current.map(proposal => proposal.proposalId))
  const slots = new Set(current.map(matrixGoogleWriteSlot))

  // A card no longer listed is settled: replaced when its agent has a newer one here, else gone.
  const settled = previous
    .filter(shown => !listed.has(shown.proposal.proposalId))
    .map(shown =>
      shown.standing !== 'open'
        ? shown
        : { ...shown, standing: slots.has(matrixGoogleWriteSlot(shown.proposal)) ? ('superseded' as const) : ('closed' as const) }
    )
    .slice(-SETTLED_KEPT)

  const fresh = current.map(
    proposal =>
      previous.find(shown => shown.standing === 'open' && shown.proposal.proposalId === proposal.proposalId) ?? {
        proposal,
        standing: 'open' as const
      }
  )

  return [...settled, ...fresh]
}

/**
 * The agent chat's Google write cards, read from the owner's pending list (never from the room:
 * nothing about a proposal is posted there). The list is read when the chat opens, when the window
 * regains focus, whenever `activity` changes (a new event in this chat) and after Shell answers a
 * decision. A failed read keeps what is shown.
 */
export function MatrixGoogleWriteProposals({
  roomId,
  activity,
  timeZone,
  onWaiting
}: {
  roomId: string
  /** Changes with this chat's newest event. */
  activity?: string
  timeZone?: string
  /** Whether a card here waits on the owner. */
  onWaiting?: (waiting: boolean) => void
}) {
  const [shown, setShown] = useState<Shown[]>([])
  const reading = useRef<{ busy: boolean; again: boolean; live: boolean }>({ busy: false, again: false, live: true })
  // Re-read this window's answers whenever one changes.
  useSyncExternalStore(subscribe, () => version)

  const refresh = useCallback(() => {
    const list = window.atumMatrix?.googleConnections?.writeProposals
    const state = reading.current

    if (!list) {
      return
    }

    if (state.busy) {
      state.again = true

      return
    }

    state.busy = true
    void Promise.resolve()
      .then(() => list())
      .then(
        answer => answer,
        () => undefined
      )
      .then(answer => {
        state.busy = false

        if (!state.live) {
          return
        }

        if (answer?.state === 'ok' && Array.isArray(answer.proposals)) {
          setShown(previous => matrixGoogleWriteCards(previous, answer.proposals, roomId))
        }

        if (state.again) {
          state.again = false
          refresh()
        }
      })
  }, [roomId])

  useEffect(() => {
    const state = reading.current

    state.live = true

    return () => {
      state.live = false
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh, activity])

  useEffect(() => {
    window.addEventListener('focus', refresh)

    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  const waiting = shown.some(item => {
    const answer = answers.get(item.proposal.proposalId)

    return item.standing === 'open' && !(answer?.phase === 'answered' && answer.state !== 'unavailable')
  })

  useEffect(() => {
    onWaiting?.(waiting)
  }, [onWaiting, waiting])

  useEffect(() => () => onWaiting?.(false), [onWaiting])

  if (!shown.length) {
    return null
  }

  return (
    <div className="grid gap-2 px-4 pb-2" data-matrix-google-write-cards>
      {shown.map(item => (
        <MatrixGoogleWriteCard
          key={item.proposal.proposalId}
          onAnswered={refresh}
          proposal={item.proposal}
          standing={item.standing}
          timeZone={timeZone}
        />
      ))}
    </div>
  )
}

interface WorkShown {
  proposal: MatrixGoogleWorkProposal
  standing: MatrixGoogleWriteStanding
}

/** How often the Work page re-reads the owner list: Work's requests arrive with no chat event to follow. */
export const MATRIX_GOOGLE_WORK_POLL_MS = 5_000

/**
 * The next Work cards from a fresh list, given the ones already shown. Shell keeps one open Work
 * proposal per owner, so a card no longer listed was replaced when another is listed, and expired
 * otherwise. Only the latest settled card stays, as one line.
 */
export function matrixGoogleWorkWriteCards(
  previous: readonly WorkShown[],
  proposals: readonly MatrixGoogleWorkProposal[]
): WorkShown[] {
  const listed = new Set(proposals.map(proposal => proposal.proposalId))

  const settled = previous
    .filter(shown => !listed.has(shown.proposal.proposalId))
    .map(shown =>
      shown.standing !== 'open' ? shown : { ...shown, standing: proposals.length ? ('superseded' as const) : ('expired' as const) }
    )
    .slice(-1)

  const fresh = proposals.map(
    proposal =>
      previous.find(shown => shown.standing === 'open' && shown.proposal.proposalId === proposal.proposalId) ?? {
        proposal,
        standing: 'open' as const
      }
  )

  return [...settled, ...fresh]
}

/**
 * The Work page's Google write card: a change the owner's own Work on this Mac asked for, waiting
 * on the same owner approval as an assistant's (one rule: nothing is written to Google without the
 * owner's tap). It is read from the owner list, shown only when main read that list for `owner`
 * (the account on screen), and re-read on focus, on a short interval while the page is visible,
 * and after Shell answers a decision. A failed or foreign read keeps what is shown.
 */
export function MatrixGoogleWorkWriteProposals({
  owner,
  timeZone,
  pollMs = MATRIX_GOOGLE_WORK_POLL_MS
}: {
  /** The signed-in Matrix user this page belongs to. */
  owner: string
  timeZone?: string
  pollMs?: number
}) {
  const [shown, setShown] = useState<WorkShown[]>([])
  const reading = useRef<{ busy: boolean; again: boolean; live: boolean }>({ busy: false, again: false, live: true })
  const account = useRef(owner)

  account.current = owner
  useSyncExternalStore(subscribe, () => version)

  const refresh = useCallback(() => {
    const list = window.atumMatrix?.googleConnections?.writeProposals
    const state = reading.current

    if (!list) {
      return
    }

    if (state.busy) {
      state.again = true

      return
    }

    state.busy = true
    void Promise.resolve()
      .then(() => list())
      .then(
        answer => answer,
        () => undefined
      )
      .then(answer => {
        state.busy = false

        if (!state.live) {
          return
        }

        // Another account's list (or one that names no account) never draws a card here.
        if (answer?.state === 'ok' && answer.owner === owner && owner === account.current && Array.isArray(answer.work)) {
          const work = answer.work

          setShown(previous => matrixGoogleWorkWriteCards(previous, work))
        }

        if (state.again) {
          state.again = false
          refresh()
        }
      })
  }, [owner])

  useEffect(() => {
    const state = reading.current

    state.live = true

    return () => {
      state.live = false
    }
  }, [])

  // A card belongs to the account it was read for: another account starts with none.
  useEffect(() => {
    setShown([])
  }, [owner])

  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        refresh()
      }
    }, pollMs)

    return () => {
      window.removeEventListener('focus', refresh)
      window.clearInterval(timer)
    }
  }, [pollMs, refresh])

  if (!shown.length) {
    return null
  }

  return (
    <div className="grid max-h-[45vh] shrink-0 gap-2 overflow-y-auto px-4 pb-2" data-matrix-google-work-cards>
      {shown.map(item => (
        <MatrixGoogleWriteCard
          key={item.proposal.proposalId}
          onAnswered={refresh}
          proposal={item.proposal}
          source="work"
          standing={item.standing}
          timeZone={timeZone}
        />
      ))}
    </div>
  )
}
