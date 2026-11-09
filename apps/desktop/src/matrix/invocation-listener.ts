import {
  ClientEvent,
  Direction,
  EventType,
  type MatrixClient,
  MatrixEvent,
  MatrixEventEvent,
  RoomEvent
} from 'matrix-js-sdk'

import type { MatrixInvocationHint, MatrixInvocationScan, MatrixInvocationWatch } from '../../shared/matrix'
import { createMatrixSyncHealth } from '../../shared/matrix-sync-health'
import { matrixTurnIntake } from '../../shared/matrix-turn-intake'

import { knownPlainRoom, withJoinedWireType } from './plain-room'

const SCAN_PAGES = 4
const SCAN_PAGE_SIZE = 50

/**
 * The agent-room contract (matrix-turn-intake.ts): only a new top-level message starts a
 * turn; edits, reactions, redactions, deleted messages and threads never do. Read from the
 * content as first sent, never an edit's replacement. A pure reply is a new message: main
 * re-reads it, and the message it answers, through the owner's SDK and passes that message's
 * words to the assistant as context (invocation.ts); the cloud brain does the same with the
 * agent's own SDK. A watch with `threads` (the cloud brain) also hears a thread message, only
 * to answer it with a one-line notice: it never starts a turn.
 */
function isAdmissibleMessage(event: MatrixEvent, threads = false) {
  const intake = matrixTurnIntake({
    type: event.getType(),
    content: event.getOriginalContent(),
    wireRelation: event.getWireContent()['m.relates_to'],
    redacted: event.isRedacted()
  })

  const admitted = intake.turn || (threads && intake.reason === 'thread')

  return admitted && Boolean(event.getId()?.startsWith('$'))
}

/** The rooms one watch covers: the cloud brain's whole room set, or its one room. */
function watchedRooms(watch: MatrixInvocationWatch): string[] {
  return watch.roomIds?.length ? watch.roomIds : [watch.roomId]
}

/**
 * The wire type a joined room's messages count as: plaintext only in a room without end-to-end
 * encryption by its synced state and its crypto store both (every room 0.20 makes; owner
 * decisions D1 and D2; plain-room.ts), ciphertext everywhere else. A message that arrives any
 * other way is never a hint (no downgrade). Null when this account is not in the room. Hints
 * only: main and the cloud brain re-read every hint (read-invocation.ts), where the room's own
 * admission decides whether it may start a turn.
 */
async function joinedWireType(client: MatrixClient, roomId: string): Promise<string | null> {
  const room = client.getRoom(roomId)

  if (room?.getMyMembership() !== 'join') {
    return null
  }

  // No answer from the store in time fails the scan (main retries it with its backoff), never a
  // scan of ciphertext only that would report a plain room's window empty, or an "incomplete"
  // that would stop listening until the owner resumes it.
  return (await knownPlainRoom(client, room, 'matrix_invocation_scan_invalid'))
    ? EventType.RoomMessage
    : EventType.RoomMessageEncrypted
}

/** A live event worth holding on to while `joinedWireType` is asked: in a joined room, encrypted,
 * or plaintext where the room shows no encryption state. */
function candidateWire(client: MatrixClient, event: MatrixEvent): boolean {
  const room = client.getRoom(event.getRoomId() ?? '')

  return (
    room?.getMyMembership() === 'join' &&
    (event.getWireType() === EventType.RoomMessageEncrypted ||
      (event.getWireType() === EventType.RoomMessage && !room.hasEncryptionStateEvent()))
  )
}

/**
 * Read a deliberately small server tail for automatic recovery. This is only
 * transport discovery: main fetches every returned event again and applies
 * device trust, addressing, ownership and dispatch-fence checks.
 *
 * A page cap, malformed page, pagination loop, membership change, or failed
 * decrypt is evidence that this is not a complete recovery window. We never
 * convert that uncertainty into an empty/complete result.
 */
export async function scanMatrixInvocations(
  client: MatrixClient,
  watch: MatrixInvocationWatch
): Promise<MatrixInvocationScan> {
  const windowStart = watch.automatic?.windowStart
  const wireType = await joinedWireType(client, watch.roomId)

  if (typeof windowStart !== 'number' || !Number.isFinite(windowStart) || !wireType) {
    throw new Error('matrix_invocation_scan_invalid')
  }

  const candidates: Array<{ eventId: string; timestamp: number }> = []
  const seen = new Set<string>()
  const tokens = new Set<string>()
  let from: string | null = null
  let complete = false
  let undecryptable = false
  let coverageCertain = true

  for (let page = 0; page < SCAN_PAGES && !complete; page++) {
    const batch = await client.createMessagesRequest(watch.roomId, from, SCAN_PAGE_SIZE, Direction.Backward)

    if (!Array.isArray(batch.chunk) || batch.chunk.length > SCAN_PAGE_SIZE) {
      throw new Error('matrix_invocation_scan_invalid')
    }

    let pageHasUnknownTimestamp = false
    let newestTimestamp = Number.NEGATIVE_INFINITY

    for (const raw of batch.chunk) {
      const event = new MatrixEvent(raw)
      const timestamp = event.getTs()

      if (!Number.isFinite(timestamp)) {
        pageHasUnknownTimestamp = true
        coverageCertain = false
      } else {
        newestTimestamp = Math.max(newestTimestamp, timestamp)
      }

      // A /messages response is expected to be room-scoped. A discrepant
      // message cannot be trusted as either a candidate or coverage proof.
      if (event.getRoomId() !== watch.roomId && raw?.type === wireType) {
        pageHasUnknownTimestamp = true
        coverageCertain = false

        continue
      }

      if (
        raw?.type !== wireType ||
        event.getSender() !== watch.sender.userId ||
        event.isRedacted() ||
        !Number.isFinite(timestamp) ||
        timestamp < windowStart
      ) {
        continue
      }

      const eventId = event.getId()

      if (!eventId?.startsWith('$') || seen.has(eventId)) {
        continue
      }

      seen.add(eventId)

      try {
        if (wireType === EventType.RoomMessageEncrypted) {
          await client.decryptEventIfNeeded(event)
        }
      } catch {
        undecryptable = true

        continue
      }

      if (event.isDecryptionFailure()) {
        undecryptable = true

        continue
      }

      if (isAdmissibleMessage(event, watch.threads === true)) {
        candidates.push({ eventId, timestamp })
      }
    }

    if (!batch.end) {
      complete = true
    } else if (batch.chunk.length > 0 && !pageHasUnknownTimestamp && newestTimestamp < windowStart) {
      // Every event in this already-backward page predates the lower bound;
      // following pages cannot add an automatic-recovery candidate.
      complete = true
    } else if (tokens.has(batch.end)) {
      complete = false

      break
    } else {
      tokens.add(batch.end)
      from = batch.end
    }
  }

  // A changed membership/encryption state invalidates both the candidates and
  // any coverage conclusion reached while paging/decrypting.
  if ((await joinedWireType(client, watch.roomId)) !== wireType) {
    return { hints: [], complete: false, undecryptable }
  }

  candidates.sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId))

  return {
    hints: candidates.map(({ eventId }) => ({ watchId: watch.id, roomId: watch.roomId, eventId })),
    complete: complete && coverageCertain && !undecryptable,
    undecryptable
  }
}

/** Everything but the end: one watch, whose end a renewal may move later. */
function sameWatch(a: MatrixInvocationWatch, b: MatrixInvocationWatch): boolean {
  return (
    a.id === b.id &&
    a.roomId === b.roomId &&
    watchedRooms(a).join('\n') === watchedRooms(b).join('\n') &&
    a.threads === b.threads &&
    a.since === b.since &&
    a.sender.userId === b.sender.userId &&
    a.sender.deviceId === b.sender.deviceId &&
    a.automatic?.windowStart === b.automatic?.windowStart
  )
}

/** SDK live-timeline admission only. Main re-fetches and verifies every hint.
 * No timeline scan, startup catch-up, persisted cursor or execution queue here. */
export function watchMatrixInvocations(client: MatrixClient, offer: (hint: MatrixInvocationHint) => void) {
  let watch: MatrixInvocationWatch | null = null
  let generation = 0
  let candidates = new WeakMap<MatrixEvent, number>()
  let emitted = new WeakSet<MatrixEvent>()

  const drop = () => {
    watch = null
    generation++
    candidates = new WeakMap()
  }

  // A reconnecting or briefly failing sync keeps the watch and what it has seen (the first
  // response after the blip brings the messages that matter); only an outage that outlasts its
  // grace, a stopped client or a refused token drops them (matrix-sync-health.ts).
  const health = createMatrixSyncHealth({
    // An outage with no further sync event (the keep-alive polls a dead network) ends by timer.
    onChange: next => {
      if (next === 'offline') {
        drop()
      }
    }
  })

  const live = (event: MatrixEvent) =>
    watch &&
    health.current() !== 'offline' &&
    Date.now() < watch.until &&
    watchedRooms(watch).includes(event.getRoomId()!) &&
    event.getSender() === watch.sender.userId &&
    (watch.automatic
      ? event.getTs() >= watch.automatic.windowStart
      : event.localTimestamp > watch.since && event.localTimestamp <= Date.now() && event.getLocalAge() <= 120_000) &&
    candidateWire(client, event) &&
    event.status === null &&
    !event.isRedacted()

  const decrypted = (event: MatrixEvent) => {
    if (
      !live(event) ||
      !watch ||
      candidates.get(event) !== generation ||
      emitted.has(event) ||
      event.isDecryptionFailure()
    ) {
      return
    }

    if (!isAdmissibleMessage(event, watch.threads === true)) {
      return
    }

    const roomId = event.getRoomId()!
    const seen = generation

    // Membership and encryption are read again (the crypto store too): the room may have
    // changed since arrival. A store that does not answer in time passes the hint on: main reads
    // it again (read-invocation.ts), which asks the store again and fails, to be retried, if
    // it still cannot tell.
    emitted.add(event)
    withJoinedWireType(client, roomId, wire => {
      if ((wire === event.getWireType() || wire === undefined) && seen === generation && watch && live(event)) {
        offer({ watchId: watch.id, roomId, eventId: event.getId()! })
      }
    })
  }

  const timeline = (
    event: MatrixEvent,
    _room: unknown,
    toStart: boolean | undefined,
    removed: boolean,
    data: { liveEvent?: boolean; fromCache?: boolean }
  ) => {
    if (toStart || removed || !data.liveEvent || data.fromCache || !live(event) || !watch) {
      return
    }

    candidates.set(event, generation)
    decrypted(event)

    if (event.getWireType() !== EventType.RoomMessageEncrypted) {
      // A plain message (a room without encryption) is offered above, as it arrived.
      return
    }

    // SDK timeline receipt does not guarantee eager decryption (especially in
    // the hidden agent host). Use its existing crypto path, including key retry.
    void client.decryptEventIfNeeded(event).then(
      () => decrypted(event),
      () => {}
    )
  }

  const sync = (state: string, _previous?: unknown, data?: unknown) => {
    if (health.observe(state, data) === 'offline') {
      drop()
    }
  }

  client.on(ClientEvent.Sync, sync)
  client.on(RoomEvent.Timeline, timeline)
  client.on(MatrixEventEvent.Decrypted, decrypted)

  return {
    set(value: MatrixInvocationWatch | null) {
      // The same watch with a later end: its credential was renewed (main's
      // credential-renewal.ts). What it has seen and is still decrypting stays.
      if (value && watch && sameWatch(value, watch) && value.until >= watch.until) {
        watch = value

        return
      }

      watch = value
      generation++
      candidates = new WeakMap()
      emitted = new WeakSet()
    },
    stop() {
      watch = null
      health.dispose()
      client.off(ClientEvent.Sync, sync)
      client.off(RoomEvent.Timeline, timeline)
      client.off(MatrixEventEvent.Decrypted, decrypted)
    }
  }
}
