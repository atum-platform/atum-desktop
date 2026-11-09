import { EarlierConversationError } from './admission'
import { ConversationUnavailableError } from './resolver'

/** Read a private assistant room, then make sure the host that read it is still current. */
export async function requireAssistantConversation(
  read: () => Promise<unknown>, stillReady: () => boolean, pending: () => boolean = () => false
): Promise<void> {
  if (pending()) {
    throw new ConversationUnavailableError()
  }
  await read()

  if (pending()) {
    throw new ConversationUnavailableError()
  }

  if (!stillReady()) {
    throw new Error('matrix_not_ready')
  }
}

interface ConversationRoomCandidate {
  id: string
  lastActiveAt?: number
}

/** The first-run review must stay in the marked main room when the account has one. */
export function firstRunConversationRoom<T extends ConversationRoomCandidate>(
  usable: readonly T[], markedMain: string | undefined, preferred?: string
): T | undefined {
  if (markedMain) {
    return usable.find(room => room.id === markedMain)
  }

  return usable.find(room => room.id === preferred) ?? latestConversationRoom(usable)
}

/** The roster preserves the selected room for legacy accounts, but a marked main takes precedence. */
export function rosterConversationRoom<T extends ConversationRoomCandidate>(
  eligible: readonly T[], selectedRoomId: string | null | undefined, markedMain: string | undefined
): T | undefined {
  return (
    eligible.find(room => room.id === markedMain) ??
    eligible.find(room => room.id === selectedRoomId) ??
    latestConversationRoom(eligible)
  )
}

interface AttentionConversationRoom extends ConversationRoomCandidate {
  agentPrincipal?: string
  membership?: string
}

/** Attention opens the authoritative main first; legacy accounts retain their listening/latest order. */
export function attentionConversationRoom<T extends AttentionConversationRoom>(
  rooms: readonly T[], input: { markedMain?: string; listeningRoom?: T; agentPrincipal: string | undefined }
): T | undefined {
  return (
    rooms.find(room => room.id === input.markedMain) ??
    input.listeningRoom ??
    latestConversationRoom(rooms.filter(room => room.agentPrincipal === input.agentPrincipal && room.membership === 'join'))
  )
}

/** Drive status treats the two expected read refusals as unavailable and leaves every other failure visible. */
export async function taskFilesConversationStatus(ready: () => Promise<boolean>): Promise<{ state: 'ready' | 'unavailable' }> {
  try {
    return { state: (await ready()) ? 'ready' : 'unavailable' }
  } catch (error) {
    if (error instanceof EarlierConversationError || error instanceof ConversationUnavailableError) {
      return { state: 'unavailable' }
    }

    throw error
  }
}

/** Private result/notice publication rechecks the room; group publication owns its separate admission path. */
export async function admitPrivateConversationPublication(
  command: { kind: string }, group: boolean, requireRoom: () => Promise<unknown>
): Promise<void> {
  if (!group && (command.kind === 'publishResult' || command.kind === 'publishNotice')) {
    await requireRoom()
  }
}

function latestConversationRoom<T extends ConversationRoomCandidate>(rooms: readonly T[]): T | undefined {
  return [...rooms].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
}
