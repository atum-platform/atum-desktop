import { type AccountDataEvents, EventType, type MatrixClient, Method, type Room } from 'matrix-js-sdk'

/** Projection only: the SDK retains history and the homeserver owns membership. */
export function ignoredInvitation(client: MatrixClient, room: Room): boolean {
  const inviter = room.currentState.getStateEvents(EventType.RoomMember, client.getSafeUserId())?.getSender()

  return room.getMyMembership() === 'invite' && Boolean(inviter && client.isUserIgnored(inviter))
}

/** Standard SDK HTTP/auth + account-data API, not a new ignore store/protocol. */
export async function changeIgnoredUser(client: MatrixClient, userId: string, ignored: boolean, active: () => boolean) {
  if (userId === client.getUserId()) {
    throw new Error('matrix_ignore_self')
  }

  // getAccountDataFromServer uses the sync cache after initial sync. Read the
  // server here so a second local edit cannot overwrite an unreceived echo.
  // Matrix account data is still last-write-wins across devices, not CAS.
  const path = `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${EventType.IgnoredUserList}`

  const content = await client.http
    .authedRequest<AccountDataEvents[EventType.IgnoredUserList]>(Method.Get, path)
    .catch(error => {
      if (error?.errcode === 'M_NOT_FOUND') {
        return { ignored_users: {} }
      }

      throw error
    })

  if (
    !content ||
    typeof content !== 'object' ||
    !content.ignored_users ||
    typeof content.ignored_users !== 'object' ||
    Array.isArray(content.ignored_users)
  ) {
    throw new Error('matrix_ignore_invalid_account_data')
  }

  const users = { ...content.ignored_users }

  if (!active()) {
    throw new Error('matrix_sdk_stopped')
  }

  if (ignored) {
    users[userId] = {}
  } else {
    delete users[userId]
  }

  // No application retry or indefinite wait for sync echo. Snapshot state stays
  // SDK-owned; an acknowledged write does not fabricate a local account event.
  await client.setAccountDataRaw(EventType.IgnoredUserList, { ignored_users: users })
}
