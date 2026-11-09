import { ClientEvent, EventType, type MatrixClient, type MatrixEvent, MatrixEventEvent, RoomEvent } from 'matrix-js-sdk'

import { AGENT_ONE_CONVERSATION } from '../../shared/agent-conversation/enabled'
import type { MatrixGroupWatch, MatrixInvocationHint } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import { createMatrixSyncHealth } from '../../shared/matrix-sync-health'
import { matrixTurnIntake } from '../../shared/matrix-turn-intake'

import { withJoinedWireType } from './plain-room'

/** Hints only: main re-reads the private pair, owner device, marker and lease.
 * This watch never offers a model turn or scans history.
 *
 * The owner's message is heard as the room sends: encrypted in an assistant room with end-to-end
 * encryption, as sent in a plain one (0.20 agent chats; plain by its synced state and its crypto
 * store both, plain-room.ts), and never a plaintext message in an encrypted room (no downgrade),
 * the same per-room rule as the invocation listener. So the closed-room notice still reaches an
 * owner writing in an earlier plain chat. */
export function watchEarlierConversations(client: MatrixClient, offer: (hint: MatrixInvocationHint) => void) {
  let watch: MatrixGroupWatch | null = null
  // A reconnecting sync is not an outage (matrix-sync-health.ts): the watch hears the first
  // response after a blip, which arrives while the state is still CATCHUP.
  const health = createMatrixSyncHealth()
  let pending = new WeakSet<MatrixEvent>()
  let emitted = new WeakSet<MatrixEvent>()
  const live = (event: MatrixEvent) =>
    AGENT_ONE_CONVERSATION &&
    health.current() !== 'offline' &&
    watch &&
    event.getSender() === watch.owner &&
    (event.getWireType() === EventType.RoomMessageEncrypted ||
      (event.getWireType() === EventType.RoomMessage &&
        client.getRoom(event.getRoomId()!)?.hasEncryptionStateEvent() === false)) &&
    event.status === null &&
    !event.isRedacted() &&
    event.localTimestamp > watch.since &&
    event.localTimestamp <= Date.now() &&
    event.getLocalAge() <= 120_000 &&
    client.getRoom(event.getRoomId()!)?.getType() === MATRIX_ASSISTANT_ROOM_TYPE
  const decrypted = (event: MatrixEvent) => {
    if (!live(event) || !pending.has(event) || emitted.has(event) || event.isDecryptionFailure()) {
      return
    }
    const intake = matrixTurnIntake({
      type: event.getType(),
      content: event.getOriginalContent(),
      wireRelation: event.getWireContent()['m.relates_to'],
      redacted: event.isRedacted()
    })
    if (!intake.turn || event.getOriginalContent().msgtype !== 'm.text' || !event.getId()?.startsWith('$')) {
      return
    }
    emitted.add(event)
    // The final word on the wire type: plaintext only where the crypto store agrees too. A store
    // that does not answer in time passes the hint on (main reads it again, read-invocation.ts).
    withJoinedWireType(client, event.getRoomId()!, wire => {
      if ((wire === event.getWireType() || wire === undefined) && live(event)) {
        offer({ watchId: 'earlier', roomId: event.getRoomId()!, eventId: event.getId()! })
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
    if (toStart || removed || !data.liveEvent || data.fromCache || !live(event)) {
      return
    }
    pending.add(event)
    decrypted(event)
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
    set(next: MatrixGroupWatch | null) {
      if (next?.owner !== watch?.owner || next?.since !== watch?.since) {
        pending = new WeakSet()
        emitted = new WeakSet()
      }
      watch = next
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
