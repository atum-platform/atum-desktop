import type { MatrixMessage, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { isFirstRunGreetingSeed } from '../../shared/matrix-first-run-greeting'

export { FIRST_RUN_GREETING_INTENT, firstRunGreetingSeed, isFirstRunGreetingSeed } from '../../shared/matrix-first-run-greeting'

/**
 * The first greeting is the assistant's own words (owner rule: no canned agent text). After the launch pick settles, the window
 * sends one internal opening intent from the owner to the primary assistant's main room; the assistant answers with its welcome
 * from the guidance in the Work provider (atum-app `feat/first-run-backend`, docs/session-logs/2026-11-27-first-run-backend.md).
 *
 * - The seed: `io.atum.first-run.greeting/1 en|vi`, optionally a space and the owner's display name (one line, ≤ 80 characters).
 * - It is never shown: the window drops it from the transcript and the chat list's preview.
 * - The assistant's answer to it renders like any message, with the Connections block right under it.
 * - Sent once per room from this Mac (a local marker); the assistant side suppresses a second one from another device.
 */
function hiddenSeed(message: Pick<MatrixMessage, 'own' | 'body'>): boolean {
  return message.own && isFirstRunGreetingSeed(message.body)
}

/**
 * The snapshot as the window draws it: the owner's seed is gone from the open chat and from every chat-list preview, and
 * `firstRunGreetingReplyId` names the assistant's answer to it (the first message from someone else after the seed).
 * Returns the same object when there is nothing to hide.
 */
export function withoutFirstRunGreetingSeed<T extends Pick<MatrixSnapshot, 'messages' | 'rooms'>>(
  snapshot: T
): T & { firstRunGreetingReplyId?: string } {
  const seedIndex = snapshot.messages.findIndex(hiddenSeed)
  const previewSeed = snapshot.rooms.some(room => room.preview?.own && isFirstRunGreetingSeed(room.preview.text))

  if (seedIndex < 0 && !previewSeed) {
    return snapshot
  }

  const reply = seedIndex < 0 ? undefined : snapshot.messages.slice(seedIndex + 1).find(message => !message.own)
  const rooms: MatrixRoom[] = previewSeed
    ? snapshot.rooms.map(room => {
        if (!(room.preview?.own && isFirstRunGreetingSeed(room.preview.text))) {
          return room
        }

        const { preview: _seed, ...rest } = room

        return rest as MatrixRoom
      })
    : snapshot.rooms

  return {
    ...snapshot,
    messages: snapshot.messages.filter(message => !hiddenSeed(message)),
    rooms,
    ...(reply ? { firstRunGreetingReplyId: reply.id } : {})
  }
}

const SENT_PREFIX = 'atum.first-run-greeting.v1:'

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function firstRunGreetingSent(roomId: string): boolean {
  try {
    return storage()?.getItem(SENT_PREFIX + roomId) === '1'
  } catch {
    return false
  }
}

function markSent(roomId: string): void {
  try {
    storage()?.setItem(SENT_PREFIX + roomId, '1')
  } catch {
    // Without the marker a later launch may try again; the assistant side suppresses the repeat.
  }
}

const inFlight = new Set<string>()

/**
 * Send the opening intent once for this room. `send` is the route the composer would use for this room (the local turn on this
 * Mac, else the ordinary Matrix send to the cloud-placed assistant). The marker is written before sending, so a crash or a second
 * window never sends twice from this Mac; a failed send clears it so the next launch can try again.
 */
export async function sendFirstRunGreetingOnce(roomId: string, seed: string, send: (body: string) => Promise<unknown>): Promise<'sent' | 'skipped' | 'failed'> {
  if (!isFirstRunGreetingSeed(seed) || inFlight.has(roomId) || firstRunGreetingSent(roomId)) {
    return 'skipped'
  }

  inFlight.add(roomId)
  markSent(roomId)

  try {
    await send(seed)

    return 'sent'
  } catch {
    try {
      storage()?.removeItem(SENT_PREFIX + roomId)
    } catch {
      // Nothing more to undo.
    }

    return 'failed'
  } finally {
    inFlight.delete(roomId)
  }
}

/** Tests only. */
export function resetFirstRunGreetingForTests(): void {
  inFlight.clear()
}
