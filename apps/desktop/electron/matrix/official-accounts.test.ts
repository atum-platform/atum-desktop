import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as oidc from 'openid-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_OFFICIAL_ACCOUNTS_PROFILE, type MatrixOfficialAccounts } from '../../shared/matrix-founder'
import { EncryptedStore } from '../encrypted-store'

import { MatrixAccount } from './account'
import { matrixConfigurationKey } from './config'
import {
  MatrixOfficialAccountsController,
  MatrixOfficialAccountsError,
  OFFICIAL_ACCOUNTS_REFRESH_MS,
  requestMatrixOfficialAccounts
} from './official-accounts'

vi.mock('openid-client', () => ({
  discovery: vi.fn(async () => ({})),
  None: () => ({}),
  allowInsecureRequests: () => {},
  refreshTokenGrant: vi.fn(),
  tokenRevocation: vi.fn(async () => {}),
  ResponseBodyError: class extends Error {}
}))

const FOUNDER = '@synthetic-user-0017:atumplatform.com'

const body = {
  profile: MATRIX_OFFICIAL_ACCOUNTS_PROFILE,
  founder: { user_id: FOUNDER },
  accounts: [{ user_id: FOUNDER, tier: 'official', role: 'founder', handle: 'founder' }]
}

const parsed: MatrixOfficialAccounts = {
  founder: { userId: FOUNDER },
  accounts: [{ userId: FOUNDER, tier: 'official', role: 'founder', handle: 'founder' }]
}

const directories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
  vi.clearAllMocks()
})

async function serve(handler: RequestListener) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }

  return `http://127.0.0.1:${port}/api/matrix/v1`
}

async function accountFixture(handler: RequestListener) {
  const resource = await serve(handler)
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-official-accounts-'))
  directories.push(directory)

  const config = {
    issuer: 'https://id.test',
    server: 'https://matrix.test',
    nativeClientId: 'matrix-native',
    callbackPort: 21881,
    domain: { nativeClientId: 'domain-native', resource }
  }

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
      subject: 'person',
      userId: '@alice:test',
      deviceId: 'DEVICE',
      storageKey: Buffer.alloc(32, 1).toString('base64'),
      accessToken: 'synthetic-matrix',
      refreshToken: 'synthetic-matrix-refresh',
      domain: {
        issuer: config.issuer,
        subject: 'person',
        sessionId: 'domain-session',
        accessToken: 'synthetic-domain',
        refreshToken: 'synthetic-domain-refresh'
      }
    })
  )

  return new MatrixAccount(config, store, vi.fn())
}

const json =
  (status: number, value: unknown, headers: Record<string, string> = {}): RequestListener =>
  (_request, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    response.end(JSON.stringify(value))
  }

describe('the official accounts read', () => {
  it('is one fixed native GET with the domain token, refreshed once on a refused token', async () => {
    const seen: Array<
      Pick<IncomingMessage, 'method' | 'url'> & { authorization?: string; cookie?: string; length: number }
    > = []

    const account = await accountFixture((request, response) => {
      let length = 0
      request.on('data', chunk => (length += chunk.length))
      request.on('end', () => {
        seen.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          length
        })
        json(seen.length === 1 ? 401 : 200, seen.length === 1 ? {} : body)(request, response)
      })
    })

    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({
      access_token: 'synthetic-renewed',
      refresh_token: 'synthetic-rotated'
    } as never)

    await expect(account.officialAccounts(AbortSignal.timeout(5000))).resolves.toEqual(parsed)
    expect(seen).toEqual([
      { method: 'GET', url: '/api/matrix/v1/official-accounts', authorization: 'Bearer synthetic-domain', length: 0 },
      { method: 'GET', url: '/api/matrix/v1/official-accounts', authorization: 'Bearer synthetic-renewed', length: 0 }
    ])
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
  })

  it('says why it failed, and never reads an unreadable answer as an empty list', async () => {
    const signal = () => AbortSignal.timeout(5000)
    const grant = { accessToken: 'synthetic-domain' }

    await expect(
      requestMatrixOfficialAccounts(await serve(json(429, {}, { 'Retry-After': '120' })), grant, signal())
    ).rejects.toMatchObject({ code: 'limit', retryAfterSeconds: 120 })
    await expect(requestMatrixOfficialAccounts(await serve(json(401, {})), grant, signal())).rejects.toMatchObject({
      code: 'authentication'
    })

    for (const [status, value] of [
      [503, { error: 'gate' }],
      [403, {}],
      [200, { ...body, profile: 'atum.official-accounts/2' }],
      [200, { ...body, accounts: [] }],
      // A malformed roster state/order is unavailable, never a partial marks list.
      [200, { ...body, accounts: [{ ...body.accounts[0], roster_state: 'hidden' }] }],
      [200, { ...body, accounts: [{ ...body.accounts[0], roster_order: -1 }] }]
    ] as const) {
      await expect(
        requestMatrixOfficialAccounts(await serve(json(status, value)), grant, signal())
      ).rejects.toMatchObject({
        code: 'unavailable'
      })
    }

    const text = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<html>')
    })

    await expect(requestMatrixOfficialAccounts(text, grant, signal())).rejects.toBeInstanceOf(
      MatrixOfficialAccountsError
    )
  })
})

describe('the official accounts, kept for the signed-in account', () => {
  const scope = { accountKey: 'account-a', generation: 1 }

  function controller(read: (signal: AbortSignal) => Promise<MatrixOfficialAccounts>) {
    const changed = vi.fn()
    const settled = vi.fn()

    return {
      changed,
      settled,
      accounts: new MatrixOfficialAccountsController({ read, changed, settled, random: () => 0.5 })
    }
  }

  it('reads when sign-in is ready and keeps the answer for that account only', async () => {
    const read = vi.fn(async () => parsed)
    const { accounts, changed, settled } = controller(read)

    expect(accounts.snapshot()).toBeUndefined()
    accounts.activate(scope)
    await vi.waitFor(() => expect(accounts.snapshot()).toEqual(parsed))
    expect(changed).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledTimes(1)
    // The same account again is not a new read.
    accounts.activate({ ...scope })
    expect(read).toHaveBeenCalledTimes(1)

    // Signing out drops it; another account starts from nothing.
    accounts.activate(null)
    expect(accounts.snapshot()).toBeUndefined()
    read.mockImplementationOnce(() => new Promise(() => {}))
    accounts.activate({ accountKey: 'account-b', generation: 2 })
    expect(accounts.snapshot()).toBeUndefined()
    accounts.stop()
  })

  it('keeps the last good answer through a failure, and has none when it never read one', async () => {
    const read = vi.fn<(signal: AbortSignal) => Promise<MatrixOfficialAccounts>>()
    read.mockRejectedValueOnce(new MatrixOfficialAccountsError('unavailable'))
    const { accounts, settled } = controller(read)

    accounts.activate(scope)
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1))
    expect(accounts.snapshot()).toBeUndefined()

    read.mockResolvedValueOnce(parsed)
    await accounts.refresh()
    expect(accounts.snapshot()).toEqual(parsed)

    read.mockRejectedValueOnce(new MatrixOfficialAccountsError('unavailable'))
    await accounts.refresh()
    expect(accounts.snapshot()).toEqual(parsed)
    accounts.stop()
  })

  it('reads again every six hours with jitter, on wake, and never while the platform asked to wait', async () => {
    vi.useFakeTimers()
    const read = vi.fn<(signal: AbortSignal) => Promise<MatrixOfficialAccounts>>(async () => parsed)
    const { accounts } = controller(read)

    accounts.activate(scope)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(OFFICIAL_ACCOUNTS_REFRESH_MS - 60_000)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(read).toHaveBeenCalledTimes(2)

    accounts.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(3)

    // 429: Retry-After holds every read, wake included, until it passes.
    read.mockRejectedValueOnce(new MatrixOfficialAccountsError('limit', 600))
    accounts.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(4)
    accounts.resume()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(read).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(400_000)
    expect(read).toHaveBeenCalledTimes(5)
    expect(accounts.snapshot()).toEqual(parsed)
    accounts.stop()
  })

  it('shares one read between callers and drops an answer that arrives for an earlier account', async () => {
    let answer!: (value: MatrixOfficialAccounts) => void
    const read = vi.fn(() => new Promise<MatrixOfficialAccounts>(resolve => (answer = resolve)))
    const { accounts, changed } = controller(read)

    accounts.activate(scope)
    const first = accounts.refresh()
    const second = accounts.refresh()
    expect(first).toBe(second)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))

    accounts.activate(null)
    answer(parsed)
    await first
    expect(accounts.snapshot()).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
  })
})
