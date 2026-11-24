import { Codecs, persistentAtom } from '@/lib/persisted'

import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { isAssistantRoom } from '../../shared/matrix-assistant-room'
import { isTeamSpaceRoom } from '../../shared/matrix-company-channel-room'

import { agentRoomId, primaryAgent } from './room-agent'
import { sortConversations } from './room-navigation'

/**
 * The last personal Chat each signed-in account had open, by Matrix user id: room ids only, never
 * transcript content. It survives a relaunch, so Chat opens where the person left it.
 */
export const $matrixLastChatByAccount = persistentAtom<Record<string, string>>(
  'atum.desktop.lastChatByAccount.v1',
  {},
  Codecs.stringRecord
)

export function rememberMatrixLastChat(account: string, roomId: string): void {
  const current = $matrixLastChatByAccount.get()

  if (current[account] !== roomId) {
    $matrixLastChatByAccount.set({ ...current, [account]: roomId })
  }
}

function homeRoom(rooms: readonly MatrixRoom[], roomId: string | undefined): MatrixRoom | undefined {
  return roomId
    ? rooms.find(room => room.id === roomId && room.membership === 'join' && !isTeamSpaceRoom(room))
    : undefined
}

/**
 * The account's last Chat, while it is still a joined personal conversation. A former assistant's
 * chat (read-only history once its enrollment was replaced) is not one to land in.
 */
export function matrixRememberedChat(
  snapshot: Pick<MatrixSnapshot, 'agents' | 'assistant' | 'identity' | 'rooms'>
): string | undefined {
  const account = snapshot.identity?.userId
  const room = account ? homeRoom(snapshot.rooms, $matrixLastChatByAccount.get()[account]) : undefined

  const formerAssistant =
    room?.assistant &&
    !isAssistantRoom(room, account, snapshot.assistant?.userId) &&
    !snapshot.agents?.some(agent => agent.principal === room.agentPrincipal)

  return formerAssistant ? undefined : room?.id
}

/**
 * The conversation Chat shows when nothing is selected: the account's last Chat while it is still
 * joined, else the primary agent's conversation. With `anyConversation` (the person pressed Chats)
 * and no agent at all, once the roster is known, the most recent personal conversation. A launch
 * leaves that choice to the person.
 */
export function matrixChatRoomToOpen(
  snapshot: MatrixSnapshot,
  { anyConversation = false }: { anyConversation?: boolean } = {}
): string | undefined {
  const account = snapshot.identity?.userId

  if (!account) {
    return undefined
  }

  const remembered = matrixRememberedChat(snapshot)

  if (remembered) {
    return remembered
  }

  const primary = primaryAgent(snapshot)
  const primaryRoom = primary ? homeRoom(snapshot.rooms, agentRoomId(snapshot, primary.principal)) : undefined

  if (primaryRoom) {
    return primaryRoom.id
  }

  const homeRooms = snapshot.rooms.filter(room => !isTeamSpaceRoom(room))
  const assistantRoom = homeRooms.find(room => isAssistantRoom(room, account, snapshot.assistant?.userId))

  if (assistantRoom) {
    return assistantRoom.id
  }

  // An unavailable platform default is not permission to enter another agent's history.
  return anyConversation && !snapshot.assistant && !primary && snapshot.agentRoster?.state !== 'loading'
    ? sortConversations(homeRooms)[0]?.id
    : undefined
}
