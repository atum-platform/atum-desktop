import { expect, it, vi } from 'vitest'
import type { MatrixSnapshot } from '../../../apps/desktop/shared/matrix'
import { serveMatrixSdk } from '../../../apps/desktop/src/matrix/sdk-host-serve'
import { readableMessages, startBrowserRuntime } from '../src/runtime'
import type { BoundDevice } from '../src/session'

it('runs browser room/recovery actions through the canonical serve/queue seam', async () => {
  const calls: unknown[] = []
  const command = vi.fn(async value => { calls.push(value); return value.kind === 'recoveryCreateKey' ? { id: 'fixture-stage', key: 'fixture-user-key' } : value.kind==='ownerRecovery' ? 'fixture-user-key' : null })
  const stop = vi.fn(async () => {})
  const device = { configuration: () => ({ userId: '@fixture:localhost', deviceId: 'DEVICE_123456', storageKey: btoa('x'.repeat(32)),
    baseUrl: 'https://matrix.localhost', accessToken: 'fixture-access', refreshToken: 'fixture-refresh' }),
    refresh: vi.fn(async () => ({ ok: true, accessToken: 'fixture-rotated', refreshToken: 'fixture-next' })), cryptoStarted: vi.fn(async () => {}) } as unknown as BoundDevice
  const runtime = startBrowserRuntime(device, () => {}, port => serveMatrixSdk(port, async (configuration, refresh) => {
    expect(configuration.deviceId).toBe('DEVICE_123456')
    expect(await refresh(configuration.refreshToken!)).toMatchObject({ ok: true })
    return { command, stop, renewed: async () => true }
  }))
  await runtime.ready
  await runtime.selectRoom('!encrypted:localhost')
  const key = await runtime.createRecoveryKey()
  await runtime.setUpRecovery(key.id)
  await runtime.restoreRecovery('fixture-user-key')
  await runtime.discardRecovery()
  expect(calls).toEqual([{ kind: 'select', roomId: '!encrypted:localhost' }, { kind: 'recoveryCreateKey' },
    { kind: 'ownerRecovery', command:{ kind: 'recoverySetUp', id: 'fixture-stage' } },
    { kind: 'ownerRecovery', command:{ kind: 'recoveryRestore', key: 'fixture-user-key' } }, { kind: 'recoveryDiscard' }])
  expect(runtime).not.toHaveProperty('command')
  expect(runtime).not.toHaveProperty('verify')
  await runtime.stop()
  expect(stop).toHaveBeenCalledTimes(1)
  await expect(runtime.selectRoom('!encrypted:localhost')).rejects.toThrow('signed_out')
})

it('displays only decrypted encrypted messages from a joined encrypted room', () => {
  const message = { id: '$m', sender: '@fixture:localhost', body: 'fixture plaintext', timestamp: 1, own: false,
    encrypted: true, decryptionFailed: false, pending: false, failed: false, attachment: false }
  const snapshot: MatrixSnapshot = { identity: null, state: 'ready', error: null, roomId: '!room:localhost',
    rooms: [{ id: '!room:localhost', name: 'Room', encrypted: true, membership: 'join' }],
    messages: [message, { ...message, id: '$clear', encrypted: false }, { ...message, id: '$failed', decryptionFailed: true }] }
  expect(readableMessages(snapshot)).toEqual([message])
  expect(readableMessages({ ...snapshot, rooms: [{ ...snapshot.rooms[0], encrypted: false }] })).toEqual([])
  expect(readableMessages({ ...snapshot, rooms: [{ ...snapshot.rooms[0], membership: 'invite' }] })).toEqual([])
})
