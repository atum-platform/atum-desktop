import { useEffect, useState } from 'react'

import { MarkdownContent } from '@/components/assistant-ui/markdown-surface'
import { ProtonMark } from '@/components/brand/proton-mark'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Brain, Calendar, FileText, type IconComponent, Mail, X } from '@/lib/icons'

import type { MatrixIdentity, MatrixSnapshot } from '../../shared/matrix'
import {
  type MatrixCheckInChange,
  matrixCheckInCost,
  type MatrixCheckInFeedbackChange,
  type MatrixCheckInNudge,
  matrixCheckInsAsking,
  matrixCheckInSnoozeUntil,
  type MatrixCheckInsSnapshot
} from '../../shared/matrix-check-ins'

import { matrixCheckInClock, matrixCheckInProtons, matrixCheckInsCopy, matrixCheckInTime } from './check-ins-copy'
import { MATRIX_MARKDOWN_HOST } from './markdown-host'

const SOURCE_ICONS: Record<MatrixCheckInNudge['source'], IconComponent> = {
  files: FileText,
  memory: Brain,
  calendar: Calendar,
  mail: Mail
}

/** The owner's choice, through main to their own SDK (validated there again). */
export function changeMatrixCheckIns(identity: MatrixIdentity, change: MatrixCheckInChange) {
  return window.atumMatrix.command({ kind: 'checkInsChange', identity, change })
}

/** The owner's answer to a check-in. */
export function answerMatrixCheckIn(identity: MatrixIdentity, feedback: MatrixCheckInFeedbackChange) {
  return window.atumMatrix.command({ kind: 'checkInsFeedback', identity, feedback })
}

/** The owner's records and identity for a card inside the transcript, which has no snapshot
 * of its own to read: the window's own snapshot stream, kept to these two fields. */
function useMatrixCheckIns(): { checkIns?: MatrixCheckInsSnapshot; identity?: MatrixIdentity } {
  const [view, setView] = useState<{ checkIns?: MatrixCheckInsSnapshot; identity?: MatrixIdentity }>({})

  useEffect(() => {
    let live = true

    const take = (snapshot: MatrixSnapshot) =>
      live && setView({ checkIns: snapshot.checkIns, identity: snapshot.identity ?? undefined })

    void window.atumMatrix
      .snapshot()
      .then(take)
      .catch(() => {})

    const unsubscribe = window.atumMatrix.subscribe(take)

    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return view
}

/**
 * A check-in in the assistant's chat (DESIGN.md "Check-ins"): its one line, then one offer
 * as a button, where it came from, and two quiet answers, "Less like this" and "Snooze".
 * The offer sends the owner's own message to the assistant, so whatever happens next is a
 * turn the owner started; the check-in itself never acted.
 */
export function MatrixCheckInCard({
  nudge,
  onAct,
  postedAt
}: {
  nudge: MatrixCheckInNudge
  /** Sends the offer as the owner's message; absent while the assistant cannot answer. */
  onAct?: (text: string) => void
  /** When this post arrived: a snooze due before it is the one that brought it back. */
  postedAt?: number
}) {
  const { locale } = useI18n()
  const copy = matrixCheckInsCopy[locale]
  const { checkIns, identity } = useMatrixCheckIns()
  const [answered, setAnswered] = useState<'less' | { snoozed: number } | null>(null)
  const [failed, setFailed] = useState(false)

  // Snoozed from this post (or another post of the same item), not yet back; the post a
  // snooze brought back offers its buttons again.
  const snoozed =
    (answered && answered !== 'less' ? answered.snoozed : undefined) ??
    checkIns?.feedback.snoozed.find(item => item.key === nudge.key && (postedAt === undefined || item.until > postedAt))
      ?.until

  const less =
    answered === 'less' ||
    (nudge.kind === 'brief'
      ? checkIns?.settings.brief === null
      : Boolean(checkIns?.feedback.muted.includes(nudge.kind)))

  const canAnswer = Boolean(identity && checkIns?.writable)

  const answer = (run: () => Promise<unknown>, next: typeof answered) => {
    setFailed(false)
    void run()
      .then(() => setAnswered(next))
      .catch(() => setFailed(true))
  }

  const done = less ? copy.lessDone : snoozed ? copy.snoozed(matrixCheckInClock(snoozed, locale)) : null

  const SourceIcon = SOURCE_ICONS[nudge.source]

  // The line, where it came from (a quiet caption), then the offer and the two quiet answers.
  return (
    <div aria-label={copy.cardLabel} className="grid gap-1.5" data-matrix-check-in={nudge.kind} role="group">
      <MarkdownContent host={MATRIX_MARKDOWN_HOST} isRunning={false} text={nudge.text} />
      <p className="flex min-w-0 items-center gap-1.5 text-xs text-(--atum-ink-faint)" data-matrix-check-in-source>
        <SourceIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {copy.sources[nudge.source]}
          {nudge.ref ? ` · ${nudge.ref}` : ''}
        </span>
      </p>
      {done ? (
        <p className="pt-0.5 text-xs text-(--atum-ink-muted)" role="status">
          {done}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Button
            disabled={!onAct}
            onClick={() => onAct?.(copy.request[nudge.action](nudge.text))}
            size="sm"
            variant="secondary"
          >
            {copy.actions[nudge.action]}
          </Button>
          <Button
            disabled={!canAnswer}
            onClick={() =>
              identity &&
              answer(
                // A brief that is not wanted is the morning brief turned off (Settings shows it).
                () =>
                  nudge.kind === 'brief'
                    ? changeMatrixCheckIns(identity, { field: 'brief', value: null })
                    : answerMatrixCheckIn(identity, { kind: 'less', nudge: nudge.kind }),
                'less'
              )
            }
            size="sm"
            variant="text"
          >
            {copy.less}
          </Button>
          <Button
            disabled={!canAnswer}
            onClick={() => {
              if (!identity || !checkIns) {
                return
              }

              const until = matrixCheckInSnoozeUntil(new Date(), checkIns.settings)
              answer(() => answerMatrixCheckIn(identity, { kind: 'snooze', nudge, until }), { snoozed: until })
            }}
            size="sm"
            variant="text"
          >
            {copy.snooze}
          </Button>
        </div>
      )}
      {failed && (
        <p className="text-xs text-(--atum-danger)" role="status">
          {copy.failed}
        </p>
      )}
    </div>
  )
}

type Notice = 'asking' | 'off' | 'intro'

/** Which line the assistant's chat shows about check-ins, if any. */
export function matrixCheckInsNotice(checkIns: MatrixCheckInsSnapshot | undefined, now: number): Notice | null {
  if (!checkIns?.writable) {
    return null
  }

  const { settings } = checkIns

  if (settings.enabled && matrixCheckInsAsking(checkIns)) {
    return 'asking'
  }

  // Turned off by asking: said once, for the day it happened.
  if (
    !settings.enabled &&
    settings.offBy === 'asked' &&
    settings.offAt !== undefined &&
    now - settings.offAt < 24 * 60 * 60_000
  ) {
    return 'off'
  }

  if (settings.enabled && settings.introducedAt === undefined) {
    return 'intro'
  }

  return null
}

/**
 * Above the assistant's message box, in the transcript's column (like its questions): the
 * one-line first mention of check-ins with their cost, "Keep these coming?" after unanswered
 * ones, and a confirmation after "stop checking in". One at a time, each with its one action.
 */
export function MatrixCheckInsNotice({
  snapshot,
  onOpenSettings,
  introReady = true
}: {
  snapshot: MatrixSnapshot
  /** The assistant's card, where check-ins are changed. */
  onOpenSettings?: () => void
  /** The first mention waits for this (the assistant is up and has spoken in the chat). */
  introReady?: boolean
}) {
  const { locale } = useI18n()
  const copy = matrixCheckInsCopy[locale]
  const identity = snapshot.identity
  const checkIns = snapshot.checkIns
  const [now] = useState(() => Date.now())
  const [hidden, setHidden] = useState<Notice | null>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const notice = matrixCheckInsNotice(checkIns, now)

  if (!identity || !checkIns || !notice || notice === hidden || (notice === 'intro' && !introReady)) {
    return null
  }

  const run = (work: () => Promise<unknown>, hide = true) => {
    setPending(true)
    setFailed(false)
    void work()
      .then(() => hide && setHidden(notice))
      .catch(() => setFailed(true))
      .finally(() => setPending(false))
  }

  const cost = matrixCheckInCost()
  const perDay = matrixCheckInProtons(cost.perDay, locale)
  const atMost = matrixCheckInProtons(cost.atMost, locale)
  const introduced = () => changeMatrixCheckIns(identity, { field: 'introduced' })

  const dismiss = (
    <Tip label={copy.introDismiss}>
      <Button
        aria-label={copy.introDismiss}
        disabled={pending}
        onClick={() => (notice === 'intro' ? run(introduced) : setHidden(notice))}
        size="icon-xs"
        variant="ghost"
      >
        <X />
      </Button>
    </Tip>
  )

  // In the transcript's column, above the message box, like the assistant's questions.
  return (
    <div className="mx-auto grid w-[min(var(--composer-width),calc(100%-2rem))] shrink-0 pt-2">
      <section
        aria-label={copy.title}
        className="atum-glass-card grid gap-2 px-4 py-3"
        data-matrix-check-ins-notice={notice}
      >
        {notice === 'asking' && (
          <>
            <div>
              <p className="text-sm font-medium">{copy.askTitle}</p>
              <p className="text-xs text-(--atum-ink-muted)">{copy.askHelp}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={pending}
                onClick={() => run(() => answerMatrixCheckIn(identity, { kind: 'ack' }))}
                size="sm"
              >
                {copy.askKeep}
              </Button>
              <Button
                disabled={pending}
                onClick={() =>
                  run(() => changeMatrixCheckIns(identity, { field: 'enabled', value: false, by: 'paused' }))
                }
                size="sm"
                variant="text"
              >
                {copy.askOff}
              </Button>
            </div>
          </>
        )}
        {notice === 'off' && (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-sm text-(--atum-ink-soft)">{copy.offNotice}</p>
            <Button
              disabled={pending}
              onClick={() => run(() => changeMatrixCheckIns(identity, { field: 'enabled', value: true }))}
              size="sm"
              variant="secondary"
            >
              {copy.turnOn}
            </Button>
            {dismiss}
          </div>
        )}
        {notice === 'intro' && (
          <>
            <div className="flex items-start gap-2">
              <div className="grid min-w-0 flex-1 gap-1">
                <p className="text-sm text-(--atum-ink-soft)">
                  {copy.intro(checkIns.settings.brief ? matrixCheckInTime(checkIns.settings.brief, locale) : null)}
                </p>
                {snapshot.ownModel ? (
                  <p className="text-xs text-(--atum-ink-muted)" data-matrix-check-ins-model>
                    {copy.ownModel}
                  </p>
                ) : (
                  <p className="flex items-center gap-1.5 text-xs text-(--atum-ink-muted)" data-matrix-check-ins-cost>
                    <ProtonMark aria-hidden className="size-3 shrink-0" />
                    {copy.cost(perDay, atMost)}
                  </p>
                )}
              </div>
              {dismiss}
            </div>
            <div className="flex flex-wrap gap-2">
              {onOpenSettings && (
                <Button
                  disabled={pending}
                  onClick={() => {
                    onOpenSettings()
                    run(introduced)
                  }}
                  size="sm"
                  variant="secondary"
                >
                  {copy.introChange}
                </Button>
              )}
              <Button
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    await changeMatrixCheckIns(identity, { field: 'enabled', value: false, by: 'settings' })
                    await introduced()
                  })
                }
                size="sm"
                variant="text"
              >
                {copy.introOff}
              </Button>
            </div>
          </>
        )}
        {failed && (
          <p className="text-xs text-(--atum-danger)" role="status">
            {copy.failed}
          </p>
        )}
      </section>
    </div>
  )
}
