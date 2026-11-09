import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { ChatStorage } from '../src/chat-storage'
import { ChatOutbox, UncertainChatSend } from '../src/chat-outbox'
import { chatRoster, admittedChatRoom } from '../src/chat-roster'
import { BoundDevice } from '../src/session'
import { matrixScope, type DeviceSession } from '../src/record'
import type { BrowserOAuth } from '../src/oauth'

const identity = { userId: '@owner:test', deviceId: 'DEVICE_123456' }
const record: DeviceSession = {
  ...identity,
  issuer: 'https://mas.test/',
  baseUrl: 'https://matrix.test',
  clientId: 'web-human',
  redirectUri: 'http://localhost:4318/callback',
  kind: 'session',
  phase: 'establishing',
  version: 1,
  revision: 1,
  subject: 'owner',
  storageKey: btoa('x'.repeat(32)),
  accessToken: 'fixture-access',
  refreshToken: 'fixture-refresh',
  scope: matrixScope(identity.deviceId),
  expiresAt: Date.now() + 60000
}
const provider = (): BrowserOAuth => ({
  prepare: vi.fn(),
  authorize: vi.fn(),
  exchange: vi.fn(),
  revoke: vi.fn(async () => {}),
  whoami: vi.fn(async () => identity),
  refresh: vi.fn(async old => ({
    accessToken: 'fixture-rotated',
    refreshToken: 'fixture-rotated-refresh',
    scope: old.scope,
    expiresAt: Date.now() + 60000
  }))
})

describe('consumer authentication, separate from the recovery proof', () => {
  it('resumes an interrupted SDK startup and reloads the same device without a recovery setup gate', async () => {
    const store = await ChatStorage.open(new IDBFactory())
    await store.device.replace(null, record)
    const cryptoGate = vi.fn(async () => {
      throw new Error('missing_crypto')
    })
    const device = new BoundDevice(record, store.device, provider(), cryptoGate, undefined, 'chat')
    expect(await device.load()).toBe('active')
    expect(((await store.device.read()) as DeviceSession).phase).toBe('establishing')
    await device.sdkStarted()
    expect(((await store.device.read()) as DeviceSession).phase).toBe('active')
    const reloaded = new BoundDevice(record, store.device, provider(), cryptoGate, undefined, 'chat')
    expect(await reloaded.load()).toBe('active')
    expect(reloaded.configuration()).toMatchObject(identity)
    expect(reloaded.sendEpoch()).not.toBe(device.sendEpoch())
    expect(cryptoGate).not.toHaveBeenCalled()
    await expect(new BoundDevice(record, store.device, provider(), cryptoGate).load()).rejects.toThrow('missing_crypto')
    store.close()
  })
  it('keeps the old proof default strict, and CAS prevents two auth writers', async () => {
    const store = await ChatStorage.open(new IDBFactory())
    await store.device.replace(null, record)
    await expect(new BoundDevice(record, store.device, provider()).load()).rejects.toThrow('recovery_needed')
    await expect(store.device.replace(null, record)).rejects.toThrow('operation_failed')
    expect(await store.device.read()).toEqual(record)
    store.close()
  })
})

describe('durable ordinary human sends', () => {
  it('sign-out clears authentication and unrecoverable device-scoped uncertain text', async () => {
    const store = await ChatStorage.open(new IDBFactory())
    await store.device.replace(null, record)
    const send = vi.fn(async () => {
      throw new Error('uncertain_network_outcome')
    })
    const outbox = new ChatOutbox(store, identity, send, () => 'epoch-1')
    await expect(outbox.submit('!agent:test', 'Check history before sending again')).rejects.toThrow('send_uncertain')
    const [pending] = await outbox.list()
    outbox.close()
    await store.clearAuthentication()
    expect(await store.device.read()).toBeUndefined()
    expect(await store.domain.read()).toBeUndefined()
    expect(await store.sends(identity.userId, identity.deviceId)).toEqual([])
    await expect(outbox.retry(pending!)).rejects.toThrow('send_unavailable')
    const nextDevice = new ChatOutbox(store, { ...identity, deviceId: 'NEW_DEVICE' }, send, () => 'epoch-2')
    expect(await nextDevice.list()).toEqual([])
    await expect(nextDevice.retry(pending!)).rejects.toThrow('send_unavailable')
    expect(send).toHaveBeenCalledOnce()
    store.close()
  })

  it('persists before IO; uncertain outcome survives reload and cannot be replayed under a new credential epoch', async () => {
    const factory = new IDBFactory()
    const store = await ChatStorage.open(factory)
    const send = vi.fn(async () => {
      expect(await store.sends(identity.userId, identity.deviceId)).toHaveLength(1)
      throw new Error('network_lost_after_commit')
    })
    const outbox = new ChatOutbox(store, identity, send, () => 'epoch-1')
    await expect(outbox.submit('!agent:test', 'Hello')).rejects.toBeInstanceOf(UncertainChatSend)
    const [pending] = await outbox.list()
    store.close()
    const reloadedStore = await ChatStorage.open(factory)
    const reloaded = new ChatOutbox(reloadedStore, identity, send, () => 'epoch-2')
    expect(await reloaded.list()).toEqual([pending])
    await expect(reloaded.retry(pending!)).rejects.toThrow('send_unavailable')
    expect(send).toHaveBeenCalledTimes(1)
    expect(
      await new ChatOutbox(reloadedStore, { ...identity, deviceId: 'OTHER_DEVICE' }, send, () => 'epoch-1').list()
    ).toEqual([])
    reloadedStore.close()
  })
  it('an explicit retry keeps the same transaction, clears on confirmation, and closes after rotation', async () => {
    const store = await ChatStorage.open(new IDBFactory())
    let epoch = 'epoch-1'
    const send = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue('$sent')
    const outbox = new ChatOutbox(store, identity, send, () => epoch)
    await expect(outbox.submit('!agent:test', 'Hello')).rejects.toThrow('send_uncertain')
    const [pending] = await outbox.list()
    await outbox.retry(pending!)
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
    expect(await outbox.list()).toEqual([])
    epoch = 'epoch-2'
    await expect(outbox.retry(pending!)).rejects.toThrow('send_unavailable')
    store.close()
  })
  it('reconciles an uncertain result only from its settled own event', async () => {
    const store = await ChatStorage.open(new IDBFactory())
    const send = vi.fn(async () => {
      throw new Error('response_lost')
    })
    const outbox = new ChatOutbox(store, identity, send, () => 'epoch-1')
    await expect(outbox.submit('!agent:test', 'Hello')).rejects.toThrow('send_uncertain')
    const [pending] = await outbox.list()
    const message = {
      id: '$sent',
      sender: identity.userId,
      body: 'Hello',
      timestamp: 1,
      own: true,
      encrypted: false,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false,
      sent: true as const,
      matrixTransactionId: pending!.id
    }
    await outbox.reconcile('!other:test', [message])
    await outbox.reconcile('!agent:test', [{ ...message, own: false }])
    expect(await outbox.list()).toHaveLength(1)
    await outbox.reconcile('!agent:test', [message])
    expect(await outbox.list()).toEqual([])
    store.close()
  })
  it('failed persistence sends nothing; closing during persistence prevents a late network send', async () => {
    const send = vi.fn(async () => '$sent')
    const bad = {
      putSend: async () => {
        throw new Error('disk_full')
      },
      dropSend: vi.fn(),
      sends: vi.fn()
    }
    await expect(
      new ChatOutbox(bad, identity, send, () => 'epoch').submit('!agent:test', 'Keep my draft')
    ).rejects.toThrow('disk_full')
    expect(send).not.toHaveBeenCalled()
    let release!: () => void
    const store = {
      ...bad,
      putSend: () =>
        new Promise<void>(resolve => {
          release = resolve
        })
    }
    const outbox = new ChatOutbox(store, identity, send, () => 'epoch')
    const submitting = outbox.submit('!agent:test', 'Keep my draft')
    outbox.close()
    release()
    await expect(submitting).rejects.toThrow('send_uncertain')
    expect(send).not.toHaveBeenCalled()
  })
})

// Shape from the current platform `/agents` row after migration 0244: canonical
// camel-case `roomId` on every active top-level row, with the existing assistant
// presentation fields passed through.
const projectionRow = (roomId: unknown = '!moonCanonicalRoom:atum.example') => ({
  id: '00000000-0000-4000-8000-29b27310f6e1',
  principal: '00000000-0000-4000-8000-b42afff6e30e',
  agentPrincipal: '00000000-0000-4000-8000-b42afff6e30e',
  matrixUser: '@atum-agent:atum.example',
  display_name: 'Atum',
  avatar_url: null,
  is_default: true,
  status: 'active',
  answering: 'cloud',
  answeringChangedAt: 1790000000000,
  roomId
})
const plainAgentRoom = {
  id: '!moonCanonicalRoom:atum.example',
  name: 'Atum',
  membership: 'join',
  encrypted: false,
  plainAgent: true
} as const

it('consumes the current 0244 payload and admits only the exact joined plain cloud room', () => {
  const [agent] = chatRoster([projectionRow()])
  const decoy = { ...plainAgentRoom, id: '!mostRecentDm:atum.example' }
  expect(agent).toMatchObject({
    principal: '00000000-0000-4000-8000-b42afff6e30e',
    roomId: '!moonCanonicalRoom:atum.example',
    answering: 'cloud'
  })
  expect(admittedChatRoom(agent!, [decoy, plainAgentRoom])).toBe(plainAgentRoom)
  expect(admittedChatRoom(agent!, [decoy])).toBeUndefined()
})

it('rejects a roster with a missing or malformed canonical roomId and never reads snake_case', () => {
  const { roomId: _required, ...missing } = projectionRow()
  expect(() => chatRoster([missing])).toThrow('invalid_roster')
  expect(() => chatRoster([{ ...missing, room_id: plainAgentRoom.id }])).toThrow('invalid_roster')
  expect(() => chatRoster([{ ...projectionRow(), roomId: undefined }])).toThrow('invalid_roster')
  for (const roomId of [
    1,
    true,
    {},
    [],
    '',
    'not-a-room',
    '!room',
    '!a:',
    '!ro om:server',
    '!room:server\n',
    '!é:ö',
    `!${'a'.repeat(1022)}:b`
  ])
    expect(() => chatRoster([projectionRow(roomId)])).toThrow('invalid_roster')
  expect(() => chatRoster([projectionRow(null)])).not.toThrow()
})

it('keeps an explicit null mapping unavailable even when a plain agent room is in sync', () => {
  const [agent] = chatRoster([projectionRow(null)])
  expect(agent!.roomId).toBeNull()
  expect(admittedChatRoom(agent!, [plainAgentRoom])).toBeUndefined()
  const [legacyOnly] = chatRoster([{ ...projectionRow(null), room_id: plainAgentRoom.id }])
  expect(legacyOnly!.roomId).toBeNull()
  expect(admittedChatRoom(legacyOnly!, [plainAgentRoom])).toBeUndefined()
})

it('refuses local, foreign, encrypted, left, untyped and duplicate room authority', () => {
  const [agent] = chatRoster([projectionRow()])
  for (const denied of [
    { ...plainAgentRoom, id: '!foreign:atum.example' },
    { ...plainAgentRoom, encrypted: true },
    { ...plainAgentRoom, membership: 'leave' },
    { ...plainAgentRoom, plainAgent: false }
  ])
    expect(admittedChatRoom(agent!, [denied])).toBeUndefined()
  expect(admittedChatRoom({ ...agent!, answering: 'local' }, [plainAgentRoom])).toBeUndefined()
  expect(admittedChatRoom({ ...agent!, answering: null }, [plainAgentRoom])).toBeUndefined()
  expect(() => chatRoster([projectionRow(), projectionRow()])).toThrow('invalid_roster')
})

it('drops the old binding when the canonical mapping changes and recovers the new room', () => {
  const rooms = [
    { ...plainAgentRoom, id: '!old:atum.example' },
    { ...plainAgentRoom, id: '!new:atum.example' }
  ]
  const [before] = chatRoster([projectionRow('!old:atum.example')])
  const [after] = chatRoster([projectionRow('!new:atum.example')])
  expect(admittedChatRoom(before!, rooms)?.id).toBe('!old:atum.example')
  expect(admittedChatRoom(after!, rooms)?.id).toBe('!new:atum.example')
  expect(admittedChatRoom(after!, [rooms[0]!])).toBeUndefined()
})

it('projects the current canonical agent identity with its required room field', () => {
  const assistantId = '00000000-0000-4000-8000-29b27310f6e1'
  const principal = '00000000-0000-4000-8000-b42afff6e30e'
  const avatarUrl =
    `https://public-config.example.invalid/storage/v1/object/public/atum-avatars-v1/assistants/principals/${principal}/${assistantId}/00000000-0000-4000-8000-abf62dc17316.webp`
  const [agent] = chatRoster([
    {
      id: assistantId,
      agentPrincipal: principal,
      matrixUser: '@agent:test',
      display_name: 'Atum',
      avatar_url: avatarUrl,
      is_default: true,
      status: 'active',
      answering: 'cloud',
      roomId: null
    }
  ])
  expect(agent).toEqual({
    assistantId,
    principal,
    userId: '@agent:test',
    name: 'Atum',
    avatarUrl,
    isMain: true,
    roomId: null,
    answering: 'cloud'
  })
  expect(
    chatRoster([
      {
        id: assistantId,
        agentPrincipal: principal,
        matrixUser: '@agent:test',
        avatar_url: `https://tracker.invalid/${assistantId}.webp`,
        roomId: null
      }
    ])[0]?.avatarUrl
  ).toBeNull()
  expect(
    chatRoster([
      {
        id: assistantId,
        agentPrincipal: principal,
        matrixUser: '@agent:test',
        avatar_url: `http://127.0.0.1:54321/storage/v1/object/public/atum-avatars-v1/assistants/principals/${principal}/${assistantId}/00000000-0000-4000-8000-abf62dc17316.webp`,
        roomId: null
      }
    ])[0]?.avatarUrl
  ).toBeNull()
})
