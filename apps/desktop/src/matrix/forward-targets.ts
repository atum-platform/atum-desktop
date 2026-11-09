import type { AppDescriptor } from '../../shared/app-catalog'
import type { MatrixAgentView, MatrixRoom } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import { directPartner } from './people'
import { personHandleText } from './person-handle-line'
import { isAppBotRoom, matrixRosterAgentName, normalizeMatrixRosterQuery } from './roster-model'
import type { CompanyChannelsState } from './team-space/channels-store'
import type { CompanyConversationsState } from './team-space/conversations-store'
import { conversationTitle } from './team-space/views'

export interface MatrixForwardTarget {
  room: MatrixRoom
  name: string
  subtitle?: string
  avatarUserId?: string
  disabled?: 'encrypted_file'
  /** A private room for one of this owner's agents; renderer uses this only to choose local invocation. */
  assistant?: MatrixAgentView
}

interface MatrixForwardTargetInput {
  rooms: readonly MatrixRoom[]
  ownerUserId?: string
  agents?: readonly MatrixAgentView[]
  apps?: readonly AppDescriptor[]
  sourceRoomId: string
  encryptedFile: boolean
  defaultAssistantName: string
  companyNames?: ReadonlyMap<string, string>
  channelStates?: readonly CompanyChannelsState[]
  conversationStates?: readonly CompanyConversationsState[]
  companySelfRefs?: ReadonlyMap<string, string>
  /** Directory-verified @handles by Matrix ID: a person's chat shows theirs under the name. */
  handles?: Readonly<Record<string, string>>
}

const roomCompanyId = (room: MatrixRoom) => room.companyChannel?.companyId ?? room.companyConversation?.companyId

/** Renderer-side target curation. Main repeats every authority/privacy check before sending. */
export function matrixForwardTargets(input: MatrixForwardTargetInput): MatrixForwardTarget[] {
  const source = input.rooms.find(room => room.id === input.sourceRoomId)
  const sourceCompany = source && roomCompanyId(source)
  const channels = (input.channelStates ?? []).flatMap(state => !state.error && !state.stale ? state.channels : [])
  const conversations = (input.conversationStates ?? [])
    .flatMap(state => !state.error && !state.stale ? state.conversations : [])

  return input.rooms.flatMap(room => {
    if (room.membership !== 'join' || room.canSend === false || room.appGroup ||
        input.apps?.some(app => isAppBotRoom(room, app))) {
      return []
    }

    const assistant = room.roomType === MATRIX_ASSISTANT_ROOM_TYPE
      ? input.agents?.find(agent => room.participants?.some(member =>
          member.userId === agent.userId && ['join', 'invite'].includes(member.membership)))
      : undefined
    const companyId = roomCompanyId(room)

    if (sourceCompany && companyId !== sourceCompany && !assistant) {
      return []
    }

    let name = room.title?.trim() || room.name
    let subtitle: string | undefined

    if (assistant) {
      name = matrixRosterAgentName(assistant, input.defaultAssistantName)
    } else if (room.companyChannel) {
      const channel = channels.find(item =>
        item.companyId === room.companyChannel?.companyId && item.id === room.companyChannel.channelId &&
        item.room.state === 'ready' && item.room.roomId === room.id && item.state === 'active')

      if (!channel) {
        return []
      }

      name = `# ${channel.displayName}`
      subtitle = input.companyNames?.get(channel.companyId)
    } else if (room.companyConversation) {
      const conversation = conversations.find(item =>
        item.companyId === room.companyConversation?.companyId &&
        item.id === room.companyConversation.conversationId && item.room.state === 'ready' &&
        item.room.roomId === room.id && item.state === 'active' && !item.hidden)

      if (!conversation) {
        return []
      }

      name = conversationTitle(
        conversation,
        input.companySelfRefs?.get(conversation.companyId),
        room.name
      )
      subtitle = input.companyNames?.get(conversation.companyId)
    } else if (input.ownerUserId) {
      const partner = directPartner(room, input.ownerUserId)

      subtitle = partner ? personHandleText(input.handles?.[partner]) : undefined
    }

    const avatarUserId = assistant?.userId ?? room.participants?.find(member =>
      member.userId !== input.ownerUserId && member.membership === 'join')?.userId

    return [{
      room,
      name,
      ...(subtitle ? { subtitle } : {}),
      ...(avatarUserId ? { avatarUserId } : {}),
      ...(input.encryptedFile && !room.encrypted ? { disabled: 'encrypted_file' as const } : {}),
      ...(assistant ? { assistant } : {})
    }]
  }).sort((left, right) =>
    (right.room.lastActiveAt ?? 0) - (left.room.lastActiveAt ?? 0) || left.name.localeCompare(right.name))
}

export function filterMatrixForwardTargets(targets: readonly MatrixForwardTarget[], query: string) {
  const needle = normalizeMatrixRosterQuery(query)

  return needle
    ? targets.filter(target => normalizeMatrixRosterQuery([
        target.name,
        target.subtitle,
        target.room.name,
        target.room.title,
        target.room.firstLine
      ].filter(Boolean).join(' ')).includes(needle))
    : targets
}

/** Cloud agents answer the forwarded Matrix event themselves; invoking them here would double-answer. */
export function matrixForwardNeedsLocalInvocation(target: MatrixForwardTarget): boolean {
  return Boolean(target.assistant && target.assistant.answering !== 'cloud' && target.assistant.hermes === 'ready')
}
