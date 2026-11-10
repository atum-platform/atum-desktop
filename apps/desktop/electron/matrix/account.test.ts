import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as oidc from 'openid-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EncryptedStore } from '../encrypted-store'

import { END_DEVICE_SESSION_ACTION, END_DEVICE_SESSION_ID, MatrixAccount } from './account'
import { requestMatrixChatGptRelay } from './chatgpt-relay-client'
import { matrixConfigurationKey } from './config'
import { currentIanaTimeZone } from './time-zone'
import type * as TimeZoneModule from './time-zone'

vi.mock('./time-zone', async importOriginal => {
  const actual = await importOriginal<typeof TimeZoneModule>()

  return { ...actual, currentIanaTimeZone: vi.fn(() => 'Asia/Ho_Chi_Minh') }
})

vi.mock('openid-client', () => ({
  discovery: vi.fn(async () => ({})),
  None: () => ({}),
  allowInsecureRequests: () => {},
  refreshTokenGrant: vi.fn(),
  tokenRevocation: vi.fn(async () => {}),
  ResponseBodyError: class extends Error {
    constructor(public error: string) {
      super(error)
    }
  }
}))
const directories: string[] = []
afterEach(() => {
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

const config = {
  issuer: 'https://id.test',
  server: 'https://matrix.test',
  nativeClientId: 'client',
  callbackPort: 21881
}

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-matrix-test-'))
  directories.push(directory)
  const file = path.join(directory, 'vault.json')

  const store = new EncryptedStore(file, {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString()
  })

  store.setItem(
    'matrix-account',
    JSON.stringify({
      version: 1,
      configurationKey: matrixConfigurationKey(config),
      issuer: config.issuer,
      subject: 'subject',
      userId: '@alice:test',
      deviceId: 'DEVICE',
      storageKey: Buffer.alloc(32, 1).toString('base64'),
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh'
    })
  )

  return { file, store, account: new MatrixAccount(config, store, async () => {}) }
}

const ownerReaderConfig = {
  ...config,
  domain: { nativeClientId: 'domain-client', resource: 'https://domain.test', callbackPort: 21884 }
}

const ownerReaderExecutor = '00000000-0000-4000-8000-cf4c4732fd3b'
const ownerReaderEnrollment = '00000000-0000-4000-8000-ecbad70593ee'
const ownerReaderPrincipal = '00000000-0000-4000-8000-0d23e78bd190'

function ownerReaderFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-owner-reader-test-'))
  directories.push(directory)

  const store = new EncryptedStore(path.join(directory, 'vault.json'), {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString()
  })

  store.setItem('matrix-account', JSON.stringify({
    version: 1,
    configurationKey: matrixConfigurationKey(ownerReaderConfig),
    issuer: ownerReaderConfig.issuer,
    subject: 'owner-subject',
    userId: '@alice:test',
    deviceId: 'OWNER_DEVICE',
    storageKey: Buffer.alloc(32, 2).toString('base64'),
    accessToken: 'synthetic-access',
    refreshToken: 'synthetic-refresh',
    domain: {
      issuer: ownerReaderConfig.issuer,
      subject: 'owner-subject',
      accessToken: 'synthetic-domain-access',
      refreshToken: 'synthetic-domain-refresh',
      sessionId: 'owner-domain-session'
    }
  }))

  return { store, account: new MatrixAccount(ownerReaderConfig, store, async () => {}) }
}

function pendingOwnerReader(overrides: Record<string, unknown> = {}) {
  return {
    executorId: ownerReaderExecutor,
    enrollmentId: ownerReaderEnrollment,
    kind: 'owner_reader',
    deviceId: `ATUM_COMPANION_${ownerReaderExecutor}`,
    state: 'awaiting_trust',
    trust: 'pending',
    disclosureVersion: 1,
    ownerDevice: 'OWNER_DEVICE',
    handoffUntil: Date.now() + 60_000,
    ...overrides
  }
}

function installOwnerReaderFetch(enrollments: unknown[], handoff?: unknown) {
  const requests: Array<{ method: string; path: string; authorization: string | null; body?: unknown }> = []

  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    requests.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get('authorization'),
      ...(request.method === 'POST' ? { body: await request.clone().json() } : {})
    })

    if (url.pathname === '/me') {
      return Response.json({ issuer: ownerReaderConfig.issuer, subject: 'owner-subject', principal: ownerReaderPrincipal })
    }

    if (url.pathname === '/cloud/enrollments') {return Response.json({ enrollments })}

    if (url.pathname === `/cloud/enrollments/${ownerReaderEnrollment}/handoff`) {return Response.json(handoff)}

    return new Response(null, { status: 404 })
  })

  vi.stubGlobal('fetch', fetch)

  return { fetch, requests }
}

describe('main-owned Matrix account', () => {
  it('lists the device IDs of the non-human participants it enrolled', () => {
    const { account, store } = fixture()
    const record = JSON.parse(store.getItem('matrix-account')!)

    store.setItem(
      'matrix-account',
      JSON.stringify({
        ...record,
        enrollment: {
          executorId: 'default-executor',
          state: 'ready',
          agentPrincipal: 'default-principal',
          credential: {
            userId: '@agent-default:test',
            deviceId: 'ATUM_AGENT_DEFAULT',
            agentPrincipal: 'default-principal',
            accessToken: 'agent-token'
          }
        },
        agentEnrollments: {
          'other-principal': {
            executorId: 'other-executor',
            state: 'ready',
            agentPrincipal: 'other-principal',
            credential: {
              userId: '@agent-other:test',
              deviceId: 'ATUM_AGENT_OTHER',
              agentPrincipal: 'other-principal',
              accessToken: 'agent-token'
            }
          }
        },
        apps: {
          moon: {
            executorId: 'app-executor',
            state: 'ready',
            credential: { userId: '@app-moon:test', deviceId: 'ATUM_APP_BOT_MOON_1', accessToken: 'app-token' }
          }
        }
      })
    )

    expect(account.agentDeviceIds().sort()).toEqual(['ATUM_AGENT_DEFAULT', 'ATUM_AGENT_OTHER', 'ATUM_APP_BOT_MOON_1'])
  })

  it('reads an existing pending owner-reader enrollment with the authenticated domain grant and never creates one', async () => {
    const { account } = ownerReaderFixture()
    const network = installOwnerReaderFetch([pendingOwnerReader()])

    await expect(account.ownerReaderTrustEnrollment()).resolves.toEqual({
      executorId: ownerReaderExecutor,
      enrollmentId: ownerReaderEnrollment,
      kind: 'owner_reader',
      ownerPrincipal: ownerReaderPrincipal,
      ownerUserId: '@alice:test',
      deviceId: `ATUM_COMPANION_${ownerReaderExecutor}`,
      enrollmentState: 'awaiting_trust',
      trust: 'pending',
      disclosureVersion: 1,
      ownerDevice: 'OWNER_DEVICE',
      handoffUntil: expect.any(Number)
    })
    expect(network.requests).toEqual([
      { method: 'GET', path: '/me', authorization: 'Bearer synthetic-domain-access' },
      { method: 'GET', path: '/cloud/enrollments', authorization: 'Bearer synthetic-domain-access' }
    ])
  })

  it('opens a bounded handoff only for an existing pending reader and sends the native owner device', async () => {
    const { account } = ownerReaderFixture()
    const provisioned = pendingOwnerReader({ state: 'provisioning', ownerDevice: undefined, handoffUntil: undefined })
    const network = installOwnerReaderFetch([provisioned], { enrollment: pendingOwnerReader() })

    await expect(account.ownerReaderTrustEnrollment()).resolves.toMatchObject({ executorId: ownerReaderExecutor, enrollmentId: ownerReaderEnrollment })
    expect(network.requests).toEqual([
      { method: 'GET', path: '/me', authorization: 'Bearer synthetic-domain-access' },
      { method: 'GET', path: '/cloud/enrollments', authorization: 'Bearer synthetic-domain-access' },
      {
        method: 'POST',
        path: `/cloud/enrollments/${ownerReaderEnrollment}/handoff`,
        authorization: 'Bearer synthetic-domain-access',
        body: { ownerDevice: 'OWNER_DEVICE' }
      }
    ])
  })

  it('reports a pending reader only while an owner_reader enrollment is provisioning or awaiting trust', async () => {
    const { account } = ownerReaderFixture()

    installOwnerReaderFetch([])
    await expect(account.ownerReaderTrustState()).resolves.toEqual({ pending: false, enrollment: null })

    installOwnerReaderFetch([
      pendingOwnerReader({ state: 'active', trust: 'trusted' }),
      { ...pendingOwnerReader(), kind: 'cloud', agentPrincipal: ownerReaderPrincipal }
    ])
    await expect(account.ownerReaderTrustState()).resolves.toEqual({ pending: false, enrollment: null })

    const provisioning = pendingOwnerReader({ state: 'provisioning', ownerDevice: undefined, handoffUntil: undefined })
    installOwnerReaderFetch([provisioning], { enrollment: provisioning })
    await expect(account.ownerReaderTrustState()).resolves.toEqual({ pending: true, enrollment: null })

    installOwnerReaderFetch([pendingOwnerReader()])
    await expect(account.ownerReaderTrustState()).resolves.toMatchObject({
      pending: true,
      enrollment: { executorId: ownerReaderExecutor, enrollmentId: ownerReaderEnrollment }
    })
  })

  it('does not create, adopt, or renew an arbitrary reader enrollment', async () => {
    const { account } = ownerReaderFixture()

    const network = installOwnerReaderFetch([
      { ...pendingOwnerReader(), kind: 'cloud', agentPrincipal: ownerReaderPrincipal },
      pendingOwnerReader({ handoffUntil: Date.now() - 1 })
    ])

    await expect(account.ownerReaderTrustEnrollment('00000000-0000-4000-8000-54cf138c3f97')).resolves.toBeNull()
    await expect(account.ownerReaderTrustEnrollment(ownerReaderExecutor)).resolves.toBeNull()
    await expect(account.ownerReaderTrustEnrollment('not-a-uuid')).rejects.toThrow('matrix_owner_reader_invalid')
    expect(network.requests.filter(request => request.method === 'POST')).toEqual([])
    expect(network.requests.filter(request => request.path === '/cloud/enrollments')).toHaveLength(2)
  })

  it.each([
    ['wrong device', pendingOwnerReader({ deviceId: 'ARBITRARY_DEVICE' })],
    ['missing disclosure', pendingOwnerReader({ disclosureVersion: 0 })],
    ['agent principal', pendingOwnerReader({ agentPrincipal: ownerReaderPrincipal })],
    ['agent user', pendingOwnerReader({ agentUserId: '@agent:test' })]
  ])('refuses a malformed owner-reader %s before any handoff', async (_name, row) => {
    const { account } = ownerReaderFixture()
    const network = installOwnerReaderFetch([row])

    await expect(account.ownerReaderTrustEnrollment()).rejects.toThrow('matrix_owner_reader_invalid')
    expect(network.requests.filter(request => request.method === 'POST')).toEqual([])
  })

  it('refuses a domain-generation change while the authenticated enrollment read is in flight', async () => {
    const { account } = ownerReaderFixture()
    let finish!: () => void
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async input => {
      const url = new URL(input instanceof Request ? input.url : input)
      requests.push(url.pathname)

      if (url.pathname === '/me') {return Response.json({ issuer: ownerReaderConfig.issuer, subject: 'owner-subject', principal: ownerReaderPrincipal })}

      if (url.pathname === '/cloud/enrollments') {
        await new Promise<void>(resolve => { finish = resolve })

        return Response.json({ enrollments: [pendingOwnerReader()] })
      }

      return new Response(null, { status: 404 })
    }))

    const pending = account.ownerReaderTrustEnrollment()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    account.cancel()
    finish()

    await expect(pending).rejects.toThrow('matrix_owner_reader_stale')
    expect(requests).toEqual(['/me', '/cloud/enrollments'])
  })

  it('refuses an account switch while the authenticated enrollment read is in flight', async () => {
    const { account, store } = ownerReaderFixture()
    let finish!: () => void
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async input => {
      const url = new URL(input instanceof Request ? input.url : input)

      if (url.pathname === '/me') {return Response.json({ issuer: ownerReaderConfig.issuer, subject: 'owner-subject', principal: ownerReaderPrincipal })}

      if (url.pathname === '/cloud/enrollments') {
        await new Promise<void>(resolve => { finish = resolve })

        return Response.json({ enrollments: [pendingOwnerReader()] })
      }

      return new Response(null, { status: 404 })
    }))

    const pending = account.ownerReaderTrustEnrollment()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const switched = JSON.parse(store.getItem('matrix-account')!)
    store.setItem('matrix-account', JSON.stringify({
      ...switched,
      subject: 'different-subject',
      userId: '@bob:test',
      deviceId: 'OTHER_DEVICE',
      domain: { ...switched.domain, subject: 'different-subject', sessionId: 'different-domain-session' }
    }))
    finish()

    await expect(pending).rejects.toThrow('matrix_owner_reader_stale')
  })

  it('fences a private SAS response after the native domain generation is cancelled',async()=>{
    const {account}=ownerReaderFixture()
    let finish!:()=>void
    const requests:string[]=[]
    vi.stubGlobal('fetch',vi.fn<typeof globalThis.fetch>(async input=>{
      const url=new URL(input instanceof Request ? input.url:input)
      requests.push(url.pathname)

      if (url.pathname==='/me') {return Response.json({issuer:ownerReaderConfig.issuer,subject:'owner-subject',principal:ownerReaderPrincipal})}

      if (url.pathname===`/cloud/enrollments/${ownerReaderEnrollment}/verification`) {
        await new Promise<void>(resolve=>{finish=resolve})

        return Response.json({verification:null})
      }

      return new Response(null,{status:404})
    }))
    const pending=account.ownerReaderVerification(ownerReaderEnrollment)
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'))
    account.cancel()
    finish()
    await expect(pending).rejects.toThrow('matrix_owner_reader_stale')
    expect(requests).toEqual(['/me',`/cloud/enrollments/${ownerReaderEnrollment}/verification`])
  })

  it('retains a validated owner recovery key only in the exact account vault, never SDK configuration', async () => {
    const { account, store } = fixture()
    const owner = account.identity()!
    expect(account.recoveryKey(owner)).toBeUndefined()
    account.recoveryKey(owner, 'synthetic-validated-key')
    const reopened = new MatrixAccount(config, store, async () => {})
    expect(reopened.recoveryKey(owner)).toBe('synthetic-validated-key')
    expect(JSON.stringify(reopened.sdkConfiguration())).not.toContain('synthetic-validated-key')
    expect(() => reopened.recoveryKey({ ...owner, deviceId: 'other' }, 'replacement')).toThrow('stale')
    expect(() => reopened.recoveryKey({ ...owner, userId: '@other:test' })).toThrow('stale')
    await reopened.signOut()
    expect(() => reopened.recoveryKey(owner)).toThrow('stale')
    expect(store.getItem('matrix-account')).toBeNull()
  })

  it("marks a key made quietly on this Mac until the person writes it down, and forgets both at sign-out", async () => {
    const { account, store } = fixture()
    const owner = account.identity()!

    expect(account.recoveryCustody(owner)).toBeUndefined()
    expect(() => account.revealRecoveryKey(owner)).toThrow('matrix_recovery_unavailable')
    expect(() => account.recoveryWritten(owner)).toThrow('matrix_recovery_unavailable')

    account.recoveryKey(owner, 'synthetic-quiet-key', 'device')
    const reopened = new MatrixAccount(config, store, async () => {})
    expect(reopened.recoveryCustody(owner)).toBe('device')
    expect(reopened.revealRecoveryKey(owner)).toBe('synthetic-quiet-key')
    expect(() => reopened.revealRecoveryKey({ ...owner, deviceId: 'other' })).toThrow('stale')

    reopened.recoveryWritten(owner)
    expect(reopened.recoveryCustody(owner)).toBeUndefined()
    // Written down: the key itself stays for the assistant's trust step on this Mac.
    expect(reopened.recoveryKey(owner)).toBe('synthetic-quiet-key')

    // A key the person saw or typed is never marked as this Mac's alone.
    reopened.recoveryKey(owner, 'synthetic-quiet-key', 'device')
    reopened.recoveryKey(owner, 'synthetic-typed-key')
    expect(reopened.recoveryCustody(owner)).toBeUndefined()

    reopened.recoveryKey(owner, 'synthetic-quiet-key', 'device')
    await reopened.signOut()
    expect(store.getItem('matrix-account')).toBeNull()
    expect(() => reopened.recoveryCustody(owner)).toThrow('stale')
  })

  it('forgets the record’s copy of the key and its mark when the person forgets the key here', () => {
    const { account, store } = fixture()
    const owner = account.identity()!

    account.recoveryKey(owner, 'synthetic-quiet-key', 'device')
    account.forgetRecoveryKey(owner)

    const reopened = new MatrixAccount(config, store, async () => {})
    expect(reopened.recoveryKey(owner)).toBeUndefined()
    expect(reopened.recoveryCustody(owner)).toBeUndefined()
    // Still signed in: only the key went.
    expect(reopened.identity()).toEqual(owner)
    expect(() => reopened.forgetRecoveryKey({ ...owner, deviceId: 'other' })).toThrow('stale')
  })

  it('opens only the one-device sign-out address on the discovered same-origin account page', async () => {
    const { store } = fixture()
    vi.mocked(oidc.discovery).mockResolvedValueOnce({
      serverMetadata: () => ({
        // Whatever else the discovered address carries is dropped: this is not a way to open the server's other pages.
        account_management_uri: 'https://id.test/account/?action=org.matrix.profile&x=1#frag',
        account_management_actions_supported: ['org.matrix.devices_list', 'org.matrix.device_delete']
      })
    } as never)
    const open = vi.fn(async (_url: string) => {})
    const account = new MatrixAccount(config, store, open)
    await account.endDeviceSession('SECOND.dev_1~-2')
    expect(open).toHaveBeenCalledExactlyOnceWith(
      'https://id.test/account/?action=org.matrix.device_delete&device_id=SECOND.dev_1%7E-2'
    )
    expect(END_DEVICE_SESSION_ACTION).toBe('org.matrix.device_delete')
    // What the platform's gate reads back from the address (atum-platform deploy/chat/templates.py).
    const url = new URL(open.mock.calls[0]![0])
    expect([...url.searchParams.keys()]).toEqual(['action', 'device_id'])
    expect(url.searchParams.get('device_id')).toBe('SECOND.dev_1~-2')
    expect(END_DEVICE_SESSION_ID.test(url.searchParams.get('device_id')!)).toBe(true)
    expect(url.href).not.toContain('synthetic-access')
  })
  it('opens nothing for a device that is not a plain device ID, or once signed out', async () => {
    for (const device of [
      undefined,
      null,
      7,
      '',
      'A/B',
      'A B',
      'A?x=1',
      'A&action=org.matrix.profile',
      '../password/change',
      'A:B',
      'A'.repeat(129),
      { url: 'https://evil.test' }
    ]) {
      const { store } = fixture()
      const open = vi.fn(async () => {})
      await expect(new MatrixAccount(config, store, open).endDeviceSession(device)).rejects.toThrow(
        'matrix_command_invalid'
      )
      expect(open).not.toHaveBeenCalled()
    }

    const { account, store } = fixture()
    await account.signOut()
    const open = vi.fn(async () => {})
    await expect(new MatrixAccount(config, store, open).endDeviceSession('SECOND')).rejects.toThrow('matrix_signed_out')
    expect(open).not.toHaveBeenCalled()
  })
  it('refuses a server whose account address is absent or foreign, or that does not offer the sign-out action', async () => {
    const offered = ['org.matrix.device_delete']

    for (const metadata of [
      { account_management_uri: undefined, account_management_actions_supported: offered },
      { account_management_uri: 'https://evil.test/account/', account_management_actions_supported: offered },
      { account_management_uri: 'https://u:p@id.test/account/', account_management_actions_supported: offered },
      { account_management_uri: 'https://id.test/account/' },
      { account_management_uri: 'https://id.test/account/', account_management_actions_supported: [] },
      // The session list is not a substitute.
      {
        account_management_uri: 'https://id.test/account/',
        account_management_actions_supported: ['org.matrix.devices_list', 'org.matrix.sessions_list']
      }
    ]) {
      const { store } = fixture()
      vi.mocked(oidc.discovery).mockResolvedValueOnce({ serverMetadata: () => metadata } as never)
      const open = vi.fn(async () => {})
      await expect(new MatrixAccount(config, store, open).endDeviceSession('SECOND')).rejects.toThrow(
        'matrix_account_management_'
      )
      expect(open).not.toHaveBeenCalled()
    }
  })
  it('only gives the SDK an opaque process-scoped refresh handle', () => {
    const { account, store } = fixture()
    expect(account.sdkConfiguration().refreshToken).not.toBe('synthetic-refresh')
    expect(account.sdkConfiguration().refreshToken).not.toBe(
      new MatrixAccount(config, store, async () => {}).sdkConfiguration().refreshToken
    )
    expect(account.identity()).toEqual({ userId: '@alice:test', deviceId: 'DEVICE' })
  })
  it('coalesces concurrent refresh and persists rotation before returning it', async () => {
    const { account, store } = fixture()
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({
      access_token: 'rotated-access',
      refresh_token: 'rotated-refresh'
    } as never)
    const handle = account.sdkConfiguration().refreshToken
    const [first, second] = await Promise.all([account.refresh(handle), account.refresh(handle)])
    expect(first).toEqual(second)
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
    expect(JSON.parse(store.getItem('matrix-account')!).refreshToken).toBe('rotated-refresh')
    expect(await account.refresh('foreign')).toEqual({ ok: false, reauthenticate: true, cause: 'stale' })
  })
  it('does not turn a read/decrypt failure into a signed-out account or erase the vault', () => {
    const { account, file } = fixture()
    writeFileSync(file, 'corrupt')
    expect(() => account.identity()).toThrow('matrix_vault_unavailable')
    expect(readFileSync(file, 'utf8')).toBe('corrupt')
  })
  it('keeps local access closed and a durable revoke intent when remote logout fails', async () => {
    const { account, store } = fixture()
    vi.mocked(oidc.tokenRevocation).mockRejectedValueOnce(new Error('network'))
    await expect(account.signOut()).rejects.toThrow('network')
    expect(account.identity()).toBeNull()
    expect(() => account.sdkConfiguration()).toThrow('matrix_signed_out')
    expect(JSON.parse(store.getItem('matrix-account')!).signingOut).toBe(true)
    const restored = new MatrixAccount(config, store, async () => {})
    expect(restored.signOutPending()).toBe(true)
    expect(restored.identity()).toBeNull()
    expect(JSON.parse(store.getItem('matrix-revocations')!)).toHaveLength(1)
    await account.signOut()
    expect(store.getItem('matrix-account')).toBeNull()
    expect(store.getItem('matrix-revocations')).toBeNull()
  })
  it('a refresh finishing during logout cannot resurrect the account', async () => {
    const { account, store } = fixture()
    let finish!: (value: unknown) => void
    vi.mocked(oidc.refreshTokenGrant).mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        }) as never
    )
    const refresh = account.refresh(account.sdkConfiguration().refreshToken)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const logout = account.signOut()
    finish({ access_token: 'late-access', refresh_token: 'late-refresh' })
    expect(await refresh).toEqual({ ok: false, reauthenticate: true, cause: 'signed_out' })
    await logout
    expect(account.identity()).toBeNull()
    expect(store.getItem('matrix-account')).toBeNull()
    expect(oidc.tokenRevocation).toHaveBeenCalledWith(expect.anything(), 'late-refresh', expect.anything())
  })
  it('withdraws Drive owner authority before asynchronous sign-out cleanup finishes', async () => {
    const { account, store } = fixture()
    expect(account.driveOwner()).not.toBeNull()
    let finish!: () => void

    const logout = account.signOut(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )

    expect(JSON.parse(store.getItem('matrix-account')!).signingOut).toBe(true)
    expect(account.driveOwner()).toBeNull()
    finish()
    await logout
    expect(account.driveOwner()).toBeNull()
  })
  it('normal quit/cancel settles an in-flight refresh without revoking the session', async () => {
    const { account, store } = fixture()
    let finish!: (value: unknown) => void
    vi.mocked(oidc.refreshTokenGrant).mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        }) as never
    )
    const refresh = account.refresh(account.sdkConfiguration().refreshToken)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    account.cancel()
    let settled = false

    const quit = account.settleRefresh().then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    finish({ access_token: 'quit-access', refresh_token: 'quit-refresh' })
    expect((await refresh).ok).toBe(true)
    await quit
    expect(new MatrixAccount(config, store, async () => {}).identity()).toEqual({
      userId: '@alice:test',
      deviceId: 'DEVICE'
    })
    expect(JSON.parse(store.getItem('matrix-account')!).refreshToken).toBe('quit-refresh')
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
  })
  it('normal close waits for a refresh first requested while the SDK is stopping', async () => {
    const { account, store } = fixture()
    const handle = account.sdkConfiguration().refreshToken
    let finish!: (value: unknown) => void
    vi.mocked(oidc.refreshTokenGrant).mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        }) as never
    )
    let closed = false

    const closing = account
      .close(async () => {
        void account.refresh(handle)
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      })
      .then(() => {
        closed = true
      })

    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await Promise.resolve()
    expect(closed).toBe(false)
    finish({ access_token: 'closing-access', refresh_token: 'closing-refresh' })
    await closing
    expect(JSON.parse(store.getItem('matrix-account')!).refreshToken).toBe('closing-refresh')
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
  })
  it('clears only the stored device before forgetting credentials, retaining intent if cleanup fails', async () => {
    const { account, store } = fixture()

    const cleanup = vi.fn(async () => {
      throw new Error('storage busy')
    })

    await expect(account.signOut(cleanup)).rejects.toThrow('storage busy')
    expect(cleanup).toHaveBeenCalledWith({ userId: '@alice:test', deviceId: 'DEVICE' }, undefined)
    expect(account.signOutPending()).toBe(true)
    expect(account.identity()).toBeNull()
    expect(store.getItem('matrix-account')).not.toBeNull()
    await account.signOut(async () => {})
    expect(store.getItem('matrix-account')).toBeNull()
  })
  it('does not mistake a provider authorization rejection for successful revocation', async () => {
    const { account, store } = fixture()
    vi.mocked(oidc.tokenRevocation).mockRejectedValueOnce(
      new oidc.ResponseBodyError('invalid_client', {
        cause: { error: 'invalid_client' },
        response: new Response('', { status: 401 })
      })
    )
    await expect(account.signOut()).rejects.toThrow()
    expect(account.signOutPending()).toBe(true)
    expect(store.getItem('matrix-revocations')).not.toBeNull()
    await expect(account.signIn()).rejects.toThrow('matrix_sign_out_first')
  })
  it('gives up a revocation the server keeps refusing, after a few tries, without holding up the rest', async () => {
    const { store } = fixture()
    const log = vi.fn()
    const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log)
    const stuck = { issuer: config.issuer, subject: 'subject', accessToken: 'stuck-access', refreshToken: 'stuck-refresh' }
    const behind = { issuer: config.issuer, subject: 'subject', accessToken: 'behind-access', refreshToken: 'behind-refresh' }
    store.setItem('matrix-revocations', JSON.stringify([stuck, behind]))
    vi.mocked(oidc.tokenRevocation).mockImplementation(async (_config, token) => {
      if (String(token).startsWith('stuck')) {
        throw new oidc.ResponseBodyError('invalid_client', {
          cause: { error: 'invalid_client' },
          response: new Response('', { status: 401 })
        })
      }
    })

    // The entry behind it is revoked on the first drain; the refused one stays, counted.
    await expect(account.drainRevocations()).rejects.toThrow('invalid_client')
    expect(oidc.tokenRevocation).toHaveBeenCalledWith(expect.anything(), 'behind-refresh', expect.anything())
    expect(JSON.parse(store.getItem('matrix-revocations')!)).toEqual([{ ...stuck, attempts: 1 }])
    await expect(account.drainRevocations()).rejects.toThrow('invalid_client')
    expect(log).not.toHaveBeenCalled()

    // The third refusal gives it up, with a closed code and no token in the line.
    await expect(account.drainRevocations()).resolves.toBeUndefined()
    expect(store.getItem('matrix-revocations')).toBeNull()
    expect(log).toHaveBeenCalledWith({
      event: 'revocation_dropped',
      client: 'matrix',
      cause: 'refused',
      oauth: 'invalid_client',
      attempts: 3
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('stuck')

    // A sign-out is no longer held up by it either.
    await account.signOut()
    expect(store.getItem('matrix-account')).toBeNull()
    vi.mocked(oidc.tokenRevocation).mockReset()
  })
  it('keeps a revocation the server never answers through a long outage', async () => {
    const { account, store } = fixture()

    const unanswered = {
      issuer: config.issuer,
      subject: 'subject',
      accessToken: 'later-access',
      refreshToken: 'later-refresh'
    }

    store.setItem('matrix-revocations', JSON.stringify([unanswered]))
    vi.mocked(oidc.tokenRevocation).mockRejectedValue(new TypeError('fetch failed'))

    for (let attempt = 1; attempt <= 10; attempt++) {
      await expect(account.drainRevocations()).rejects.toThrow('fetch failed')
    }

    expect(JSON.parse(store.getItem('matrix-revocations')!)).toEqual([{ ...unanswered, attempts: 10 }])
    vi.mocked(oidc.tokenRevocation).mockReset()
  })
  it('does not lose a revocation appended while another drain is in flight', async () => {
    const { account, store } = fixture()
    store.setItem(
      'matrix-revocations',
      JSON.stringify([
        { issuer: config.issuer, subject: 'earlier', accessToken: 'earlier-access', refreshToken: 'earlier-refresh' }
      ])
    )
    let finish!: () => void
    vi.mocked(oidc.tokenRevocation).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        }) as never
    )
    const earlier = account.drainRevocations()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const logout = account.signOut()
    await vi.waitFor(() => expect(JSON.parse(store.getItem('matrix-revocations')!)).toHaveLength(2))
    finish()
    await Promise.all([earlier, logout])
    expect(oidc.tokenRevocation).toHaveBeenCalledWith(expect.anything(), 'synthetic-refresh', expect.anything())
    expect(oidc.tokenRevocation).toHaveBeenCalledWith(expect.anything(), 'synthetic-access', expect.anything())
    expect(store.getItem('matrix-revocations')).toBeNull()
  })
  it('does not start browser auth when credential encryption is unavailable', async () => {
    const { file, store } = fixture()
    store.removeItem('matrix-account')

    const unavailable = new EncryptedStore(file, {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error('unavailable')
      },
      decryptString: () => ''
    })

    const browser = vi.fn(async () => {})
    const account = new MatrixAccount(config, unavailable, browser)
    await expect(account.signIn()).rejects.toThrow('auth_storage_unavailable')
    expect(browser).not.toHaveBeenCalled()
    expect(oidc.discovery).not.toHaveBeenCalled()
  })
  it('holds a rotation the vault could not save: never revoked, never handed out, saved and served once there is room', async () => {
    vi.useFakeTimers()

    try {
      const log = vi.fn()
      const renewed = vi.fn()
      const { store } = fixture()
      const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log, { renewed })
      const owner = account.identity()!
      const handle = account.sdkConfiguration().refreshToken
      const retained = store.getItem('matrix-account')
      vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({
        access_token: 'held-access',
        refresh_token: 'held-refresh',
        expires_in: 300
      } as never)

      // The Mac mini at 18:08:56Z on 2026-10-04: the disk is full when the rotation lands.
      const full = vi.spyOn(store, 'setItem').mockImplementation(() => {
        throw new Error('auth_storage_disk_full')
      })

      expect(await account.refresh(handle)).toEqual({ ok: false, reauthenticate: false, cause: 'disk_full' })
      // The session goes on, signed in; nothing is revoked, and nobody is handed the held token,
      // so the saved grant still works if this Mac stops before the save lands.
      expect(oidc.tokenRevocation).not.toHaveBeenCalled()
      expect(account.identity()).toEqual(owner)
      expect(account.sessionEnded()).toBeNull()
      expect(account.sdkConfiguration().accessToken).toBe('synthetic-access')
      expect(store.getItem('matrix-account')).toBe(retained)
      expect(log).toHaveBeenCalledWith({
        event: 'credential_save_failed',
        client: 'matrix',
        code: 'auth_storage_disk_full'
      })

      // Asked again while the disk is still full: the sign-in server is not asked again (that
      // would revoke the held pair for nothing), and still nobody gets a token.
      expect(await account.refresh(handle)).toEqual({ ok: false, reauthenticate: false, cause: 'disk_full' })
      expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(store.getItem('matrix-account')).toBe(retained)
      expect(renewed).not.toHaveBeenCalled()

      // Room on the disk again: the next try saves the held pair into the record as it is now.
      full.mockRestore()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(JSON.parse(store.getItem('matrix-account')!)).toMatchObject({
        accessToken: 'held-access',
        refreshToken: 'held-refresh',
        storageKey: Buffer.alloc(32, 1).toString('base64')
      })
      expect(log).toHaveBeenCalledWith({ event: 'credential_saved', client: 'matrix' })
      expect(renewed).toHaveBeenCalledWith('matrix')

      // The engine's next refresh rotates from the pair saved, never from the spent one.
      vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'next-access', refresh_token: 'next-refresh' } as never)
      expect(await account.refresh(handle)).toMatchObject({ ok: true, accessToken: 'next-access' })
      expect(vi.mocked(oidc.refreshTokenGrant).mock.calls.at(-1)?.[1]).toBe('held-refresh')
      expect(oidc.tokenRevocation).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('a crash before the held rotation is saved loses nothing: the next launch rotates from the saved grant', async () => {
    const { store } = fixture()
    const account = new MatrixAccount(config, store, async () => {})
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'lost-access', refresh_token: 'lost-refresh' } as never)

    const full = vi.spyOn(store, 'setItem').mockImplementation(() => {
      throw new Error('auth_storage_write_failed')
    })

    expect((await account.refresh(account.sdkConfiguration().refreshToken)).ok).toBe(false)
    full.mockRestore()

    // A kernel panic here (the mini, 18:15:34Z): the held pair is gone with the process. It was
    // never used, so MAS takes the saved refresh token once more (token.rs:672-761).
    const relaunched = new MatrixAccount(config, store, async () => {})
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'again-access', refresh_token: 'again-refresh' } as never)
    expect(await relaunched.refresh(relaunched.sdkConfiguration().refreshToken)).toMatchObject({
      ok: true,
      accessToken: 'again-access'
    })
    expect(vi.mocked(oidc.refreshTokenGrant).mock.calls.at(-1)?.[1]).toBe('synthetic-refresh')
    expect(JSON.parse(store.getItem('matrix-account')!).refreshToken).toBe('again-refresh')
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
  })
  it('never writes an older token back: the vault and the engine agree on the newest grant after a held one lands', async () => {
    vi.useFakeTimers()

    try {
      const { store } = fixture()
      const account = new MatrixAccount(config, store, async () => {})
      const handle = account.sdkConfiguration().refreshToken
      const saved = () => JSON.parse(store.getItem('matrix-account')!)
      // The first rotation can't be saved; it expires before the disk has room.
      vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
        access_token: 'first-access',
        refresh_token: 'first-refresh',
        expires_in: 1
      } as never)
      vi.spyOn(store, 'setItem').mockImplementationOnce(() => {
        throw new Error('auth_storage_write_failed')
      })
      expect((await account.refresh(handle)).ok).toBe(false)

      // Room again before the retry: the engine's next refresh saves the held pair, finds it
      // expired and rotates from it, never from the spent one.
      vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
        access_token: 'second-access',
        refresh_token: 'second-refresh',
        expires_in: 300
      } as never)
      await vi.advanceTimersByTimeAsync(500)
      expect(await account.refresh(handle)).toMatchObject({ ok: true, accessToken: 'second-access' })
      expect(vi.mocked(oidc.refreshTokenGrant).mock.calls.at(-1)?.[1]).toBe('first-refresh')
      expect(saved()).toMatchObject({ accessToken: 'second-access', refreshToken: 'second-refresh' })

      // Every retry that was due passes: none of them writes the first pair back.
      await vi.advanceTimersByTimeAsync(180_000)
      expect(saved()).toMatchObject({ accessToken: 'second-access', refreshToken: 'second-refresh' })
      expect(account.sdkConfiguration().accessToken).toBe('second-access')
    } finally {
      vi.useRealTimers()
    }
  })
  it('makes room for a save on a full disk from the reserve, so the rotation lands at once', async () => {
    const log = vi.fn()
    const { store } = fixture()
    const reserve = { ensure: vi.fn(), release: vi.fn(() => true) }
    const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log, { reserve })
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'roomy-access', refresh_token: 'roomy-refresh' } as never)

    vi.spyOn(store, 'setItem').mockImplementationOnce(() => {
      vi.spyOn(store, 'failureCode').mockReturnValueOnce('auth_storage_disk_full')
      throw new Error('auth_storage_disk_full')
    })

    expect(await account.refresh(account.sdkConfiguration().refreshToken)).toMatchObject({
      ok: true,
      accessToken: 'roomy-access'
    })
    expect(reserve.release).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith({ event: 'disk_reserve_used' })
    expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'credential_save_failed' }))
    expect(JSON.parse(store.getItem('matrix-account')!).refreshToken).toBe('roomy-refresh')
    // Kept made again after a save that lands (the reserve decides when).
    expect(reserve.ensure).toHaveBeenCalled()
  })
  it('names a save that failed for any other reason the vault, not a full disk, and keeps the reserve', async () => {
    const log = vi.fn()
    const { store } = fixture()
    const reserve = { ensure: vi.fn(), release: vi.fn(() => true) }
    const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log, { reserve })
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'denied-access', refresh_token: 'denied-refresh' } as never)

    // A permission or I/O error: freeing space fixes nothing, so the window must not say so.
    vi.spyOn(store, 'setItem').mockImplementationOnce(() => {
      vi.spyOn(store, 'failureCode').mockReturnValueOnce('auth_storage_write_failed')
      throw new Error('auth_storage_write_failed')
    })

    expect(await account.refresh(account.sdkConfiguration().refreshToken)).toEqual({
      ok: false,
      reauthenticate: false,
      cause: 'vault'
    })
    expect(reserve.release).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith({ event: 'credential_save_failed', client: 'matrix', code: 'auth_storage_write_failed' })
  })
  it('tries once more at quit: saves a held rotation when it can, and logs it when the disk is still full', async () => {
    const log = vi.fn()
    const { store } = fixture()
    const full = new MatrixAccount(config, store, async () => {}, undefined, undefined, log)
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({ access_token: 'full-access', refresh_token: 'full-refresh' } as never)

    const disk = vi.spyOn(store, 'setItem').mockImplementation(() => {
      throw new Error('auth_storage_write_failed')
    })

    expect((await full.refresh(full.sdkConfiguration().refreshToken)).ok).toBe(false)
    log.mockClear()
    await full.close(async () => {})
    expect(log).toHaveBeenCalledWith({ event: 'credential_save_failed', client: 'matrix', code: expect.any(String) })
    disk.mockRestore()
    // The saved grant is still the one to rotate from.
    expect(JSON.parse(store.getItem('matrix-account')!).refreshToken).toBe('synthetic-refresh')

    const quitting = new MatrixAccount(config, store, async () => {}, undefined, undefined, log)
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({ access_token: 'kept-access', refresh_token: 'kept-refresh' } as never)
    vi.spyOn(store, 'setItem').mockImplementationOnce(() => {
      throw new Error('auth_storage_write_failed')
    })
    expect((await quitting.refresh(quitting.sdkConfiguration().refreshToken)).ok).toBe(false)
    await quitting.close(async () => {})
    expect(JSON.parse(store.getItem('matrix-account')!).refreshToken).toBe('kept-refresh')
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
  })
  it('treats a vault it cannot read after a rotation as the same account: held, saved once readable, never revoked', async () => {
    vi.useFakeTimers()

    try {
      const { account, store } = fixture()
      const owner = account.identity()!
      const handle = account.sdkConfiguration().refreshToken
      const retained = store.getItem('matrix-account')
      vi.mocked(oidc.refreshTokenGrant).mockImplementationOnce(async () => {
        vi.spyOn(store, 'failureCode').mockReturnValueOnce('auth_storage_read_failed')

        return { access_token: 'unread-access', refresh_token: 'unread-refresh' } as never
      })
      expect(await account.refresh(handle)).toEqual({ ok: false, reauthenticate: false, cause: 'vault' })
      // Refresh failure itself never deletes keys, and an unreadable vault is not a sign-out.
      expect(store.getItem('matrix-account')).toBe(retained)
      expect(oidc.tokenRevocation).not.toHaveBeenCalled()
      expect(account.identity()).toEqual(owner)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(JSON.parse(store.getItem('matrix-account')!).refreshToken).toBe('unread-refresh')
      // The next rotation starts from the pair it saved.
      vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'next-access', refresh_token: 'next-refresh' } as never)
      expect(await account.refresh(handle)).toMatchObject({ ok: true, accessToken: 'next-access' })
      expect(vi.mocked(oidc.refreshTokenGrant).mock.calls.at(-1)?.[1]).toBe('unread-refresh')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the end of a chat session ', () => {
  const refused = (code: string) =>
    new oidc.ResponseBodyError(code, { cause: { error: code }, response: new Response('', { status: 400 }) })

  function logged() {
    const log = vi.fn()
    const { store, file } = fixture()

    return { log, store, file, account: new MatrixAccount(config, store, async () => {}, undefined, undefined, log) }
  }

  it.each(['invalid_grant'] as const)(
    'ends only when the sign-in server refuses the grant (%s): nothing revoked, the account kept and marked',
    async code => {
      const { account, store, log } = logged()
      const before = JSON.parse(store.getItem('matrix-account')!)
      vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(refused(code))

      expect(await account.refresh(account.sdkConfiguration().refreshToken)).toEqual({
        ok: false,
        reauthenticate: true,
        cause: 'session_ended'
      })
      expect(account.identity()).toBeNull()
      expect(account.signOutPending()).toBe(false)
      expect(account.sessionEnded()).toMatchObject({ cause: `refresh_rejected:${code}` })
      expect(oidc.tokenRevocation).not.toHaveBeenCalled()
      // Keys, tokens and everything else stay for the same person's next sign-in.
      expect(JSON.parse(store.getItem('matrix-account')!)).toEqual({
        ...before,
        sessionEnded: { cause: `refresh_rejected:${code}`, at: expect.any(Number) }
      })
      expect(log).toHaveBeenCalledWith({ event: 'session_ended', client: 'matrix', cause: `refresh_rejected:${code}` })

      // A restart opens on the sign-in and asks the server nothing.
      const restarted = new MatrixAccount(config, store, async () => {})
      vi.mocked(oidc.refreshTokenGrant).mockClear()
      expect(restarted.identity()).toBeNull()
      expect(restarted.sessionEnded()).toMatchObject({ cause: `refresh_rejected:${code}` })
      expect(() => restarted.sdkConfiguration()).toThrow('matrix_signed_out')
      expect(await restarted.confirmSession()).toEqual({ ok: false, reauthenticate: true, cause: 'session_ended' })
      expect(oidc.refreshTokenGrant).not.toHaveBeenCalled()
    }
  )

  it("an app the sign-in server doesn't recognise (invalid_client) ends nothing: logged with its code, asked again", async () => {
    const { account, store, log } = logged()
    const retained = store.getItem('matrix-account')
    const handle = account.sdkConfiguration().refreshToken
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(refused('invalid_client'))

    expect(await account.refresh(handle)).toEqual({ ok: false, reauthenticate: false, cause: 'refused' })
    expect(account.identity()).not.toBeNull()
    expect(account.sessionEnded()).toBeNull()
    expect(store.getItem('matrix-account')).toBe(retained)
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith({ event: 'refresh_unavailable', client: 'matrix', cause: 'refused', oauth: 'invalid_client' })

    // The server's configuration is back: the same grant rotates as usual.
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'back-access', refresh_token: 'back-refresh' } as never)
    expect(await account.refresh(handle)).toMatchObject({ ok: true, accessToken: 'back-access' })
  })

  it('still ends the session in this run when the vault cannot take the mark', async () => {
    const { account, store } = logged()
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(refused('invalid_grant'))
    vi.spyOn(store, 'setItem').mockImplementation(() => {
      throw new Error('auth_storage_write_failed')
    })

    expect((await account.refresh(account.sdkConfiguration().refreshToken)).ok).toBe(false)
    expect(account.identity()).toBeNull()
    expect(account.sessionEnded()).toMatchObject({ cause: 'refresh_rejected:invalid_grant' })
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
  })

  it.each([
    ['the network', () => new TypeError('fetch failed'), 'transport', undefined],
    ['a timeout', () => Object.assign(new Error('operation timed out'), { code: 'OAUTH_TIMEOUT' }), 'transport', undefined],
    [
      'a 5xx',
      () =>
        Object.assign(new Error('unexpected HTTP response status code'), {
          code: 'OAUTH_RESPONSE_IS_NOT_CONFORM',
          cause: new Response('', { status: 502 })
        }),
      '5xx',
      undefined
    ],
    ['another refusal', () => refused('temporarily_unavailable'), 'refused', 'temporarily_unavailable']
  ] as const)('a passing failure (%s) never ends, revokes or clears anything, and is one log line', async (_name, error, cause, oauth) => {
    const { account, store, log } = logged()
    const owner = account.identity()
    const retained = store.getItem('matrix-account')
    const handle = account.sdkConfiguration().refreshToken
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValue(error())

    expect(await account.refresh(handle)).toEqual({ ok: false, reauthenticate: false, cause })
    expect(await account.refresh(handle)).toEqual({ ok: false, reauthenticate: false, cause })
    expect(account.identity()).toEqual(owner)
    expect(account.sessionEnded()).toBeNull()
    expect(store.getItem('matrix-account')).toBe(retained)
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
    expect(log.mock.calls).toEqual([[{ event: 'refresh_unavailable', client: 'matrix', cause, ...(oauth ? { oauth } : {}) }]])

    // Back again: the next rotation lands as usual.
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({ access_token: 'back-access', refresh_token: 'back-refresh' } as never)
    expect((await account.refresh(handle)).ok).toBe(true)
    expect(JSON.parse(store.getItem('matrix-account')!).refreshToken).toBe('back-refresh')
  })

  it("a sign-in server it can't discover is a passing failure too", async () => {
    const { account, log } = logged()
    vi.mocked(oidc.discovery).mockRejectedValueOnce(new Error('offline'))

    expect(await account.refresh(account.sdkConfiguration().refreshToken)).toEqual({
      ok: false,
      reauthenticate: false,
      cause: 'discovery'
    })
    expect(account.identity()).not.toBeNull()
    expect(log).toHaveBeenCalledWith({ event: 'refresh_unavailable', client: 'matrix', cause: 'discovery' })
  })

  it('revokes a rotation that lands after the account was signed out, saying why', async () => {
    const { account, store, log } = logged()
    let finish!: (value: unknown) => void
    vi.mocked(oidc.refreshTokenGrant).mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        }) as never
    )
    const refresh = account.refresh(account.sdkConfiguration().refreshToken)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    store.removeItem('matrix-account')
    finish({ access_token: 'orphan-access', refresh_token: 'orphan-refresh' })

    expect(await refresh).toEqual({ ok: false, reauthenticate: true, cause: 'signed_out' })
    expect(oidc.tokenRevocation).toHaveBeenCalledWith(expect.anything(), 'orphan-refresh', expect.anything())
    expect(log).toHaveBeenCalledWith({ event: 'grant_revoked', client: 'matrix', reason: 'account_changed' })
  })
})

describe('signing out on purpose', () => {
  it('still revokes every grant, and logs the person signing out with the result', async () => {
    const log = vi.fn()
    const { store } = fixture()
    const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log)

    await account.signOut()
    expect(oidc.tokenRevocation).toHaveBeenCalledWith(expect.anything(), 'synthetic-refresh', expect.anything())
    expect(oidc.tokenRevocation).toHaveBeenCalledWith(expect.anything(), 'synthetic-access', expect.anything())
    expect(store.getItem('matrix-account')).toBeNull()
    expect(log.mock.calls.map(([event]) => event)).toEqual([
      { event: 'grant_revoked', client: 'matrix', reason: 'user_sign_out' },
      { event: 'user_sign_out', result: 'completed' }
    ])
  })

  it('revokes the live tokens of a rotation the vault could not save, with the spent ones', async () => {
    const { store } = fixture()
    const account = new MatrixAccount(config, store, async () => {})
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({ access_token: 'live-access', refresh_token: 'live-refresh' } as never)
    const write = store.setItem.bind(store)

    // The rotation never fits in the vault; everything else does.
    vi.spyOn(store, 'setItem').mockImplementation((key, value) => {
      if (key === 'matrix-account' && value.includes('live-refresh')) {
        throw new Error('auth_storage_write_failed')
      }

      write(key, value)
    })

    expect((await account.refresh(account.sdkConfiguration().refreshToken)).ok).toBe(false)

    await account.signOut()
    // The held pair is the session at the sign-in server: revoking only the spent, saved pair
    // would be answered 200 and end nothing (revoke.rs:184-193).
    expect(oidc.tokenRevocation).toHaveBeenCalledWith(expect.anything(), 'live-refresh', expect.anything())
    expect(oidc.tokenRevocation).toHaveBeenCalledWith(expect.anything(), 'live-access', expect.anything())
    expect(oidc.tokenRevocation).toHaveBeenCalledWith(expect.anything(), 'synthetic-refresh', expect.anything())
    expect(store.getItem('matrix-account')).toBeNull()
  })

  it('saves a held rotation into the record first when the vault takes it again, and revokes that', async () => {
    const { store } = fixture()
    const account = new MatrixAccount(config, store, async () => {})
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({ access_token: 'live-access', refresh_token: 'live-refresh' } as never)

    const disk = vi.spyOn(store, 'setItem').mockImplementationOnce(() => {
      throw new Error('auth_storage_write_failed')
    })

    expect((await account.refresh(account.sdkConfiguration().refreshToken)).ok).toBe(false)
    disk.mockRestore()

    await account.signOut()
    expect(oidc.tokenRevocation).toHaveBeenCalledWith(expect.anything(), 'live-refresh', expect.anything())
    expect(oidc.tokenRevocation).toHaveBeenCalledWith(expect.anything(), 'live-access', expect.anything())
    expect(store.getItem('matrix-account')).toBeNull()
  })

  it('logs a sign-out that could not finish, with its closed code and no token', async () => {
    const log = vi.fn()
    const { store } = fixture()
    const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log)
    vi.mocked(oidc.tokenRevocation).mockRejectedValueOnce(new Error('network down: synthetic-refresh'))

    await expect(account.signOut()).rejects.toThrow()
    expect(log).toHaveBeenLastCalledWith({ event: 'user_sign_out', result: 'pending', code: 'unexpected' })
    expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-')
  })
})

describe('the owner time zone on the Matrix roster read', () => {
  function installAgentsFetch(ack?: string) {
    const requests: Array<{ path: string; timeZone: string | null }> = []

    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push({ path: url.pathname, timeZone: request.headers.get('atum-time-zone') })

      if (url.pathname !== '/agents') {
        return new Response(null, { status: 404 })
      }

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          ...(ack ? { 'Atum-Time-Zone-Ack': ack } : {})
        }
      })
    })

    vi.stubGlobal('fetch', fetch)

    return { fetch, requests }
  }

  it('reports on the first roster read, records the matching ack, and stays quiet after it', async () => {
    const { account, store } = ownerReaderFixture()
    vi.mocked(currentIanaTimeZone).mockReturnValue('Asia/Ho_Chi_Minh')
    const network = installAgentsFetch('Asia/Ho_Chi_Minh')

    await expect(account.agents(new AbortController().signal)).resolves.toEqual([])
    expect(network.requests).toEqual([{ path: '/agents', timeZone: 'Asia/Ho_Chi_Minh' }])
    expect(store.keys('matrix-owner-time-zone')).toHaveLength(1)

    await account.agents(new AbortController().signal)
    expect(network.requests[1]).toEqual({ path: '/agents', timeZone: null })
  })

  it('offers the acknowledged zone to a new routine’s default, and nothing before an ack', async () => {
    const { account } = ownerReaderFixture()
    vi.mocked(currentIanaTimeZone).mockReturnValue('Asia/Tokyo')
    installAgentsFetch('Asia/Tokyo')

    expect(account.ownerTimeZone()).toBeUndefined()
    await account.agents(new AbortController().signal)
    expect(account.ownerTimeZone()).toBe('Asia/Tokyo')
  })

  it('reports again when the Mac zone changed, and not when the ack was absent or different', async () => {
    const { account } = ownerReaderFixture()
    vi.mocked(currentIanaTimeZone).mockReturnValue('Asia/Ho_Chi_Minh')

    installAgentsFetch()
    await account.agents(new AbortController().signal)

    vi.mocked(currentIanaTimeZone).mockReturnValue('Europe/Berlin')
    const changed = installAgentsFetch('Europe/Berlin')
    await account.agents(new AbortController().signal)
    expect(changed.requests[0]?.timeZone).toBe('Europe/Berlin')

    const quiet = installAgentsFetch()
    await account.agents(new AbortController().signal)
    expect(quiet.requests[0]?.timeZone).toBeNull()

    vi.mocked(currentIanaTimeZone).mockReturnValue('Asia/Tokyo')
    const mismatch = installAgentsFetch('Europe/Berlin')
    await account.agents(new AbortController().signal)
    expect(mismatch.requests[0]?.timeZone).toBe('Asia/Tokyo')
    const stillUnacked = installAgentsFetch()
    await account.agents(new AbortController().signal)
    expect(stillUnacked.requests[0]?.timeZone).toBe('Asia/Tokyo')
  })

  it('sends no header for an invalid or undefined device zone', async () => {
    const { account, store } = ownerReaderFixture()
    const network = installAgentsFetch()

    vi.mocked(currentIanaTimeZone).mockReturnValue(undefined)
    await account.agents(new AbortController().signal)
    vi.mocked(currentIanaTimeZone).mockReturnValue('+07:00')
    await account.agents(new AbortController().signal)

    expect(network.requests.map(request => request.timeZone)).toEqual([null, null])
    expect(store.keys('matrix-owner-time-zone')).toEqual([])
  })

  it('keeps each account’s acknowledged zone across a switch', async () => {
    const { account, store } = ownerReaderFixture()
    vi.mocked(currentIanaTimeZone).mockReturnValue('Asia/Ho_Chi_Minh')
    const first = JSON.parse(store.getItem('matrix-account')!)

    installAgentsFetch('Asia/Ho_Chi_Minh')
    await account.agents(new AbortController().signal)

    store.setItem(
      'matrix-account',
      JSON.stringify({
        ...first,
        subject: 'other-subject',
        userId: '@bob:test',
        deviceId: 'OTHER_DEVICE',
        domain: { ...first.domain, subject: 'other-subject', sessionId: 'other-domain-session' }
      })
    )
    const forB = installAgentsFetch('Asia/Ho_Chi_Minh')
    await account.agents(new AbortController().signal)
    expect(forB.requests[0]?.timeZone).toBe('Asia/Ho_Chi_Minh')

    store.setItem('matrix-account', JSON.stringify(first))
    const backToA = installAgentsFetch()
    await account.agents(new AbortController().signal)
    expect(backToA.requests[0]?.timeZone).toBeNull()
    expect(store.keys('matrix-owner-time-zone')).toHaveLength(2)
  })

  it('discards a delayed ack after the account switched', async () => {
    const { account, store } = ownerReaderFixture()
    vi.mocked(currentIanaTimeZone).mockReturnValue('Asia/Tokyo')
    let finish!: () => void

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(async input => {
        const request = input instanceof Request ? input : new Request(input)
        const url = new URL(request.url)

        if (url.pathname !== '/agents') {
          return new Response(null, { status: 404 })
        }

        await new Promise<void>(resolve => {
          finish = resolve
        })

        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'Atum-Time-Zone-Ack': 'Asia/Tokyo' }
        })
      })
    )

    const pending = account.agents(new AbortController().signal)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const switched = JSON.parse(store.getItem('matrix-account')!)
    store.setItem(
      'matrix-account',
      JSON.stringify({
        ...switched,
        subject: 'other-subject',
        userId: '@bob:test',
        deviceId: 'OTHER_DEVICE',
        domain: { ...switched.domain, subject: 'other-subject', sessionId: 'other-domain-session' }
      })
    )
    finish()

    await expect(pending).resolves.toEqual([])
    expect(store.keys('matrix-owner-time-zone')).toEqual([])
  })

  it('discards a delayed ack after sign-out and clears this account’s value', async () => {
    const { account, store } = ownerReaderFixture()
    vi.mocked(currentIanaTimeZone).mockReturnValue('Asia/Tokyo')

    installAgentsFetch('Asia/Tokyo')
    await account.agents(new AbortController().signal)
    expect(store.keys('matrix-owner-time-zone')).toHaveLength(1)

    let finish!: () => void
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(async input => {
        const request = input instanceof Request ? input : new Request(input)
        const url = new URL(request.url)

        if (url.pathname !== '/agents') {
          return new Response(null, { status: 404 })
        }

        await new Promise<void>(resolve => {
          finish = resolve
        })

        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'Atum-Time-Zone-Ack': 'Asia/Tokyo' }
        })
      })
    )

    const pending = account.agents(new AbortController().signal)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const out = account.signOut()
    finish()

    await expect(pending).resolves.toEqual([])
    await out
    expect(store.keys('matrix-owner-time-zone')).toEqual([])
  })

  it('reads and changes the owner\'s coarse location through the one owner route', async () => {
    const { account } = ownerReaderFixture()
    const calls: Array<{ method: string; path: string; body: string | null; authorization: string | null }> = []
    let answer: unknown = { enabled: true, city: 'Ho Chi Minh City', region: 'Ho Chi Minh', country: 'VN' }

    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      calls.push({ method: request.method, path: url.pathname,
        body: request.method === 'PUT' ? await request.text() : null, authorization: request.headers.get('authorization') })
      return Response.json(answer)
    }))

    await expect(account.ownerLocation()).resolves.toEqual({ enabled: true, city: 'Ho Chi Minh City', region: 'Ho Chi Minh', country: 'VN' })
    answer = { enabled: false }
    await expect(account.setOwnerLocationEnabled(false)).resolves.toEqual({ enabled: false })
    expect(calls.map(call => [call.method, call.path])).toEqual([
      ['GET', '/owner-location'], ['PUT', '/owner-location']
    ])
    expect(JSON.parse(calls[1]!.body!)).toEqual({ enabled: false })
    expect(calls.every(call => call.authorization === 'Bearer synthetic-domain-access')).toBe(true)
  })

  it('refuses a location view with an open key, a non-boolean switch or a non-OK response', async () => {
    const { account } = ownerReaderFixture()

    for (const [answer, status] of [
      [{ enabled: true, city: 'Hanoi', source: 'edge' }, 200],
      [{ enabled: 'yes' }, 200],
      [{ enabled: true }, 500]
    ] as const) {
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => Response.json(answer, { status })))
      await expect(account.ownerLocation()).rejects.toThrow('matrix_owner_location_unavailable')
    }
  })
})

describe('relay publication bearer repair', () => {
  it.each([false, true])('refreshes once on 401 (repeat rejection: %s)', async repeat => {
    const { account, store } = ownerReaderFixture()
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({ access_token: 'fresh-domain-access', refresh_token: 'fresh-domain-refresh' } as never)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'enabled' }), {
        status: repeat ? 401 : 200, headers: { 'content-type': 'application/json' }
      }))
    vi.stubGlobal('fetch', fetch)
    const signal = AbortSignal.timeout(10_000)
    const result = account.s1Request((token, resource) =>
      requestMatrixChatGptRelay(resource, token, 'enable', signal, { requestId: 'same-request' }), signal)
    if (repeat) {await expect(result).rejects.toThrow('matrix_s1_authentication')}
    else {await expect(result).resolves.toEqual({ status: 200, value: { state: 'enabled' } })}
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls.map(([, init]) => (init?.headers as Record<string, string>).Authorization))
      .toEqual(['Bearer synthetic-domain-access', 'Bearer fresh-domain-access'])
    expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body)
    expect(store.getItem('matrix-account')).toBeTruthy()
  })
})

it('bounds S1 credential/send waits and passes cancellation to the transport', async () => {
  vi.useFakeTimers()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const abort = new AbortController()
    setTimeout(() => abort.abort(new Error('fixture deadline')), ms)
    return abort.signal
  })
  try {
    const { account } = ownerReaderFixture()
    let requestSignal: AbortSignal | undefined
    const result = account.s1Request(async (_token, _resource, signal) => {
      requestSignal = signal
      return new Promise(() => {})
    }, new AbortController().signal)
    const rejected = expect(result).rejects.toThrow('fixture deadline')
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    expect(timeout).toHaveBeenCalledWith(15_000)
    expect(requestSignal?.aborted).toBe(true)
  } finally { timeout.mockRestore(); vi.useRealTimers() }
})
