import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { type Locale, useI18n } from '@/i18n'
import { Calendar, FileText, type IconComponent, Mail } from '@/lib/icons'

import {
  type MatrixGoogleWriteAnswer,
  type MatrixGoogleWriteDecision,
  matrixGoogleWriteDigest,
  type MatrixGoogleWriteDraft,
  type MatrixGoogleWriteEventFields,
  type MatrixGoogleWriteProposal,
  type MatrixGoogleWriteStanding,
  type MatrixGoogleWriteWhen
} from '../../shared/matrix-google-write-proposal'

import { matrixGoogleWriteCardCopy, type MatrixGoogleWriteCardCopy } from './google-write-card-copy'

type Kind = keyof MatrixGoogleWriteCardCopy['done']

/** What the card shows. Only `pending` offers the two actions. */
export type MatrixGoogleWriteCardView =
  | 'checking'
  | 'pending'
  | 'approving'
  | 'declining'
  | Exclude<MatrixGoogleWriteAnswer, 'retry'>

type Local = { phase: 'sending'; decision: MatrixGoogleWriteDecision } | { phase: 'answered'; answer: MatrixGoogleWriteAnswer }

const ANSWERS = new Set<string>(['done', 'approved', 'declined', 'superseded', 'expired', 'changed', 'answered', 'failed', 'retry'])

/**
 * This window's own answers, by proposal: a card that scrolls out of view and back, or a second
 * card for the same proposal, reads the same answer, and a decision already in flight is never
 * sent again (one request per press, however fast the presses).
 */
const answers = new Map<string, Local>()
const listeners = new Set<() => void>()

function remember(proposalId: string, local: Local) {
  answers.set(proposalId, local)

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

/** Test seam: forget this window's answers. */
export function resetMatrixGoogleWriteAnswers() {
  answers.clear()
}

function kindOf(draft: MatrixGoogleWriteDraft): Kind {
  return draft.kind === 'drive_change' ? (draft.action === 'create' ? 'drive_create' : 'drive_update') : draft.kind
}

const ICONS: Record<Kind, IconComponent> = {
  send_email: Mail,
  create_event: Calendar,
  update_event: Calendar,
  drive_create: FileText,
  drive_update: FileText
}

/** The one line that names what a settled card was about. */
function summary(draft: MatrixGoogleWriteDraft): string {
  switch (draft.kind) {
    case 'send_email':
      return draft.subject || draft.to.join(', ')
    case 'create_event':
      return draft.event.title
    case 'update_event':
      return draft.next.title
    case 'drive_change':
      return draft.name
  }
}

const DAY_MS = 86_400_000

/**
 * An instant in the owner's time zone; an all-day date as that calendar date. Google's all-day end
 * is the day after the last one, so the end shows the last day itself.
 */
function shownWhen(value: MatrixGoogleWriteWhen, locale: Locale, timeZone: string, copy: MatrixGoogleWriteCardCopy, end = false) {
  if ('date' in value) {
    const day = Date.parse(`${value.date}T00:00:00Z`) - (end ? DAY_MS : 0)

    return `${new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(day)} · ${copy.labels.allDay}`
  }

  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(Date.parse(value.dateTime))
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-(--atum-ink-muted)">{label}</dt>
      <dd className="min-w-0 break-words text-(--atum-ink)">{children}</dd>
    </>
  )
}

function Text({ value }: { value: string }) {
  // Exactly as written: line breaks kept, never markdown, long text scrolls inside the card.
  return (
    <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm text-(--atum-ink)" data-matrix-google-write-text>
      {value}
    </div>
  )
}

function eventZones(fields: MatrixGoogleWriteEventFields, timeZone: string): string | undefined {
  const zones = [fields.start, fields.end].flatMap(when => ('timeZone' in when && when.timeZone !== timeZone ? [when.timeZone] : []))

  return zones.length ? [...new Set(zones)].join(', ') : undefined
}

function EventRows({ fields, locale, timeZone, copy }: { fields: MatrixGoogleWriteEventFields; locale: Locale; timeZone: string; copy: MatrixGoogleWriteCardCopy }) {
  const zones = eventZones(fields, timeZone)

  return (
    <>
      <Row label={copy.labels.title}>{fields.title}</Row>
      <Row label={copy.labels.start}>{shownWhen(fields.start, locale, timeZone, copy)}</Row>
      <Row label={copy.labels.end}>{shownWhen(fields.end, locale, timeZone, copy, true)}</Row>
      {zones && <Row label={copy.labels.timeZone}>{zones}</Row>}
      {fields.location && <Row label={copy.labels.location}>{fields.location}</Row>}
      {fields.attendees.length > 0 && <Row label={copy.labels.guests}>{fields.attendees.join(', ')}</Row>}
    </>
  )
}

function sameWhen(left: MatrixGoogleWriteWhen, right: MatrixGoogleWriteWhen) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function Draft({ draft, locale, timeZone, copy }: { draft: MatrixGoogleWriteDraft; locale: Locale; timeZone: string; copy: MatrixGoogleWriteCardCopy }) {
  const labels = copy.labels
  const grid = 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm'

  if (draft.kind === 'send_email') {
    return (
      <>
        <dl className={grid}>
          <Row label={labels.from}>{draft.from}</Row>
          <Row label={labels.to}>{draft.to.join(', ')}</Row>
          {draft.cc.length > 0 && <Row label={labels.cc}>{draft.cc.join(', ')}</Row>}
          {draft.bcc.length > 0 && <Row label={labels.bcc}>{draft.bcc.join(', ')}</Row>}
          <Row label={labels.subject}>{draft.subject}</Row>
          {draft.attachments.length > 0 && (
            <Row label={labels.attachments}>{draft.attachments.map(file => file.name).join(', ')}</Row>
          )}
        </dl>
        {draft.inReplyTo && <p className="text-xs text-(--atum-ink-muted)">{labels.inReplyTo}</p>}
        <Text value={draft.body} />
      </>
    )
  }

  if (draft.kind === 'create_event') {
    return (
      <>
        <dl className={grid}>
          <Row label={labels.calendar}>{draft.calendar}</Row>
          <EventRows copy={copy} fields={draft.event} locale={locale} timeZone={timeZone} />
        </dl>
        {draft.event.notes && <Text value={draft.event.notes} />}
      </>
    )
  }

  if (draft.kind === 'update_event') {
    const { current, next } = draft
    const change = (label: string, before: string, after: string) => (
      <Row label={label}>
        <span className="block text-(--atum-ink-muted)">
          {labels.current} {before}
        </span>
        <span className="block">
          {labels.after} {after}
        </span>
      </Row>
    )

    return (
      <dl className={grid}>
        <Row label={labels.calendar}>{draft.calendar}</Row>
        {current.title === next.title ? <Row label={labels.title}>{next.title}</Row> : change(labels.title, current.title, next.title)}
        {!sameWhen(current.start, next.start) &&
          change(labels.start, shownWhen(current.start, locale, timeZone, copy), shownWhen(next.start, locale, timeZone, copy))}
        {!sameWhen(current.end, next.end) &&
          change(labels.end, shownWhen(current.end, locale, timeZone, copy, true), shownWhen(next.end, locale, timeZone, copy, true))}
        {(eventZones(current, timeZone) ?? '') !== (eventZones(next, timeZone) ?? '') &&
          change(labels.timeZone, eventZones(current, timeZone) ?? timeZone, eventZones(next, timeZone) ?? timeZone)}
        {current.location !== next.location && change(labels.location, current.location, next.location)}
        {current.attendees.join(', ') !== next.attendees.join(', ') &&
          change(labels.guests, current.attendees.join(', '), next.attendees.join(', '))}
        {current.notes !== next.notes && change(labels.notes, current.notes, next.notes)}
      </dl>
    )
  }

  return (
    <>
      <dl className={grid}>
        <Row label={labels.file}>{draft.name}</Row>
        {draft.folder && <Row label={labels.folder}>{draft.folder}</Row>}
      </dl>
      <Text value={draft.content} />
    </>
  )
}

function useNow(until: number, now: () => number): boolean {
  const [passed, setPassed] = useState(() => now() >= until)

  useEffect(() => {
    if (passed) {
      return
    }

    // Timers cap near 24.8 days; a later expiry is checked again when that one fires.
    const timer = setTimeout(() => setPassed(now() >= until), Math.min(Math.max(until - now(), 0), 2_147_483_647))

    return () => clearTimeout(timer)
  }, [passed, until, now])

  return passed
}

function useDigest(draft: MatrixGoogleWriteDraft): string | null | undefined {
  const [digest, setDigest] = useState<{ of: MatrixGoogleWriteDraft; value: string | null }>()

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
 * The owner's Google write confirmation in the agent's chat (docs/google-write-confirmation.md).
 * It renders the proposal's whole draft, offers one primary action and Decline, and sends Shell the
 * digest of the draft it rendered; a draft whose digest is not the proposal's is never offered.
 * Settled, it folds to one line naming the request and how it ended.
 */
export function MatrixGoogleWriteCard({
  proposal,
  standing,
  timeZone,
  now = Date.now
}: {
  proposal: MatrixGoogleWriteProposal
  standing: MatrixGoogleWriteStanding
  /** The owner's time zone; the system's when absent. */
  timeZone?: string
  now?: () => number
}) {
  const { locale } = useI18n()
  const copy = matrixGoogleWriteCardCopy(locale)
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const id = proposal.proposalId
  const local = useSyncExternalStore(subscribe, () => answers.get(id))
  const expired = useNow(proposal.expiresAt, now)
  const digest = useDigest(proposal.draft)
  const kind = kindOf(proposal.draft)

  const answer = local?.phase === 'answered' && local.answer !== 'retry' ? local.answer : undefined

  // The agent's outcome first, then this window's answer; a newer card, the clock and the
  // digest only ever close a card. Nothing here reads as approved unless Shell said so.
  const view: MatrixGoogleWriteCardView =
    standing !== 'open' && standing !== 'superseded'
      ? standing
      : answer
        ? answer
        : local?.phase === 'sending'
          ? local.decision === 'approve' ? 'approving' : 'declining'
          : standing === 'superseded'
            ? 'superseded'
            : expired
              ? 'expired'
              : digest === undefined
                ? 'checking'
                : digest !== proposal.digest
                  ? 'changed'
                  : 'pending'

  const decide = (decision: MatrixGoogleWriteDecision) => {
    // One request per proposal at a time, and only for the draft this card rendered.
    if (view !== 'pending' || answers.get(id)?.phase === 'sending' || digest !== proposal.digest) {
      return
    }

    const send = window.atumMatrix?.googleConnections?.decideWrite

    if (!send) {
      remember(id, { phase: 'answered', answer: 'retry' })

      return
    }

    remember(id, { phase: 'sending', decision })

    void Promise.resolve()
      .then(() => send({ proposalId: id, digest, decision }))
      .then(
        value => (typeof value === 'string' && ANSWERS.has(value) ? value : 'retry'),
        () => 'retry' as const
      )
      .then(value => {
        // An approval's answers never close a Decline, nor the reverse.
        const fits =
          decision === 'approve' ? value !== 'declined' : value !== 'done' && value !== 'approved' && value !== 'failed'

        remember(id, { phase: 'answered', answer: fits ? value : 'retry' })
      })
  }

  const Icon = ICONS[kind]
  const open = view === 'checking' || view === 'pending' || view === 'approving' || view === 'declining'
  const sending = view === 'approving' || view === 'declining'

  if (!open) {
    const line =
      view === 'done'
        ? copy.done[kind]
        : view === 'approved'
          ? copy.approved
          : view === 'declined'
            ? copy.declined
            : view === 'superseded'
              ? copy.superseded
              : view === 'expired'
                ? copy.expired
                : view === 'changed'
                  ? copy.changed
                  : view === 'answered'
                    ? copy.answered
                    : copy.failed

    return (
      <section
        aria-label={copy.question[kind]}
        className="grid max-w-[34rem] gap-1 rounded-(--atum-r-card) bg-(--atum-sunk) px-4 py-3"
        data-matrix-google-write={view}
      >
        <p className="flex min-w-0 items-center gap-2 text-sm text-(--atum-ink-soft)">
          <Icon aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{summary(proposal.draft)}</span>
        </p>
        <p className={`text-xs ${view === 'failed' ? 'text-(--atum-danger)' : 'text-(--atum-ink-muted)'}`} role="status">
          {line}
        </p>
      </section>
    )
  }

  return (
    <section
      aria-busy={sending || undefined}
      aria-label={copy.question[kind]}
      className="grid max-w-[34rem] gap-3 rounded-(--atum-r-card) bg-(--atum-card) p-4 shadow-(--atum-glass-edge)"
      data-matrix-google-write={view}
    >
      <p className="flex min-w-0 items-center gap-2 font-medium text-(--atum-ink)">
        <Icon aria-hidden className="size-4 shrink-0" />
        <span>{copy.question[kind]}</span>
      </p>
      <Draft copy={copy} draft={proposal.draft} locale={locale} timeZone={zone} />
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button disabled={view !== 'pending'} onClick={() => decide('approve')} size="sm" type="button">
          {view === 'approving' ? (
            <>
              <Spinner aria-hidden className="size-3.5 animate-spin" />
              {copy.approving}
            </>
          ) : (
            copy.approve[kind]
          )}
        </Button>
        <Button disabled={view !== 'pending'} onClick={() => decide('decline')} size="sm" type="button" variant="text">
          {view === 'declining' ? copy.declining : copy.decline}
        </Button>
      </div>
      {local?.phase === 'answered' && local.answer === 'retry' && view === 'pending' && (
        <p className="text-xs text-(--atum-ink-muted)" role="status">
          {copy.retry}
        </p>
      )}
    </section>
  )
}
