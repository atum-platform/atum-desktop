import { type ComponentProps, useEffect, useState } from 'react'

import { useI18n } from '@/i18n'
import { ChevronRight } from '@/lib/icons'

import type { MatrixAgentView, MatrixMessage } from '../../../shared/matrix'
import { CompanyAIAvatar } from '../company-ai-status'
import { MatrixPersonAvatar } from '../member-avatar'
import { matrixAgo, matrixDayLabel, matrixNewDay } from '../message-time'
import { mobileChatCopy } from '../mobile-copy'
import { matrixThreadCopy } from '../thread-copy'

/** Kept as re-exports for the existing Team Space call sites. */
export const teamSpaceNewDay = matrixNewDay
export const teamSpaceDayLabel = matrixDayLabel

/** A line across the column with its words in a pill at the centre: the day, or where unread
 * starts. Colours live in styles.css (`.atum-divider`), so a chat's look can retint them. */
interface DividerLineProps extends ComponentProps<'div'> {
  flat: boolean
}

function DividerLine({ children, className, flat, ...props }: DividerLineProps) {
  return (
    <div
      className={`atum-divider relative flex h-7 items-center justify-center ${flat ? '-ms-[3.75rem] -me-5' : 'w-full'} ${className ?? ''}`}
      role="separator"
      {...props}
    >
      <span aria-hidden className="atum-divider-line absolute inset-x-0 top-1/2 h-px" />
      {children}
    </div>
  )
}

const dividerPill = 'atum-divider-pill relative rounded-full px-3 py-0.5 text-xs font-semibold'

/** Slack's day line: a hairline across the column with the day in a pill at its centre. When the
 * first unread message is also the day's first, the unread line joins it: one line, the day pill
 * and the "New messages" pill side by side at the centre, never two stacked lines (owner
 * 2026-11-07). The line then takes the unread line's emphasis; the day pill keeps its own look. */
export function TeamSpaceDayDivider({
  flat = true,
  onJumpToNew,
  timestamp
}: {
  flat?: boolean
  /** Set when the first unread message starts this day: the unread pill joins the day line. */
  onJumpToNew?: () => void
  timestamp: number
}) {
  const { locale } = useI18n()
  const label = teamSpaceDayLabel(timestamp, locale)

  if (!onJumpToNew) {
    return (
      <DividerLine aria-label={label} className="mt-2 mb-1" data-team-space-day flat={flat}>
        <span aria-hidden className={dividerPill}>
          {label}
        </span>
      </DividerLine>
    )
  }

  const newLabel = mobileChatCopy[locale].readMarker

  return (
    <DividerLine
      aria-label={`${label}, ${newLabel}`}
      className="mt-2 mb-1 gap-2"
      data-divider-emphasis
      data-team-space-day
      data-team-space-new-messages
      flat={flat}
    >
      <span aria-hidden className={dividerPill} data-divider-plain>
        {label}
      </span>
      <button className={dividerPill} onClick={onJumpToNew} type="button">
        {newLabel}
      </button>
    </DividerLine>
  )
}

/** The first still-loaded message covered by the room's unread count. Matrix
 * owns the count; the renderer only places the divider among the messages it
 * can actually show. */
export function teamSpaceFirstUnreadMessageId(
  messages: readonly MatrixMessage[],
  unreadCount: number
): string | undefined {
  if (!Number.isFinite(unreadCount) || unreadCount <= 0) {
    return undefined
  }

  const received = messages.filter(message => !message.own && !message.thread)
  const offset = Math.max(0, received.length - Math.floor(unreadCount))

  return received[offset]?.id
}

/** The unread line: the day line's shape, centred, in the stronger ink. Its pill doubles as the
 * jump target without adding another floating control to the transcript. */
export function TeamSpaceNewMessagesDivider({ flat = true, onJump }: { flat?: boolean; onJump(): void }) {
  const { locale } = useI18n()
  const label = mobileChatCopy[locale].readMarker

  return (
    <DividerLine aria-label={label} className="my-1" data-divider-emphasis data-team-space-new-messages flat={flat}>
      <button className={dividerPill} onClick={onJump} type="button">
        {label}
      </button>
    </DividerLine>
  )
}

/** Under a thread's first message in the thread panel: how many replies follow, then a hairline. */
export function TeamSpaceRepliesDivider({ count }: { count: number }) {
  const { locale } = useI18n()

  return (
    <div className="-me-5 mt-2 flex items-center gap-3 text-xs text-(--atum-ink-muted)" data-team-space-replies-divider>
      <span className="shrink-0">{matrixThreadCopy(locale).replies(count)}</span>
      <span aria-hidden className="h-px flex-1 bg-(--atum-line)" />
    </div>
  )
}

export interface ThreadSummaryFace {
  id: string
  name: string
  avatarMxc?: string | null
  /** One of the owner's own agents wears its roster face. */
  agent?: MatrixAgentView
  /** The company's Chief of Staff wears the same face as on its channel rows. */
  companyAIPrincipal?: string
}

/** Slack shows up to five repliers' faces on the line. */
export const THREAD_SUMMARY_FACES_MAX = 5

/** The relative "Last reply …" moves on once a minute while the line is on screen. */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)

    return () => clearInterval(timer)
  }, [])

  return now
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function TeamSpaceThreadSummary({ faces, lastReplyAt, messageId, onOpen, replyCount, unread }: {
  faces: readonly ThreadSummaryFace[]
  lastReplyAt?: number
  messageId: string
  onOpen(): void
  replyCount: number
  unread: boolean
}) {
  const { locale } = useI18n()
  const copy = matrixThreadCopy(locale)
  const now = useMinuteNow()
  const when = lastReplyAt !== undefined && Number.isFinite(lastReplyAt) ? matrixAgo(lastReplyAt, locale, now) : undefined
  const shown = faces.slice(0, THREAD_SUMMARY_FACES_MAX)

  return (
    <button
      aria-label={[copy.replies(replyCount), unread ? copy.unread : undefined, when ? copy.lastReply(when) : undefined]
        .filter(Boolean)
        .join(', ')}
      className="group/thread-line -ms-1 flex w-full max-w-[36rem] min-w-0 items-center gap-(--ak-s2) rounded-(--ak-r-md) border border-transparent p-1 pe-(--ak-s2) text-start [font:var(--ak-t-body)] transition-colors duration-(--ak-dur-1) hover:border-(--ak-line) hover:bg-(--ak-surface) focus-visible:border-(--ak-line) focus-visible:bg-(--ak-surface) focus-visible:outline-2 focus-visible:outline-(--ak-focus)"
      data-matrix-thread-summary={messageId}
      data-thread-unread={unread || undefined}
      onClick={onOpen}
      type="button"
    >
      {shown.length > 0 && (
        <span aria-hidden className="flex shrink-0 gap-1" data-thread-summary-faces>
          {shown.map(face =>
            face.companyAIPrincipal ? (
              <CompanyAIAvatar
                className="size-6 shrink-0 text-[0.625rem] leading-none"
                key={face.id}
                name={face.name}
                principal={face.companyAIPrincipal}
              />
            ) : (
              <MatrixPersonAvatar
                agent={face.agent}
                avatarMxc={face.avatarMxc}
                className="size-6 shrink-0 text-[0.625rem] leading-none"
                id={face.id}
                key={face.id}
                name={face.name}
                presence={false}
              />
            )
          )}
        </span>
      )}
      <span className="shrink-0 font-semibold text-(--ak-ink) group-hover/thread-line:underline" data-thread-summary-count>
        {copy.replies(replyCount)}
      </span>
      {unread && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-(--ak-ink)" data-team-space-thread-unread />}
      {when && (
        <span
          className="min-w-0 truncate text-(--ak-ink-3) group-hover/thread-line:hidden group-focus-visible/thread-line:hidden"
          data-team-space-last-reply
        >
          {copy.lastReply(when)}
        </span>
      )}
      <span
        className={`min-w-0 truncate text-(--ak-ink-3) group-hover/thread-line:inline group-focus-visible/thread-line:inline ${when ? 'hidden' : ''}`}
        data-team-space-view-thread
      >
        {copy.viewThread}
      </span>
      <ChevronRight
        aria-hidden
        className="ak-icon ak-icon--sm ms-auto shrink-0 text-(--ak-ink-3) opacity-0 group-hover/thread-line:opacity-100 group-focus-visible/thread-line:opacity-100"
      />
    </button>
  )
}
