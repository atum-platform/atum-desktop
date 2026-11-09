import type { AtumMessagingConversation, AtumSocialProjection } from '@/lib/atum-messaging-client'

import type { GroupRoomContact } from './group-room-controls'

/** Social profile ids are display identities, not group API account ids. */
export function groupContacts(
  people: readonly AtumSocialProjection[],
  conversations: readonly AtumMessagingConversation[],
  accountId: string | null
): GroupRoomContact[] {
  if (!accountId) {
    return []
  }

  const directThreads = new Map(conversations.filter(row => row.kind === 'direct').map(row => [row.id, row]))

  return people.flatMap(row => {
    if (row.availability !== 'available' || row.state !== 'connected' || !row.directThreadId) {
      return []
    }

    // The existing social contract names the canonical direct thread. Resolve
    // its other account from the same account-scoped messaging roster.
    const thread = directThreads.get(row.directThreadId)
    const members = new Set(thread?.participantIds)

    if (members.size !== 2 || !members.delete(accountId)) {
      return []
    }

    const [userId] = members

    return [{ userId: userId!, displayName: row.profile.displayName, handle: row.profile.handle }]
  })
}
