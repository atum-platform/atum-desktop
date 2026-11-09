import { EventEmitter } from 'node:events'

import { ClientEvent } from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentIdentityCarrier } from './agent-identity-carrier'

const enrollmentId = '00000000-0000-4000-8000-3833bb080cbb'
const executorId = '00000000-0000-4000-8000-1e06b6722ae5'
const agent = '@synthetic-user-0010:atumplatform.com'
const owner = '@owner:atumplatform.com'
const agentDevice = 'ATUM_AGENT_8d6c4b2a-0f1e-4d3c-9b5a-7e6f8d9c0b36'
const ownerDevice = 'OWNER_DEVICE'
const nonce = 'ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1-f4CBgoM'

function event() {
  return {
    type: 'io.atum.agent_identity.request' as const,
    content: { v: 1 as const, enrollmentId, executorId, agentUserId: agent, deviceId: agentDevice, purpose: 'restore' as const, nonce, expiresAt: 1790673000000 }
  }
}

function fixture() {
  const client = new EventEmitter()
  const batch = { eventType: event().type, batch: [{ userId: owner, deviceId: ownerDevice, payload: event().content }] }
  const crypto = {
    encryptToDeviceMessages: vi.fn(async () => batch),
    createRecoveryKeyFromPassphrase: vi.fn(async () => ({ privateKey: new Uint8Array(32).fill(7), encodedPrivateKey: 'EsTf AkeK eyFo rThe Cont ract Pack NotA RealK eyAt All0 0000' }))
  }
  const queueToDevice = vi.fn(async () => {})
  Object.assign(client, { getCrypto: () => crypto, queueToDevice })
  const carrier = agentIdentityCarrier(client as any)

  return { batch, carrier, client, crypto, queueToDevice }
}

afterEach(() => vi.clearAllMocks())

describe('agent identity Olm carrier', () => {
  it('starts empty, encrypts only the fixed event types, and queues the SDK batch', async () => {
    const f = fixture()
    await expect(f.carrier.command({ kind: 'agentIdentityToDeviceRead', sender: { userId: agent, deviceId: agentDevice } })).resolves.toEqual([])
    await expect(f.carrier.command({ kind: 'agentIdentityToDeviceSend', recipient: { userId: owner, deviceId: ownerDevice }, event: event() })).resolves.toBeNull()
    expect(f.crypto.encryptToDeviceMessages).toHaveBeenCalledExactlyOnceWith(event().type, [{ userId: owner, deviceId: ownerDevice }], event().content)
    expect(f.queueToDevice).toHaveBeenCalledExactlyOnceWith(f.batch)
    await expect(f.carrier.command({ kind: 'agentIdentityToDeviceSend', recipient: { userId: owner, deviceId: ownerDevice }, event: { ...event(), type: 'm.room.message' } as any })).rejects.toThrow('invalid')
    expect(f.crypto.encryptToDeviceMessages).toHaveBeenCalledOnce()
  })

  it('accepts only SDK-decrypted Olm data and returns authenticated sender metadata to the exact expected peer', async () => {
    const f = fixture()
    const receive = (overrides: Record<string, unknown> = {}) =>
      f.client.emit(ClientEvent.ReceivedToDeviceMessage, {
        message: { type: event().type, content: event().content, sender: agent },
        encryptionInfo: { sender: agent, senderDevice: agentDevice, senderCurve25519KeyBase64: 'curve', senderVerified: false },
        ...overrides
      })

    receive({ encryptionInfo: null })
    receive({ message: { type: 'm.room.message', content: event().content, sender: agent } })
    receive({ message: { type: event().type, content: { ...event().content, extra: 'spoofed' }, sender: agent } })
    receive({ message: { type: event().type, content: event().content, sender: owner } })
    receive()
    await expect(f.carrier.command({ kind: 'agentIdentityToDeviceRead', sender: { userId: owner, deviceId: ownerDevice } })).resolves.toEqual([])
    await expect(f.carrier.command({ kind: 'agentIdentityToDeviceRead', sender: { userId: agent, deviceId: agentDevice } })).resolves.toEqual([
      { type: event().type, content: event().content, senderUserId: agent, senderDeviceId: agentDevice }
    ])
  })

  it('returns only an encoded generated recovery key and zeroes the SDK raw key', async () => {
    const f = fixture()
    const key = await f.carrier.generateRecoveryKey()
    expect(key).toContain(' ')
    const generated = await f.crypto.createRecoveryKeyFromPassphrase.mock.results[0]!.value
    expect(generated.privateKey.every((byte: number) => byte === 0)).toBe(true)
  })

  it('refuses new messages at capacity without evicting a pending handoff', async () => {
    const f = fixture()
    for (let index = 0; index < 33; index++) {
      f.client.emit(ClientEvent.ReceivedToDeviceMessage, {
        message: { type: event().type, content: { ...event().content, expiresAt: 1790673000000 + index }, sender: agent },
        encryptionInfo: { sender: agent, senderDevice: agentDevice, senderVerified: false }
      })
    }
    const received = await f.carrier.command({ kind: 'agentIdentityToDeviceRead', sender: { userId: agent, deviceId: agentDevice }, limit: 32 })
    expect(received).toHaveLength(32)
    expect(received?.[0]?.content).toMatchObject({ expiresAt: 1790673000000 })
    expect(received?.[31]?.content).toMatchObject({ expiresAt: 1790673000031 })
  })

  it('drops pending material and detaches the listener on stop', async () => {
    const f = fixture()
    f.client.emit(ClientEvent.ReceivedToDeviceMessage, {
      message: { type: event().type, content: event().content, sender: agent },
      encryptionInfo: { sender: agent, senderDevice: agentDevice, senderCurve25519KeyBase64: 'curve', senderVerified: false }
    })
    f.carrier.stop()
    await expect(f.carrier.command({ kind: 'agentIdentityToDeviceRead', sender: { userId: agent, deviceId: agentDevice } })).rejects.toThrow('stopped')
    expect(f.client.listenerCount(ClientEvent.ReceivedToDeviceMessage)).toBe(0)
  })
})
