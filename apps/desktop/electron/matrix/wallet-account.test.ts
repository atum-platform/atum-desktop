import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type RequestListener, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as oidc from 'openid-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EncryptedStore } from '../encrypted-store'

import { MatrixAccount } from './account'
import { matrixConfigurationKey } from './config'

vi.mock('openid-client', () => ({
  discovery: vi.fn(async () => ({})), None: () => ({}), allowInsecureRequests: () => {},
  refreshTokenGrant: vi.fn(), tokenRevocation: vi.fn(async () => {}),
  ResponseBodyError: class extends Error {}
}))
const directories: string[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve())
  })))
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
  vi.clearAllMocks()
})

const wallet = { unit: 'micro_proton', balances: { available: 1, paid: 1, earned: 0, promo: 0, held: 0 }, allowance: null, checkoutOpen: false }

async function fixture(handler: RequestListener) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-wallet-account-'))
  directories.push(directory)

  const config = { issuer: 'https://id.test', server: 'https://matrix.test', nativeClientId: 'matrix-native', callbackPort: 21881,
    domain: { nativeClientId: 'domain-native', resource: `http://127.0.0.1:${port}/api/matrix/v1` } }

  const store = new EncryptedStore(path.join(directory, 'vault.json'), {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString()
  })

  const record = { version: 1, configurationKey: matrixConfigurationKey(config), issuer: config.issuer, subject: 'person',
    userId: '@alice:test', deviceId: 'DEVICE', storageKey: Buffer.alloc(32, 1).toString('base64'),
    accessToken: 'synthetic-matrix', refreshToken: 'synthetic-matrix-refresh',
    domain: { issuer: config.issuer, subject: 'person', sessionId: 'domain-session', accessToken: 'synthetic-domain', refreshToken: 'synthetic-domain-refresh' } }

  store.setItem('matrix-account', JSON.stringify(record))
  const browser = vi.fn()

  return { account: new MatrixAccount(config, store, browser), store, record, browser }
}

describe('wallet reads through the real account vault and HTTP boundary', () => {
  it('uses only the human domain grant, and refreshes a 401 once without opening a browser', async () => {
    const authorizations: unknown[] = []

    const { account, browser } = await fixture((request, response) => {
      authorizations.push(request.headers.authorization)
      response.writeHead(authorizations.length === 1 ? 401 : 200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(wallet))
    })

    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce({ access_token: 'synthetic-renewed', refresh_token: 'synthetic-rotated' } as never)
    expect(await account.wallet(AbortSignal.timeout(5000))).toEqual(wallet)
    expect(authorizations).toEqual(['Bearer synthetic-domain', 'Bearer synthetic-renewed'])
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1)
    expect(browser).not.toHaveBeenCalled()
  })
  it('refuses a delayed result after cancellation, even while its old grant still works', async () => {
    let finish!: () => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })

    const { account } = await fixture((_request, response) => {
      finish = () => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(wallet)) }
      started()
    })

    const read = account.wallet(AbortSignal.timeout(5000))
    const refused = expect(read).rejects.toThrow('matrix_wallet_cancelled')
    await waiting
    account.cancel()
    finish()
    await refused
  })
  it('rejects an old history page after vault account replacement and never returns a partial page', async () => {
    let finish!: () => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })

    const { account, store, record } = await fixture((_request, response) => {
      finish = () => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"entries":[],"next":null}') }
      started()
    })

    const read = account.walletHistory(AbortSignal.timeout(5000))
    const refused = expect(read).rejects.toThrow('matrix_wallet_cancelled')
    await waiting
    store.setItem('matrix-account', JSON.stringify({ ...record, subject: 'other',
      domain: { ...record.domain, subject: 'other', sessionId: 'other-domain-session' } }))
    finish()
    await refused
  })
})
