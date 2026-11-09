import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useMemo, useRef } from 'react'

import { useI18n } from '@/i18n'
import { $atumAppCatalog, appDisplayName, type DesktopAppCatalogEntry } from '@/lib/atum-app-catalog'
import type { AtumMessagingMessage } from '@/lib/atum-messaging-client'

import type { AdvisoryAdvisor, GroupMember, GroupMembershipEvent, GroupSpecialist } from '../../../shared/atum-group-conversations'
import type { ParticipantDisplay } from '../../../shared/atum-participants'
import { AtumAssistantAvatar } from '../atum/assistant-avatar'

import { DmMessageBubble } from './dm-message-bubble'
import { parseDmMetadata } from './dm-metadata'
import { GroupParticipantIdentity } from './group-participant-identity'

export interface DmMessageListProps {
  accountId: string | null
  emptyContent: ReactNode
  messages: AtumMessagingMessage[]
  retryLabel: string
  onRetry: (clientMessageId: string) => void
  onLoadOlder: () => void
  olderState: 'idle' | 'loading' | 'exhausted' | 'error'
  membershipEvents?: readonly GroupMembershipEvent[]
  groupMembers?: readonly GroupMember[]
  groupSpecialists?: readonly GroupSpecialist[]
  groupAdvisors?: readonly AdvisoryAdvisor[]
  immutable?: boolean
  onReport?: (messageId: string) => void
  onQuote?: (message: AtumMessagingMessage) => void
  quoteEnabled?: boolean
  quoteLimit?: number
  onReply?: (message: AtumMessagingMessage) => void
  onReact?: (messageId: string, emoji: string) => void
  onEdit?: (messageId: string, content: string) => void
  onRecall?: (messageId: string) => void
  readMessageId?: string | null
  onJumpToMessage?: (messageId: string) => void
}

type TimelineEntry =
  | { createdAt: string; id: string; kind: 'event'; event: GroupMembershipEvent }
  | { createdAt: string; id: string; kind: 'message'; message: AtumMessagingMessage }

function dayKey(date: string): string {
  return date.slice(0, 10)
}

function compareTimelineEntries(left: TimelineEntry, right: TimelineEntry): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
}

function personLabel(member: Pick<GroupMember, 'displayName' | 'handle'>): string {
  return member.handle ? `${member.displayName} (@${member.handle})` : member.displayName
}

function eventMemberLabel(
  event: GroupMembershipEvent,
  userId: string | null,
  members: readonly GroupMember[],
  fallback: string
): string {
  const member = userId ? members.find(candidate => candidate.userId === userId) : null

  if (member) {
    return personLabel(member)
  }

  const displayName = event.identitySnapshot.displayName?.trim()
  const handle = event.identitySnapshot.handle?.trim()

  if (displayName) {
    return handle ? `${displayName} (@${handle})` : displayName
  }

  return fallback
}

function eventCopy(
  event: GroupMembershipEvent,
  members: readonly GroupMember[],
  copy: ReturnType<typeof useI18n>['t']['dm']['group']['events']
): string {
  const actor = eventMemberLabel(event, event.actorUserId, members, copy.member)

  const subject = event.specialist
    ? event.identitySnapshot.displayName?.trim() || event.specialist
    : eventMemberLabel(event, event.subjectUserId, members, copy.formerMember)

  switch (event.kind) {
    case 'created':
      return copy.created(actor)

    case 'member_added':
      return copy.memberAdded(actor, subject)

    case 'member_removed':
      return copy.memberRemoved(actor, subject)

    case 'member_left':
      return copy.memberLeft(subject)

    case 'owner_transferred':
      return copy.ownerTransferred(actor, subject)

    case 'renamed':
      return copy.renamed(actor)

    case 'retired':
      return copy.retired(actor)

    case 'account_deleted':
      return copy.accountDeleted(subject)
  }
}

function sameIdentity(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

/** A snapshot must describe the actual message sender before it can be shown. */
function participantMatchesSender(participant: ParticipantDisplay, message: AtumMessagingMessage): boolean {
  if (participant.kind === 'app') {
    // App UUIDs deliberately differ from the legacy specialist slug. The server
    // records that binding when it accepts the turn, and rendering does not try
    // to reconstruct it from the slug.
    return message.sender.type === 'specialist'
  }

  return participant.kind === 'assistant'
    ? message.sender.type === 'assistant' && sameIdentity(participant.id, message.sender.id)
    : (message.sender.type === 'account' || message.sender.type === 'user') && sameIdentity(participant.id, message.sender.id)
}

function participantLabel(
  participant: ParticipantDisplay,
  accountId: string | null,
  copy: ReturnType<typeof useI18n>['t']['dm']['group']
): string {
  if (participant.kind !== 'app') { return participant.displayName }

  if (accountId && participant.ownerUserId && sameIdentity(accountId, participant.ownerUserId)) {
    return copy.participant.myApp(participant.displayName)
  }

  if (participant.ownerDisplayName) {
    return copy.participant.appOwnedBy(participant.ownerDisplayName, participant.displayName)
  }

  // A known owner ID is intentionally not presentation copy. Without a viewer
  // match or recorded owner name, retain only the historical app label.
  return participant.displayName
}

function SnapshotParticipantIdentity({ accountId, participant, appSlug }: { accountId: string | null; participant: ParticipantDisplay; appSlug: string | null }) {
  const { t } = useI18n()
  const label = participantLabel(participant, accountId, t.dm.group)

  return (
    <span className="flex min-w-0 max-w-full items-center gap-1.5 text-left">
      <AtumAssistantAvatar
        avatarUrl={participant.avatarUrl}
        className="size-5 shrink-0 rounded-full"
        id={`${participant.kind}:${participant.id}:${participant.ownerUserId ?? ''}`}
        name={participant.displayName}
      />
      <span className="truncate">{label}</span>
    </span>
  )
}

function groupSenderLabel(
  message: AtumMessagingMessage,
  members: readonly GroupMember[] | undefined,
  specialists: readonly GroupSpecialist[] | undefined,
  formerMember: string,
  advisors: readonly AdvisoryAdvisor[] | undefined,
  accountId: string | null,
  catalog: readonly DesktopAppCatalogEntry[],
  locale: string
): ReactNode {
  const metadata = parseDmMetadata(message.metadata)
  const participant = metadata?.participant

  if (participant && participantMatchesSender(participant, message)) {
    return <SnapshotParticipantIdentity accountId={accountId} appSlug={participant.kind === 'app' ? message.sender.id : null} participant={participant} />
  }

  const assistantIdentity = metadata?.assistantIdentity

  if (assistantIdentity && message.sender.type === 'assistant' && sameIdentity(assistantIdentity.id, message.sender.id)) {
    return (
      <span className="flex min-w-0 max-w-full items-center gap-1.5 text-left">
        <AtumAssistantAvatar avatarUrl={assistantIdentity.avatarUrl} className="size-5 shrink-0 rounded-full" id={assistantIdentity.id} name={assistantIdentity.displayName} />
        <span className="truncate">{assistantIdentity.displayName}</span>
      </span>
    )
  }

  const advisor = advisors?.find(candidate => candidate.target.type === message.sender.type && candidate.target.id === message.sender.id)

  if (advisor) {
    return <GroupParticipantIdentity displayName={advisor.displayName} target={advisor.target} />
  }

  if (advisors && message.sender.type === 'assistant') {
    return formerMember
  }

  if (message.sender.type === 'specialist') {
    const snapshot = message.metadata?.specialist_identity

    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
      const identity = snapshot as Record<string, unknown>

      if (identity.specialist === message.sender.id && typeof identity.display_name === 'string' && identity.display_name.trim()) {
        return identity.display_name
      }
    }

    const app = catalog.find(candidate => candidate.app === message.sender.id && candidate.availability === 'available')

    return specialists?.find(candidate => candidate.specialist === message.sender.id)?.displayName
      ?? (app ? appDisplayName(app, locale) : message.sender.id)
  }

  if (!members || (message.sender.type !== 'account' && message.sender.type !== 'user')) {
    return null
  }

  const member = members.find(candidate => candidate.userId === message.sender.id)

  return member ? personLabel(member) : formerMember
}

/** Renders a server-projected membership event without treating it as a message. */
function GroupMembershipEventRow({ event, members }: { event: GroupMembershipEvent; members: readonly GroupMember[] }) {
  const { t } = useI18n()

  return (
    <div
      className="my-3 flex items-center gap-2 text-center text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)"
      data-group-membership-event={event.kind}
    >
      <span className="h-px flex-1 bg-(--atum-line)" />
      <span>{eventCopy(event, members, t.dm.group.events)}</span>
      <span className="h-px flex-1 bg-(--atum-line)" />
    </div>
  )
}

export function DmMessageList({
  accountId,
  emptyContent,
  groupMembers,
  groupSpecialists,
  groupAdvisors,
  immutable = false,
  membershipEvents,
  messages,
  onEdit,
  onJumpToMessage,
  onLoadOlder,
  onReact,
  onRecall,
  onQuote,
  onReply,
  onReport,
  onRetry,
  olderState,
  readMessageId,
  retryLabel,
  quoteEnabled = false,
  quoteLimit = 0
}: DmMessageListProps) {
  const { locale, t } = useI18n()
  const catalog = useStore($atumAppCatalog)
  const catalogApps = catalog.accountId === accountId ? catalog.apps : []

  const endRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const priorHeightRef = useRef<number | null>(null)

  const timeline = useMemo(() => {
    const messageConversationIds = new Set(messages.map(message => message.conversationId))
    const knownConversationId = messageConversationIds.size === 1 ? [...messageConversationIds][0] : null

    const events =
      membershipEvents?.filter(event => !knownConversationId || event.conversationId === knownConversationId) ?? []

    return [
      ...messages.map(message => ({
        createdAt: message.createdAt,
        id: message.id ?? message.localId,
        kind: 'message' as const,
        message
      })),
      ...events.map(event => ({ createdAt: event.createdAt, id: event.id, kind: 'event' as const, event }))
    ].sort(compareTimelineEntries)
  }, [membershipEvents, messages])

  useEffect(() => {
    const scroller = scrollerRef.current

    if (scroller && priorHeightRef.current !== null) {
      scroller.scrollTop += scroller.scrollHeight - priorHeightRef.current
      priorHeightRef.current = null
    } else {
      endRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [timeline.length])

  if (timeline.length === 0) {
    return <div className="grid min-h-0 flex-1 place-items-center">{emptyContent}</div>
  }

  let priorDay: string | null = null

  return (
    <div
      aria-live="polite"
      className="min-h-0 flex-1 overflow-y-auto px-4 py-5"
      onScroll={event => {
        if (event.currentTarget.scrollTop <= 80 && olderState !== 'loading' && olderState !== 'exhausted') {
          priorHeightRef.current = event.currentTarget.scrollHeight
          onLoadOlder()
        }
      }}
      ref={scrollerRef}
      role="log"
    >
      <div className="mx-auto w-full max-w-3xl">
        {timeline.map(entry => {
          const currentDay = dayKey(entry.createdAt)
          const showDate = currentDay !== priorDay
          priorDay = currentDay

          return (
            <div key={`${entry.kind}:${entry.id}`}>
              {showDate && (
                <div className="my-3 text-center text-[0.6875rem] text-(--atum-ink-muted)">
                  {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(entry.createdAt))}
                </div>
              )}
              {entry.kind === 'event' ? (
                <GroupMembershipEventRow event={entry.event} members={groupMembers ?? []} />
              ) : (
                <DmMessageBubble
                  immutable={immutable}
                  message={entry.message}
                  onEdit={onEdit}
                  onJumpToMessage={onJumpToMessage}
                  onQuote={onQuote}
                  onReact={onReact}
                  onRecall={onRecall}
                  onReply={onReply}
                  onReport={
                    accountId && entry.message.sender.type === 'user' && entry.message.sender.id === accountId
                      ? undefined
                      : onReport
                  }
                  onRetry={onRetry}
                  own={Boolean(
                    accountId && entry.message.sender.type === 'user' && entry.message.sender.id === accountId
                  )}
                  quoteEnabled={quoteEnabled}
                  quoteLimit={quoteLimit}
                  read={Boolean(entry.message.id && entry.message.id === readMessageId)}
                  replySource={
                    entry.message.replyToMessageId
                      ? messages.find(candidate => candidate.id === entry.message.replyToMessageId)
                      : null
                  }
                  retryLabel={retryLabel}
                  senderLabel={groupSenderLabel(
                    entry.message,
                    groupMembers,
                    groupSpecialists,
                    t.dm.group.events.formerMember,
                    groupAdvisors,
                    accountId,
                    catalogApps,
                    locale
                  )}
                />
              )}
            </div>
          )
        })}
        <div ref={endRef} />
      </div>
    </div>
  )
}
