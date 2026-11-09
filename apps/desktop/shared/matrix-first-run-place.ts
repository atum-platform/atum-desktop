import type { MatrixSnapshot } from './matrix'
import { isAssistantRoom, matrixPrimaryAgent } from './matrix-assistant-room'

/**
 * Where the first run belongs: the new account's primary assistant chat, or the panel before that
 * chat exists. Synced account data remains the authority: only a welcome the account's record says
 * is `open` places (`firstRunWelcome`, written once by main for an account it found to be new,
 * matrix-first-run-eligibility.ts), and only while the folder answer is unanswered; unknown,
 * unevaluated, finished, dismissed and answered never become an offer, so an account that already
 * talks to its assistant is never shown a welcome above its history. The window draws the
 * assistant's welcome and connector card there, and every side that answers uses the same rule to know that the
 * person's first words answer it (first-run-naming.ts), so they never differ.
 *
 * It does not depend on where the assistant answers. A new account's primary is cloud-placed and
 * gets the same welcome and card as one answering on this Mac.
 */
export function matrixFirstRunPlace(snapshot: MatrixSnapshot, roomId?: string): boolean {
  const assistant = snapshot.assistant?.userId
  const primary = matrixPrimaryAgent(snapshot)

  if (
    !snapshot.firstRunOpen ||
    snapshot.firstRunWelcome !== 'open' ||
    snapshot.firstRunMarker !== 'unseen' ||
    !assistant ||
    (primary && primary.userId !== assistant)
  ) {
    return false
  }

  const chats = snapshot.rooms.filter(room => isAssistantRoom(room, snapshot.identity?.userId, assistant))

  return roomId ? chats.length === 1 && chats[0]!.id === roomId : chats.length === 0
}
