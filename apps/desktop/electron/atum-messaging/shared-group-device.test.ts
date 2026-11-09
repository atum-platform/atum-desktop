import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test, vi } from 'vitest'

import { SafeStorageAuthStorage, type SafeStorageLike } from './credential-vault'
import { SharedGroupDevice } from './shared-group-device'
import type { MessagingAccountSession } from './types'

const ACCOUNT_A = '00000000-0000-4000-8000-303617b97302'
const ACCOUNT_B = '00000000-0000-4000-8000-00f765af1c54'
const INSTALLATION = '00000000-0000-4000-8000-bd7662a5eeb4'
const ROTATION = '00000000-0000-4000-8000-b454f82c5857'
const ASSISTANT = '00000000-0000-4000-8000-f6222a1106ee'
const IDENTITY = '00000000-0000-4000-8000-f1d11edf5c5c'
const DIGEST = 'a'.repeat(64)
const CREDENTIAL = 'a'.repeat(43)
const NOW = new Date('2030-01-01T00:00:00.000Z')

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`sealed:${value}`),
  decryptString: value => {
    const decoded = value.toString('utf8')

    if (!decoded.startsWith('sealed:')) {
      throw new Error('not sealed')
    }

    return decoded.slice(7)
  }
}

function session(id: string, token = 'access-a'): MessagingAccountSession {
  return {
    baseUrl: 'https://platform.example',
    tokens: { accessToken: token, expiresAt: null, refreshToken: 'refresh' },
    user: { id, displayName: 'Owner', handle: null }
  }
}

function grant(credential = CREDENTIAL) {
  return {
    installation_id: '00000000-0000-4000-8000-fbfe405ca65f',
    device_credential: credential,
    credential_expires_at: '2031-01-01T00:00:00.000Z',
    heartbeat_interval_seconds: 30
  }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function storages() {
  const directory = mkdtempSync(join(tmpdir(), 'atum-shared-group-device-'))
  const byAccount = new Map<string, SafeStorageAuthStorage>()

  const storageForAccount = (accountId: string) => {
    let storage = byAccount.get(accountId)

    if (!storage) {
      storage = new SafeStorageAuthStorage(join(directory, `${accountId}.json`), safeStorage)
      byAccount.set(accountId, storage)
    }

    return storage
  }

  return { directory, byAccount, storageForAccount }
}

function device(
  current: () => MessagingAccountSession | null,
  storageForAccount: ReturnType<typeof storages>['storageForAccount'],
  fetchImpl: typeof fetch
) {
  return new SharedGroupDevice({
    tokens: { current, refresh: vi.fn(async rejected => rejected) },
    storageForAccount,
    installationNonce: INSTALLATION,
    clientVersion: '0.17.0',
    fetchImpl,
    now: () => NOW,
    randomUUID: () => ROTATION
  })
}

test('explicit enable persists device credentials only in encrypted account storage and binds a valid agent', async () => {
  const storage = storages()

  try {
    let current = session(ACCOUNT_A)

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('x-atum-group-conversations'), '1')
      assert.equal(headers.get('x-atum-group-shared-agents'), '1')
      assert.equal(headers.get('authorization'), 'Bearer access-a')
      const url = String(input)

      if (url.endsWith('/group-conversations/device')) {
        return response(grant())
      }

      assert.match(url, new RegExp(`/agents/${ASSISTANT}$`, 'u'))
      assert.equal(headers.get('x-atum-device-credential'), CREDENTIAL)

      return new Response(null, { status: 204 })
    })

    const client = device(() => current, storage.storageForAccount, fetchImpl as typeof fetch)

    assert.deepEqual(await client.enable(), {
      enabled: true,
      installationId: grant().installation_id,
      credentialExpiresAt: grant().credential_expires_at,
      heartbeatIntervalSeconds: 30
    })
    await client.enable()
    assert.equal(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/group-conversations/device')).length, 1)
    await client.bindAgent({
      assistantId: ASSISTANT,
      profileIdentity: IDENTITY,
      modelAlias: 'binh-minh',
      personaDigest: DIGEST,
      personaRevision: 1
    })
    assert.equal(client.credentialForAccount(ACCOUNT_A), CREDENTIAL)
    assert.equal(client.credentialForAccount(ACCOUNT_B), null)
    const encrypted = readFileSync(join(storage.directory, `${ACCOUNT_A}.json`), 'utf8')
    assert.doesNotMatch(encrypted, new RegExp(`${CREDENTIAL}|2031-01-01`, 'u'))
    current = session(ACCOUNT_B, 'access-b')
    assert.equal(client.credentialForAccount(ACCOUNT_A), null)
  } finally {
    rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('withdrawal after rejected registration needs no credential or further registration', async () => {
  const storage = storages()

  try {
    const fetchImpl = vi.fn(async () => response({ error: 'feature_unavailable' }, 503))
    const client = device(() => session(ACCOUNT_A), storage.storageForAccount, fetchImpl as typeof fetch)
    await assert.rejects(client.enable(), /request_rejected/u)
    await client.unbindAgent(ASSISTANT)
    assert.equal(fetchImpl.mock.calls.length, 1)
    assert.equal(client.credentialForAccount(ACCOUNT_A), null)
  } finally {
    rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('withdrawal after credential expiry does not require re-enabling the device', async () => {
  const storage = storages()
  let now = NOW

  try {
    const fetchImpl = vi.fn(async () => response(grant()))

    const client = new SharedGroupDevice({
      tokens: { current: () => session(ACCOUNT_A), refresh: async () => null },
      storageForAccount: storage.storageForAccount,
      installationNonce: INSTALLATION, clientVersion: '0.17.0', fetchImpl,
      now: () => now, randomUUID: () => ROTATION
    })

    await client.enable()
    now = new Date('2032-01-01T00:00:00.000Z')
    await client.unbindAgent(ASSISTANT)
    assert.equal(fetchImpl.mock.calls.length, 1)
    assert.equal(client.credentialForAccount(ACCOUNT_A), null)
  } finally {
    rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('an account switch while registering aborts before refresh or persistence for another account', async () => {
  const storage = storages()

  try {
    let current = session(ACCOUNT_A)
    const refresh = vi.fn(async rejected => rejected)

    const fetchImpl = vi.fn(async () => {
      current = session(ACCOUNT_B, 'access-b')

      return response({}, 401)
    })

    const client = new SharedGroupDevice({
      tokens: { current: () => current, refresh },
      storageForAccount: storage.storageForAccount,
      installationNonce: INSTALLATION,
      clientVersion: '0.17.0',
      fetchImpl: fetchImpl as typeof fetch,
      now: () => NOW,
      randomUUID: () => ROTATION
    })

    await assert.rejects(client.enable(), /shared_group_device_account_changed/u)
    assert.equal(refresh.mock.calls.length, 0)
    assert.equal(storage.byAccount.get(ACCOUNT_A)?.getItem('atum-shared-group-device-v1'), null)
    assert.equal(storage.byAccount.has(ACCOUNT_B), false)
  } finally {
    rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('rotation records its idempotency key before the request and reuses it after restart', async () => {
  const storage = storages()

  try {
    const current = session(ACCOUNT_A)
    const rotationBodies: string[] = []

    const firstFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)

      if (url.endsWith('/group-conversations/device')) {
        return response(grant('b'.repeat(43)))
      }

      if (url.endsWith('/heartbeat')) {
        return response({
          accepted_at: '2030-01-01T00:00:00.000Z',
          next_heartbeat_seconds: 30,
          credential_state: 'rotate'
        })
      }

      rotationBodies.push(String(init?.body))

      return response({}, 500)
    })

    const first = device(() => current, storage.storageForAccount, firstFetch as typeof fetch)
    await first.enable()
    await assert.rejects(first.heartbeat(), /shared_group_device_request_rejected/u)

    const secondFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)

      if (url.endsWith('/heartbeat')) {
        return response({
          accepted_at: '2030-01-01T00:01:00.000Z',
          next_heartbeat_seconds: 30,
          credential_state: 'rotate'
        })
      }

      rotationBodies.push(String(init?.body))

      return response(grant('c'.repeat(43)))
    })

    const restarted = device(() => current, storage.storageForAccount, secondFetch as typeof fetch)
    await restarted.heartbeat()

    assert.equal(rotationBodies.length, 2)
    assert.deepEqual(
      rotationBodies.map(body => JSON.parse(body)),
      [{ idempotency_key: ROTATION }, { idempotency_key: ROTATION }]
    )
    assert.equal(restarted.credentialForAccount(ACCOUNT_A), 'c'.repeat(43))
  } finally {
    rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('malformed grants and unsafe proxy paths fail closed', async () => {
  const storage = storages()

  try {
    const current = session(ACCOUNT_A)

    const malformed = device(
      () => current,
      storage.storageForAccount,
      vi.fn(async () => response({ device_credential: 'secret' })) as typeof fetch
    )

    await assert.rejects(malformed.enable(), /shared_group_device_invalid_response/u)

    const malformedCredential = device(
      () => current,
      storage.storageForAccount,
      vi.fn(async () => response({ ...grant(), device_credential: 'short' })) as typeof fetch
    )

    await assert.rejects(malformedCredential.enable(), /shared_group_device_invalid_response/u)

    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/group-conversations/device')) {return response(grant())}
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('x-atum-device-credential'), CREDENTIAL)
      assert.equal(headers.get('authorization'), 'Bearer access-a')

      return response({ ok: true })
    })

    const valid = device(() => current, storage.storageForAccount, request as typeof fetch)
    await valid.enable()
    await valid.authenticatedRequest('/api/desktop/v1/group-conversations/rooms?limit=10')
    await assert.rejects(
      valid.authenticatedRequest('https://attacker.example/api/desktop/v1/group-conversations/x'),
      /shared_group_device_invalid_request_path/u
    )
    await assert.rejects(
      valid.bindAgent({
        assistantId: ASSISTANT,
        profileIdentity: IDENTITY,
        modelAlias: 'unmanaged',
        personaDigest: DIGEST,
        personaRevision: 1
      }),
      /shared_group_device_invalid_agent_binding/u
    )
  } finally {
    rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('only HTTPS or loopback HTTP base URLs can enable a device', async () => {
  const storage = storages()

  try {
    const unsafe = { ...session(ACCOUNT_A), baseUrl: 'ftp://localhost' }
    const fetchImpl = vi.fn(async () => response(grant()))
    const client = device(() => unsafe, storage.storageForAccount, fetchImpl as typeof fetch)

    await assert.rejects(client.enable(), /shared_group_device_not_authenticated/u)
    assert.equal(fetchImpl.mock.calls.length, 0)
  } finally {
    rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('heartbeats retain one boot identity while logical rotations receive distinct retry keys', async () => {
  const storage = storages()
  const ids = [INSTALLATION, ROTATION, IDENTITY]
  const beats: string[] = []
  const rotations: string[] = []

  try {
    const client = new SharedGroupDevice({
      tokens: { current: () => session(ACCOUNT_A), refresh: async () => null },
      storageForAccount: storage.storageForAccount, installationNonce: INSTALLATION,
      clientVersion: '1.0.0', now: () => NOW, randomUUID: () => ids.shift()!,
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname
        const body = JSON.parse(String(init?.body))

        if (path.endsWith('/device')) {return response(grant())}

        if (path.endsWith('/heartbeat')) {
          beats.push(body.boot_id)

          return response({ accepted_at: NOW.toISOString(), next_heartbeat_seconds: 30, credential_state: 'rotate' })
        }

        assert.ok(path.endsWith('/rotate'))
        rotations.push(body.idempotency_key)

        return response(grant())
      }
    })

    await client.enable()
    await client.heartbeat()
    await client.heartbeat()
    assert.deepEqual(beats, [INSTALLATION, INSTALLATION])
    assert.deepEqual(rotations, [ROTATION, IDENTITY])
  } finally {rmSync(storage.directory, { recursive: true, force: true })}
})

test('authenticated job requests decode bounded JSON and never accept an HTTP failure as success', async () => {
  const storage = storages()
  let status = 200
  let responseBody: unknown = { ok: true }

  try {
    const client = device(() => session(ACCOUNT_A), storage.storageForAccount, async (input, init) => {
      if (String(input).endsWith('/device')) {return response(grant())}
      assert.equal(new Headers(init?.headers).get('content-type'), 'application/json')

      return response(responseBody, status)
    })

    await client.enable()
    const path = `/api/desktop/v1/group-conversations/${INSTALLATION}/jobs/${ASSISTANT}/preflight`
    assert.deepEqual(await client.authenticatedRequest(path, { method: 'POST', body: '{}' }), { ok: true })
    status = 500
    await assert.rejects(client.authenticatedRequest(path, { method: 'POST', body: '{}' }), /request_rejected/)
    status = 404
    await assert.rejects(client.authenticatedRequest(path, { method: 'POST', body: '{}' }), /request_rejected/)
    responseBody = { error: { code: 'not_found' } }
    await assert.rejects(client.authenticatedRequest(path, { method: 'POST', body: '{}' }), /request_rejected/)
    responseBody = { error: { code: 'not_found', details: { reason: 'shared_job_gone' } } }
    await assert.rejects(client.authenticatedRequest(path, { method: 'POST', body: '{}' }), /job_gone/)
  } finally {rmSync(storage.directory, { recursive: true, force: true })}
})
