/** Preserve user-visible identity, state and recovery behavior across connection changes. */
import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixContinuityRead } from '../../shared/matrix-continuity'
import { matrixFirstRunNamingNote, matrixFirstRunNoEarlierDialogue } from '../../shared/matrix-first-run-naming'
import { matrixFirstRunPlace } from '../../shared/matrix-first-run-place'

export { matrixFirstRunNamingNote }

/**
 * The hidden note for a message the person is typing on this Mac, or nothing. It belongs only to
 * the first message of the new account's primary assistant chat while the welcome is still on
 * screen: the empty chat the window shows the welcome in, with the first-run marker unanswered. A
 * reply, a message to any other room or agent, and every later message get nothing.
 */
export function matrixFirstRunNamingContext(input: {
  snapshot: MatrixSnapshot
  roomId: string
  /** The room's agent is the person's primary assistant (not another agent, not an app). */
  primary: boolean
  /** A reply carries its quote as context instead; it is never a first message. */
  replying: boolean
  /** The primary's current display name. */
  name: string | undefined
}): string | undefined {
  const { snapshot, roomId } = input

  if (
    !input.primary ||
    input.replying ||
    !input.name?.trim() ||
    snapshot.roomId !== roomId ||
    snapshot.messages.length > 0 ||
    !matrixFirstRunPlace(snapshot, roomId)
  ) {
    return undefined
  }

  return matrixFirstRunNamingNote(input.name)
}

/**
 * The hidden note for a message another device sent that this Mac answers from the room (the
 * phone's first reply to the welcome), or nothing. The window's selected room means nothing here,
 * so the first message is told by the room itself: `read` is its visible dialogue before the
 * message, and the welcome must still be open for the account (the same rule as the window).
 */
export function matrixFirstRunNamingForIncoming(input: {
  snapshot: MatrixSnapshot
  roomId: string
  primary: boolean
  name: string | undefined
  read: Pick<MatrixContinuityRead, 'entries' | 'reachedStop' | 'gaps' | 'uncertainAgent'>
}): string | undefined {
  if (
    !input.primary ||
    !input.name?.trim() ||
    !matrixFirstRunPlace(input.snapshot, input.roomId) ||
    !matrixFirstRunNoEarlierDialogue(input.read)
  ) {
    return undefined
  }

  return matrixFirstRunNamingNote(input.name)
}
