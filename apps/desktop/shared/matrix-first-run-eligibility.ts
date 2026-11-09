import type { MatrixSnapshot } from './matrix'
import { isAssistantRoom, matrixPrimaryAgent } from './matrix-assistant-room'

/**
 * Whether the account is new, for the first run's welcome. Main asks it once per account (the
 * evaluator in electron/matrix/first-run-welcome.ts) and writes the answer into the account's
 * welcome record (`io.atum.onboarding.first_run.v2`), which every device then follows: the welcome
 * and inline connector card belong to an account that has not started talking to its assistant,
 * never to one that has, whichever side answers and however long ago it signed up.
 *
 * - `existing`: the account already holds a folder answer (the first-run marker, from any device),
 *   or its primary assistant already has dialogue, or the person has more than one chat with it.
 *   The welcome is never offered; the record is written `done`.
 * - `new`: sync is complete, the primary is known, no folder answer exists, and the primary has no
 *   chat yet or one whose loaded history reaches its creation and holds no message. The record is
 *   written `open`, so every device agrees whether the greeting may open.
 * - `unknown`: anything that cannot be told yet (offline, not synced, no primary, a chat whose loaded
 *   history cannot say whether anyone has spoken). Nothing is written; unknown never means new.
 *
 * Dialogue is any message of either side, readable or not (`MatrixRoom.dialogue`).
 */
export type MatrixFirstRunEligibility = 'new' | 'existing' | 'unknown'

export function matrixFirstRunEligibility(snapshot: MatrixSnapshot): MatrixFirstRunEligibility {
  const owner = snapshot.identity?.userId
  const assistant = snapshot.assistant?.userId
  const primary = matrixPrimaryAgent(snapshot)

  if (snapshot.state !== 'ready' || snapshot.degraded || !owner || !assistant || (primary && primary.userId !== assistant)) {
    return 'unknown'
  }

  if (snapshot.firstRunMarker === 'answered') {
    return 'existing'
  }

  if (snapshot.firstRunMarker !== 'unseen') {
    return 'unknown'
  }

  const chats = snapshot.rooms.filter(room => isAssistantRoom(room, owner, assistant))

  if (chats.length > 1 || chats.some(room => room.dialogue === 'started')) {
    return 'existing'
  }

  return chats.some(room => room.dialogue === undefined) ? 'unknown' : 'new'
}
