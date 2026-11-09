import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'

import { type DomainConfig, type DomainCredentials, type DomainOwner, type DomainPending, type DomainRecord, type DomainSession, parseDomainConfig, type MatrixBinding } from '../src/domain-record'
import { DomainHttpFailure, type DomainOAuth } from '../src/domain-oauth'
import { DomainGrant } from '../src/domain-session'
import { IndexedDomainStore } from '../src/domain-storage'
import { BrowserFailure, CALLBACK, type BrowserConfig } from '../src/record'

const matrixConfig: BrowserConfig = { issuer: 'https://mas.localhost/', baseUrl: 'https://matrix.localhost', clientId: 'matrix-public-client', redirectUri: CALLBACK }
const config: DomainConfig = parseDomainConfig({ clientId: 'domain-public-client', apiBaseUrl: 'https://api.localhost' }, matrixConfig)!
const binding: MatrixBinding = { issuer: config.issuer, subject: 'human-subject', userId: '@human:localhost', deviceId: 'MATRIX_DEVICE_123456' }
const owner: DomainOwner = { issuer: config.issuer, subject: binding.subject, principal: '00000000-0000-4000-8000-fffeb1027f6c' }

function credentials(overrides: Partial<DomainCredentials> = {}): DomainCredentials {
  return { accessToken: 'domain-access', refreshToken: 'domain-refresh', expiresAt: Date.now() + 600_000, scope: 'openid', subject: binding.subject, ...overrides }
}
function active(overrides: Partial<DomainSession> = {}): DomainSession {
  return { ...config, matrix: binding, version: 1, revision: 1, kind: 'domain-session', phase: 'active', principal: owner.principal,
    scope: 'openid', accessToken: 'domain-access', refreshToken: 'domain-refresh', expiresAt: Date.now() + 600_000, ...overrides }
}
function oauth(): DomainOAuth {
  return {
    prepare: vi.fn(async () => ({ config: {} as never, verifier: 'v'.repeat(43), state: 'domain-state', nonce: 'domain-nonce' })),
    authorize: vi.fn(async () => new URL('https://mas.localhost/authorize')),
    exchange: vi.fn(async () => credentials()),
    refresh: vi.fn(async () => credentials({ accessToken: 'domain-rotated', refreshToken: 'domain-next-refresh', subject: undefined })),
    me: vi.fn(async () => owner),
    request: vi.fn(async (_config, _token, resource) => ({ resource })),
    revoke: vi.fn(async () => {}),
  }
}
async function harness(initial?: DomainRecord, matrix: () => MatrixBinding = () => binding) {
  const store = await IndexedDomainStore.open(new IDBFactory())
  if (initial) await store.replace(null, initial)
  const provider = oauth()
  return { store, provider, matrix, grant: new DomainGrant(config, store, matrix, provider) }
}
function callback(record: DomainPending) { return new URL(`${config.redirectUri}?code=domain-code&state=${record.state}`) }

describe('independent browser-domain grant custody', () => {
  it('persists pending before exchange and consumes a callback exactly once', async () => {
    const { grant, provider, store } = await harness()
    expect(await grant.load()).toBe('empty')
    await grant.beginLogin()
    const pending = await store.read() as DomainPending
    expect(pending).toMatchObject({ kind: 'domain-login', phase: 'pending', matrix: binding })
    const resumed = new DomainGrant(config, store, () => binding, provider)
    expect(await resumed.load()).toBe('pending')

    let complete!: (value: DomainCredentials) => void
    provider.exchange = vi.fn(() => new Promise<DomainCredentials>(resolve => { complete = resolve }))
    const first = resumed.callback(callback(pending))
    await vi.waitFor(async () => expect((await store.read() as DomainPending).phase).toBe('exchanging'))
    await expect(resumed.callback(callback(pending))).rejects.toBeInstanceOf(BrowserFailure)
    expect(provider.exchange).toHaveBeenCalledTimes(1)
    complete(credentials())
    await first
    expect(await resumed.load()).toBe('active')
    expect((await store.read() as DomainSession).matrix).toEqual(binding)
    store.close()
  })

  it('requires both OIDC and API identities to agree with the Matrix binding', async () => {
    for (const setup of [
      (provider: DomainOAuth) => { provider.exchange = vi.fn(async () => credentials({ subject: 'different-subject' })) },
      (provider: DomainOAuth) => { provider.me = vi.fn(async () => ({ ...owner, subject: 'different-subject' })) },
      (provider: DomainOAuth) => { provider.me = vi.fn(async () => ({ ...owner, issuer: 'https://other.localhost/' })) },
    ]) {
      const { grant, provider, store } = await harness()
      await grant.beginLogin()
      const pending = await store.read() as DomainPending
      setup(provider)
      await expect(grant.callback(callback(pending))).rejects.toThrow('recovery_needed')
      expect((await store.read() as DomainPending).phase).toBe('exchanging')
      await expect(new DomainGrant(config, store, () => binding, provider).load()).rejects.toThrow('recovery_needed')
      store.close()
    }
  })

  it('preserves untrusted records and does not restart malformed, future, mismatched, or signed-out state', async () => {
    const future: DomainPending = { ...config, matrix: binding, version: 1, revision: 1, kind: 'domain-login', phase: 'pending',
      verifier: 'v'.repeat(43), state: 'future-state', nonce: 'future-nonce', createdAt: Date.now() + 60_000 }
    const cases: Array<{ record: DomainRecord; matrix?: () => MatrixBinding }> = [
      { record: { revision: 1, kind: 'domain-session' } as DomainRecord },
      { record: future },
      { record: active({ clientId: 'other-client' }) },
      { record: active({ issuer: 'https://other.localhost/' }) },
      { record: active({ scope: 'not-openid' as 'openid' }) },
      { record: active(), matrix: () => ({ ...binding, deviceId: 'OTHER_DEVICE_123456' }) },
      { record: active({ phase: 'signed_out' }) },
    ]
    for (const { record, matrix } of cases) {
      const { grant, provider, store } = await harness(record, matrix)
      const bytes = JSON.stringify(await store.read())
      await expect(grant.load()).rejects.toBeInstanceOf(BrowserFailure)
      await expect(grant.beginLogin()).rejects.toBeInstanceOf(BrowserFailure)
      expect(JSON.stringify(await store.read())).toBe(bytes)
      expect(provider.prepare).not.toHaveBeenCalled()
      expect(provider.refresh).not.toHaveBeenCalled()
      store.close()
    }
  })

  it('permits an explicit reconnect only from a known blocked domain record', async () => {
    const { grant, provider, store } = await harness(active({ phase: 'blocked' }))
    await expect(grant.load()).rejects.toThrow('recovery_needed')
    await expect(grant.beginLogin()).resolves.toBeInstanceOf(URL)
    expect(provider.prepare).toHaveBeenCalledTimes(1)
    expect(await store.read()).toMatchObject({ kind: 'domain-login', phase: 'pending', matrix: binding })
    store.close()
  })

  it('refreshes independently, verifies API identity without a new ID token, and keeps the Matrix device binding', async () => {
    const { grant, provider, store } = await harness(active())
    expect(await grant.load()).toBe('active')
    provider.refresh = vi.fn(async session => credentials({ accessToken: 'next-access', refreshToken: 'next-refresh', subject: undefined, expiresAt: session.expiresAt + 1 }))
    provider.me = vi.fn(async () => owner)
    expect(await grant.refresh()).toBe(true)
    const persisted = await store.read() as DomainSession
    expect(vi.mocked(provider.me).mock.calls.at(-1)).toEqual([expect.objectContaining(config), 'next-access'])
    expect(persisted).toMatchObject({ matrix: binding, scope: 'openid', accessToken: 'next-access', refreshToken: 'next-refresh' })
    store.close()
  })

  it('never automatically reloads uncertain exchange or refresh state', async () => {
    const exchange = await harness()
    await exchange.grant.beginLogin()
    const pending = await exchange.store.read() as DomainPending
    exchange.provider.exchange = vi.fn(async () => { throw new Error('offline') })
    await expect(exchange.grant.callback(callback(pending))).rejects.toThrow('recovery_needed')
    await expect(new DomainGrant(config, exchange.store, () => binding, exchange.provider).load()).rejects.toThrow('recovery_needed')
    expect(exchange.provider.exchange).toHaveBeenCalledTimes(1)
    exchange.store.close()

    const refresh = await harness(active())
    expect(await refresh.grant.load()).toBe('active')
    refresh.provider.refresh = vi.fn(async () => { throw new Error('offline') })
    expect(await refresh.grant.refresh()).toBe(false)
    expect((await refresh.store.read() as DomainSession).phase).toBe('blocked')
    await expect(new DomainGrant(config, refresh.store, () => binding, refresh.provider).load()).rejects.toThrow('recovery_needed')
    refresh.store.close()
  })

  it('uses fixed resources, retries one idempotent 401 after rotation, and closes locally before revocation', async () => {
    const { grant, provider, store } = await harness(active())
    expect(await grant.load()).toBe('active')
    provider.request = vi.fn()
      .mockRejectedValueOnce(new DomainHttpFailure(401))
      .mockResolvedValueOnce({ accepted: true })
    provider.refresh = vi.fn(async () => credentials({ accessToken: 'retry-access', refreshToken: 'retry-refresh', subject: undefined }))
    provider.me = vi.fn(async () => owner)
    await expect(grant.request('assistant')).resolves.toEqual({ accepted: true })
    expect(vi.mocked(provider.request).mock.calls.at(0)).toEqual([expect.objectContaining(config), expect.any(String), 'assistant'])
    expect(vi.mocked(provider.request).mock.calls.at(1)).toEqual([expect.objectContaining(config), 'retry-access', 'assistant'])
    expect(provider.refresh).toHaveBeenCalledTimes(1)

    let complete!: (value: DomainCredentials) => void
    provider.refresh = vi.fn(() => new Promise<DomainCredentials>(resolve => { complete = resolve }))
    const first = grant.refresh()
    expect(grant.refresh()).toBe(first)
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    provider.revoke = vi.fn(async session => {
      expect((await store.read() as DomainSession).phase).toBe('signed_out')
      expect(session.refreshToken).toBe('final-refresh')
      throw new Error('offline')
    })
    const signingOut = grant.signOut()
    await expect(grant.request('me')).rejects.toThrow('signed_out')
    complete(credentials({ accessToken: 'final-access', refreshToken: 'final-refresh', subject: undefined }))
    expect(await first).toBe(true)
    await expect(signingOut).rejects.toThrow('offline')
    expect((await store.read() as DomainSession)).toMatchObject({ phase: 'signed_out', refreshToken: 'final-refresh', matrix: binding })
    expect(provider.revoke).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('discards a domain response that arrives after admission closes', async () => {
    const { grant, provider, store } = await harness(active())
    expect(await grant.load()).toBe('active')
    let complete!: (value: unknown) => void
    provider.request = vi.fn(() => new Promise(resolve => { complete = resolve }))
    const request = grant.request('wallet')
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    grant.closeAdmission()
    complete({ balances: 'late' })
    await expect(request).rejects.toThrow('signed_out')
    store.close()
  })
})
