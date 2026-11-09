/**
 * Renewing an agent's executor credential before it expires (launch checklist G1-12,
 * G1-30; stream RT, slice 2): the platform's rotation of the same executor, and the
 * Retry-After of its per-owner bounds (0150).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as oidc from 'openid-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EncryptedStore } from '../encrypted-store'

import { MatrixAccount } from './account'
import { matrixConfigurationKey } from './config'
import { ensureDomainAssistant, readDomainIdentity } from './domain'
import type * as DomainModule from './domain'
import type * as EnrollmentModule from './enrollment'
import { MatrixEnrollmentRateLimited, requestEnrollment, requestLocalEnrollmentCapabilities } from './enrollment'

vi.mock('./authorization', () => ({ authorizeNative: vi.fn() }))
vi.mock('./domain', async importOriginal => ({
  ...(await importOriginal<typeof DomainModule>()),
  readDomainIdentity: vi.fn(),
  ensureDomainAssistant: vi.fn()
}))
vi.mock('./enrollment', async importOriginal => ({
  ...(await importOriginal<typeof EnrollmentModule>()),
  requestEnrollment: vi.fn(),
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
  vi.useRealTimers()
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
const defaultAgent = '22345678-1234-1234-1234-123456789abc'
const otherAgent = '32345678-1234-1234-1234-123456789abc'

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

/** The platform as the desktop sees it: each POST issues the same session and device for an
 * executor, with a new token and a new hour, as MAS's regenerate does. */
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-renewal-test-'))
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
      domain: { ...grant, sessionId: 'domain-session' }
    })
  )

  let issued = 0
  let currentDefault = defaultAgent
  const executorAgents = new Map<string, string>()
  vi.mocked(readDomainIdentity).mockResolvedValue(identity)
  vi.mocked(ensureDomainAssistant).mockImplementation(async () => ({
    agentPrincipal: currentDefault,
    matrixUser: currentDefault === defaultAgent ? '@hermes:test' : '@other:test'
  }))
  vi.mocked(requestLocalEnrollmentCapabilities).mockResolvedValue(false)
  vi.mocked(requestEnrollment).mockImplementation(async (_resource, _grant, executorId, method, _app, agent) => {
    if (method === 'DELETE') {
      executorAgents.delete(executorId)

      return null
    }

    // 0146/0150 bind an existing executor before resolving a requested agent/default.
    const agentPrincipal = executorAgents.get(executorId) ?? agent ?? currentDefault
    executorAgents.set(executorId, agentPrincipal)

    return {
      ...identity,
      executorId,
      agentPrincipal,
      userId: agentPrincipal === defaultAgent ? '@hermes:test' : '@other:test',
      deviceId: agentPrincipal === defaultAgent ? 'AGENT' : 'OTHER',
      accessToken: `agent-token-${++issued}`,
      expiresAt: Date.now() + 3_600_000
    }
  })

  const clearLocalHermes = vi.fn(async () => {})

  const account = new MatrixAccount(
    config,
    store,
    vi.fn(async () => {}),
    clearLocalHermes,
    vi.fn(async () => {})
  )

  const read = () => JSON.parse(store.getItem('matrix-account')!)
  const posts = () => vi.mocked(requestEnrollment).mock.calls.filter(call => call[3] === 'POST')

  const restart = () =>
    new MatrixAccount(
      config,
      new EncryptedStore(path.join(directory, 'vault.json'), {
        isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(value),
        decryptString: value => value.toString()
      }),
      vi.fn(async () => {}),
      clearLocalHermes
    )

  return {
    directory,
    account,
    store,
    read,
    posts,
    clearLocalHermes,
    restart,
    promote: () => {
      currentDefault = otherAgent
    },
    forgetExecutor: (executorId: string) => executorAgents.delete(executorId)
  }
}

describe('renewing a ready credential', () => {
  it('pins an undelivered first enrollment through restart and default promotion', async () => {
    const f = fixture()
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new Error('offline'))
    await expect(f.account.enrollHermes()).rejects.toThrow('offline')
    const pending = f.read().enrollment
    expect(pending).toMatchObject({ state: 'pending', agentPrincipal: defaultAgent })
    expect(pending.credential).toBeUndefined()
    f.promote()
    vi.mocked(ensureDomainAssistant).mockClear()

    const restarted = f.restart()
    expect(restarted.retainedAgentPrincipal()).toBe(defaultAgent)
    expect(() => restarted.agentSdkConfiguration()).toThrow('matrix_agent_unavailable')
    const root = await restarted.enrollHermes(false)

    expect(root.identity?.agentPrincipal).toBe(defaultAgent)
    expect(f.posts().map(call => [call[2], call[5]])).toEqual([
      [pending.executorId, defaultAgent],
      [pending.executorId, defaultAgent]
    ])
    expect(ensureDomainAssistant).not.toHaveBeenCalled()
    expect(restarted.agentSdkConfiguration().storageKey).toBe(pending.storageKey)
    expect(f.read().agentEnrollments).toBeUndefined()
  })

  it("rotates the default agent's own executor: the same session and device, a new token and hour", async () => {
    const { account, read, posts } = fixture()
    const enrolled = await account.enrollHermes()
    const before = read().enrollment

    const renewed = await account.renewAgentExecutor()

    expect(posts()).toHaveLength(2)
    const [, bearer, executorId, method, app, agent] = posts()[1]!
    expect([bearer.accessToken, executorId, method, app, agent]).toEqual([
      'domain-access',
      before.executorId,
      'POST',
      undefined,
      defaultAgent
    ])

    const after = read().enrollment
    expect(after.credential.accessToken).toBe('agent-token-2')
    expect(after.credential.expiresAt).toBeGreaterThanOrEqual(before.credential.expiresAt)
    expect({ ...after, credential: undefined }).toEqual({ ...before, credential: undefined })
    expect(renewed).toEqual({
      state: 'ready',
      identity: { ...enrolled.identity, expiresAt: after.credential.expiresAt }
    })
    expect(JSON.stringify(renewed)).not.toContain('agent-token')
    expect(account.agentSdkConfiguration().accessToken).toBe('agent-token-2')
  })

  it.each(['renewal', 'expired re-enrollment'] as const)(
    'pins retained root custody through default promotion and restart during %s, even if the executor is absent',
    async mode => {
      const f = fixture()
      const root = await f.account.enrollHermes()
      await f.account.enrollAgent(otherAgent)
      f.account.retainHermesProfile('/fixture/root-import')
      f.account.retainHermesProfile('/fixture/main-import', otherAgent)
      f.promote()
      f.forgetExecutor(root.identity!.executorId)

      const record = f.read()

      if (mode === 'expired re-enrollment') {
        record.enrollment.credential.expiresAt = 1
        f.store.setItem('matrix-account', JSON.stringify(record))
      }

      const before = f.read()
      const account = f.restart()
      expect(account.retainedAgentPrincipal()).toBe(defaultAgent)
      expect(account.retainedAgentPrincipal(otherAgent)).toBe(otherAgent)
      const result = mode === 'renewal' ? await account.renewAgentExecutor() : await account.enrollHermes(false)

      expect(f.posts().at(-1)?.[5]).toBe(defaultAgent)
      expect(result.identity).toEqual({ ...root.identity, expiresAt: f.read().enrollment.credential.expiresAt })
      expect({ ...f.read().enrollment, credential: undefined }).toEqual({ ...before.enrollment, credential: undefined })
      expect(f.read().localHermes).toEqual(before.localHermes)
      expect(f.read().agentHermes).toEqual(before.agentHermes)
      expect(f.read().agentEnrollments).toEqual(before.agentEnrollments)
      expect(account.agentSdkConfiguration().storageKey).toBe(before.enrollment.storageKey)
      expect(account.agentSdkConfiguration({ agent: otherAgent }).storageKey).toBe(
        before.agentEnrollments[otherAgent].storageKey
      )
      expect(f.clearLocalHermes).not.toHaveBeenCalled()
    }
  )

  it('first root provisioning resolves the current default without inventing a named slot', async () => {
    const f = fixture()
    expect(f.account.retainedAgentPrincipal()).toBeUndefined()
    f.promote()
    const root = await f.account.enrollHermes(false)
    expect(root.identity?.agentPrincipal).toBe(otherAgent)
    expect(f.posts()[0]?.[5]).toBe(otherAgent)
    expect(f.read().agentEnrollments).toBeUndefined()
    expect(f.account.retainedAgentPrincipal()).toBe(otherAgent)
  })

  it('names another agent, and renews only that agent', async () => {
    const { account, read, posts } = fixture()
    await account.enrollHermes()
    await account.enrollAgent(otherAgent)
    const defaultBefore = read().enrollment

    await account.renewAgentExecutor(otherAgent)

    expect(posts().at(-1)?.[5]).toBe(otherAgent)
    expect(read().agentEnrollments[otherAgent].credential.accessToken).toBe('agent-token-3')
    expect(read().enrollment).toEqual(defaultBefore)
    expect(account.agentSdkConfiguration({ agent: otherAgent }).accessToken).toBe('agent-token-3')
  })

  it('coalesces renewals of one agent into one rotation', async () => {
    const { account, posts } = fixture()
    await account.enrollHermes()

    const [a, b] = await Promise.all([account.renewAgentExecutor(), account.renewAgentExecutor()])

    expect(a).toEqual(b)
    expect(posts()).toHaveLength(2)
  })

  it('refreshes a rejected domain grant once, then rotates', async () => {
    const { account, posts } = fixture()
    await account.enrollHermes()
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
      access_token: 'domain-access-2',
      refresh_token: 'domain-refresh-2',
      expires_in: 300
    } as Awaited<ReturnType<typeof oidc.refreshTokenGrant>>)
    const issue = vi.mocked(requestEnrollment).getMockImplementation()!
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new Error('matrix_enrollment_authentication'))
    vi.mocked(requestEnrollment).mockImplementation(issue)

    await account.renewAgentExecutor()

    expect(
      posts()
        .slice(1)
        .map(call => call[1].accessToken)
    ).toEqual(['domain-access', 'domain-access-2'])
  })
})

describe('what a renewal refuses', () => {
  it('cleans a withdrawn root custody after retirement while preserving named agents', async () => {
    const { account, read, clearLocalHermes } = fixture()
    await account.enrollHermes()
    await account.enrollAgent(otherAgent)
    account.retainHermesProfile('/fixture/default-profile')
    account.retainHermesProfile('/fixture/other-profile', otherAgent)
    const otherBefore = read().agentEnrollments[otherAgent]
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new Error('matrix_enrollment_denied'))
    await expect(account.renewAgentExecutor()).rejects.toThrow('matrix_enrollment_denied')
    expect(account.enrollment()).toEqual({ state: 'withdrawn', identity: null })
    expect(account.retainedAgentPrincipal()).toBe(defaultAgent)
    expect(account.retainedAgentDevice()).toEqual({ userId: '@hermes:test', deviceId: 'AGENT' })
    expect(() => account.agentSdkConfiguration()).toThrow('matrix_agent_unavailable')

    await account.revokeHermes()

    expect(clearLocalHermes).toHaveBeenCalledExactlyOnceWith('/fixture/default-profile')
    expect(account.retainedAgentPrincipal()).toBeUndefined()
    expect(account.retainedAgentDevice()).toBeUndefined()
    expect(account.enrollment()).toEqual({ state: 'absent', identity: null })
    expect(read().localHermes).toBeUndefined()
    expect(read().agentEnrollments[otherAgent]).toEqual(otherBefore)
    expect(account.retainedAgentPrincipal(otherAgent)).toBe(otherAgent)
    expect(account.retainedAgentDevice(otherAgent)).toEqual({ userId: '@other:test', deviceId: 'OTHER' })
    await account.revokeHermes()
    expect(clearLocalHermes).toHaveBeenCalledTimes(1)
  })

  it('persists a correlated renewal denial without discarding device, key, token or retained profile', async () => {
    const { directory, account, read, posts } = fixture()
    await account.enrollHermes()
    account.retainHermesProfile('/fixture/default-profile')
    const before = read()
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new Error('matrix_enrollment_denied'))

    await expect(account.renewAgentExecutor()).rejects.toThrow('matrix_enrollment_denied')
    const withdrawn = { ...before, enrollment: { ...before.enrollment, state: 'withdrawn' } }
    expect(read()).toEqual(withdrawn)
    expect(account.enrollment()).toEqual({ state: 'withdrawn', identity: null })

    const reloadedStore = new EncryptedStore(path.join(directory, 'vault.json'), {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString()
    })

    expect(JSON.parse(reloadedStore.getItem('matrix-account')!)).toEqual(withdrawn)
    const restarted = new MatrixAccount(config, reloadedStore, vi.fn(async () => {}))
    expect(restarted.enrollment()).toEqual({ state: 'withdrawn', identity: null })
    expect(restarted.retainedAgentPrincipal()).toBe(defaultAgent)
    expect(() => restarted.agentSdkConfiguration()).toThrow('matrix_agent_unavailable')
    await expect(restarted.enrollHermes(false)).rejects.toThrow('matrix_enrollment_withdrawn')
    await expect(restarted.renewAgentExecutor()).rejects.toThrow('matrix_agent_unavailable')
    expect(posts()).toHaveLength(2)
    expect(read()).toEqual(withdrawn)
  })

  it('withdraws a denied other-agent renewal without altering the default agent', async () => {
    const { account, read, posts } = fixture()
    await account.enrollHermes()
    await account.enrollAgent(otherAgent)
    account.retainHermesProfile('/fixture/other-profile', otherAgent)
    const before = read()
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new Error('matrix_enrollment_denied'))

    await expect(account.renewAgentExecutor(otherAgent)).rejects.toThrow('matrix_enrollment_denied')
    expect(read()).toEqual({
      ...before,
      agentEnrollments: {
        ...before.agentEnrollments, [otherAgent]: { ...before.agentEnrollments[otherAgent], state: 'withdrawn' }
      }
    })
    expect(account.agentEnrollment(otherAgent)).toEqual({ state: 'withdrawn', identity: null })
    expect(account.retainedAgentPrincipal(otherAgent)).toBe(otherAgent)
    await expect(account.enrollAgent(otherAgent)).rejects.toThrow('matrix_enrollment_withdrawn')
    expect(account.agentSdkConfiguration().accessToken).toBe('agent-token-1')
    expect(posts()).toHaveLength(3)
  })

  it.each(['generation', 'domain session', 'domain token', 'executor', 'agent token', 'revocation'] as const)(
    'does not persist a renewal denial after the %s changed', async changed => {
      const { account, read, store } = fixture()
      await account.enrollHermes()
      const denial = deferred<Error>()
      vi.mocked(requestEnrollment).mockImplementationOnce(async () => { throw await denial.promise })
      const pending = account.renewAgentExecutor()
      await vi.waitFor(() => expect(requestEnrollment).toHaveBeenCalledTimes(2))
      const next = read()

      switch (changed) {
        case 'generation':
          account.cancel()

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

        case 'revocation':
          next.enrollment.state = 'revoking'

          break
      }

      store.setItem('matrix-account', JSON.stringify(next))
      const rejected = expect(pending).rejects.toThrow('matrix_enrollment_denied')
      denial.resolve(new Error('matrix_enrollment_denied'))
      await rejected
      expect(read()).toEqual(next)
    }
  )

  it.each(['matrix_enrollment_unavailable', 'network'])(
    'does not withdraw custody for a renewal %s', async message => {
      const { account, read } = fixture()
      await account.enrollHermes()
      const before = read()
      vi.mocked(requestEnrollment).mockRejectedValueOnce(new Error(message))
      await expect(account.renewAgentExecutor()).rejects.toThrow(message)
      expect(read()).toEqual(before)
    }
  )

  it('persists only the correlated denial of the one authenticated renewal replay', async () => {
    const { account, read, posts } = fixture()
    await account.enrollHermes()
    const before = read().enrollment
    vi.mocked(requestEnrollment)
      .mockRejectedValueOnce(new Error('matrix_enrollment_authentication'))
      .mockRejectedValueOnce(new Error('matrix_enrollment_denied'))
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
      access_token: 'domain-access-2', refresh_token: 'domain-refresh-2', expires_in: 300
    } as Awaited<ReturnType<typeof oidc.refreshTokenGrant>>)

    await expect(account.renewAgentExecutor()).rejects.toThrow('matrix_enrollment_denied')
    expect(posts().slice(1).map(call => call[1].accessToken)).toEqual(['domain-access', 'domain-access-2'])
    expect(read().enrollment).toEqual({ ...before, state: 'withdrawn' })
  })

  it.each([
    ['another device', { deviceId: 'ELSEWHERE' }],
    ['another user', { userId: '@stranger:test' }],
    ['another agent', { agentPrincipal: otherAgent }]
  ])('keeps the current credential, and revokes nothing, when the answer is %s', async (_name, change) => {
    const { account, read } = fixture()
    await account.enrollHermes()
    const before = read().enrollment
    const issue = vi.mocked(requestEnrollment).getMockImplementation()!
    vi.mocked(requestEnrollment).mockImplementationOnce(async (...args) => ({
      ...((await issue(...args)) as object),
      ...change
    }))

    await expect(account.renewAgentExecutor()).rejects.toThrow('matrix_enrollment_invalid')

    expect(read().enrollment).toEqual(before)
    expect(vi.mocked(requestEnrollment).mock.calls.some(call => call[3] === 'DELETE')).toBe(false)
  })

  it.each([
    ['another device', { deviceId: 'ELSEWHERE' }],
    ['another user', { userId: '@stranger:test' }],
    ['another principal', { agentPrincipal: otherAgent }],
    ['foreign owner', { subject: 'stranger' }]
  ])('retains inert expired custody after re-enrollment returns %s, including after restart', async (_name, change) => {
    const f = fixture()
    await f.account.enrollHermes()
    await f.account.enrollAgent(otherAgent)
    f.account.retainHermesProfile('/fixture/root-import')
    f.account.retainHermesProfile('/fixture/main-import', otherAgent)
    const expired = f.read()
    expired.enrollment.credential.expiresAt = 1
    f.store.setItem('matrix-account', JSON.stringify(expired))
    f.promote()
    const issue = vi.mocked(requestEnrollment).getMockImplementation()!
    vi.mocked(requestEnrollment).mockImplementationOnce(async (...args) => ({
      ...((await issue(...args)) as object),
      ...change
    }))

    await expect(f.restart().enrollHermes(false)).rejects.toThrow('matrix_enrollment_invalid')
    expect(f.read()).toEqual({ ...expired, enrollment: { ...expired.enrollment, state: 'pending' } })
    expect(f.clearLocalHermes).not.toHaveBeenCalled()
    expect(vi.mocked(requestEnrollment).mock.calls.some(call => call[3] === 'DELETE')).toBe(false)

    const restarted = f.restart()
    expect(restarted.enrollment()).toEqual({ state: 'pending', identity: null })
    expect(restarted.retainedAgentPrincipal()).toBe(defaultAgent)
    expect(() => restarted.agentSdkConfiguration()).toThrow('matrix_agent_unavailable')
    expect((await restarted.enrollHermes(false)).identity?.deviceId).toBe(expired.enrollment.credential.deviceId)
    expect(f.posts().at(-1)?.[5]).toBe(defaultAgent)
    expect(f.read().localHermes).toEqual(expired.localHermes)
    expect(f.read().agentEnrollments).toEqual(expired.agentEnrollments)
  })

  it('renews nothing that is not ready: absent, pending, expired, revoking or withdrawn', async () => {
    const { account, read, store, posts } = fixture()
    await expect(account.renewAgentExecutor()).rejects.toThrow('matrix_agent_unavailable')

    await account.enrollHermes()
    const record = read()

    for (const enrollment of [
      { ...record.enrollment, credential: { ...record.enrollment.credential, expiresAt: 1 } },
      { executorId: record.enrollment.executorId, state: 'pending' },
      { executorId: record.enrollment.executorId, state: 'revoking' },
      { ...record.enrollment, state: 'withdrawn' }
    ]) {
      store.setItem('matrix-account', JSON.stringify({ ...record, enrollment }))
      await expect(account.renewAgentExecutor()).rejects.toThrow('matrix_agent_unavailable')
    }

    expect(posts()).toHaveLength(1)
  })

  it('does not write a renewal that answers after a sign-out began', async () => {
    const { account, read } = fixture()
    await account.enrollHermes()
    const answer = deferred<unknown>()
    vi.mocked(requestEnrollment).mockReturnValueOnce(answer.promise)
    const before = read().enrollment

    const renewal = account.renewAgentExecutor()
    await vi.waitFor(() => expect(requestEnrollment).toHaveBeenCalledTimes(2))
    account.cancel()
    answer.resolve({ ...identity, ...before.credential, accessToken: 'late', expiresAt: Date.now() + 3_600_000 })

    await expect(renewal).rejects.toThrow('matrix_login_cancelled')
    expect(read().enrollment).toEqual(before)
  })

  it('holds a new credential the vault cannot keep, and the next try saves it instead of rotating again', async () => {
    const { account, read, store, posts } = fixture()
    await account.enrollHermes()
    const before = read().enrollment
    const save = store.setItem.bind(store)
    let full = true

    const write = vi.spyOn(store, 'setItem').mockImplementation((key, value) => {
      if (full && key === 'matrix-account' && JSON.parse(value).enrollment?.credential?.accessToken === 'agent-token-2') {
        throw new Error('auth_storage_write_failed')
      }

      save(key, value)
    })

    // A passing failure the renewal schedule retries (never one that stops it).
    await expect(account.renewAgentExecutor()).rejects.toThrow('matrix_vault_unavailable')
    expect(read().enrollment).toEqual(before)
    // Still full at the next try: still held, and nothing re-issued.
    await expect(account.renewAgentExecutor()).rejects.toThrow('matrix_vault_unavailable')
    expect(posts()).toHaveLength(2)

    full = false
    const renewed = await account.renewAgentExecutor()
    expect(posts()).toHaveLength(2)
    expect(read().enrollment.credential.accessToken).toBe('agent-token-2')
    expect(renewed.state).toBe('ready')
    expect(account.agentSdkConfiguration().accessToken).toBe('agent-token-2')

    // Nothing held any more: the next renewal rotates.
    await account.renewAgentExecutor()
    expect(posts()).toHaveLength(3)
    expect(read().enrollment.credential.accessToken).toBe('agent-token-3')
    write.mockRestore()
  })

  it('drops a held credential that is no longer the agent’s, and rotates from what the record holds', async () => {
    const { account, read, store, posts } = fixture()
    await account.enrollHermes()
    const save = store.setItem.bind(store)

    const write = vi.spyOn(store, 'setItem').mockImplementation((key, value) => {
      if (key === 'matrix-account' && JSON.parse(value).enrollment?.credential?.accessToken === 'agent-token-2') {
        throw new Error('auth_storage_write_failed')
      }

      save(key, value)
    })

    await expect(account.renewAgentExecutor()).rejects.toThrow('matrix_vault_unavailable')
    write.mockRestore()
    // The agent's credential changed meanwhile (an enrollment renewed it): the held one is stale.
    const record = read()
    store.setItem(
      'matrix-account',
      JSON.stringify({ ...record, enrollment: { ...record.enrollment, credential: { ...record.enrollment.credential, accessToken: 'agent-other' } } })
    )

    await account.renewAgentExecutor()
    expect(posts()).toHaveLength(3)
    expect(read().enrollment.credential.accessToken).toBe('agent-token-3')
  })
})

describe('never beside an enrollment or revocation of the same agent', () => {
  it('lets an enrollment wait for a renewal in flight, which then finds the credential renewed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'))
    const { account, read, store, posts } = fixture()
    await account.enrollHermes()
    const record = read()
    // Seconds from its end, as when a renewal runs late.
    store.setItem(
      'matrix-account',
      JSON.stringify({
        ...record,
        enrollment: {
          ...record.enrollment,
          credential: { ...record.enrollment.credential, expiresAt: Date.now() + 1_000 }
        }
      })
    )
    const answer = deferred<void>()
    const issue = vi.mocked(requestEnrollment).getMockImplementation()!
    vi.mocked(requestEnrollment).mockImplementationOnce(async (...args) => {
      const value = await issue(...args)
      await answer.promise

      return value
    })

    const renewal = account.renewAgentExecutor()
    await vi.waitFor(() => expect(posts()).toHaveLength(2))

    // The credential ends while the renewal is in flight, and the gate asks to enroll again.
    vi.setSystemTime(new Date('2026-09-29T10:00:02Z'))
    expect(account.enrollment().state).toBe('expired')
    const enrollment = account.enrollHermes(false)
    answer.resolve()

    await renewal
    expect((await enrollment).state).toBe('ready')
    // One rotation, not two racing on one executor.
    expect(posts()).toHaveLength(2)
    expect(read().enrollment.credential.accessToken).toBe('agent-token-2')
  })

  it('refuses to start while an enrollment or a revocation of the agent is pending', async () => {
    const { account } = fixture()
    await account.enrollHermes()
    const answer = deferred<unknown>()
    vi.mocked(requestEnrollment).mockReturnValueOnce(answer.promise)

    const revocation = account.revokeHermes()
    await vi.waitFor(() => expect(requestEnrollment).toHaveBeenCalledTimes(2))
    await expect(account.renewAgentExecutor()).rejects.toThrow('matrix_enrollment_pending')

    answer.resolve(null)
    await revocation
  })

  it('lets a revocation wait for a renewal in flight, then revoke what it left', async () => {
    const { account, read } = fixture()
    await account.enrollHermes()
    await account.enrollAgent(otherAgent)
    const answer = deferred<void>()
    const issue = vi.mocked(requestEnrollment).getMockImplementation()!
    vi.mocked(requestEnrollment).mockImplementationOnce(async (...args) => {
      const value = await issue(...args)
      await answer.promise

      return value
    })

    const renewal = account.renewAgentExecutor(otherAgent)
    await vi.waitFor(() =>
      expect(vi.mocked(requestEnrollment).mock.calls.filter(call => call[5] === otherAgent)).toHaveLength(2)
    )
    const revocation = account.revokeAgent(otherAgent)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(vi.mocked(requestEnrollment).mock.calls.some(call => call[3] === 'DELETE')).toBe(false)

    answer.resolve()
    await renewal
    await revocation

    const deletes = vi.mocked(requestEnrollment).mock.calls.filter(call => call[3] === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(read().agentEnrollments?.[otherAgent]).toBeUndefined()
  })
})

describe("the platform's per-owner bounds (0150)", () => {
  it('waits for Retry-After: nothing is sent before it, by a renewal or an enrollment of that agent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'))
    const { account, read, store, posts } = fixture()
    await account.enrollHermes()
    await account.enrollAgent(otherAgent)
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new MatrixEnrollmentRateLimited(120_000))

    await expect(account.renewAgentExecutor()).rejects.toMatchObject({ retryAfterMs: 120_000 })
    expect(posts()).toHaveLength(3)

    vi.setSystemTime(new Date('2026-09-29T10:00:30Z'))
    await expect(account.renewAgentExecutor()).rejects.toMatchObject({
      message: 'matrix_enrollment_rate_limited',
      retryAfterMs: 90_000
    })

    // After an expiry, the gate's enrollment of the same agent waits too, and leaves its record as it is.
    const record = read()

    const expired = {
      ...record,
      enrollment: { ...record.enrollment, credential: { ...record.enrollment.credential, expiresAt: 1 } }
    }

    store.setItem('matrix-account', JSON.stringify(expired))
    await expect(account.enrollHermes(false)).rejects.toMatchObject({ retryAfterMs: 90_000 })
    expect(read()).toEqual(expired)
    expect(posts()).toHaveLength(3)

    // Another agent is not held up by this one's wait.
    await account.renewAgentExecutor(otherAgent)
    expect(posts()).toHaveLength(4)

    vi.setSystemTime(new Date('2026-09-29T10:02:00Z'))
    expect((await account.enrollHermes(false)).state).toBe('ready')
    expect(posts()).toHaveLength(5)
  })

  it("remembers an enrollment's own 429 for the next enrollment of that agent", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'))
    const { account, read, store, posts } = fixture()
    await account.enrollHermes()
    const record = read()
    store.setItem(
      'matrix-account',
      JSON.stringify({
        ...record,
        enrollment: { ...record.enrollment, credential: { ...record.enrollment.credential, expiresAt: 1 } }
      })
    )
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new MatrixEnrollmentRateLimited(60_000))

    await expect(account.enrollHermes(false)).rejects.toBeInstanceOf(MatrixEnrollmentRateLimited)
    await expect(account.enrollHermes(false)).rejects.toMatchObject({ retryAfterMs: 60_000 })
    expect(posts()).toHaveLength(2)
  })

  it("keeps a revocation's own wait apart: an enrollment's never holds it up, its own is honoured", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'))
    const { account } = fixture()
    await account.enrollHermes()
    await account.enrollAgent(otherAgent)

    // The other agent's renewal is asked to wait; its revocation still goes out.
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new MatrixEnrollmentRateLimited(3_600_000))
    await expect(account.renewAgentExecutor(otherAgent)).rejects.toBeInstanceOf(MatrixEnrollmentRateLimited)
    await account.revokeAgent(otherAgent)
    expect(vi.mocked(requestEnrollment).mock.calls.filter(call => call[3] === 'DELETE')).toHaveLength(1)

    // A revocation refused under the tombstone bound is not sent again before its Retry-After.
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new MatrixEnrollmentRateLimited(120_000))
    await expect(account.revokeHermes()).rejects.toBeInstanceOf(MatrixEnrollmentRateLimited)
    const deletes = () => vi.mocked(requestEnrollment).mock.calls.filter(call => call[3] === 'DELETE').length
    expect(deletes()).toBe(2)

    vi.setSystemTime(new Date('2026-09-29T10:01:00Z'))
    await expect(account.revokeHermes()).rejects.toMatchObject({ retryAfterMs: 60_000 })
    expect(deletes()).toBe(2)

    vi.setSystemTime(new Date('2026-09-29T10:02:00Z'))
    expect((await account.revokeHermes()).state).toBe('absent')
    expect(deletes()).toBe(3)
  })

  it('forgets a wait at sign-out: another account is not bound by it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'))
    const { account, read, store, posts } = fixture()
    await account.enrollHermes()
    vi.mocked(requestEnrollment).mockRejectedValueOnce(new MatrixEnrollmentRateLimited(3_600_000))
    await expect(account.renewAgentExecutor()).rejects.toBeInstanceOf(MatrixEnrollmentRateLimited)

    // The same Mac, another sign-in: a new account storage key.
    store.setItem('matrix-account', JSON.stringify({ ...read(), storageKey: Buffer.alloc(32, 2).toString('base64') }))
    await account.renewAgentExecutor()
    expect(posts()).toHaveLength(3)
  })
})
