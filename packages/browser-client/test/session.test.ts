import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'

import { type BrowserOAuth } from '../src/oauth'
import { CALLBACK, matrixScope, parseConfig, parseRecord, requireScope, type BrowserConfig, type DeviceRecord, type DeviceSession, type PendingLogin } from '../src/record'
import { BoundDevice } from '../src/session'
import { acquireWriter, IndexedDeviceStore, requireCryptoStores } from '../src/storage'

const config: BrowserConfig = { issuer: 'https://mas.localhost/', baseUrl: 'https://matrix.localhost', clientId: 'public-client', redirectUri: CALLBACK }
function session(): DeviceSession {
  return { ...config, version: 1, revision: 1, kind: 'session', phase: 'active', deviceId: 'DEVICE_123456',
    userId: '@disposable:localhost', subject: 'disposable-subject', storageKey: btoa('x'.repeat(32)),
    scope: matrixScope('DEVICE_123456'), accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 4102444800000 }
}
function oauth(): BrowserOAuth {
  return {
    prepare: vi.fn(async () => ({ config: {} as never, verifier: 'a'.repeat(43), state: 'fixture-state', nonce: 'fixture-nonce' })),
    authorize: vi.fn(async () => new URL('https://mas.localhost/authorize')),
    exchange: vi.fn(async pending => ({ accessToken: 'fixture-exchanged', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 60000,
      subject: 'disposable-subject', scope: matrixScope(pending.deviceId) })),
    refresh: vi.fn(async old => ({ accessToken: 'fixture-rotated', refreshToken: 'fixture-next-refresh', expiresAt: Date.now() + 60000, scope: old.scope })),
    whoami: vi.fn(async () => ({ userId: session().userId, deviceId: session().deviceId })),
    revoke: vi.fn(async () => {})
  }
}
async function harness(initial?: DeviceRecord) {
  const store = await IndexedDeviceStore.open(new IDBFactory())
  if (initial) await store.replace(null, initial)
  const provider = oauth()
  const cryptoExists = vi.fn(async () => {})
  const failed = vi.fn()
  const device = new BoundDevice(config, store, provider, cryptoExists, failed)
  return { store, provider, cryptoExists, failed, device }
}

describe('bound IndexedDB device and session contract (fixtures, no live acceptance)', () => {
  it('creates PKCE persistence before navigation and binds the callback to whoami', async () => {
    const { device, store, provider } = await harness()
    expect(await device.load()).toBe('empty')
    await device.beginLogin()
    const pending = parseRecord(await store.read(), config) as PendingLogin
    expect(pending.phase).toBe('pending')
    provider.whoami = vi.fn(async () => ({ userId: session().userId, deviceId: pending.deviceId }))
    provider.exchange = vi.fn(async value => {
      expect((await store.read() as PendingLogin).phase).toBe('exchanging')
      return { accessToken: 'fixture-new', refreshToken: 'fixture-refresh', scope: matrixScope(value.deviceId),
        subject: 'disposable-subject', expiresAt: Date.now() + 60000 }
    })
    await device.callback(new URL(`${CALLBACK}?code=fixture-code&state=${pending.state}`))
    const established = parseRecord(await store.read(), config) as DeviceSession
    expect(established.phase).toBe('establishing')
    expect(device.configuration()).toMatchObject({ deviceId: pending.deviceId, storageKey: pending.storageKey })
    expect(established).not.toHaveProperty('verifier')
    await device.cryptoStarted()
    expect((await store.read() as DeviceSession).phase).toBe('active')
    store.close()
  })

  it('reload rotates credentials before resuming exactly the same device and crypto key', async () => {
    const initial = session()
    const { device, store, cryptoExists } = await harness(initial)
    expect(await device.load()).toBe('active')
    expect(cryptoExists).toHaveBeenCalledWith(initial.deviceId)
    const record = parseRecord(await store.read(), config) as DeviceSession
    expect(record).toMatchObject({ userId: initial.userId, deviceId: initial.deviceId, storageKey: initial.storageKey,
      issuer: initial.issuer, subject: initial.subject, accessToken: 'fixture-rotated', refreshToken: 'fixture-next-refresh' })
    const reloaded = new BoundDevice(config, store, oauth(), cryptoExists)
    await reloaded.load()
    expect(reloaded.configuration()).toMatchObject({ userId: initial.userId, deviceId: initial.deviceId, storageKey: initial.storageKey })
    store.close()
  })

  it('only acknowledges rotation after persistence and coalesces concurrent refresh', async () => {
    const { device, provider, store } = await harness(session())
    await device.load()
    let complete!: (value: Awaited<ReturnType<BrowserOAuth['refresh']>>) => void
    provider.refresh = vi.fn(() => new Promise<Awaited<ReturnType<BrowserOAuth['refresh']>>>(resolve => { complete = resolve }))
    const first = device.refresh('fixture-next-refresh')
    const second = device.refresh('fixture-next-refresh')
    expect(first).toBe(second)
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    expect((await store.read() as DeviceSession).phase).toBe('refreshing')
    complete({ accessToken: 'fixture-rotated-again', refreshToken: 'fixture-rotated-refresh-again', scope: session().scope, expiresAt: Date.now() + 60000 })
    expect(await first).toMatchObject({ ok: true, refreshToken: 'fixture-rotated-refresh-again' })
    expect((await store.read() as DeviceSession).refreshToken).toBe('fixture-rotated-refresh-again')
    store.close()
  })

  it('does not resurrect the device if a handle mismatch races an in-flight rotation', async () => {
    const { device, provider, store } = await harness(session())
    await device.load()
    let complete!: (value: Awaited<ReturnType<BrowserOAuth['refresh']>>) => void
    provider.refresh = vi.fn(() => new Promise<Awaited<ReturnType<BrowserOAuth['refresh']>>>(resolve => { complete = resolve }))
    const rotation = device.refresh('fixture-next-refresh')
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    expect(await device.refresh('fixture-wrong-handle')).toMatchObject({ ok: false, reauthenticate: true })
    complete({ accessToken: 'fixture-late', refreshToken: 'fixture-late-refresh', scope: session().scope, expiresAt: Date.now() + 60000 })
    expect(await rotation).toMatchObject({ ok: false, reauthenticate: true })
    expect((await store.read() as DeviceSession).phase).toBe('blocked')
    await expect(new BoundDevice(config, store, provider).load()).rejects.toThrow('recovery_needed')
    store.close()
  })

  it.each(['userId', 'deviceId', 'subject', 'scope'] as const)('fails closed on rotated %s mismatch', async field => {
    const { device, provider, store, failed } = await harness(session())
    if (field === 'userId' || field === 'deviceId') provider.whoami = vi.fn(async () => ({ ...session(), [field]: 'other' }))
    else provider.refresh = vi.fn(async old => ({ accessToken: 'fixture-wrong', refreshToken: 'fixture-wrong-refresh', expiresAt: Date.now() + 60000,
      scope: old.scope, [field]: 'other' }))
    await expect(device.load()).rejects.toThrow('recovery_needed')
    expect((await store.read() as DeviceSession).phase).toBe('blocked')
    expect(failed).toHaveBeenCalled()
    expect(() => device.configuration()).toThrow('signed_out')
    store.close()
  })

  it('does not return a rotated token when the durable commit fails', async () => {
    const { device, store } = await harness(session())
    const replace = store.replace.bind(store)
    vi.spyOn(store, 'replace').mockImplementation(async (expected, next) => {
      if (next.phase === 'active') throw new Error('fixture-quota-exhaustion')
      return replace(expected, next)
    })
    await expect(device.load()).rejects.toThrow('recovery_needed')
    expect((await store.read() as DeviceSession).accessToken).toBe('fixture-access')
    expect((await store.read() as DeviceSession).phase).toBe('blocked')
    store.close()
  })

  it.each(['refreshing', 'establishing', 'blocked', 'signed_out'] as const)('never silently creates a replacement after %s', async phase => {
    const { device, provider, store } = await harness({ ...session(), phase })
    await expect(device.load()).rejects.toThrow(phase === 'signed_out' ? 'signed_out' : 'recovery_needed')
    await expect(device.beginLogin()).rejects.toThrow('recovery_needed')
    expect(provider.prepare).not.toHaveBeenCalled()
    expect(provider.refresh).not.toHaveBeenCalled()
    store.close()
  })

  it('preserves malformed persistence and fails before OAuth or crypto', async () => {
    const { store, provider, cryptoExists } = await harness()
    const malformed = { ...session(), storageKey: 'broken', refreshToken: '' }
    await store.replace(null, malformed)
    const device = new BoundDevice(config, store, provider, cryptoExists)
    await expect(device.load()).rejects.toThrow('recovery_needed')
    await expect(device.beginLogin()).rejects.toThrow('recovery_needed')
    expect(await store.read()).toEqual(malformed)
    expect(provider.refresh).not.toHaveBeenCalled()
    expect(cryptoExists).not.toHaveBeenCalled()
    store.close()
  })

  it('rejects a changed issuer/client/homeserver/callback before using stored credentials', async () => {
    for (const [key, value] of [['issuer', 'https://other.localhost/'], ['baseUrl', 'https://other.localhost'], ['clientId', 'other'], ['redirectUri', 'http://localhost:4317/other']]) {
      const { store, provider } = await harness(session())
      await expect(new BoundDevice({ ...config, [key]: value }, store, provider).load()).rejects.toThrow('recovery_needed')
      expect(provider.refresh).not.toHaveBeenCalled()
      store.close()
    }
  })

  it('fails before network and crypto initialization when the crypto stores disappeared', async () => {
    const { store, provider } = await harness(session())
    const device = new BoundDevice(config, store, provider, id => requireCryptoStores(id, new IDBFactory()))
    await expect(device.load()).rejects.toThrow('recovery_needed')
    expect(provider.refresh).not.toHaveBeenCalled()
    expect((await store.read() as DeviceSession).deviceId).toBe(session().deviceId)
    store.close()
  })

  it.each([
    `${CALLBACK}?code=c&state=wrong`,
    'http://localhost:4317/other?code=c&state=fixture-state',
    `${CALLBACK}?code=c&state=fixture-state&access_token=fixture-secret`,
    `${CALLBACK}?code=c&state=fixture-state#id_token=fixture-secret`,
    `${CALLBACK}?code=c&code=other&state=fixture-state`,
    `${CALLBACK}?code=c&state=fixture-state&iss=https://wrong.localhost/`
  ])('rejects hostile callback input without spending an exchange', async url => {
    const { device, provider, store } = await harness()
    await device.load(); await device.beginLogin()
    await expect(device.callback(new URL(url))).rejects.toThrow('signed_out')
    expect(provider.exchange).not.toHaveBeenCalled()
    store.close()
  })

  it('never retries an uncertain authorization exchange after reload', async () => {
    const { device, provider, store } = await harness()
    await device.load(); await device.beginLogin()
    provider.exchange = vi.fn(async () => { throw new Error('fixture-network-loss') })
    await expect(device.callback(new URL(`${CALLBACK}?code=c&state=fixture-state`))).rejects.toThrow('recovery_needed')
    expect((await store.read() as PendingLogin).phase).toBe('exchanging')
    await expect(new BoundDevice(config, store, provider).load()).rejects.toThrow('recovery_needed')
    expect(provider.exchange).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('does not recreate a signed-out identity if provider revocation fails', async () => {
    const { device, provider, store } = await harness(session())
    await device.load()
    provider.revoke = vi.fn(async () => { throw new Error('fixture-provider-offline') })
    await expect(device.signOut()).rejects.toThrow('fixture-provider-offline')
    expect((await store.read() as DeviceSession).phase).toBe('signed_out')
    await expect(new BoundDevice(config, store, provider).load()).rejects.toThrow('signed_out')
    store.close()
  })

  it('finishes an in-flight rotation then signs out, refusing any new refresh', async () => {
    const { device, provider, store } = await harness(session())
    await device.load()
    let complete!: (value: Awaited<ReturnType<BrowserOAuth['refresh']>>) => void
    provider.refresh = vi.fn(() => new Promise<Awaited<ReturnType<BrowserOAuth['refresh']>>>(resolve => { complete = resolve }))
    const refresh = device.refresh('fixture-next-refresh')
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    const signingOut = device.signOut()
    expect(await device.refresh('fixture-next-refresh')).toMatchObject({ ok: false, reauthenticate: true })
    expect(() => device.configuration()).toThrow('signed_out')
    complete({ accessToken: 'fixture-final', refreshToken: 'fixture-final-refresh', scope: session().scope, expiresAt: Date.now() + 60000 })
    await refresh; await signingOut
    expect((await store.read() as DeviceSession)).toMatchObject({ phase: 'signed_out', refreshToken: 'fixture-final-refresh', deviceId: session().deviceId })
    expect(provider.revoke).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'fixture-final-refresh' }))
    store.close()
  })

  it('atomically refuses stale writers without replacing any bound field', async () => {
    const { store } = await harness(session())
    await expect(store.replace(null, session())).rejects.toThrow('recovery_needed')
    await expect(store.replace(7, { ...session(), revision: 8 })).rejects.toThrow('recovery_needed')
    expect(await store.read()).toEqual(session())
    store.close()
  })

  it('requires exact fixed callback and HTTPS issuer configuration', () => {
    expect(parseConfig(config)).toEqual(config)
    expect(() => parseConfig({ ...config, issuer: 'http://mas.localhost' })).toThrow('configuration_required')
    expect(() => parseConfig({ ...config, redirectUri: `${CALLBACK}?next=elsewhere` })).toThrow('configuration_required')
    expect(() => parseConfig({ ...config, baseUrl: 'https://fixture-2296b34165@example.invalid' })).toThrow('configuration_required')
  })

  it('requests and persists the canonical public-client MSC2967 scopes on exactly one device', () => {
    const exact = 'openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:DEVICE_123456'
    expect(matrixScope('DEVICE_123456')).toBe(exact)
    expect(requireScope(exact, 'DEVICE_123456')).toBe(exact)
    const reordered = exact.split(' ').reverse().join(' ')
    expect(requireScope(reordered, 'DEVICE_123456')).toBe(reordered)
    expect(() => requireScope(`${exact} urn:matrix:org.matrix.msc2967.client:device:OTHER_DEVICE`, 'DEVICE_123456')).toThrow('recovery_needed')
    expect(() => requireScope('openid urn:matrix:org.matrix.msc2967.client:api:*', 'DEVICE_123456')).toThrow('recovery_needed')
    expect(() => requireScope(`${exact} urn:mas:admin`, 'DEVICE_123456')).toThrow('recovery_needed')
    // A server/persistence namespace change must not be hidden by an alias fallback.
    expect(() => requireScope('openid urn:matrix:client:api:* urn:matrix:client:device:DEVICE_123456', 'DEVICE_123456')).toThrow('recovery_needed')
  })
})

it('Web Lock admits one writer for the full SDK lifetime, with no lease stealing', async () => {
  let held = false
  const locks = { request: async (_name: string, options: LockOptions, work: (lock: object | null) => Promise<void>) => {
    expect(options).toMatchObject({ mode: 'exclusive', ifAvailable: true })
    if (held) return work(null)
    held = true
    await work({})
    held = false
  } } as unknown as LockManager
  const release = await acquireWriter(locks)
  await expect(acquireWriter(locks)).rejects.toThrow('device_busy')
  release()
  await vi.waitFor(() => expect(held).toBe(false))
  const secondRelease = await acquireWriter(locks)
  secondRelease()
})
