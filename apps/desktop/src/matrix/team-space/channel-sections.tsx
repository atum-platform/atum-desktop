import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { Compass, Hash, Lock, Plus } from '@/lib/icons'

import type { MatrixRoom } from '../../../shared/matrix'
import { companyRoomBadge } from '../company-chrome'
import { RosterBadge } from '../roster-badge'
import { TeamSpaceSidebarRow, TeamSpaceSidebarSection } from '../team-space-sidebar'

import type { CompanyAbilities } from './abilities'
import { useTeamSpaceCopy } from './copy'
import { type CompanyChannelView, isDefaultChannel, sortChannels } from './views'

export interface ChannelSectionsProps {
  views: readonly CompanyChannelView[]
  rooms: readonly MatrixRoom[]
  activeRoomId?: string | null
  showingOverview: boolean
  /** A channel is being opened: no second open starts. */
  openingRoomId?: string
  abilities: CompanyAbilities
  onOpen(view: CompanyChannelView): void
  onAcceptInvitation(view: CompanyChannelView): void
  onCreate(): void
  onBrowse(): void
  query?: string
  /** Optional workspace-owned content above the channel rows. */
  top?: ReactNode
  /** Loading and failure lines sit under the rows. */
  bottom?: ReactNode
}

/**
 * The channel sidebar of a company with channel admission: Favorites (the person's own Matrix
 * `m.favourite` tags, so they follow the account), Channels with a lock on private ones, pending
 * channel invitations, and Archived, collapsed. Before C2 the workspace draws the one flat list of
 * the 1.1 client instead.
 */
export function ChannelSections({
  abilities,
  activeRoomId,
  bottom,
  onAcceptInvitation,
  onBrowse,
  onCreate,
  onOpen,
  query = '',
  rooms,
  showingOverview,
  top,
  views
}: ChannelSectionsProps) {
  const { company, locale, team } = useTeamSpaceCopy()
  const roomsById = new Map(rooms.map(room => [room.id, room]))
  const roomOf = (view: CompanyChannelView) => (view.room.state === 'ready' ? roomsById.get(view.room.roomId) : undefined)
  const sorted = sortChannels(views, locale)
  const invited = sorted.filter(view => view.admission?.state === 'invited')
  const archived = sorted.filter(view => view.state === 'archived' && view.admission?.state !== 'invited')
  const live = sorted.filter(view => view.state !== 'archived' && view.admission?.state !== 'invited')

  const matched = live.filter(view => {
    const needle = query.trim().toLocaleLowerCase(locale)

    return !needle || (isDefaultChannel(view) ? company.defaultChannelName : view.displayName).toLocaleLowerCase(locale).includes(needle)
  })

  const favorites = matched.filter(view => roomOf(view)?.favourite)
  const channels = matched.filter(view => !roomOf(view)?.favourite)

  const row = (view: CompanyChannelView) => {
    const label = isDefaultChannel(view) ? company.defaultChannelName : view.displayName
    const ready = view.room.state === 'ready'
    const selected = ready && view.room.roomId === activeRoomId && !showingOverview
    const badge = ready ? companyRoomBadge(roomOf(view)) : null
    const state = view.state === 'archived' ? 'archived' : view.room.state
    const Icon = view.visibility === 'private' ? Lock : Hash

    return (
      <div data-channel-visibility={view.visibility} data-matrix-company-channel-row key={view.id}>
        <TeamSpaceSidebarRow
          ariaLabel={ready ? (view.visibility === 'private' ? `${company.openChannel(label)} · ${team.privateChannel}` : company.openChannel(label)) : undefined}
          disabled={!ready}
          icon={<Icon />}
          label={label}
          onSelect={() => onOpen(view)}
          selected={selected}
          trailing={state === 'ready' ? (badge ? <RosterBadge badge={badge} /> : undefined) : company.channelState(state)}
          unread={badge !== null}
        />
      </div>
    )
  }

  const canAdd = abilities.createChannel || abilities.browseChannels

  // The section-header action offers channel creation and discovery without adding a fake row.
  const addMenu = (trigger: ReactNode) => (
    <DropdownMenu>
      {trigger}
      <DropdownMenuContent align="start" className="min-w-48">
        {abilities.createChannel && (
          <DropdownMenuItem onSelect={onCreate}>
            <Plus aria-hidden />
            {team.createChannelItem}
          </DropdownMenuItem>
        )}
        {abilities.browseChannels && (
          <DropdownMenuItem onSelect={onBrowse}>
            <Compass aria-hidden />
            {team.browseChannelsItem}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <>
      {favorites.length > 0 && (
        <div data-matrix-company-favorites>
          <TeamSpaceSidebarSection title={team.favorites}>{favorites.map(row)}</TeamSpaceSidebarSection>
        </div>
      )}
      <div data-matrix-company-channels>
        <TeamSpaceSidebarSection
          action={canAdd ? addMenu(
            <Tip label={team.addChannels}>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label={team.addChannels}
                  className="ak-iconbtn ak-iconbtn--sm"
                  data-matrix-company-add-channels
                  type="button"
                >
                  <Plus aria-hidden className="ak-icon ak-icon--sm" />
                </button>
              </DropdownMenuTrigger>
            </Tip>
          ) : undefined}
          title={company.channels}
        >
          {top}
          {channels.length === 0 && favorites.length === 0 && invited.length === 0 && archived.length === 0 && (
            <p className="px-2 py-1 text-sm text-(--atum-ink-muted)">{company.noChannels}</p>
          )}
          {channels.map(row)}
          {bottom}
        </TeamSpaceSidebarSection>
      </div>
      {invited.length > 0 && (
        <div data-matrix-company-channel-invitations>
          <TeamSpaceSidebarSection title={team.channelInvitations}>
            {invited.map(view => (
              <div className="flex items-center justify-between gap-2 px-2 py-1" key={view.id}>
                <span className="truncate text-sm text-(--atum-ink)">{team.channelInvitationRow(view.displayName)}</span>
                <Button onClick={() => onAcceptInvitation(view)} size="sm" variant="secondary">
                  {team.joinChannel}
                </Button>
              </div>
            ))}
          </TeamSpaceSidebarSection>
        </div>
      )}
      {archived.length > 0 && (
        <div data-matrix-company-archived>
          <TeamSpaceSidebarSection defaultOpen={false} title={team.archivedSection}>
            {archived.map(row)}
          </TeamSpaceSidebarSection>
        </div>
      )}
    </>
  )
}
