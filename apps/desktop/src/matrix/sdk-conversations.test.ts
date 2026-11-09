import {
  ClientEvent,
  createClient,
  Direction,
  EventStatus,
  EventType,
  type MatrixClient,
  MatrixEvent,
  MatrixEventEvent,
  Method,
  NotificationCountType,
  PushRuleActionName,
  Room,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  SyncState,
  ThreadEvent,
  TweakName
} from 'matrix-js-sdk'
import type * as MatrixSdk from 'matrix-js-sdk'
import { CryptoEvent, DecryptionFailureCode, EventShieldColour } from 'matrix-js-sdk/lib/crypto-api'
import { afterEach, expect, it, vi } from 'vitest'

import { matrixTurnsNeedingHost } from '../../electron/matrix/agent-routing'
import { assistantRooms } from '../../electron/matrix/assistant-policy'
import { MatrixCompanyPrivateCosNotificationAuthority } from '../../electron/matrix/company-private-cos-notification-authority'
import { matrixHostEndsTurns, matrixHostLiveness, matrixLeaseHostAction } from '../../electron/matrix/host-health'
import { MatrixExecutorLease } from '../../electron/matrix/lease'
import { createMatrixNotifications } from '../../electron/matrix/notifications'
import { CONVERSATION_STATE_TYPE, EarlierConversationError } from '../../shared/agent-conversation'
import { DEFAULT_DESKTOP_LOCALE, desktopLocaleFor } from '../../shared/desktop-locale'
import type { MatrixNotificationHint, MatrixSdkCommand, MatrixSnapshot } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import {
  MATRIX_COMPANY_CHANNEL_BINDING,
  MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
  MATRIX_COMPANY_CHANNEL_TYPE
} from '../../shared/matrix-company-channel-room'
import { MATRIX_DISPLAY_EVENTS } from '../../shared/matrix-display-preferences'
import { MATRIX_NOTES_SELF_ACCOUNT_DATA, MATRIX_NOTES_SELF_ROOM_TYPE } from '../../shared/matrix-notes-self'
import { MATRIX_SYNC_GRACE_MS } from '../../shared/matrix-sync-health'
import { DEFAULT_CONTEXT_LIMITS } from '../../shared/room-participation'
import type { GroupRecentTarget } from '../../shared/room-participation/recent'

import { conversationRoom } from './conversations'
import { boundedMatrixFetch } from './media'
import { READ_SETTLE_MS } from './read-receipts'
import { publicReaders } from './read-state'
import { roomSelection } from './room-navigation'
import {
  MATRIX_ASSISTANT_INVITE_WAIT_MS,
  MATRIX_ASSISTANT_POST_CREATE_SETTLE_MS,
  startMatrixSdk
} from './sdk'
import { connectMatrixSdk } from './sdk-host-queue'
import { serveMatrixSdk } from './sdk-host-serve'
import { MATRIX_TIMELINE_KEY_RETRY_MS } from './timeline-key-retry'

vi.mock('matrix-js-sdk', async importOriginal => {
  const actual = await importOriginal<typeof MatrixSdk>()

  return {
    ...actual,
    createClient: vi.fn(),
    IndexedDBStore: class extends actual.MemoryStore {
      async startup() {}
      async save() {}
    }
  }
})

const alice = '@alice:test'
const bob = '@bob:test'
const stops: Array<() => Promise<void>> = []

it('projects SDK backup availability without accepting trust, then closes on a failed read', async () => {
  const f = await fixture()
  const read = vi.fn().mockResolvedValue({ version: '1' })
  Object.assign(f.client.getCrypto()!, { getKeyBackupInfo: read })
  expect(f.latest().security?.backupAvailable).toBe(false)
  f.client.emit(CryptoEvent.KeyBackupStatus, true)
  await vi.waitFor(() => expect(f.latest().security?.backupAvailable).toBe(true))
  expect(f.client.getCrypto()!.globalBlacklistUnverifiedDevices).toBe(true)
  read.mockRejectedValue(new Error('synthetic_backup_unavailable'))
  f.client.emit(CryptoEvent.KeyBackupStatus, false)
  await vi.waitFor(() => expect(f.latest().security?.backupAvailable).toBe(false))
  expect(f.client.getCrypto()!.globalBlacklistUnverifiedDevices).toBe(true)
})

it('retires pending backup reads with the actual SDK session and never publishes a late result', async () => {
  const f = await fixture()
  const pending = deferred<{ version: string }>()
  const read = vi.fn(() => pending.promise)
  Object.assign(f.client.getCrypto()!, { getKeyBackupInfo: read })
  f.client.emit(CryptoEvent.KeyBackupStatus, true)
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
  await f.sdk.stop()
  const published = f.snapshots.length
  pending.resolve({ version: '1' })
  await pending.promise
  f.client.emit(CryptoEvent.KeyBackupStatus, true)
  await new Promise(resolve => setTimeout(resolve, 60))
  expect(read).toHaveBeenCalledOnce()
  expect(f.snapshots).toHaveLength(published)
})

it('projects one missing-key display retry through the actual SDK without changing its timeline or trust', async () => {
  vi.useFakeTimers()

  try {
    const f = await fixture()
    const selected = f.client.getRoom('!first:test')!

    const event = new MatrixEvent({
      type: EventType.RoomMessageEncrypted, event_id: '$missing', room_id: selected.roomId, sender: bob,
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'unchanged-fixture' }
    })

    vi.spyOn(event, 'isDecryptionFailure').mockReturnValue(true)
    vi.spyOn(event, 'decryptionFailureReason', 'get').mockReturnValue(DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID)
    await selected.addLiveEvents([event], { addToState: true })
    const decrypt = vi.spyOn(f.client, 'decryptEventIfNeeded').mockImplementation(retry => decryptReportFixture(retry))
    await f.sdk.command({ kind: 'select', roomId: selected.roomId })
    expect(f.latest().messages).toContainEqual(expect.objectContaining({ id: '$missing', decryptionReason: 'waiting_for_key', body: '' }))
    await vi.advanceTimersByTimeAsync(MATRIX_TIMELINE_KEY_RETRY_MS + 40)
    expect(f.latest().messages).toContainEqual(expect.objectContaining({ id: '$missing', decryptionFailed: false, body: 'private fixture body' }))
    expect(decrypt).toHaveBeenCalledOnce()
    expect(decrypt.mock.calls[0][0]).not.toBe(event)
    expect(decrypt.mock.calls[0][0].getWireContent()).toEqual(event.getWireContent())
    expect(selected.findEventById('$missing')).toBe(event)
    expect(event.isDecryptionFailure()).toBe(true)
    expect(f.client.getCrypto()!.globalBlacklistUnverifiedDevices).toBe(true)
    await vi.advanceTimersByTimeAsync(10 * MATRIX_TIMELINE_KEY_RETRY_MS)
    expect(decrypt).toHaveBeenCalledOnce()
    await f.sdk.stop()
  } finally {
    vi.useRealTimers()
  }
})

async function groupRecentFixture() {
  const f = await fixture()

  const target: GroupRecentTarget = {
    roomId: '!first:test', ownerId: alice, viewerAgentId: '@assistant:test',
    ownAgentIds: ['@assistant:test'], excludeEventId: '$trigger', window: 'meeting', limits: DEFAULT_CONTEXT_LIMITS
  }

  const state = [
    { type: EventType.RoomCreate, state_key: '', content: {} },
    { type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'joined' } },
    ...[alice, target.viewerAgentId].map(state_key => ({
      type: EventType.RoomMember, state_key, content: { membership: 'join' }
    }))
  ]

  const roomState = vi.spyOn(f.client, 'roomState').mockResolvedValue(state as never)

  const page = vi.spyOn(f.client, 'createMessagesRequest').mockResolvedValue({
    chunk: [{
      event_id: '$recent', room_id: target.roomId, sender: alice, origin_server_ts: 1000,
      type: EventType.RoomMessageEncrypted,
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'fixture' }
    }]
  } as never)

  Object.assign(f.client.getCrypto()!, {
    getUserDeviceInfo: vi.fn(async () => new Map([[alice, new Map([['DEVICE', {
      deviceId: 'DEVICE', getIdentityKey: () => 'fixture', getFingerprint: () => 'fixture'
    }]])]])),
    getDeviceVerificationStatus: vi.fn(async () => ({ isVerified: () => true })),
    getEncryptionInfoForEvent: vi.fn(async () => ({ shieldColour: EventShieldColour.NONE, shieldReason: null }))
  })
  vi.spyOn(f.client, 'decryptEventIfNeeded').mockImplementation(event => decryptReportFixture(event))

  return { ...f, target, state, roomState, page }
}

it('routes recent context through the real owner SDK only while ready, with fresh group state and verified events', async () => {
  const f = await groupRecentFixture()
  const command = { kind: 'readGroupRecent' as const, ...f.target }
  await expect(f.sdk.command(command)).rejects.toThrow('matrix_room_unreadable')
  expect(f.roomState).not.toHaveBeenCalled()
  expect(f.page).not.toHaveBeenCalled()

  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  await expect(f.sdk.command(command)).resolves.toMatchObject({
    roomId: f.target.roomId, viewerAgentId: f.target.viewerAgentId,
    context: { status: 'ok', lines: [{ eventId: '$recent', trust: 'owner', text: 'private fixture body' }] }
  })
  expect(f.roomState).toHaveBeenCalledTimes(2)
  expect(f.page).toHaveBeenCalledExactlyOnceWith(f.target.roomId, null, 50, Direction.Backward)

  f.state.push({ type: EventType.RoomMember, state_key: bob, content: { membership: 'join' } })
  await expect(f.sdk.command(command)).rejects.toThrow('matrix_group_room_required')
  expect(f.page).toHaveBeenCalledTimes(1)

  f.client.emit(ClientEvent.Sync, SyncState.Stopped, SyncState.Prepared)
  await expect(f.sdk.command(command)).rejects.toThrow('matrix_room_unreadable')
  expect(f.page).toHaveBeenCalledTimes(1)
  await f.sdk.stop()
  await expect(f.sdk.command(command)).rejects.toThrow('stopped')
})

it('discards pending recent context when the real SDK loses readiness during pagination', async () => {
  const f = await groupRecentFixture()
  const pending = deferred<Awaited<ReturnType<MatrixClient['createMessagesRequest']>>>()
  f.page.mockImplementation(() => pending.promise)
  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const read = f.sdk.command({ kind: 'readGroupRecent', ...f.target })
  const refused = expect(read).rejects.toThrow('matrix_room_unreadable')
  await vi.waitFor(() => expect(f.page).toHaveBeenCalledOnce())
  f.client.emit(ClientEvent.Sync, SyncState.Stopped, SyncState.Prepared)
  pending.resolve({ chunk: [] } as never)
  await refused
  expect(f.roomState).toHaveBeenCalledTimes(1)
})

it('projects portable display settings through the actual SDK session and account-data event handlers', async () => {
  const f = await fixture()
  const identity = { userId: alice, deviceId: 'DEVICE' }
  expect(f.latest().displayPreferences?.appearance).toEqual({ value: 'system', writable: false })
  await expect(
    f.sdk.command({ kind: 'displayPreference', identity, field: 'appearance', value: 'dark' })
  ).rejects.toThrow('unavailable')
  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const read = vi.spyOn(f.client.http, 'authedRequest').mockResolvedValue({ version: 1, value: 'system' } as never)
  await f.sdk.command({ kind: 'displayPreference', identity, field: 'appearance', value: 'dark' })
  expect(read).toHaveBeenCalledOnce()
  expect(f.client.setAccountDataRaw).toHaveBeenCalledWith(MATRIX_DISPLAY_EVENTS.appearance, {
    version: 1,
    value: 'dark'
  })
  expect(f.latest().displayPreferences?.appearance.value).toBe('system')
  const event = new MatrixEvent({ type: MATRIX_DISPLAY_EVENTS.appearance, content: { version: 1, value: 'dark' } })
  f.client.store.storeAccountDataEvents([event])
  f.client.emit(ClientEvent.AccountData, event, undefined)
  await vi.waitFor(() => expect(f.latest().displayPreferences?.appearance).toEqual({ value: 'dark', writable: true }))
  f.client.emit(ClientEvent.Sync, SyncState.Stopped, SyncState.Prepared)
  expect(f.latest().displayPreferences?.appearance).toEqual({ value: 'dark', writable: false })
  await expect(f.sdk.command({ kind: 'displayPreference', identity, field: 'textSize', value: 110 })).rejects.toThrow(
    'unavailable'
  )
  await f.sdk.stop()
  await expect(
    f.sdk.command({ kind: 'displayPreference', identity, field: 'appearance', value: 'light' })
  ).rejects.toThrow('stopped')
})

it('sends typing only while shared activity is on, following the synced privacy setting', async () => {
  const f = await fixture()
  const sendTyping = vi.spyOn(f.client, 'sendTyping').mockResolvedValue({})
  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  await f.sdk.command({ kind: 'typing', roomId: '!first:test', typing: true })
  expect(sendTyping).toHaveBeenCalledOnce()

  // Off: a typing signal is private too, so nothing leaves the device.
  const event = new MatrixEvent({
    type: MATRIX_DISPLAY_EVENTS.shareActivity,
    content: { version: 1, value: false }
  })

  f.client.store.storeAccountDataEvents([event])
  f.client.emit(ClientEvent.AccountData, event, undefined)
  await vi.waitFor(() => expect(f.latest().displayPreferences?.shareActivity?.value).toBe(false))
  await f.sdk.command({ kind: 'typing', roomId: '!first:test', typing: true })
  expect(sendTyping).toHaveBeenCalledOnce()

  // On again: the same signal goes out once more.
  const on = new MatrixEvent({ type: MATRIX_DISPLAY_EVENTS.shareActivity, content: { version: 1, value: true } })
  f.client.store.storeAccountDataEvents([on])
  f.client.emit(ClientEvent.AccountData, on, undefined)
  await vi.waitFor(() => expect(f.latest().displayPreferences?.shareActivity?.value).toBe(true))
  await f.sdk.command({ kind: 'typing', roomId: '!first:test', typing: true })
  expect(sendTyping).toHaveBeenCalledTimes(2)
  await f.sdk.stop()
})

it('projects portable language through the actual session, with sync authority and readiness/retirement refusal', async () => {
  const f = await fixture()
  const identity = { userId: alice, deviceId: 'DEVICE' }
  // Never chosen: the system's language where Atum speaks it, Vietnamese otherwise.
  const unchosen = desktopLocaleFor(navigator.languages) ?? DEFAULT_DESKTOP_LOCALE
  expect(f.latest().displayPreferences?.language).toEqual({ value: unchosen, writable: false })
  await expect(f.sdk.command({ kind: 'displayPreference', identity, field: 'language', value: 'en' })).rejects.toThrow(
    'unavailable'
  )
  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  vi.spyOn(f.client.http, 'authedRequest').mockResolvedValue({ version: 1, value: 'vi' } as never)
  await f.sdk.command({ kind: 'displayPreference', identity, field: 'language', value: 'en' })
  expect(f.client.setAccountDataRaw).toHaveBeenCalledWith(MATRIX_DISPLAY_EVENTS.language, { version: 1, value: 'en' })
  expect(f.latest().displayPreferences?.language?.value).toBe(unchosen)
  const event = new MatrixEvent({ type: MATRIX_DISPLAY_EVENTS.language, content: { version: 1, value: 'en' } })
  f.client.store.storeAccountDataEvents([event])
  f.client.emit(ClientEvent.AccountData, event, undefined)
  await vi.waitFor(() => expect(f.latest().displayPreferences?.language).toEqual({ value: 'en', writable: true }))
  f.client.emit(ClientEvent.Sync, SyncState.Stopped, SyncState.Prepared)
  expect(f.latest().displayPreferences?.language).toEqual({ value: 'en', writable: false })
  await expect(f.sdk.command({ kind: 'displayPreference', identity, field: 'language', value: 'ja' })).rejects.toThrow(
    'unavailable'
  )
  await f.sdk.stop()
  await expect(f.sdk.command({ kind: 'displayPreference', identity, field: 'language', value: 'ja' })).rejects.toThrow(
    'stopped'
  )
})

it('sends explicit app addressing using standard Matrix mentions, without replacing ordinary sends', async () => {
  const f = await fixture()
  const send = vi.spyOn(f.client, 'sendEvent').mockResolvedValue({ event_id: '$addressed' })
  await expect(
    f.sdk.command({ kind: 'sendAppMessage', roomId: '!first:test', body: 'Hello', userId: '@app:test' })
  ).resolves.toBe('$addressed')
  expect(send).toHaveBeenCalledWith('!first:test', EventType.RoomMessage, {
    msgtype: 'm.text',
    body: 'Hello',
    'm.mentions': { user_ids: ['@app:test'] }
  })
})

it('sends an addressed app-bot message and performs bot-device retirement and room-key rotation', async () => {
  const f = await fixture()
  const send = vi.spyOn(f.client, 'sendEvent').mockResolvedValue({ event_id: '$bot-addressed' })
  const room = f.client.getRoom('!first:test')!
  room.currentState.setStateEvents([new MatrixEvent({
    type: EventType.RoomMember,
    state_key: '@app-moon:test',
    room_id: room.roomId,
    event_id: '$join-moon',
    sender: '@app-moon:test',
    content: { membership: 'join' }
  })])

  const crypto = f.client.getCrypto() as unknown as {
    forceDiscardSession: ReturnType<typeof vi.fn>
    globalBlacklistUnverifiedDevices: boolean
    setDeviceVerified: ReturnType<typeof vi.fn>
  }

  crypto.forceDiscardSession = vi.fn().mockResolvedValue(undefined)
  crypto.setDeviceVerified = vi.fn().mockResolvedValue(undefined)

  expect(crypto.globalBlacklistUnverifiedDevices).toBe(true)
  await expect(
    f.sdk.command({ kind: 'sendAppBotMessage', roomId: '!first:test', body: 'Moon?', userId: '@app-moon:test' })
  ).resolves.toBe('$bot-addressed')
  await expect(f.sdk.command({ kind: 'retireDevice', userId: '@app-moon:test', deviceId: 'OLD' })).resolves.toBeNull()
  await expect(f.sdk.command({ kind: 'rotateOutboundKeys', roomId: '!first:test' })).resolves.toBeNull()

  expect(send).toHaveBeenCalledWith('!first:test', EventType.RoomMessage, {
    msgtype: 'm.text',
    body: 'Moon?',
    'm.mentions': { user_ids: ['@app-moon:test'] }
  })
  expect(crypto.setDeviceVerified).toHaveBeenCalledWith('@app-moon:test', 'OLD', false)
  expect(crypto.forceDiscardSession).toHaveBeenCalledWith('!first:test')
})

it('refuses to address an official bot that is not joined to the room', async () => {
  const f = await fixture()
  const send = vi.spyOn(f.client, 'sendEvent').mockResolvedValue({ event_id: '$should-not-send' })

  await expect(
    f.sdk.command({ kind: 'sendAppBotMessage', roomId: '!first:test', body: 'Moon?', userId: '@app-moon:test' })
  ).rejects.toThrow('matrix_app_bot_membership_required')
  expect(send).not.toHaveBeenCalled()
})
afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop()
  }

  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

it('passes native disclosure transactions through the real agent SDK and rejects invalid overrides before key sharing', async () => {
  const agent = '@assistant:test'
  const f = await fixture(undefined, agent, 'DEVICE', false)
  const group = f.client.getRoom('!first:test')!
  group.currentState.setStateEvents([new MatrixEvent({
    type: EventType.RoomMember, state_key: agent, room_id: group.roomId, event_id: '$join-agent',
    sender: agent, content: { membership: 'join' }
  })])
  const send = vi.spyOn(f.client, 'sendEvent').mockResolvedValue({ event_id: '$disclosure' })
  const command = { kind: 'publishGroupNotice' as const, roomId: group.roomId, body: 'I’m an AI assistant.' }
  const first = `atum-gd-${'a'.repeat(64)}`
  const second = `atum-gd-${'b'.repeat(64)}`

  await expect(f.sdk.command({ ...command, transactionId: first })).resolves.toBe('$disclosure')
  expect(send).toHaveBeenLastCalledWith(group.roomId, EventType.RoomMessage,
    { msgtype: 'm.notice', body: command.body }, first)
  await f.sdk.command({ ...command, transactionId: second })
  expect(send).toHaveBeenLastCalledWith(group.roomId, EventType.RoomMessage,
    { msgtype: 'm.notice', body: command.body }, second)

  group.setBlacklistUnverifiedDevices(true)
  await expect(f.sdk.command({ ...command, transactionId: 'atum-gd-short' })).rejects.toThrow('matrix_command_invalid')
  expect(group.getBlacklistUnverifiedDevices()).toBe(true)
  expect(send).toHaveBeenCalledTimes(2)
  await f.sdk.stop()
  await expect(f.sdk.command({ ...command, transactionId: first })).rejects.toThrow('stopped')
})

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

/** A joined room without encryption state: every chat 0.20 creates. */
function plainRoomFixture(client: MatrixClient, id: string) {
  const ownId = client.getSafeUserId()
  const value = new Room(id, client, ownId)
  value.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomMember,
      state_key: ownId,
      room_id: id,
      sender: bob,
      content: { membership: 'join' }
    })
  ])
  value.updateMyMembership('join')
  client.store.storeRoom(value)

  return value
}

function notesRoomFixture(client: MatrixClient, id: string) {
  const ownId = client.getSafeUserId()
  const value = new Room(id, client, ownId)
  value.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomCreate,
      state_key: '',
      room_id: id,
      sender: ownId,
      origin_server_ts: 1,
      content: { type: MATRIX_NOTES_SELF_ROOM_TYPE }
    }),
    new MatrixEvent({
      type: EventType.RoomMember,
      state_key: ownId,
      room_id: id,
      sender: ownId,
      content: { membership: 'join' }
    })
  ])
  value.updateMyMembership('join')
  client.store.storeRoom(value)

  return value
}

function room(client: MatrixClient, id: string, membership = 'join', direct = false) {
  const ownId = client.getSafeUserId()
  const value = new Room(id, client, ownId)
  value.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomEncryption,
      state_key: '',
      room_id: id,
      sender: alice,
      content: { algorithm: 'm.megolm.v1.aes-sha2' }
    }),
    new MatrixEvent({
      type: EventType.RoomMember,
      state_key: ownId,
      room_id: id,
      sender: bob,
      content: { membership, is_direct: direct }
    })
  ])
  value.updateMyMembership(membership)
  client.store.storeRoom(value)

  return value
}

interface AssistantRoomShape {
  ownerId: string
  agentId: string
  creator: string
  ownerMembership: 'join' | 'invite'
  agentMembership: 'join' | 'invite'
}

function assistantRoomState(id: string, shape: AssistantRoomShape) {
  const member = (userId: string, membership: 'join' | 'invite') => ({
    type: EventType.RoomMember,
    state_key: userId,
    room_id: id,
    event_id: `$${membership}-${userId}`,
    sender: membership === 'invite' ? shape.creator : userId,
    origin_server_ts: 4,
    content: { membership, ...(membership === 'invite' ? { is_direct: true } : {}) }
  })

  return [
    {
      type: EventType.RoomCreate,
      state_key: '',
      room_id: id,
      event_id: '$create',
      sender: shape.creator,
      origin_server_ts: 1,
      content: { type: MATRIX_ASSISTANT_ROOM_TYPE }
    },
    {
      type: EventType.RoomHistoryVisibility,
      state_key: '',
      room_id: id,
      event_id: '$history',
      sender: shape.creator,
      origin_server_ts: 2,
      content: { history_visibility: 'invited' }
    },
    {
      type: EventType.RoomPowerLevels,
      state_key: '',
      room_id: id,
      event_id: '$power',
      sender: shape.creator,
      origin_server_ts: 3,
      content: { users: { [shape.ownerId]: 100, [shape.agentId]: 100 } }
    },
    member(shape.ownerId, shape.ownerMembership),
    member(shape.agentId, shape.agentMembership)
  ]
}

function holdAssistantRoom(client: MatrixClient, id: string, shape: AssistantRoomShape) {
  const value = new Room(id, client, client.getSafeUserId())
  value.currentState.setStateEvents(assistantRoomState(id, shape).map(event => new MatrixEvent(event)))
  value.updateMyMembership(
    client.getSafeUserId() === shape.ownerId ? shape.ownerMembership : shape.agentMembership
  )
  client.store.storeRoom(value)

  return value
}

function strippedAssistantInvite(
  client: MatrixClient,
  id: string,
  creator: string,
  options: { typed?: boolean; third?: boolean } = {}
) {
  const value = new Room(id, client, client.getSafeUserId())

  const event = (type: string, stateKey: string, content: Record<string, unknown>, sender: string) =>
    new MatrixEvent({ type, state_key: stateKey, content, sender, room_id: id } as never)

  value.currentState.setStateEvents([
    event(EventType.RoomCreate, '', options.typed === false ? {} : { type: MATRIX_ASSISTANT_ROOM_TYPE }, creator),
    event(EventType.RoomMember, creator, { membership: 'join' }, creator),
    event(EventType.RoomMember, bob, { membership: 'invite', is_direct: true }, creator),
    ...(options.third ? [event(EventType.RoomMember, '@third:test', { membership: 'join' }, '@third:test')] : [])
  ])
  value.updateMyMembership('invite')

  return value
}

it('projects a realistic stripped agent invite as hidden but keeps stranger, untyped and crowded invites', async () => {
  const actual = await vi.importActual<typeof MatrixSdk>('matrix-js-sdk')
  const client = actual.createClient({ baseUrl: 'https://matrix.test', userId: bob })
  const enrolled = strippedAssistantInvite(client, '!enrolled:test', alice)
  const stranger = strippedAssistantInvite(client, '!stranger:test', '@stranger:test')
  const untyped = strippedAssistantInvite(client, '!untyped:test', alice, { typed: false })
  const crowded = strippedAssistantInvite(client, '!crowded:test', alice, { third: true })
  const projected = [enrolled, stranger, untyped, crowded].map(room => conversationRoom(client, room))

  expect(
    assistantRooms(projected, undefined, [{ principal: 'agent-principal', userId: alice }], bob)
      .map(room => room.id)
      .sort()
  ).toEqual(['!crowded:test', '!stranger:test', '!untyped:test'])
})

async function fixture(
  fetcher?: typeof fetch,
  userId = alice,
  deviceId = 'DEVICE',
  selectInitial = true,
  notify: (hint: MatrixNotificationHint) => void = () => {}
) {
  const actual = await vi.importActual<typeof MatrixSdk>('matrix-js-sdk')

  const client = actual.createClient({
    baseUrl: 'https://matrix.test',
    userId,
    deviceId,
    ...(fetcher ? { fetchFn: boundedMatrixFetch(fetcher) } : {})
  })

  vi.mocked(createClient).mockReturnValue(client)
  vi.stubGlobal('indexedDB', {})
  vi.spyOn(client, 'initRustCrypto').mockResolvedValue(undefined)
  vi.spyOn(client, 'getCrypto').mockReturnValue({ globalBlacklistUnverifiedDevices: false } as unknown as ReturnType<
    MatrixClient['getCrypto']
  >)
  vi.spyOn(client, 'startClient').mockResolvedValue(undefined)
  vi.spyOn(client, 'stopClient').mockImplementation(() => {})
  vi.spyOn(client, 'getAccountDataFromServer').mockResolvedValue({})
  vi.spyOn(client, 'setAccountDataRaw').mockResolvedValue({})
  room(client, '!first:test')
  room(client, '!other:test')
  const snapshots: MatrixSnapshot[] = []

  const sdk = await startMatrixSdk(
    {
      baseUrl: 'https://matrix.test',
      userId,
      deviceId,
      accessToken: 'fixture',
      storageKey: btoa('0'.repeat(32))
    },
    vi.fn(),
    value => snapshots.push(value),
    undefined,
    notify
  )

  stops.push(sdk.stop)

  if (selectInitial) {
    await sdk.command({ kind: 'select', roomId: '!first:test' })
  }

  return { client, sdk, snapshots, latest: () => snapshots.at(-1)! }
}

async function decryptReportFixture(
  event: MatrixEvent,
  type: string = EventType.RoomMessage,
  body = 'private fixture body'
) {
  await event.attemptDecryption({
    decryptEvent: async () => ({
      clearEvent: { type, content: { msgtype: 'm.text', body } },
      senderCurve25519Key: 'fixture',
      claimedEd25519Key: 'fixture'
    })
  } as unknown as Parameters<MatrixEvent['attemptDecryption']>[0])
}

it('watches threads only in the selected joined company room and detaches on switch or leave', async () => {
  const f = await fixture()

  const companyRoom = (id: string) => {
    const value = plainRoomFixture(f.client, id)
    vi.spyOn(value, 'getType').mockReturnValue(MATRIX_COMPANY_CHANNEL_TYPE)
    vi.spyOn(value, 'createThreadsTimelineSets').mockResolvedValue([{}, {}] as never)

    return value
  }

  const first = companyRoom('!company-one:test')
  const second = companyRoom('!company-two:test')

  await f.sdk.command({ kind: 'select', roomId: first.roomId })
  await vi.waitFor(() => expect(first.listenerCount(ThreadEvent.Update)).toBe(1))
  expect(first.listenerCount(RoomEvent.UnreadNotifications)).toBe(1)

  await f.sdk.command({ kind: 'select', roomId: second.roomId })
  await vi.waitFor(() => expect(second.listenerCount(ThreadEvent.Update)).toBe(1))
  expect(first.listenerCount(ThreadEvent.Update)).toBe(0)
  expect(first.listenerCount(RoomEvent.UnreadNotifications)).toBe(0)

  second.updateMyMembership('leave')
  f.client.emit(RoomEvent.MyMembership, second, 'leave', 'join')
  await vi.waitFor(() => expect(second.listenerCount(ThreadEvent.Update)).toBe(0))
  expect(second.listenerCount(RoomEvent.UnreadNotifications)).toBe(0)
})

it("projects a Team Space channel's joins and departures beside its messages, and none for an ordinary chat", async () => {
  const f = await fixture()
  const manager = '@manager:test'
  const channel = plainRoomFixture(f.client, '!channel:test')
  vi.spyOn(channel, 'createThreadsTimelineSets').mockResolvedValue([{}, {}] as never)

  channel.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomCreate,
      state_key: '',
      room_id: channel.roomId,
      sender: manager,
      content: {
        type: MATRIX_COMPANY_CHANNEL_TYPE,
        room_version: MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
        [MATRIX_COMPANY_CHANNEL_BINDING]: {
          companyId: '00000000-0000-4000-8000-8c031eadb7f3',
          channelId: '00000000-0000-4000-8000-01670d853f95'
        }
      }
    })
  ])

  // A homeserver's member event carries the membership before it in `unsigned`.
  const membership = (roomId: string, id: string, userId: string, state: string, before: string, sender = userId, name?: string) =>
    new MatrixEvent({
      type: EventType.RoomMember,
      state_key: userId,
      room_id: roomId,
      event_id: id,
      sender,
      origin_server_ts: 1_000,
      content: { membership: state, ...(name ? { displayname: name } : {}) },
      unsigned: { prev_content: { membership: before } }
    })

  const hello = new MatrixEvent({
    type: EventType.RoomMessage,
    room_id: channel.roomId,
    event_id: '$hello',
    sender: bob,
    origin_server_ts: 2_000,
    content: { msgtype: 'm.text', body: 'hello' }
  })

  await channel.addLiveEvents(
    [
      membership(channel.roomId, '$joined', bob, 'join', 'invite', bob, 'Bob'),
      hello,
      membership(channel.roomId, '$profile', bob, 'join', 'join', bob, 'Bob B.'),
      membership(channel.roomId, '$removed', bob, 'ban', 'join', manager)
    ],
    { addToState: false }
  )

  await f.sdk.command({ kind: 'select', roomId: channel.roomId })

  await vi.waitFor(() =>
    expect(f.latest().membershipLines).toEqual([
      expect.objectContaining({ id: '$joined', kind: 'joined', userId: bob, name: 'Bob' }),
      expect.objectContaining({ id: '$removed', kind: 'departed', userId: bob })
    ])
  )

  // They are lines beside the messages, never messages.
  expect(f.latest().messages.map(value => value.id)).toEqual(['$hello'])

  const ordinary = f.client.getRoom('!other:test')!
  await ordinary.addLiveEvents([membership(ordinary.roomId, '$other', bob, 'join', 'invite')], { addToState: false })
  await f.sdk.command({ kind: 'select', roomId: ordinary.roomId })
  await vi.waitFor(() => expect(f.latest().roomId).toBe(ordinary.roomId))
  expect(f.latest().membershipLines).toBeUndefined()
})

/** Real MatrixHttpApi serialization with a local fetch handler; no homeserver is contacted. */
async function reportHttpFixture(fetcher: typeof fetch) {
  const actual = await vi.importActual<typeof MatrixSdk>('matrix-js-sdk')

  const client = actual.createClient({
    baseUrl: 'https://matrix.test',
    userId: alice,
    accessToken: 'synthetic-report-token',
    fetchFn: boundedMatrixFetch(fetcher)
  })

  vi.mocked(createClient).mockReturnValue(client)
  vi.stubGlobal('indexedDB', {})
  vi.spyOn(client, 'initRustCrypto').mockResolvedValue(undefined)
  vi.spyOn(client, 'getCrypto').mockReturnValue({ globalBlacklistUnverifiedDevices: false } as unknown as ReturnType<
    MatrixClient['getCrypto']
  >)
  vi.spyOn(client, 'startClient').mockResolvedValue(undefined)
  vi.spyOn(client, 'stopClient').mockImplementation(() => {})
  vi.spyOn(client, 'getAccountDataFromServer').mockResolvedValue({})
  vi.spyOn(client, 'setAccountDataRaw').mockResolvedValue({})
  const selected = room(client, '!first:test')
  const snapshots: MatrixSnapshot[] = []

  const sdk = await startMatrixSdk(
    {
      baseUrl: 'https://matrix.test',
      userId: alice,
      deviceId: 'DEVICE',
      accessToken: 'synthetic-report-token',
      storageKey: btoa('0'.repeat(32))
    },
    vi.fn(),
    value => snapshots.push(value)
  )

  const event = new MatrixEvent({
    event_id: '$http-report',
    room_id: selected.roomId,
    type: EventType.RoomMessageEncrypted,
    sender: bob,
    content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'fixture' }
  })

  stops.push(sdk.stop)
  await decryptReportFixture(event)
  await selected.addLiveEvents([event], { addToState: true })
  await sdk.command({ kind: 'select', roomId: selected.roomId })
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)

  return { client, event, sdk, selected, snapshots }
}

it('publishes a trusted Google fence through the real SDK session and refuses offline, foreign and stopped calls', async () => {
  const f = await fixture()
  const identity = { userId: alice, deviceId: 'DEVICE' }
  await expect(f.sdk.command({ kind: 'publishGoogleFence', identity })).rejects.toThrow('stale')
  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  vi.spyOn(f.client.http, 'authedRequest').mockRejectedValue({ errcode: 'M_NOT_FOUND' })
  const result = await f.sdk.command({ kind: 'publishGoogleFence', identity })
  expect(result).toMatchObject({ v: 1, since: expect.any(Number) })
  expect(f.client.setAccountDataRaw).toHaveBeenCalledWith('io.atum.google_fence', result)
  await expect(f.sdk.command({ kind: 'publishGoogleFence', identity: { ...identity, deviceId: 'OTHER' } })).rejects.toThrow('stale')
  f.client.emit(ClientEvent.Sync, SyncState.Stopped, SyncState.Prepared)
  await expect(f.sdk.command({ kind: 'publishGoogleFence', identity })).rejects.toThrow('stale')
  await f.sdk.stop()
  await expect(f.sdk.command({ kind: 'publishGoogleFence', identity })).rejects.toThrow('stopped')
})

it('publishes a reconnecting sync as ready and degraded, not offline, and goes offline by itself past the grace (R4)', async () => {
  vi.useFakeTimers()

  try {
    const f = await fixture()
    f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
    f.client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Prepared)
    expect(f.latest()).toMatchObject({ state: 'ready' })
    expect(f.latest().degraded).toBeUndefined()

    // The router dropped: the long-poll fails; the host stays ready so no turn, lease or watch ends.
    f.client.emit(ClientEvent.Sync, SyncState.Reconnecting, SyncState.Syncing, { error: new Error('network') })
    expect(f.latest()).toMatchObject({ state: 'ready', degraded: true })
    await vi.advanceTimersByTimeAsync(16_000)
    expect(f.latest()).toMatchObject({ state: 'ready', degraded: true })

    // Back: the first response is applied while the state is CATCHUP.
    f.client.emit(ClientEvent.Sync, SyncState.Catchup, SyncState.Reconnecting, { catchingUp: true })
    expect(f.latest()).toMatchObject({ state: 'ready' })
    expect(f.latest().degraded).toBeUndefined()
    f.client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Catchup)
    expect(f.latest().degraded).toBeUndefined()

    // Failing with no further sync event: offline by itself once the grace runs out, never before.
    f.client.emit(ClientEvent.Sync, SyncState.Error, SyncState.Syncing, { error: new Error('502') })
    expect(f.latest()).toMatchObject({ state: 'ready', degraded: true })
    await vi.advanceTimersByTimeAsync(MATRIX_SYNC_GRACE_MS - 1_000)
    expect(f.latest()).toMatchObject({ state: 'ready', degraded: true })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.latest().state).toBe('offline')
    expect(f.latest().degraded).toBeUndefined()

    f.client.emit(ClientEvent.Sync, SyncState.Catchup, SyncState.Error)
    expect(f.latest()).toMatchObject({ state: 'ready' })
    await f.sdk.stop()
  } finally {
    vi.useRealTimers()
  }
})

it('keeps a turn in flight and its lease through a reconnecting sync, and ends both once the sync is down past the grace (R4)', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000_000)

  try {
    const f = await fixture()

    // Main's side of the seam, with the real lease and the real turn lookup: what the host
    // snapshot makes of a turn in flight and of the answering lease (electron/matrix/main.ts).
    const executorId = '00000000-0000-4000-8000-75c02539218c'

    const request = vi.fn(async (operation: 'acquire' | 'release') =>
      operation === 'release'
        ? { held: false }
        : { held: true, executorId, acquiredAt: Date.now(), expiresAt: Date.now() + 90_000 }
    )

    const lease = new MatrixExecutorLease({ request, random: () => 0.5 })
    const turn: { abort: AbortController; setup?: true } = { abort: new AbortController() }
    const agents = [{ role: 'agent' as const, invocation: turn }]

    const apply = (snapshot: MatrixSnapshot) => {
      if (matrixHostEndsTurns(matrixHostLiveness(snapshot))) {
        for (const each of matrixTurnsNeedingHost<typeof turn>('agent', agents)) {
          each.abort.abort()
        }
      }

      const action = matrixLeaseHostAction({
        enrolled: true,
        agent: { ready: true },
        human: { ready: snapshot.state === 'ready', degraded: snapshot.degraded === true }
      })

      if (action === 'release') {
        void lease.release()
      } else if (action === 'proceed') {
        lease.start(executorId)
      }
    }

    f.client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Prepared)
    apply(f.latest())
    await vi.advanceTimersByTimeAsync(0)
    expect(lease.current.state).toBe('held')
    const held = lease.held(executorId)!

    // A 16 s router blip, as on 2026-10-17: several renewals' worth of time passes with the sync
    // reconnecting, and the turn keeps running under the same lease session.
    f.client.emit(ClientEvent.Sync, SyncState.Reconnecting, SyncState.Syncing, { error: new Error('network') })
    apply(f.latest())
    await vi.advanceTimersByTimeAsync(16_000)
    expect(turn.abort.signal.aborted).toBe(false)
    expect(lease.current.state).toBe('held')
    expect(held.signal.aborted).toBe(false)

    f.client.emit(ClientEvent.Sync, SyncState.Catchup, SyncState.Reconnecting)
    apply(f.latest())
    f.client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Catchup)
    apply(f.latest())
    expect(turn.abort.signal.aborted).toBe(false)
    // The same lease session throughout: it was renewed, never given up and taken again.
    expect(lease.held(executorId)?.since).toBe(held.since)
    expect(held.signal.aborted).toBe(false)
    expect(request.mock.calls.filter(([operation]) => operation === 'release')).toEqual([])

    // The same sync failing past its grace is an outage: the turn ends and the lease is given up.
    f.client.emit(ClientEvent.Sync, SyncState.Error, SyncState.Syncing, { error: new Error('502') })
    apply(f.latest())
    const acquires = () => request.mock.calls.filter(([operation]) => operation === 'acquire').length
    const before = acquires()
    await vi.advanceTimersByTimeAsync(MATRIX_SYNC_GRACE_MS - 1_000)
    expect(turn.abort.signal.aborted).toBe(false)
    expect(lease.current.state).toBe('held')
    // It kept renewing in the background the whole time.
    expect(acquires()).toBeGreaterThan(before)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.latest().state).toBe('offline')
    apply(f.latest())
    await vi.advanceTimersByTimeAsync(0)
    expect(turn.abort.signal.aborted).toBe(true)
    expect(lease.current.state).toBe('idle')
    expect(held.signal.aborted).toBe(true)
    await f.sdk.stop()
  } finally {
    vi.useRealTimers()
  }
})

it('publishes a stopped client as offline and a refused token as an error at once (R4)', async () => {
  const f = await fixture()
  f.client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Prepared)
  expect(f.latest().state).toBe('ready')

  f.client.emit(ClientEvent.Sync, SyncState.Stopped, SyncState.Syncing)
  expect(f.latest().state).toBe('offline')
  expect(f.latest().degraded).toBeUndefined()

  f.client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Stopped)
  f.client.emit(ClientEvent.Sync, SyncState.Error, SyncState.Syncing, {
    error: Object.assign(new Error('token refused'), { errcode: 'M_UNKNOWN_TOKEN' })
  })
  expect(f.latest().state).toBe('error')
  expect(f.latest().degraded).toBeUndefined()
})

it('offers native notifications through the actual SDK session and push rules, never initial history or retired delivery', async () => {
  const notify = vi.fn()
  const f = await fixture(undefined, alice, 'DEVICE', true, notify)
  f.client.pushRules = {
    global: {
      override: [
        {
          rule_id: 'fixture',
          default: false,
          enabled: true,
          conditions: [],
          actions: [PushRuleActionName.Notify, { set_tweak: TweakName.Sound, value: 'default' }]
        }
      ]
    }
  }

  const incoming = (id: string) =>
    new MatrixEvent({
      type: EventType.RoomMessage,
      event_id: id,
      room_id: '!other:test',
      sender: bob,
      content: { msgtype: 'm.text', body: 'private text' }
    })

  const timeline = (e: MatrixEvent, liveEvent = true) =>
    f.client.emit(RoomEvent.Timeline, e, f.client.getRoom('!other:test')!, false, false, {
      liveEvent,
      timeline: f.client.getRoom('!other:test')!.getLiveTimeline()
    })

  const history = incoming('$history')
  timeline(history)
  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  f.client.emit(MatrixEventEvent.Decrypted, history)
  timeline(incoming('$cached'), false)
  expect(notify).not.toHaveBeenCalled()
  const fresh = incoming('$fresh')
  timeline(fresh)
  timeline(fresh)
  f.client.emit(MatrixEventEvent.Decrypted, fresh)
  expect(notify).toHaveBeenCalledExactlyOnceWith({ roomId: '!other:test', eventId: '$fresh', sound: true })
  const off = new MatrixEvent({ type: MATRIX_DISPLAY_EVENTS.notifications, content: { version: 1, value: false } })
  f.client.store.storeAccountDataEvents([off])
  f.client.emit(ClientEvent.AccountData, off, undefined)
  timeline(incoming('$disabled'))
  expect(notify).toHaveBeenCalledOnce()
  await f.sdk.stop()
  timeline(incoming('$retired'))
  expect(notify).toHaveBeenCalledOnce()
})

it('suppresses a marker-lag room through the authenticated binding in both SDK and native main', async () => {
  const host = { identity: { userId: alice, deviceId: 'DEVICE' } }
  const scope = { accountKey: 'alice-account', generation: 1 }
  const authority = new MatrixCompanyPrivateCosNotificationAuthority()
  const create = vi.fn(() => ({ once: vi.fn(), show: vi.fn(), close: vi.fn() }))
  let f!: Awaited<ReturnType<typeof fixture>>
  const native = createMatrixNotifications({
    current: () => ({ host, snapshot: f.latest(), focused: false, closing: false }),
    create,
    open: vi.fn(),
    privateCosBoundRoom: roomId => authority.has(scope, roomId)
  })
  const hints = vi.fn((hint: MatrixNotificationHint) => native.offer('human', host, hint))

  f = await fixture(undefined, alice, 'DEVICE', true, hints)
  f.client.pushRules = { global: { override: [{
    rule_id: 'fixture',
    default: false,
    enabled: true,
    conditions: [],
    actions: [PushRuleActionName.Notify]
  }] } }
  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)

  const companyId = '00000000-0000-4000-8000-87c6455cae48'
  const pair = {
    companyPrincipal: companyId,
    memberPrincipal: '00000000-0000-4000-8000-f6c6b8bb709f',
    membershipIncarnation: '00000000-0000-4000-8000-8a4e23bab81e'
  }
  authority.observe(scope, {
    schemaVersion: 1,
    state: 'ready',
    pair,
    greetingState: 'published',
    binding: {
      scope: { pair, authorityEpoch: 1, contextEpoch: 1, homeGeneration: 1 },
      agentPrincipal: '00000000-0000-4000-8000-f9ae298d66d3',
      agentUserId: '@private-cos:atum.example',
      executorId: '00000000-0000-4000-8000-31ba7dd260e2',
      homeId: '00000000-0000-4000-8000-7886f5c6d975',
      roomId: '!other:test',
      storeGeneration: 1,
      profileDigest: 'a'.repeat(64)
    }
  })
  await f.sdk.command({
    kind: 'companyPrivateCosNotificationRooms',
    roomIds: authority.roomIds(scope)
  })

  expect(f.latest().rooms.find(room => room.id === '!other:test')).not.toHaveProperty('companyPrivateCosBound')
  const event = new MatrixEvent({
    type: EventType.RoomMessage,
    event_id: '$marker-lag',
    room_id: '!other:test',
    sender: bob,
    content: { msgtype: 'm.text', body: 'private text' }
  })
  const other = f.client.getRoom('!other:test')!
  f.client.emit(RoomEvent.Timeline, event, other, false, false, {
    liveEvent: true,
    timeline: other.getLiveTimeline()
  })

  expect(hints).not.toHaveBeenCalled()
  native.offer('human', host, { roomId: '!other:test', eventId: '$main-defence', sound: true })
  expect(create).not.toHaveBeenCalled()
})

it('publishes current room and preference facts before the native alert, not after the timeline debounce', async () => {
  const host = { identity: { userId: alice, deviceId: 'DEVICE' } }
  let f!: Awaited<ReturnType<typeof fixture>>
  const create = vi.fn(() => ({ once: vi.fn(), show: vi.fn(), close: vi.fn() }))

  const native = createMatrixNotifications({ current: () => ({ host, snapshot: f.latest(), focused: false, closing: false }),
    create, open: vi.fn() })

  f = await fixture(undefined, alice, 'DEVICE', true, hint => native.offer('human', host, hint))
  f.client.pushRules = { global: { override: [{ rule_id: 'fixture', default: false, enabled: true, conditions: [],
    actions: [PushRuleActionName.Notify, { set_tweak: TweakName.Sound, value: 'default' }] }] } }
  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const newRoom = room(f.client, '!new:test')
  f.client.emit(ClientEvent.Room, newRoom)
  expect(f.latest().rooms.some(each => each.id === newRoom.roomId)).toBe(false)

  const event = new MatrixEvent({ type: EventType.RoomMessage, room_id: newRoom.roomId, sender: bob,
    event_id: '$first-in-new-room', content: { msgtype: 'm.text', body: 'private' } })

  f.client.emit(RoomEvent.Timeline, event, newRoom, false, false, { liveEvent: true, timeline: newRoom.getLiveTimeline() })
  expect(create).toHaveBeenCalledOnce()
  expect(f.latest().rooms.some(each => each.id === newRoom.roomId)).toBe(true)
  const silent = new MatrixEvent({ type: MATRIX_DISPLAY_EVENTS.sound, content: { version: 1, value: false } })
  f.client.store.storeAccountDataEvents([silent])
  f.client.emit(ClientEvent.AccountData, silent, undefined)
  f.client.emit(RoomEvent.Timeline, new MatrixEvent({ ...event.event, event_id: '$silent' }), newRoom, false, false,
    { liveEvent: true, timeline: newRoom.getLiveTimeline() })
  expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ silent: true }))
})

it('reports "connecting" once started and before its first sync, then ready (G1-13)', async () => {
  // Main starts an agent's model check as soon as that agent's host has loaded, so this
  // first snapshot always arrives during the check. It must not end the check.
  const { client, snapshots } = await fixture(undefined, alice, 'DEVICE', false)
  expect(snapshots.map(each => each.state)).toEqual(['connecting'])
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  expect(snapshots.at(-1)!.state).toBe('ready')
})

it('keeps sync ready and the other rooms projected when the notes snapshot projection fails', async () => {
  const f = await fixture(undefined, alice, 'DEVICE', false)
  const before = f.latest().notesSelf
  const getAccountData = f.client.getAccountData.bind(f.client)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  vi.spyOn(f.client, 'getAccountData').mockImplementation(type => {
    if (type === MATRIX_NOTES_SELF_ACCOUNT_DATA) {
      throw new Error('secret provider detail')
    }

    return getAccountData(type)
  })

  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)

  expect(f.latest()).toMatchObject({ state: 'ready', notesSelf: before })
  expect(f.latest().rooms.map(room => room.id).sort()).toEqual(['!first:test', '!other:test'])
  expect(warn).toHaveBeenCalledWith('[matrix] notes-self projection failed (snapshot)')
  expect(warn.mock.calls.flat().join(' ')).not.toContain('secret provider detail')
})

it('fails closed without destabilizing readiness when notes use and send projections fail', async () => {
  const f = await fixture(undefined, alice, 'DEVICE', false)
  const notes = notesRoomFixture(f.client, '!notes:test')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)

  const getRooms = vi.spyOn(f.client, 'getRooms').mockImplementation(() => {
    throw new Error('secret room projection detail')
  })

  await expect(f.sdk.command({
    kind: 'draft',
    identity: { userId: alice, deviceId: 'DEVICE' },
    roomId: notes.roomId,
    text: 'private draft'
  })).rejects.toThrow('matrix_draft_room_unavailable')
  await expect(f.sdk.command({ kind: 'send', roomId: notes.roomId, body: 'private note' }))
    .rejects.toThrow('matrix_notes_self_unavailable')

  expect(warn).toHaveBeenCalledWith('[matrix] notes-self projection failed (can-use)')
  expect(warn).toHaveBeenCalledWith('[matrix] notes-self projection failed (assert-send)')
  expect(warn.mock.calls.flat().join(' ')).not.toContain('secret room projection detail')

  getRooms.mockRestore()
  f.client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Prepared)
  expect(f.latest().state).toBe('ready')
})

it('restores the last conversation only after initial sync, never over newer intent or on reconnect', async () => {
  const selection = roomSelection(localStorage, alice, 'DEVICE')
  selection.write('!other:test')
  const { client, sdk, latest } = await fixture(undefined, alice, 'DEVICE', false)
  expect(latest().roomId).toBeNull()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  expect(latest().roomId).toBe('!other:test')
  await sdk.command({ kind: 'select', roomId: '!first:test' })
  expect(selection.read()).toBe('!first:test')
  selection.write('!other:test')
  client.emit(ClientEvent.Sync, SyncState.Stopped, SyncState.Prepared)
  client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Error)
  expect(latest().roomId).toBe('!first:test')
})

it.each(['leave', 'ban', 'missing', 'ignored-invite'])('does not restore a %s room', async kind => {
  const selection = roomSelection(localStorage, alice, 'DEVICE')
  selection.write('!other:test')
  const { client, latest } = await fixture(undefined, alice, 'DEVICE', false)

  if (kind === 'missing') {
    client.store.removeRoom('!other:test')
  } else if (kind === 'ignored-invite') {
    room(client, '!other:test', 'invite', true)
    vi.spyOn(client, 'isUserIgnored').mockReturnValue(true)
  } else {
    client.getRoom('!other:test')!.updateMyMembership(kind)
  }

  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  expect(latest().roomId).toBeNull()
  expect(selection.read()).toBeNull()
})

it('an early explicit selection wins over restoration and leave clears the pointer', async () => {
  roomSelection(localStorage, alice, 'DEVICE').write('!other:test')
  const { client, sdk, latest } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  expect(latest().roomId).toBe('!first:test')
  vi.spyOn(client, 'leave').mockResolvedValue({})
  await sdk.command({ kind: 'leave', roomId: '!first:test' })
  expect(roomSelection(localStorage, alice, 'DEVICE').read()).toBeNull()
})

it('uses standard tag-specific SDK writes and waits for real tags to change the projection', async () => {
  const { client, sdk, latest } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const add = vi.spyOn(client, 'setRoomTag').mockResolvedValue({})
  const remove = vi.spyOn(client, 'deleteRoomTag').mockResolvedValue({})
  const selected = client.getRoom('!first:test')!
  await sdk.command({ kind: 'favourite', roomId: selected.roomId, favourite: true })
  expect(add).toHaveBeenCalledExactlyOnceWith(selected.roomId, 'm.favourite')
  expect(latest().rooms.find(room => room.id === selected.roomId)?.favourite).toBe(false)
  selected.addTags(
    new MatrixEvent({ type: EventType.Tag, content: { tags: { 'm.favourite': { order: 0.25 }, 'u.work': {} } } })
  )
  client.emit(RoomEvent.AccountData, new MatrixEvent({ type: EventType.Tag }), selected)
  await vi.waitFor(() =>
    expect(latest().rooms.find(room => room.id === selected.roomId)).toMatchObject({
      favourite: true,
      favouriteOrder: 0.25
    })
  )
  await sdk.command({ kind: 'favourite', roomId: selected.roomId, favourite: false })
  expect(remove).toHaveBeenCalledExactlyOnceWith(selected.roomId, 'm.favourite')
  expect(selected.tags).toHaveProperty('u.work')
  remove.mockRejectedValue(new Error('M_FORBIDDEN'))
  await expect(sdk.command({ kind: 'favourite', roomId: selected.roomId, favourite: false })).rejects.toThrow(
    'M_FORBIDDEN'
  )
  expect(selected.tags).toHaveProperty('m.favourite')
})

it('marks low priority with the standard m.lowpriority tag, never both it and m.favourite', async () => {
  const { client, sdk, latest } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const add = vi.spyOn(client, 'setRoomTag').mockResolvedValue({})
  const remove = vi.spyOn(client, 'deleteRoomTag').mockResolvedValue({})
  const selected = client.getRoom('!first:test')!

  await sdk.command({ kind: 'lowPriority', roomId: selected.roomId, lowPriority: true })
  expect(add).toHaveBeenCalledExactlyOnceWith(selected.roomId, 'm.lowpriority')
  expect(remove).not.toHaveBeenCalled()
  // Sync, not the command, changes the projection.
  expect(latest().rooms.find(room => room.id === selected.roomId)?.lowPriority).toBeUndefined()
  selected.addTags(new MatrixEvent({ type: EventType.Tag, content: { tags: { 'm.lowpriority': {}, 'u.work': {} } } }))
  client.emit(RoomEvent.AccountData, new MatrixEvent({ type: EventType.Tag }), selected)
  await vi.waitFor(() => expect(latest().rooms.find(room => room.id === selected.roomId)?.lowPriority).toBe(true))

  // Pinning a low priority chat takes it out of low priority.
  add.mockClear()
  await sdk.command({ kind: 'favourite', roomId: selected.roomId, favourite: true })
  expect(add).toHaveBeenCalledExactlyOnceWith(selected.roomId, 'm.favourite')
  expect(remove).toHaveBeenCalledExactlyOnceWith(selected.roomId, 'm.lowpriority')

  // And marking a pinned chat low priority unpins it.
  selected.addTags(new MatrixEvent({ type: EventType.Tag, content: { tags: { 'm.favourite': {} } } }))
  add.mockClear()
  remove.mockClear()
  await sdk.command({ kind: 'lowPriority', roomId: selected.roomId, lowPriority: true })
  expect(add).toHaveBeenCalledExactlyOnceWith(selected.roomId, 'm.lowpriority')
  expect(remove).toHaveBeenCalledExactlyOnceWith(selected.roomId, 'm.favourite')

  remove.mockClear()
  await sdk.command({ kind: 'lowPriority', roomId: selected.roomId, lowPriority: false })
  expect(remove).toHaveBeenCalledExactlyOnceWith(selected.roomId, 'm.lowpriority')

  room(client, '!invited:test', 'invite')
  add.mockClear()

  for (const roomId of ['!missing:test', '!invited:test']) {
    await expect(sdk.command({ kind: 'lowPriority', roomId, lowPriority: true })).rejects.toThrow(
      'matrix_low_priority_unavailable'
    )
  }

  expect(add).not.toHaveBeenCalled()
})

it('does not write favourites for absent, invited, left or offline rooms', async () => {
  const { client, sdk } = await fixture()
  const add = vi.spyOn(client, 'setRoomTag')
  await expect(sdk.command({ kind: 'favourite', roomId: '!first:test', favourite: true })).rejects.toThrow()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  room(client, '!invited:test', 'invite')
  room(client, '!left:test', 'leave')

  for (const roomId of ['!missing:test', '!invited:test', '!left:test']) {
    await expect(sdk.command({ kind: 'favourite', roomId, favourite: true })).rejects.toThrow(
      'matrix_favourite_unavailable'
    )
  }

  expect(add).not.toHaveBeenCalled()
})

it('a delayed create does not steal a newer room selection', async () => {
  const { client, sdk, latest } = await fixture()
  const pending = deferred<{ room_id: string }>()
  vi.spyOn(client, 'createRoom').mockReturnValue(pending.promise)
  const operation = sdk.command({ kind: 'create', name: 'New', invite: [] })
  await sdk.command({ kind: 'select', roomId: '!other:test' })
  pending.resolve({ room_id: '!new:test' })
  expect(await operation).toBe('!new:test')
  expect(latest().roomId).toBe('!other:test')
})

it('trusted assistant creation uses the same SDK lifecycle but adds the immutable room type', async () => {
  const { client, sdk, latest } = await fixture()
  vi.spyOn(client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: [] })
  vi.spyOn(client, 'createRoom').mockResolvedValue({ room_id: '!assistant:test' })
  expect(await sdk.command({ kind: 'createAssistant', name: '', invite: [bob], direct: true })).toBe('!assistant:test')
  expect(client.createRoom).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ creation_content: { type: MATRIX_ASSISTANT_ROOM_TYPE } })
  )
  expect(latest().roomId).toBe('!assistant:test')
})

it('a controller bootstrap creates the typed room as the agent and grants its owner administration', async () => {
  const { client, sdk } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  vi.spyOn(client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: [] })
  const create = vi.spyOn(client, 'createRoom').mockResolvedValue({ room_id: '!phone-assistant:test' })
  await expect(sdk.command({ kind: 'ensureAssistantConversation', ownerId: bob }))
    .resolves.toBe('!phone-assistant:test')
  expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    invite: [bob],
    is_direct: true,
    creation_content: { type: MATRIX_ASSISTANT_ROOM_TYPE },
    power_level_content_override: { users: { [alice]: 100, [bob]: 100 } }
  }))
})

it('a controller bootstrap reuses its agent-created room while the owner is still invited', async () => {
  const { client, sdk } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  vi.spyOn(client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: ['!pending-phone-assistant:test'] })
  vi.spyOn(client, 'getRoom').mockReturnValue(null)
  vi.spyOn(client, 'roomState').mockResolvedValue([
    {
      type: EventType.RoomCreate, state_key: '', room_id: '!pending-phone-assistant:test',
      event_id: '$create', sender: alice, origin_server_ts: 1,
      content: { type: MATRIX_ASSISTANT_ROOM_TYPE }
    },
    {
      type: EventType.RoomHistoryVisibility, state_key: '', room_id: '!pending-phone-assistant:test',
      event_id: '$history', sender: alice, origin_server_ts: 2,
      content: { history_visibility: 'invited' }
    },
    {
      type: EventType.RoomPowerLevels, state_key: '', room_id: '!pending-phone-assistant:test',
      event_id: '$power', sender: alice, origin_server_ts: 3,
      content: { users: { [alice]: 100, [bob]: 100 } }
    },
    {
      type: EventType.RoomMember, state_key: alice, room_id: '!pending-phone-assistant:test',
      event_id: '$agent', sender: alice, origin_server_ts: 4,
      content: { membership: 'join' }
    },
    {
      type: EventType.RoomMember, state_key: bob, room_id: '!pending-phone-assistant:test',
      event_id: '$owner', sender: alice, origin_server_ts: 5,
      content: { membership: 'invite' }
    }
  ])
  const create = vi.spyOn(client, 'createRoom')

  await expect(sdk.command({ kind: 'ensureAssistantConversation', ownerId: bob }))
    .resolves.toBe('!pending-phone-assistant:test')
  expect(create).not.toHaveBeenCalled()
})

it('a controller bootstrap adopts an owner-created invitation instead of making the reverse room', async () => {
  const { client, sdk } = await fixture(undefined, alice, 'AGENT', false)
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  vi.spyOn(client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: [] })
  holdAssistantRoom(client, '!owner-first:test', {
    ownerId: bob,
    agentId: alice,
    creator: bob,
    ownerMembership: 'join',
    agentMembership: 'invite'
  })
  vi.spyOn(client, 'joinRoom').mockImplementation(async roomId => {
    holdAssistantRoom(client, roomId, {
      ownerId: bob,
      agentId: alice,
      creator: bob,
      ownerMembership: 'join',
      agentMembership: 'join'
    })

    return client.getRoom(roomId)!
  })
  vi.spyOn(client, 'roomState').mockResolvedValue(
    assistantRoomState('!owner-first:test', {
      ownerId: bob,
      agentId: alice,
      creator: bob,
      ownerMembership: 'join',
      agentMembership: 'join'
    }) as never
  )
  const create = vi.spyOn(client, 'createRoom')

  await expect(sdk.command({ kind: 'ensureAssistantConversation', ownerId: bob }))
    .resolves.toBe('!owner-first:test')
  expect(client.joinRoom).toHaveBeenCalledExactlyOnceWith('!owner-first:test')
  expect(create).not.toHaveBeenCalled()
})

it('concurrent first-run creators converge on the controller room instead of leaving two rooms', async () => {
  const owner = await fixture(undefined, bob, 'OWNER', false)
  const agent = await fixture(undefined, alice, 'AGENT', false)
  owner.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  agent.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  vi.spyOn(owner.client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: [] })
  vi.spyOn(agent.client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: [] })
  const roomId = '!controller-wins:test'
  const ownerCreate = vi.spyOn(owner.client, 'createRoom')

  const agentCreate = vi.spyOn(agent.client, 'createRoom').mockImplementation(async () => {
    const invitation = {
      ownerId: bob,
      agentId: alice,
      creator: alice,
      ownerMembership: 'invite' as const,
      agentMembership: 'join' as const
    }

    holdAssistantRoom(owner.client, roomId, invitation)
    holdAssistantRoom(agent.client, roomId, invitation)

    return { room_id: roomId }
  })

  vi.spyOn(owner.client, 'joinRoom').mockImplementation(async joined => {
    holdAssistantRoom(owner.client, joined, {
      ownerId: bob,
      agentId: alice,
      creator: alice,
      ownerMembership: 'join',
      agentMembership: 'join'
    })

    return owner.client.getRoom(joined)!
  })
  vi.spyOn(owner.client, 'roomState').mockImplementation(async joined =>
    assistantRoomState(joined, {
      ownerId: bob,
      agentId: alice,
      creator: alice,
      ownerMembership: 'join',
      agentMembership: 'join'
    }) as never
  )

  const ownerOpening = owner.sdk.command({
    kind: 'createAssistant',
    name: '',
    invite: [alice],
    direct: true,
    adoptAgentInvite: true
  })

  const controllerBootstrap = agent.sdk.command({ kind: 'ensureAssistantConversation', ownerId: bob })

  await expect(Promise.all([ownerOpening, controllerBootstrap])).resolves.toEqual([roomId, roomId])
  expect(agentCreate).toHaveBeenCalledOnce()
  expect(ownerCreate).not.toHaveBeenCalled()
  expect(owner.client.joinRoom).toHaveBeenCalledExactlyOnceWith(roomId)
})

function ownerFirstRunSetup(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  options: { arrivesAfterMs: number | null; history: 'empty' | 'messages' | 'fails' }
) {
  const { client } = fixtureValue
  vi.spyOn(client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: [] })

  const create = vi.spyOn(client, 'createRoom').mockImplementation(async () => {
    if (options.arrivesAfterMs !== null) {
      setTimeout(() => {
        const invitation = holdAssistantRoom(client, '!controller:test', {
          ownerId: bob, agentId: alice, creator: alice,
          ownerMembership: 'invite', agentMembership: 'join'
        })

        client.emit(ClientEvent.Room, invitation)
      }, options.arrivesAfterMs)
    }

    return { room_id: '!owner:test' }
  })

  const join = vi.spyOn(client, 'joinRoom').mockImplementation(async roomId => {
    holdAssistantRoom(client, roomId, {
      ownerId: bob, agentId: alice, creator: alice,
      ownerMembership: 'join', agentMembership: 'join'
    })

    return client.getRoom(roomId)!
  })

  vi.spyOn(client, 'roomState').mockImplementation(async roomId =>
    assistantRoomState(roomId, {
      ownerId: bob, agentId: alice, creator: alice,
      ownerMembership: 'join', agentMembership: 'join'
    }) as never
  )

  const stateOnly = [
    { type: EventType.RoomMember, state_key: bob },
    { type: EventType.RoomMember, state_key: alice },
    { type: EventType.RoomHistoryVisibility, state_key: '' },
    { type: EventType.RoomCreate, state_key: '' }
  ]

  const history = vi.spyOn(client, 'createMessagesRequest').mockImplementation(async () => {
    if (options.history === 'fails') {throw new Error('network')}

    return { chunk: options.history === 'messages'
      ? [{ type: EventType.RoomMessage, event_id: '$message' }, ...stateOnly]
      : stateOnly } as never
  })

  const leave = vi.spyOn(client, 'leave').mockResolvedValue({} as never)

  return { create, history, join, leave }
}

const createFirstAssistant: MatrixSdkCommand = {
  kind: 'createAssistant', name: '', invite: [alice], direct: true, adoptAgentInvite: true
}

it('adopts a controller invite that crosses the post-create settle and leaves the empty owner room', async () => {
  const value = await fixture(undefined, bob, 'OWNER', false)
  value.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const calls = ownerFirstRunSetup(value, { arrivesAfterMs: 300, history: 'empty' })
  await expect(value.sdk.command(createFirstAssistant)).resolves.toBe('!controller:test')
  expect(calls.create).toHaveBeenCalledOnce()
  expect(calls.join).toHaveBeenCalledExactlyOnceWith('!controller:test')
  expect(calls.leave).toHaveBeenCalledExactlyOnceWith('!owner:test')
  expect(value.latest().roomId).toBe('!controller:test')
})

it('keeps a crossing owner room that already has a message while selecting the controller room', async () => {
  const value = await fixture(undefined, bob, 'OWNER', false)
  value.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const calls = ownerFirstRunSetup(value, { arrivesAfterMs: 300, history: 'messages' })
  await expect(value.sdk.command(createFirstAssistant)).resolves.toBe('!controller:test')
  expect(calls.leave).not.toHaveBeenCalled()
  expect(value.latest().roomId).toBe('!controller:test')
})

it('keeps a crossing owner room when its history cannot be read', async () => {
  const value = await fixture(undefined, bob, 'OWNER', false)
  value.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const calls = ownerFirstRunSetup(value, { arrivesAfterMs: 300, history: 'fails' })
  await expect(value.sdk.command(createFirstAssistant)).resolves.toBe('!controller:test')
  expect(calls.leave).not.toHaveBeenCalled()
})

it('falls back to the owner room after the bounded roughly-two-second invite wait expires', async () => {
  const value = await fixture(undefined, bob, 'OWNER', false)
  value.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const calls = ownerFirstRunSetup(value, { arrivesAfterMs: null, history: 'empty' })
  const started = Date.now()
  await expect(value.sdk.command(createFirstAssistant)).resolves.toBe('!owner:test')
  expect(calls.create).toHaveBeenCalledOnce()
  expect(Date.now() - started).toBeGreaterThanOrEqual(
    MATRIX_ASSISTANT_INVITE_WAIT_MS + MATRIX_ASSISTANT_POST_CREATE_SETTLE_MS - 100
  )
})

it('reconciles one invite arriving after the settle without leaving an active owner room', async () => {
  const value = await fixture(undefined, bob, 'OWNER', false)
  value.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const calls = ownerFirstRunSetup(value, { arrivesAfterMs: 1_200, history: 'messages' })
  await expect(value.sdk.command(createFirstAssistant)).resolves.toBe('!owner:test')
  await vi.waitFor(() => expect(value.latest().roomId).toBe('!controller:test'), { timeout: 3_000 })
  expect(calls.join).toHaveBeenCalledExactlyOnceWith('!controller:test')
  expect(calls.leave).not.toHaveBeenCalled()
})

it('retries a stale invite join, then falls through to owner creation instead of failing first run', async () => {
  const value = await fixture(undefined, bob, 'OWNER', false)
  value.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const calls = ownerFirstRunSetup(value, { arrivesAfterMs: null, history: 'empty' })
  holdAssistantRoom(value.client, '!stale-controller:test', {
    ownerId: bob, agentId: alice, creator: alice,
    ownerMembership: 'invite', agentMembership: 'join'
  })
  calls.join.mockRejectedValue(Object.assign(new Error('forbidden'), { errcode: 'M_FORBIDDEN' }))
  await expect(value.sdk.command(createFirstAssistant)).resolves.toBe('!owner:test')
  expect(calls.join.mock.calls.length).toBeGreaterThanOrEqual(3)
  expect(calls.create).toHaveBeenCalledOnce()
})

it('returns the already-created owner room when a crossing invite cannot be joined', async () => {
  const value = await fixture(undefined, bob, 'OWNER', false)
  value.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const calls = ownerFirstRunSetup(value, { arrivesAfterMs: 300, history: 'empty' })
  calls.join.mockRejectedValue(new Error('temporary'))
  await expect(value.sdk.command(createFirstAssistant)).resolves.toBe('!owner:test')
  expect(calls.create).toHaveBeenCalledOnce()
  expect(calls.leave).not.toHaveBeenCalled()
  expect(value.latest().roomId).toBe('!owner:test')
})

it('does not fall back after joining a crossing invite whose full state cannot be validated', async () => {
  const value = await fixture(undefined, bob, 'OWNER', false)
  value.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const calls = ownerFirstRunSetup(value, { arrivesAfterMs: 300, history: 'empty' })
  vi.mocked(value.client.roomState).mockRejectedValue(new Error('temporary'))
  await expect(value.sdk.command(createFirstAssistant)).rejects.toThrow('matrix_assistant_room_adoption_uncertain')
  expect(calls.create).toHaveBeenCalledOnce()
  expect(calls.leave).not.toHaveBeenCalled()
})

it('controller bootstrap keeps its joined main instead of adopting a newer pending owner invite', async () => {
  const value = await fixture(undefined, alice, 'AGENT', false)
  value.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  holdAssistantRoom(value.client, '!joined-main:test', {
    ownerId: bob, agentId: alice, creator: bob,
    ownerMembership: 'join', agentMembership: 'join'
  })
  holdAssistantRoom(value.client, '!pending-owner:test', {
    ownerId: bob, agentId: alice, creator: bob,
    ownerMembership: 'join', agentMembership: 'invite'
  })
  vi.spyOn(value.client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: ['!joined-main:test'] })
  vi.spyOn(value.client, 'roomState').mockResolvedValue(
    assistantRoomState('!joined-main:test', {
      ownerId: bob, agentId: alice, creator: bob,
      ownerMembership: 'join', agentMembership: 'join'
    }) as never
  )
  const join = vi.spyOn(value.client, 'joinRoom')
  await expect(value.sdk.command({ kind: 'ensureAssistantConversation', ownerId: bob }))
    .resolves.toBe('!joined-main:test')
  expect(join).not.toHaveBeenCalled()
})

it('rejects a retired assistant invitation with no enrollment before sending any SDK invite', async () => {
  const { client, sdk } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  vi.spyOn(client, 'roomState').mockResolvedValue([
    {
      type: EventType.RoomCreate,
      state_key: '',
      content: { type: MATRIX_ASSISTANT_ROOM_TYPE },
      event_id: '$create',
      sender: alice,
      room_id: '!first:test',
      origin_server_ts: 1
    }
  ])
  const invite = vi.spyOn(client, 'invite')
  await expect(sdk.command({ kind: 'inviteHuman', roomId: '!first:test', userId: bob })).rejects.toThrow(
    'matrix_private_assistant_room_required'
  )
  expect(invite).not.toHaveBeenCalled()
})

it('does not read room state or invite while offline', async () => {
  const { client, sdk } = await fixture()
  const read = vi.spyOn(client, 'roomState')
  const invite = vi.spyOn(client, 'invite')
  await expect(sdk.command({ kind: 'inviteHuman', roomId: '!first:test', userId: bob })).rejects.toThrow(
    'matrix_offline'
  )
  expect(read).not.toHaveBeenCalled()
  expect(invite).not.toHaveBeenCalled()
})

it('does not invite when readiness is lost during the full room-state read', async () => {
  const { client, sdk } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const pending = deferred<Awaited<ReturnType<MatrixClient['roomState']>>>()
  vi.spyOn(client, 'roomState').mockReturnValue(pending.promise)
  const invite = vi.spyOn(client, 'invite')
  const operation = sdk.command({ kind: 'inviteHuman', roomId: '!first:test', userId: bob })
  const rejected = expect(operation).rejects.toThrow('matrix_private_assistant_room_required')
  client.emit(ClientEvent.Sync, SyncState.Stopped, SyncState.Prepared)
  pending.resolve([])
  await rejected
  expect(invite).not.toHaveBeenCalled()
})

it('a delayed join preserves selection and records the incoming standard DM hint', async () => {
  const { client, sdk, latest } = await fixture()
  const invited = room(client, '!invite:test', 'invite', true)
  const pending = deferred<Room>()
  vi.spyOn(client, 'joinRoom').mockReturnValue(pending.promise)
  const operation = sdk.command({ kind: 'join', roomId: invited.roomId })
  await sdk.command({ kind: 'select', roomId: '!other:test' })
  pending.resolve(invited)
  await operation
  expect(latest().roomId).toBe('!other:test')
  await vi.waitFor(() =>
    expect(client.setAccountDataRaw).toHaveBeenCalledWith(EventType.Direct, { [bob]: [invited.roomId] })
  )
})

it('a background company invitation join does not select the room', async () => {
  const { client, sdk, latest } = await fixture()
  const invited = room(client, '!private-cos-invite:test', 'invite', true)
  vi.spyOn(client, 'joinRoom').mockResolvedValue(invited)
  await sdk.command({ kind: 'select', roomId: '!other:test' })

  await sdk.command({ kind: 'join', roomId: invited.roomId, select: false })

  expect(latest().roomId).toBe('!other:test')
})

it('leaving a previous room does not clear the newly selected room', async () => {
  const { client, sdk, latest } = await fixture()
  const pending = deferred<{}>()
  vi.spyOn(client, 'leave').mockReturnValue(pending.promise)
  const operation = sdk.command({ kind: 'leave', roomId: '!first:test' })
  await sdk.command({ kind: 'select', roomId: '!other:test' })
  pending.resolve({})
  await operation
  expect(latest().roomId).toBe('!other:test')
})

it('returns successful creation without waiting for optional DM metadata, then reports metadata failure', async () => {
  const { client, sdk, latest } = await fixture()
  vi.spyOn(client, 'createRoom').mockResolvedValue({ room_id: '!new:test' })
  const pending = deferred<Record<string, string[]>>()
  vi.mocked(client.getAccountDataFromServer).mockReturnValue(pending.promise)
  vi.mocked(client.setAccountDataRaw).mockRejectedValue(new Error('offline'))
  expect(await sdk.command({ kind: 'create', name: 'Bob', invite: [bob], direct: true })).toBe('!new:test')
  expect(latest().roomId).toBe('!new:test')
  expect(client.setAccountDataRaw).not.toHaveBeenCalled()
  pending.resolve({})
  await vi.waitFor(() => expect(latest().error).toBe('matrix_direct_mapping_pending'))
  expect(client.createRoom).toHaveBeenCalledTimes(1)
  await sdk.command({ kind: 'select', roomId: '!other:test' })
  expect(latest().error).toBeNull()
})

it.each([
  ['with only the owner’s assistants, shows its members the group’s history like any group', [], 'shared'],
  ['with people, shows its members the group’s history', [bob], 'shared']
])('makes a group %s', async (_name, people, history) => {
  const { client, sdk } = await fixture()
  const create = vi.spyOn(client, 'createRoom').mockResolvedValue({ room_id: '!new:test' })
  await sdk.command({ kind: 'createGroup', name: 'Plans', invite: people, agents: ['@gigi:test'] })
  const state = create.mock.calls[0][0].initial_state ?? []
  expect(state.some(each => each.type === EventType.RoomEncryption)).toBe(false)
  expect(state.find(each => each.type === EventType.RoomHistoryVisibility)?.content).toEqual({
    history_visibility: history
  })
})

it('does not publish or write pending metadata after the SDK is stopped', async () => {
  const { client, sdk, snapshots } = await fixture()
  vi.spyOn(client, 'createRoom').mockResolvedValue({ room_id: '!new:test' })
  const pending = deferred<Record<string, string[]>>()
  vi.mocked(client.getAccountDataFromServer).mockReturnValue(pending.promise)
  await sdk.command({ kind: 'create', name: 'Bob', invite: [bob], direct: true })
  await sdk.stop()
  const count = snapshots.length
  pending.resolve({})
  await pending.promise
  await Promise.resolve()
  expect(client.setAccountDataRaw).not.toHaveBeenCalled()
  expect(snapshots).toHaveLength(count)
  await expect(sdk.command({ kind: 'select', roomId: '!first:test' })).rejects.toThrow('matrix_sdk_stopped')
})

it('serializes this client’s optional DM writes without serializing room creation', async () => {
  const { client, sdk } = await fixture()
  // Keep the actual SDK read/setAccountData semantics: reads are cached after
  // sync, and HTTP PUT success is not yet a cache update.
  vi.mocked(client.getAccountDataFromServer).mockRestore()
  vi.spyOn(client, 'isInitialSyncComplete').mockReturnValue(true)
  client.clientRunning = true

  const echo = (content: Record<string, string[]>) => {
    const event = new MatrixEvent({ type: EventType.Direct, content })
    client.store.storeAccountDataEvents([event])
    client.emit(ClientEvent.AccountData, event, undefined)
  }

  vi.spyOn(client, 'createRoom')
    .mockResolvedValueOnce({ room_id: '!one:test' })
    .mockResolvedValueOnce({ room_id: '!two:test' })
  await sdk.command({ kind: 'create', name: 'Bob', invite: [bob], direct: true })
  await sdk.command({ kind: 'create', name: 'Carol', invite: ['@carol:test'], direct: true })
  expect(client.createRoom).toHaveBeenCalledTimes(2)
  // Drain already queued microtasks before deliberately delivering the sync echo.
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(client.setAccountDataRaw).toHaveBeenCalledTimes(1)
  echo({ [bob]: ['!one:test'] })
  await vi.waitFor(() => expect(client.setAccountDataRaw).toHaveBeenCalledTimes(2))
  const expected = { [bob]: ['!one:test'], '@carol:test': ['!two:test'] }
  expect(client.setAccountDataRaw).toHaveBeenLastCalledWith(EventType.Direct, expected)
  echo(expected)
})

it('uses the SDK encrypted-message permission and retains a kicked selected room as read-only', async () => {
  const { client, sdk, latest } = await fixture()
  const selected = client.getRoom('!first:test')!

  const powers = (encrypted: number, plaintext: number) =>
    selected.currentState.setStateEvents([
      new MatrixEvent({
        type: EventType.RoomPowerLevels,
        state_key: '',
        room_id: selected.roomId,
        sender: alice,
        content: { events: { [EventType.RoomMessageEncrypted]: encrypted, [EventType.RoomMessage]: plaintext } }
      })
    ])

  powers(50, 0)
  await sdk.command({ kind: 'select', roomId: selected.roomId })
  expect(latest().canSend).toBe(false)
  powers(0, 50)
  await sdk.command({ kind: 'select', roomId: selected.roomId })
  expect(latest().canSend).toBe(true)
  selected.updateMyMembership('leave')
  client.emit(RoomEvent.MyMembership, selected, 'leave', 'join')
  await vi.waitFor(() => expect(latest().canSend).toBe(false))
  expect(latest().roomId).toBe(selected.roomId)
  expect(latest().rooms.find(value => value.id === selected.roomId)?.membership).toBe('leave')
})

async function readFixture(fetcher?: typeof fetch) {
  const value = await fixture(fetcher)
  const selected = value.client.getRoom('!first:test')!
  selected.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomMember,
      room_id: selected.roomId,
      state_key: bob,
      sender: bob,
      content: { membership: 'join' }
    })
  ])

  const first = new MatrixEvent({
    event_id: '$first',
    room_id: selected.roomId,
    type: EventType.RoomMessage,
    sender: alice,
    origin_server_ts: 200,
    content: { msgtype: 'm.text', body: 'First' }
  })

  const last = new MatrixEvent({
    event_id: '$last',
    room_id: selected.roomId,
    type: EventType.RoomMessage,
    sender: bob,
    origin_server_ts: 100,
    content: { msgtype: 'm.text', body: 'Last despite earlier clock' }
  })

  await selected.addLiveEvents([first, last], { addToState: true })
  const write = vi.spyOn(value.client, 'setRoomReadMarkersHttpRequest').mockResolvedValue({})
  value.client.emit(ClientEvent.Sync, SyncState.Syncing, null)

  let receiptTime = 0

  const receipt = (userId: string, eventId: string, synthetic = false, type = 'm.read') => {
    const event = new MatrixEvent({
      type: EventType.Receipt,
      content: { [eventId]: { [type]: { [userId]: { ts: ++receiptTime } } } }
    })

    selected.addReceipt(event, synthetic)
    value.client.emit(RoomEvent.Receipt, event, selected)
  }

  const marker = (eventId: string) => {
    const event = new MatrixEvent({ type: EventType.FullyRead, content: { event_id: eventId } })
    selected.addAccountData([event])
    value.client.emit(RoomEvent.AccountData, event, selected)
  }

  return { ...value, selected, first, last, write, receipt, marker }
}

function ignoreEcho(client: MatrixClient, users: string[]) {
  const event = new MatrixEvent({
    type: EventType.IgnoredUserList,
    content: {
      ignored_users: Object.fromEntries(users.map(id => [id, {}]))
    }
  })

  client.store.storeAccountDataEvents([event])
  client.emit(ClientEvent.AccountData, event, undefined)
}

it('freezes the fully-read marker for one room visit before receipts can advance it', async () => {
  const f = await readFixture()
  await f.sdk.command({ kind: 'select', roomId: '!other:test' })
  f.marker('$first')
  await f.sdk.command({ kind: 'select', roomId: f.selected.roomId })
  expect(f.latest().readMarkerEventId).toBe('$first')

  f.marker('$last')
  expect(f.latest().readMarkerEventId).toBe('$first')

  await f.sdk.command({ kind: 'select', roomId: '!other:test' })
  await f.sdk.command({ kind: 'select', roomId: f.selected.roomId })
  expect(f.latest().readMarkerEventId).toBe('$last')
})

it('projects Ignore over cached messages without changing history, send authority or other rooms', async () => {
  const { client, selected, latest } = await readFixture()

  const encrypted = new MatrixEvent({
    event_id: '$hidden-encrypted',
    room_id: selected.roomId,
    type: EventType.RoomMessageEncrypted,
    sender: bob,
    content: { algorithm: 'm.megolm.v1.aes-sha2' }
  })

  await selected.addLiveEvents([encrypted], { addToState: true })
  ignoreEcho(client, [bob])
  await vi.waitFor(() => expect(latest().ignoredUsers).toEqual([bob]))
  expect(latest().messages.map(message => message.id)).toEqual(['$first'])
  expect(latest().canSend).toBe(true)
  expect(latest().rooms.map(room => room.id)).toContain('!other:test')
  expect(selected.getLiveTimeline().getEvents()).toHaveLength(3)
  ignoreEcho(client, [])
  await vi.waitFor(() => expect(latest().messages.map(message => message.id)).toContain('$last'))
})

it('hides cached invitations from ignored senders, clears their selection, and restores without auto-opening', async () => {
  const { sdk, client, latest } = await fixture()
  const invited = room(client, '!invite:test', 'invite')
  await sdk.command({ kind: 'select', roomId: invited.roomId })
  ignoreEcho(client, [bob])
  await vi.waitFor(() => expect(latest().roomId).toBeNull())
  expect(latest().rooms.map(room => room.id)).not.toContain(invited.roomId)
  expect(client.getRoom(invited.roomId)).toBe(invited)
  const join = vi.spyOn(client, 'joinRoom')
  await expect(sdk.command({ kind: 'select', roomId: invited.roomId })).rejects.toThrow()
  await expect(sdk.command({ kind: 'join', roomId: invited.roomId })).rejects.toThrow()
  expect(join).not.toHaveBeenCalled()
  ignoreEcho(client, [])
  await vi.waitFor(() => expect(latest().rooms.map(room => room.id)).toContain(invited.roomId))
  expect(latest().roomId).toBeNull()
})

it('serializes ignore edits without optimistic account state, releases on failure, and refuses offline writes', async () => {
  const { sdk, client, latest } = await fixture()
  const command = { kind: 'ignore' as const, userId: bob, ignored: true }
  await expect(sdk.command(command)).rejects.toThrow('matrix_ignore_unavailable')
  client.emit(ClientEvent.Sync, SyncState.Syncing, null)
  const pending = deferred<{ ignored_users: {} }>()
  const read = vi.spyOn(client.http, 'authedRequest').mockReturnValue(pending.promise)
  const edit = sdk.command(command)
  await expect(sdk.command(command)).rejects.toThrow('matrix_ignore_unavailable')
  pending.resolve({ ignored_users: {} })
  await edit
  expect(latest().ignoredUsers).toEqual([])
  expect(client.setAccountDataRaw).toHaveBeenCalledExactlyOnceWith(EventType.IgnoredUserList, {
    ignored_users: { [bob]: {} }
  })
  read.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ignored_users: { [bob]: {} } })
  await expect(sdk.command(command)).rejects.toThrow('offline')
  await sdk.command({ ...command, ignored: false })
  expect(client.setAccountDataRaw).toHaveBeenLastCalledWith(EventType.IgnoredUserList, { ignored_users: {} })
})

it('does not write a delayed old-account ignore edit or leak its snapshot into a new SDK', async () => {
  const old = await fixture()
  old.client.emit(ClientEvent.Sync, SyncState.Syncing, null)
  ignoreEcho(old.client, [bob])
  const pending = deferred<{ ignored_users: {} }>()
  vi.spyOn(old.client.http, 'authedRequest').mockReturnValue(pending.promise)
  const edit = old.sdk.command({ kind: 'ignore', userId: '@carol:test', ignored: true })
  const rejected = expect(edit).rejects.toThrow('matrix_sdk_stopped')
  await old.sdk.stop()
  const count = old.snapshots.length
  const next = await fixture(undefined, '@carol:test', 'CAROL_DEVICE')
  pending.resolve({ ignored_users: {} })
  await rejected
  expect(old.client.setAccountDataRaw).not.toHaveBeenCalled()
  expect(old.snapshots).toHaveLength(count)
  expect(next.latest().ignoredUsers).toEqual([])
  expect(next.latest().identity).toEqual({ userId: '@carol:test', deviceId: 'CAROL_DEVICE' })
})

it('reports only the original synced encrypted event with fixed SDK-owned abuse metadata', async () => {
  const { sdk, client } = await fixture()
  const selected = client.getRoom('!first:test')!

  const event = new MatrixEvent({
    event_id: '$reportable',
    room_id: selected.roomId,
    type: EventType.RoomMessageEncrypted,
    sender: bob,
    content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'ciphertext-only-fixture' }
  })

  await decryptReportFixture(event)
  await selected.addLiveEvents([event], { addToState: true })
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const request = vi.spyOn(client.http, 'authedRequest').mockResolvedValue({})
  const decrypt = vi.spyOn(client, 'decryptEventIfNeeded')
  const command = { kind: 'reportEvent' as const, roomId: selected.roomId, eventId: event.getId()!, userId: bob }

  await expect(sdk.command(command)).resolves.toBeNull()
  expect(request).toHaveBeenCalledExactlyOnceWith(
    Method.Post,
    '/rooms/!first%3Atest/report/%24reportable',
    undefined,
    { reason: 'abuse', score: -100 },
    { prefix: '/_matrix/client/v3' }
  )
  expect(decrypt).not.toHaveBeenCalled()

  const self = new MatrixEvent({
    event_id: '$self',
    room_id: selected.roomId,
    type: EventType.RoomMessageEncrypted,
    sender: alice,
    content: { algorithm: 'm.megolm.v1.aes-sha2' }
  })

  const pending = new MatrixEvent({
    event_id: '$pending',
    room_id: selected.roomId,
    type: EventType.RoomMessageEncrypted,
    sender: bob,
    content: { algorithm: 'm.megolm.v1.aes-sha2' }
  })

  pending.setStatus(EventStatus.SENDING)

  const redacted = new MatrixEvent({
    event_id: '$redacted',
    room_id: selected.roomId,
    type: EventType.RoomMessageEncrypted,
    sender: bob,
    content: { algorithm: 'm.megolm.v1.aes-sha2' }
  })

  vi.spyOn(redacted, 'isRedacted').mockReturnValue(true)

  const undecryptable = new MatrixEvent({
    event_id: '$undecryptable',
    room_id: selected.roomId,
    type: EventType.RoomMessageEncrypted,
    sender: bob,
    content: { algorithm: 'm.megolm.v1.aes-sha2' }
  })

  vi.spyOn(undecryptable, 'isDecryptionFailure').mockReturnValue(true)

  const notYetDecrypted = new MatrixEvent({
    event_id: '$not-yet-decrypted', room_id: selected.roomId,
    type: EventType.RoomMessageEncrypted, sender: bob,
    content: { algorithm: 'm.megolm.v1.aes-sha2' }
  })

  const reaction = new MatrixEvent({
    event_id: '$reaction', room_id: selected.roomId,
    type: EventType.RoomMessageEncrypted, sender: bob,
    content: { algorithm: 'm.megolm.v1.aes-sha2' }
  })

  await decryptReportFixture(reaction, EventType.Reaction)

  for (const rejected of [self, pending, redacted, undecryptable]) {
    await decryptReportFixture(rejected)
  }

  await selected.addLiveEvents([self, pending, redacted, undecryptable, notYetDecrypted, reaction], { addToState: true })

  for (const rejected of [
    { eventId: '$missing', userId: bob },
    { eventId: '$reportable', userId: '@carol:test' },
    { eventId: '$self', userId: alice },
    { eventId: '$pending', userId: bob },
    { eventId: '$redacted', userId: bob },
    { eventId: '$undecryptable', userId: bob },
    { eventId: '$not-yet-decrypted', userId: bob },
    { eventId: '$reaction', userId: bob }
  ]) {
    await expect(sdk.command({ ...command, ...rejected })).rejects.toThrow('matrix_report_target_changed')
  }

  expect(request).toHaveBeenCalledOnce()
})

it('reports a plain message in a plain room, and still refuses plaintext in an encrypted room', async () => {
  const { sdk, client } = await fixture()
  const plain = plainRoomFixture(client, '!plain:test')
  // The crypto store's own record (plain-room.ts): the plain room was never encrypted; the
  // unsynced one is encrypted there though its encryption state has not synced yet.
  const unsynced = plainRoomFixture(client, '!unsynced:test')
  Object.assign(client.getCrypto()!, {
    isEncryptionEnabledInRoom: async (roomId: string) => roomId !== plain.roomId
  })

  const message = new MatrixEvent({
    event_id: '$plain-report',
    room_id: plain.roomId,
    type: EventType.RoomMessage,
    sender: bob,
    content: { msgtype: 'm.text', body: 'plain fixture' }
  })

  await plain.addLiveEvents([message], { addToState: true })
  const encrypted = client.getRoom('!first:test')!

  const downgraded = new MatrixEvent({
    event_id: '$plaintext-in-encrypted',
    room_id: encrypted.roomId,
    type: EventType.RoomMessage,
    sender: bob,
    content: { msgtype: 'm.text', body: 'plaintext fixture' }
  })

  await encrypted.addLiveEvents([downgraded], { addToState: true })

  const injected = new MatrixEvent({
    event_id: '$plaintext-in-unsynced',
    room_id: unsynced.roomId,
    type: EventType.RoomMessage,
    sender: bob,
    content: { msgtype: 'm.text', body: 'plaintext fixture' }
  })

  await unsynced.addLiveEvents([injected], { addToState: true })
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const request = vi.spyOn(client.http, 'authedRequest').mockResolvedValue({})

  await expect(
    sdk.command({ kind: 'reportEvent', roomId: plain.roomId, eventId: '$plain-report', userId: bob })
  ).resolves.toBeNull()
  expect(request).toHaveBeenCalledExactlyOnceWith(
    Method.Post,
    '/rooms/!plain%3Atest/report/%24plain-report',
    undefined,
    { reason: 'abuse', score: -100 },
    { prefix: '/_matrix/client/v3' }
  )
  await expect(
    sdk.command({ kind: 'reportEvent', roomId: encrypted.roomId, eventId: '$plaintext-in-encrypted', userId: bob })
  ).rejects.toThrow('matrix_report_target_changed')
  await expect(
    sdk.command({ kind: 'reportEvent', roomId: unsynced.roomId, eventId: '$plaintext-in-unsynced', userId: bob })
  ).rejects.toThrow('matrix_report_target_changed')
  expect(request).toHaveBeenCalledOnce()
})

it('serializes a report through the installed MatrixHttpApi with only fixed SDK-owned metadata', async () => {
  const requests: Array<{ url: string; method: string; body: string; authorization: string | null }> = []

  const { event, sdk, selected } = await reportHttpFixture(async (input, init) => {
    const request = new Request(input, init)
    requests.push({
      url: request.url,
      method: request.method,
      body: await request.text(),
      authorization: request.headers.get('authorization')
    })

    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  })

  await expect(
    sdk.command({ kind: 'reportEvent', roomId: selected.roomId, eventId: event.getId()!, userId: bob })
  ).resolves.toBeNull()
  expect(requests).toEqual([
    {
      url: 'https://matrix.test/_matrix/client/v3/rooms/!first%3Atest/report/%24http-report',
      method: 'POST',
      body: JSON.stringify({ reason: 'abuse', score: -100 }),
      authorization: 'Bearer synthetic-report-token'
    }
  ])
  const body = JSON.parse(requests[0]!.body) as Record<string, unknown>
  expect(body).toEqual({ reason: 'abuse', score: -100 })
  expect(body).not.toHaveProperty('text')
  expect(body).not.toHaveProperty('account')
})

it('does not retry a rejected MatrixHttpApi report request', async () => {
  const requests: string[] = []

  const { event, sdk, selected } = await reportHttpFixture(async (input, init) => {
    const request = new Request(input, init)
    requests.push(`${request.method} ${request.url}`)

    return new Response(JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'denied by local fixture' }), {
      status: 403,
      headers: { 'content-type': 'application/json' }
    })
  })

  await expect(
    sdk.command({ kind: 'reportEvent', roomId: selected.roomId, eventId: event.getId()!, userId: bob })
  ).rejects.toThrow()
  expect(requests).toEqual(['POST https://matrix.test/_matrix/client/v3/rooms/!first%3Atest/report/%24http-report'])
})

it('does not resolve an old account report after that SDK has stopped', async () => {
  const old = await fixture()
  const selected = old.client.getRoom('!first:test')!

  const event = new MatrixEvent({
    event_id: '$old-account-report',
    room_id: selected.roomId,
    type: EventType.RoomMessageEncrypted,
    sender: bob,
    content: { algorithm: 'm.megolm.v1.aes-sha2' }
  })

  await decryptReportFixture(event)
  await selected.addLiveEvents([event], { addToState: true })
  old.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const network = deferred<{}>()
  vi.spyOn(old.client.http, 'authedRequest').mockReturnValue(network.promise)

  const report = old.sdk.command({
    kind: 'reportEvent',
    roomId: selected.roomId,
    eventId: event.getId()!,
    userId: bob
  })

  await old.sdk.stop()
  const snapshotCount = old.snapshots.length
  const next = await fixture(undefined, '@carol:test', 'CAROL_DEVICE')
  network.resolve({})

  await expect(report).rejects.toThrow('matrix_sdk_stopped')
  expect(old.snapshots).toHaveLength(snapshotCount)
  expect(next.latest().identity).toEqual({ userId: '@carol:test', deviceId: 'CAROL_DEVICE' })
})

async function reportUserFixture() {
  const f = await fixture()
  const selected = f.client.getRoom('!first:test')!
  selected.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomMember,
      state_key: bob,
      room_id: selected.roomId,
      sender: bob,
      content: { membership: 'join' }
    })
  ])

  const message = (id: string, sender: string) =>
    new MatrixEvent({
      event_id: id,
      room_id: selected.roomId,
      type: EventType.RoomMessageEncrypted,
      sender,
      content: { algorithm: 'm.megolm.v1.aes-sha2' }
    })

  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)

  return { ...f, message, selected }
}

it('reports a person with the Matrix user report and only their id and the reason', async () => {
  const { client, sdk, selected } = await reportUserFixture()
  const request = vi.spyOn(client.http, 'authedRequest').mockResolvedValue({})

  await expect(
    sdk.command({ kind: 'reportUser', roomId: selected.roomId, userId: bob, reason: 'spam links' })
  ).resolves.toBeNull()
  await expect(sdk.command({ kind: 'reportUser', roomId: selected.roomId, userId: bob })).resolves.toBeNull()
  expect(request.mock.calls).toEqual([
    [Method.Post, '/users/%40bob%3Atest/report', undefined, { reason: 'spam links' }, { prefix: '/_matrix/client/v3' }],
    [Method.Post, '/users/%40bob%3Atest/report', undefined, { reason: 'abuse' }, { prefix: '/_matrix/client/v3' }]
  ])

  // Never yourself, someone not in this chat, or a chat you are not in.
  for (const command of [
    { roomId: selected.roomId, userId: alice },
    { roomId: selected.roomId, userId: '@carol:test' }
  ]) {
    await expect(sdk.command({ kind: 'reportUser', ...command })).rejects.toThrow('matrix_report_target_changed')
  }

  await expect(sdk.command({ kind: 'reportUser', roomId: '!missing:test', userId: bob })).rejects.toThrow()
  expect(request).toHaveBeenCalledTimes(2)
})

it('without user reports, reports that person’s latest message here instead', async () => {
  const { client, sdk, message, selected } = await reportUserFixture()
  const older = message('$older', bob)
  const latest = message('$latest', bob)
  const own = message('$own', alice)

  for (const event of [older, latest, own]) {
    await decryptReportFixture(event)
  }

  await selected.addLiveEvents([older, latest, own], { addToState: true })

  const request = vi
    .spyOn(client.http, 'authedRequest')
    .mockRejectedValueOnce(Object.assign(new Error('Unrecognized request'), { errcode: 'M_UNRECOGNIZED', httpStatus: 404 }))
    .mockResolvedValue({})

  await expect(
    sdk.command({ kind: 'reportUser', roomId: selected.roomId, userId: bob, reason: 'harassment' })
  ).resolves.toBeNull()
  expect(request.mock.calls[1]).toEqual([
    Method.Post,
    '/rooms/!first%3Atest/report/%24latest',
    undefined,
    { reason: 'harassment', score: -100 },
    { prefix: '/_matrix/client/v3' }
  ])
  expect(request).toHaveBeenCalledTimes(2)
})

it('a refused user report is not retried as a message report; nothing to fall back on says so', async () => {
  const { client, sdk, selected } = await reportUserFixture()

  const request = vi
    .spyOn(client.http, 'authedRequest')
    .mockRejectedValueOnce(Object.assign(new Error('denied'), { errcode: 'M_FORBIDDEN', httpStatus: 403 }))

  await expect(sdk.command({ kind: 'reportUser', roomId: selected.roomId, userId: bob })).rejects.toThrow('denied')
  expect(request).toHaveBeenCalledOnce()

  // An older server, and no message from them to report.
  request.mockRejectedValueOnce(Object.assign(new Error('Unrecognized'), { errcode: 'M_UNRECOGNIZED', httpStatus: 404 }))
  await expect(sdk.command({ kind: 'reportUser', roomId: selected.roomId, userId: bob })).rejects.toThrow(
    'matrix_report_unavailable'
  )
  expect(request).toHaveBeenCalledTimes(2)
})

it('sends the person’s own reason with a message report', async () => {
  const { client, sdk, message, selected } = await reportUserFixture()
  const event = message('$reasoned', bob)
  await decryptReportFixture(event)
  await selected.addLiveEvents([event], { addToState: true })
  const request = vi.spyOn(client.http, 'authedRequest').mockResolvedValue({})

  await sdk.command({ kind: 'reportEvent', roomId: selected.roomId, eventId: '$reasoned', userId: bob, reason: 'scam' })
  expect(request).toHaveBeenCalledExactlyOnceWith(
    Method.Post,
    '/rooms/!first%3Atest/report/%24reasoned',
    undefined,
    { reason: 'scam', score: -100 },
    { prefix: '/_matrix/client/v3' }
  )
})

it('projects only real public receipts on the exact message they name, never a send, private receipt or unknown event', async () => {
  const { selected, first, last, receipt, latest } = await readFixture()
  expect(publicReaders(selected, first)).toEqual([]) // only the SDK's own synthesized receipt exists
  receipt(bob, '$last', true)
  expect(publicReaders(selected, first)).toEqual([])
  expect(publicReaders(selected, last)).toEqual([]) // Bob wrote it
  receipt(bob, '$last', false, 'm.read.private')
  expect(publicReaders(selected, first)).toEqual([])
  // An unknown event proves nothing about this one.
  receipt(bob, '$unknown')
  expect(publicReaders(selected, first)).toEqual([])

  // Exactly where Bob's public receipt sits.
  receipt(bob, '$first')
  expect(publicReaders(selected, first)).toEqual([bob])
  await vi.waitFor(() => expect(latest().messages[0].readBy).toEqual([bob]))

  // A later receipt moves the avatar; it never smears over every earlier message.
  receipt(bob, '$last')
  expect(selected.getReadReceiptForUserId(bob, true)?.eventId).toBe('$last')
  expect(selected.getJoinedMembers().map(member => member.userId)).toContain(bob)
  expect(publicReaders(selected, first)).toEqual([])
  await vi.waitFor(() => expect(latest().messages[0].readBy).toEqual([]))
})

it('loads a room member avatar through authenticated media, and refuses anyone outside the room', async () => {
  const { sdk, client } = await fixture()
  const selected = client.getRoom('!first:test')!
  selected.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomMember,
      room_id: selected.roomId,
      state_key: bob,
      sender: bob,
      content: { membership: 'join', avatar_url: 'mxc://matrix.test/bob' }
    })
  ])
  selected.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomMember,
      room_id: selected.roomId,
      state_key: alice,
      sender: alice,
      content: { membership: 'join' }
    })
  ])

  const authed = vi
    .spyOn(client.http, 'authedRequest')
    .mockResolvedValue(new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])]))

  client.emit(ClientEvent.Sync, SyncState.Prepared, null)

  await expect(sdk.command({ kind: 'memberAvatar', roomId: selected.roomId, userId: bob })).resolves.toEqual({
    userId: bob,
    avatarUrl: 'data:image/png;base64,iVBORw0KGgo='
  })
  expect(authed).toHaveBeenCalledWith(
    'GET',
    '/media/download/matrix.test/bob',
    undefined,
    undefined,
    expect.objectContaining({ prefix: '/_matrix/client/v1', rawResponseBody: true })
  )

  await expect(
    sdk.command({ kind: 'memberAvatar', roomId: selected.roomId, userId: '@stranger:test' })
  ).rejects.toThrow('matrix_member_avatar_unavailable')
})

it("projects an assistant's receipt on your message as read by it, past the SDK's own receipt for its later answer", async () => {
  // Bob answered after Alice's message, so the SDK keeps a made-up receipt for him on that answer.
  const { selected, first, receipt, latest } = await readFixture()
  expect(publicReaders(selected, first)).toEqual([])

  // Exactly what an agent sends once it took the message up (agent-turns v1.1 P2): a public
  // `m.read` with no `thread_id`, on that message itself.
  receipt(bob, '$first')
  expect(publicReaders(selected, first)).toEqual([bob])
  await vi.waitFor(() => expect(latest().messages[0].readBy).toEqual([bob]))
})

it('acknowledges the conversation on screen through the actual SDK session, publicly by default, and nothing else', async () => {
  const { sdk, client, selected, latest, write, marker, receipt } = await readFixture()
  const network = vi.spyOn(client.http, 'authedRequest')
  selected.setUnreadNotificationCount(NotificationCountType.Total, 2)
  client.emit(ClientEvent.Sync, SyncState.Syncing, null)
  expect(latest().rooms[0].unreadNotifications).toBe(2)
  // Selecting is not reading: nothing is sent until the window says the transcript is on screen.
  await sdk.command({ kind: 'select', roomId: selected.roomId })
  await new Promise(resolve => setTimeout(resolve, READ_SETTLE_MS * 2))
  expect(write).not.toHaveBeenCalled()
  expect(network).not.toHaveBeenCalled()

  await expect(sdk.command({ kind: 'attend', roomId: selected.roomId })).resolves.toBeNull()
  await vi.waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith(selected.roomId, '$last', '$last', undefined))
  // Sync, not the request, clears the count: the projection waits for the server.
  expect(latest().rooms[0].unreadNotifications).toBe(2)
  marker('$last')
  receipt(alice, '$last')
  selected.setUnreadNotificationCount(NotificationCountType.Total, 0)
  client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing)
  await vi.waitFor(() => expect(latest().rooms[0].unreadNotifications).toBe(0))

  // A reply arriving while it stays on screen is acknowledged in turn, undecryptable or not.
  const reply = new MatrixEvent({
    event_id: '$reply',
    room_id: selected.roomId,
    type: EventType.RoomMessageEncrypted,
    sender: bob,
    content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'fixture' }
  })

  await selected.addLiveEvents([reply], { addToState: true })
  client.emit(RoomEvent.Timeline, reply, selected, false, false, { liveEvent: true, timeline: selected.getLiveTimeline() })
  await vi.waitFor(() => expect(write).toHaveBeenLastCalledWith(selected.roomId, '$reply', '$reply', undefined))

  // Off screen (another room, a background window) or offline: messages stay unread.
  await sdk.command({ kind: 'attend', roomId: null })

  const unseen = new MatrixEvent({
    event_id: '$unseen',
    room_id: selected.roomId,
    type: EventType.RoomMessage,
    sender: bob,
    content: { msgtype: 'm.text', body: 'Later' }
  })

  await selected.addLiveEvents([unseen], { addToState: true })
  client.emit(RoomEvent.Timeline, unseen, selected, false, false, { liveEvent: true, timeline: selected.getLiveTimeline() })
  await sdk.command({ kind: 'select', roomId: '!other:test' })
  await sdk.command({ kind: 'attend', roomId: selected.roomId })
  await new Promise(resolve => setTimeout(resolve, READ_SETTLE_MS * 2))
  expect(write).toHaveBeenCalledTimes(2)

  await sdk.command({ kind: 'select', roomId: selected.roomId })
  client.emit(ClientEvent.Sync, SyncState.Stopped, SyncState.Syncing)
  await sdk.command({ kind: 'attend', roomId: null })
  await sdk.command({ kind: 'attend', roomId: selected.roomId })
  await new Promise(resolve => setTimeout(resolve, READ_SETTLE_MS * 2))
  expect(write).toHaveBeenCalledTimes(2)
  client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Error)
  await vi.waitFor(() => expect(write).toHaveBeenLastCalledWith(selected.roomId, '$unseen', '$unseen', undefined))

  // A stopped session sends nothing more, whatever arrives.
  await sdk.stop()
  await selected.addLiveEvents(
    [
      new MatrixEvent({
        event_id: '$after-stop',
        room_id: selected.roomId,
        type: EventType.RoomMessage,
        sender: bob,
        content: { msgtype: 'm.text', body: 'After' }
      })
    ],
    { addToState: true }
  )
  await new Promise(resolve => setTimeout(resolve, READ_SETTLE_MS * 2))
  expect(write).toHaveBeenCalledTimes(3)
})

it('keeps receipt projection to the shown messages', async () => {
  const { sdk, selected, latest, marker, receipt } = await readFixture()
  await selected.addLiveEvents(
    Array.from(
      { length: 400 },
      (_, index) =>
        new MatrixEvent({
          event_id: `$long${index}`,
          room_id: selected.roomId,
          type: EventType.RoomMessage,
          sender: alice,
          content: { msgtype: 'm.text', body: `Message ${index}` }
        })
    ),
    { addToState: true }
  )
  marker('$first')
  receipt(bob, '$long399')
  await sdk.command({ kind: 'select', roomId: selected.roomId })
  expect(latest().messages).toHaveLength(200)
  // The avatar sits under the message Bob's receipt names, not under all 400.
  expect(latest().messages.filter(message => message.readBy?.includes(bob)).map(message => message.id)).toEqual([
    '$long399'
  ])
})

it('waits for real encrypted scrollback before exposing the room-start search target', async () => {
  const f = await fixture()
  const selected = f.client.getRoom('!first:test')!
  await selected.addLiveEvents(
    Array.from(
      { length: 50 },
      (_, offset) =>
        new MatrixEvent({
          event_id: `$history${550 + offset}`,
          room_id: selected.roomId,
          type: EventType.RoomMessage,
          sender: offset % 2 ? bob : alice,
          origin_server_ts: 550 + offset,
          content: { msgtype: 'm.text', body: `Message ${550 + offset}` }
        })
    ),
    { addToState: true }
  )
  selected.getLiveTimeline().setPaginationToken('older-550', Direction.Backward)

  let nextOldest = 550

  const scrollback = vi.spyOn(f.client, 'scrollback').mockImplementation(async (room, limit = 30) => {
    const start = Math.max(0, nextOldest - limit)

    const page = Array.from({ length: nextOldest - start }, (_, offset) => nextOldest - offset - 1).map(
      index =>
        new MatrixEvent({
          event_id: `$history${index}`,
          room_id: room.roomId,
          type: EventType.RoomMessageEncrypted,
          sender: index % 2 ? bob : alice,
          origin_server_ts: index,
          content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: `fixture-${index}` }
        })
    )

    room.addEventsToTimeline(page, true, true, room.getLiveTimeline())
    nextOldest = start
    room.getLiveTimeline().setPaginationToken(nextOldest === 0 ? null : `older-${nextOldest}`, Direction.Backward)

    return room
  })

  const finalDecryptStarted = deferred<void>()
  const releaseFinalDecrypt = deferred<void>()

  const decrypt = vi.spyOn(f.client, 'decryptEventIfNeeded').mockImplementation(async event => {
    await Promise.resolve()

    if (event.getId() === '$history20') {
      finalDecryptStarted.resolve(undefined)
      await releaseFinalDecrypt.promise
    }

    const index = Number(event.getId()?.replace('$history', ''))
    await decryptReportFixture(event, EventType.RoomMessage, `Message ${index}${index === 20 ? ' unique-needle' : ''}`)
  })

  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  await f.sdk.command({ kind: 'select', roomId: selected.roomId })
  expect(f.latest().messages).toHaveLength(50)

  for (let page = 1; page <= 10; page++) {
    await expect(f.sdk.command({ kind: 'paginateTimeline', roomId: selected.roomId })).resolves.toMatchObject({
      loaded: 50,
      hasMore: true,
      capped: false
    })
  }

  expect(f.latest().messages).toHaveLength(550)
  const finalPage = f.sdk.command({ kind: 'paginateTimeline', roomId: selected.roomId })
  await finalDecryptStarted.promise
  let settled = false
  void finalPage.then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)

  releaseFinalDecrypt.resolve(undefined)
  await expect(finalPage).resolves.toMatchObject({ loaded: 50, visible: 600, hasMore: false, capped: false })
  expect(f.latest().messages).toHaveLength(600)
  expect(f.latest().messages[0]?.id).toBe('$history0')
  expect(f.latest().messages.find(message => message.id === '$history20')?.body).toContain('unique-needle')
  expect(scrollback).toHaveBeenCalledTimes(11)
  expect(decrypt).toHaveBeenCalledTimes(550)
})

it('reveals cached history after the server token reaches the room start', async () => {
  const f = await fixture()
  const selected = f.client.getRoom('!first:test')!
  await selected.addLiveEvents(
    Array.from(
      { length: 260 },
      (_, index) =>
        new MatrixEvent({
          event_id: `$cached${index}`,
          room_id: selected.roomId,
          type: EventType.RoomMessage,
          sender: index % 2 ? bob : alice,
          origin_server_ts: index,
          content: { msgtype: 'm.text', body: `Cached ${index}` }
        })
    ),
    { addToState: true }
  )
  selected.getLiveTimeline().setPaginationToken(null, Direction.Backward)
  const scrollback = vi.spyOn(f.client, 'scrollback')

  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  await f.sdk.command({ kind: 'select', roomId: selected.roomId })
  expect(f.latest().messages[0]?.id).toBe('$cached60')

  await expect(f.sdk.command({ kind: 'paginateTimeline', roomId: selected.roomId })).resolves.toMatchObject({
    loaded: 0,
    visible: 250,
    hasMore: true,
    capped: false
  })
  expect(f.latest().messages[0]?.id).toBe('$cached10')

  await expect(f.sdk.command({ kind: 'paginateTimeline', roomId: selected.roomId })).resolves.toMatchObject({
    loaded: 0,
    visible: 260,
    hasMore: false,
    capped: false
  })
  expect(f.latest().messages[0]?.id).toBe('$cached0')
  expect(scrollback).not.toHaveBeenCalled()
})

it('caps an in-memory transcript at 40 steps and resets the bound with a new live timeline', async () => {
  const f = await fixture()
  const selected = f.client.getRoom('!first:test')!
  await selected.addLiveEvents(
    Array.from(
      { length: 600 },
      (_, index) =>
        new MatrixEvent({
          event_id: `$history${index}`,
          room_id: selected.roomId,
          type: EventType.RoomMessage,
          sender: index % 2 ? bob : alice,
          origin_server_ts: index,
          content: { msgtype: 'm.text', body: `Message ${index}` }
        })
    ),
    { addToState: true }
  )
  selected.getLiveTimeline().setPaginationToken('older', Direction.Backward)
  const scrollback = vi.spyOn(f.client, 'scrollback').mockResolvedValue(selected)

  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  await f.sdk.command({ kind: 'select', roomId: selected.roomId })
  expect(f.latest().messages).toHaveLength(200)
  expect(f.latest().messages[0]?.id).toBe('$history400')

  for (let page = 1; page <= 8; page++) {
    await expect(f.sdk.command({ kind: 'paginateTimeline', roomId: selected.roomId })).resolves.toMatchObject({
      visible: Math.min(600, 200 + page * 50),
      hasMore: true,
      capped: false
    })
  }

  expect(f.latest().messages).toHaveLength(600)
  expect(f.latest().messages[0]?.id).toBe('$history0')

  let capped: unknown

  for (let page = 8; page < 40; page++) {
    capped = await f.sdk.command({ kind: 'paginateTimeline', roomId: selected.roomId })
  }

  expect(capped).toMatchObject({ visible: 600, hasMore: false, capped: true })
  expect(scrollback).toHaveBeenCalledTimes(32)
  await expect(f.sdk.command({ kind: 'paginateTimeline', roomId: selected.roomId })).resolves.toMatchObject({
    visible: 600,
    hasMore: false,
    capped: true
  })
  expect(scrollback).toHaveBeenCalledTimes(32)

  selected.resetLiveTimeline('reset-older', null)
  await selected.addLiveEvents(
    Array.from(
      { length: 50 },
      (_, index) =>
        new MatrixEvent({
          event_id: `$reset${index}`,
          room_id: selected.roomId,
          type: EventType.RoomMessage,
          sender: alice,
          origin_server_ts: index,
          content: { msgtype: 'm.text', body: `Reset ${index}` }
        })
    ),
    { addToState: true }
  )

  await expect(f.sdk.command({ kind: 'paginateTimeline', roomId: selected.roomId })).resolves.toMatchObject({
    visible: 50,
    hasMore: true,
    capped: false
  })
  expect(scrollback).toHaveBeenCalledTimes(33)
})

it.each(['versions', 'headers', 'body'] as const)(
  'aborts a stalled %s read request and acknowledges again by itself',
  async phase => {
    const deadlines: AbortController[] = []
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      expect(ms).toBe(10_000)
      const controller = new AbortController()
      deadlines.push(controller)

      return controller.signal
    })
    let stall = true

    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      const versions = String(input).endsWith('/versions')

      if (stall && (phase === 'versions' ? versions : !versions)) {
        if (phase === 'body') {
          return new Response(
            new ReadableStream({
              start(controller) {
                init!.signal!.addEventListener(
                  'abort',
                  () => controller.error(new DOMException('Aborted', 'AbortError')),
                  { once: true }
                )
              }
            })
          )
        }

        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true
          })
        })
      }

      if (!versions) {
        posted.push(JSON.parse(String(init!.body)))
      }

      return new Response(JSON.stringify(versions ? { versions: ['v1.4'], unstable_features: {} } : {}))
    })

    const posted: unknown[] = []
    const { sdk, write } = await readFixture(fetcher)
    write.mockRestore() // actual SDK discovery + read_markers + HTTP + bounded fetch
    await sdk.command({ kind: 'attend', roomId: '!first:test' })
    await vi.waitFor(() => expect(deadlines).toHaveLength(phase === 'versions' ? 1 : 2))
    stall = false
    deadlines.at(-1)!.abort()
    // The aborted receipt is retried on its own, publicly: the read marker and m.read only.
    await vi.waitFor(() => expect(posted).toEqual([{ 'm.fully_read': '$last', 'm.read': '$last' }]), {
      timeout: 5_000
    })
  }
)

it('sends one encrypted-room task promise through the actual SDK after a full private-room read', async () => {
  const { client, sdk } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)

  const privateState = [
    { type: EventType.RoomCreate, state_key: '', content: { type: MATRIX_ASSISTANT_ROOM_TYPE } },
    { type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'joined' } },
    { type: EventType.RoomMember, state_key: alice, content: { membership: 'join' } },
    { type: EventType.RoomMember, state_key: bob, content: { membership: 'join' } }
  ].map(e => ({ ...e, sender: alice, event_id: '$state', room_id: '!first:test', origin_server_ts: 1 }))

  vi.spyOn(client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: ['!first:test'] })
  const state = vi.spyOn(client, 'roomState').mockResolvedValue(privateState)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$task' })
  const taskFiles = { version: 1 as const, requestIds: ['00000000-0000-4000-8000-11e594f48195'] }
  expect(
    await sdk.command({ kind: 'sendTaskFiles', roomId: '!first:test', body: 'Use my notes', userId: bob, taskFiles })
  ).toBe('$task')
  expect(state).toHaveBeenCalledWith('!first:test')
  expect(send).toHaveBeenCalledExactlyOnceWith('!first:test', EventType.RoomMessage, {
    msgtype: 'm.text',
    body: 'Use my notes',
    'io.atum.task-files': taskFiles
  })
  state.mockResolvedValueOnce([...privateState, { ...privateState[4], state_key: '@foreign:test' }])
  await expect(
    sdk.command({ kind: 'sendTaskFiles', roomId: '!first:test', body: 'Use my notes', userId: bob, taskFiles })
  ).rejects.toThrow('private_assistant')
  expect(send).toHaveBeenCalledTimes(1)
})

it('deletes a chat through the actual SDK session: leaves, then forgets that room only, and lets go of it', async () => {
  roomSelection(localStorage, alice, 'DEVICE').write('!first:test')
  const { client, sdk, latest } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const order: string[] = []

  const leave = vi.spyOn(client, 'leave').mockImplementation(async roomId => {
    order.push(`leave ${roomId}`)

    return {}
  })

  const forget = vi.spyOn(client.http, 'authedRequest').mockImplementation(async (_method, path) => {
    order.push(`request ${path}`)

    return {} as never
  })

  await sdk.command({ kind: 'forget', roomId: '!first:test' })
  // The server forgets only a room you have left: leave first, then forget, that room alone.
  expect(order).toEqual(['leave !first:test', `request /rooms/${encodeURIComponent('!first:test')}/forget`])
  expect(leave).toHaveBeenCalledExactlyOnceWith('!first:test')
  expect(forget).toHaveBeenCalledOnce()
  // Gone from this client and from the chats, with nothing left selected or restored.
  expect(client.getRoom('!first:test')).toBeNull()
  expect(latest().rooms.map(room => room.id)).toEqual(['!other:test'])
  expect(latest().roomId).toBeNull()
  expect(roomSelection(localStorage, alice, 'DEVICE').read()).toBeNull()

  // A room this client does not have is refused, never guessed at.
  await expect(sdk.command({ kind: 'forget', roomId: '!first:test' })).rejects.toThrow('membership_required')
  await expect(sdk.command({ kind: 'forget', roomId: '!unknown:test' })).rejects.toThrow('membership_required')
  expect(leave).toHaveBeenCalledOnce()
})

it("leaves and forgets a retired agent's chat through the actual SDK session, only after a full room read", async () => {
  const { client, sdk, latest } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)

  const pair = [
    { type: EventType.RoomCreate, state_key: '', content: { type: MATRIX_ASSISTANT_ROOM_TYPE } },
    { type: EventType.RoomMember, state_key: alice, content: { membership: 'join' } },
    { type: EventType.RoomMember, state_key: bob, content: { membership: 'leave' } }
  ].map(e => ({ ...e, sender: alice, event_id: '$state', room_id: '!first:test', origin_server_ts: 1 }))

  const roomState = vi
    .spyOn(client, 'roomState')
    .mockResolvedValueOnce([...pair, { ...pair[1]!, state_key: '@friend:test' }])
    .mockResolvedValue(pair)

  const leave = vi.spyOn(client, 'leave').mockResolvedValue({})
  const forget = vi.spyOn(client.http, 'authedRequest').mockResolvedValue({} as never)
  const command = { kind: 'forgetAgentRoom', roomId: '!first:test', ownerId: alice, agentId: bob } as const

  // A friend was once in it: it stays, untouched.
  await expect(sdk.command(command)).resolves.toBe('kept')
  expect(leave).not.toHaveBeenCalled()
  expect(forget).not.toHaveBeenCalled()
  expect(client.getRoom('!first:test')).not.toBeNull()

  // Only the two of them: left, forgotten, gone from the chats and from the selection.
  await expect(sdk.command(command)).resolves.toBe('forgotten')
  expect(roomState).toHaveBeenCalledTimes(2)
  expect(leave).toHaveBeenCalledExactlyOnceWith('!first:test')
  expect(forget).toHaveBeenCalledOnce()
  expect(client.getRoom('!first:test')).toBeNull()
  expect(latest().rooms.map(room => room.id)).toEqual(['!other:test'])
  expect(latest().roomId).toBeNull()

  // Already gone: refused, never guessed at.
  await expect(sdk.command(command)).rejects.toThrow('membership_required')
  expect(roomState).toHaveBeenCalledTimes(2)
})

it("does not keep a retired agent's chat for good when sync drops while its state is read", async () => {
  const { client, sdk } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)

  const pair = [
    { type: EventType.RoomCreate, state_key: '', content: { type: MATRIX_ASSISTANT_ROOM_TYPE } },
    { type: EventType.RoomMember, state_key: alice, content: { membership: 'join' } },
    { type: EventType.RoomMember, state_key: bob, content: { membership: 'leave' } }
  ].map(e => ({ ...e, sender: alice, event_id: '$state', room_id: '!first:test', origin_server_ts: 1 }))

  vi.spyOn(client, 'roomState').mockImplementationOnce(async () => {
    client.emit(ClientEvent.Sync, SyncState.Stopped, SyncState.Prepared)

    return pair
  })

  const leave = vi.spyOn(client, 'leave').mockResolvedValue({})
  const command = { kind: 'forgetAgentRoom', roomId: '!first:test', ownerId: alice, agentId: bob } as const

  // A failure that may pass, so main tries again; never "kept", which main never asks again.
  await expect(sdk.command(command)).rejects.toThrow('matrix_sdk_stopped')
  expect(leave).not.toHaveBeenCalled()
  expect(client.getRoom('!first:test')).not.toBeNull()
})

it('forgets a chat already left without leaving again, and keeps another open chat selected', async () => {
  const { client, sdk, latest } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  client.getRoom('!other:test')!.updateMyMembership('leave')
  const leave = vi.spyOn(client, 'leave').mockResolvedValue({})
  vi.spyOn(client.http, 'authedRequest').mockResolvedValue({} as never)

  await sdk.command({ kind: 'forget', roomId: '!other:test' })
  expect(leave).not.toHaveBeenCalled()
  expect(client.getRoom('!other:test')).toBeNull()
  expect(latest().roomId).toBe('!first:test')
})

it('refuses to delete a chat while the chats are not ready', async () => {
  const { client, sdk } = await fixture()
  const leave = vi.spyOn(client, 'leave').mockResolvedValue({})

  await expect(sdk.command({ kind: 'forget', roomId: '!first:test' })).rejects.toThrow('membership_required')
  expect(leave).not.toHaveBeenCalled()
})

it('sends a reply through the actual SDK only to a message of the selected room, and a plain send unchanged', async () => {
  const { client, sdk } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const selected = client.getRoom('!first:test')!
  await selected.addLiveEvents(
    [
      new MatrixEvent({
        type: EventType.RoomMessage,
        room_id: selected.roomId,
        event_id: '$question',
        sender: bob,
        origin_server_ts: 1,
        content: { msgtype: 'm.text', body: 'Dinner?' }
      })
    ],
    { addToState: false }
  )
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$reply' })
  const plain = vi.spyOn(client, 'sendTextMessage').mockResolvedValue({ event_id: '$plain' })

  expect(await sdk.command({ kind: 'send', roomId: selected.roomId, body: 'Yes', replyTo: '$question' })).toBe('$reply')
  expect(send).toHaveBeenCalledExactlyOnceWith(selected.roomId, EventType.RoomMessage, {
    msgtype: 'm.text',
    body: 'Yes',
    'm.relates_to': { 'm.in_reply_to': { event_id: '$question' } }
  })
  await expect(sdk.command({ kind: 'send', roomId: '!other:test', body: 'Yes', replyTo: '$question' })).rejects.toThrow(
    'matrix_message_changed'
  )
  expect(await sdk.command({ kind: 'send', roomId: selected.roomId, body: 'Plain' })).toBe('$plain')
  expect(plain).toHaveBeenCalledExactlyOnceWith(selected.roomId, 'Plain')
  expect(send).toHaveBeenCalledTimes(1)
})

it('adds the private Chief of Staff agent mention to an ordinary plain-room message',async()=>{
  const {client,sdk}=await fixture()
  client.emit(ClientEvent.Sync,SyncState.Prepared,null)
  const target=new Room('!private-cos:test',client,alice)

  const state=(type:string,stateKey:string,content:Record<string,unknown>,sender=alice)=>new MatrixEvent({
    type,state_key:stateKey,room_id:target.roomId,sender,content
  } as never)

  target.currentState.setStateEvents([
    state(EventType.RoomCreate,'',{type:'io.atum.assistant'}),
    state(EventType.RoomName,'',{name:'Chief of Staff'}),
    state('io.atum.company_private_cos','',{v:1,classification:'company_private_cos',
      companyId:'00000000-0000-4000-8000-435c1d9ce575',
      membershipIncarnation:'00000000-0000-4000-8000-e860663e054f',
      executorId:'00000000-0000-4000-8000-876425eb0072',
      attemptId:'00000000-0000-4000-8000-77b665e3862d'}),
    state(EventType.RoomMember,alice,{membership:'join'}),
    state(EventType.RoomMember,bob,{membership:'join'},bob)
  ])
  target.updateMyMembership('join');client.store.storeRoom(target)
  await sdk.command({kind:'select',roomId:target.roomId})
  const send=vi.spyOn(client,'sendEvent').mockResolvedValue({event_id:'$private'})
  const plain=vi.spyOn(client,'sendTextMessage').mockResolvedValue({event_id:'$plain'})

  await expect(sdk.command({kind:'send',roomId:target.roomId,body:'Please help'})).resolves.toBe('$private')
  expect(send).toHaveBeenCalledWith(target.roomId,EventType.RoomMessage,{
    msgtype:'m.text',body:'Please help','m.mentions':{user_ids:[bob]}
  })
  await target.addLiveEvents([new MatrixEvent({type:EventType.RoomMessage,room_id:target.roomId,
    event_id:'$private-question',sender:bob,origin_server_ts:1,content:{msgtype:'m.text',body:'Question'}})],
  {addToState:false})
  await expect(sdk.command({kind:'send',roomId:target.roomId,body:'Reply',replyTo:'$private-question'}))
    .resolves.toBe('$private')
  expect(send).toHaveBeenLastCalledWith(target.roomId,EventType.RoomMessage,{
    msgtype:'m.text',body:'Reply','m.relates_to':{'m.in_reply_to':{event_id:'$private-question'}},
    'm.mentions':{user_ids:[bob]}})
  expect(plain).not.toHaveBeenCalled()
})

it('projects who is typing in the open chat and a chat marked unread, from SDK state', async () => {
  const { client, latest } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const selected = client.getRoom('!first:test')!
  selected.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomMember,
      state_key: bob,
      room_id: selected.roomId,
      sender: bob,
      content: { membership: 'join', displayname: 'Bob' }
    })
  ])
  const typing = new MatrixEvent({ type: 'm.typing', room_id: selected.roomId, content: { user_ids: [bob, alice] } })
  selected.currentState.setTypingEvent(typing)
  client.emit(RoomMemberEvent.Typing, typing, selected.getMember(bob)!)
  await vi.waitFor(() => expect(latest().typing).toEqual([bob]))

  const other = client.getRoom('!other:test')!
  other.addAccountData([new MatrixEvent({ type: 'm.marked_unread', content: { unread: true } })])
  client.emit(RoomEvent.AccountData, new MatrixEvent({ type: 'm.marked_unread' }), other)
  await vi.waitFor(() => expect(latest().rooms.find(room => room.id === '!other:test')?.markedUnread).toBe(true))
  expect(latest().rooms.find(room => room.id === '!first:test')).not.toHaveProperty('markedUnread')
})

it("clears a chat's unread mark once it is on screen, without acknowledging anything else", async () => {
  const { client, sdk } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const selected = client.getRoom('!first:test')!
  selected.addAccountData([new MatrixEvent({ type: 'm.marked_unread', content: { unread: true } })])
  const write = vi.spyOn(client, 'setRoomAccountData').mockResolvedValue({})

  await sdk.command({ kind: 'attend', roomId: selected.roomId })
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledExactlyOnceWith(selected.roomId, 'm.marked_unread', { unread: false })
  )
  await sdk.command({ kind: 'attend', roomId: null })
  expect(write).toHaveBeenCalledOnce()
})

it("writes the owner's personal background through room account data", async () => {
  const { client, sdk } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const selected = client.getRoom('!first:test')!

  const look = {
    v: 1 as const,
    background: { kind: 'pack' as const, pack_id: '00000000-0000-4000-8000-177920da9661' }
  }

  const write = vi.spyOn(client, 'setRoomAccountData').mockResolvedValue({})

  await sdk.command({ kind: 'chatLook', roomId: selected.roomId, look })
  expect(write).toHaveBeenCalledExactlyOnceWith(selected.roomId, 'io.atum.chat.look', look)
})

it('writes canonical v2 through the actual SDK while preserving other assistant choices', async () => {
  const { client, sdk } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const selected = client.getRoom('!first:test')!
  const principal = '00000000-0000-4000-8000-bd7662a5eeb4'
  const override = { v: 2, source: 'connection', connectionId: 'personal-key', model: 'gpt-6-luna' }
  selected.addAccountData([new MatrixEvent({ type: 'io.atum.model', content: {
    v: 2, source: 'atum', model: 'nhat-thuc', agents: { [principal]: override }
  } })])
  const write = vi.spyOn(client, 'setRoomAccountData').mockResolvedValue({})
  await sdk.command({ kind: 'setModel', roomId: selected.roomId, effort: 'high' })
  expect(write).toHaveBeenCalledExactlyOnceWith(selected.roomId, 'io.atum.model', {
    v: 2, source: 'atum', model: 'nhat-thuc', effort: 'high', agents: { [principal]: override }
  })
})

it('migrates the released effort-only account data without losing the selected level', async () => {
  const { client, sdk } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const selected = client.getRoom('!first:test')!
  selected.addAccountData([new MatrixEvent({ type: 'io.atum.model', content: { effort: 'high' } })])
  const write = vi.spyOn(client, 'setRoomAccountData').mockResolvedValue({})
  await sdk.command({ kind: 'setModel', roomId: selected.roomId, model: 'nhat-thuc' })
  expect(write).toHaveBeenCalledExactlyOnceWith(selected.roomId, 'io.atum.model', {
    v: 2, source: 'atum', model: 'nhat-thuc', effort: 'high'
  })
})

it('refuses malformed/connection rewrites before any SDK account-data write', async () => {
  const { client, sdk } = await fixture()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  const selected = client.getRoom('!first:test')!
  const write = vi.spyOn(client, 'setRoomAccountData').mockResolvedValue({})

  for (const content of [{ v: 99, model: 'nguyet-thuc' }, { v: 2, source: 'connection', connectionId: 'personal-key', model: 'gpt-6-luna' }]) {
    selected.addAccountData([new MatrixEvent({ type: 'io.atum.model', content })])
    await expect(sdk.command({ kind: 'setModel', roomId: selected.roomId, effort: 'high' })).rejects.toThrow('matrix_model_choice_invalid')
  }

  expect(write).not.toHaveBeenCalled()
})

/** Actual SDK dispatch + server reader + serve/clone/queue, with only HTTP/crypto boot mocked. */
async function conversationSdkFixture() {
  const f = await fixture(undefined, alice, 'DEVICE', false)
  const ids = ['!earlier:test', '!main:test', '!stray:test']
  const states = new Map<string, Array<Record<string, unknown>>>()

  for (const id of ids) {
    const marker = id === ids[2] ? [] : [{
      type: CONVERSATION_STATE_TYPE, state_key: '', room_id: id, sender: alice,
      content: { v: 1, role: id === ids[1] ? 'main' : 'earlier', main: ids[1], at: 1 }
    }]

    const state = [
      { type: EventType.RoomCreate, content: { type: MATRIX_ASSISTANT_ROOM_TYPE } },
      { type: EventType.RoomEncryption, content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      { type: EventType.RoomHistoryVisibility, content: { history_visibility: 'joined' } },
      { type: EventType.RoomMember, state_key: alice, content: { membership: 'join' } },
      { type: EventType.RoomMember, state_key: bob, content: { membership: 'join' } }
    ].map(event => ({ state_key: '', room_id: id, sender: alice, ...event }))

    states.set(id, [...state, ...marker])
    const r = room(f.client, id)
    r.currentState.setStateEvents(states.get(id)!.map(event => new MatrixEvent(event)))
  }

  vi.spyOn(f.client.http, 'authedRequest').mockImplementation(async (_method, path) => {
    if (path === '/joined_rooms') { return { joined_rooms: ids } }
    const id = decodeURIComponent(path.split('/')[2]!)

    if (states.has(id) && path.endsWith('/state')) { return states.get(id) }
    throw new Error('unexpected conversation proof HTTP route')
  })

  f.client.emit(ClientEvent.Sync, SyncState.Prepared, null)

  const connected = connectMatrixSdk({
    configuration: async () => ({ baseUrl: 'https://matrix.test', userId: alice, deviceId: 'DEVICE', accessToken: 'fixture', storageKey: btoa('0'.repeat(32)) }),
    refresh: async () => ({ ok: false, reauthenticate: false }),
    snapshot: () => {}
  })

  await serveMatrixSdk(connected.port, async () => f.sdk).started
  stops.push(async () => connected.queue.close())

  return { ...f, ...connected, states, ids }
}

it('preserves actual Earlier and stray refusals through the SDK command, serve, clone and queue', async () => {
  const f = await conversationSdkFixture()
  const send = vi.spyOn(f.client, 'sendEvent')

  for (const roomId of [f.ids[0], f.ids[2]]) {
    const command = { kind: 'readAssistantRoom', roomId, ownerId: alice, agentId: bob, forTurn: true }
    const error = await f.queue.command(command).catch(error => error)
    expect(error).toBeInstanceOf(EarlierConversationError)
    expect(error).toMatchObject({ code: 'matrix_earlier_conversation', roomId, main: f.ids[1] })
    await expect(f.queue.command({ ...command, forTurn: false })).resolves.toBeUndefined()
  }

  await expect(f.queue.command({ kind: 'readAssistantRoom', roomId: f.ids[1], ownerId: alice, agentId: bob, forTurn: true })).resolves.toBeUndefined()
  expect(send).not.toHaveBeenCalled()
})

it('dispatches the actual marker reader and projects owner-checked marker changes', async () => {
  const f = await conversationSdkFixture()
  await expect(f.queue.command({ kind: 'readConversationMarker', roomId: f.ids[0], ownerId: alice, agentId: bob })).resolves.toEqual({ role: 'earlier', main: f.ids[1], at: 1 })
  const r = f.client.getRoom(f.ids[1])!
  const event = r.currentState.getStateEvents(CONVERSATION_STATE_TYPE, '')!
  f.client.emit(RoomStateEvent.Events, event, r.currentState, null)
  await vi.waitFor(() => expect(f.latest().rooms.find(room => room.id === f.ids[1])).toMatchObject({ conversation: { role: 'main', main: f.ids[1], at: 1 }, conversationOwnerId: alice }))
  const forged = new MatrixEvent({ ...event.event, sender: bob })
  r.currentState.setStateEvents([forged])
  f.client.emit(RoomStateEvent.Events, forged, r.currentState, event)
  await vi.waitFor(() => expect(f.latest().rooms.find(room => room.id === f.ids[1])?.conversation).toBeNull())
})

it('retains the unavailable closed code on the actual SDK path and sends no task file from Earlier', async () => {
  const f = await conversationSdkFixture()
  const send = vi.spyOn(f.client, 'sendEvent')
  await expect(f.queue.command({ kind: 'sendTaskFiles', roomId: f.ids[0], userId: bob, body: 'Use my notes', taskFiles: { version: 1, requestIds: ['00000000-0000-4000-8000-11e594f48195'] } })).rejects.toMatchObject({ code: 'matrix_earlier_conversation', main: f.ids[1] })
  expect(send).not.toHaveBeenCalled()
  vi.spyOn(f.client, 'getJoinedRooms').mockRejectedValue(new Error('private network response'))
  // Previous complete election is retained; a fresh SDK client has no such election.
  const fresh = await conversationSdkFixture()
  vi.spyOn(fresh.client, 'getJoinedRooms').mockRejectedValue(new Error('private network response'))
  await expect(fresh.queue.command({ kind: 'readAssistantRoom', roomId: fresh.ids[1], ownerId: alice, agentId: bob, forTurn: true })).rejects.toMatchObject({ message: 'matrix_conversation_unavailable' })
})


it('reuses an existing main for repeated assistant first-contact commands without creating another room', async () => {
  const { client, sdk, latest } = await fixture()
  vi.spyOn(client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: ['!first:test'] })
  vi.spyOn(client, 'roomState').mockResolvedValue([
    { type: EventType.RoomCreate, state_key: '', content: { type: MATRIX_ASSISTANT_ROOM_TYPE } },
    { type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'joined' } },
    ...[alice, bob].map(state_key => ({ type: EventType.RoomMember, state_key, content: { membership: 'join' } })),
    { type: CONVERSATION_STATE_TYPE, state_key: '', content: { v: 1, role: 'main', main: '!first:test', at: 1 } }
  ].map(event => ({ ...event, sender: alice, room_id: '!first:test', event_id: '$state', origin_server_ts: 1 })) as never)
  const create = vi.spyOn(client, 'createRoom')

  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(sdk.command({ kind: 'createAssistant', name: '', invite: [bob], direct: true })).resolves.toBe('!first:test')
  }

  expect(create).not.toHaveBeenCalled()
  expect(latest().roomId).toBe('!first:test')
})

it("forwards main's quiet agent verification through the SDK to the native security domain", async () => {
  const f = await fixture()
  const request = { pending: false, cancel: vi.fn().mockResolvedValue(undefined) }
  const crypto = f.client.getCrypto() as unknown as { requestDeviceVerification: ReturnType<typeof vi.fn> }
  crypto.requestDeviceVerification = vi.fn().mockResolvedValue(request)

  // Main sends this to the human host during agent trust; an unhandled kind would return
  // undefined and leave the handshake waiting for a request that was never made.
  await expect(
    f.sdk.command({ kind: 'agentVerificationStart', userId: '@agent:test', deviceId: 'AGENT' })
  ).resolves.toBeNull()
  expect(crypto.requestDeviceVerification).toHaveBeenCalledWith('@agent:test', 'AGENT')
})
