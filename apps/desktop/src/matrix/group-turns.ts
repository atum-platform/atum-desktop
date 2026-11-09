import { ClientEvent, EventType, type MatrixClient, type MatrixEvent, MatrixEventEvent, RoomEvent } from 'matrix-js-sdk'

import type { MatrixGroupWatch, MatrixInvocationHint } from '../../shared/matrix'
import { MATRIX_GROUP_WATCH_ID } from '../../shared/matrix-group-room'
import { createMatrixSyncHealth } from '../../shared/matrix-sync-health'
import { matrixTurnIntake } from '../../shared/matrix-turn-intake'

import { isMatrixPrivateChat } from './assistant-room'
import { GROUP_CHAIN_KEY, parseGroupChain } from './group-chain-publish'
import { withJoinedWireType } from './plain-room'

/** How old a live message may be when it is offered: the age main accepts too (invocation.ts). */
const LIVE_MS = 120_000

/**
 * The words of a new message the way the agent-room contract reads them
 * (shared/matrix-turn-intake.ts): only a new top-level message or a pure reply, never an edit,
 * a reaction, a thread or a deleted message.
 */
function intake(event: MatrixEvent) {
  return matrixTurnIntake({
    type: event.getType(),
    content: event.getOriginalContent(),
    wireRelation: event.getWireContent()['m.relates_to'],
    redacted: event.isRedacted()
  })
}

/**
 * An agent host's watch over its groups (owner-only assistants in groups, 2026-10-06). The
 * owner's new text in an ordinary group this agent is in becomes a hint to main (watch id
 * `group`): encrypted in a group with end-to-end encryption, as sent in one without (every group
 * since 0.20), and never a plaintext message in an encrypted group (no downgrade). Main reads
 * the owner's policy and chooses the deterministic floor.
 * A named, stamped continuation from another own assistant is also a hint. Other members,
 * unstamped assistant messages, this agent's own messages, private/app/company rooms,
 * edits and reactions never are.
 *
 * Hints only, never authority. Main re-reads each one through the owner's SDK and checks the
 * room, the sender and their verified device, the addressing and its age, and claims it once
 * on the ledger before anything runs (electron/matrix/invocation.ts). No scan, cursor or
 * queue here: messages from before the watch (or while this host was away) are not offered.
 */
export function watchMatrixGroupTurns(client: MatrixClient, offer: (hint: MatrixInvocationHint) => void) {
  let watch: MatrixGroupWatch | null = null
  // A reconnecting sync is not an outage (matrix-sync-health.ts): the watch hears the first
  // response after a blip, which arrives while the state is still CATCHUP.
  const health = createMatrixSyncHealth()
  let candidates = new WeakSet<MatrixEvent>()
  let emitted = new WeakSet<MatrixEvent>()

  /** An ordinary group this agent is in, with or without encryption: no room type
   * (shared/matrix-group-room.ts), and not a direct chat of two (an older private chat). */
  const group = (roomId: string | undefined) => {
    const room = roomId ? client.getRoom(roomId) : null

    return room?.getMyMembership() === 'join' && !room.getType() && !isMatrixPrivateChat(client, room) ? room : null
  }

  /** A wire type worth holding on to: encrypted, or plaintext in a room that shows no encryption
   * state. The final word is `withJoinedWireType`, before the hint is offered. */
  const candidateWire = (event: MatrixEvent) =>
    event.getWireType() === EventType.RoomMessageEncrypted ||
    (event.getWireType() === EventType.RoomMessage &&
      client.getRoom(event.getRoomId() ?? '')?.hasEncryptionStateEvent() === false)

  const live = (event: MatrixEvent) =>
    Boolean(watch) &&
    health.current() !== 'offline' &&
    (event.getSender() === watch!.owner || (event.getSender() !== client.getUserId() && Boolean(watch!.agentIds?.includes(event.getSender()!)))) &&
    candidateWire(event) &&
    event.status === null &&
    !event.isRedacted() &&
    event.localTimestamp > watch!.since &&
    event.localTimestamp <= Date.now() &&
    event.getLocalAge() <= LIVE_MS

  const decrypted = (event: MatrixEvent) => {
    if (!live(event) || !candidates.has(event) || emitted.has(event) || event.isDecryptionFailure()) {
      return
    }

    const read = intake(event)

    if (
      !read.turn ||
      event.getOriginalContent().msgtype !== 'm.text' ||
      !event.getId()?.startsWith('$') ||
      !group(event.getRoomId())
    ) {
      return
    }

    const mentions: unknown = event.getOriginalContent()['m.mentions']?.user_ids
    if (event.getSender() !== watch!.owner && (!parseGroupChain(event.getOriginalContent()[GROUP_CHAIN_KEY]) ||
      !Array.isArray(mentions) || !mentions.includes(client.getUserId() ?? ''))) {return}

    emitted.add(event)
    // The final word on the wire type: plaintext only where the crypto store agrees too. A store
    // that does not answer in time passes the hint on (main reads it again, read-invocation.ts).
    withJoinedWireType(client, event.getRoomId()!, wire => {
      if ((wire === event.getWireType() || wire === undefined) && live(event) && group(event.getRoomId())) {
        offer({ watchId: MATRIX_GROUP_WATCH_ID, roomId: event.getRoomId()!, eventId: event.getId()! })
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
    if (toStart || removed || !data.liveEvent || data.fromCache || !live(event) || !group(event.getRoomId())) {
      return
    }

    candidates.add(event)
    decrypted(event)
    // A hidden agent host does not decrypt eagerly: use the SDK's own crypto path.
    void client.decryptEventIfNeeded(event).then(
      () => decrypted(event),
      () => {}
    )
  }

  const sync = (state: string, _previous?: unknown, data?: unknown) => {
    health.observe(state, data)
  }

  client.on(ClientEvent.Sync, sync)
  client.on(RoomEvent.Timeline, timeline)
  client.on(MatrixEventEvent.Decrypted, decrypted)

  return {
    set(value: MatrixGroupWatch | null) {
      // A roster refresh keeps the same live window and its pending decryptions/exact-once
      // hints. A new host window or owner still starts empty and never scans old messages.
      if (!watch || !value || watch.owner !== value.owner || watch.since !== value.since) {
        candidates = new WeakSet()
        emitted = new WeakSet()
      }

      watch = value
      // Armed after the first sync: the next sync event would say so too, a little later.
      sync(String(client.getSyncState() ?? ''))
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
