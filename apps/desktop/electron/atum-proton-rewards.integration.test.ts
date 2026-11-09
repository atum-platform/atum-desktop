import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { AccountRootAuthority } from './atum-messaging/account-roots'
import { SafeStorageAuthStorage } from './atum-messaging/credential-vault'
import { AtumMessagingHttpClient } from './atum-messaging/http-client'
import { AtumProtonsService } from './atum-protons'
import { registerAtumProtonsIpc } from './atum-protons-ipc'
import { AtumUtilities } from './atum-utilities'

test('real encrypted connector store -> main proof callback -> hosted transport -> sanitized IPC result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atum-proton-connector-'))
  const userId = '00000000-0000-4000-8000-303617b97302'
  const roots = new AccountRootAuthority(root)
  roots.commit(userId, 1)
  const account = { accountId: userId, generation: 1, root: roots.pathsForAccount(userId).root }

  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text).reverse(),
    decryptString: (value: Buffer) => Buffer.from(value).reverse().toString() }

  const vault = new SafeStorageAuthStorage(join(account.root, 'utilities.credentials.json'), safeStorage)
  const googleKey = 'g:fixture'
  vault.setItem('connections', JSON.stringify({ version: 2, appleConnected: false,
    accounts: [{ accountKey: googleKey, credential: { clientId: 'fixture.apps.googleusercontent.com',
      clientSecret: 'fixture-client-secret', refreshToken: 'fixture-refresh-token', label: 'fixture@example.test' } }],
    sources: ['email', 'calendar'].map(kind => ({ id: `s:${kind}`, kind, provider: 'google', accountKey: googleKey,
      label: kind, state: 'connected', enabled: true, ...(kind === 'calendar' ? { providerRef: 'primary', primary: true } : {}) })) }))
  const cloudBodies: unknown[] = []

  const utilities = new AtumUtilities({ account: () => account, safeStorage, google: null,
    apple: { available: { calendar: false }, calendar: async () => { throw new Error('unused') } },
    openExternal: async () => { throw new Error('second OAuth setup must not be opened') },
    fetchImpl: async (url, init) => {
      assert.equal(String(url), 'https://oauth2.googleapis.com/token')
      const params = new URLSearchParams(String(init?.body))
      assert.equal(params.get('refresh_token'), 'fixture-refresh-token')

      return Response.json({ access_token: 'ephemeral-google-proof-token' })
    }
  })

  const client = new AtumMessagingHttpClient({ current: () => ({ baseUrl: 'https://atum.test',
    user: { id: userId, displayName: null, handle: null }, tokens: { accessToken: 'atum-bearer-token', refreshToken: null, expiresAt: null } }),
    refresh: async () => null }, async (url, init) => {
      assert.equal(new URL(String(url)).pathname, '/api/desktop/v1/protons/rewards/connection')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer atum-bearer-token')
      cloudBodies.push(JSON.parse(String(init?.body)))

      return Response.json({ state: 'earned', amount_protons: 3000 })
    })

  const protons = new AtumProtonsService({ accountRoots: roots, session: () => ({ user: { id: userId } }), client,
    withGoogleConnectionProof: (kind, consume) => utilities.withGoogleConnectionProof(kind, consume) })

  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  registerAtumProtonsIpc({ handle: (name, handler) => { handlers.set(name, handler) } }, protons,
    { assertTrustedSender: event => assert.equal(event, 'trusted') })

  try {
    for (const kind of ['email', 'calendar']) {
      const result = await handlers.get('atum:protons:rewards:claim')!('trusted', kind)
      assert.deepEqual(result, { state: 'earned', amount_protons: 3000 })
      assert.equal(JSON.stringify(result).includes('token'), false)
    }

    assert.deepEqual(cloudBodies, ['email', 'calendar'].map(service => ({ service, access_token: 'ephemeral-google-proof-token' })))
    await utilities.setEnabled([{ id: 's:email', enabled: false }])
    await assert.rejects(protons.claimConnectionReward('email'), /unavailable/)
    assert.equal(cloudBodies.length, 2)
  } finally { utilities.cancel(); rmSync(root, { recursive: true, force: true }) }
})
