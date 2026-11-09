import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { EncryptedStore } from '../encrypted-store'

import { MatrixDeviceIsolationPolicy } from './device-isolation'
import { parseMatrixCommand } from './ipc-policy'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'atum-isolation-'))
  directories.push(directory)
  const file = join(directory, 'device', 'preference.json')
  const store = new EncryptedStore(file, {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString()
  })
  return { file, store, policy: new MatrixDeviceIsolationPolicy(store) }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

it('replaces all engines only after durable policy, with no host admitted during stop', async () => {
  const { policy, store, file } = fixture()
  const roles = ['human', 'agent', 'agent:second', 'app:third']
  const old = roles.map(role => ({ role, policy: policy.forHost() }))
  let hosts = [...old]
  const gate = deferred()
  const change = policy.change('signed', {
    current: () => true,
    stop: async () => {
      hosts = []
      await gate.promise
    },
    start: async () => {
      expect(store.getItem('device-isolation')).toBe('signed')
      hosts = roles.map(role => ({ role, policy: policy.forHost() }))
    },
    changed: () => {}
  })
  expect(() => policy.forHost()).toThrow('pending')
  expect(hosts).toEqual([])
  await expect(
    policy.change('all', { current: () => true, stop: vi.fn(), start: vi.fn(), changed: vi.fn() })
  ).rejects.toThrow('pending')
  gate.resolve()
  await change
  expect(hosts).toHaveLength(4)
  expect(hosts.every(host => host.policy === 'signed' && !old.includes(host))).toBe(true)
  expect(new MatrixDeviceIsolationPolicy(store).forHost()).toBe('signed')
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(2)
})

it.each(['write', 'start', 'stop'] as const)(
  'a %s failure retires partial hosts and never starts legacy as strict',
  async failure => {
    const { policy, store } = fixture()
    if (failure === 'write') {
      vi.spyOn(store, 'setItem').mockImplementation(() => {
        throw new Error('write_failed')
      })
    }
    let hosts = ['all']
    const stop = vi.fn(async () => {
      hosts = []
      if (failure === 'stop') {
        throw new Error('stop_failed')
      }
    })
    const start = vi.fn(async () => {
      hosts = [policy.forHost()]
      if (failure === 'start') {
        throw new Error('start_failed')
      }
    })
    await expect(policy.change('signed', { current: () => true, stop, start, changed: vi.fn() })).rejects.toThrow(
      `${failure}_failed`
    )
    expect(hosts).toEqual([])
    expect(() => policy.forHost()).toThrow('pending')
    expect(policy.value()).toBe(failure === 'start' ? 'signed' : 'all')
    if (failure !== 'start') {
      expect(start).not.toHaveBeenCalled()
    }
  }
)

it('a withdrawn account after stop cannot persist or recreate hosts', async () => {
  const { policy, store } = fixture()
  let current = true
  const start = vi.fn()
  await expect(
    policy.change('signed', {
      current: () => current,
      stop: async () => {
        current = false
      },
      start,
      changed: vi.fn()
    })
  ).rejects.toThrow('stale')
  expect(store.getItem('device-isolation')).toBeNull()
  expect(start).not.toHaveBeenCalled()
  expect(policy.forHost()).toBe('all')
})

it('unreadable or invalid persisted preferences cannot turn strict mode off', () => {
  const { store } = fixture()
  store.setItem('device-isolation', 'SIGNED')
  expect(() => new MatrixDeviceIsolationPolicy(store).forHost()).toThrow('invalid')
  const readFailure = { getItem: () => null, setItem: vi.fn(), failureCode: () => 'auth_storage_unavailable' }
  expect(() => new MatrixDeviceIsolationPolicy(readFailure).forHost()).toThrow('unavailable')
})

it('closes UI values and strips renderer confirmation/trust while keeping native SDK actions private', () => {
  const identity = { userId: '@owner:test', deviceId: 'ONE' }
  expect(parseMatrixCommand({ kind: 'deviceIsolation', identity, value: 'signed', confirmed: true })).toEqual({
    kind: 'deviceIsolation',
    identity,
    value: 'signed'
  })
  for (const value of [null, {}, true, 'SIGNED']) {
    expect(() => parseMatrixCommand({ kind: 'deviceIsolation', identity, value })).toThrow('invalid')
  }
  const input = { kind: 'peerIdentity', identity, roomId: '!room:test', userId: '@peer:test', action: 'review' }
  expect(parseMatrixCommand({ ...input, confirmed: true, verified: true })).toEqual(input)
  for (const kind of ['peerIdentityRead', 'peerIdentityStart', 'peerIdentityContinue']) {
    expect(() => parseMatrixCommand({ ...input, kind })).toThrow('invalid')
  }
})

it('a withdrawn account after persistence retains strict policy without poisoning the next sign-in', async () => {
  const { policy, store } = fixture()
  let current = true
  const stop = vi.fn(async () => {})
  await expect(
    policy.change('signed', {
      current: () => current,
      stop,
      start: async () => {
        expect(policy.forHost()).toBe('signed')
        current = false
      },
      changed: vi.fn()
    })
  ).rejects.toThrow('stale')
  expect(stop).toHaveBeenCalledTimes(2)
  expect(store.getItem('device-isolation')).toBe('signed')
  expect(policy.forHost()).toBe('signed')
})
