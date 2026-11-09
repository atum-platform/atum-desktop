import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'

import { openAccount, signOutAccount } from '../src/account'
import { parseDomainConfig, type DomainConfig, type DomainCredentials, type DomainOwner, type DomainSession, type MatrixBinding } from '../src/domain-record'
import type { DomainOAuth } from '../src/domain-oauth'
import { DomainGrant } from '../src/domain-session'
import { IndexedDomainStore } from '../src/domain-storage'
import type { BrowserOAuth, Credentials } from '../src/oauth'
import { CALLBACK, matrixScope, type BrowserConfig, type DeviceSession, type PendingLogin } from '../src/record'
import { BoundDevice } from '../src/session'
import { IndexedDeviceStore } from '../src/storage'

const matrixConfig: BrowserConfig = { issuer: 'https://mas.localhost/', baseUrl: 'https://matrix.localhost', clientId: 'matrix-public-client', redirectUri: CALLBACK }
const matrixBinding = (deviceId = 'MATRIX_DEVICE_123456'): MatrixBinding => ({ issuer: matrixConfig.issuer, subject: 'human-subject', userId: '@human:localhost', deviceId })
const domainConfig: DomainConfig = parseDomainConfig({ clientId: 'domain-public-client', apiBaseUrl: 'https://api.localhost' }, matrixConfig)!
const owner = (binding: MatrixBinding): DomainOwner => ({ issuer: binding.issuer, subject: binding.subject, principal: '00000000-0000-4000-8000-fffeb1027f6c' })

function matrixSession(): DeviceSession {
  const binding = matrixBinding()
  return { ...matrixConfig, version: 1, revision: 1, kind: 'session', phase: 'active', deviceId: binding.deviceId, userId: binding.userId,
    subject: binding.subject, storageKey: btoa('x'.repeat(32)), scope: matrixScope(binding.deviceId), accessToken: 'matrix-access', refreshToken: 'matrix-refresh', expiresAt: Date.now() + 600_000 }
}
function domainSession(binding: MatrixBinding): DomainSession {
  return { ...domainConfig, matrix: binding, version: 1, revision: 1, kind: 'domain-session', phase: 'active', principal: owner(binding).principal,
    scope: 'openid', accessToken: 'domain-access', refreshToken: 'domain-refresh', expiresAt: Date.now() + 600_000 }
}
function matrixOAuth(): BrowserOAuth {
  return {
    prepare: vi.fn(async () => ({ config: {} as never, verifier: 'v'.repeat(43), state: 'matrix-state', nonce: 'matrix-nonce' })),
    authorize: vi.fn(async () => new URL('https://mas.localhost/matrix-authorize')),
    exchange: vi.fn(async pending => ({ accessToken: 'matrix-new-access', refreshToken: 'matrix-new-refresh', expiresAt: Date.now() + 600_000,
      subject: 'human-subject', scope: matrixScope(pending.deviceId) })),
    refresh: vi.fn(async old => ({ accessToken: 'matrix-rotated', refreshToken: 'matrix-next-refresh', expiresAt: Date.now() + 600_000,
      subject: undefined, scope: old.scope })),
    whoami: vi.fn(async config => ({ userId: '@human:localhost', deviceId: config.deviceId })),
    revoke: vi.fn(async () => {}),
  }
}
function domainOAuth(): DomainOAuth {
  return {
    prepare: vi.fn(async () => ({ config: {} as never, verifier: 'd'.repeat(43), state: 'domain-state', nonce: 'domain-nonce' })),
    authorize: vi.fn(async () => new URL('https://mas.localhost/domain-authorize')),
    exchange: vi.fn(async pending => ({ accessToken: 'domain-new-access', refreshToken: 'domain-new-refresh', expiresAt: Date.now() + 600_000,
      subject: pending.matrix.subject, scope: 'openid' as const })),
    refresh: vi.fn(async session => ({ accessToken: 'domain-rotated', refreshToken: 'domain-next-refresh', expiresAt: Date.now() + 600_000,
      subject: undefined, scope: session.scope })),
    me: vi.fn(async config => owner({ issuer: config.issuer, subject: 'human-subject', userId: '@human:localhost', deviceId: 'MATRIX_DEVICE_123456' })),
    request: vi.fn(async (_config, _token, resource) => ({ resource })),
    revoke: vi.fn(async () => {}),
  }
}
async function harness(options: { matrix?: DeviceSession; domain?: DomainSession } = {}) {
  const factory = new IDBFactory()
  const matrixStore = await IndexedDeviceStore.open(factory)
  if (options.matrix) await matrixStore.replace(null, options.matrix)
  const domainStore = await IndexedDomainStore.open(factory)
  if (options.domain) await domainStore.replace(null, options.domain)
  const matrixProvider = matrixOAuth()
  const domainProvider = domainOAuth()
  const cryptoExists = vi.fn(async () => {})
  const device = new BoundDevice(matrixConfig, matrixStore, matrixProvider, cryptoExists)
  const domain = new DomainGrant(domainConfig, domainStore, () => device.identity(), domainProvider)
  return { factory, matrixStore, domainStore, matrixProvider, domainProvider, cryptoExists, device, domain }
}
function matrixCallback(record: PendingLogin) { return new URL(`${CALLBACK}?code=matrix-code&state=${record.state}`) }
function domainCallback(record: { state: string }) { return new URL(`${CALLBACK}?code=domain-code&state=${record.state}`) }
function openCrypto(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('keys')
    request.onsuccess = () => resolve(request.result)
    request.onerror = request.onblocked = () => reject(request.error)
  })
}
function put(db: IDBDatabase, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite')
    tx.objectStore('keys').put(value, 'fixture')
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error)
  })
}
function get(db: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readonly')
    const request = tx.objectStore('keys').get('fixture')
    tx.oncomplete = () => resolve(request.result)
    tx.onerror = tx.onabort = () => reject(tx.error)
  })
}

describe('two independent browser grants', () => {
  it('finishes and persists Matrix crypto admission before starting the second redirect', async () => {
    const { device, domain, matrixStore, domainStore, domainProvider, cryptoExists } = await harness()
    await device.beginLogin()
    const pending = await matrixStore.read() as PendingLogin
    domainProvider.authorize = vi.fn(async () => {
      expect((await matrixStore.read() as DeviceSession).phase).toBe('active')
      expect(cryptoExists).toHaveBeenCalledWith(pending.deviceId)
      return new URL('https://mas.localhost/domain-authorize')
    })

    const state = await openAccount(device, domain, async () => { await device.cryptoStarted() }, matrixCallback(pending))
    expect(state).toMatchObject({ matrix: 'active', domain: 'empty', authorization: expect.any(URL) })
    expect((await domainStore.read())).toMatchObject({ kind: 'domain-login', phase: 'pending', matrix: device.identity() })
    matrixStore.close(); domainStore.close()
  })

  it('routes one pending callback to its matching grant and never replaces Matrix after a domain failure', async () => {
    const first = await harness()
    await first.device.beginLogin()
    const matrixPending = await first.matrixStore.read() as PendingLogin
    await openAccount(first.device, first.domain, async () => { await first.device.cryptoStarted() }, matrixCallback(matrixPending))
    const domainPending = await first.domainStore.read() as { state: string }
    vi.mocked(first.matrixProvider.exchange).mockClear()
    await expect(openAccount(first.device, first.domain, async () => { await first.device.cryptoStarted() }, domainCallback(domainPending))).resolves.toMatchObject({ matrix: 'active', domain: 'active' })
    expect(first.matrixProvider.exchange).not.toHaveBeenCalled()
    expect(first.domainProvider.exchange).toHaveBeenCalledTimes(1)
    const identity = first.device.identity()

    first.domainProvider.refresh = vi.fn(async () => { throw new Error('domain offline') })
    const failed = await openAccount(first.device, first.domain, async () => { await first.device.cryptoStarted() })
    expect(failed).toMatchObject({ matrix: 'active', domain: 'attention' })
    expect(first.device.identity()).toEqual(identity)
    expect(first.device.configuration().deviceId).toBe(identity.deviceId)
    first.matrixStore.close(); first.domainStore.close()
  })

  it('refuses a Matrix replacement login when an independent domain record already exists', async () => {
    const binding = matrixBinding()
    const { device, domain, matrixStore, domainStore, matrixProvider } = await harness({ domain: domainSession(binding) })
    await expect(openAccount(device, domain, async () => { throw new Error('must not start') })).rejects.toThrow('recovery_needed')
    expect(await matrixStore.read()).toBeUndefined()
    expect(await domainStore.read()).toMatchObject({ kind: 'domain-session', phase: 'active' })
    expect(matrixProvider.prepare).not.toHaveBeenCalled()
    matrixStore.close(); domainStore.close()
  })

  it('closes both admissions before waiting for rotations, then persists both signed-out records', async () => {
    const binding = matrixBinding()
    const { device, domain, matrixStore, domainStore, matrixProvider, domainProvider } = await harness({ matrix: matrixSession(), domain: domainSession(binding) })
    await device.load(); await domain.load()
    let finishMatrix!: (value: Credentials) => void
    let finishDomain!: (value: DomainCredentials) => void
    matrixProvider.refresh = vi.fn(old => new Promise<Credentials>(resolve => { finishMatrix = resolve }))
    domainProvider.refresh = vi.fn(() => new Promise<DomainCredentials>(resolve => { finishDomain = resolve }))
    const matrixRefresh = device.refresh(device.configuration().refreshToken!)
    const domainRefresh = domain.refresh()
    await vi.waitFor(() => expect(finishMatrix).toBeTypeOf('function'))
    await vi.waitFor(() => expect(finishDomain).toBeTypeOf('function'))
    const signedOut = signOutAccount(device, domain)
    expect(() => device.configuration()).toThrow('signed_out')
    await expect(domain.request('me')).rejects.toThrow('signed_out')
    matrixProvider.revoke = vi.fn(async () => {
      expect((await matrixStore.read() as DeviceSession).phase).toBe('signed_out')
      expect((await domainStore.read() as DomainSession).phase).toBe('signed_out')
    })
    domainProvider.revoke = vi.fn(async () => {
      expect((await matrixStore.read() as DeviceSession).phase).toBe('signed_out')
      expect((await domainStore.read() as DomainSession).phase).toBe('signed_out')
    })
    finishMatrix({ accessToken: 'matrix-final', refreshToken: 'matrix-final-refresh', expiresAt: Date.now() + 600_000, scope: matrixScope(binding.deviceId) })
    finishDomain({ accessToken: 'domain-final', refreshToken: 'domain-final-refresh', expiresAt: Date.now() + 600_000, scope: 'openid' })
    expect((await matrixRefresh).ok).toBe(true)
    expect(await domainRefresh).toBe(true)
    expect(await signedOut).toBe(true)
    expect((await matrixStore.read() as DeviceSession)).toMatchObject({ phase: 'signed_out', refreshToken: 'matrix-final-refresh' })
    expect((await domainStore.read() as DomainSession)).toMatchObject({ phase: 'signed_out', refreshToken: 'domain-final-refresh' })
    matrixStore.close(); domainStore.close()
  })

  it('keeps both durable records and Matrix crypto material when providers are offline during account sign-out', async () => {
    const binding = matrixBinding()
    const { factory, device, domain, matrixStore, domainStore, matrixProvider, domainProvider } = await harness({ matrix: matrixSession(), domain: domainSession(binding) })
    const crypto = await openCrypto(factory, `crypto-${binding.deviceId}::matrix-sdk-crypto`)
    const material = { opaque: 'sdk-key-material', counter: 3 }
    await put(crypto, material)
    await device.load(); await domain.load()
    matrixProvider.revoke = vi.fn(async () => {
      expect((await matrixStore.read() as DeviceSession).phase).toBe('signed_out')
      expect((await domainStore.read() as DomainSession).phase).toBe('signed_out')
      throw new Error('matrix offline')
    })
    domainProvider.revoke = vi.fn(async () => {
      expect((await matrixStore.read() as DeviceSession).phase).toBe('signed_out')
      expect((await domainStore.read() as DomainSession).phase).toBe('signed_out')
      throw new Error('domain offline')
    })

    expect(await signOutAccount(device, domain)).toBe(false)
    expect((await matrixStore.read() as DeviceSession).phase).toBe('signed_out')
    expect((await domainStore.read() as DomainSession).phase).toBe('signed_out')
    expect(await get(crypto)).toEqual(material)
    crypto.close(); matrixStore.close(); domainStore.close()
  })

  it('does not claim confirmed remote closure after an uncertain second-grant exchange', async () => {
    const { device, domain, matrixStore, domainStore, domainProvider, matrixProvider } = await harness({ matrix: matrixSession() })
    await device.load()
    await domain.load()
    await domain.beginLogin()
    const pending = await domainStore.read() as { state: string }
    domainProvider.me = vi.fn(async () => { throw new Error('domain API unavailable after MAS issuance') })
    await expect(domain.callback(domainCallback(pending))).rejects.toThrow('recovery_needed')
    expect(await domainStore.read()).toMatchObject({ kind: 'domain-login', phase: 'exchanging' })
    // A reload loses any response-only token. The durable marker proves uncertainty.
    const reloaded = new DomainGrant(domainConfig, domainStore, () => device.identity(), domainProvider)
    await expect(reloaded.load()).rejects.toThrow('recovery_needed')
    expect(await signOutAccount(device, reloaded)).toBe(false)
    expect(matrixProvider.revoke).toHaveBeenCalledOnce()
    expect(domainProvider.revoke).not.toHaveBeenCalled()
    expect(await matrixStore.read()).toMatchObject({ phase: 'signed_out' })
    matrixStore.close(); domainStore.close()
  })

  it('does not treat revoking a consumed domain refresh handle as confirmation of an uncertain rotation', async () => {
    const binding = matrixBinding()
    const { device, domain, matrixStore, domainStore, domainProvider, matrixProvider } = await harness({ matrix: matrixSession(), domain: domainSession(binding) })
    await device.load(); await domain.load()
    const old = await domainStore.read() as DomainSession
    domainProvider.refresh = vi.fn(async () => ({ accessToken: 'issued-after-rotation', refreshToken: 'issued-refresh-after-rotation', expiresAt: Date.now() + 600_000, scope: 'openid' as const }))
    domainProvider.me = vi.fn(async () => { throw new Error('owner check unavailable after rotation') })
    expect(await domain.refresh()).toBe(false)
    expect(await domainStore.read()).toMatchObject({ phase: 'blocked', refreshToken: old.refreshToken })
    const reloaded = new DomainGrant(domainConfig, domainStore, () => device.identity(), domainProvider)
    await expect(reloaded.load()).rejects.toThrow('recovery_needed')
    // Real MAS also returns 200 for a consumed handle without closing the new session.
    domainProvider.revoke = vi.fn(async () => {})
    expect(await signOutAccount(device, reloaded)).toBe(false)
    expect(matrixProvider.revoke).toHaveBeenCalledOnce()
    expect(domainProvider.revoke).toHaveBeenCalledOnce()
    expect(domainProvider.revoke).toHaveBeenCalledWith(expect.objectContaining({ phase: 'blocked', refreshToken: old.refreshToken }))
    expect(await domainStore.read()).toMatchObject({ phase: 'signed_out' })
    matrixStore.close(); domainStore.close()
  })


  it('keeps Matrix rotation uncertainty unconfirmed even when revoking the old handle returns success', async () => {
    const binding = matrixBinding()
    const { device, domain, matrixStore, domainStore, matrixProvider, domainProvider } = await harness({ matrix: matrixSession(), domain: domainSession(binding) })
    await device.load(); await domain.load()
    const old = await matrixStore.read() as DeviceSession
    matrixProvider.refresh = vi.fn(async () => ({ accessToken: 'matrix-issued-after-rotation', refreshToken: 'matrix-issued-refresh-after-rotation', expiresAt: Date.now() + 600_000, scope: old.scope }))
    matrixProvider.whoami = vi.fn(async () => { throw new Error('whoami unavailable after rotation') })
    expect((await device.refresh(old.refreshToken)).ok).toBe(false)
    expect(await matrixStore.read()).toMatchObject({ phase: 'blocked', refreshToken: old.refreshToken })
    matrixProvider.revoke = vi.fn(async () => {})
    expect(await signOutAccount(device, domain)).toBe(false)
    expect(matrixProvider.revoke).toHaveBeenCalledWith(expect.objectContaining({ phase: 'blocked', refreshToken: old.refreshToken }))
    expect(domainProvider.revoke).toHaveBeenCalledOnce()
    expect(await matrixStore.read()).toMatchObject({ phase: 'signed_out' })
    expect(await domainStore.read()).toMatchObject({ phase: 'signed_out' })
    matrixStore.close(); domainStore.close()
  })

})
