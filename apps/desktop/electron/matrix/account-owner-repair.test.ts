import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as oidc from 'openid-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EncryptedStore } from '../encrypted-store'

import { MatrixAccount } from './account'
import { authorizeNative } from './authorization'
import { matrixConfigurationKey } from './config'
import type * as EnrollmentModule from './enrollment'
import { requestEnrollment } from './enrollment'

vi.mock('./authorization', () => ({ authorizeNative: vi.fn() }))
vi.mock('./sign-in-entry', () => ({
  matrixSignInEntry: vi.fn(async ({ authorizationUrl }) => authorizationUrl)
}))
vi.mock('./enrollment', async original => ({
  ...(await original<typeof EnrollmentModule>()),
  requestEnrollment: vi.fn()
}))
vi.mock('openid-client', () => ({
  discovery: vi.fn(async (_url, clientId) => ({ clientId })),
  None: () => ({}),
  refreshTokenGrant: vi.fn(),
  tokenRevocation: vi.fn(async () => {})
}))

const directories: string[] = []
afterEach(() => {
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

const config = {
  issuer: 'https://id.test/',
  server: 'https://matrix.test',
  nativeClientId: 'matrix',
  callbackPort: 21881,
  domain: { nativeClientId: 'domain', resource: 'https://api.test' }
}
const owner = { userId: '@owner:test', deviceId: 'HUMAN_OLD' }
const principal = (name: string) =>
  `${Buffer.from(name).toString('hex').padEnd(8, '0').slice(0, 8)}-1111-4222-8333-444444444444`
const raymond = principal('raymond')

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })

  return { promise, resolve }
}

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-owner-repair-'))
  directories.push(directory)
  const store = new EncryptedStore(path.join(directory, 'vault.json'), {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString()
  })
  const enrollment = (name: string) => ({
    executorId: `executor-${name}`,
    enrollmentId: `enrollment-${name}`,
    state: 'ready',
    hostDevice: owner.deviceId,
    storageKey: Buffer.alloc(32, name.length + 2).toString('base64'),
    credential: {
      issuer: config.issuer,
      subject: 'owner-subject',
      principal: 'owner-principal',
      executorId: `executor-${name}`,
      agentPrincipal: principal(name),
      userId: `@${name}:test`,
      deviceId: `AGENT_${name}`,
      accessToken: `synthetic-${name}-token`,
      expiresAt: Date.now() + 3600_000
    }
  })
  const names = ['raymond', 'gigi', 'andy', 'moon', 'helper']
  const record = {
    version: 1,
    configurationKey: matrixConfigurationKey(config),
    issuer: config.issuer,
    subject: 'owner-subject',
    ...owner,
    storageKey: Buffer.alloc(32, 1).toString('base64'),
    accessToken: 'synthetic-human-old',
    refreshToken: 'synthetic-human-old-refresh',
    domain: {
      issuer: config.issuer,
      subject: 'owner-subject',
      accessToken: 'synthetic-domain',
      refreshToken: 'synthetic-domain-refresh',
      sessionId: 'domain-session',
      expiresAt: Date.now() + 3600_000
    },
    enrollment: enrollment('root'),
    localHermes: { executorId: 'executor-root', home: '/fixture/root' },
    agentEnrollments: Object.fromEntries(names.map(name => [principal(name), enrollment(name)])),
    agentHermes: Object.fromEntries(
      names.map(name => [principal(name), { executorId: `executor-${name}`, home: `/fixture/${name}` }])
    ),
    apps: { river: enrollment('river') },
    ownerRecoveryKey: 'synthetic-existing-recovery',
    ownerRecoveryCustody: 'device',
    // Forward-compatible unknown state also survives the same-person merge.
    recoveryIdentity: { master: 'synthetic-master', keyId: 'synthetic-key-id' }
  }
  store.setItem('matrix-account', JSON.stringify(record))
  const open = vi.fn<(_url: string) => Promise<void>>()
  const clearHome = vi.fn()
  const clearApp = vi.fn()
  const account = new MatrixAccount(config, store, open, clearHome, clearApp)
  const signOut = vi.spyOn(account, 'signOut')
  const read = () => JSON.parse(store.getItem('matrix-account')!)
  const before = read()

  return { account, store, read, before, open, clearHome, clearApp, signOut }
}

/** Real account prepare/commit/discard + disk store; only the browser/OIDC boundary is fake. */
function browser(
  f: ReturnType<typeof fixture>,
  overrides: { issuer?: string; subject?: string; userId?: string } = {}
) {
  const callback = gate()
  let deviceId = ''
  const issued = {
    issuer: overrides.issuer ?? config.issuer,
    subject: overrides.subject ?? 'owner-subject',
    accessToken: 'synthetic-human-new',
    refreshToken: 'synthetic-human-new-refresh'
  }
  const request = vi.fn(async (input: string) => {
    if (input !== `${config.server}/_matrix/client/v3/account/whoami`) {
      throw new Error('unexpected_network_path')
    }
    return Response.json({ user_id: overrides.userId ?? owner.userId, device_id: deviceId })
  })
  vi.stubGlobal('fetch', request)
  vi.mocked(authorizeNative).mockImplementation(async options => {
    let cancelled = false
    deviceId = /device:(\S+)/.exec(options.scope)![1]!
    const completed = callback.promise.then(async () => {
      try {
        const prepared = await options.prepare(issued)
        if (cancelled) {
          throw new Error('matrix_login_cancelled')
        }
        options.commit(prepared)
        await options.continueTo?.()

        return prepared
      } catch (error) {
        await options.discard(issued)
        throw error
      }
    })
    void completed.catch(() => {})

    return {
      authorizationUrl: 'https://id.test/authorize',
      completed,
      cancel: vi.fn(() => {
        cancelled = true
        callback.resolve()
      })
    }
  })
  f.open.mockImplementation(async () => callback.resolve())

  return { callback, request }
}

function expectNoParticipantChanges(f: ReturnType<typeof fixture>) {
  const after = f.read()
  for (const key of [
    'enrollment',
    'localHermes',
    'agentEnrollments',
    'agentHermes',
    'apps',
    'ownerRecoveryKey',
    'ownerRecoveryCustody',
    'recoveryIdentity',
    'domain'
  ]) {
    expect(after[key]).toEqual(f.before[key])
  }
  expect(requestEnrollment).not.toHaveBeenCalled()
  expect(f.clearHome).not.toHaveBeenCalled()
  expect(f.clearApp).not.toHaveBeenCalled()
  expect(f.signOut).not.toHaveBeenCalled()
  expect(oidc.refreshTokenGrant).not.toHaveBeenCalled()
  for (const [configuration, token] of vi.mocked(oidc.tokenRevocation).mock.calls) {
    expect(configuration).toEqual({ clientId: 'matrix' })
    expect(token).toMatch(/^synthetic-human-/)
  }
}

describe('explicit repair replaces only the human session', () => {
  it('keeps five agents, Raymond custody, homes, domain and recovery byte-for-byte for the same person', async () => {
    const f = fixture()
    const { request } = browser(f)
    const generation = f.account.driveOwner()!.generation
    await expect(f.account.signIn()).rejects.toThrow('matrix_sign_out_first')
    await expect(f.account.repairOwnerDevice(owner)).resolves.toEqual({ domain: true, replaced: owner })
    const after = f.read()
    expect(after.deviceId).not.toBe(owner.deviceId)
    expect(after.storageKey).not.toBe(f.before.storageKey)
    expect(after.accessToken).toBe('synthetic-human-new')
    expect(after.userId).toBe(owner.userId)
    expect(after.subject).toBe(f.before.subject)
    expect(f.account.sessionEnded()).toBeNull()
    expect(f.account.driveOwner()!.generation).toBe(generation)
    expect(f.account.recoveryKey(f.account.identity()!)).toBe(f.before.ownerRecoveryKey)
    await vi.waitFor(() =>
      expect(oidc.tokenRevocation).toHaveBeenCalledWith(
        { clientId: 'matrix' },
        'synthetic-human-old-refresh',
        expect.anything()
      )
    )
    expect(authorizeNative).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(1)
    expectNoParticipantChanges(f)
  })

  it.each([{ subject: 'different-subject' }, { issuer: 'https://other-id.test/' }, { userId: '@someone-else:test' }])(
    'refuses account switching %j without replacing any retained state',
    async mismatch => {
      const f = fixture()
      browser(f, mismatch)
      await expect(f.account.repairOwnerDevice(owner)).rejects.toThrow('matrix_account_mismatch')
      expect(f.read()).toEqual(f.before)
      expect(f.account.identity()).toEqual(owner)
      expect(oidc.tokenRevocation).not.toHaveBeenCalledWith(
        expect.anything(),
        'synthetic-human-old-refresh',
        expect.anything()
      )
      expectNoParticipantChanges(f)
    }
  )

  it('cancel before callback leaves the old session and agent operation generation usable', async () => {
    const f = fixture()
    const { callback } = browser(f)
    const generation = f.account.driveOwner()!.generation
    f.open.mockImplementation(async () => {
      f.account.cancelOwnerDeviceRepair()
      callback.resolve()
    })
    await expect(f.account.repairOwnerDevice(owner)).rejects.toThrow('matrix_login_cancelled')
    expect(f.read()).toEqual(f.before)
    expect(f.account.driveOwner()!.generation).toBe(generation)
    expectNoParticipantChanges(f)
  })

  it('a browser failure leaves everything retained', async () => {
    const f = fixture()
    browser(f)
    f.open.mockRejectedValueOnce(new Error('browser_failed'))
    await expect(f.account.repairOwnerDevice(owner)).rejects.toThrow('browser_failed')
    await vi.waitFor(() => expect(oidc.tokenRevocation).toHaveBeenCalled())
    expect(f.read()).toEqual(f.before)
    expectNoParticipantChanges(f)
  })

  it('a failed atomic account save retains the original record and discards only the new grant', async () => {
    const f = fixture()
    browser(f)
    const save = f.store.setItem.bind(f.store)
    vi.spyOn(f.store, 'setItem').mockImplementation((key, value) => {
      if (key === 'matrix-account') {
        throw new Error('auth_storage_disk_full')
      }
      save(key, value)
    })
    await expect(f.account.repairOwnerDevice(owner)).rejects.toThrow('auth_storage_disk_full')
    expect(f.read()).toEqual(f.before)
    expect(oidc.tokenRevocation).toHaveBeenCalledWith(
      { clientId: 'matrix' },
      'synthetic-human-new-refresh',
      expect.anything()
    )
    expectNoParticipantChanges(f)
  })

  it('does not use an agent, another human device, or registration as a repair target', async () => {
    const f = fixture()
    browser(f)
    for (const identity of [
      { userId: '@raymond:test', deviceId: 'AGENT_raymond' },
      { ...owner, deviceId: 'OTHER' }
    ]) {
      await expect(f.account.repairOwnerDevice(identity)).rejects.toThrow('matrix_recovery_stale')
    }
    await expect(f.account.repairOwnerDevice(owner, 'create')).rejects.toThrow('matrix_owner_repair_method_invalid')
    expect(authorizeNative).not.toHaveBeenCalled()
    expect(f.read()).toEqual(f.before)
  })

  it('merges current retained state rather than a snapshot from before the browser opened', async () => {
    const f = fixture()
    const { callback } = browser(f)
    f.open.mockImplementation(async () => {
      const current = f.read()
      current.agentHermes[raymond].home = '/fixture/new-raymond-home'
      f.store.setItem('matrix-account', JSON.stringify(current))
      callback.resolve()
    })
    await f.account.repairOwnerDevice(owner)
    expect(f.read().agentHermes[raymond].home).toBe('/fixture/new-raymond-home')
    expect(f.read().agentEnrollments).toEqual(f.before.agentEnrollments)
  })

  it('leaves unrelated queued domain revocations to the normal lifecycle', async () => {
    const f = fixture()
    browser(f)
    const queued = { ...f.before.domain, clientId: 'domain' }
    f.store.setItem('matrix-revocations', JSON.stringify([queued]))
    await f.account.repairOwnerDevice(owner)
    await vi.waitFor(() => expect(oidc.tokenRevocation).toHaveBeenCalled())
    await vi.waitFor(() => expect(JSON.parse(f.store.getItem('matrix-revocations')!)).toEqual([queued]))
    expectNoParticipantChanges(f)
  })

  it('retires a held human rotation only after the replacement has been durably saved', async () => {
    const f = fixture()
    browser(f)
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
      access_token: 'synthetic-human-held',
      refresh_token: 'synthetic-human-held-refresh'
    } as never)
    const save = f.store.setItem.bind(f.store)
    const failing = vi.spyOn(f.store, 'setItem').mockImplementation((key, value) => {
      if (key === 'matrix-account') {
        throw new Error('auth_storage_disk_full')
      }
      save(key, value)
    })
    expect((await f.account.refresh(f.account.sdkConfiguration().refreshToken)).ok).toBe(false)
    expect(f.read()).toEqual(f.before)
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
    failing.mockRestore()
    vi.mocked(oidc.refreshTokenGrant).mockClear()
    await f.account.repairOwnerDevice(owner)
    await vi.waitFor(() =>
      expect(oidc.tokenRevocation).toHaveBeenCalledWith(
        { clientId: 'matrix' },
        'synthetic-human-held-refresh',
        expect.anything()
      )
    )
    expect(f.read().accessToken).toBe('synthetic-human-new')
    expectNoParticipantChanges(f)
  })

  it('rejects a second repair while its browser is open', async () => {
    const f = fixture()
    const { callback } = browser(f)
    f.open.mockResolvedValue(undefined)
    const first = f.account.repairOwnerDevice(owner)
    await vi.waitFor(() => expect(f.open).toHaveBeenCalled())
    await expect(f.account.repairOwnerDevice(owner)).rejects.toThrow('matrix_operation_pending')
    await expect(f.account.signIn()).rejects.toThrow('matrix_operation_pending')
    callback.resolve()
    await first
    expect(authorizeNative).toHaveBeenCalledOnce()
    expectNoParticipantChanges(f)
  })

  it('refuses a commit racing an agent renewal; that renewal can still save without revocation', async () => {
    const f = fixture()
    const { callback } = browser(f)
    const renewalGate = gate()
    let renewal!: Promise<unknown>
    vi.mocked(requestEnrollment).mockImplementation(async () => {
      await renewalGate.promise

      return {
        ...f.before.agentEnrollments[raymond].credential,
        executorId: 'executor-raymond',
        accessToken: 'synthetic-raymond-renewed'
      }
    })
    f.open.mockImplementation(async () => {
      renewal = f.account.renewAgentExecutor(raymond)
      void renewal.catch(() => {})
      callback.resolve()
    })
    await expect(f.account.repairOwnerDevice(owner)).rejects.toThrow('matrix_owner_repair_busy')
    expect(f.read()).toEqual(f.before)
    renewalGate.resolve()
    await renewal
    expect(f.read().agentEnrollments[raymond].credential.accessToken).toBe('synthetic-raymond-renewed')
    expect(vi.mocked(requestEnrollment).mock.calls.every(call => call[3] === 'POST')).toBe(true)
    expect(f.read().deviceId).toBe(owner.deviceId)
    expect(f.clearHome).not.toHaveBeenCalled()
  })
})
