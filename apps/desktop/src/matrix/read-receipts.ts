import { ClientEvent, type MatrixClient, type MatrixEvent, type Room, RoomEvent, type SyncState } from 'matrix-js-sdk'
import type { IRoomTimelineData } from 'matrix-js-sdk/lib/models/event-timeline-set'

import { matrixSyncApplied } from '../../shared/matrix-sync-health'

import { matrixRoomTimelineEvents } from './threads'

/** A burst (a reply arriving in parts, a quick back-and-forth) becomes one receipt. */
export const READ_SETTLE_MS = 300
/** A steady stream (a reply streamed by edits) is still acknowledged at least this often. */
export const READ_MAX_WAIT_MS = 2_000
/** A failed acknowledgement retries a few times, then waits for the next change. */
export const READ_RETRY_MS = [1_000, 4_000, 15_000] as const

/**
 * The newest event the server has given this room. Everything up to it is what the person
 * is looking at. Local echoes (`~` ids, or still sending) never count: a receipt must name
 * an event the server knows.
 *
 * `matrixRoomTimelineEvents` is the displayed window: ordinary-room SDK threads are flattened
 * into it, while Team Space replies stay in their panel and use per-thread receipts there.
 */
export function latestSettledEvent(room: Room): MatrixEvent | undefined {
  const settled = (event: MatrixEvent) => Boolean(event.getId()?.startsWith('$')) && event.status === null
  const events = matrixRoomTimelineEvents(room)
  let latest: MatrixEvent | undefined

  for (let index = events.length - 1; index >= 0; index--) {
    if (settled(events[index]!)) {
      latest = events[index]
      break
    }
  }

  return latest
}

/**
 * Whether this account's own receipt (public or private, never one the SDK synthesised
 * for a send) already covers the event. An unknown order is "not covered": acknowledging
 * again is harmless, a badge that never clears is not.
 */
export function readThrough(room: Room, userId: string, eventId: string): boolean {
  const upTo = room.getEventReadUpTo(userId, true)

  if (!upTo) {
    return false
  }

  if (upTo === eventId) {
    return true
  }

  const order = room.getUnfilteredTimelineSet().compareEventOrdering(upTo, eventId)

  return order !== null && order > 0
}

/**
 * Matrix's standard read state, as Element keeps it: while a conversation is on screen in a
 * focused window, the newest event in it is acknowledged with the fully-read marker and a
 * public read receipt (`m.read`) unless the person keeps their activity private (owner,
 * 2026-10-20; Settings › Privacy, on by default), in which case `m.read.private` is used.
 * The homeserver resets this account's unread counts from either receipt type, so the badge
 * and any alert clear on every device. Undecryptable or unordered events never hold it
 * back: the person has seen the timeline up to its newest event either way.
 *
 * One request at a time (the server never sees acknowledgements out of order), coalesced,
 * and retried when the newest event changed while one was in flight or the request failed.
 * The renderer says what is on screen (`attend`); nothing here guesses at visibility.
 */
export function matrixReadReceipts(
  client: MatrixClient,
  options: {
    /** The SDK's selected room. Receipts go only to the room the renderer also attends. */
    selected(): string | null
    /** Synced and not stopped. */
    ready(): boolean
    /** Whether other people may see this account read (the privacy setting). Always
     * false while it is off: the private receipt still clears the account's own badges. */
    shareActivity(): boolean
  }
) {
  let attention: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let firstAt = 0
  let inFlight = false
  let failures = 0
  let stopped = false
  // The last event acknowledged per room this session, until sync echoes the receipt back.
  const sent = new Map<string, string>()

  function due(): { room: Room; eventId: string } | undefined {
    const roomId = options.selected()

    if (stopped || !options.ready() || !roomId || attention !== roomId) {
      return undefined
    }

    const room = client.getRoom(roomId)

    if (!room || room.getMyMembership() !== 'join') {
      return undefined
    }

    const eventId = latestSettledEvent(room)?.getId()

    if (!eventId || sent.get(roomId) === eventId || readThrough(room, client.getSafeUserId(), eventId)) {
      return undefined
    }

    return { room, eventId }
  }

  function schedule(delay: number = READ_SETTLE_MS) {
    if (stopped) {
      return
    }

    const now = Date.now()

    if (timer === undefined) {
      firstAt = now
    } else {
      clearTimeout(timer)
    }

    // Each change postpones the receipt a little, but never past the burst's deadline.
    const at = Math.min(now + delay, firstAt + Math.max(delay, READ_MAX_WAIT_MS))
    timer = setTimeout(flush, Math.max(0, at - now))
  }

  function flush() {
    timer = undefined

    // The next check runs when this request settles.
    if (inFlight) {
      return
    }

    const target = due()

    if (!target) {
      return
    }

    const { room, eventId } = target
    const share = options.shareActivity()
    inFlight = true
    let failed = false

    // The standard request, not the SDK's optimistic wrapper: sync, not the request,
    // updates the projection. Shared activity sends the public `m.read` receipt; private
    // activity leaves it unset and names `m.read.private` instead.
    void client
      .setRoomReadMarkersHttpRequest(room.roomId, eventId, share ? eventId : undefined, share ? undefined : eventId)
      .then(
        () => {
          failures = 0
          sent.set(room.roomId, eventId)
        },
        () => {
          failed = true
          failures++
        }
      )
      .finally(() => {
        inFlight = false

        if (stopped) {
          return
        }

        if (failed) {
          if (failures <= READ_RETRY_MS.length) {
            schedule(READ_RETRY_MS[failures - 1])
          }

          return
        }

        // The newest event changed while this one was in flight (a streamed reply).
        if (due()) {
          schedule()
        }
      })
  }

  const timeline = (
    _event: MatrixEvent,
    room: Room | undefined,
    toStart: boolean | undefined,
    removed: boolean,
    data: IRoomTimelineData
  ) => {
    if (!toStart && !removed && data?.liveEvent && room?.roomId === options.selected()) {
      schedule()
    }
  }

  // A sent message gets its server id here; it is then the newest event in the room.
  const echo = (_event: MatrixEvent, room: Room) => {
    if (room.roomId === options.selected()) {
      schedule()
    }
  }

  // Back online: whatever arrived while the sync was down is acknowledged if it is on screen.
  // That is when a sync response has been applied again (matrix-sync-health.ts), not when the
  // state first reads alive: CATCHUP precedes the response that brings the messages.
  const sync = (next: SyncState, previous: SyncState | null) => {
    if (matrixSyncApplied(next) && !matrixSyncApplied(previous)) {
      schedule()
    }
  }

  client.on(RoomEvent.Timeline, timeline)
  client.on(RoomEvent.LocalEchoUpdated, echo)
  client.on(ClientEvent.Sync, sync)

  return {
    /** The conversation the person has on screen in a focused window, or none. */
    attend(roomId: string | null) {
      if (stopped || attention === roomId) {
        return
      }

      attention = roomId
      failures = 0

      if (roomId) {
        schedule()
      }
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      timer = undefined
      sent.clear()
      client.off(RoomEvent.Timeline, timeline)
      client.off(RoomEvent.LocalEchoUpdated, echo)
      client.off(ClientEvent.Sync, sync)
    }
  }
}
