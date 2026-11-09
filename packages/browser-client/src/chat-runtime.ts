import { ClientEvent, MatrixClient } from 'matrix-js-sdk/lib/client'
import { EventType } from 'matrix-js-sdk/lib/@types/event'
import { TokenRefreshLogoutError } from 'matrix-js-sdk/lib/http-api/errors'
import type { Logger } from 'matrix-js-sdk/lib/logger'
import { EventStatus, type MatrixEvent } from 'matrix-js-sdk/lib/models/event'
import { Direction } from 'matrix-js-sdk/lib/models/event-timeline'
import { RoomEvent, type Room } from 'matrix-js-sdk/lib/models/room'
import { RoomMemberEvent } from 'matrix-js-sdk/lib/models/room-member'
import { RoomStateEvent } from 'matrix-js-sdk/lib/models/room-state'
import { IndexedDBStore } from 'matrix-js-sdk/lib/store/indexeddb'

import type { MatrixRoom } from '../../../apps/desktop/shared/matrix'
import { plainAgentRoom } from '../../../apps/desktop/shared/matrix-assistant-room'
import { createMatrixSyncHealth, matrixSyncTokenRefused } from '../../../apps/desktop/shared/matrix-sync-health'
import { BoundDevice } from './session'
import { BrowserFailure } from './record'
import type { BrowserChatMessage, BrowserChatSnapshot } from './chat-types'
import { createBrowserOwnProfile, type BrowserOwnProfiles } from './own-profile'

const INITIAL_EVENTS = 200
const PAGE_EVENTS = 50
const MAX_EVENTS = 2_200

const quietLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  getChild() {
    return quietLogger
  }
}

function roomProjection(room: Room): MatrixRoom {
  return {
    id: room.roomId,
    name: room.name || 'Atum',
    membership: room.getMyMembership(),
    encrypted: room.hasEncryptionStateEvent(),
    plainAgent: plainAgentRoom(room),
    roomType: room.getType()
  }
}

function shownContent(event: MatrixEvent): Record<string, unknown> {
  const replacement = event.replacingEvent()
  if (replacement && replacement.getSender() === event.getSender()) {
    const content = replacement.getContent()['m.new_content']
    if (content && typeof content === 'object' && !Array.isArray(content)) return content as Record<string, unknown>
  }
  return event.getContent()
}

function messageProjection(event: MatrixEvent, userId: string): BrowserChatMessage | null {
  const relation = event.getOriginalContent()['m.relates_to']
  if (
    event.getType() !== EventType.RoomMessage ||
    event.isEncrypted() ||
    (relation && typeof relation === 'object' && relation.rel_type === 'm.replace')
  )
    return null

  const id = event.getId() ?? ''
  const sender = event.getSender() ?? ''
  const own = sender === userId
  if (event.isRedacted() || event.localRedactionEvent()) {
    return {
      id,
      sender,
      body: '',
      timestamp: event.getTs(),
      own,
      encrypted: false,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false,
      redacted: true
    }
  }

  const content = shownContent(event)
  const transactionId = own ? event.getTxnId() ?? event.getUnsigned().transaction_id : undefined
  const msgtype = content.msgtype
  const attachment = ['m.audio', 'm.file', 'm.image', 'm.video'].includes(String(msgtype))

  return {
    id,
    sender,
    body: typeof content.body === 'string' ? content.body : '',
    timestamp: event.getTs(),
    own,
    ...(typeof transactionId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(transactionId)
      ? { matrixTransactionId: transactionId }
      : {}),
    encrypted: false,
    decryptionFailed: false,
    pending: [EventStatus.ENCRYPTING, EventStatus.QUEUED, EventStatus.SENDING].includes(event.status!),
    failed: event.status === EventStatus.NOT_SENT,
    ...(own && event.status === null && id.startsWith('$') ? { sent: true as const } : {}),
    attachment
  }
}

/**
 * Browser chat is deliberately a plain-room Matrix client. It does not start Rust
 * crypto, verification, recovery, the desktop command dispatcher, or an executor.
 */
export function startChatRuntime(device: BoundDevice, publish: (value: BrowserChatSnapshot) => void) {
  let client: MatrixClient | undefined
  let store: IndexedDBStore | undefined
  let identity: { userId: string; deviceId: string } | undefined
  let selectedRoomId: string | null = null
  let visibleEvents = INITIAL_EVENTS
  let state: BrowserChatSnapshot['state'] = 'connecting'
  let dirtyTimer: ReturnType<typeof setTimeout> | undefined
  let stopping: Promise<void> | undefined
  let stopped = false
  let profiles: BrowserOwnProfiles | undefined
  const network = new AbortController()
  // A reconnecting sync is a blip, not an outage (apps/desktop/shared/matrix-sync-health.ts): the
  // chat stays 'ready' through it and goes 'offline' only once the sync is stopped or has been
  // down past its grace (by timer: no sync event says so).
  const syncHealth = createMatrixSyncHealth({
    onChange: next => {
      if (!stopped && next === 'offline' && state === 'ready') {
        state = 'offline'
        snapshot()
      }
    }
  })

  const selectedRoom = () => {
    const room = selectedRoomId ? client?.getRoom(selectedRoomId) : null
    return room?.getMyMembership() === 'join' && plainAgentRoom(room) ? room : null
  }

  const snapshot = () => {
    if (stopped || !client || !identity) return
    const room = selectedRoom()
    const events = room?.getLiveTimeline().getEvents().slice(-visibleEvents) ?? []
    publish({
      state,
      identity,
      rooms: client
        .getRooms()
        .filter(value => ['join', 'invite'].includes(value.getMyMembership()))
        .map(roomProjection),
      roomId: room?.roomId ?? null,
      messages: room
        ? events
            .map(event => messageProjection(event, identity!.userId))
            .filter((value): value is BrowserChatMessage => value !== null)
        : [],
      typing:
        room
          ?.getJoinedMembers()
          .filter(member => member.userId !== identity!.userId && member.typing)
          .map(member => member.userId) ?? [],
      error: state === 'error' ? 'matrix_signed_out' : null
    })
  }

  const changed = () => {
    if (!dirtyTimer && !stopped) {
      dirtyTimer = setTimeout(() => {
        dirtyTimer = undefined
        snapshot()
      }, 40)
    }
  }

  const ready = (async () => {
    const configuration = device.configuration()
    identity = { userId: configuration.userId, deviceId: configuration.deviceId }
    const { storageKey: _unusedStorageKey, ...connection } = configuration
    store = new IndexedDBStore({
      indexedDB,
      localStorage,
      dbName: `sync-${encodeURIComponent(configuration.userId)}-${encodeURIComponent(configuration.deviceId)}`
    })
    let refreshing: Promise<Awaited<ReturnType<BoundDevice['refresh']>>> | undefined
    // Construct the pinned SDK's plain client directly. The package's browser
    // entrypoint installs a legacy crypto store even when crypto is never
    // initialized; this host has no encrypted-room surface.
    client = new MatrixClient({
      ...connection,
      store,
      disableVoip: true,
      logger: quietLogger,
      fetchFn: (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        const sync = url.pathname.endsWith('/sync')
        return fetch(input, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.any([
            network.signal,
            ...(init?.signal ? [init.signal] : []),
            ...(!sync ? [AbortSignal.timeout(30_000)] : [])
          ])
        })
      },
      tokenRefreshFunction: configuration.refreshToken
        ? async handle => {
            const result = await (refreshing ??= device.refresh(handle).finally(() => {
              refreshing = undefined
            }))
            if (result.ok)
              return {
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                ...(result.expiresAt ? { expiry: new Date(result.expiresAt) } : {})
              }
            if (result.reauthenticate) throw new TokenRefreshLogoutError(new Error('matrix_signed_out'))
            throw new Error('matrix_refresh_unavailable')
          }
        : undefined
    })
    profiles = createBrowserOwnProfile(
      client,
      () => !stopped,
      () => state === 'ready'
    )

    client.on(ClientEvent.Sync, (status, _previous, data) => {
      if (stopped) return
      state = syncHealth.observe(status, data) === 'offline' ? 'offline' : 'ready'
      if (matrixSyncTokenRefused(data)) state = 'error'
      snapshot()
    })
    client.on(ClientEvent.Room, changed)
    client.on(RoomEvent.Timeline, changed)
    client.on(RoomEvent.MyMembership, changed)
    client.on(RoomEvent.LocalEchoUpdated, changed)
    client.on(RoomEvent.Name, changed)
    client.on(RoomStateEvent.Events, changed)
    client.on(RoomStateEvent.Members, changed)
    client.on(RoomMemberEvent.Typing, changed)

    await store.startup()
    if (stopped) throw new BrowserFailure('signed_out')
    await client.startClient({ initialSyncLimit: 50 })
    if (stopped) throw new BrowserFailure('signed_out')
    await device.sdkStarted()
    snapshot()
  })()

  const command = async <T>(run: (sdk: MatrixClient) => Promise<T> | T): Promise<T> => {
    if (stopped) throw new BrowserFailure('signed_out')
    await ready
    if (stopped || !client) throw new BrowserFailure('signed_out')
    return run(client)
  }

  const requireRoom = (sdk: MatrixClient, roomId: string) => {
    const room = sdk.getRoom(roomId)
    if (state !== 'ready' || !room || room.getMyMembership() !== 'join' || !plainAgentRoom(room))
      throw new Error('matrix_room_unavailable')
    return room
  }

  return {
    ready,
    stop: (options: { clearStoredData?: boolean } = {}) =>
      (stopping ??= (async () => {
        stopped = true
        profiles?.stop()
        syncHealth.dispose()
        clearTimeout(dirtyTimer)
        network.abort()
        client?.stopClient()
        await ready.catch(() => undefined)
        profiles?.stop()
        if (options.clearStoredData) await store?.deleteAllData().catch(() => undefined)
        else await store?.save(true).catch(() => undefined)
      })()),
    profile: {
      open: (changed?: () => void) => {
        if (stopped || !profiles) throw new BrowserFailure('signed_out')
        return profiles.open(changed)
      }
    },
    select: (roomId: string) =>
      command(sdk => {
        requireRoom(sdk, roomId)
        selectedRoomId = roomId
        visibleEvents = INITIAL_EVENTS
        snapshot()
      }),
    send: (roomId: string, body: string, matrixTransactionId: string) =>
      command(async sdk => {
        const room = requireRoom(sdk, roomId)
        if (selectedRoomId !== roomId || !room.maySendMessage()) throw new Error('matrix_send_unavailable')
        const transactionEvent = () =>
          room
            .getLiveTimeline()
            .getEvents()
            .find(event => event.getTxnId() === matrixTransactionId)
        const existing = transactionEvent()
        if (
          existing?.getId()?.startsWith('$') &&
          (existing.status === EventStatus.SENT || existing.status === null)
        )
          return existing.getId()!
        if (existing?.status === EventStatus.NOT_SENT) return (await sdk.resendEvent(existing, room)).event_id
        if (existing) throw new Error('matrix_send_in_progress')
        // No MatrixScheduler is installed: one call makes one HTTP attempt. A
        // failed local echo stays only so an explicit retry can resend it with
        // the same transaction id; the durable outbox owns that user intent.
        return (await sdk.sendTextMessage(roomId, body, matrixTransactionId)).event_id
      }),
    attend: (_roomId: string | null) => Promise.resolve(),
    earlier: (roomId: string) =>
      command(async sdk => {
        const room = requireRoom(sdk, roomId)
        if (selectedRoomId !== roomId || visibleEvents >= MAX_EVENTS) return false
        const timeline = room.getLiveTimeline()
        const before = timeline.getEvents().length
        if (before <= visibleEvents && timeline.getPaginationToken(Direction.Backward) !== null)
          await sdk.scrollback(room, PAGE_EVENTS)
        if (stopped || selectedRoomId !== roomId) throw new BrowserFailure('signed_out')
        visibleEvents = Math.min(MAX_EVENTS, visibleEvents + PAGE_EVENTS)
        snapshot()
        return (
          visibleEvents < Math.min(MAX_EVENTS, timeline.getEvents().length) ||
          (visibleEvents < MAX_EVENTS && timeline.getPaginationToken(Direction.Backward) !== null)
        )
      })
  }
}

export type ChatRuntime = ReturnType<typeof startChatRuntime>
