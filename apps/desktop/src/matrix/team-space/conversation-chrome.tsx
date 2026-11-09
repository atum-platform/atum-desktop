import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { NoticeBand } from '@/components/ui/error-state'
import { Tip } from '@/components/ui/tooltip'
import { Bell, BellOff, EyeOff, MoreHorizontal, Palette, Plus, User, Users } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixRoom } from '../../../shared/matrix'
import { useChatCopy } from '../chat-copy'
import { useRoomFlag } from '../conversation-menu'
import { MatrixTeammateAvatar } from '../member-avatar'
import { runMatrixCommand } from '../text-document-actions'

import { $companyConversations, $companySelfRefs, conversationViewForRoom } from './conversations-store'
import { useTeamSpaceCopy } from './copy'
import { requestTeamSpaceIntent } from './intents'
import { teamSpaceKey } from './keys'
import { type CompanyConversationView, conversationPeople, conversationTitle } from './views'

type ConversationRoom = Pick<MatrixRoom, 'companyConversation' | 'id'> & Partial<Pick<MatrixRoom, 'muted'>>

interface ConversationPerson {
  displayName?: string | null
  handle?: string | null
  memberRef: string
}

/** A group DM is two overlapping round faces, never a numeric or generic people glyph. */
export function ConversationGroupAvatar({
  people,
  small = false
}: {
  people: readonly ConversationPerson[]
  small?: boolean
}) {
  const { company } = useTeamSpaceCopy()

  return (
    <span className={cn('ak-group-avatar', small && 'ak-group-avatar--sm')} data-conversation-group-avatar>
      {people.slice(0, 2).map(person => (
        <MatrixTeammateAvatar
          className="ak-avatar"
          key={person.memberRef}
          name={person.displayName ?? person.handle ?? company.someone}
          person={person}
          presence={false}
        />
      ))}
    </span>
  )
}

/** The platform's record of the open conversation room, and who "me" is in its company. */
function useConversationOf(accountKey: string, room: ConversationRoom) {
  const companyId = room.companyConversation?.companyId
  const key = companyId ? teamSpaceKey(accountKey, companyId) : ''
  const conversations = useStore($companyConversations, { keys: [key] })[key]
  const selfRef = useStore($companySelfRefs, { keys: [key] })[key]

  return { conversation: conversationViewForRoom(conversations, room), selfRef }
}

/** The header's mark: one person or several. */
export function ConversationGlyph({ className, kind }: { className?: string; kind: CompanyConversationView['kind'] | undefined }) {
  const Icon = kind === 'dm' ? User : Users

  return <Icon aria-hidden className={className} />
}

/**
 * The header's face, as Slack shows it: the person in a DM (the same squircle as their sidebar row), or for a
 * group how many people are in it. Before the platform has listed the conversation there is nothing to draw a
 * face from, so the generic mark stands in.
 */
export function ConversationFaceFor({ accountKey, className, room }: { accountKey: string; className?: string; room: ConversationRoom }) {
  const { company } = useTeamSpaceCopy()
  const { conversation, selfRef } = useConversationOf(accountKey, room)

  if (!conversation) {
    return <ConversationGlyph className={className} kind={undefined} />
  }

  const people = conversationPeople(conversation, selfRef)
  const first = people[0]

  if (conversation.kind === 'dm' && first) {
    return (
      <MatrixTeammateAvatar
        className={className ?? ''}
        name={first.displayName ?? first.handle ?? company.someone}
        person={first}
      />
    )
  }

  return <ConversationGroupAvatar people={people} small />
}

/** The open conversation's name: the other people in it, from the platform's record (the Matrix room name only before it is read). */
export function ConversationTitleFor({ accountKey, fallback, room }: { accountKey: string; fallback: string; room: ConversationRoom }) {
  return <>{useConversationTitle(accountKey, room, fallback)}</>
}

/** The same authoritative conversation name for non-visual consumers such as the composer. */
export function useConversationTitle(accountKey: string, room: ConversationRoom, fallback: string): string {
  const { company } = useTeamSpaceCopy()
  const { conversation, selfRef } = useConversationOf(accountKey, room)

  return conversation ? conversationTitle(conversation, selfRef, company.someone) : fallback
}

/**
 * A read-only conversation (a participant left the company, so this set can take no more messages) keeps
 * its history and says why. Like an archived channel's banner it stands in the composer's place.
 */
export function ReadOnlyConversationBanner() {
  const { team } = useTeamSpaceCopy()

  return (
    <NoticeBand data-matrix-conversation-read-only role="status" tone="notice">
      {team.conversationReadOnlyBanner}
    </NoticeBand>
  )
}

/**
 * The conversation header's menu: add people (a new conversation with the larger group) and hide. There is
 * no leave, delete or remove: who is in a conversation is the platform's, and hiding is only this person's view.
 * The workspace owns the dialogs and the single change journal, so each entry leaves a note for it.
 */
export function ConversationMenu({ accountKey, fail, onBackground, room }: {
  accountKey: string
  fail?(cause?: unknown): void
  onBackground?: () => void
  room: ConversationRoom
}) {
  const chat = useChatCopy()
  const { team } = useTeamSpaceCopy()
  const { conversation } = useConversationOf(accountKey, room)
  const mute = useRoomFlag(Boolean(room.muted))

  if (!conversation) {
    return null
  }

  const addable = conversation.state === 'active'

  return (
    <DropdownMenu>
      <Tip label={team.conversationMenu}>
        <DropdownMenuTrigger asChild>
          <Button aria-label={team.conversationMenu} data-matrix-conversation-menu size="icon-sm" variant="ghost">
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="min-w-48">
        {addable && (
          <DropdownMenuItem onSelect={() => requestTeamSpaceIntent({ kind: 'conversation-add-people', conversationId: conversation.id })}>
            <Plus aria-hidden />
            {team.addPeople}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={mute.busy}
          onSelect={() => mute.change(
            !mute.value,
            () => runMatrixCommand({ kind: 'mute', roomId: room.id, muted: !mute.value }),
            fail ?? (() => {})
          )}
        >
          {mute.value ? <Bell aria-hidden /> : <BellOff aria-hidden />}
          {mute.value ? chat.unmute : chat.mute}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => requestTeamSpaceIntent({ kind: 'conversation-hide', conversationId: conversation.id })}>
          <EyeOff aria-hidden />
          {team.conversationHide}
        </DropdownMenuItem>
        {onBackground && (
          <DropdownMenuItem onSelect={onBackground}>
            <Palette aria-hidden />
            {chat.background}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
