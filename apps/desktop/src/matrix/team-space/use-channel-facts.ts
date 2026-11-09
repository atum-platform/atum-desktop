import { useStore } from '@nanostores/react'

import type { MatrixRoom } from '../../../shared/matrix'
import { isCompanyConversationRoom } from '../../../shared/matrix-company-channel-room'

import {
  type ChannelAbilities,
  channelAbilities,
  type CompanyAbilities,
  companyAbilities,
  NO_CHANNEL_ABILITIES,
  teamSpaceProfile
} from './abilities'
import { $companyChannels, channelViewForRoom } from './channels-store'
import { $companyConversations, conversationViewForRoom } from './conversations-store'
import { $teamSpaceDiscovery } from './discovery-store'
import { teamSpaceKey } from './keys'
import { $companyStanding } from './standing-store'
import { channelFactsOf, type CompanyChannelView, type CompanyConversationView } from './views'

export interface CompanyChannelFacts {
  /** The platform's own record of this channel for this person; absent until the directory is read. */
  channel?: CompanyChannelView
  /**
   * The platform's record of this company conversation (a company DM or group DM), when the open room is one and the
   * directory lists it. Absent until then: such a room takes no message before the platform has said what it is.
   */
  conversation?: CompanyConversationView
  abilities: ChannelAbilities
  /** Company-wide actions used by #general's owner/admin chips. */
  company: CompanyAbilities
  /** Both platform standing and Matrix's current room-mention power allow `@channel`. */
  mentionRoom: boolean
  /**
   * Whether a file may be attached here. A private channel's files need the protected company-drive-files
   * 1.2 routes, which this client does not speak yet, and a file must never fall back to the homeserver's
   * media for a channel whose audience is narrower than the company. With channel admission active a file is
   * therefore attached only where the directory says the channel is public; before it, no channel is private.
   */
  attachments: boolean
  /**
   * The platform has archived this channel: nothing may be posted to it, whatever Matrix says about this person's
   * power in the room. The composer closes on this first; Matrix power levels stay the second line of defence.
   */
  archived: boolean
  /**
   * What the platform has said about this channel's state. A company channel is `unknown` until the matching-wire
   * directory is read: nothing may be posted then, because "not archived yet" is not "not archived". Anything
   * that is no company channel is `active` (nothing here concerns it).
   */
  state: 'unknown' | 'active' | 'archived'
}

/**
 * What the open company channel is and what its viewer may do, read from the stores the workspace
 * keeps (directory, discovery, standing). The header, banner and menu all ask here, so none of them
 * asks the platform again, and none decides a permission on its own.
 */
export function useCompanyChannelFacts(
  accountKey: string,
  room: (Pick<MatrixRoom, 'companyChannel'> &
    Partial<Pick<MatrixRoom, 'canMentionRoom' | 'companyConversation' | 'id' | 'roomType'>>) | null | undefined
): CompanyChannelFacts {
  const conversationCompanyId = room?.companyConversation?.companyId
  const companyId = room?.companyChannel?.companyId ?? conversationCompanyId
  const key = companyId ? teamSpaceKey(accountKey, companyId) : ''
  const discovery = useStore($teamSpaceDiscovery)
  const channels = useStore($companyChannels, { keys: [key] })[key]
  const conversations = useStore($companyConversations, { keys: [key] })[key]
  const standing = useStore($companyStanding, { keys: [key] })[key]
  const profile = teamSpaceProfile(discovery?.accountKey === accountKey ? discovery.discovery : { state: 'unknown' })
  const channel = channelViewForRoom(channels, room)
  const company = companyAbilities(profile, standing)

  // A company conversation (a company DM or group DM). Its audience is its participants, so nothing is posted until the
  // platform's directory lists it, and a read-only one (a participant left the company) takes nothing at all. The
  // protected-file path re-reads this same authority in native main before reserve and every download.
  if (conversationCompanyId || isCompanyConversationRoom(room)) {
    // A room that claims the type with no readable binding has nothing to be looked up by: it is never confirmed.
    const conversation = conversationViewForRoom(conversations, { id: room?.id ?? '', companyConversation: room?.companyConversation })

    if (!conversation) {
      return {
        abilities: NO_CHANNEL_ABILITIES,
        company,
        mentionRoom: false,
        attachments: false,
        archived: false,
        state: 'unknown'
      }
    }

    const readOnly = conversation.state === 'read_only'

    return {
      conversation,
      abilities: NO_CHANNEL_ABILITIES,
      company,
      mentionRoom: false,
      attachments: !readOnly,
      archived: readOnly,
      state: readOnly ? 'archived' : 'active'
    }
  }

  // A directory read on another wire than discovery now selects is not drawn from: a private
  // channel must never read as a company-wide one while the right read is on its way.
  // Not a company channel at all: nothing here concerns it.
  if (!companyId) {
    return {
      abilities: NO_CHANNEL_ABILITIES,
      company,
      mentionRoom: false,
      attachments: true,
      archived: false,
      state: 'active'
    }
  }

  if (!channel || channel.wire !== (profile.channels ? '1.4' : '1.1')) {
    return {
      abilities: NO_CHANNEL_ABILITIES,
      company,
      mentionRoom: false,
      attachments: !profile.channels,
      archived: false,
      state: 'unknown'
    }
  }

  return {
    channel,
    company,
    mentionRoom: Boolean(
      room?.canMentionRoom &&
        (channelFactsOf(channel).ownedByViewer || standing?.role === 'owner' || standing?.role === 'admin')
    ),
    attachments: channel.state === 'active' && (channel.wire === '1.1' || channel.admission?.state === 'active'),
    archived: channel.state === 'archived',
    state: channel.state === 'archived' ? 'archived' : 'active',
    abilities: channelAbilities(profile, standing?.role, channelFactsOf(channel))
  }
}
