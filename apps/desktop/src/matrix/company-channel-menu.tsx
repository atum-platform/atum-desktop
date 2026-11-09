import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Archive, ArchiveOff, Hash, LogOut, Messages, MoreHorizontal, Plus, Star, Users } from '@/lib/icons'

import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { matrixCompanyCopy } from '../../shared/matrix-company-copy'
import { matrixTeamSpaceCopy } from '../../shared/matrix-team-space-copy'

import { useChatCopy } from './chat-copy'
import { useRoomFlag } from './conversation-menu'
import { focusDialogField, MatrixDialogHeader } from './dialog-header'
import { MatrixMemberAvatar } from './member-avatar'
import { MatrixNotificationLevelMenu } from './notification-level-menu'
import { requestTeamSpaceIntent } from './team-space/intents'
import { teamSpaceAccountKey } from './team-space/keys'
import { useCompanyChannelFacts } from './team-space/use-channel-facts'
import { runMatrixCommand } from './text-document-actions'
import { matrixThreadCopy } from './thread-copy'

/**
 * The channel header's people (Atum Kit, FlowTeamSpace): up to three round faces and the count,
 * in one quiet capsule beside search. The count is the platform's own for the channel; the faces
 * are the room's joined members, for show. It opens the channel's members, or the company's
 * roster where the channel has no platform record.
 */
export function MatrixCompanyMembersButton({ snapshot }: { snapshot: MatrixSnapshot }) {
  const chat = useChatCopy()
  const room = snapshot.rooms.find(value => value.id === snapshot.roomId)
  const { channel } = useCompanyChannelFacts(teamSpaceAccountKey(snapshot.identity), room ?? { companyChannel: undefined })
  const { locale } = useI18n()
  const team = matrixTeamSpaceCopy(locale)
  const joined = (snapshot.members ?? []).filter(member => member.membership === 'join')
  const count = channel?.memberCount ?? joined.length
  const label = channel ? team.channelMemberCount(count) : chat.members

  return (
    <Tip label={label}>
      <button
        aria-label={label}
        className="atum-member-stack"
        data-matrix-company-members-button
        onClick={() => requestTeamSpaceIntent({
          kind: 'channel-members',
          channelId: channel?.id ?? room?.companyChannel?.channelId ?? ''
        })}
        type="button"
      >
        {joined.length > 0 ? (
          <span aria-hidden className="atum-member-stack-faces">
            {joined.slice(0, 3).map(member => (
              <MatrixMemberAvatar
                avatarMxc={member.avatarMxc}
                className="atum-avatar atum-member-stack-face"
                id={member.userId}
                key={member.userId}
                name={member.name ?? member.userId}
                presence={false}
              />
            ))}
          </span>
        ) : (
          // The room's members are not loaded yet: the people glyph stands in for their faces.
          <Users aria-hidden className="size-4" />
        )}
        <span aria-hidden>{count}</span>
      </button>
    </Tip>
  )
}

/** Active and invited people on the company's own roster (the same count the sidebar shows). */
function useCompanyMemberCount(companyId: string, enabled: boolean): number | undefined {
  const [count, setCount] = useState<number>()

  useEffect(() => {
    const bridge = window.atumMatrix.companies

    if (!enabled || !bridge) {
      return
    }

    let live = true

    void bridge
      .request({ action: 'read', companyId })
      .then(result => {
        if (live && result.ok && 'company' in result.value && 'members' in result.value) {
          setCount(result.value.members.filter(member => member.state === 'active' || member.state === 'invited').length)
        }
      })
      .catch(() => {})

    return () => {
      live = false
    }
  }, [companyId, enabled])

  return count
}

function ChannelDetails({
  companyId,
  onOpenChange,
  open,
  title
}: {
  companyId: string
  onOpenChange(open: boolean): void
  open: boolean
  title: string
}) {
  const { locale, t } = useI18n()
  const copy = matrixCompanyCopy(locale)
  const count = useCompanyMemberCount(companyId, open)

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        aria-describedby={undefined}
        className="atum-sheet max-w-sm"
        data-matrix-company-channel-details
        onOpenAutoFocus={focusDialogField}
        showCloseButton={false}
      >
        <MatrixDialogHeader title={copy.channelDetails} />
        <div className="grid gap-3 text-sm">
          <p className="flex items-center gap-2 font-medium text-(--atum-ink)">
            <Hash aria-hidden className="size-4 shrink-0 text-(--atum-ink-muted)" />
            <span className="truncate">{title}</span>
          </p>
          {count !== undefined && <p className="text-(--atum-ink-muted)">{copy.members(count)}</p>}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
            {t.common.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The company channel's own "…" menu. The personal conversation menu (private rename, pin,
 * Leave chat, Delete chat) does not belong here: the channel belongs to the company and its
 * membership follows the company's roster, so there is nothing to leave or forget from a
 * room. Notifications is the account's private cross-device level, not room membership.
 */
export function MatrixCompanyChannelMenu({
  fail,
  onThreads,
  room,
  snapshot,
  title
}: {
  fail(cause?: unknown): void
  onBackground?: () => void
  onThreads?: () => void
  room: MatrixRoom
  snapshot: MatrixSnapshot
  title: string
}) {
  return <MatrixCompanyChannelMenuFor fail={fail} key={room.id} onThreads={onThreads} room={room} snapshot={snapshot} title={title} />
}

function MatrixCompanyChannelMenuFor({
  fail,
  onThreads,
  room,
  snapshot,
  title
}: {
  fail(cause?: unknown): void
  onThreads?: () => void
  room: MatrixRoom
  snapshot: MatrixSnapshot
  title: string
}) {
  const chat = useChatCopy()
  const { locale } = useI18n()
  const copy = matrixCompanyCopy(locale)
  const team = matrixTeamSpaceCopy(locale)
  const threads = matrixThreadCopy(locale)
  const [details, setDetails] = useState(false)
  const favourite = useRoomFlag(Boolean(room.favourite))
  const ready = snapshot.state === 'ready'
  // The platform's own record of this channel and what this person may do in it; nothing is decided here.
  const { abilities, channel } = useCompanyChannelFacts(teamSpaceAccountKey(snapshot.identity), room)
  const admission = channel?.wire === '1.4' ? channel : undefined
  const ask = (intent: Parameters<typeof requestTeamSpaceIntent>[0]) => () => requestTeamSpaceIntent(intent)
  const archive = admission && (abilities.archive || abilities.restore)
  const exits = admission && (abilities.leave || archive)

  return (
    <>
      <DropdownMenu>
        <Tip label={chat.conversationOptions}>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={chat.conversationOptions}
              className="atum-icon-btn size-7 shrink-0"
              data-matrix-chat-menu="company"
              type="button"
            >
              <MoreHorizontal aria-hidden className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end" className="min-w-52">
          {onThreads && (
            <DropdownMenuItem onSelect={onThreads}>
              <Messages aria-hidden />
              {threads.openThreads}
            </DropdownMenuItem>
          )}
          {admission && (
            <DropdownMenuItem onSelect={ask({ kind: 'channel-members', channelId: admission.id })}>
              <Users aria-hidden />
              {team.channelMembersTitle}
            </DropdownMenuItem>
          )}
          {admission && abilities.addPeople && (
            <DropdownMenuItem onSelect={ask({ kind: 'add-people', channelId: admission.id })}>
              <Plus aria-hidden />
              {team.addPeople}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={admission ? ask({ kind: 'channel-details', channelId: admission.id }) : () => setDetails(true)}>
            <Hash aria-hidden />
            {admission && abilities.edit ? team.editChannel : copy.channelDetails}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!ready || favourite.busy}
            onSelect={() =>
              favourite.change(
                !favourite.value,
                () => runMatrixCommand({ kind: 'favourite', roomId: room.id, favourite: !favourite.value }),
                fail
              )
            }
          >
            <Star aria-hidden />
            {favourite.value ? team.unfavoriteChannel : team.favoriteChannel}
          </DropdownMenuItem>
          <MatrixNotificationLevelMenu
            fail={fail}
            roomId={room.id}
            snapshot={snapshot}
            value={snapshot.notificationPolicy?.channelOverrides[room.id] ?? 'inherit'}
          />
          {exits && <DropdownMenuSeparator />}
          {admission && abilities.leave && (
            <DropdownMenuItem onSelect={ask({ kind: 'leave-channel', channelId: admission.id })} variant="destructive">
              <LogOut aria-hidden />
              {team.leaveChannel}
            </DropdownMenuItem>
          )}
          {admission && abilities.archive && (
            <DropdownMenuItem onSelect={ask({ kind: 'archive-channel', channelId: admission.id })} variant="destructive">
              <Archive aria-hidden />
              {team.archiveChannel}
            </DropdownMenuItem>
          )}
          {admission && abilities.restore && (
            <DropdownMenuItem onSelect={ask({ kind: 'restore-channel', channelId: admission.id })}>
              <ArchiveOff aria-hidden />
              {team.restoreChannel}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ChannelDetails
        companyId={room.companyChannel?.companyId ?? ''}
        onOpenChange={setDetails}
        open={details}
        title={title}
      />
    </>
  )
}
