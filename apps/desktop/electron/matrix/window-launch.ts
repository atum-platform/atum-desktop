import { MATRIX_AGENT_TASK_ROOM_TYPE } from '../../shared/agent-task'
import type { MatrixIdentity, MatrixSnapshot } from '../../shared/matrix'

/**
 * How the window opens . The compact sign-in
 * window is only for a Mac with no account; a saved account opens on its launch in the
 * product window, and nobody sees a screen or a size that the next frame takes back.
 */

/**
 * The account saved on this Mac, for the window's first snapshot: none when nobody is
 * signed in, while a sign-out is still finishing, or when the vault cannot be read (the
 * start reports that itself, as it always has).
 */
export function matrixSavedIdentity(account: {
  identity(): MatrixIdentity | null
  signOutPending(): boolean
}): MatrixIdentity | null {
  try {
    return account.signOutPending() ? null : account.identity()
  } catch {
    return null
  }
}

/**
 * Whether the account saved here is one whose chat session the sign-in server ended
 * (account.sessionEnded): the window then opens on the compact sign-in, saying so, and the
 * chat engine is not started. False when the vault cannot be read (the start reports that).
 */
export function matrixEndedSession(account: { sessionEnded(): unknown }): boolean {
  try {
    return Boolean(account.sessionEnded())
  } catch {
    return false
  }
}

/**
 * The person's SDK snapshot as main publishes it. An engine that could not start reports no
 * identity (`matrix_sdk_start_failed`, sdk-host-serve.ts), but the account is still this
 * Mac's: the snapshot keeps the host's identity, so the window says its chats can't be
 * reached (with Try again) instead of offering the sign-in that would be refused anyway.
 */
export function matrixHumanSnapshot(snapshot: MatrixSnapshot, identity: MatrixIdentity): MatrixSnapshot {
  const value = snapshot.identity ? snapshot : { ...snapshot, identity }
  const rooms = value.rooms.filter(room => room.roomType !== MATRIX_AGENT_TASK_ROOM_TYPE)

  return rooms.length === value.rooms.length ? value : { ...value, rooms }
}

/**
 * Whether the window has chosen its size: the renderer's first window-mode request, sent as
 * soon as main's first snapshot is drawn. `wait(ms)` settles once it has (at once if it
 * already did) or after `ms` whatever happens, so the window is shown at the size of its
 * first screen, and always shown.
 */
export function matrixWindowChoice(): { chosen(): void; wait(ms: number): Promise<void> } {
  let made = false
  let release: (() => void) | undefined

  return {
    chosen: () => {
      made = true
      release?.()
    },
    wait: ms =>
      made
        ? Promise.resolve()
        : new Promise<void>(resolve => {
            const done = () => {
              clearTimeout(timer)
              release = undefined
              resolve()
            }

            const timer = setTimeout(done, ms)
            release = done
          })
  }
}
