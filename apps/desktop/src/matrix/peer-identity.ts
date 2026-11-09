import type { MatrixClient } from 'matrix-js-sdk'

/** This is SDK truth for a joined peer, not a renderer-supplied trust claim.
 * Own-identity recovery stays on the owner recovery/agent handshake path.
 */
export async function matrixPeerIdentityReview(
  client: MatrixClient,
  roomId: string,
  userId: string,
  current: () => boolean = () => true
) {
  const room = client.getRoom(roomId)
  const crypto = client.getCrypto()

  if (
    !current() ||
    !crypto ||
    userId === client.getUserId() ||
    room?.getMyMembership() !== 'join' ||
    !room.hasEncryptionStateEvent() ||
    room.getMember(userId)?.membership !== 'join'
  ) {
    throw new Error('matrix_identity_review_invalid')
  }

  await crypto.getUserDeviceInfo([userId], true)
  if (!current()) {
    throw new Error('matrix_identity_review_stale')
  }
  const status = await crypto.getUserVerificationStatus(userId)

  if (
    !current() ||
    client.getRoom(roomId) !== room ||
    !room.hasEncryptionStateEvent() ||
    room.getMyMembership() !== 'join' ||
    room.getMember(userId)?.membership !== 'join'
  ) {
    throw new Error('matrix_identity_review_invalid')
  }

  if (!status.known || status.isCrossSigningVerified()) {
    return null
  }

  return status.needsUserApproval
    ? ('changed' as const)
    : status.wasCrossSigningVerified()
      ? ('verification_required' as const)
      : null
}

/** Called only by the native owner after explicit confirmation, never by an automatic
 * send retry. The approval is to remove this person's previous verification requirement;
 * it is not a claim that a displayed key snapshot was atomically pinned. The SDK's strict
 * device policy remains selected and this does not resend any message.
 */
export async function matrixContinueChangedPeer(
  client: MatrixClient,
  roomId: string,
  userId: string,
  current: () => boolean = () => true
) {
  if (!(await matrixPeerIdentityReview(client, roomId, userId, current))) {
    throw new Error('matrix_identity_review_stale')
  }

  if (!current()) {
    throw new Error('matrix_identity_review_stale')
  }
  await client.getCrypto()!.withdrawVerificationRequirement(userId)
  if (!current()) {
    throw new Error('matrix_identity_review_stale')
  }
}

/** A closed, actionable refusal from actual local SDK trust facts, before sending.
 * No error-string inference: transport/key refresh errors still cross as generic errors.
 * Rust crypto remains the final authority if trust changes after this preflight. */
export async function requireMatrixRoomPeerTrust(
  client: MatrixClient,
  roomId: string,
  mode: 'all' | 'signed' | undefined,
  current: () => boolean
): Promise<void> {
  if (mode !== 'signed') {
    return
  }
  const room = client.getRoom(roomId)

  // A room without end-to-end encryption shares no keys, so no device needs review before a
  // send there (0.20: agent, bot, people and group chats are plain). A room with it keeps this
  // check exactly.
  if (room?.getMyMembership() === 'join' && !room.hasEncryptionStateEvent()) {
    return
  }

  const crypto = client.getCrypto()
  const live = () =>
    current() &&
    Boolean(crypto) &&
    client.getRoom(roomId) === room &&
    room?.getMyMembership() === 'join' &&
    room.hasEncryptionStateEvent()
  if (!live() || !crypto || !room) {
    throw new Error('matrix_identity_review_stale')
  }
  for (const member of room.getJoinedMembers()) {
    if (member.userId === client.getUserId()) {
      continue
    }
    const status = await crypto.getUserVerificationStatus(member.userId)
    if (!live()) {
      throw new Error('matrix_identity_review_stale')
    }
    if (
      room.getMember(member.userId)?.membership === 'join' &&
      status.known &&
      !status.isCrossSigningVerified() &&
      (status.needsUserApproval || status.wasCrossSigningVerified())
    ) {
      throw new Error('matrix_identity_review_required')
    }
  }
}
