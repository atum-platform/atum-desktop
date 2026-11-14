import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as oidc from 'openid-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isDefinitiveCompanyRefusal } from '../../shared/matrix-company-team-space'
import { EncryptedStore } from '../encrypted-store'

import { MatrixAccount, type MatrixAccountHooks } from './account'
import { MatrixAgentContent } from './agent-content'
import { MatrixAgentRuntime } from './agent-runtime'
import { authorizeNative, type NativeGrant } from './authorization'
import { matrixConfigurationKey, parseMatrixConfig } from './config'
import { MatrixContinuousListening } from './continuous-listening'
import { ensureDomainAssistant, readDomainIdentity } from './domain'
import type * as DomainModule from './domain'
import type * as EnrollmentModule from './enrollment'
import {
  MatrixEnrollmentRateLimited,
  requestAgentIdentity,
  requestAppTurn,
  requestEnrollment,
  requestLease,
  requestLocalEnrollmentCapabilities
} from './enrollment'
import { MatrixGoogleFenceNotices } from './google-fence'
import { MatrixExecutorLease } from './lease'
import { matrixMainAgentContentTarget } from './main-agent-content'
import { handleMatrixCompanyCommand } from './main-company'
import { readMatrixAgentPresentation } from './main-enrollment'
import { boundSdkConfiguration } from './sdk-host'

vi.mock('./authorization', () => ({ authorizeNative: vi.fn() }))
vi.mock('./domain', async importOriginal => ({
  ...(await importOriginal<typeof DomainModule>()),
  readDomainIdentity: vi.fn(),
  ensureDomainAssistant: vi.fn()
}))
vi.mock('./enrollment', async importOriginal => ({
  ...(await importOriginal<typeof EnrollmentModule>()),
  requestEnrollment: vi.fn(),
  requestAppTurn: vi.fn(),
  requestAgentIdentity: vi.fn(),
  requestLease: vi.fn(),
  requestLocalEnrollmentCapabilities: vi.fn()
}))
vi.mock('openid-client', () => ({
  discovery: vi.fn(async (_url, clientId) => ({ clientId })),
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
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

const config = {
  issuer: 'https://id.test/',
  server: 'https://matrix.test',
  nativeClientId: 'matrix',
  callbackPort: 21881,
  domain: { nativeClientId: 'domain', resource: 'https://api.test' }
}

const identity = { issuer: config.issuer, subject: 'alice', principal: '12345678-1234-1234-1234-123456789abc' }
const grant = { issuer: config.issuer, subject: 'alice', accessToken: 'domain-access', refreshToken: 'domain-refresh' }

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

function fixture(connected = true, hooks?: MatrixAccountHooks) {
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-domain-test-'))
  directories.push(directory)

  const store = new EncryptedStore(path.join(directory, 'vault.json'), {
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
      subject: 'alice',
      userId: '@alice:test',
      deviceId: 'A',
      storageKey: Buffer.alloc(32, 1).toString('base64'),
      accessToken: 'matrix-access',
      refreshToken: 'matrix-refresh',
      ...(connected ? { domain: { ...grant, sessionId: 'domain-session' } } : {})
    })
  )
  vi.mocked(readDomainIdentity).mockResolvedValue(identity)
  vi.mocked(ensureDomainAssistant).mockResolvedValue({
    agentPrincipal: '22345678-1234-1234-1234-123456789abc',
    matrixUser: '@hermes:test'
  })
  vi.mocked(requestLocalEnrollmentCapabilities).mockResolvedValue(false)
  vi.mocked(requestEnrollment).mockImplementation(async (_resource, _grant, executorId, method) =>
    method === 'DELETE'
      ? null
      : {
          ...identity,
          executorId,
          agentPrincipal: '22345678-1234-1234-1234-123456789abc',
          userId: '@hermes:test',
          deviceId: 'AGENT',
          accessToken: 'agent-only',
          expiresAt: Date.now() + 3600000
        }
  )
  const open = vi.fn(async () => {})
  const clearLocalHermes = vi.fn(async (_home: string) => {})
  const clearAppDevice = vi.fn(async (_slug: string, _identity: { userId: string; deviceId: string }) => {})
  const account = new MatrixAccount(config, store, open, clearLocalHermes, clearAppDevice, undefined, hooks)
  const read = () => JSON.parse(store.getItem('matrix-account')!)

  return { directory, store, account, read, open, clearLocalHermes, clearAppDevice }
}

it('keeps normal S1 budgets short but gives host Stop its 40-second deadline', async () => {
  const f = fixture()
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  try {
    const send = vi.fn(async (_token: string, _resource: string, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false)
      return 'received'
    })
    await expect(f.account.s1Request(send, new AbortController().signal)).resolves.toBe('received')
    expect(timeout).toHaveBeenCalledWith(15_000)
    timeout.mockClear()
    await expect(f.account.s1Request(send, new AbortController().signal, { timeoutMs: 40_000 })).resolves.toBe('received')
    expect(timeout).toHaveBeenCalledWith(40_000)
    expect(timeout).not.toHaveBeenCalledWith(15_000)
  } finally { timeout.mockRestore() }
})

const riverApp = {
  slug: 'river',
  appId: '00000000-0000-4000-8000-11e594f48195',
  appVersionId: '00000000-0000-4000-8000-dd7df1164681'
}

const moonApp = {
  slug: 'moon',
  appId: '00000000-0000-4000-8000-e79acd97ac88',
  appVersionId: '00000000-0000-4000-8000-5ba39b7cfa53'
}

function appFixture(hooks?: MatrixAccountHooks) {
  const f = fixture(true, hooks)
  const issue = vi.mocked(requestEnrollment).getMockImplementation()!
  vi.mocked(requestEnrollment).mockImplementation(async (resource, domainGrant, executorId, method, app) => {
    const common = await issue(resource, domainGrant, executorId, method)

    if (!app || method === 'DELETE') {
      return common
    }

    const selected = app.slug === 'river' ? riverApp : moonApp

    return {
      ...(common as object),
      ...selected,
      installationId: selected.appId,
      agentPrincipal: selected.appId,
      userId: `@${app.slug}:test`,
      deviceId: `APP-${app.slug}`,
      accessToken: `${app.slug}-only`,
      linkEpoch: 1
    }
  })

  return f
}

describe('native Matrix app participant custody', () => {
  it('rechecks the Google-local memory fence after acquiring the native grant', async () => {
    const { account } = fixture()
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    const permitted = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)

    await expect(
      account.writeAgentMemory(
        '00000000-0000-4000-8000-eb4b9770929a',
        { expected_revision: 1, enabled: true, snapshot: { memory: ['Local'], user: [] } },
        new AbortController().signal,
        permitted
      )
    ).rejects.toMatchObject({ code: 'denied' })
    expect(permitted).toHaveBeenCalledTimes(2)
    expect(request).not.toHaveBeenCalled()
  })

  it('validates initializer authority against the live native agent enrollment', async () => {
    const f = fixture()
    await f.account.enrollHermes()
    const identity = f.account.enrollment().identity!

    const response = {
      executorId: identity.executorId,
      agentPrincipal: identity.agentPrincipal,
      userId: identity.userId,
      deviceId: identity.deviceId,
      initializer: true
    }

    vi.mocked(requestAgentIdentity).mockResolvedValue(response)
    expect(await f.account.agentIdentity(identity.executorId)).toBe(true)
    vi.mocked(requestAgentIdentity).mockResolvedValue({ ...response, initializer: false })
    expect(await f.account.agentIdentity(identity.executorId)).toBe(false)

    for (const patch of [
      { userId: '@foreign:test' },
      { deviceId: 'OTHER' },
      { agentPrincipal: 'foreign' },
      { executorId: 'foreign' },
      { initializer: 'true' }
    ]) {
      vi.mocked(requestAgentIdentity).mockResolvedValue({ ...response, ...patch })
      await expect(f.account.agentIdentity(identity.executorId)).rejects.toThrow('invalid')
    }

    const pending = deferred<unknown>()
    vi.mocked(requestAgentIdentity).mockReturnValueOnce(pending.promise)
    const claim = f.account.agentIdentity(identity.executorId)
    await vi.waitFor(() => expect(requestAgentIdentity).toHaveBeenCalledTimes(8))
    const record = f.read()
    f.store.setItem(
      'matrix-account',
      JSON.stringify({ ...record, enrollment: { ...record.enrollment, state: 'revoking' } })
    )
    pending.resolve(response)
    await expect(claim).rejects.toThrow('stale')
  })

  it('requires explicit disclosure and a native app/version selection', () => {
    const { account } = appFixture()
    expect(() => account.enrollApp(riverApp, false as true)).toThrow('matrix_disclosure_required')
    expect(() => account.enrollApp({ ...riverApp, slug: undefined as never }, true)).toThrow(
      'matrix_enrollment_invalid'
    )
    expect(() => account.enrollApp({ ...riverApp, slug: '../local-hermes' }, true)).toThrow('matrix_enrollment_invalid')
    expect(requestEnrollment).not.toHaveBeenCalled()
  })

  it('isolates human, Hermes and two app credentials/keys, including restart and exact host binding', async () => {
    const f = appFixture()

    const [hermes, river, moon] = await Promise.all([
      f.account.enrollHermes(),
      f.account.enrollApp(riverApp, true),
      f.account.enrollApp(moonApp, true)
    ])

    const configs = [
      f.account.sdkConfiguration(),
      f.account.agentSdkConfiguration(),
      f.account.agentSdkConfiguration('river'),
      f.account.agentSdkConfiguration('moon')
    ]

    expect(new Set(configs.map(value => value.storageKey)).size).toBe(4)
    expect(new Set(configs.map(value => value.accessToken)).size).toBe(4)
    expect(f.account.appEnrollments().sort()).toEqual(['moon', 'river'])
    expect(JSON.stringify([hermes, river, moon])).not.toMatch(/accessToken|storageKey|river-only|moon-only/)
    const retained = f.read().apps
    expect(retained.river.app).toEqual({
      ...riverApp,
      disclosedAt: expect.any(Number),
      ownerPrincipal: identity.principal
    })

    const restarted = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice)
    expect(restarted.agentSdkConfiguration('river')).toEqual(configs[2])
    expect(restarted.appEnrollment('river')).toEqual(river)
    expect(boundSdkConfiguration(restarted, 'app:river', river.identity!)).toEqual(configs[2])
    expect(() => boundSdkConfiguration(restarted, 'app:river', moon.identity!)).toThrow('matrix_sdk_identity_changed')
    expect(() => boundSdkConfiguration(restarted, 'agent', river.identity!)).toThrow('matrix_sdk_identity_changed')
    expect(() => boundSdkConfiguration(restarted, 'human', river.identity!)).toThrow('matrix_sdk_identity_changed')
    await restarted.close(async () => {})
    expect(f.read().apps).toEqual(retained)
    expect(f.clearAppDevice).not.toHaveBeenCalled()
  })

  it('withholds a late provider reply after withdrawal, without replaying it', async () => {
    const f = appFixture()
    await f.account.enrollApp(riverApp, true)
    let finish!: (value: { text: string }) => void
    vi.mocked(requestAppTurn).mockImplementationOnce(
      async () =>
        new Promise(resolve => {
          finish = resolve
        })
    )

    const input = {
      text: 'current only',
      mentionedUserIds: ['@river:test'],
      invocationId: 'turn',
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 30000
    }

    const pending = f.account.appTurn('river', input)
    await vi.waitFor(() => expect(requestAppTurn).toHaveBeenCalledOnce())
    await f.account.revokeApp('river')
    finish({ text: 'Late response' })
    await expect(pending).rejects.toThrow('matrix_invocation_cancelled')
    expect(requestAppTurn).toHaveBeenCalledOnce()
  })

  it('coalesces one app while refusing a concurrent different version even before intent is stored', async () => {
    const { account } = appFixture()
    const pending = account.enrollApp(riverApp, true)
    expect(account.enrollApp(riverApp, true)).toBe(pending)
    expect(() => account.enrollApp({ ...riverApp, appVersionId: moonApp.appVersionId }, true)).toThrow(
      'matrix_app_enrollment_changed'
    )
    await pending
    expect(requestEnrollment).toHaveBeenCalledOnce()
  })

  it('binds a retained credential to the saved owner principal, not its own principal claim', async () => {
    const f = appFixture()
    await f.account.enrollApp(riverApp, true)
    const record = f.read()
    record.apps.river.credential.principal = '00000000-0000-4000-8000-e8d95748107a'
    f.store.setItem('matrix-account', JSON.stringify(record))
    expect(() => f.account.appEnrollment('river')).toThrow('matrix_enrollment_invalid')
    expect(() => f.account.agentSdkConfiguration('river')).toThrow('matrix_enrollment_invalid')
  })

  it('coalesces complete withdrawals and strips stored credential/key synchronously', async () => {
    const f = appFixture()
    await f.account.enrollApp(riverApp, true)
    const first = f.account.revokeApp('river')
    expect(f.account.revokeApp('river')).toBe(first)
    expect(f.read().apps.river.credential).toBeUndefined()
    expect(f.read().apps.river.storageKey).toBeUndefined()
    expect(f.read().apps.river.cleanupIdentity).toEqual({ userId: '@river:test', deviceId: 'APP-river' })
    await first
    expect(requestEnrollment).toHaveBeenCalledTimes(2)
  })

  it('retries ambiguous issuance on the same executor/key after restart, without touching another app', async () => {
    const f = appFixture()
    await f.account.enrollApp(moonApp, true)
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new Error('lost response'))
    await expect(f.account.enrollApp(riverApp, true)).rejects.toThrow('lost response')
    const retained = f.read().apps
    expect(retained.river.state).toBe('pending')
    const restarted = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice)
    await restarted.enrollApp(riverApp, true)
    expect(f.read().apps.river).toMatchObject({
      executorId: retained.river.executorId,
      storageKey: retained.river.storageKey,
      app: retained.river.app
    })
    expect(f.read().apps.moon).toEqual(retained.moon)
  })

  it.each(['appId', 'appVersionId', 'subject', 'executorId', 'userId'])(
    'rejects an issuance with a foreign %s and drains it',
    async key => {
      const f = appFixture()
      const issue = vi.mocked(requestEnrollment).getMockImplementation()!
      vi.mocked(requestEnrollment).mockImplementationOnce(async (...args) => ({
        ...((await issue(...args)) as object),
        [key]: key === 'userId' ? '@alice:test' : 'foreign'
      }))
      await expect(f.account.enrollApp(riverApp, true)).rejects.toThrow('matrix_enrollment_invalid')
      expect(f.account.appEnrollment('river').state).toBe('absent')
      expect(requestEnrollment).toHaveBeenLastCalledWith(
        config.domain.resource,
        expect.anything(),
        expect.any(String),
        'DELETE',
        { slug: 'river' }
      )
    }
  )

  it('reports expiry without renewing consent or forgetting the exact device needing cleanup', async () => {
    const f = appFixture()
    await f.account.enrollApp(riverApp, true)
    const record = f.read()
    record.apps.river.credential.expiresAt = Date.now() - 1
    f.store.setItem('matrix-account', JSON.stringify(record))
    expect(f.account.appEnrollment('river').state).toBe('expired')
    expect(() => f.account.agentSdkConfiguration('river')).toThrow('matrix_agent_unavailable')
    await expect(f.account.enrollApp(riverApp, true)).rejects.toThrow('matrix_app_enrollment_changed')
    expect(requestEnrollment).toHaveBeenCalledOnce()
    await f.account.revokeApp('river')
    expect(f.clearAppDevice).toHaveBeenCalledWith('river', { userId: '@river:test', deviceId: 'APP-river' })
    expect(f.account.appEnrollment('river').state).toBe('absent')
  })

  it.each(['missing', 'malformed', 'human', 'other-app'])('never repairs or uses a %s app crypto key', async kind => {
    const f = appFixture()
    await f.account.enrollApp(riverApp, true)
    await f.account.enrollApp(moonApp, true)
    const record = f.read()
    record.apps.river.storageKey =
      kind === 'missing'
        ? undefined
        : kind === 'malformed'
          ? 'bad'
          : kind === 'human'
            ? record.storageKey
            : record.apps.moon.storageKey
    f.store.setItem('matrix-account', JSON.stringify(record))
    expect(() => f.account.agentSdkConfiguration('river')).toThrow('matrix_agent_key_invalid')
    expect(f.read().apps.river.storageKey).toBe(record.apps.river.storageKey)
  })

  it('closes and erases only the selected app before remote revoke; failures remain retryable after restart', async () => {
    const f = appFixture()
    await f.account.enrollApp(riverApp, true)
    await f.account.enrollApp(moonApp, true)
    const moon = f.read().apps.moon
    f.clearAppDevice.mockImplementationOnce(async () => {
      expect(f.read().apps.river).toMatchObject({
        state: 'revoking',
        cleanupIdentity: { userId: '@river:test', deviceId: 'APP-river' }
      })
      expect(f.read().apps.river.credential).toBeUndefined()
      expect(requestEnrollment).toHaveBeenCalledTimes(2)
      throw new Error('partition busy')
    })
    await expect(f.account.revokeApp('river')).rejects.toThrow('matrix_local_cleanup_pending')
    expect(requestEnrollment).toHaveBeenCalledTimes(3)
    expect(f.read().apps.river.cleanupIdentity).toBeDefined()
    expect(f.read().apps.moon).toEqual(moon)
    expect(() => f.account.agentSdkConfiguration('river')).toThrow('matrix_agent_unavailable')
    const restarted = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice)
    await restarted.revokeApp('river')
    expect(restarted.appEnrollment('river').state).toBe('absent')
    expect(f.clearAppDevice).toHaveBeenCalledTimes(2)
    expect(f.read().apps.moon).toEqual(moon)
  })

  it('retains failed remote revoke without secrets and blocks replacement until it drains', async () => {
    const f = appFixture()
    await f.account.enrollApp(riverApp, true)
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new Error('offline'))
    await expect(f.account.revokeApp('river')).rejects.toThrow('offline')
    expect(f.read().apps.river).toEqual({ executorId: expect.any(String), state: 'revoking', app: expect.anything() })
    await expect(f.account.enrollApp(riverApp, true)).rejects.toThrow('matrix_enrollment_revoke_pending')
    await f.account.revokeApp('river')
    expect(f.account.appEnrollments()).toEqual([])
  })

  it('withdrawal fences a pending domain read before issuance', async () => {
    const f = appFixture()
    const read = deferred<typeof identity>()
    vi.mocked(readDomainIdentity).mockReturnValueOnce(read.promise)
    const enrolling = f.account.enrollApp(riverApp, true).catch(error => error.message)
    const withdrawing = f.account.revokeApp('river')
    read.resolve(identity)
    expect(await enrolling).toBe('matrix_enrollment_revoke_pending')
    await withdrawing
    expect(requestEnrollment).not.toHaveBeenCalled()
  })

  it('withdrawal cannot accept a late issuance or affect a second app', async () => {
    const f = appFixture()
    await f.account.enrollApp(moonApp, true)
    const response = deferred<unknown>()
    const issue = vi.mocked(requestEnrollment).getMockImplementation()!
    let args!: Parameters<typeof requestEnrollment>
    vi.mocked(requestEnrollment).mockImplementationOnce((...input) => {
      args = input

      return response.promise
    })
    const enrolling = f.account.enrollApp(riverApp, true).catch(error => error.message)
    await vi.waitFor(() => expect(args).toBeDefined())
    const withdrawing = f.account.revokeApp('river')
    response.resolve(await issue(...args))
    expect(await enrolling).toBe('matrix_login_cancelled')
    await withdrawing
    expect(f.account.appEnrollment('river').state).toBe('absent')
    expect(f.account.appEnrollment('moon').state).toBe('ready')
  })

  it('sign-out revokes both app participants before discarding domain authority', async () => {
    const f = appFixture()
    await f.account.enrollApp(riverApp, true)
    await f.account.enrollApp(moonApp, true)
    const stopped = vi.fn(async () => {})
    f.clearAppDevice.mockImplementation(async () => {
      expect(stopped).toHaveBeenCalledOnce()
      expect(f.read().domain).toBeDefined()
    })
    await f.account.signOut(stopped)
    expect(f.clearAppDevice).toHaveBeenCalledTimes(2)
    expect(requestEnrollment).toHaveBeenCalledTimes(4)
    expect(f.account.identity()).toBeNull()
    expect(f.store.getItem('matrix-account')).toBeNull()
  })

  it('does not forget failed local app erasure on sign-out', async () => {
    const f = appFixture()
    await f.account.enrollApp(riverApp, true)
    f.clearAppDevice.mockRejectedValueOnce(new Error('busy'))
    await expect(f.account.signOut(async () => {})).rejects.toThrow('matrix_local_cleanup_pending')
    expect(f.read()).toMatchObject({
      signingOut: true,
      apps: { river: { state: 'revoking', cleanupIdentity: { userId: '@river:test', deviceId: 'APP-river' } } }
    })
    await f.account.signOut(async () => {})
    expect(f.store.getItem('matrix-account')).toBeNull()
  })

  it('attempts every app on sign-out even when the first participant cleanup fails', async () => {
    const f = appFixture()
    await f.account.enrollApp(riverApp, true)
    await f.account.enrollApp(moonApp, true)
    f.clearAppDevice.mockRejectedValueOnce(new Error('busy'))
    await expect(f.account.signOut(async () => {})).rejects.toThrow('matrix_local_cleanup_pending')
    expect(f.clearAppDevice.mock.calls.map(([slug]) => slug)).toEqual(['river', 'moon'])
    expect(Object.keys(f.read().apps)).toEqual(['river'])
    expect(f.read().apps.river.cleanupIdentity).toBeDefined()
    expect(requestEnrollment).toHaveBeenCalledTimes(4)
    await f.account.signOut(async () => {})
    expect(f.store.getItem('matrix-account')).toBeNull()
  })
})

describe('Matrix app resource authority', () => {
  it('keeps home migration disabled unless a bounded synthetic-agent list is configured', () => {
    const agent = '00000000-0000-4000-8000-d9f59d29173c'
    expect(parseMatrixConfig(config).cloudMigrationTestAgents).toBeUndefined()
    expect(parseMatrixConfig({ ...config, cloudMigrationTestAgents: [agent] }).cloudMigrationTestAgents).toEqual([agent])

    for (const cloudMigrationTestAgents of [true, ['not-a-principal'], [agent, agent], [agent, agent, agent]]) {
      expect(() => parseMatrixConfig({ ...config, cloudMigrationTestAgents })).toThrow('matrix_configuration_invalid')
    }
  })
  it.each([400, 403, 404, 409, 429, 503])(
    'classifies untyped HTTP %i without retrying permanent refusal',
    async status => {
      const { account } = fixture()
      const fetcher = vi.fn(async () => Response.json({ error: 'untyped refusal' }, { status }))
      vi.stubGlobal('fetch', fetcher)
      await expect(account.appRequest({ app: 'river', action: 'launch' })).rejects.toMatchObject({
        code: status === 429 ? 'rate_limited' : status >= 500 ? 'temporarily_unavailable' : 'app_unavailable'
      })
      expect(fetcher).toHaveBeenCalledOnce()
    }
  )
  it('keeps activation default-off and presentation gate outside partition identity', () => {
    expect(parseMatrixConfig(config).appWorkspace).toBeUndefined()
    expect(parseMatrixConfig({ ...config, appWorkspace: true }).appWorkspace).toBe(true)
    expect(() => parseMatrixConfig({ ...config, appWorkspace: 'true' })).toThrow()
    expect(matrixConfigurationKey({ ...config, appWorkspace: true })).toBe(matrixConfigurationKey(config))
  })
  it("enables Atum's model only with a domain, a TLS gateway and a valid fixed loopback port", () => {
    expect(parseMatrixConfig(config).managedModel).toBeUndefined()
    expect(parseMatrixConfig({ ...config, managedModel: { gateway: 'https://gateway.test/' } }).managedModel).toEqual({
      gateway: 'https://gateway.test',
      port: 21890
    })
    expect(
      parseMatrixConfig({ ...config, managedModel: { gateway: 'https://gateway.test', port: 30001 } }).managedModel
        ?.port
    ).toBe(30001)

    for (const managedModel of [
      { gateway: 'http://gateway.test' },
      { gateway: 'https://user:pass@gateway.test' },
      { gateway: 'https://gateway.test', port: 80 },
      { gateway: 'https://gateway.test', port: 1.5 },
      null
    ]) {
      expect(() => parseMatrixConfig({ ...config, managedModel })).toThrow()
    }

    const { domain: _domain, ...withoutDomain } = config
    expect(() => parseMatrixConfig({ ...withoutDomain, managedModel: { gateway: 'https://gateway.test' } })).toThrow()
    expect(
      matrixConfigurationKey(parseMatrixConfig({ ...config, managedModel: { gateway: 'https://gateway.test' } }))
    ).toBe(matrixConfigurationKey(parseMatrixConfig(config)))
  })
  it('negotiates app-panel only on the manifest read', async () => {
    const { account } = fixture()
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({}))
    vi.stubGlobal('fetch', fetcher)
    await account.appRequest({ app: 'river', action: 'manifest' })
    expect(fetcher).toHaveBeenCalledWith('https://api.test/apps/river/manifest', expect.objectContaining({
      method: 'GET', headers: expect.objectContaining({ 'Atum-App-Panel-Profile': 'atum.app-panel/1' })
    }))
    await account.appRequest({ app: 'river', action: 'launch' })
    expect(fetcher.mock.calls[1]?.[1]?.headers).not.toHaveProperty('Atum-App-Panel-Profile')
  })
  it('uses only the domain bearer on fixed endpoints; mutations are never replayed', async () => {
    const { account } = fixture()
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ apps: [] }))
    vi.stubGlobal('fetch', fetcher)
    const scope = account.appScope()
    await account.appRequest({})
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.test/apps',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer domain-access',
          Accept: 'application/json',
          'X-Atum-App-Catalog': '2',
          'X-Atum-Look-Pack': '1'
        },
        redirect: 'error'
      })
    )
    expect(scope?.accountKey).toMatch(/^[a-f0-9]{64}$/)
    await expect(account.appRequest({ app: '../escape', action: 'launch' })).rejects.toThrow('invalid')
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockRejectedValue(new Error('ambiguous response'))
    await expect(account.appRequest({ app: 'river', action: 'launch' }, { route_id: 'open' })).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(account.appScope()).toEqual(scope)
  })
  it('reads the optional look gallery with negotiation and treats 404 as not deployed', async () => {
    const { account } = fixture()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ profile: 'atum.look-gallery/1', items: [] }))
      .mockResolvedValueOnce(Response.json({ error: 'not_found' }, { status: 404 }))
    vi.stubGlobal('fetch', fetcher)

    await expect(account.lookGalleryRequest()).resolves.toEqual({ profile: 'atum.look-gallery/1', items: [] })
    await expect(account.lookGalleryRequest()).resolves.toBeNull()
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://api.test/looks/gallery',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer domain-access',
          Accept: 'application/json',
          'X-Atum-Look-Pack': '1'
        },
        redirect: 'error'
      })
    )
  })
  it('uses the domain bearer for fixed app intake reads and one-shot submissions', async () => {
    const { account } = fixture()
    const status = { complete: false, missing: ['preferred_name'], fields: [{ name: 'preferred_name', type: 'text' }] }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(status))
      .mockResolvedValueOnce(Response.json({ complete: true, missing: [], fields: [] }))
    vi.stubGlobal('fetch', fetcher)

    await expect(account.appIntakeRequest('moon', 'read')).resolves.toEqual(status)
    await expect(account.appIntakeRequest('moon', 'submit', { preferred_name: 'Minh' })).resolves.toMatchObject({ complete: true })

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://api.test/apps/moon/bot/intake',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer domain-access', Accept: 'application/json' },
        redirect: 'error'
      })
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://api.test/apps/moon/bot/intake',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer domain-access',
          Accept: 'application/json',
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify({ preferred_name: 'Minh' }),
        redirect: 'error'
      })
    )

    await expect(account.appIntakeRequest('../moon', 'read')).rejects.toThrow('matrix_app_invalid')
    await expect(account.appIntakeRequest('moon', 'submit', {})).rejects.toMatchObject({ code: 'intake_values_invalid' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('keeps only a validated field name from an app intake rejection', async () => {
    const { account } = fixture()
    const fetcher = vi.fn(async () => Response.json(
      { error: { code: 'upstream_copy_must_not_escape' }, field: 'preferred_name' },
      { status: 400 }
    ))
    vi.stubGlobal('fetch', fetcher)

    await expect(account.appIntakeRequest('moon', 'submit', { preferred_name: 'Minh' })).rejects.toMatchObject({
      code: 'app_surface_request_failed',
      details: { field: 'preferred_name' }
    })
  })
  it('distinguishes an absent intake endpoint from transient non-JSON failures', async () => {
    const { account } = fixture()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'not_found' }, { status: 404 }))
      .mockResolvedValueOnce(new Response('<html>gateway down</html>', {
        status: 503,
        headers: { 'content-type': 'text/html' }
      }))
    vi.stubGlobal('fetch', fetcher)

    await expect(account.appIntakeRequest('moon', 'read')).rejects.toMatchObject({
      code: 'app_surface_absent',
      status: 404
    })
    await expect(account.appIntakeRequest('moon', 'read')).rejects.toMatchObject({
      code: 'app_surface_unavailable',
      status: 503
    })
  })
  it('asks the platform to name an app bot’s chat with the bearer and nothing else, and reads the answer as it is', async () => {
    const { account } = fixture()
    const requestId = '00000000-0000-4000-8000-91eec2533b39'
    const roomId = '!room:atumplatform.com'
    const ready = { state: 'ready', roomId, botUserId: '@app-acme:atumplatform.com' }

    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(ready))
      .mockResolvedValueOnce(Response.json({ error: 'matrix_403' }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: 'not_found' }, { status: 404 }))
      .mockResolvedValueOnce(new Response('<html>gateway down</html>', { status: 503, headers: { 'content-type': 'text/html' } }))

    vi.stubGlobal('fetch', fetcher)

    await expect(account.appBotStart('acme', { requestId, appVersion: '0.20.17', roomId })).resolves.toEqual({
      status: 200,
      body: ready
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.test/apps/acme/bot/start',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer domain-access', Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, appVersion: '0.20.17', roomId }),
        redirect: 'error'
      })
    )
    // A refusal, an absent route and a gateway page are answers too: the status is what the caller reads.
    await expect(account.appBotStart('acme', { requestId, roomId })).resolves.toEqual({
      status: 403,
      body: { error: 'matrix_403' }
    })
    await expect(account.appBotStart('acme', { requestId })).resolves.toEqual({ status: 404, body: { error: 'not_found' } })
    await expect(account.appBotStart('acme', { requestId })).resolves.toEqual({ status: 503 })
  })

  it('sends nothing the route would refuse as built here, and never replays a start', async () => {
    const { account } = fixture()
    const requestId = '00000000-0000-4000-8000-91eec2533b39'
    const fetcher = vi.fn().mockRejectedValue(new Error('ambiguous response'))
    vi.stubGlobal('fetch', fetcher)

    for (const [slug, request] of [
      ['../acme', { requestId }],
      ['acme', { requestId: 'not-a-uuid' }],
      ['acme', { requestId, appVersion: 'has a space' }],
      ['acme', { requestId, appVersion: 'x'.repeat(101) }],
      ['acme', { requestId, roomId: 'room' }],
      ['acme', { requestId, roomId: '!no-server' }]
    ] as const) {
      await expect(account.appBotStart(slug, request), JSON.stringify([slug, request])).rejects.toThrow('matrix_app_invalid')
    }

    expect(fetcher).not.toHaveBeenCalled()
    // An ambiguous failure is the caller's to repeat with the same body; it is not repeated here.
    await expect(account.appBotStart('acme', { requestId })).rejects.toThrow('ambiguous response')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('does not answer a start for an account that has changed meanwhile', async () => {
    const { account } = fixture()
    const late = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => late.promise))

    const pending = account.appBotStart('acme', { requestId: '00000000-0000-4000-8000-91eec2533b39' })
    const outcome = expect(pending).rejects.toThrow('matrix_not_ready')
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledOnce())
    account.cancel()
    late.resolve(Response.json({ state: 'create', botUserId: '@app-acme:atumplatform.com' }))
    await outcome
  })

  it('reads pet preferences without enrolling or starting an executor and rejects a late account response', async () => {
    const { account } = fixture()
    const expected = { owner: identity.principal, agent: '00000000-0000-4000-8000-eb4b9770929a' }
    const response = { ...expected, revision: 1, pet: null, provenance: null, access: null, visitEndsAt: null, serverTime: '2026-10-03T00:00:00.000Z' }
    const fetcher = vi.fn(async () => Response.json(response))
    vi.stubGlobal('fetch', fetcher)
    await expect(
      account.agentPet('00000000-0000-4000-8000-63804d107579', expected, AbortSignal.timeout(1000))
    ).resolves.toEqual(response)
    expect(requestEnrollment).not.toHaveBeenCalled()
    expect(requestLease).not.toHaveBeenCalled()
    expect(authorizeNative).not.toHaveBeenCalled()
    const late = deferred<Response>()
    fetcher.mockImplementation(() => late.promise)
    const pending = account.agentPet('00000000-0000-4000-8000-63804d107579', expected, AbortSignal.timeout(1000))
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    account.cancel()
    late.resolve(Response.json(response))
    await expect(pending).rejects.toThrow('matrix_pet_cancelled')
  })
  it('does not submit a pet mutation after account cancellation during grant renewal', async () => {
    const { account, store, read } = fixture()
    const record = read()
    record.domain.expiresAt = Date.now() - 1
    store.setItem('matrix-account', JSON.stringify(record))
    const rotation = deferred<Awaited<ReturnType<typeof oidc.refreshTokenGrant>>>()
    vi.mocked(oidc.refreshTokenGrant).mockReturnValueOnce(rotation.promise)
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)

    const pending = account.agentPet(
      '00000000-0000-4000-8000-63804d107579',
      { owner: identity.principal, agent: identity.principal },
      AbortSignal.timeout(1000),
      {
        revision: 1,
        pet: { ref: null, enabled: false, scale: 1 }
      }
    )

    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1))
    account.cancel()
    rotation.resolve({ access_token: 'rotated' } as never)
    await rejected
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['json', 'text'])('rejects late replies and keeps Hermes usable after an app-local %s 401', async format => {
    const { account } = fixture()
    const result = deferred<Response>()
    const fetcher = vi.fn(() => result.promise)
    vi.stubGlobal('fetch', fetcher)
    const pending = account.appRequest({})
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    account.cancel()
    result.resolve(Response.json({ apps: [] }))
    await expect(pending).rejects.toThrow('cancelled')
    fetcher.mockResolvedValueOnce(
      format === 'json'
        ? Response.json({ error: 'unauthorized' }, { status: 401 })
        : new Response('Unauthorized', { status: 401 })
    )
    await expect(account.appRequest({})).rejects.toMatchObject({ code: 'account_unavailable' })
    expect(account.appScope()).not.toBeNull()
    expect(account.identity()?.userId).toBe('@alice:test')
    fetcher.mockResolvedValueOnce(Response.json({ state: 'accepted' }))
    await expect(account.invocation({ operation: 'recover' })).resolves.toEqual({ state: 'accepted' })
  })
})

describe('local executor credential cleanup', () => {
  it('retains the exact profile through expired enrollment renewal on the same executor', async () => {
    const { account, store, read, clearLocalHermes } = fixture()
    const initial = await account.enrollHermes()
    account.retainHermesProfile('/fixture/original-profile')
    const expired = read()
    expired.enrollment.credential.expiresAt = Date.now() - 1
    store.setItem('matrix-account', JSON.stringify(expired))
    expect(account.enrollment().state).toBe('expired')
    const renewed = await account.enrollHermes()
    expect(renewed.state).toBe('ready')
    expect(renewed.identity!.executorId).toBe(initial.identity!.executorId)
    expect(read().localHermes).toEqual(expired.localHermes)
    expect(clearLocalHermes).not.toHaveBeenCalled()
  })

  it('waits for a running executor to finish stopping before erasing its credential', async () => {
    const { account, clearLocalHermes } = fixture()
    await account.enrollHermes()
    account.retainHermesProfile('/fixture/original-profile')
    const stopping = deferred<void>()
    const close = vi.fn(() => stopping.promise)
    const pending = account.signOut(close)
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(clearLocalHermes).not.toHaveBeenCalled()
    stopping.resolve()
    await pending
    expect(clearLocalHermes).toHaveBeenCalledOnce()
  })

  it('retains exact scope before setup, keeps it on quit/renewal, clears after stopping on logout', async () => {
    const { account, read, clearLocalHermes } = fixture()
    await account.enrollHermes()
    account.retainHermesProfile('/fixture/original-profile')
    expect(read().localHermes.home).toBe('/fixture/original-profile')
    expect(() => account.retainHermesProfile('/fixture/replacement')).toThrow('matrix_local_cleanup_pending')
    await account.close(async () => {})
    expect(clearLocalHermes).not.toHaveBeenCalled()
    const stopped = vi.fn(async () => {})
    clearLocalHermes.mockImplementation(async () => {
      expect(stopped).toHaveBeenCalledOnce()
      expect(read().signingOut).toBe(true)
      expect(read().localHermes.cleanupPending).toBe(true)
      expect(read().enrollment.state).toBe('revoking')
    })
    await account.signOut(stopped)
    expect(clearLocalHermes).toHaveBeenCalledWith('/fixture/original-profile')
    expect(account.identity()).toBeNull()
  })

  it('revokes remotely despite local failure and retries after restart without renewing an executor', async () => {
    const { account, read, store, open, clearLocalHermes } = fixture()
    await account.enrollHermes()
    account.retainHermesProfile('/fixture/original-profile')
    clearLocalHermes.mockRejectedValue(new Error('disk contents must stay private'))
    await expect(account.revokeHermes()).rejects.toThrow('matrix_local_cleanup_pending')
    expect(read().enrollment).toBeUndefined()
    expect(read().localHermes.cleanupPending).toBe(true)
    expect(account.enrollment()).toEqual({ state: 'revoking', identity: null })
    await expect(account.enrollHermes()).rejects.toThrow('matrix_enrollment_revoke_pending')
    expect(() => account.agentSdkConfiguration()).toThrow('matrix_agent_unavailable')
    const cleanup = vi.fn(async () => {})
    const restarted = new MatrixAccount(config, store, open, cleanup)
    expect(await restarted.revokeHermes()).toEqual({ state: 'absent', identity: null })
    expect(cleanup).toHaveBeenCalledWith('/fixture/original-profile')
    expect(read().localHermes).toBeUndefined()
  })

  it('keeps failed logout cleanup durable even when server revocation completed', async () => {
    const { account, store, open, clearLocalHermes } = fixture()
    await account.enrollHermes()
    account.retainHermesProfile('/fixture/original-profile')
    clearLocalHermes.mockRejectedValue(new Error('unavailable runtime'))
    await expect(account.signOut()).rejects.toThrow('matrix_local_cleanup_pending')
    const restarted = new MatrixAccount(config, store, open, async () => {})
    expect(restarted.signOutPending()).toBe(true)
    expect(restarted.identity()).toBeNull()
    await restarted.signOut()
    expect(store.getItem('matrix-account')).toBeNull()
  })

  it('does not leave the local key untouched merely because human revocation is offline', async () => {
    const { account, clearLocalHermes } = fixture()
    await account.enrollHermes()
    account.retainHermesProfile('/fixture/original-profile')
    vi.mocked(oidc.tokenRevocation).mockRejectedValue(new Error('offline'))
    await expect(account.signOut()).rejects.toThrow('offline')
    expect(clearLocalHermes).toHaveBeenCalledOnce()
    expect(account.signOutPending()).toBe(true)
  })
})

function browserGrant(value: NativeGrant) {
  const cancel = vi.fn()
  vi.mocked(authorizeNative).mockImplementation(async options => {
    const completed = Promise.resolve().then(async () => {
      try {
        const prepared = await options.prepare(value)
        options.commit(prepared)

        return prepared
      } catch {
        await options.discard(value)
        throw new Error('matrix_login_failed')
      }
    })

    void completed.catch(() => {})

    return { authorizationUrl: 'https://id.test/authorize', completed, cancel }
  })

  return cancel
}

describe('persisted agent executor withdrawal', () => {
  it('retains exact encrypted custody after an acquire refusal and restart, without automatic enrollment', async () => {
    const f = fixture()
    const enrolled = await f.account.enrollHermes()
    const executorId = enrolled.identity!.executorId
    f.account.retainHermesProfile('/fixture/retained-profile')
    const before = f.read()
    vi.mocked(requestLease).mockRejectedValueOnce(new Error('matrix_lease_denied'))

    await expect(f.account.lease('acquire', executorId, { protocol: 2 })).rejects.toThrow('matrix_lease_denied')
    const withdrawn = { ...before, enrollment: { ...before.enrollment, state: 'withdrawn' } }
    expect(f.read()).toEqual(withdrawn)
    expect(f.account.enrollment()).toEqual({ state: 'withdrawn', identity: null })
    expect(f.account.identity()).toEqual({ userId: '@alice:test', deviceId: 'A' })
    expect(f.account.sdkConfiguration().accessToken).toBe('matrix-access')
    expect(f.clearLocalHermes).not.toHaveBeenCalled()
    expect(f.clearAppDevice).not.toHaveBeenCalled()

    vi.mocked(requestEnrollment).mockClear()
    vi.mocked(readDomainIdentity).mockClear()
    vi.mocked(ensureDomainAssistant).mockClear()

    const reloadedStore = new EncryptedStore(path.join(f.directory, 'vault.json'), {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString()
    })

    expect(JSON.parse(reloadedStore.getItem('matrix-account')!)).toEqual(withdrawn)
    const restarted = new MatrixAccount(config, reloadedStore, f.open, f.clearLocalHermes, f.clearAppDevice)
    expect(restarted.enrollment()).toEqual({ state: 'withdrawn', identity: null })
    expect(() => restarted.agentSdkConfiguration()).toThrow('matrix_agent_unavailable')
    expect(restarted.managedModelKey()).toBeNull()
    expect(restarted.managedModelKeys()).toEqual([])
    await expect(restarted.agentIdentity(executorId)).rejects.toThrow('matrix_agent_identity_invalid')
    await expect(restarted.enrollHermes(false)).rejects.toThrow('matrix_enrollment_withdrawn')
    await expect(restarted.enrollHermes()).rejects.toThrow('matrix_enrollment_withdrawn')
    await expect(restarted.renewAgentExecutor()).rejects.toThrow('matrix_agent_unavailable')
    await expect(restarted.lease('acquire', executorId, { protocol: 2 })).rejects.toThrow('matrix_lease_denied')
    expect(requestLease).toHaveBeenCalledOnce()
    expect(requestEnrollment).not.toHaveBeenCalled()
    expect(readDomainIdentity).not.toHaveBeenCalled()
    expect(ensureDomainAssistant).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
    expect(f.read()).toEqual(withdrawn)
  })

  it('withdraws only the exact other-agent participant and leaves default custody usable', async () => {
    const f = agentsFixture()
    await f.account.enrollHermes()
    const other = await f.account.enrollAgent(alfred)
    f.account.retainHermesProfile('/fixture/alfred-profile', alfred)
    const agent = new MatrixAgentRuntime(`agent:${alfred}`, alfred)
    agent.assistantId = '00000000-0000-4000-8000-b454f82c5857'

    const runtime = { source: '/unused/source', python: '/unused/python', profiles: directories.at(-1)! }

    const source = {
      defaultAgent: new MatrixAgentRuntime('agent'),
      agents: new Map([[alfred, agent]]),
      account: () => f.account,
      runtime: () => runtime,
      closing: () => false,
      enrollment: () => f.account.agentEnrollment(alfred)
    }

    const content = new MatrixAgentContent({ log: vi.fn() })
    const target = matrixMainAgentContentTarget(source, agent)!
    expect(target.live()).toBe(true)
    const before = f.read()
    vi.mocked(requestLease).mockRejectedValueOnce(new Error('matrix_lease_denied'))

    await expect(f.account.lease('acquire', other.identity!.executorId)).rejects.toThrow('matrix_lease_denied')
    expect(f.read()).toEqual({
      ...before,
      agentEnrollments: {
        ...before.agentEnrollments,
        [alfred]: { ...before.agentEnrollments[alfred], state: 'withdrawn' }
      }
    })
    expect(f.account.agentEnrollment(alfred)).toEqual({ state: 'withdrawn', identity: null })
    expect(target.live()).toBe(false)
    expect(matrixMainAgentContentTarget(source, agent)).toBeUndefined()
    expect(content.view(matrixMainAgentContentTarget(source, agent))).toBeUndefined()
    expect(() => f.account.agentSdkConfiguration({ agent: alfred })).toThrow('matrix_agent_unavailable')
    expect(f.account.agentSdkConfiguration().accessToken).toBe('agent-only')
    await expect(f.account.enrollAgent(alfred)).rejects.toThrow('matrix_enrollment_withdrawn')
    expect(requestEnrollment).toHaveBeenCalledTimes(2)
    expect(f.clearLocalHermes).not.toHaveBeenCalled()
  })

  it('correlates an acquire refusal to the authenticated replay grant after one401 refresh', async () => {
    const f = fixture()
    const enrolled = await f.account.enrollHermes()
    const before = f.read().enrollment
    vi.mocked(requestLease)
      .mockRejectedValueOnce(new Error('matrix_lease_authentication'))
      .mockRejectedValueOnce(new Error('matrix_lease_denied'))
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
      access_token: 'domain-rotated',
      refresh_token: 'domain-refresh-rotated',
      expires_in: 300
    } as never)

    await expect(f.account.lease('acquire', enrolled.identity!.executorId)).rejects.toThrow('matrix_lease_denied')
    expect(requestLease).toHaveBeenCalledTimes(2)
    expect(f.read().domain.accessToken).toBe('domain-rotated')
    expect(f.read().enrollment).toEqual({ ...before, state: 'withdrawn' })
  })

  it('does not withdraw a successfully renewed credential when an older lease denial arrives', async () => {
    const f = fixture()
    const enrolled = await f.account.enrollHermes()
    const denial = deferred<Error>()
    vi.mocked(requestLease).mockImplementationOnce(async () => {
      throw await denial.promise
    })
    const pending = f.account.lease('acquire', enrolled.identity!.executorId)
    const issue = vi.mocked(requestEnrollment).getMockImplementation()!
    vi.mocked(requestEnrollment).mockImplementationOnce(async (...args) => ({
      ...((await issue(...args)) as object),
      accessToken: 'new-agent-token'
    }))
    await f.account.renewAgentExecutor()
    const renewed = f.read()
    const rejected = expect(pending).rejects.toThrow('matrix_lease_unavailable')
    denial.resolve(new Error('matrix_lease_denied'))
    await rejected
    expect(f.read()).toEqual(renewed)
    expect(f.account.agentSdkConfiguration().accessToken).toBe('new-agent-token')
  })

  it('keeps the real lease retryable through the provider rotating state and resumes after actual credential renewal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000_000)
    const f = fixture()
    const enrolled = await f.account.enrollHermes()
    const executorId = enrolled.identity!.executorId
    const credential = f.read().enrollment.credential
    let rotating = false
    const states: string[] = []
    vi.mocked(requestLease).mockImplementation(async (_resource, _grant, input) => {
      if (input.operation === 'release') {
        return { held: false }
      }

      if (rotating) {
        throw new Error('matrix_lease_denied')
      }

      return {
        held: true,
        executorId,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 90_000,
        leaseToken: '00000000-0000-4000-8000-127ad7633157',
        boundary: 9_999_000
      }
    })

    const lease = new MatrixExecutorLease({
      request: (operation, id, metadata) => f.account.lease(operation, id, metadata),
      random: () => 0.5,
      onChange: status => states.push(status.state === 'unavailable' ? (status.reason ?? status.state) : status.state)
    })

    try {
      lease.start(executorId, 2)
      await vi.advanceTimersByTimeAsync(0)
      const held = lease.held(executorId)!
      expect(held).not.toBeNull()
      const rotation = deferred<unknown>()
      vi.mocked(requestEnrollment).mockReturnValueOnce(rotation.promise)
      rotating = true
      const renewing = f.account.renewAgentExecutor()
      await vi.advanceTimersByTimeAsync(0)
      expect(requestEnrollment).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(requestLease).toHaveBeenCalledTimes(2)
      expect(held.signal.aborted).toBe(false)
      expect(f.account.enrollment().state).toBe('ready')
      expect(states).not.toContain('authority_withdrawn')

      rotating = false
      rotation.resolve({ ...credential, accessToken: 'rotated-agent-token', expiresAt: Date.now() + 3_600_000 })
      await renewing
      await vi.advanceTimersByTimeAsync(5_000)
      expect(requestLease).toHaveBeenCalledTimes(3)
      expect(lease.current.state).toBe('held')
      expect(lease.held(executorId)?.signal).toBe(held.signal)
      expect(f.account.agentSdkConfiguration().accessToken).toBe('rotated-agent-token')
      expect(states).not.toContain('authority_withdrawn')
    } finally {
      await lease.stop()
      vi.useRealTimers()
    }
  })

  it.each([
    'generation',
    'account',
    'domain session',
    'domain token',
    'executor',
    'agent token',
    'storage key',
    'device',
    'revocation'
  ] as const)('does not persist an acquire denial after the %s changed', async changed => {
    const f = fixture()
    const enrolled = await f.account.enrollHermes()
    const denial = deferred<Error>()
    vi.mocked(requestLease).mockImplementationOnce(async () => {
      throw await denial.promise
    })
    const pending = f.account.lease('acquire', enrolled.identity!.executorId)
    expect(requestLease).toHaveBeenCalledOnce()
    const next = f.read()

    switch (changed) {
      case 'generation':
        f.account.cancel()

        break

      case 'account':
        next.subject = 'bob'
        next.domain.subject = 'bob'

        break

      case 'domain session':
        next.domain.sessionId = 'successor-session'

        break

      case 'domain token':
        next.domain.accessToken = 'successor-domain-token'

        break

      case 'executor':
        next.enrollment.executorId = '42345678-1234-1234-1234-123456789abc'

        break

      case 'agent token':
        next.enrollment.credential.accessToken = 'successor-agent-token'

        break

      case 'storage key':
        next.enrollment.storageKey = Buffer.alloc(32, 4).toString('base64')

        break

      case 'device':
        next.enrollment.credential.deviceId = 'SUCCESSOR'

        break

      case 'revocation':
        next.enrollment.state = 'revoking'

        break
    }

    f.store.setItem('matrix-account', JSON.stringify(next))

    const rejected = expect(pending).rejects.toThrow(
      ['generation', 'account', 'domain session'].includes(changed)
        ? 'matrix_invocation_cancelled'
        : ['domain token', 'agent token'].includes(changed)
          ? 'matrix_lease_unavailable'
          : 'matrix_lease_denied'
    )

    denial.resolve(new Error('matrix_lease_denied'))
    await rejected
    expect(f.read()).toEqual(next)
  })

  it.each(['matrix_lease_authentication', 'matrix_lease_unavailable', 'network'])(
    'keeps custody unchanged on %s',
    async message => {
      const f = fixture()
      const enrolled = await f.account.enrollHermes()
      const before = f.read()
      // A failed refresh is still authentication failure, never a withdrawal.
      vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(new Error(message))
      vi.mocked(requestLease).mockRejectedValueOnce(new Error(message))
      await expect(f.account.lease('acquire', enrolled.identity!.executorId)).rejects.toThrow(
        message === 'matrix_lease_authentication' ? 'matrix_domain_unavailable' : message
      )
      expect(f.read()).toEqual(before)
    }
  )

  it.each([{ held: false }, { held: false, reason: 'stale_term' }, { held: false, reason: 'upgrade_required' }])(
    'keeps a normal non-held lease response retryable: %j',
    async result => {
      const f = fixture()
      const enrolled = await f.account.enrollHermes()
      const before = f.read()
      vi.mocked(requestLease).mockResolvedValueOnce(result)
      await expect(f.account.lease('acquire', enrolled.identity!.executorId)).resolves.toEqual(result)
      expect(f.read()).toEqual(before)
    }
  )

  it('does not persist release403 or mistake normal credential expiry for withdrawal', async () => {
    const f = fixture()
    const enrolled = await f.account.enrollHermes()
    const before = f.read()
    vi.mocked(requestLease).mockRejectedValueOnce(new Error('matrix_lease_denied'))
    await expect(f.account.lease('release', enrolled.identity!.executorId)).rejects.toThrow('matrix_lease_denied')
    expect(f.read()).toEqual(before)
    expect(f.account.agentSdkConfiguration().accessToken).toBe('agent-only')

    before.enrollment.credential.expiresAt = 1
    f.store.setItem('matrix-account', JSON.stringify(before))
    vi.mocked(requestLease).mockRejectedValueOnce(new Error('matrix_lease_denied'))
    await expect(f.account.lease('acquire', enrolled.identity!.executorId)).rejects.toThrow('matrix_lease_unavailable')
    expect(f.account.enrollment().state).toBe('expired')
    expect(f.read()).toEqual(before)
    const renewed = await f.account.enrollHermes(false)
    expect(renewed.identity!.executorId).toBe(enrolled.identity!.executorId)
  })

  it('retains custody across a lost expired-renewal reply and marks a subsequent correlated refusal after restart', async () => {
    const f = fixture()
    await f.account.enrollHermes()
    f.account.retainHermesProfile('/fixture/retained-profile')
    const expired = f.read()
    expired.enrollment.credential.expiresAt = 1
    f.store.setItem('matrix-account', JSON.stringify(expired))
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new Error('network'))
    await expect(f.account.enrollHermes(false)).rejects.toThrow('network')
    expect(f.read()).toEqual({ ...expired, enrollment: { ...expired.enrollment, state: 'pending' } })
    expect(() => f.account.agentSdkConfiguration()).toThrow('matrix_agent_unavailable')

    const restarted = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice)
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new Error('matrix_enrollment_denied'))
    await expect(restarted.enrollHermes(false)).rejects.toThrow('matrix_enrollment_denied')
    expect(restarted.enrollment()).toEqual({ state: 'withdrawn', identity: null })
    expect(f.read()).toEqual({ ...expired, enrollment: { ...expired.enrollment, state: 'withdrawn' } })
    expect(f.clearLocalHermes).not.toHaveBeenCalled()
    expect(f.clearAppDevice).not.toHaveBeenCalled()
  })

  it('never cleans up a successor account when an expired enrollment refusal arrives after cancellation', async () => {
    const f = fixture()
    await f.account.enrollHermes()
    f.account.retainHermesProfile('/fixture/alice-profile')
    const expired = f.read()
    expired.enrollment.credential.expiresAt = 1
    f.store.setItem('matrix-account', JSON.stringify(expired))
    const denial = deferred<Error>()
    vi.mocked(requestEnrollment).mockImplementationOnce(async () => {
      throw await denial.promise
    })
    const pending = f.account.enrollHermes(false)
    await vi.waitFor(() => expect(requestEnrollment).toHaveBeenCalledTimes(2))
    f.account.cancel()
    const successorId = '42345678-1234-1234-1234-123456789abc'

    const successor = {
      ...f.read(),
      subject: 'bob',
      userId: '@bob:test',
      deviceId: 'B',
      storageKey: Buffer.alloc(32, 2).toString('base64'),
      domain: { ...f.read().domain, subject: 'bob', sessionId: 'bob-session', accessToken: 'bob-domain' },
      enrollment: {
        ...expired.enrollment,
        state: 'ready',
        executorId: successorId,
        storageKey: Buffer.alloc(32, 3).toString('base64'),
        credential: {
          ...expired.enrollment.credential,
          subject: 'bob',
          executorId: successorId,
          userId: '@bob-agent:test',
          deviceId: 'BOB-AGENT',
          accessToken: 'bob-agent',
          expiresAt: Date.now() + 3_600_000
        }
      },
      localHermes: { home: '/fixture/bob-profile', executorId: successorId }
    }

    f.store.setItem('matrix-account', JSON.stringify(successor))
    const rejected = expect(pending).rejects.toThrow('matrix_enrollment_denied')
    denial.resolve(new Error('matrix_enrollment_denied'))
    await rejected
    expect(f.read()).toEqual(successor)
    expect(requestEnrollment).toHaveBeenCalledTimes(2)
    expect(f.clearLocalHermes).not.toHaveBeenCalled()
    expect(f.clearAppDevice).not.toHaveBeenCalled()
  })
})

describe('domain credentials within the main-owned account', () => {
  it('rotates a rejected lease grant once and replays only the idempotent lease request', async () => {
    const { account, read } = fixture()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(requestLease)
      .mockRejectedValueOnce(new Error('matrix_lease_authentication'))
      .mockResolvedValueOnce({ held: true })
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
      access_token: 'domain-rotated',
      refresh_token: 'domain-refresh-rotated',
      expires_in: 300
    } as never)

    await expect(account.lease('acquire', 'executor')).resolves.toEqual({ held: true })
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
    expect(requestLease).toHaveBeenNthCalledWith(
      1,
      config.domain.resource,
      expect.objectContaining({ accessToken: 'domain-access' }),
      { operation: 'acquire', executorId: 'executor' }
    )
    expect(requestLease).toHaveBeenNthCalledWith(
      2,
      config.domain.resource,
      expect.objectContaining({ accessToken: 'domain-rotated' }),
      { operation: 'acquire', executorId: 'executor' }
    )
    expect(read().domain.accessToken).toBe('domain-rotated')
    expect(warning).not.toHaveBeenCalled()
  })

  it('passes opted-in v2 lease metadata through the domain lease path', async () => {
    const { account } = fixture()
    vi.mocked(requestLease).mockResolvedValueOnce({ held: true })

    await expect(
      account.lease('release', 'executor', {
        protocol: 2,
        leaseToken: '00000000-0000-4000-8000-127ad7633157'
      })
    ).resolves.toEqual({ held: true })
    expect(requestLease).toHaveBeenCalledWith(config.domain.resource, expect.anything(), {
      operation: 'release',
      executorId: 'executor',
      protocol: 2,
      leaseToken: '00000000-0000-4000-8000-127ad7633157'
    })
  })

  it('does not replay a lease after its single refreshed-grant retry is also rejected', async () => {
    const { account } = fixture()
    vi.mocked(requestLease).mockRejectedValue(new Error('matrix_lease_authentication'))
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'domain-rotated' } as never)

    await expect(account.lease('release', 'executor')).rejects.toThrow('matrix_lease_authentication')
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
    expect(requestLease).toHaveBeenCalledTimes(2)
  })

  it('does not rotate a domain token for 403, availability, or transport failures', async () => {
    const { account } = fixture()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(requestLease)
      .mockRejectedValueOnce(new Error('matrix_lease_unavailable')) // 403 is normalized at the endpoint.
      .mockRejectedValueOnce(new TypeError('network detail must not be logged'))

    await expect(account.lease('acquire', 'executor')).rejects.toThrow('matrix_lease_unavailable')
    await expect(account.lease('release', 'executor')).rejects.toThrow('network detail must not be logged')
    expect(oidc.refreshTokenGrant).not.toHaveBeenCalled()
    expect(requestLease).toHaveBeenCalledTimes(2)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledWith('[Matrix] lease unavailable')
    expect(JSON.stringify(warning.mock.calls)).not.toContain('network detail')
  })

  it('uses a 401 as the refresh signal even when an older grant has no expiry', async () => {
    const { account, read } = fixture()
    expect(read().domain).not.toHaveProperty('expiresAt')
    vi.mocked(requestLease)
      .mockRejectedValueOnce(new Error('matrix_lease_authentication'))
      .mockResolvedValueOnce({ held: false })
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'domain-rotated' } as never)

    await expect(account.lease('acquire', 'executor')).resolves.toEqual({ held: false })
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
    expect(requestLease).toHaveBeenCalledTimes(2)
  })

  it('coalesces simultaneous lease 401s into one domain-token rotation', async () => {
    const { account } = fixture()
    const rotation = deferred<never>()
    vi.mocked(requestLease).mockImplementation(async (_resource, leaseGrant) => {
      if (leaseGrant.accessToken === 'domain-access') {
        throw new Error('matrix_lease_authentication')
      }

      return { held: true }
    })
    vi.mocked(oidc.refreshTokenGrant).mockReturnValueOnce(rotation.promise)

    const acquire = account.lease('acquire', 'executor-a')
    const release = account.lease('release', 'executor-b')
    await vi.waitFor(() => expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1))
    rotation.resolve({ access_token: 'domain-rotated', refresh_token: 'domain-refresh-rotated' } as never)

    await expect(Promise.all([acquire, release])).resolves.toEqual([{ held: true }, { held: true }])
    expect(requestLease).toHaveBeenCalledTimes(4)
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
  })

  it('reuses a completed concurrent renewal for a staggered stale 401', async () => {
    const { account } = fixture()
    const late = deferred<Error>()
    vi.mocked(requestLease).mockImplementation(async (_resource, leaseGrant, input) => {
      if (leaseGrant.accessToken !== 'domain-access') {
        return { held: true }
      }

      if (input.executorId === 'late') {
        throw await late.promise
      }

      throw new Error('matrix_lease_authentication')
    })
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
      access_token: 'domain-rotated',
      refresh_token: 'domain-refresh-rotated'
    } as never)

    const delayed = account.lease('acquire', 'late')
    await vi.waitFor(() => expect(requestLease).toHaveBeenCalledOnce())
    await expect(account.lease('release', 'current')).resolves.toEqual({ held: true })
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)

    late.resolve(new Error('matrix_lease_authentication'))
    await expect(delayed).resolves.toEqual({ held: true })
    expect(requestLease).toHaveBeenCalledTimes(4)
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
  })

  it('does not rotate or replay a rejected lease after cancellation changes its generation', async () => {
    const { account } = fixture()
    let reject!: (error: Error) => void
    vi.mocked(requestLease).mockReturnValueOnce(
      new Promise<never>((_resolve, rejectRequest) => {
        reject = rejectRequest
      })
    )

    const pending = account.lease('acquire', 'executor')
    await vi.waitFor(() => expect(requestLease).toHaveBeenCalledOnce())
    account.cancel()
    reject(new Error('matrix_lease_authentication'))

    await expect(pending).rejects.toThrow('matrix_invocation_cancelled')
    expect(oidc.refreshTokenGrant).not.toHaveBeenCalled()
    expect(requestLease).toHaveBeenCalledOnce()
  })

  it('does not replay a lease when cancellation happens during its authentication refresh', async () => {
    const { account } = fixture()
    const rotation = deferred<never>()
    vi.mocked(requestLease).mockRejectedValueOnce(new Error('matrix_lease_authentication'))
    vi.mocked(oidc.refreshTokenGrant).mockReturnValueOnce(rotation.promise)

    const pending = account.lease('acquire', 'executor')
    await vi.waitFor(() => expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1))
    account.cancel()
    rotation.resolve({ access_token: 'domain-rotated' } as never)

    await expect(pending).rejects.toThrow('matrix_invocation_cancelled')
    expect(requestLease).toHaveBeenCalledOnce()
  })

  it('does not revive or replay a lease while sign-out waits for its authentication refresh', async () => {
    const { account, store } = fixture()
    const rotation = deferred<never>()
    vi.mocked(requestLease).mockRejectedValueOnce(new Error('matrix_lease_authentication'))
    vi.mocked(oidc.refreshTokenGrant).mockReturnValueOnce(rotation.promise)

    const pending = account.lease('acquire', 'executor')
    await vi.waitFor(() => expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1))
    const signingOut = account.signOut()
    rotation.resolve({ access_token: 'domain-rotated', refresh_token: 'domain-refresh-rotated' } as never)

    await expect(pending).rejects.toThrow('matrix_domain_signed_out')
    await expect(signingOut).resolves.toBeUndefined()
    expect(requestLease).toHaveBeenCalledOnce()
    expect(store.getItem('matrix-account')).toBeNull()
  })

  it('does not publish a lease reply that arrives after cancellation during its replay', async () => {
    const { account } = fixture()
    const replay = deferred<unknown>()
    vi.mocked(requestLease)
      .mockRejectedValueOnce(new Error('matrix_lease_authentication'))
      .mockReturnValueOnce(replay.promise)
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'domain-rotated' } as never)

    const pending = account.lease('release', 'executor')
    await vi.waitFor(() => expect(requestLease).toHaveBeenCalledTimes(2))
    account.cancel()
    replay.resolve({ held: false })

    await expect(pending).rejects.toThrow('matrix_invocation_cancelled')
  })

  it('uses only the domain grant for the fixed invocation endpoint and never retries a mutation', async () => {
    const { account } = fixture()

    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ state: 'claimed' }), { headers: { 'Content-Type': 'application/json' } })
    )

    vi.stubGlobal('fetch', request)
    expect(await account.invocation({ operation: 'claim' })).toEqual({ state: 'claimed' })
    expect(request).toHaveBeenCalledWith(
      'https://api.test/local-hermes/invocations',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: 'Bearer domain-access', 'Content-Type': 'application/json' }
      })
    )
    request.mockResolvedValueOnce(new Response('denied', { status: 401 }))
    await expect(account.invocation({ operation: 'dispatch' })).rejects.toThrow('matrix_invocation_unavailable')
    expect(request).toHaveBeenCalledTimes(2)
    expect(oidc.refreshTokenGrant).not.toHaveBeenCalled()
  })
  it('rejects non-JSON and account-generation changes during invocation responses', async () => {
    const { account } = fixture()
    const request = vi.fn(async () => new Response('not JSON'))
    vi.stubGlobal('fetch', request)
    await expect(account.invocation({ operation: 'claim' })).rejects.toThrow('matrix_invocation_unavailable')
    const response = deferred<Response>()
    request.mockImplementation(() => response.promise)
    const pending = account.invocation({ operation: 'claim' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    account.cancel()
    response.resolve(new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
    await expect(pending).rejects.toThrow('matrix_invocation_cancelled')
  })
  it('uses the dedicated openid client and stores no new account identity or SDK token', async () => {
    const { account, read, open } = fixture(false)
    browserGrant(grant)
    expect(await account.readDomain()).toEqual(identity)
    expect(authorizeNative).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'openid', config: { clientId: 'domain' }, timeoutMs: 180_000 })
    )
    expect(open).toHaveBeenCalledTimes(1)
    expect(read().domain.accessToken).toBe('domain-access')
    expect(account.sdkConfiguration()).not.toHaveProperty('domain')
    expect(account.sdkConfiguration().accessToken).toBe('matrix-access')
    expect(account.identity()).toEqual({ userId: '@alice:test', deviceId: 'A' })
  })
  it('connects the Atum account after two seconds when a queued revocation is never answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const { account, store, read, open } = fixture(false)
      browserGrant(grant)
      store.setItem(
        'matrix-revocations',
        JSON.stringify([{ issuer: config.issuer, subject: 'alice', accessToken: 'stuck', refreshToken: 'stuck-refresh', clientId: 'domain' }])
      )
      vi.mocked(oidc.tokenRevocation).mockImplementation(() => new Promise(() => {}))

      const outcome = Promise.race([
        account.readDomain(),
        new Promise(resolve => setTimeout(() => resolve('held up'), 30_000))
      ])

      await vi.advanceTimersByTimeAsync(30_000)
      await expect(outcome).resolves.toEqual(identity)
      expect(open).toHaveBeenCalledTimes(1)
      expect(read().domain.accessToken).toBe('domain-access')
      expect(JSON.parse(store.getItem('matrix-revocations')!)).toEqual([expect.objectContaining({ refreshToken: 'stuck-refresh' })])
    } finally {
      vi.useRealTimers()
    }
  })
  it('read-only recovery requires an existing grant and never starts a browser login', async () => {
    const { account, open } = fixture(false)
    await expect(account.readDomain(false)).rejects.toThrow('matrix_domain_connection_required')
    await expect(account.invocation({ operation: 'recover' })).rejects.toThrow('matrix_domain_connection_required')
    expect(open).not.toHaveBeenCalled()
    expect(authorizeNative).not.toHaveBeenCalled()
    expect(readDomainIdentity).not.toHaveBeenCalled()
  })
  it('rejects and revokes the browser grant for another subject without linking or signing out Matrix', async () => {
    const { account, read } = fixture(false)
    browserGrant({ ...grant, subject: 'bob' })
    await expect(account.readDomain()).rejects.toThrow('matrix_login_failed')
    expect(read().domain).toBeUndefined()
    expect(account.identity()?.userId).toBe('@alice:test')
    expect(readDomainIdentity).not.toHaveBeenCalled()
    expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'domain-access', expect.anything())
  })
  it('restores domain access from the vault without reopening the browser', async () => {
    const { store, open } = fixture()
    expect(await new MatrixAccount(config, store, open).readDomain()).toEqual(identity)
    expect(open).not.toHaveBeenCalled()
    expect(oidc.refreshTokenGrant).not.toHaveBeenCalled()
  })
  it('preserves both rotations when Matrix and domain refresh finish concurrently', async () => {
    const { account, read, store } = fixture()
    store.setItem('matrix-account', JSON.stringify({ ...read(), domain: { ...read().domain, expiresAt: 1 } }))
    const matrix = deferred<never>()
    const domain = deferred<never>()
    vi.mocked(oidc.refreshTokenGrant).mockImplementation((_config, token) =>
      token === 'matrix-refresh' ? matrix.promise : domain.promise
    )
    const matrixRead = account.refresh(account.sdkConfiguration().refreshToken)
    const domainRead = account.readDomain()
    await vi.waitFor(() => expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(2))
    domain.resolve({
      access_token: 'domain-rotated',
      refresh_token: 'domain-refresh-rotated',
      expires_in: 300
    } as never)
    await domainRead
    matrix.resolve({ access_token: 'matrix-rotated', refresh_token: 'matrix-refresh-rotated' } as never)
    await matrixRead
    expect(read().domain.accessToken).toBe('domain-rotated')
    expect(read().accessToken).toBe('matrix-rotated')
  })
  it('coalesces refresh and retries an authentication failure at most once, then is unavailable, not signed out', async () => {
    const log = vi.fn()
    const { store } = fixture()
    const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log)
    vi.mocked(readDomainIdentity).mockResolvedValue(null)
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({
      access_token: 'rotated',
      refresh_token: 'rotated-refresh'
    } as never)
    // Two refusals from the platform, one after a fresh rotation, are not the sign-in server
    // ending the Atum account sign-in: only its invalid_grant does that.
    await expect(account.readDomain()).rejects.toThrow('matrix_domain_unavailable')
    expect(account.appScope()).not.toBeNull()
    expect(readDomainIdentity).toHaveBeenCalledTimes(2)
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
    expect(authorizeNative).not.toHaveBeenCalled()
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith({ event: 'domain_refused' })

    // The next read asks again, with the rotated grant it kept.
    vi.mocked(readDomainIdentity).mockResolvedValue(identity)
    expect(await account.readDomain()).toEqual(identity)
    expect(JSON.parse(store.getItem('matrix-account')!).domain.refreshToken).toBe('rotated-refresh')
  })
  it('holds a rotated Atum account grant the vault could not save: never revoked, never used, saved later', async () => {
    vi.useFakeTimers()

    try {
      const log = vi.fn()
      const renewed = vi.fn()
      const { store, read } = fixture()
      store.setItem('matrix-account', JSON.stringify({ ...read(), domain: { ...read().domain, expiresAt: 1 } }))
      const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log, { renewed })
      vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({
        access_token: 'domain-held',
        refresh_token: 'domain-held-refresh',
        expires_in: 300
      } as never)

      const disk = vi.spyOn(store, 'setItem').mockImplementation(() => {
        throw new Error('auth_storage_write_failed')
      })

      // Unavailable while it is held: the saved grant stays the one MAS takes after a crash.
      await expect(account.readDomain()).rejects.toThrow('matrix_domain_unavailable')
      expect(readDomainIdentity).not.toHaveBeenCalled()
      expect(oidc.tokenRevocation).not.toHaveBeenCalled()
      expect(account.appScope()).not.toBeNull()
      expect(account.identity()?.userId).toBe('@alice:test')
      expect(log).toHaveBeenCalledWith({ event: 'credential_save_failed', client: 'domain', code: 'auth_storage_write_failed' })
      // Asked again meanwhile: no second rotation, just another try at the save.
      await expect(account.readDomain()).rejects.toThrow('matrix_domain_unavailable')
      expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)

      disk.mockRestore()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(read().domain).toMatchObject({ accessToken: 'domain-held', refreshToken: 'domain-held-refresh' })
      expect(log).toHaveBeenCalledWith({ event: 'credential_saved', client: 'domain' })
      expect(renewed).toHaveBeenCalledWith('domain')
      expect(await account.readDomain()).toEqual(identity)
      expect(vi.mocked(readDomainIdentity).mock.calls.at(-1)?.[1]).toMatchObject({ accessToken: 'domain-held' })
      expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it.each([
    ['the network', () => new TypeError('fetch failed'), 'transport'],
    [
      'a 5xx',
      () => Object.assign(new Error('unexpected HTTP response status code'), { code: 'OAUTH_RESPONSE_IS_NOT_CONFORM', cause: new Response('', { status: 503 }) }),
      '5xx'
    ]
  ] as const)('a passing Atum account refresh failure (%s) signs nothing out and clears nothing', async (_name, error, cause) => {
    const log = vi.fn()
    const { store, read } = fixture()
    store.setItem('matrix-account', JSON.stringify({ ...read(), domain: { ...read().domain, expiresAt: 1 } }))
    const retained = store.getItem('matrix-account')
    const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log)
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(error())

    await expect(account.readDomain()).rejects.toThrow('matrix_domain_unavailable')
    expect(store.getItem('matrix-account')).toBe(retained)
    expect(account.appScope()).not.toBeNull()
    expect(account.identity()?.userId).toBe('@alice:test')
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith({ event: 'refresh_unavailable', client: 'domain', cause })

    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'domain-back', refresh_token: 'domain-back-refresh' } as never)
    expect(await account.readDomain()).toEqual(identity)
  })
  it('revokes a rotation of an Atum account sign-in replaced meanwhile, without touching the current one', async () => {
    const log = vi.fn()
    const { store, read } = fixture()
    store.setItem('matrix-account', JSON.stringify({ ...read(), domain: { ...read().domain, expiresAt: 1 } }))
    const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log)
    const rotation = deferred<never>()
    vi.mocked(oidc.refreshTokenGrant).mockReturnValue(rotation.promise)
    const reading = account.readDomain()
    const rejected = expect(reading).rejects.toThrow('matrix_domain_unavailable')
    await vi.waitFor(() => expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1))
    // A new authorization replaced the sign-in while the old one rotated.
    store.setItem('matrix-account', JSON.stringify({ ...read(), domain: { ...grant, accessToken: 'new-access', refreshToken: 'new-refresh', sessionId: 'replacement' } }))
    rotation.resolve({ access_token: 'stale-access', refresh_token: 'stale-refresh' } as never)

    await rejected
    expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'stale-refresh', expect.anything())
    expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'new-refresh', expect.anything())
    expect(read().domain).toMatchObject({ sessionId: 'replacement', refreshToken: 'new-refresh' })
    expect(account.appScope()).not.toBeNull()
    expect(log).toHaveBeenCalledWith({ event: 'grant_revoked', client: 'domain', reason: 'domain_replaced' })
  })
  it('ends the Atum account sign-in only on its own invalid_grant, and logs it', async () => {
    const log = vi.fn()
    const { store, read } = fixture()
    store.setItem('matrix-account', JSON.stringify({ ...read(), domain: { ...read().domain, expiresAt: 1 } }))
    const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log)
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(
      new oidc.ResponseBodyError('invalid_grant', { cause: { error: 'invalid_grant' }, response: new Response('', { status: 400 }) })
    )

    await expect(account.readDomain()).rejects.toThrow('matrix_domain_signed_out')
    expect(log).toHaveBeenCalledWith({ event: 'session_ended', client: 'domain', cause: 'refresh_rejected:invalid_grant' })
    // The person's chats are another sign-in: still open.
    expect(account.identity()?.userId).toBe('@alice:test')
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
  })
  it("an app the sign-in server doesn't recognise (invalid_client) leaves the Atum account sign-in as it is", async () => {
    const log = vi.fn()
    const { store, read } = fixture()
    store.setItem('matrix-account', JSON.stringify({ ...read(), domain: { ...read().domain, expiresAt: 1 } }))
    const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log)
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(
      new oidc.ResponseBodyError('invalid_client', { cause: { error: 'invalid_client' }, response: new Response('', { status: 401 }) })
    )

    await expect(account.readDomain()).rejects.toThrow('matrix_domain_unavailable')
    expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'session_ended' }))
    expect(log).toHaveBeenCalledWith({ event: 'refresh_unavailable', client: 'domain', cause: 'refused', oauth: 'invalid_client' })
    expect(account.appScope()).not.toBeNull()

    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'domain-back', refresh_token: 'domain-back-refresh' } as never)
    expect(await account.readDomain(false)).toEqual(identity)
  })
  it("keeps agents working on a live Atum account sign-in after the person's chat session ended", async () => {
    const { account, store } = fixture()
    await account.enrollHermes()
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(
      new oidc.ResponseBodyError('invalid_grant', { cause: { error: 'invalid_grant' }, response: new Response('', { status: 400 }) })
    )
    expect((await account.refresh(account.sdkConfiguration().refreshToken)).ok).toBe(false)
    expect(account.identity()).toBeNull()

    // The domain owner is not the chat session: reads, scope and the agent's custody go on.
    expect(await account.readDomain()).toEqual(identity)
    expect(account.appScope()).not.toBeNull()
    expect(account.enrollment().state).toBe('ready')
    expect(() => account.agentSdkConfiguration()).not.toThrow()
    expect(JSON.parse(store.getItem('matrix-account')!).enrollment.state).toBe('ready')
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
  })
  it('service failure never causes token rotation or another browser login', async () => {
    const { account } = fixture()
    vi.mocked(readDomainIdentity).mockRejectedValueOnce(new Error('unavailable'))
    await expect(account.readDomain()).rejects.toThrow('unavailable')
    expect(oidc.refreshTokenGrant).not.toHaveBeenCalled()
    expect(authorizeNative).not.toHaveBeenCalled()
  })
  it('a revoked domain refresh fails closed on later background reads without another request or browser', async () => {
    const { account } = fixture()
    vi.mocked(readDomainIdentity).mockResolvedValueOnce(null)
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(
      new oidc.ResponseBodyError('invalid_grant', {
        cause: { error: 'invalid_grant' },
        response: new Response('', { status: 400 })
      })
    )
    await expect(account.readDomain()).rejects.toThrow('matrix_domain_signed_out')
    // In the background it is one click to ask for (setup's Connect), never a browser by itself.
    await expect(account.readDomain(false)).rejects.toThrow('matrix_domain_connection_required')
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
    expect(readDomainIdentity).toHaveBeenCalledTimes(1)
    expect(authorizeNative).not.toHaveBeenCalled()
    expect(account.identity()?.userId).toBe('@alice:test')
  })
  it("the person's own Connect replaces an Atum account sign-in the server refused, with no sign-out", async () => {
    const log = vi.fn()
    const returned = vi.fn()
    const f = fixture()
    const account = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice, log, { returned })
    vi.mocked(readDomainIdentity).mockResolvedValueOnce(null)
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(
      new oidc.ResponseBodyError('invalid_grant', { cause: { error: 'invalid_grant' }, response: new Response('', { status: 400 }) })
    )
    await expect(account.readDomain()).rejects.toThrow('matrix_domain_signed_out')
    expect(account.appScope()).toBeNull()

    vi.mocked(authorizeNative).mockImplementation(async options => {
      const value = { ...grant, accessToken: 'domain-new', refreshToken: 'domain-new-refresh' }
      options.onCallback?.()

      const completed = options.prepare(value).then(prepared => {
        options.commit(prepared)

        return prepared
      })

      return { authorizationUrl: 'https://id.test/authorize?client=domain', completed, cancel: vi.fn() }
    })

    expect(await account.readDomain()).toEqual(identity)
    expect(f.open).toHaveBeenCalledTimes(1)
    // The app comes back to the front when the browser does.
    expect(returned).toHaveBeenCalledTimes(1)
    expect(f.read().domain).toMatchObject({ accessToken: 'domain-new', refreshToken: 'domain-new-refresh' })
    expect(f.read().domain.sessionId).not.toBe('domain-session')
    expect(account.appScope()).not.toBeNull()
    expect(await account.readDomain(false)).toEqual(identity)
    // The refused one is revoked behind it, best effort.
    expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'domain-refresh', expect.anything())
    expect(log).toHaveBeenCalledWith({ event: 'grant_revoked', client: 'domain', reason: 'session_replaced' })
  })
  it('after the platform refused a fresh Atum account token, waits five minutes before rotating on a refusal again', async () => {
    vi.useFakeTimers()

    try {
      const log = vi.fn()
      const { store, read } = fixture()
      const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log)
      vi.mocked(readDomainIdentity).mockResolvedValue(null)
      vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({
        access_token: 'domain-rotated',
        refresh_token: 'domain-rotated-refresh',
        expires_in: 3600
      } as never)

      await expect(account.readDomain(false)).rejects.toThrow('matrix_domain_unavailable')
      expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
      expect(log).toHaveBeenCalledWith({ event: 'domain_refused' })

      // Seven agents' renewals in the next minutes: each reads once, none rotates.
      for (let agent = 0; agent < 7; agent++) {
        await expect(account.readDomain(false)).rejects.toThrow('matrix_domain_unavailable')
      }

      expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
      expect(read().domain.refreshToken).toBe('domain-rotated-refresh')

      // The platform takes the token again: the wait ends at once.
      vi.mocked(readDomainIdentity).mockResolvedValueOnce(identity)
      expect(await account.readDomain(false)).toEqual(identity)

      // Refused again later: one rotation, then the wait again.
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await expect(account.readDomain(false)).rejects.toThrow('matrix_domain_unavailable')
      expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(2)
      await expect(account.readDomain(false)).rejects.toThrow('matrix_domain_unavailable')
      expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
  it('keeps human chat publishable after domain revocation without reading or erasing retained agent custody', async () => {
    const { account, store } = fixture()
    await account.enrollHermes()
    const retained = store.getItem('matrix-account')
    const participants = vi.fn(() => ({ enrollment: account.enrollment(), agents: account.agentEnrollments() }))
    expect(readMatrixAgentPresentation(Boolean(account.appScope()), participants)?.enrollment.state).toBe('ready')
    participants.mockClear()
    vi.mocked(readDomainIdentity).mockResolvedValueOnce(null)
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(
      new oidc.ResponseBodyError('invalid_grant', {
        cause: { error: 'invalid_grant' },
        response: new Response('', { status: 400 })
      })
    )
    await expect(account.readDomain()).rejects.toThrow('matrix_domain_signed_out')
    const projection = readMatrixAgentPresentation(Boolean(account.appScope()), participants)
    expect(projection).toBeUndefined()
    expect(participants).not.toHaveBeenCalled()
    expect(account.identity()?.userId).toBe('@alice:test')
    expect(store.getItem('matrix-account')).toBe(retained)
    expect(() => account.enrollment()).toThrow('matrix_domain_signed_out')
    expect(authorizeNative).not.toHaveBeenCalled()
  })
  it('lets listener shutdown reach real account cleanup after its domain grant is revoked', async () => {
    const { account, store } = fixture()
    await account.enrollHermes()
    const maintenance = vi.fn(() => account.enrollment())
    const publication = vi.fn(() => void readMatrixAgentPresentation(Boolean(account.appScope()), maintenance))

    const listening = new MatrixContinuousListening({
      store,
      listener: () => undefined,
      stop: () => {},
      context: () => ({ state: 'waiting', reason: 'unavailable' }),
      arm: async () => {
        throw new Error('unexpected listener admission')
      },
      changed: publication
    })

    listening.disable()
    expect(publication).toHaveBeenCalled()
    expect(maintenance.mock.results.at(-1)?.value.state).toBe('ready')
    publication.mockClear()
    maintenance.mockClear()
    vi.mocked(readDomainIdentity).mockResolvedValueOnce(null)
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(
      new oidc.ResponseBodyError('invalid_grant', {
        cause: { error: 'invalid_grant' },
        response: new Response('', { status: 400 })
      })
    )
    await expect(account.readDomain()).rejects.toThrow('matrix_domain_signed_out')
    const retained = store.getItem('matrix-account')
    // The unguarded publication read reproduces the installed exception.
    expect(maintenance).toThrow('matrix_domain_signed_out')
    maintenance.mockClear()
    expect(() => listening.disable()).not.toThrow()
    expect(publication).toHaveBeenCalled()
    expect(maintenance).not.toHaveBeenCalled()
    expect(store.getItem('matrix-account')).toBe(retained)
    publication.mockClear()
    await account.signOut(async () => {
      listening.disable()
    })
    expect(publication).toHaveBeenCalled()
    expect(store.getItem('matrix-account')).toBeNull()
    expect(store.getItem('matrix-revocations')).toBeNull()
    expect(listening.enabled).toBe(false)
    expect(maintenance).not.toHaveBeenCalled()
    expect(authorizeNative).not.toHaveBeenCalled()
  })
  it('closes both grants durably before remote logout, preserving pending cleanup on failure', async () => {
    const { account, read, store } = fixture()
    vi.mocked(oidc.tokenRevocation).mockRejectedValueOnce(new Error('network'))
    await expect(account.signOut()).rejects.toThrow('network')
    expect(read().signingOut).toBe(true)
    // The chat grant whose revocation failed stays queued; the Atum account's, behind it, went.
    expect(JSON.parse(store.getItem('matrix-revocations')!)).toEqual([
      expect.objectContaining({ refreshToken: 'matrix-refresh', attempts: 1 })
    ])
    expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'domain-refresh', expect.anything())
    const restarted = new MatrixAccount(config, store, async () => {})
    await expect(restarted.readDomain()).rejects.toThrow('matrix_domain_signed_out')
    await restarted.signOut()
    expect(store.getItem('matrix-account')).toBeNull()
    expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'domain-refresh', expect.anything())
    expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'matrix' }, 'matrix-refresh', expect.anything())
  })
  it('revokes a late rotation instead of resurrecting a logged-out account', async () => {
    const { account, read, store } = fixture()
    store.setItem('matrix-account', JSON.stringify({ ...read(), domain: { ...read().domain, expiresAt: 1 } }))
    const rotation = deferred<never>()
    vi.mocked(oidc.refreshTokenGrant).mockReturnValue(rotation.promise)
    const reading = account.readDomain()
    const rejected = expect(reading).rejects.toThrow('matrix_login_cancelled')
    await vi.waitFor(() => expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1))
    const signingOut = account.signOut()
    rotation.resolve({ access_token: 'late-access', refresh_token: 'late-refresh' } as never)
    await rejected
    await signingOut
    expect(store.getItem('matrix-account')).toBeNull()
    expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'late-refresh', expect.anything())
  })
  it('cancel drops a late resource response without revoking either account', async () => {
    const { account } = fixture()
    const request = deferred<typeof identity>()
    vi.mocked(readDomainIdentity).mockReturnValue(request.promise)
    const reading = account.readDomain()
    account.cancel()
    request.resolve(identity)
    await expect(reading).rejects.toThrow('matrix_login_cancelled')
    expect(account.identity()).not.toBeNull()
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
  })
  it('normal quit does not start a new rotation from a late unauthorized response', async () => {
    const { account } = fixture()
    const request = deferred<null>()
    vi.mocked(readDomainIdentity).mockReturnValue(request.promise)
    const reading = account.readDomain()
    await account.close(async () => {})
    request.resolve(null)
    await expect(reading).rejects.toThrow('matrix_login_cancelled')
    expect(oidc.refreshTokenGrant).not.toHaveBeenCalled()
  })
})

describe('authenticated local Hermes enrollment custody', () => {
  it.each(['root', 'named'] as const)('records the canonical native device in the durable %s creation intent only after support', async kind => {
    const f = fixture()
    const primary = '22345678-1234-1234-1234-123456789abc'
    vi.mocked(requestLocalEnrollmentCapabilities).mockResolvedValue(true)

    await (kind === 'root' ? f.account.enrollHermes() : f.account.enrollAgent(primary))

    const enrollment = kind === 'root' ? f.read().enrollment : f.read().agentEnrollments[primary]
    expect(enrollment).toMatchObject({ state: 'ready', hostDevice: 'A' })
    expect(requestLocalEnrollmentCapabilities).toHaveBeenCalledWith(config.domain.resource, expect.anything())
    expect(vi.mocked(requestEnrollment).mock.calls[0]?.[6]).toBe('A')
  })

  it('keeps a supported host-device binding across renewal, recovery, and an unavailable legacy probe', async () => {
    const f = fixture()
    vi.mocked(requestLocalEnrollmentCapabilities).mockResolvedValue(true)
    await f.account.enrollHermes()
    const original = f.read().enrollment

    vi.mocked(requestLocalEnrollmentCapabilities).mockClear()
    await f.account.renewAgentExecutor()
    expect(vi.mocked(requestEnrollment).mock.calls.at(-1)?.[6]).toBe('A')
    expect(vi.mocked(requestLocalEnrollmentCapabilities)).not.toHaveBeenCalled()

    const expired = f.read()
    expired.enrollment.credential.expiresAt = 1
    f.store.setItem('matrix-account', JSON.stringify(expired))
    await new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice).enrollHermes(false)
    expect(vi.mocked(requestEnrollment).mock.calls.at(-1)?.[6]).toBe('A')
    expect(f.read().enrollment.hostDevice).toBe(original.hostDevice)
    expect(vi.mocked(requestLocalEnrollmentCapabilities)).not.toHaveBeenCalled()

    const legacy = fixture()
    await legacy.account.enrollHermes()
    expect(legacy.read().enrollment.hostDevice).toBeUndefined()
    expect(vi.mocked(requestEnrollment).mock.calls.at(-1)?.[6]).toBeUndefined()
  })

  it('reuses the same durable host-device body after an unknown local POST outcome', async () => {
    const f = fixture()
    vi.mocked(requestLocalEnrollmentCapabilities).mockResolvedValue(true)
    const issue = vi.mocked(requestEnrollment).getMockImplementation()!
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new Error('offline'))

    await expect(f.account.enrollHermes()).rejects.toThrow('offline')
    const pending = f.read().enrollment
    expect(pending).toMatchObject({ state: 'pending', hostDevice: 'A' })

    vi.mocked(requestEnrollment).mockImplementation(issue)
    await f.account.enrollHermes()
    expect(vi.mocked(requestEnrollment).mock.calls.map(call => [call[2], call[6]])).toEqual([
      [pending.executorId, 'A'],
      [pending.executorId, 'A']
    ])
    expect(requestLocalEnrollmentCapabilities).toHaveBeenCalledTimes(1)
  })

  it('never probes or carries host-device context to an app proxy enrollment', async () => {
    const f = appFixture()
    vi.mocked(requestLocalEnrollmentCapabilities).mockResolvedValue(true)

    await f.account.enrollApp(riverApp, true)

    expect(requestLocalEnrollmentCapabilities).not.toHaveBeenCalled()
    const call = vi.mocked(requestEnrollment).mock.calls[0]!
    expect(call[4]).toMatchObject({ slug: riverApp.slug })
    expect(call[6]).toBeUndefined()
  })

  it.each(['root', 'named'] as const)('%s pending custody excludes concurrent duplicate issuance', async first => {
    const { account, read } = fixture()
    const primary = '22345678-1234-1234-1234-123456789abc'
    const issue = vi.mocked(requestEnrollment).getMockImplementation()!
    const response = deferred<unknown>()
    vi.mocked(requestEnrollment).mockReturnValueOnce(response.promise)
    const enrolling = first === 'root' ? account.enrollHermes() : account.enrollAgent(primary)
    await vi.waitFor(() => expect(requestEnrollment).toHaveBeenCalledTimes(1))
    const retained = read()
    const intent = first === 'root' ? retained.enrollment : retained.agentEnrollments[primary]
    expect(intent).toMatchObject({ state: 'pending', agentPrincipal: primary })
    expect(intent.credential).toBeUndefined()

    await expect(first === 'root' ? account.enrollAgent(primary) : account.enrollHermes()).rejects.toThrow(
      'matrix_enrollment_invalid'
    )
    expect(requestEnrollment).toHaveBeenCalledTimes(1)
    expect(read()).toEqual(retained)
    response.resolve(await issue(...vi.mocked(requestEnrollment).mock.calls[0]!))
    expect((await enrolling).state).toBe('ready')
    expect(requestEnrollment).toHaveBeenCalledTimes(1)
    expect(first === 'root' ? account.agentEnrollment(primary).state : account.enrollment().state).toBe('absent')
  })

  it('refuses a second root slot before issuance when the default already has named custody', async () => {
    const { account, read } = fixture()
    const primary = '22345678-1234-1234-1234-123456789abc'
    vi.mocked(ensureDomainAssistant).mockResolvedValue({ agentPrincipal: primary, matrixUser: '@hermes:test' })
    const named = await account.enrollAgent(primary)
    const retained = read()
    vi.mocked(requestEnrollment).mockClear()

    await expect(account.enrollHermes()).rejects.toThrow('matrix_enrollment_invalid')

    expect(requestEnrollment).not.toHaveBeenCalled()
    expect(read()).toEqual(retained)
    expect(account.agentEnrollment(primary)).toEqual(named)
    expect(account.enrollment().state).toBe('absent')
  })

  it('withdraws a root intent that was never issued when the named slot serves its agent', async () => {
    const { account, read, store } = fixture()
    const primary = '22345678-1234-1234-1234-123456789abc'
    const named = await account.enrollAgent(primary)
    // Left by an earlier launch: pinned to the agent, never issued (no credential).
    const stale = { executorId: '00000000-0000-4000-8000-6c8dbd6d95b3', state: 'pending', agentPrincipal: primary }
    store.setItem('matrix-account', JSON.stringify({ ...read(), enrollment: { ...stale, storageKey: 'aW50ZW50' } }))
    expect(account.retainedAgentPrincipal()).toBe(primary)
    vi.mocked(requestEnrollment).mockClear()

    await expect(account.enrollHermes()).rejects.toThrow('matrix_enrollment_invalid')

    // Only the stale executor is withdrawn (revoked or tombstoned by the platform): no issuance.
    expect(vi.mocked(requestEnrollment).mock.calls.map(call => [call[2], call[3]])).toEqual([
      [stale.executorId, 'DELETE']
    ])
    expect(read().enrollment).toBeUndefined()
    expect(account.retainedAgentPrincipal()).toBeUndefined()
    expect(account.agentEnrollment(primary)).toEqual(named)

    // The root now stays out of the way: the next refusal sends nothing at all.
    vi.mocked(requestEnrollment).mockClear()
    await expect(account.enrollHermes()).rejects.toThrow('matrix_enrollment_invalid')
    expect(requestEnrollment).not.toHaveBeenCalled()
    expect(account.agentEnrollment(primary)).toEqual(named)
  })

  it("withdraws a named intent that was never issued when the root holds the agent's credential", async () => {
    const { account, read, store } = fixture()
    const primary = '22345678-1234-1234-1234-123456789abc'
    const root = await account.enrollHermes()
    const expired = read()
    expired.enrollment.credential.expiresAt = Date.now() - 1000
    const stale = { executorId: '00000000-0000-4000-8000-e1059ba50f1e', state: 'pending', storageKey: 'aW50ZW50' }
    store.setItem('matrix-account', JSON.stringify({ ...expired, agentEnrollments: { [primary]: stale } }))
    vi.mocked(requestEnrollment).mockClear()

    await expect(account.enrollHermes()).rejects.toThrow('matrix_enrollment_invalid')

    expect(vi.mocked(requestEnrollment).mock.calls.map(call => [call[2], call[3]])).toEqual([
      [stale.executorId, 'DELETE']
    ])
    expect(read().agentEnrollments ?? {}).toEqual({})
    expect(read().enrollment).toEqual(expired.enrollment)

    // The root's own executor then renews as before: the same executor, device and agent.
    const renewed = await account.enrollHermes()
    expect(renewed.identity).toMatchObject({
      executorId: root.identity!.executorId,
      agentPrincipal: primary,
      deviceId: root.identity!.deviceId
    })
  })

  it('never withdraws custody: two slots with credentials for one agent are only refused', async () => {
    const { account, read, store } = fixture()
    const primary = '22345678-1234-1234-1234-123456789abc'
    await account.enrollHermes()
    const record = read()

    const other = {
      ...record.enrollment,
      executorId: '00000000-0000-4000-8000-e701d04e702f',
      credential: { ...record.enrollment.credential, executorId: '00000000-0000-4000-8000-e701d04e702f' }
    }

    record.enrollment.credential.expiresAt = Date.now() - 1000
    store.setItem('matrix-account', JSON.stringify({ ...record, agentEnrollments: { [primary]: other } }))
    const retained = read()
    vi.mocked(requestEnrollment).mockClear()

    await expect(account.enrollHermes()).rejects.toThrow('matrix_enrollment_invalid')

    expect(requestEnrollment).not.toHaveBeenCalled()
    expect(read()).toEqual(retained)
  })

  it('passes the enrolled agent partition to logout cleanup even when its credential has expired', async () => {
    const { account, read, store } = fixture()
    const enrolled = await account.enrollHermes()
    const record = read()
    record.enrollment.credential.expiresAt = 1
    store.setItem('matrix-account', JSON.stringify(record))
    const cleanup = vi.fn(async () => {})
    await account.signOut(cleanup)
    expect(cleanup).toHaveBeenCalledWith(
      { userId: '@alice:test', deviceId: 'A' },
      { userId: enrolled.identity!.userId, deviceId: enrolled.identity!.deviceId }
    )
  })
  it('keeps independent crypto custody across restart/renewal and denies expired or revoking agent access', async () => {
    const { account, read, store, open } = fixture()
    await account.enrollHermes()
    const agent = account.agentSdkConfiguration()
    expect(agent.accessToken).toBe('agent-only')
    expect(agent).not.toHaveProperty('refreshToken')
    expect(agent.storageKey).not.toBe(account.sdkConfiguration().storageKey)
    expect(Buffer.from(agent.storageKey, 'base64')).toHaveLength(32)
    expect(new MatrixAccount(config, store, open).agentSdkConfiguration()).toEqual(agent)
    const record = read()
    record.enrollment.credential.expiresAt = 1
    store.setItem('matrix-account', JSON.stringify(record))
    expect(() => account.agentSdkConfiguration()).toThrow('matrix_agent_unavailable')
    await account.enrollHermes()
    expect(account.agentSdkConfiguration().storageKey).toBe(agent.storageKey)
    vi.mocked(requestEnrollment).mockRejectedValue(new Error('offline'))
    await expect(account.revokeHermes()).rejects.toThrow('offline')
    expect(() => account.agentSdkConfiguration()).toThrow('matrix_agent_unavailable')
  })

  it('upgrades old custody durably but never regenerates a corrupt key or reuses the human key', async () => {
    const { account, read, store } = fixture()
    await account.enrollHermes()
    const record = read()
    delete record.enrollment.storageKey
    store.setItem('matrix-account', JSON.stringify(record))
    const key = account.agentSdkConfiguration().storageKey
    expect(read().enrollment.storageKey).toBe(key)

    for (const invalid of ['bad-key', record.storageKey]) {
      record.enrollment.storageKey = invalid
      store.setItem('matrix-account', JSON.stringify(record))
      expect(() => account.agentSdkConfiguration()).toThrow('matrix_agent_key_invalid')
      expect(read().enrollment.storageKey).toBe(invalid)
    }
  })
  it('persists intent before issuance; coalesces acquisition; exposes only metadata after restart', async () => {
    const { account, read, store, open } = fixture()
    const issue = vi.mocked(requestEnrollment).getMockImplementation()!
    vi.mocked(requestEnrollment).mockImplementation(async (...args) => {
      expect(read().enrollment.state).toBe('pending')
      expect(read().enrollment.executorId).toBe(args[2])

      return issue(...args)
    })
    const [a, b] = await Promise.all([account.enrollHermes(), account.enrollHermes()])
    expect(a).toEqual(b)
    expect(requestEnrollment).toHaveBeenCalledTimes(1)
    expect(a.state).toBe('ready')
    expect(JSON.stringify(a)).not.toContain('agent-only')
    expect(account.sdkConfiguration().accessToken).toBe('matrix-access')
    expect(JSON.stringify(account.sdkConfiguration())).not.toContain('agent-only')
    const restarted = new MatrixAccount(config, store, open)
    expect(restarted.enrollment()).toEqual(a)
    await restarted.enrollHermes()
    expect(requestEnrollment).toHaveBeenCalledTimes(1)
    expect(read().enrollment.credential.accessToken).toBe('agent-only')
    expect(open).not.toHaveBeenCalled()
  })
  it('denies malformed/foreign ownership delivery and retains failed cleanup durably', async () => {
    const { account, read, store, open } = fixture()
    vi.mocked(requestEnrollment)
      .mockResolvedValueOnce({ ...identity, subject: 'bob' })
      .mockRejectedValueOnce(new Error('network'))
    await expect(account.enrollHermes()).rejects.toThrow('matrix_enrollment_invalid')
    expect(read().enrollment.state).toBe('revoking')
    expect(read().enrollment.credential).toBeUndefined()
    const restarted = new MatrixAccount(config, store, open)
    await expect(restarted.enrollHermes()).rejects.toThrow('matrix_enrollment_revoke_pending')
    expect((await restarted.revokeHermes()).state).toBe('absent')
  })
  it('expired enrollment renews the same main-chosen executor instead of changing agent identity', async () => {
    const { account, read, store } = fixture()
    const first = await account.enrollHermes()
    const record = read()
    record.enrollment.credential.expiresAt = 1
    store.setItem('matrix-account', JSON.stringify(record))
    expect(account.enrollment().state).toBe('expired')
    const second = await account.enrollHermes()
    expect(second.identity?.executorId).toBe(first.identity?.executorId)
    expect(second.identity?.userId).toBe(first.identity?.userId)
    expect(requestEnrollment).toHaveBeenCalledTimes(2)
  })
  it('a pending acquisition left by process death retains its executor on retry', async () => {
    const { account, read, store } = fixture()
    const executorId = '42345678-1234-1234-1234-123456789abc'
    store.setItem('matrix-account', JSON.stringify({ ...read(), enrollment: { executorId, state: 'pending' } }))
    expect(account.enrollment().state).toBe('pending')
    expect((await account.enrollHermes()).identity?.executorId).toBe(executorId)
    expect(requestEnrollment).toHaveBeenCalledWith(
      config.domain.resource,
      expect.anything(),
      executorId,
      'POST',
      undefined,
      '22345678-1234-1234-1234-123456789abc'
    )
  })
  it.each(['cancel', 'logout', 'quit'])('%s never resurrects a late enrollment', async operation => {
    const { account, read, store } = fixture()
    const response = deferred<unknown>()
    vi.mocked(requestEnrollment).mockReturnValueOnce(response.promise)
    const acquiring = account.enrollHermes()
    const rejected = expect(acquiring).rejects.toThrow()
    await vi.waitFor(() => expect(read().enrollment?.state).toBe('pending'))
    const executorId = read().enrollment.executorId
    let closing: Promise<void> | undefined

    if (operation === 'cancel') {
      account.cancel()
    }

    if (operation === 'logout') {
      closing = account.signOut()
    }

    if (operation === 'quit') {
      closing = account.close(async () => {})
    }

    response.resolve({
      ...identity,
      executorId,
      agentPrincipal: '22345678-1234-1234-1234-123456789abc',
      userId: '@hermes:test',
      deviceId: 'AGENT',
      accessToken: 'late',
      expiresAt: Date.now() + 3600000
    })
    await rejected
    await closing
    expect(requestEnrollment).toHaveBeenLastCalledWith(config.domain.resource, expect.anything(), executorId, 'DELETE')
    expect(operation === 'logout' ? store.getItem('matrix-account') : read().enrollment).toBe(
      operation === 'logout' ? null : undefined
    )
  })
  it('logout stops the SDK first and retains domain authorization while agent revocation is unavailable', async () => {
    const { account, read, store } = fixture()
    await account.enrollHermes()
    const stopped = vi.fn(async () => {})
    vi.mocked(requestEnrollment).mockImplementationOnce(async () => {
      expect(stopped).toHaveBeenCalledTimes(1)
      throw new Error('network')
    })
    await expect(account.signOut(stopped)).rejects.toThrow('network')
    expect(read().signingOut).toBe(true)
    expect(read().enrollment.state).toBe('revoking')
    expect(read().domain.accessToken).toBe('domain-access')
    expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'matrix' }, 'matrix-access', expect.anything())
    expect(oidc.tokenRevocation).not.toHaveBeenCalledWith({ clientId: 'domain' }, expect.anything(), expect.anything())
    await new MatrixAccount(config, store, async () => {}).signOut()
    expect(store.getItem('matrix-account')).toBeNull()
    expect(oidc.tokenRevocation).toHaveBeenCalled()
  })
  it('renews an expired domain grant during logout solely to revoke the scoped agent', async () => {
    const { account, store, read } = fixture()
    await account.enrollHermes()
    store.setItem('matrix-account', JSON.stringify({ ...read(), domain: { ...read().domain, expiresAt: 1 } }))
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({
      access_token: 'cleanup-access',
      refresh_token: 'cleanup-refresh',
      expires_in: 300
    } as never)
    await account.signOut()
    expect(requestEnrollment).toHaveBeenLastCalledWith(
      config.domain.resource,
      expect.objectContaining({ accessToken: 'cleanup-access' }),
      expect.any(String),
      'DELETE'
    )
    expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'cleanup-refresh', expect.anything())
    expect(store.getItem('matrix-account')).toBeNull()
  })
  it('coalesces explicit revocation with logout rather than racing two cleanup requests', async () => {
    const { account, store } = fixture()
    await account.enrollHermes()
    const response = deferred<null>()
    vi.mocked(requestEnrollment).mockReturnValue(response.promise)
    const revoking = account.revokeHermes().catch(() => {})
    await vi.waitFor(() => expect(requestEnrollment).toHaveBeenCalledTimes(2))
    const signingOut = account.signOut()
    void signingOut.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 0))
    const calls = vi.mocked(requestEnrollment).mock.calls.length
    response.resolve(null)
    await Promise.allSettled([revoking, signingOut])
    expect(calls).toBe(2)
    await expect(signingOut).resolves.toBeUndefined()
    expect(store.getItem('matrix-account')).toBeNull()
  })
  it('lost cleanup authority does not trap logout: both human grants close and a token-free orphan record survives', async () => {
    const { account, store, read } = fixture()
    const enrolled = await account.enrollHermes()
    store.setItem('matrix-account', JSON.stringify({ ...read(), domain: { ...read().domain, expiresAt: 1 } }))
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(
      new oidc.ResponseBodyError('invalid_grant', {
        cause: { error: 'invalid_grant' },
        response: new Response('', { status: 400 })
      })
    )
    await account.signOut()
    expect(store.getItem('matrix-account')).toBeNull()
    expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'matrix' }, 'matrix-access', expect.anything())
    expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'domain-access', expect.anything())
    const journal = store.getItem('matrix-orphaned-enrollments')!
    expect(JSON.parse(journal)).toEqual([
      expect.objectContaining({
        executorId: enrolled.identity!.executorId,
        issuer: config.issuer,
        subject: 'alice',
        resource: config.domain.resource,
        reason: 'domain_authority_lost'
      })
    ])
    expect(journal).not.toContain('agent-only')
    expect(new MatrixAccount(config, store, async () => {}).hasOrphanedEnrollments()).toBe(true)
  })
  it('network or authentication failure during renewal keeps the same executor retryable', async () => {
    const { account, store, read } = fixture()
    const first = await account.enrollHermes()
    const record = read()
    record.enrollment.credential.expiresAt = 1
    store.setItem('matrix-account', JSON.stringify(record))

    for (const error of ['network', 'matrix_enrollment_authentication']) {
      vi.mocked(requestEnrollment).mockRejectedValueOnce(new Error(error))
      await expect(account.enrollHermes()).rejects.toThrow(error)
      expect(account.enrollment().state).toBe('pending')
      expect(read().enrollment.executorId).toBe(first.identity?.executorId)
    }

    expect((await account.enrollHermes()).identity?.executorId).toBe(first.identity?.executorId)
    expect(vi.mocked(requestEnrollment).mock.calls.every(call => call[3] === 'POST')).toBe(true)
  })
  it('does not forget an orphan if persisting its reconciliation record fails', async () => {
    const { account, store, read } = fixture()
    await account.enrollHermes()
    store.setItem('matrix-account', JSON.stringify({ ...read(), domain: { ...read().domain, expiresAt: 1 } }))
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(
      new oidc.ResponseBodyError('invalid_grant', {
        cause: { error: 'invalid_grant' },
        response: new Response('', { status: 400 })
      })
    )
    const save = store.setItem.bind(store)

    const write = vi.spyOn(store, 'setItem').mockImplementation((key, value) => {
      if (key === 'matrix-orphaned-enrollments') {
        throw new Error('disk')
      }

      save(key, value)
    })

    await expect(account.signOut()).rejects.toThrow('disk')
    expect(read().enrollment.state).toBe('revoking')
    expect(read().signingOut).toBe(true)
    write.mockRestore()
    await account.signOut()
    expect(store.getItem('matrix-account')).toBeNull()
    expect(account.hasOrphanedEnrollments()).toBe(true)
  })
  it('ready-write failure retains its pending intent and retries the same executor', async () => {
    const { account, store, read } = fixture()
    const save = store.setItem.bind(store)

    const write = vi.spyOn(store, 'setItem').mockImplementation((key, value) => {
      if (key === 'matrix-account' && JSON.parse(value).enrollment?.state === 'ready') {
        throw new Error('disk')
      }

      save(key, value)
    })

    await expect(account.enrollHermes()).rejects.toThrow('disk')
    const executorId = read().enrollment.executorId
    expect(account.enrollment().state).toBe('pending')
    write.mockRestore()
    expect((await account.enrollHermes()).identity?.executorId).toBe(executorId)
    expect(vi.mocked(requestEnrollment).mock.calls.every(call => call[3] === 'POST')).toBe(true)
  })
})

describe('first sign-in assistant provisioning', () => {
  it('provisions the assistant before the first Hermes enrollment records any intent', async () => {
    const { account } = fixture()
    await account.enrollHermes()
    expect(ensureDomainAssistant).toHaveBeenCalledTimes(1)
    expect(ensureDomainAssistant).toHaveBeenCalledWith(
      config.domain.resource,
      expect.objectContaining({ subject: 'alice' })
    )
    expect(vi.mocked(ensureDomainAssistant).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(requestEnrollment).mock.invocationCallOrder[0]!
    )
  })
  it('never provisions again for a renewal, nor for an app participant', async () => {
    const { account, store, read } = fixture()
    await account.enrollHermes()
    const expired = read()
    expired.enrollment.credential.expiresAt = Date.now() - 1
    store.setItem('matrix-account', JSON.stringify(expired))
    await account.enrollHermes()
    expect(ensureDomainAssistant).toHaveBeenCalledTimes(1)
    vi.mocked(ensureDomainAssistant).mockClear()
    const apps = appFixture()
    await apps.account.enrollApp(riverApp, true)
    expect(ensureDomainAssistant).not.toHaveBeenCalled()
  })
  it('a failed or refused provisioning leaves no pending enrollment and issues nothing', async () => {
    const { account, read } = fixture()
    vi.mocked(ensureDomainAssistant).mockRejectedValueOnce(new Error('matrix_assistant_unavailable'))
    await expect(account.enrollHermes()).rejects.toThrow('matrix_assistant_unavailable')
    vi.mocked(ensureDomainAssistant).mockResolvedValueOnce(null)
    await expect(account.enrollHermes()).rejects.toThrow('matrix_assistant_unavailable')
    expect(read().enrollment).toBeUndefined()
    expect(requestEnrollment).not.toHaveBeenCalled()
  })
  it('launch-time setup needs an existing grant and never opens the browser', async () => {
    const { account, open } = fixture(false)
    await expect(account.enrollHermes(false)).rejects.toThrow('matrix_domain_connection_required')
    expect(open).not.toHaveBeenCalled()
    expect(authorizeNative).not.toHaveBeenCalled()
    expect(ensureDomainAssistant).not.toHaveBeenCalled()
  })
  it('sign-out while provisioning drops the result without recording an enrollment', async () => {
    const { account, read } = fixture()
    const provisioned = deferred<{ agentPrincipal: string; matrixUser: string } | null>()
    vi.mocked(ensureDomainAssistant).mockReturnValueOnce(provisioned.promise)
    const acquiring = account.enrollHermes()
    const rejected = expect(acquiring).rejects.toThrow()
    await vi.waitFor(() => expect(ensureDomainAssistant).toHaveBeenCalled())
    account.cancel()
    provisioned.resolve({ agentPrincipal: identity.principal, matrixUser: '@agent:test' })
    await rejected
    expect(requestEnrollment).not.toHaveBeenCalled()
    expect(read()?.enrollment).toBeUndefined()
  })
})

describe('managed model credentials', () => {
  it('derives one stable local key per ready Hermes executor, and none before enrollment', async () => {
    const { account } = fixture()
    expect(account.managedModelKey()).toBeNull()
    await account.enrollHermes()
    const key = account.managedModelKey()
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(account.managedModelKey()).toBe(key)
    expect(key).not.toContain('agent-only')
  })
  it('hands the proxy the current domain token without a browser, and nothing when signed out', async () => {
    const { account, open } = fixture()
    expect(await account.managedModelBearer()).toBe(grant.accessToken)
    const signedOut = fixture(false)
    expect(await signedOut.account.managedModelBearer()).toBeNull()
    expect(open).not.toHaveBeenCalled()
    expect(signedOut.open).not.toHaveBeenCalled()
    expect(authorizeNative).not.toHaveBeenCalled()
  })
  it('hands Drive the same access token, rotates it only when due or when the refused token is current, and keeps the refresh token here', async () => {
    const { account, open, read, store } = fixture()
    expect(await account.driveCredential()).toEqual({ accessToken: grant.accessToken })
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
      access_token: 'domain-rotated',
      refresh_token: 'domain-refresh-2',
      expires_in: 300
    } as never)
    const rotated = await account.driveCredential(grant.accessToken)
    expect(rotated).toEqual({ accessToken: 'domain-rotated', expiresAt: expect.any(Number) })
    expect(read().domain).toMatchObject({ accessToken: 'domain-rotated', refreshToken: 'domain-refresh-2' })
    expect(JSON.stringify(rotated)).not.toContain('domain-refresh')
    // A save with no expiry is still fresh: nothing rotates until the engine asks or it is due.
    vi.mocked(oidc.refreshTokenGrant).mockClear()
    expect(await account.driveCredential()).toEqual({ accessToken: 'domain-rotated', expiresAt: expect.any(Number) })
    expect(oidc.refreshTokenGrant).not.toHaveBeenCalled()
    // A refused token another caller already rotated is not rotated a second time.
    expect(await account.driveCredential(grant.accessToken)).toEqual({
      accessToken: 'domain-rotated',
      expiresAt: expect.any(Number)
    })
    expect(oidc.refreshTokenGrant).not.toHaveBeenCalled()
    // Due within the freshness window rotates without a browser.
    const due = read()
    due.domain.expiresAt = Date.now() + 1_000
    store.setItem('matrix-account', JSON.stringify(due))
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'domain-due', expires_in: 300 } as never)
    expect((await account.driveCredential()).accessToken).toBe('domain-due')
    expect(open).not.toHaveBeenCalled()
    expect(authorizeNative).not.toHaveBeenCalled()
    const signedOut = fixture(false)
    expect(await signedOut.account.driveCredential()).toBeNull()
    expect(signedOut.open).not.toHaveBeenCalled()
    // A rotated token the platform does not resolve to this sign-in is never handed to the engine.
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'domain-check', expires_in: 300 } as never)
    vi.mocked(readDomainIdentity).mockResolvedValueOnce(null)
    expect(await account.driveCredential('domain-due')).toBeNull()
  })
  it('refuses a Drive token that no longer resolves to the identity the engine pinned at start', async () => {
    const { account } = fixture()
    const pinned = { issuer: config.issuer, subject: 'alice' }
    // A working token for the pinned person is handed over (no rotation was needed).
    vi.mocked(readDomainIdentity).mockResolvedValueOnce(identity)
    expect(await account.driveCredential('domain-replaced', pinned)).toEqual({
      accessToken: grant.accessToken
    })
    expect(vi.mocked(readDomainIdentity).mock.calls.at(-1)?.[1]).toMatchObject({ issuer: config.issuer, subject: 'alice' })
    // A definitive answer for another subject is refused, and the grant is not rotated to hide it.
    vi.mocked(oidc.refreshTokenGrant).mockClear()
    vi.mocked(readDomainIdentity).mockResolvedValueOnce({ ...identity, subject: 'mallory' })
    expect(await account.driveCredential(undefined, pinned)).toBeNull()
    expect(oidc.refreshTokenGrant).not.toHaveBeenCalled()
    // A platform that cannot answer does not strand an otherwise fresh grant (the engine may
    // simply start offline); only a definitive wrong answer does.
    vi.mocked(readDomainIdentity).mockRejectedValueOnce(new Error('matrix_domain_unavailable'))
    expect(await account.driveCredential(undefined, pinned)).toEqual({ accessToken: grant.accessToken })
  })
})

describe('one-trip sign-in', () => {
  /**
   * `domain` lists how each domain authorization goes, in order: `ok` lands, `other` is
   * another person's browser session, `unprepared` cannot even start (discovery or port).
   * `mas` answers the entry probe of `/authorize` (sign-in-entry.ts); by default it is not
   * MAS, so the browser opens the plain authorization URL.
   */
  function signInFixture(
    domain: Array<'ok' | 'other' | 'unprepared'> = ['ok'],
    mas: (url: string) => Response = () => new Response('not found', { status: 404 }),
    domainContinuation?: {
      continueTo(): string | undefined | Promise<string | undefined>
      cancel(): void
    }
  ) {
    const directory = mkdtempSync(path.join(tmpdir(), 'atum-one-trip-'))
    directories.push(directory)

    const store = new EncryptedStore(path.join(directory, 'vault.json'), {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString()
    })

    const open = vi.fn(async (_url: string) => {})
    const log = vi.fn()
    const returned = vi.fn()

    const account = new MatrixAccount(
      config,
      store,
      open,
      vi.fn(async () => {}),
      vi.fn(async () => {}),
      log,
      { returned, ...(domainContinuation ? { domainContinuation } : {}) }
    )

    const flows = {
      matrixCancel: vi.fn(),
      domainCancel: vi.fn(),
      continued: undefined as string | undefined,
      domainContinued: undefined as string | undefined,
      returnedBeforeCommit: 0
    }

    const outcomes = [...domain]
    let deviceId = ''
    let domainAttempts = 0
    let browserReachesDomain!: () => void
    const redirected = new Promise<void>(resolve => (browserReachesDomain = resolve))

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        String(input).startsWith(config.issuer) ? mas(String(input)) : Response.json({ user_id: '@alice:test', device_id: deviceId })
      )
    )
    vi.mocked(authorizeNative).mockImplementation(async options => {
      if (options.scope === 'openid') {
        const outcome = outcomes.shift() ?? 'other'

        if (outcome === 'unprepared') {
          throw new Error('matrix_identity_unavailable')
        }

        const attempt = ++domainAttempts

        const completed = redirected.then(async () => {
          const value = { ...grant, subject: outcome === 'ok' ? 'alice' : 'mallory' }
          let prepared

          try {
            prepared = await options.prepare(value)
            options.commit(prepared)
          } catch (error) {
            await options.discard(value)
            throw error
          }

          try {
            flows.domainContinued = await options.continueTo?.()
          } catch {
            // As authorization.ts: a failed continuation never fails the committed domain grant.
          }

          return prepared
        })

        void completed.catch(() => {})

        return {
          authorizationUrl: `https://id.test/authorize?client=domain&attempt=${attempt}`,
          completed,
          cancel: flows.domainCancel
        }
      }

      deviceId = /device:(\S+)/.exec(options.scope)![1]!

      const completed = Promise.resolve().then(async () => {
        const issued = {
          issuer: config.issuer,
          subject: 'alice',
          accessToken: 'matrix-access',
          refreshToken: 'matrix-refresh'
        }

        // As authorization.ts: the callback is announced before the code is redeemed.
        options.onCallback?.()
        flows.returnedBeforeCommit = returned.mock.calls.length
        const prepared = await options.prepare(issued)

        // As authorization.ts: a grant its commit refused is revoked by the caller's discard.
        try {
          options.commit(prepared)
        } catch (error) {
          await options.discard(issued)
          throw error
        }

        flows.continued = await options.continueTo?.()
        browserReachesDomain() // the browser follows the redirect in the same tab

        return prepared
      })

      void completed.catch(() => {})

      return {
        authorizationUrl: `https://id.test/authorize?client=matrix${options.prompt ? `&prompt=${options.prompt}` : ''}`,
        completed,
        cancel: flows.matrixCancel
      }
    })

    const domainAuthorizations = () => vi.mocked(authorizeNative).mock.calls.filter(([o]) => o.scope === 'openid')

    return {
      account,
      open,
      flows,
      log,
      returned,
      store,
      domainAuthorizations,
      read: () => JSON.parse(store.getItem('matrix-account')!)
    }
  }

  it('signs in to Matrix and the domain in one browser trip', async () => {
    const { account, open, flows, read } = signInFixture()
    await expect(account.signIn()).resolves.toEqual({ domain: true })
    expect(open).toHaveBeenCalledTimes(1)
    expect(flows.continued).toBe('https://id.test/authorize?client=domain&attempt=1')
    expect(read().userId).toBe('@alice:test')
    expect(read().domain.accessToken).toBe('domain-access')
  })
  it('continues the domain callback to Drive in the same browser tab', async () => {
    const domainContinuation = {
      continueTo: vi.fn(async () => 'https://id.test/authorize?client=drive'),
      cancel: vi.fn()
    }

    const { account, open, flows } = signInFixture(['ok'], undefined, domainContinuation)
    await expect(account.signIn()).resolves.toEqual({ domain: true })
    expect(open).toHaveBeenCalledTimes(1)
    expect(flows.continued).toBe('https://id.test/authorize?client=domain&attempt=1')
    expect(flows.domainContinued).toBe('https://id.test/authorize?client=drive')
    expect(domainContinuation.continueTo).toHaveBeenCalledOnce()
  })
  it('brings the app to the front the moment the browser is back, before the code is redeemed', async () => {
    const { account, flows, returned } = signInFixture()
    await expect(account.signIn()).resolves.toEqual({ domain: true })
    expect(flows.returnedBeforeCommit).toBe(1)
    expect(returned).toHaveBeenCalledTimes(1)
  })
  it('never links a domain grant for another person, and the Matrix sign-in stands', async () => {
    const { account, read } = signInFixture(['other', 'other'])
    await expect(account.signIn()).resolves.toEqual({ domain: false })
    expect(read().userId).toBe('@alice:test')
    expect(read().domain).toBeUndefined()
  })
  it('cancelling the sign-in cancels both steps', async () => {
    const domainContinuation = { continueTo: vi.fn(async () => undefined), cancel: vi.fn() }
    const { account, open, flows } = signInFixture(['ok'], undefined, domainContinuation)
    open.mockImplementationOnce(async () => account.cancel())
    await expect(account.signIn()).rejects.toThrow()
    expect(flows.matrixCancel).toHaveBeenCalled()
    expect(flows.domainCancel).toHaveBeenCalled()
    expect(domainContinuation.continueTo).not.toHaveBeenCalled()
    expect(domainContinuation.cancel).toHaveBeenCalled()
  })
  it('retries preparing the Atum account step, so the one trip still carries it', async () => {
    const { account, open, flows, read, domainAuthorizations } = signInFixture(['unprepared', 'ok'])
    await expect(account.signIn()).resolves.toEqual({ domain: true })
    expect(domainAuthorizations()).toHaveLength(2)
    expect(flows.continued).toBe('https://id.test/authorize?client=domain&attempt=1')
    expect(open).toHaveBeenCalledTimes(1)
    expect(read().domain.accessToken).toBe('domain-access')
  })
  it('never opens the browser a second time over the app: setup asks for the Atum account there', async () => {
    const { account, open, read, domainAuthorizations } = signInFixture(['other', 'ok'])
    await expect(account.signIn()).resolves.toEqual({ domain: false })
    expect(open).toHaveBeenCalledTimes(1)
    expect(domainAuthorizations()).toHaveLength(1)
    expect(read().userId).toBe('@alice:test')
    expect(read().domain).toBeUndefined()
  })
  it('waits at most two seconds at the callback for the Atum account step, then ends the tab on Atum', async () => {
    vi.useFakeTimers()

    try {
      // Preparing it fails three times (discovery or its port), past the two seconds.
      const { account, open, flows, read } = signInFixture(['unprepared', 'unprepared', 'unprepared', 'ok'])
      const signedIn = account.signIn()
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(signedIn).resolves.toEqual({ domain: false })
      expect(flows.continued).toBeUndefined()
      expect(open).toHaveBeenCalledTimes(1)
      expect(read().userId).toBe('@alice:test')
      expect(read().domain).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
  it("opens the chosen way in: Google's picker, MAS's sign-in page, or its registration page", async () => {
    const grantId = '01K6ZQ3W4X5Y6Z7A8B9C0D1E2F'
    const page = (url: string) => (new URL(url).searchParams.get('prompt') === 'create' ? '/register' : '/login')

    const mas = (url: string) =>
      new URL(url).pathname === '/authorize'
        ? new Response(null, {
            status: 303,
            headers: { location: `${page(url)}?kind=continue_authorization_grant&id=${grantId}` }
          })
        : new Response('<a href="/upstream/authorize/01J00000000000000000000005?x">Google</a>', { status: 200 })

    for (const [method, expected] of [
      ['google', `https://id.test/upstream/authorize/01J00000000000000000000005?kind=continue_authorization_grant&id=${grantId}`],
      ['email', `https://id.test/login?kind=continue_authorization_grant&id=${grantId}`],
      ['create', `https://id.test/register?kind=continue_authorization_grant&id=${grantId}`]
    ] as const) {
      const { account, open } = signInFixture(['ok'], mas)
      await account.signIn(method)
      expect(open.mock.calls[0]![0]).toBe(expected)
      await account.signOut()
      vi.mocked(authorizeNative).mockClear()
    }
  })
  it('says why before revoking a new sign-in the vault could not save', async () => {
    const { account, store, log } = signInFixture()
    const write = store.setItem.bind(store)

    vi.spyOn(store, 'setItem').mockImplementation((key, value) => {
      if (key === 'matrix-account') {
        throw new Error('auth_storage_write_failed')
      }

      write(key, value)
    })

    await expect(account.signIn()).rejects.toThrow()
    const events = log.mock.calls.map(([event]) => event)
    const saveFailed = events.findIndex(event => event.event === 'credential_save_failed')
    const revoked = events.findIndex(event => event.event === 'grant_revoked' && event.reason === 'sign_in_cancelled')
    expect(saveFailed).toBeGreaterThanOrEqual(0)
    expect(events[saveFailed]).toEqual({ event: 'credential_save_failed', client: 'matrix', code: 'auth_storage_write_failed' })
    expect(revoked).toBeGreaterThan(saveFailed)
    expect(oidc.tokenRevocation).toHaveBeenCalledWith(expect.anything(), 'matrix-refresh', expect.anything())
  })
  it('opens the password registration form for a new account when the server takes new accounts by email', async () => {
    const grantId = '01K6ZQ3W4X5Y6Z7A8B9C0D1E2F'
    vi.mocked(oidc.discovery).mockImplementation(
      async (_url, clientId) =>
        ({ clientId, serverMetadata: () => ({ prompt_values_supported: ['login', 'create'] }) }) as never
    )

    const mas = (url: string) =>
      new URL(url).pathname === '/authorize'
        ? new Response(null, { status: 303, headers: { location: `/register?kind=continue_authorization_grant&id=${grantId}` } })
        : new Response('MAS chooser', { status: 200 })

    const { account, open } = signInFixture(['ok'], mas)
    await account.signIn('create')
    expect(open.mock.calls[0]![0]).toBe(
      `https://id.test/register/password?kind=continue_authorization_grant&id=${grantId}`
    )
  })
  it('opens no browser when email was chosen but the server has no passwords', async () => {
    const mas = (url: string) =>
      new URL(url).pathname === '/authorize'
        ? new Response(null, {
            status: 303,
            headers: { location: '/login?kind=continue_authorization_grant&id=01K6ZQ3W4X5Y6Z7A8B9C0D1E2F' }
          })
        : new Response(null, { status: 303, headers: { location: '/upstream/authorize/01J00000000000000000000005' } })

    const { account, open, flows } = signInFixture(['ok'], mas)
    await expect(account.signIn('email')).rejects.toThrow('matrix_password_unavailable')
    expect(open).not.toHaveBeenCalled()
    // Both loopback listeners close: no callback can complete a sign-in nobody started.
    expect(flows.matrixCancel).toHaveBeenCalled()
    expect(flows.domainCancel).toHaveBeenCalled()
  })
})

// Several agents per person ( §2.2).
const alfred = '00000000-0000-4000-8000-63804d107579'
const bea = '00000000-0000-4000-8000-6c8dbd6d95b3'

function agentsFixture() {
  const f = fixture()
  const issue = vi.mocked(requestEnrollment).getMockImplementation()!
  vi.mocked(requestEnrollment).mockImplementation(
    async (resource, domainGrant, executorId, method, app, agentPrincipal) => {
      const common = await issue(resource, domainGrant, executorId, method)

      if (
        method === 'DELETE' ||
        agentPrincipal === undefined ||
        agentPrincipal === '22345678-1234-1234-1234-123456789abc'
      ) {
        return common
      }

      return {
        ...(common as object),
        agentPrincipal,
        userId: `@${agentPrincipal.slice(-4)}:test`,
        deviceId: `AGENT-${agentPrincipal.slice(-4)}`,
        accessToken: `${agentPrincipal.slice(-4)}-only`
      }
    }
  )

  return f
}

describe('signing in again over an ended session ', () => {
  const refused = (code = 'invalid_grant') =>
    new oidc.ResponseBodyError(code, { cause: { error: code }, response: new Response('', { status: 400 }) })

  /** The Atum account step in the tab: it commits when the test says (or never). */
  function tab() {
    let resolve!: () => void
    let reject!: (error: Error) => void

    const promise = new Promise<void>((done, fail) => {
      resolve = done
      reject = fail
    })

    void promise.catch(() => {})

    return { promise, resolve, reject }
  }

  /** Everything this Mac keeps for the person (the Atum account sign-in, an agent with its
   * home, the remembered recovery key), and then the sign-in server ending the chat session. */
  async function ended() {
    const f = fixture()
    const log = vi.fn()
    const account = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice, log)
    await account.enrollHermes()
    account.retainHermesProfile('/fixture/original-profile')
    account.recoveryKey(account.identity()!, 'synthetic-remembered-key')
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(refused())
    expect((await account.refresh(account.sdkConfiguration().refreshToken)).ok).toBe(false)
    expect(account.identity()).toBeNull()
    vi.mocked(oidc.refreshTokenGrant).mockReset()

    return { ...f, account, log, before: f.read() }
  }

  /** The browser trip, answered as `subject`: the chat sign-in, then (if asked for) the Atum
   * account authorization in the same tab. */
  function browserAs(subject: string, userId = `@${subject}:test`, domainGate: Promise<void> = Promise.resolve()) {
    let deviceId = ''
    let reachDomain!: () => void
    const redirected = new Promise<void>(resolve => (reachDomain = resolve)).then(() => domainGate)

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        String(input).startsWith(config.issuer)
          ? new Response('not found', { status: 404 })
          : Response.json({ user_id: userId, device_id: deviceId })
      )
    )
    vi.mocked(authorizeNative).mockImplementation(async options => {
      const domainStep = options.scope === 'openid'

      if (!domainStep) {
        deviceId = /device:(\S+)/.exec(options.scope)![1]!
      }

      const value = domainStep
        ? { ...grant, subject, accessToken: 'domain-again', refreshToken: 'domain-again-refresh' }
        : { issuer: config.issuer, subject, accessToken: 'matrix-again', refreshToken: 'matrix-again-refresh' }

      const completed = (domainStep ? redirected : Promise.resolve()).then(async () => {
        let prepared: Awaited<ReturnType<typeof options.prepare>>

        try {
          prepared = await options.prepare(value)
          options.commit(prepared)
        } catch {
          await options.discard(value)

          throw new Error('matrix_login_failed')
        } finally {
          if (!domainStep) {
            reachDomain()
          }
        }

        // As authorization.ts: the tab goes on to the next step, if any, after the commit.
        await options.continueTo?.()

        return prepared
      })

      void completed.catch(() => {})

      return {
        authorizationUrl: `https://id.test/authorize?client=${domainStep ? 'domain' : 'matrix'}`,
        completed,
        cancel: vi.fn()
      }
    })

    return { device: () => deviceId }
  }

  it('resumes the same person on the same record: a new device and keys, everything else kept', async () => {
    const { account, read, before, open, log } = await ended()
    const browser = browserAs('alice', '@alice:test')
    // The Atum account sign-in proves itself with one rotation before the browser opens.
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
      access_token: 'domain-proved',
      refresh_token: 'domain-proved-refresh',
      expires_in: 300
    } as never)

    await expect(account.signIn()).resolves.toEqual({ domain: true, replaced: { userId: '@alice:test', deviceId: 'A' } })
    const after = read()
    expect(after.sessionEnded).toBeUndefined()
    expect(after).toMatchObject({
      userId: '@alice:test',
      deviceId: browser.device(),
      accessToken: 'matrix-again',
      refreshToken: 'matrix-again-refresh',
      domain: { ...before.domain, accessToken: 'domain-proved', refreshToken: 'domain-proved-refresh' },
      enrollment: before.enrollment,
      localHermes: before.localHermes,
      ownerRecoveryKey: 'synthetic-remembered-key'
    })
    expect(after.storageKey).not.toBe(before.storageKey)
    expect(Buffer.from(after.storageKey, 'base64')).toHaveLength(32)
    expect(account.identity()).toEqual({ userId: '@alice:test', deviceId: browser.device() })
    expect(account.sessionEnded()).toBeNull()
    // The new device takes its keys back with the remembered one: no recovery step.
    expect(account.recoveryKey(account.identity()!)).toBe('synthetic-remembered-key')
    // One trip, for the chats only: the Atum account sign-in carried over, and the agent with it.
    expect(open).toHaveBeenCalledTimes(1)
    expect(vi.mocked(authorizeNative).mock.calls.filter(([options]) => options.scope === 'openid')).toHaveLength(0)
    expect(account.enrollment().state).toBe('ready')
    expect(await account.readDomain()).toEqual(identity)
    // The ended grant is revoked behind the new one, best effort (dead already: MAS answers 200);
    // the Atum account sign-in it kept is not.
    await vi.waitFor(() =>
      expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'matrix' }, 'matrix-refresh', expect.anything())
    )
    expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'matrix-again-refresh', expect.anything())
    expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'domain-proved-refresh', expect.anything())
    expect(log).toHaveBeenCalledWith({ event: 'grant_revoked', client: 'matrix', reason: 'session_replaced' })
  })

  it.each([
    ['the network', () => new TypeError('fetch failed')],
    [
      'a 5xx',
      () =>
        Object.assign(new Error('unexpected HTTP response status code'), {
          code: 'OAUTH_RESPONSE_IS_NOT_CONFORM',
          cause: new Response('', { status: 503 })
        })
    ],
    ['invalid_client', () => refused('invalid_client')]
  ])(
    'asks for the Atum account again in the same trip when %s keeps it from proving itself, revoking the old one only once the new one is saved',
    async (_cause, failure) => {
      const { account, read, before } = await ended()
      const gate = tab()
      browserAs('alice', '@alice:test', gate.promise)
      vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(failure())

      const signingIn = account.signIn()
      // The chats are signed in again; the Atum account step is still in the tab.
      await vi.waitFor(() => expect(read().accessToken).toBe('matrix-again'))
      expect(read().domain).toEqual(before.domain)
      // Nothing says the old one ended: it is still the person's only Atum account sign-in.
      await vi.waitFor(() =>
        expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'matrix' }, 'matrix-refresh', expect.anything())
      )
      expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'domain-refresh', expect.anything())
      expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'domain-access', expect.anything())

      gate.resolve()
      await expect(signingIn).resolves.toEqual({ domain: true, replaced: { userId: '@alice:test', deviceId: 'A' } })
      expect(read().domain).toMatchObject({ accessToken: 'domain-again', refreshToken: 'domain-again-refresh' })
      expect(read().domain.sessionId).not.toBe(before.domain.sessionId)
      expect(read().enrollment).toEqual(before.enrollment)
      await vi.waitFor(() =>
        expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'domain-refresh', expect.anything())
      )
      expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'domain-again-refresh', expect.anything())
    }
  )

  it('keeps the old Atum account sign-in, unrevoked, when it could not prove itself and the new one never lands', async () => {
    const { account, read, before } = await ended()
    const gate = tab()
    browserAs('alice', '@alice:test', gate.promise)
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(new TypeError('fetch failed'))

    const signingIn = account.signIn()
    await vi.waitFor(() => expect(read().accessToken).toBe('matrix-again'))
    // The person closes the tab before the Atum account step: it never commits.
    gate.reject(new Error('matrix_login_failed'))

    await expect(signingIn).resolves.toEqual({ domain: false, replaced: { userId: '@alice:test', deviceId: 'A' } })
    expect(read().domain).toEqual(before.domain)
    expect(read().enrollment).toEqual(before.enrollment)
    await account.drainRevocations()
    expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'domain-refresh', expect.anything())
    expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'domain-access', expect.anything())
    // Once the sign-in server answers again, the agents carry on with it.
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
      access_token: 'domain-later',
      refresh_token: 'domain-later-refresh',
      expires_in: 300
    } as never)
    vi.mocked(readDomainIdentity).mockResolvedValueOnce(null).mockResolvedValue(identity)
    expect(await account.readDomain(false)).toEqual(identity)
    expect(read().domain).toMatchObject({ sessionId: before.domain.sessionId, refreshToken: 'domain-later-refresh' })
  })

  it('never revokes a slow proof that lands late into the record, and revokes it once the new sign-in replaces it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const { account, read, before } = await ended()
      const gate = tab()
      browserAs('alice', '@alice:test', gate.promise)
      const proof = deferred<never>()
      vi.mocked(oidc.refreshTokenGrant).mockReturnValueOnce(proof.promise)

      const signingIn = account.signIn()
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.waitFor(() => expect(read().accessToken).toBe('matrix-again'))
      expect(read().domain).toEqual(before.domain)

      // The proof answers after the chats are signed in again: saved, the record's own.
      proof.resolve({ access_token: 'domain-late', refresh_token: 'domain-late-refresh', expires_in: 300 } as never)
      await vi.waitFor(() => expect(read().domain).toMatchObject({ refreshToken: 'domain-late-refresh' }))
      await account.drainRevocations()
      expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'domain-late-refresh', expect.anything())
      expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'domain-refresh', expect.anything())

      gate.resolve()
      await expect(signingIn).resolves.toMatchObject({ domain: true })
      expect(read().domain).toMatchObject({ refreshToken: 'domain-again-refresh' })
      // Replaced by the new one, saved first: the late rotation is revoked behind it.
      await vi.waitFor(() =>
        expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'domain-late-refresh', expect.anything())
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('a late proof that lands after the new sign-in is revoked, never written over it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const { account, read } = await ended()
      browserAs('alice')
      const proof = deferred<never>()
      vi.mocked(oidc.refreshTokenGrant).mockReturnValueOnce(proof.promise)

      const signingIn = account.signIn()
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(signingIn).resolves.toMatchObject({ domain: true })
      expect(read().domain).toMatchObject({ refreshToken: 'domain-again-refresh' })

      proof.resolve({ access_token: 'domain-late', refresh_token: 'domain-late-refresh', expires_in: 300 } as never)
      await vi.waitFor(() =>
        expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'domain-late-refresh', expect.anything())
      )
      expect(read().domain).toMatchObject({ refreshToken: 'domain-again-refresh' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a slow proof the server refuses after the chats are saved is replaced by the Atum account step of the same trip', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const { account, read, before } = await ended()
      const gate = tab()
      browserAs('alice', '@alice:test', gate.promise)
      const proof = tab()
      vi.mocked(oidc.refreshTokenGrant).mockReturnValueOnce(proof.promise.then(() => Promise.reject(refused())) as never)

      const signingIn = account.signIn()
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.waitFor(() => expect(read().accessToken).toBe('matrix-again'))
      expect(read().domain).toEqual(before.domain)

      // Refused once the chats are signed in again, while the Atum account step is still in the
      // tab: that step is the person's own sign-in, and it replaces the refused one.
      proof.resolve()
      await vi.advanceTimersByTimeAsync(10)
      gate.resolve()

      await expect(signingIn).resolves.toEqual({ domain: true, replaced: { userId: '@alice:test', deviceId: 'A' } })
      expect(read().domain).toMatchObject({ refreshToken: 'domain-again-refresh' })
      expect(read().domain.sessionId).not.toBe(before.domain.sessionId)
      expect(await account.readDomain(false)).toEqual(identity)
      await vi.waitFor(() =>
        expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'domain-refresh', expect.anything())
      )
      expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'domain-again-refresh', expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it('a slow proof the server refuses after the new Atum account sign-in is saved never ends that one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const { account, read, log } = await ended()
      browserAs('alice')
      const proof = tab()
      vi.mocked(oidc.refreshTokenGrant).mockReturnValueOnce(proof.promise.then(() => Promise.reject(refused())) as never)

      const signingIn = account.signIn()
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(signingIn).resolves.toMatchObject({ domain: true })

      // The refusal is of the sign-in the new one replaced: the agents go on with the new one.
      proof.resolve()
      await vi.advanceTimersByTimeAsync(10)
      expect(read().domain).toMatchObject({ refreshToken: 'domain-again-refresh' })
      expect(() => account.agentSdkConfiguration()).not.toThrow()
      expect(await account.readDomain(false)).toEqual(identity)
      expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'session_ended', client: 'domain' }))
      await account.drainRevocations()
      expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'domain-again-refresh', expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it('says the Atum account is not signed in when the proved sign-in is refused before the chats are saved', async () => {
    const { account, store, read, before } = await ended()
    browserAs('alice')
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
      access_token: 'domain-proved',
      refresh_token: 'domain-proved-refresh',
      expires_in: 300
    } as never)
    const whoami = vi.mocked(fetch).getMockImplementation()!

    // While the person is in the browser, an agent's renewal finds the proved sign-in refused.
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes('/whoami') && read().domain?.expiresAt !== 1) {
        store.setItem('matrix-account', JSON.stringify({ ...read(), domain: { ...read().domain, expiresAt: 1 } }))
        vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(refused())
        await expect(account.readDomain(false)).rejects.toThrow('matrix_domain_signed_out')
      }

      return whoami(input, init)
    })

    await expect(account.signIn()).resolves.toEqual({ domain: false, replaced: { userId: '@alice:test', deviceId: 'A' } })
    expect(read().accessToken).toBe('matrix-again')
    expect(read().domain).toBeUndefined()
    expect(read().enrollment).toEqual(before.enrollment)
  })

  it('opens the browser after two seconds when a queued revocation is never answered, the drain going on behind it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const { account, store, open } = await ended()
      browserAs('alice')
      store.setItem(
        'matrix-revocations',
        JSON.stringify([{ issuer: config.issuer, subject: 'alice', accessToken: 'stuck', refreshToken: 'stuck-refresh', clientId: 'matrix' }])
      )
      vi.mocked(oidc.tokenRevocation).mockImplementation(async (_config, token) => {
        if (String(token).startsWith('stuck')) {
          await new Promise(() => {})
        }
      })
      vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
        access_token: 'domain-proved',
        refresh_token: 'domain-proved-refresh',
        expires_in: 300
      } as never)

      const outcome = Promise.race([
        account.signIn().then(result => result),
        new Promise(resolve => setTimeout(() => resolve('held up'), 30_000))
      ])

      await vi.advanceTimersByTimeAsync(30_000)
      await expect(outcome).resolves.toMatchObject({ domain: true })
      expect(open).toHaveBeenCalledTimes(1)
      // Still queued for the next drain, never dropped by the sign-in.
      expect(JSON.parse(store.getItem('matrix-revocations')!)).toEqual(
        expect.arrayContaining([expect.objectContaining({ refreshToken: 'stuck-refresh' })])
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('revokes an Atum account sign-in the new one replaced at once when the vault cannot queue it', async () => {
    const { account, store, read } = await ended()
    const gate = tab()
    browserAs('alice', '@alice:test', gate.promise)
    // The old one cannot prove itself (offline for a moment): it is live, not refused.
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(new TypeError('fetch failed'))
    const write = store.setItem.bind(store)

    vi.spyOn(store, 'setItem').mockImplementation((key, value) => {
      if (key === 'matrix-revocations') {
        throw new Error('auth_storage_write_failed')
      }

      write(key, value)
    })

    gate.resolve()
    await expect(account.signIn()).resolves.toMatchObject({ domain: true })
    expect(read().domain).toMatchObject({ refreshToken: 'domain-again-refresh' })
    await vi.waitFor(() =>
      expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'domain-refresh', expect.anything())
    )
    expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'domain-access', expect.anything())
    expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'domain-again-refresh', expect.anything())
  })

  it.each([
    ['saved with the chats’ sign-in, and kept when the new one never lands', 'never'],
    ['saved, then revoked once the new sign-in replaces it', 'lands'],
    ['still held when the new sign-in replaces it, and revoked with it', 'lands-held']
  ] as const)('a proof rotation the vault could not keep is %s', async (_case, mode) => {
    const { account, read, store, before } = await ended()
    const gate = tab()
    browserAs('alice', '@alice:test', gate.promise)
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
      access_token: 'domain-held',
      refresh_token: 'domain-held-refresh',
      expires_in: 300
    } as never)
    const write = store.setItem.bind(store)

    const full = () => {
      throw new Error('auth_storage_write_failed')
    }

    // The proof's rotation finds the disk full; the sign-in's own write a moment later has room,
    // and (lands-held) the save of the held rotation right after it does not.
    const disk = vi.spyOn(store, 'setItem').mockImplementationOnce(full).mockImplementationOnce(write)

    if (mode === 'lands-held') {
      disk.mockImplementationOnce(full)
      // The new sign-in lands right behind the chats' one, before any retry of the save.
      gate.resolve()
    }

    const signingIn = account.signIn()
    await vi.waitFor(() => expect(read().accessToken).toBe('matrix-again'))
    disk.mockRestore()

    if (mode === 'never') {
      expect(read().domain).toMatchObject({ sessionId: before.domain.sessionId, refreshToken: 'domain-held-refresh' })
      gate.reject(new Error('matrix_login_failed'))
      await expect(signingIn).resolves.toMatchObject({ domain: false })
      await account.drainRevocations()
      expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'domain-held-refresh', expect.anything())
      expect(read().domain).toMatchObject({ refreshToken: 'domain-held-refresh' })

      return
    }

    if (mode === 'lands') {
      expect(read().domain).toMatchObject({ refreshToken: 'domain-held-refresh' })
      gate.resolve()
    }

    await expect(signingIn).resolves.toMatchObject({ domain: true })
    expect(read().domain).toMatchObject({ refreshToken: 'domain-again-refresh' })
    await vi.waitFor(() =>
      expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'domain-held-refresh', expect.anything())
    )

    if (mode === 'lands-held') {
      expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'domain' }, 'domain-refresh', expect.anything())
    }
  })

  it('signs in again even when a queued revocation is refused by the server every time', async () => {
    const { account, store, read } = await ended()
    browserAs('alice')
    store.setItem(
      'matrix-revocations',
      JSON.stringify([{ issuer: config.issuer, subject: 'alice', accessToken: 'stuck', refreshToken: 'stuck-refresh', clientId: 'matrix' }])
    )
    vi.mocked(oidc.tokenRevocation).mockImplementation(async (_config, token) => {
      if (String(token).startsWith('stuck')) {
        throw refused('invalid_client')
      }
    })
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
      access_token: 'domain-proved',
      refresh_token: 'domain-proved-refresh',
      expires_in: 300
    } as never)

    await expect(account.signIn()).resolves.toMatchObject({ domain: true })
    expect(read().accessToken).toBe('matrix-again')
  })

  it("refuses another person's account: the ended record stays, and only the new grant is revoked", async () => {
    const { account, read, before, log } = await ended()
    browserAs('mallory')

    await expect(account.signIn()).rejects.toThrow('matrix_account_mismatch')
    expect(read()).toEqual(before)
    expect(account.sessionEnded()).toMatchObject({ cause: 'refresh_rejected:invalid_grant' })
    expect(oidc.tokenRevocation).toHaveBeenCalledWith({ clientId: 'matrix' }, 'matrix-again-refresh', expect.anything())
    expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(expect.anything(), 'domain-refresh', expect.anything())
    expect(log).toHaveBeenCalledWith({ event: 'grant_revoked', client: 'matrix', reason: 'account_mismatch' })
  })

  it('asks for the Atum account again in the same trip when that sign-in ended too, keeping the agents', async () => {
    const { account, store, read, before } = await ended()
    store.setItem('matrix-account', JSON.stringify({ ...read(), domain: { ...read().domain, expiresAt: 1 } }))
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(refused())
    await expect(account.readDomain()).rejects.toThrow('matrix_domain_signed_out')
    browserAs('alice')

    await expect(account.signIn()).resolves.toEqual({ domain: true, replaced: { userId: '@alice:test', deviceId: 'A' } })
    expect(read().domain).toMatchObject({ accessToken: 'domain-again', refreshToken: 'domain-again-refresh' })
    expect(read().domain.sessionId).not.toBe('domain-session')
    expect(read().enrollment).toEqual(before.enrollment)
    expect(read().localHermes).toEqual(before.localHermes)
    expect(await account.readDomain()).toEqual(identity)
  })

  it('still asks for a sign-out first over a live session', async () => {
    const { account } = fixture()

    await expect(account.signIn()).rejects.toThrow('matrix_sign_out_first')
    expect(authorizeNative).not.toHaveBeenCalled()
  })
})

describe('a failing Google fence (the 2026-10-04 log flood)', () => {
  it('never revokes, ends or clears a sign-in: it only reads who is signed in', async () => {
    const { account, store } = fixture()
    const retained = store.getItem('matrix-account')
    const host = {}

    // Main's owner for the fence (googleFenceOwner): who is signed in, read and nothing more.
    const owner = () => {
      const signedIn = account.identity()
      const scope = account.appScope()

      return signedIn && scope ? { ...scope, identity: signedIn, host } : null
    }

    const brain = {
      ready: () => true,
      call: vi.fn(async () => {
        throw new Error('rpc_failed')
      })
    }

    const fence = new MatrixGoogleFenceNotices(brain, owner)

    // The mini logged about eighteen a minute for three hours.
    for (let since = 1; since <= 18; since++) {
      await expect(fence.observe({ state: 'current', since })).rejects.toBeTruthy()
    }

    expect(brain.call).toHaveBeenCalled()
    expect(store.getItem('matrix-account')).toBe(retained)
    expect(account.identity()).toEqual({ userId: '@alice:test', deviceId: 'A' })
    expect(account.appScope()).not.toBeNull()
    expect(oidc.refreshTokenGrant).not.toHaveBeenCalled()
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
  })
})

describe('every way this Mac ends or revokes a sign-in names its cause in main.log', () => {
  const refused = () =>
    new oidc.ResponseBodyError('invalid_grant', { cause: { error: 'invalid_grant' }, response: new Response('', { status: 400 }) })

  const scenarios: Array<[string, (account: MatrixAccount, store: EncryptedStore) => Promise<unknown>]> = [
    ['the person signs out', account => account.signOut()],
    [
      'the sign-in server ends the chat session',
      async account => {
        vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(refused())
        await account.refresh(account.sdkConfiguration().refreshToken)
      }
    ],
    [
      'the sign-in server ends the Atum account sign-in',
      async (account, store) => {
        const record = JSON.parse(store.getItem('matrix-account')!)
        store.setItem('matrix-account', JSON.stringify({ ...record, domain: { ...record.domain, expiresAt: 1 } }))
        vi.mocked(oidc.refreshTokenGrant).mockRejectedValueOnce(refused())
        await account.readDomain().catch(() => {})
      }
    ],
    [
      'a rotation lands after the account was signed out',
      async (account, store) => {
        const rotation = deferred<never>()
        vi.mocked(oidc.refreshTokenGrant).mockReturnValueOnce(rotation.promise)
        const refresh = account.refresh(account.sdkConfiguration().refreshToken)
        await vi.waitFor(() => expect(oidc.refreshTokenGrant).toHaveBeenCalled())
        store.removeItem('matrix-account')
        rotation.resolve({ access_token: 'late', refresh_token: 'late-refresh' } as never)
        await refresh
      }
    ],
    [
      'an Atum account sign-in is replaced while it rotates',
      async (account, store) => {
        const record = JSON.parse(store.getItem('matrix-account')!)
        store.setItem('matrix-account', JSON.stringify({ ...record, domain: { ...record.domain, expiresAt: 1 } }))
        const rotation = deferred<never>()
        vi.mocked(oidc.refreshTokenGrant).mockReturnValueOnce(rotation.promise)
        const reading = account.readDomain().catch(() => {})
        await vi.waitFor(() => expect(oidc.refreshTokenGrant).toHaveBeenCalled())
        store.setItem('matrix-account', JSON.stringify({ ...record, domain: { ...record.domain, sessionId: 'replacement' } }))
        rotation.resolve({ access_token: 'stale', refresh_token: 'stale-refresh' } as never)
        await reading
      }
    ]
  ]

  it.each(scenarios)('%s', async (_name, run) => {
    const f = fixture()
    const log = vi.fn()
    const account = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice, log)

    await run(account, f.store)

    const ending = log.mock.calls
      .map(([event]) => event as { event: string; cause?: string; reason?: string; result?: string })
      .filter(event => ['session_ended', 'grant_revoked', 'user_sign_out'].includes(event.event))

    expect(ending.length).toBeGreaterThan(0)

    for (const event of ending) {
      expect(event.cause ?? event.reason ?? event.result).toMatch(/^[a-z_:]+$/)
    }

    // Never a token or an id: the fixture's tokens, its user and its device.
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/(?:matrix|domain)-(?:access|refresh)|late-refresh|stale-refresh|@alice:test|"A"/)
  })
})

describe("another agent's enrollment custody", () => {
  it('names the agent, keeps its own executor, key and device, and leaves the default alone', async () => {
    const { account, read } = agentsFixture()
    const own = await account.enrollHermes()
    const other = await account.enrollAgent(alfred)

    expect(requestEnrollment).toHaveBeenLastCalledWith(
      config.domain.resource,
      expect.anything(),
      other.identity!.executorId,
      'POST',
      undefined,
      alfred
    )
    expect(other.state).toBe('ready')
    expect(other.identity!.agentPrincipal).toBe(alfred)
    expect(other.identity!.executorId).not.toBe(own.identity!.executorId)
    expect(account.agentEnrollments()).toEqual([alfred])
    expect(account.enrollment()).toEqual(own)
    expect(read().enrollment.credential.accessToken).toBe('agent-only')

    const agent = account.agentSdkConfiguration({ agent: alfred })
    expect(agent.accessToken).toBe('7579-only')
    expect(agent.storageKey).not.toBe(account.agentSdkConfiguration().storageKey)
    expect(agent.storageKey).not.toBe(account.sdkConfiguration().storageKey)
    expect(account.managedModelKey(alfred)).not.toBe(account.managedModelKey())
    expect(account.managedModelKey(bea)).toBeNull()
    // The proxy reads every agent's key in one pass, each naming its agent.
    expect(account.managedModelKeys()).toEqual([
      { key: account.managedModelKey() },
      { key: account.managedModelKey(alfred), agent: alfred }
    ])
  })

  it("refuses a credential for another agent, and an app slug never reaches an agent's slot", async () => {
    const { account } = agentsFixture()
    const issue = vi.mocked(requestEnrollment).getMockImplementation()!
    vi.mocked(requestEnrollment).mockImplementation(async (...args) =>
      args[3] === 'POST' && args[5] === alfred
        ? { ...((await issue(...args)) as object), agentPrincipal: bea }
        : issue(...args)
    )

    await expect(account.enrollAgent(alfred)).rejects.toThrow('matrix_enrollment_invalid')
    expect(account.agentEnrollment(alfred).state).toBe('absent')
    expect(account.enrollment(alfred).state).toBe('absent')
  })

  it('revokes one agent without touching the default, and clears its Hermes credentials first', async () => {
    const { account, read, clearLocalHermes } = agentsFixture()
    const own = await account.enrollHermes()
    const other = await account.enrollAgent(alfred)
    account.retainHermesProfile('/profiles/alfred', alfred)
    expect(read().agentHermes[alfred]).toEqual({ home: '/profiles/alfred', executorId: other.identity!.executorId })

    expect((await account.revokeAgent(alfred)).state).toBe('absent')
    expect(clearLocalHermes).toHaveBeenCalledWith('/profiles/alfred', alfred)
    expect(requestEnrollment).toHaveBeenLastCalledWith(
      config.domain.resource,
      expect.anything(),
      other.identity!.executorId,
      'DELETE'
    )
    expect(read().agentHermes).toEqual({})
    expect(account.enrollment()).toEqual(own)
  })

  it("moves the root slot's retained home only for its ready executor, and revocation clears the new home", async () => {
    const { account, read, clearLocalHermes } = agentsFixture()
    const own = await account.enrollHermes()
    const executorId = own.identity!.executorId
    account.retainHermesProfile('/profiles/current')

    expect(account.retainedHermesProfile()).toEqual({ home: '/profiles/current', executorId })
    expect(() => account.rebindHermesProfile(executorId, '/profiles/other', '/profiles/earlier')).toThrow(
      'matrix_local_cleanup_pending'
    )
    expect(() =>
      account.rebindHermesProfile('00000000-0000-4000-8000-b729e770a1c4', '/profiles/current', '/profiles/earlier')
    ).toThrow('matrix_local_cleanup_pending')
    expect(() => account.rebindHermesProfile(executorId, '/profiles/current', 'earlier')).toThrow(
      'matrix_local_cleanup_pending'
    )

    account.rebindHermesProfile(executorId, '/profiles/current', '/profiles/earlier')
    expect(read().localHermes).toEqual({ home: '/profiles/earlier', executorId })
    expect(() => account.retainHermesProfile('/profiles/earlier')).not.toThrow()

    await account.revokeHermes()
    expect(clearLocalHermes).toHaveBeenCalledWith('/profiles/earlier')
    expect(account.retainedHermesProfile()).toBeUndefined()
  })

  it("moves an agent's retained home only for its ready executor, and its revocation clears the new home", async () => {
    const { account, read, clearLocalHermes } = agentsFixture()
    await account.enrollHermes()
    account.retainHermesProfile('/profiles/default')
    const other = await account.enrollAgent(alfred)
    const executorId = other.identity!.executorId
    account.retainHermesProfile('/profiles/replaced', alfred)

    expect(account.retainedAgentHermes(alfred)).toEqual({ home: '/profiles/replaced', executorId })
    expect(account.retainedAgentHermes(bea)).toBeUndefined()
    expect(account.retainedHermesHomes().sort()).toEqual(['/profiles/default', '/profiles/replaced'])

    // Only from exactly the home retained now, for the same executor, to a full path.
    expect(() => account.rebindAgentHermesProfile(alfred, executorId, '/profiles/other', '/profiles/earlier')).toThrow(
      'matrix_local_cleanup_pending'
    )
    const stranger = '00000000-0000-4000-8000-b729e770a1c4'
    expect(() => account.rebindAgentHermesProfile(alfred, stranger, '/profiles/replaced', '/profiles/earlier')).toThrow(
      'matrix_local_cleanup_pending'
    )
    expect(() => account.rebindAgentHermesProfile(alfred, executorId, '/profiles/replaced', 'earlier')).toThrow(
      'matrix_local_cleanup_pending'
    )
    expect(() => account.rebindAgentHermesProfile(bea, executorId, '/profiles/replaced', '/profiles/earlier')).toThrow(
      'matrix_local_cleanup_pending'
    )
    expect(read().agentHermes[alfred]).toEqual({ home: '/profiles/replaced', executorId })

    account.rebindAgentHermesProfile(alfred, executorId, '/profiles/replaced', '/profiles/earlier')
    expect(read().agentHermes[alfred]).toEqual({ home: '/profiles/earlier', executorId })
    expect(read().localHermes.home).toBe('/profiles/default')
    // Retaining the moved home again is the ordinary no-op of a host restart.
    expect(() => account.retainHermesProfile('/profiles/earlier', alfred)).not.toThrow()

    await account.revokeAgent(alfred)
    expect(clearLocalHermes).toHaveBeenCalledWith('/profiles/earlier', alfred)
    expect(account.retainedAgentHermes(alfred)).toBeUndefined()
  })

  it('signs out every agent too, handing their devices to cleanup', async () => {
    const { account, store } = agentsFixture()
    const own = await account.enrollHermes()
    const other = await account.enrollAgent(alfred)
    const cleanup = vi.fn(async () => {})
    await account.signOut(cleanup)

    expect(cleanup).toHaveBeenCalledWith(
      { userId: '@alice:test', deviceId: 'A' },
      { userId: own.identity!.userId, deviceId: own.identity!.deviceId },
      [{ userId: other.identity!.userId, deviceId: other.identity!.deviceId }]
    )

    const revoked = vi
      .mocked(requestEnrollment)
      .mock.calls.filter(call => call[3] === 'DELETE')
      .map(call => call[2])

    expect(revoked).toEqual(expect.arrayContaining([own.identity!.executorId, other.identity!.executorId]))
    expect(store.getItem('matrix-account')).toBeNull()
  })
})

describe("another agent's SDK host", () => {
  it("binds its host to its own credentials, never the default agent's", async () => {
    const { account } = agentsFixture()
    const own = await account.enrollHermes()
    const other = await account.enrollAgent(alfred)
    const identity = { userId: other.identity!.userId, deviceId: other.identity!.deviceId }

    expect(boundSdkConfiguration(account, `agent:${alfred}`, identity).accessToken).toBe('7579-only')
    // The default agent's device under another agent's role is refused, and the reverse.
    expect(() =>
      boundSdkConfiguration(account, `agent:${alfred}`, {
        userId: own.identity!.userId,
        deviceId: own.identity!.deviceId
      })
    ).toThrow('matrix_sdk_identity_changed')
    expect(() => boundSdkConfiguration(account, 'agent', identity)).toThrow('matrix_sdk_identity_changed')
    expect(() => boundSdkConfiguration(account, `agent:${bea}`, identity)).toThrow('matrix_agent_unavailable')
  })
})

describe('native owner cloud file custody', () => {
  const agent = '22345678-1234-1234-1234-123456789abc'

  const fileGrant = {
    requestId: '00000000-0000-4000-8000-11e594f48195',
    agentPrincipal: agent,
    roomId: '!private:test',
    eventId: '$ack',
    mode: 'read' as const,
    resource: { storage: 'storage', space: 'personal', opaque: 'notes' },
    size: 10,
    etag: 'v1'
  }

  it('uses only the fixed owner endpoint and rejects metadata or duplicate status rows', async () => {
    const f = fixture()
    const fetcher = vi.fn(async () => Response.json({ agents: [{ agentPrincipal: agent, available: true }] }))
    vi.stubGlobal('fetch', fetcher)
    expect(await f.account.cloudFileAvailable(agent)).toBe(true)
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.test/cloud/file-status',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { Authorization: 'Bearer domain-access' }
      })
    )

    for (const body of [
      { agents: [{ agentPrincipal: agent, available: true, leaseToken: 'private' }] },
      {
        agents: [
          { agentPrincipal: agent, available: true },
          { agentPrincipal: agent, available: true }
        ]
      },
      { agents: [{ agentPrincipal: agent, available: 'true' }] }
    ]) {
      fetcher.mockResolvedValueOnce(Response.json(body))
      await expect(f.account.cloudFileAvailable(agent)).rejects.toThrow('unavailable')
    }
  })

  it('keeps unmatched and explicitly unavailable agents disabled', async () => {
    const f = fixture()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ agents: [{ agentPrincipal: agent, available: false }] }))
    )
    expect(await f.account.cloudFileAvailable(agent)).toBe(false)
    expect(await f.account.cloudFileAvailable(identity.principal)).toBe(false)
  })

  it('posts the exact native grant once and does not replay a lost response', async () => {
    const f = fixture()

    const fetcher = vi.fn(async () =>
      Response.json({ grantId: fileGrant.requestId, mode: 'read', expiresAt: Date.now() + 60000 })
    )

    vi.stubGlobal('fetch', fetcher)
    await f.account.issueCloudFileGrant(fileGrant)
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.test/cloud/file-grants',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(fileGrant),
        redirect: 'error'
      })
    )
    fetcher.mockRejectedValueOnce(new Error('lost response'))
    await expect(f.account.issueCloudFileGrant(fileGrant)).rejects.toThrow('lost response')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('denies a status response after the owner domain session changes', async () => {
    const f = fixture()
    const pending = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => pending.promise)
    )
    const request = f.account.cloudFileAvailable(agent)
    const denied = expect(request).rejects.toThrow('unavailable')
    await vi.waitFor(() => expect(readDomainIdentity).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 0))
    const stored = f.read()
    f.store.setItem(
      'matrix-account',
      JSON.stringify({ ...stored, domain: { ...stored.domain, sessionId: 'other-session' } })
    )
    pending.resolve(Response.json({ agents: [{ agentPrincipal: agent, available: true }] }))
    await denied
  })

  it('rejects a malformed or denied mutation without exposing provider details or revoking the shared account', async () => {
    const f = fixture()
    const fetcher = vi.fn(async () => Response.json({ error: 'private provider detail' }, { status: 401 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(f.account.issueCloudFileGrant(fileGrant)).rejects.toThrow('matrix_drive_task_unavailable')
    expect(f.account.identity()).toEqual({ userId: '@alice:test', deviceId: 'A' })
    expect(fetcher).toHaveBeenCalledOnce()
    fetcher.mockResolvedValueOnce(
      Response.json({ grantId: fileGrant.requestId, mode: 'replace', expiresAt: Date.now() + 60000 })
    )
    await expect(f.account.issueCloudFileGrant(fileGrant)).rejects.toThrow('matrix_drive_task_unavailable')
  })
})

describe('alias claim durability and owner fence', () => {
  const input = { action: 'claim' as const, handle: 'alice', requestId: '00000000-0000-4000-8000-b4b6412c243e' }
  const result = { handle: 'alice', state: 'assigned', principal: identity.principal, generation: 1 }

  it('retains the exact unknown UUID across account restart and refuses a different claim before fetch', async () => {
    const f = fixture()
    const request = vi.fn().mockRejectedValueOnce(Error('response lost')).mockResolvedValueOnce(Response.json(result))
    vi.stubGlobal('fetch', request)
    await expect(f.account.alias(input, AbortSignal.timeout(2000))).rejects.toThrow('response lost')
    expect(f.account.aliasPending()).toEqual(input)
    const restarted = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice)
    expect(restarted.aliasPending()).toEqual(input)
    await expect(restarted.alias({ ...input, requestId: '00000000-0000-4000-8000-15dc18308a11' }, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'conflict' })
    expect(request).toHaveBeenCalledTimes(1)
    await expect(restarted.alias(input, AbortSignal.timeout(2000))).resolves.toMatchObject({ kind: 'claim', handle: 'alice' })
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ handle: input.handle, requestId: input.requestId })
    expect(restarted.aliasPending()).toBeNull()
  })

  it.each(['unreadable', 'limited'])('keeps an unknown %s result instead of inventing another UUID', async kind => {
    const { account } = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => kind === 'unreadable' ? Response.json({}) : new Response('', { status: 429 })))
    await expect(account.alias(input, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: kind === 'limited' ? 'limit' : 'unavailable' })
    expect(account.aliasPending()).toEqual(input)
  })

  it('renews one confirmed authentication refusal with the original body, then clears confirmed policy refusal', async () => {
    const { account } = fixture()
    const request = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(new Response('', { status: 403 }))
    vi.stubGlobal('fetch', request)
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({ access_token: 'rotated', refresh_token: 'rotated-refresh' } as never)
    await expect(account.alias(input, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'denied' })
    expect(request.mock.calls[1][1].body).toBe(request.mock.calls[0][1].body)
    expect(request.mock.calls[1][1].headers.Authorization).toBe('Bearer rotated')
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
    expect(authorizeNative).not.toHaveBeenCalled()
    expect(account.aliasPending()).toBeNull()
  })

  it('finds a handle as a read that never writes or clears a pending claim', async () => {
    const { account } = fixture()

    const request = vi.fn()
      .mockRejectedValueOnce(Error('response lost'))
      .mockResolvedValueOnce(Response.json({ handle: 'lan', state: 'assigned', principal: identity.principal, kind: 'human', generation: 1, matrixUser: null }))
      .mockResolvedValueOnce(new Response('', { status: 400 }))

    vi.stubGlobal('fetch', request)
    await expect(account.alias(input, AbortSignal.timeout(2000))).rejects.toThrow('response lost')
    await expect(account.alias({ action: 'lookup', handle: 'lan' }, AbortSignal.timeout(2000))).resolves.toEqual({
      kind: 'lookup', handle: 'lan', state: 'assigned', principalKind: 'human', matrixUser: null
    })

    expect(request.mock.calls[1][0]).toMatch(/\/aliases\/lookup\?handle=lan$/)
    expect(request.mock.calls[1][1].method).toBe('GET')
    // A refused lookup is about that search, never about the claim waiting in the journal.
    await expect(account.alias({ action: 'lookup', handle: 'lan' }, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'invalid' })
    expect(account.aliasPending()).toEqual(input)
  })

  it('does not issue a claim if the encrypted journal is corrupt', async () => {
    const { account, store } = fixture()
    store.setItem(`matrix-alias-pending:${account.appScope()!.accountKey}`, '{broken')
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    expect(() => account.aliasPending()).toThrow('matrix_alias_unavailable')
    await expect(account.alias(input, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'unavailable' })
    expect(request).not.toHaveBeenCalled()
  })

  it('never sends a claim when its encrypted intent cannot be saved', async () => {
    const { account, store } = fixture()
    const save = store.setItem.bind(store)
    vi.spyOn(store, 'setItem').mockImplementation((key, value) => {
      if (key.startsWith('matrix-alias-pending:')) { throw new Error('journal write failed') }
      save(key, value)
    })
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await expect(account.alias(input, AbortSignal.timeout(2000))).rejects.toThrow('journal write failed')
    expect(request).not.toHaveBeenCalled()
    expect(account.aliasPending()).toBeNull()
  })

  it.each([[400, 'invalid'], [404, 'missing'], [409, 'conflict']])('clears the exact claim only after a confirmed %s refusal', async (status, code) => {
    const { account } = fixture()
    // The domain authority answers its refusals as JSON (matrix-authority.ts): a 404 without it
    // is a Shell lacking the route, not a confirmed refusal (aliases.ts).
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: `matrix_${status}` }, { status: status as number })))
    await expect(account.alias(input, AbortSignal.timeout(2000))).rejects.toMatchObject({ code })
    expect(account.aliasPending()).toBeNull()
  })

  it('keeps the claim after a 404 from a Shell without the route, so it can be checked again', async () => {
    const { account } = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } })))
    await expect(account.alias(input, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'unavailable' })
    expect(account.aliasPending()).not.toBeNull()
  })

  it('clears a claim refused because handles are not open yet', async () => {
    const { account } = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'matrix_403', details: { reason: 'alias_claims_closed' } }, { status: 403 })))
    await expect(account.alias(input, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'closed' })
    expect(account.aliasPending()).toBeNull()
  })

  describe('a rename', () => {
    const rename = { action: 'rename' as const, handle: 'alice_two', from: 'alice', requestId: '00000000-0000-4000-8000-b62b874557d6' }

    it('keeps its exact intent across a lost answer and a restart, and sends it once more unchanged', async () => {
      const f = fixture()

      const request = vi.fn()
        .mockRejectedValueOnce(Error('response lost'))
        .mockResolvedValueOnce(Response.json({ ...result, handle: 'alice_two', previous: 'alice', replayed: true }))

      vi.stubGlobal('fetch', request)
      await expect(f.account.alias(rename, AbortSignal.timeout(2000))).rejects.toThrow('response lost')
      const restarted = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice)
      expect(restarted.aliasPending()).toEqual(rename)
      // One change at a time: a claim waits for the rename's answer.
      await expect(restarted.alias(input, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'conflict' })
      await expect(restarted.alias(rename, AbortSignal.timeout(2000))).resolves.toEqual({
        kind: 'rename', handle: 'alice_two', generation: 1, previous: 'alice', replayed: true
      })
      expect(request.mock.calls[1][0]).toMatch(/\/aliases\/rename$/)
      expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ handle: 'alice_two', from: 'alice', requestId: rename.requestId })
      expect(restarted.aliasPending()).toBeNull()
    })

    it('ends its intent at the 30-day wait, and says how long it is', async () => {
      const { account } = fixture()
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': String(12 * 86400) } })))
      await expect(account.alias(rename, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'limit', retryAfterSeconds: 12 * 86400 })
      expect(account.aliasPending()).toBeNull()
    })
  })

  it('retains the original intent after a second 401, without another renewal or interactive login', async () => {
    const { account } = fixture()
    const request = vi.fn(async (_url: string, _init: RequestInit) => new Response('', { status: 401 }))
    vi.stubGlobal('fetch', request)
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({ access_token: 'rotated' } as never)
    await expect(account.alias(input, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'authentication' })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][1].body).toBe(request.mock.calls[0][1].body)
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
    expect(authorizeNative).not.toHaveBeenCalled()
    expect(account.aliasPending()).toEqual(input)
  })

  it('retains the exact claim when MAS renewal reports sign-out', async () => {
    const f = fixture()
    const { account, store } = f
    const journalKey = `matrix-alias-pending:${account.appScope()!.accountKey}`
    const request = vi.fn(async () => new Response('', { status: 401 }))
    vi.stubGlobal('fetch', request)
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValue(new oidc.ResponseBodyError('invalid_grant', {
      cause: { error: 'invalid_grant' },
      response: new Response('', { status: 400 })
    }))
    await expect(account.alias(input, AbortSignal.timeout(2000))).rejects.toThrow('matrix_domain_signed_out')
    expect(request).toHaveBeenCalledTimes(1)
    expect(authorizeNative).not.toHaveBeenCalled()
    expect(JSON.parse(store.getItem(journalKey)!)).toEqual({ schemaVersion: 1, input })
    const restarted = new MatrixAccount(config, store, f.open, f.clearLocalHermes, f.clearAppDevice)
    expect(restarted.aliasPending()).toEqual(input)
  })

  it('keeps the journal and stops before retry after account cancellation during renewal', async () => {
    const { account } = fixture()
    const rotation = deferred<Awaited<ReturnType<typeof oidc.refreshTokenGrant>>>()
    const request = vi.fn(async () => new Response('', { status: 401 }))
    vi.stubGlobal('fetch', request)
    vi.mocked(oidc.refreshTokenGrant).mockReturnValueOnce(rotation.promise)
    const pending = account.alias(input, AbortSignal.timeout(2000))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1))
    account.cancel()
    rotation.resolve({ access_token: 'rotated' } as never)
    await rejected
    expect(request).toHaveBeenCalledTimes(1)
    expect(account.aliasPending()).toEqual(input)
  })

  it('drops a late successful claim after owner cancellation and preserves its journal for recovery', async () => {
    const { account } = fixture()
    const response = deferred<Response>()
    const request = vi.fn(() => response.promise)
    vi.stubGlobal('fetch', request)
    const pending = account.alias(input, AbortSignal.timeout(2000))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    account.cancel()
    response.resolve(Response.json(result))
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(account.aliasPending()).toEqual(input)
  })
})

describe('company authority account fence', () => {
  const directory = { schemaVersion: 1, companies: [], invitations: [] }
  const companyId = '00000000-0000-4000-8000-576f18824476'
  const requestId = '00000000-0000-4000-8000-b4b6412c243e'

  const snapshot = {
    schemaVersion: 1,
    company: { id: companyId, displayName: 'Studio', role: 'admin', authorityGeneration: 1 },
    members: [],
    projects: []
  }

  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } })

  it('keeps uncertain funding consent across restart and wallet reads, then retries only that intent', async () => {
    const f = fixture()
    const input = { action: 'funding' as const, companyId, requestId, enabled: true, taskLimit: 1000000 }

    const wallet = { schemaVersion: 1, companyId, unit: 'micro_proton', checkoutOpen: false,
      balances: { paid: 0, earned: 0, promo: 0, held: 0, available: 0 },
      funding: { enabled: true, taskLimit: input.taskLimit, revision: 1 } }

    const request = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockImplementation(async () => json(wallet))
    vi.stubGlobal('fetch', request)
    await expect(f.account.company(input, AbortSignal.timeout(2000))).rejects.toThrow('lost response')
    expect(f.account.companyPending()).toEqual(input)
    const restarted = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice)
    expect(restarted.companyPending()).toEqual(input)
    await expect(restarted.company({ action: 'wallet', companyId }, AbortSignal.timeout(2000))).resolves.toEqual(wallet)
    expect(restarted.companyPending()).toEqual(input)
    await expect(restarted.company({ ...input, enabled: false }, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'conflict' })
    expect(request).toHaveBeenCalledTimes(2)
    await expect(restarted.company(input, AbortSignal.timeout(2000))).resolves.toEqual(wallet)
    expect(restarted.companyPending()).toBeNull()
    expect(request.mock.calls[0][1].body).toBe(request.mock.calls[2][1].body)
    expect(request.mock.calls[1][1].method).toBe('GET')
  })

  it('keeps a leave request until the replay reports removed', async () => {
    const f = fixture()
    const input = { action: 'leave' as const, companyId, requestId }
    const revoking = { schemaVersion: 2, companyId, state: 'revoking', retired: false, authorityGeneration: 2 }
    const removed = { ...revoking, state: 'removed', authorityGeneration: 3 }
    const request = vi.fn()
      .mockImplementationOnce(async () => json(revoking))
      .mockImplementationOnce(async () => json(removed))
    vi.stubGlobal('fetch', request)
    await expect(f.account.company(input, AbortSignal.timeout(2000))).resolves.toEqual(revoking)
    expect(f.account.companyPending()).toEqual(input)
    const restarted = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice)
    expect(restarted.companyPending()).toEqual(input)
    await expect(restarted.company(input, AbortSignal.timeout(2000))).resolves.toEqual(removed)
    expect(restarted.companyPending()).toBeNull()
    expect(request.mock.calls[0]![1].body).toBe(request.mock.calls[1]![1].body)
    expect(request.mock.calls[1]![1].headers).toMatchObject({ 'Atum-Company-Wire': '1.11' })
  })

  it('never restores a wallet read as mutation consent from a forged journal', () => {
    const { account, store } = fixture()
    const key = `matrix-company-pending:${account.appScope()!.accountKey}`
    store.setItem(key, JSON.stringify({ schemaVersion: 1, input: { action: 'wallet', companyId } }))
    expect(() => account.companyPending()).toThrow('matrix_company_unavailable')
  })

  it('keeps project source reads outside the journal and retries an uncertain enrollment byte-for-byte', async () => {
    const f = fixture()
    const projectId = '00000000-0000-4000-8000-072e4e6126bd'
    const channelId = '00000000-0000-4000-8000-676a3a34ff0f'
    const empty = { schemaVersion: 1, companyId, projectId, authorityGeneration: 2, sourceGeneration: 0,
      eligibleChannels: [{ channelId, displayName: 'Launch', state: 'ready' }], eligibleFiles: [], sources: [],
      coverage: { state: 'empty' } }
    const selected = { ...empty, sourceGeneration: 1, coverage: { state: 'pending' }, sources: [{
      id: '00000000-0000-4000-8000-6964221939c9', kind: 'channel', state: 'active', channelId,
      enrolledAt: '2026-10-15T10:00:00+00:00', withdrawnAt: null
    }] }
    const input = { action: 'include-project-channel-source' as const, companyId, projectId, requestId,
      channelId, expectedSourceGeneration: 0 }
    const request = vi.fn()
      .mockResolvedValueOnce(json(empty))
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce(json(selected))
    vi.stubGlobal('fetch', request)

    await expect(f.account.company({ action: 'project-sources', companyId, projectId }, AbortSignal.timeout(2000)))
      .resolves.toEqual(empty)
    expect(f.account.companyPending()).toBeNull()
    await expect(f.account.company(input, AbortSignal.timeout(2000))).rejects.toThrow('lost response')
    expect(f.account.companyPending()).toEqual(input)
    await expect(f.account.company(input, AbortSignal.timeout(2000))).resolves.toEqual(selected)
    expect(f.account.companyPending()).toBeNull()
    expect(request.mock.calls[1][1].body).toBe(request.mock.calls[2][1].body)
  })

  it('keeps receipt-derived project reader status outside the mutation journal', async () => {
    const f = fixture()
    const projectId = '00000000-0000-4000-8000-072e4e6126bd'
    const status = {schemaVersion: 2, companyId, projectId, authorityGeneration: 2, sourceGeneration: 1,
      coverage: {state: 'pending'}, sources: [{sourceId: '00000000-0000-4000-8000-6964221939c9',
        kind: 'channel', state: 'active', channelId: '00000000-0000-4000-8000-676a3a34ff0f', receiptState: 'none'}]}
    const request = vi.fn().mockResolvedValueOnce(json(status))
    vi.stubGlobal('fetch', request)

    await expect(f.account.company({action: 'project-reader', companyId, projectId}, AbortSignal.timeout(2000)))
      .resolves.toEqual(status)
    expect(f.account.companyPending()).toBeNull()
    expect(request.mock.calls[0]![1]).toMatchObject({method: 'GET'})
    expect(request.mock.calls[0]![1]).not.toHaveProperty('body')
  })

  it('preserves an uncertain mutation across restart, refuses a different one before fetch, and clears after an exact retry', async () => {
    const f = fixture()
    const original = { action: 'create' as const, requestId, displayName: 'Studio' }

    const different = {
      action: 'create' as const,
      requestId: '00000000-0000-4000-8000-15dc18308a11',
      displayName: 'Different Studio'
    }

    const request = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(json(snapshot))
    vi.stubGlobal('fetch', request)

    await expect(f.account.company(original, AbortSignal.timeout(2000))).rejects.toThrow('lost response')
    expect(f.account.companyPending()).toEqual(original)

    const restarted = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice)
    expect(restarted.companyPending()).toEqual(original)
    await expect(restarted.company(different, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'conflict' })
    expect(request).toHaveBeenCalledTimes(1)

    await expect(restarted.company(original, AbortSignal.timeout(2000))).resolves.toEqual(snapshot)
    expect(request).toHaveBeenCalledTimes(2)
    expect(restarted.companyPending()).toBeNull()
  })


  describe('a typed add or email-invite 429 (the platform records nothing)', () => {
    const team = '00000000-0000-4000-8000-3570bef6c8ca'
    const status = (code: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json', ...headers } })

    const add = (id: string) => ({ action: 'member-add' as const, companyId: team, requestId: id,
      target: { kind: 'matrixUser' as const, memberMatrixUser: '@lan:atum.example' }, role: 'member' as const })

    const emailInvite = (id: string) => ({ action: 'email-invitation-create' as const, companyId: team, requestId: id,
      email: 'lan@example.com', locale: 'vi' as const })

    const added = { schemaVersion: 12, outcome: 'added', companyId: team, memberRef: 'A'.repeat(43), role: 'member',
      invitationId: '00000000-0000-4000-8000-933779c60f5b', authorityGeneration: 10, replayed: false }

    const accepted = { schemaVersion: 10, invitationId: '00000000-0000-4000-8000-71544ed54ec4', state: 'accepted',
      mailStatus: 'accepted', expiresAt: 1793000000, replayed: false }

    /** What the renderer's IPC call gets: main's real Company handler over this account's journalled request. */
    const bridgeFor = (account: MatrixAccount) => (input: unknown) => {
      const frame = { url: 'atum://matrix' }
      const ui = { mainFrame: frame }

      return handleMatrixCompanyCommand(input, {
        event: { sender: ui, senderFrame: frame } as never,
        ui: ui as never,
        uiUrl: frame.url,
        enabled: true,
        closing: false,
        available: () => true,
        request: value => account.company(value, AbortSignal.timeout(2000))
      })
    }

    it.each([
      ['a direct add', add, { error: 'matrix_429', details: { reason: 'member_add_limited' } }, 'member_add_limited', added],
      ['an email invitation', emailInvite, { error: 'matrix_429', details: { reason: 'email_invite_limited', retryable: true } },
        'email_invite_limited', accepted]
    ] as const)('%s: main releases its journal with the renderer, and the next press is a fresh request', async (
      _name, build, refusal, reason, success
    ) => {
      const f = fixture()
      const bridge = bridgeFor(f.account)
      const request = vi.fn()
        .mockResolvedValueOnce(status(429, refusal, { 'Retry-After': '1200' }))
        .mockResolvedValueOnce(status(200, success))
      vi.stubGlobal('fetch', request)

      const first = build('00000000-0000-4000-8000-eb8abd3c16e2')
      const refused = await bridge(first as never)

      // The renderer hears the typed refusal and, by the shared rule, drops its Retry; main has dropped the journal.
      expect(refused).toMatchObject({ ok: false, error: 'limit', reason })
      expect(isDefinitiveCompanyRefusal(first.action, 'limit', reason)).toBe(true)
      expect(f.account.companyPending()).toBeNull()

      // A new press: a new request ID reaches the platform (no local conflict), and settles.
      const second = build('00000000-0000-4000-8000-c43aa9490abe')
      await expect(bridge(second as never)).resolves.toMatchObject({ ok: true })
      expect(request).toHaveBeenCalledTimes(2)
      expect(JSON.parse(request.mock.calls[1]![1].body).requestId).toBe(second.requestId)
      expect(f.account.companyPending()).toBeNull()
      // Another company change is not blocked either.
      expect(isDefinitiveCompanyRefusal('member-add', 'limit', undefined)).toBe(false)
    })

    it.each([
      ['a 503', () => status(503, { error: 'matrix_503' })],
      ['an untyped 429', () => status(429, { error: 'matrix_429' }, { 'Retry-After': '60' })],
      ['a lost answer', () => Promise.reject(new Error('lost response'))]
    ] as const)('%s keeps the add journalled: a different request is refused before fetch, the same one replays', async (
      _name, failure
    ) => {
      const f = fixture()
      const bridge = bridgeFor(f.account)
      const request = vi.fn().mockImplementationOnce(failure).mockResolvedValueOnce(status(200, added))
      vi.stubGlobal('fetch', request)

      const first = add('00000000-0000-4000-8000-88dee10a5070')
      await expect(bridge(first)).resolves.toMatchObject({ ok: false })
      expect(f.account.companyPending()).toEqual(first)

      await expect(bridge(add('00000000-0000-4000-8000-827bf44f87d4'))).resolves.toMatchObject({ ok: false, error: 'conflict' })
      expect(request).toHaveBeenCalledTimes(1)

      await expect(bridge(first)).resolves.toMatchObject({ ok: true, value: { outcome: 'added' } })
      expect(request.mock.calls[0]![1].body).toBe(request.mock.calls[1]![1].body)
      expect(f.account.companyPending()).toBeNull()
    })
  })

  it('serializes different intents before the first asynchronous request completes', async () => {
    const { account } = fixture()
    const response = deferred<Response>()
    const request = vi.fn(() => response.promise)
    vi.stubGlobal('fetch', request)
    const input = { action: 'create' as const, requestId, displayName: 'Studio' }
    const pending = account.company(input, AbortSignal.timeout(2000))
    await expect(account.company({ ...input, requestId: '00000000-0000-4000-8000-36f351e7fa6d' }, AbortSignal.timeout(2000)))
      .rejects.toMatchObject({ code: 'conflict' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    response.resolve(json(snapshot))
    await pending
    expect(account.companyPending()).toBeNull()
  })

  it('does not treat a corrupt pending intent as permission to send a fresh mutation', async () => {
    const { account, store } = fixture()
    const key = `matrix-company-pending:${account.appScope()!.accountKey}`
    store.setItem(key, JSON.stringify({ schemaVersion: 1, input: { action: 'create', requestId, displayName: 'Studio', actor: 'forged' } }))
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    expect(() => account.companyPending()).toThrow('matrix_company_unavailable')
    await expect(account.company({ action: 'create', requestId, displayName: 'Studio' }, AbortSignal.timeout(2000)))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect(request).not.toHaveBeenCalled()
    expect(store.getItem(key)).not.toBeNull()
  })

  it('never posts a mutation when its intent cannot be saved durably', async () => {
    const { account, store } = fixture()
    const save = store.setItem.bind(store)
    vi.spyOn(store, 'setItem').mockImplementation((key, value) => {
      if (key.startsWith('matrix-company-pending:')) { throw new Error('journal write failed') }
      save(key, value)
    })
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await expect(account.company({ action: 'create', requestId, displayName: 'Studio' }, AbortSignal.timeout(2000)))
      .rejects.toThrow('journal write failed')
    expect(request).not.toHaveBeenCalled()
  })

  it('partitions uncertain company mutations by account scope', async () => {
    const f = fixture()
    const alice = { action: 'create' as const, requestId, displayName: 'Alice Studio' }
    const aliceRecord = f.read()
    const request = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(json(snapshot))
    vi.stubGlobal('fetch', request)

    await expect(f.account.company(alice, AbortSignal.timeout(2000))).rejects.toThrow('lost response')
    const aliceScope = f.account.appScope()!
    expect(f.account.companyPending()).toEqual(alice)

    f.store.setItem(
      'matrix-account',
      JSON.stringify({
        ...aliceRecord,
        subject: 'bob',
        userId: '@bob:test',
        domain: { ...aliceRecord.domain!, subject: 'bob' }
      })
    )
    const bob = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice)
    const bobScope = bob.appScope()!

    const bobInput = {
      action: 'create' as const,
      requestId: '00000000-0000-4000-8000-b62b874557d6',
      displayName: 'Bob Studio'
    }

    expect(bobScope.accountKey).not.toBe(aliceScope.accountKey)
    expect(bob.companyPending()).toBeNull()
    await expect(bob.company(bobInput, AbortSignal.timeout(2000))).resolves.toEqual(snapshot)
    expect(bob.companyPending()).toBeNull()

    f.store.setItem('matrix-account', JSON.stringify(aliceRecord))
    const restoredAlice = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice)
    expect(restoredAlice.appScope()?.accountKey).toBe(aliceScope.accountKey)
    expect(restoredAlice.companyPending()).toEqual(alice)
  })

  it('suppresses a delayed result after the account generation changes', async () => {
    const { account } = fixture()
    const response = deferred<Response>()
    const request = vi.fn(() => response.promise)
    vi.stubGlobal('fetch', request)
    const pending = account.company({ action: 'list' }, AbortSignal.timeout(2000))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    account.cancel()
    response.resolve(json(directory))
    await expect(pending).rejects.toThrow('matrix_company_cancelled')
  })

  it('suppresses a delayed result from a replaced account vault', async () => {
    const { account, store, read } = fixture()
    const response = deferred<Response>()
    const request = vi.fn(() => response.promise)
    vi.stubGlobal('fetch', request)
    const pending = account.company({ action: 'list' }, AbortSignal.timeout(2000))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    store.setItem('matrix-account', JSON.stringify({ ...read(), storageKey: Buffer.alloc(32, 2).toString('base64') }))
    response.resolve(json(directory))
    await expect(pending).rejects.toThrow('matrix_company_cancelled')
  })

  it('retries one authentication refusal with the exact mutation body and no browser login', async () => {
    const { account } = fixture()

    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(json(snapshot))

    vi.stubGlobal('fetch', request)
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({
      access_token: 'rotated',
      refresh_token: 'rotated-refresh'
    } as never)
    await expect(
      account.company({ action: 'create', requestId, displayName: 'Studio' }, AbortSignal.timeout(2000))
    ).resolves.toEqual(snapshot)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0][1].body).toEqual(request.mock.calls[1][1].body)
    expect(request.mock.calls[1][1].headers.Authorization).toBe('Bearer rotated')
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
    expect(authorizeNative).not.toHaveBeenCalled()
  })

  it('stops after a second authentication refusal without another refresh', async () => {
    const { account } = fixture()
    const request = vi.fn(async () => new Response('', { status: 401 }))
    vi.stubGlobal('fetch', request)
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({
      access_token: 'rotated',
      refresh_token: 'rotated-refresh'
    } as never)
    await expect(account.company({ action: 'list' }, AbortSignal.timeout(2000))).rejects.toMatchObject({
      code: 'authentication'
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
    expect(authorizeNative).not.toHaveBeenCalled()
  })

  it('does not replay a request after its refresh is revoked', async () => {
    const { account } = fixture()
    const request = vi.fn(async () => new Response('', { status: 401 }))
    vi.stubGlobal('fetch', request)
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValue(
      new oidc.ResponseBodyError('invalid_grant', {
        cause: { error: 'invalid_grant' },
        response: new Response('', { status: 400 })
      })
    )
    await expect(account.company({ action: 'list' }, AbortSignal.timeout(2000))).rejects.toThrow(
      'matrix_domain_signed_out'
    )
    expect(request).toHaveBeenCalledTimes(1)
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
    expect(account.appScope()).toBeNull()
    expect(authorizeNative).not.toHaveBeenCalled()
  })
})

describe('company file account fence and encrypted recovery', () => {
  const companyId = '00000000-0000-4000-8000-8c031eadb7f3'
  const channelId = '00000000-0000-4000-8000-01670d853f95'
  const requestId = '00000000-0000-4000-8000-46dfc9f2c745'
  const fileId = '00000000-0000-4000-8000-f739b2d7b3b6'
  const roomId = '!launch:atum.example'
  const sha256 = 'a'.repeat(64)
  const transactionId = `atum-cf-${requestId}`
  const file = { v: 1, company_id: companyId, channel_id: channelId, file_id: fileId, revision: 1,
    name: 'brief.pdf', content_type: 'application/pdf', size: 1048576, sha256 }
  const pending = { schemaVersion: 1 as const, phase: 'writing' as const, requestId, companyId, channelId, roomId,
    name: file.name, contentType: file.content_type, size: file.size, sha256, transactionId, fileId, revision: 1 as const }
  const status = () => new Response(JSON.stringify({ schemaVersion: 1, state: 'ready', requestId, file,
    resource: { storage: 'storage-users-1', space: '00000000-0000-4000-8000-e49db4f83c68', opaque: '00000000-0000-4000-8000-3850afc27747' },
    etag: '"team-space-v1"' }), { headers: { 'Content-Type': 'application/json' } })

  it('partitions, validates, persists and clears only public recovery metadata', () => {
    const f = fixture()
    f.account.writeCompanyFilePending(pending)
    const key = `matrix-company-file-pending:${f.account.appScope()!.accountKey}`
    expect(f.account.companyFilePending()).toEqual(pending)
    expect(f.store.getItem(key)).not.toMatch(/nativeGrant|serverUrl|localPath|resource|etag|credential|error/)
    f.store.setItem(key, JSON.stringify({ ...pending, nativeGrant: 'forged' }))
    expect(() => f.account.companyFilePending()).toThrow('matrix_company_file_unavailable')
    expect(() => f.account.writeCompanyFilePending({ ...pending, transactionId: 'foreign' })).toThrow('matrix_company_file_invalid')
    expect(() => f.account.writeCompanyFilePending({ ...pending, revision: undefined })).toThrow('matrix_company_file_invalid')
    expect(() => f.account.writeCompanyFilePending({ ...pending, phase: 'ready', fileId: undefined, revision: undefined })).toThrow('matrix_company_file_invalid')
    expect(() => f.account.writeCompanyFilePending({ ...pending, phase: 'published' })).toThrow('matrix_company_file_invalid')
    expect(() => f.account.writeCompanyFilePending({ ...pending, eventId: '$wrong-phase' })).toThrow('matrix_company_file_invalid')
    expect(() => f.account.writeCompanyFilePending({ ...pending, threadRootId: '$only-one' })).toThrow('matrix_company_file_invalid')
    f.store.setItem(key, JSON.stringify(pending))
    f.account.clearCompanyFilePending()
    expect(f.account.companyFilePending()).toBeNull()
  })

  it('does not cross account partitions and fails before a platform call if durable recovery cannot be saved', async () => {
    const f = fixture()
    f.account.writeCompanyFilePending(pending)
    const alice = f.read()
    const aliceKey = f.account.appScope()!.accountKey
    f.store.setItem('matrix-account', JSON.stringify({ ...alice, subject: 'bob', userId: '@bob:test', domain: { ...alice.domain, subject: 'bob' } }))
    const bob = new MatrixAccount(config, f.store, f.open, f.clearLocalHermes, f.clearAppDevice)
    expect(bob.appScope()!.accountKey).not.toBe(aliceKey)
    expect(bob.companyFilePending()).toBeNull()
    const save = f.store.setItem.bind(f.store)
    vi.spyOn(f.store, 'setItem').mockImplementation((key, value) => {
      if (key.startsWith('matrix-company-file-pending:')) { throw new Error('journal write failed') }
      save(key, value)
    })
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    expect(() => bob.writeCompanyFilePending(pending)).toThrow('journal write failed')
    expect(request).not.toHaveBeenCalled()
  })

  it('suppresses late file results after an account switch or domain-session replacement', async () => {
    const f = fixture()
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => response.promise))
    const request = { action: 'status' as const, companyId, channelId, requestId }
    const inFlight = f.account.companyFile(request, AbortSignal.timeout(2000))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    f.store.setItem('matrix-account', JSON.stringify({ ...f.read(), storageKey: Buffer.alloc(32, 9).toString('base64') }))
    response.resolve(status())
    await expect(inFlight).rejects.toThrow('matrix_company_file_cancelled')

    const second = fixture()
    const delayed = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => delayed.promise))
    const session = second.account.companyFile(request, AbortSignal.timeout(2000))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    second.store.setItem('matrix-account', JSON.stringify({ ...second.read(), domain: { ...second.read().domain, sessionId: 'replacement' } }))
    delayed.resolve(status())
    await expect(session).rejects.toThrow('matrix_company_file_cancelled')
  })

  it('refreshes a refused company-file platform token once and then replays the exact request', async () => {
    const f = fixture()
    const reserved = { schemaVersion: 1, state: 'reserved', requestId, file, serverUrl: 'https://drive.atumplatform.com',
      uploadGrant: { token: 'A'.repeat(43), expiresAtMs: 1791878400000 } }
    const request = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(
      new Response(JSON.stringify(reserved), { headers: { 'Content-Type': 'application/json' } })
    )
    vi.stubGlobal('fetch', request)
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({ access_token: 'rotated', refresh_token: 'rotated-refresh' } as never)
    await expect(f.account.companyFile({ action: 'reserve', companyId, channelId, requestId, name: file.name,
      contentType: file.content_type, size: file.size, sha256 }, AbortSignal.timeout(2000))).resolves.toMatchObject({
      uploadGrant: { nativeGrant: 'A'.repeat(43) }
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0][1].body).toBe(request.mock.calls[1][1].body)
    expect(request.mock.calls[1][1].headers.Authorization).toBe('Bearer rotated')
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
  })
})

describe('finishing revocations a sign-out could not', () => {
  const orphan = (executorId: string, extra: Record<string, unknown> = {}) => ({
    executorId,
    issuer: config.issuer,
    subject: 'alice',
    resource: config.domain.resource,
    reason: 'domain_authority_lost',
    recordedAt: 1,
    ...extra
  })

  const stored = (store: EncryptedStore) =>
    JSON.parse(store.getItem('matrix-orphaned-enrollments') ?? '[]') as Array<{ executorId: string }>

  it('withdraws each orphan with the same person’s authority and forgets only what the platform confirmed', async () => {
    const { account, store } = fixture()
    store.setItem(
      'matrix-orphaned-enrollments',
      JSON.stringify([
        orphan('00000000-0000-4000-8000-bd7662a5eeb4'),
        orphan('00000000-0000-4000-8000-b454f82c5857', { app: 'river' }),
        orphan('00000000-0000-4000-8000-f6222a1106ee', { agent: '00000000-0000-4000-8000-f1d11edf5c5c' }),
        orphan('00000000-0000-4000-8000-fbfe405ca65f', { subject: 'bob' })
      ])
    )

    await expect(account.reconcileOrphanedEnrollments()).resolves.toEqual({ attempted: true, cleared: 3, remaining: 1 })
    expect(requestEnrollment).toHaveBeenCalledWith(
      config.domain.resource,
      expect.objectContaining({ accessToken: 'domain-access' }),
      '00000000-0000-4000-8000-bd7662a5eeb4',
      'DELETE'
    )
    expect(requestEnrollment).toHaveBeenCalledWith(
      config.domain.resource,
      expect.anything(),
      '00000000-0000-4000-8000-b454f82c5857',
      'DELETE',
      { slug: 'river' }
    )
    expect(requestEnrollment).toHaveBeenCalledWith(
      config.domain.resource,
      expect.anything(),
      '00000000-0000-4000-8000-f6222a1106ee',
      'DELETE'
    )
    // Another account's record is never sent with this person's authority.
    expect(vi.mocked(requestEnrollment).mock.calls.some(call => call[2] === '00000000-0000-4000-8000-fbfe405ca65f')).toBe(false)
    expect(stored(store).map(item => item.executorId)).toEqual(['00000000-0000-4000-8000-fbfe405ca65f'])
    expect(account.hasOrphanedEnrollments()).toBe(true)
  })

  it('clears the notice once nothing is left, and keeps what the platform could not confirm', async () => {
    const { account, store } = fixture()
    store.setItem('matrix-orphaned-enrollments', JSON.stringify([orphan('00000000-0000-4000-8000-bd7662a5eeb4')]))
    await account.reconcileOrphanedEnrollments()
    expect(account.hasOrphanedEnrollments()).toBe(false)
    expect(store.getItem('matrix-orphaned-enrollments')).toBeNull()

    store.setItem(
      'matrix-orphaned-enrollments',
      JSON.stringify([
        orphan('00000000-0000-4000-8000-a9703d75e616'),
        orphan('00000000-0000-4000-8000-f2da1f9533d4'),
        orphan('00000000-0000-4000-8000-c8f367a876b2')
      ])
    )
    vi.mocked(requestEnrollment)
      .mockRejectedValueOnce(new Error('matrix_enrollment_unavailable'))
      .mockRejectedValueOnce(new MatrixEnrollmentRateLimited(60_000))
    await expect(account.reconcileOrphanedEnrollments()).resolves.toEqual({ attempted: true, cleared: 0, remaining: 3 })
    // Asked to wait: the rest are left for the next launch rather than retried now.
    expect(requestEnrollment).toHaveBeenCalledTimes(3)
    expect(stored(store)).toHaveLength(3)
  })

  it('needs this person’s platform authority and never touches an executor still in use', async () => {
    const offline = fixture(false)
    offline.store.setItem('matrix-orphaned-enrollments', JSON.stringify([orphan('00000000-0000-4000-8000-bd7662a5eeb4')]))
    await expect(offline.account.reconcileOrphanedEnrollments()).resolves.toEqual({ attempted: false, cleared: 0, remaining: 1 })
    expect(requestEnrollment).not.toHaveBeenCalled()

    const { account, store } = fixture()
    const current = await account.enrollHermes()
    vi.mocked(requestEnrollment).mockClear()
    store.setItem('matrix-orphaned-enrollments', JSON.stringify([orphan(current.identity!.executorId)]))
    await expect(account.reconcileOrphanedEnrollments()).resolves.toEqual({ attempted: true, cleared: 0, remaining: 1 })
    expect(requestEnrollment).not.toHaveBeenCalled()
  })
})

describe('a cloud-only agent never creates a local executor', () => {
  const agentPrincipal = '32345678-1234-1234-1234-123456789abc'

  it('skips the local-executor POST for the default assistant', async () => {
    const f = fixture(true, { localExecutorRequired: () => false })

    expect(await f.account.enrollHermes()).toEqual({ state: 'absent', identity: null })
    expect(ensureDomainAssistant).toHaveBeenCalledOnce()
    expect(requestEnrollment).not.toHaveBeenCalled()
    expect(requestLocalEnrollmentCapabilities).not.toHaveBeenCalled()
    expect(f.read().enrollment).toBeUndefined()
  })

  it('skips it for a named agent the same decision leaves to the cloud', async () => {
    const f = fixture(true, { localExecutorRequired: agent => agent === undefined })

    expect(await f.account.enrollAgent(agentPrincipal)).toEqual({ state: 'absent', identity: null })
    expect(requestEnrollment).not.toHaveBeenCalled()
    expect(f.read().agentEnrollments?.[agentPrincipal]).toBeUndefined()
  })

  it('keeps the ordinary local enrollment when the decision allows it', async () => {
    const f = fixture(true, { localExecutorRequired: () => true })

    expect((await f.account.enrollHermes()).state).toBe('ready')
    expect(requestEnrollment).toHaveBeenCalledOnce()
  })

  it('never applies the assistant decision to an app enrollment', async () => {
    const f = appFixture({ localExecutorRequired: () => false })

    await expect(f.account.enrollApp(riverApp, true)).resolves.toMatchObject({ identity: { userId: '@river:test' } })
    expect(requestEnrollment).toHaveBeenCalledOnce()
  })
})
