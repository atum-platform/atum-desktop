import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test, vi } from 'vitest'

import {
  ACTIVE_AUTH_STORAGE_KEY,
  ATUM_AUTH_STABLE_FAILURE_CODES,
  AtumAccountAuthController,
  type AtumAuthTerminalEvent,
  resolveAtumAccountConfig,
  stableAtumAuthFailureCode,
  SupabaseAtumAccountClient
} from './account-auth'
import { AccountRootAuthority, type AccountScopedPaths } from './account-roots'
import { AtumAuthCallbackBroker } from './auth-deep-link'
import { SafeStorageAuthStorage, type SafeStorageLike } from './credential-vault'
import { AtumMessagingRuntime } from './runtime'

const USER_A = '00000000-0000-4000-8000-303617b97302'
const USER_B = '00000000-0000-4000-8000-00f765af1c54'
const CONVERSATION_ID = '00000000-0000-4000-8000-f6222a1106ee'
const MESSAGE_ID = '00000000-0000-4000-8000-b454f82c5857'

type AuthorizeMode = 'success' | 'state_mismatch' | 'callback_error' | 'never'

interface FakeAuthState {
  authorizeMode: AuthorizeMode
  userId: string
  hostedUserId?: string
  passwordAccepted: boolean
  pkceNeverRespond?: boolean
  hostedSessionNeverRespond?: boolean
  hostedSessionHtmlError?: boolean
  hostedSessionStatus?: number
  refreshNeverRespond?: boolean
  /** Fired the moment a refresh reaches the stub, so a test can wait on the
   *  request ARRIVING instead of racing a wall-clock deadline against it. */
  onRefreshReceived?: () => void
  refreshDelayMs?: number
  /** Each hosted messaging request stays individually bounded, but their
   * cumulative first sync may outlast the controller's switch barrier. */
  messagingResponseDelayMs?: number
  passwordNeverRespond?: boolean
  passwordOversized?: boolean
  malformedToken: boolean
  currentRefreshToken: string | null
  refreshCount: number
  tokenCount: number
  validTokens: Set<string>
  requests: Array<{ method: string; path: string; body: string; authorization: string | undefined }>
}

const servers: http.Server[] = []
const directories: string[] = []
const runtimes: AtumMessagingRuntime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    runtime.stop()
  }

  for (const server of servers) {
    server.closeAllConnections()
  }

  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`sealed:${value}`, 'utf8'),
  decryptString: value => {
    const decoded = value.toString('utf8')
    assert.ok(decoded.startsWith('sealed:'))

    return decoded.slice('sealed:'.length)
  }
}

function userData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'atum-account-auth-'))
  directories.push(directory)

  return directory
}

async function body(request: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let value = ''
    request.setEncoding('utf8')
    request.on('data', chunk => (value += chunk))
    request.on('end', () => resolve(value))
  })
}

function base64Url(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeAccessToken(userId: string, nonce: string): string {
  const header = base64Url(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })))

  const payload = base64Url(
    Buffer.from(JSON.stringify({ sub: userId, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3_600 }))
  )

  return `${header}.${payload}.${base64Url(Buffer.from(nonce))}`
}

async function fakeServer(state: FakeAuthState): Promise<string> {
  const pending = new Map<string, string>()

  const server = http.createServer(async (request, response) => {
    const requestBody = await body(request)
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    state.requests.push({
      method: request.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      body: requestBody,
      authorization: request.headers.authorization
    })

    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(value))
    }

    if (url.pathname === '/auth/v1/authorize') {
      const redirect = new URL(url.searchParams.get('redirect_to')!)

      if (state.authorizeMode === 'never') {
        response.writeHead(200)
        response.end('pending')

        return
      }

      if (state.authorizeMode === 'state_mismatch') {
        redirect.pathname = `${redirect.pathname}-forged`
      }

      if (state.authorizeMode === 'callback_error') {
        redirect.searchParams.set('error', 'access_denied')
      } else {
        const code = `code-${state.tokenCount + 1}`
        pending.set(code, url.searchParams.get('code_challenge') ?? '')
        redirect.searchParams.set('code', code)
      }

      response.writeHead(302, { location: redirect.toString() })
      response.end()

      return
    }

    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
      if (state.pkceNeverRespond) {
        return
      }

      if (state.malformedToken) {
        json(200, { access_token: 'missing-everything-else' })

        return
      }

      const input = JSON.parse(requestBody)
      const expected = pending.get(input.auth_code)
      const actual = base64Url(createHash('sha256').update(input.code_verifier, 'ascii').digest())

      if (!expected || expected !== actual) {
        json(400, { error: 'invalid_grant' })

        return
      }

      state.tokenCount += 1
      const accessToken = makeAccessToken(state.userId, `oauth-${state.tokenCount}`)
      state.currentRefreshToken = `refresh-${state.userId}`
      state.validTokens.add(accessToken)
      json(200, {
        access_token: accessToken,
        refresh_token: state.currentRefreshToken,
        expires_in: 3600,
        user: { id: state.userId, user_metadata: { full_name: state.userId === USER_A ? 'Minh' : 'Lan' } }
      })

      return
    }

    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      if (!state.passwordAccepted) {
        json(400, { code: 'invalid_credentials', msg: 'Invalid login credentials' })

        return
      }

      state.tokenCount += 1
      const token = makeAccessToken(state.userId, `password-${state.tokenCount}`)
      state.currentRefreshToken = `refresh-${state.userId}`
      state.validTokens.add(token)
      json(200, {
        access_token: token,
        refresh_token: state.currentRefreshToken,
        expires_in: 3600,
        token_type: 'bearer',
        user: { id: state.userId, user_metadata: { full_name: state.userId === USER_A ? 'Minh' : 'Lan' } }
      })

      return
    }

    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      state.refreshCount += 1
      state.onRefreshReceived?.()
      const input = JSON.parse(requestBody)

      if (state.refreshNeverRespond) {
        return
      }

      if (state.refreshDelayMs) {
        await new Promise(resolve => setTimeout(resolve, state.refreshDelayMs))
      }

      if (input.refresh_token !== state.currentRefreshToken) {
        json(401, { error: 'invalid_refresh_token' })

        return
      }

      const accessToken = makeAccessToken(state.userId, `refresh-${state.refreshCount}`)
      state.currentRefreshToken = `refresh-${state.userId}-${state.refreshCount}`
      state.validTokens.add(accessToken)
      json(200, {
        access_token: accessToken,
        refresh_token: state.currentRefreshToken,
        expires_in: 3600,
        user: { id: state.userId, user_metadata: { full_name: 'Minh' } }
      })

      return
    }

    if (url.pathname === '/api/desktop/v1/auth/password') {
      const input = JSON.parse(requestBody)

      if (state.passwordNeverRespond) {
        return
      }

      if (state.passwordOversized) {
        json(200, { session: { padding: 'x'.repeat(70_000) } })

        return
      }

      if (!state.passwordAccepted) {
        json(400, {
          error: 'invalid_credentials',
          echoed_identifier: input.identifier,
          echoed_password: input.password
        })

        return
      }

      state.tokenCount += 1
      const accessToken = makeAccessToken(state.userId, `hosted-password-${state.tokenCount}`)
      state.currentRefreshToken = `refresh-${state.userId}`
      state.validTokens.add(accessToken)
      json(200, {
        session: {
          access_token: accessToken,
          refresh_token: state.currentRefreshToken,
          expires_in: 3600,
          user: {
            id: state.userId,
            display_name: state.userId === USER_A ? 'Minh' : 'Lan',
            handle: state.userId === USER_A ? 'minh' : 'lan'
          }
        }
      })

      return
    }

    if (url.pathname === '/auth/v1/user') {
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? ''

      if (!state.validTokens.has(token)) {
        json(401, { code: 'bad_jwt', msg: 'invalid JWT' })

        return
      }

      json(200, {
        id: state.userId,
        aud: 'authenticated',
        role: 'authenticated',
        user_metadata: { full_name: state.userId === USER_A ? 'Minh' : 'Lan' }
      })

      return
    }

    if (url.pathname === '/auth/v1/logout') {
      response.writeHead(204)
      response.end()

      return
    }

    if (url.pathname.startsWith('/api/desktop/v1/')) {
      if (state.messagingResponseDelayMs) {
        await new Promise(resolve => setTimeout(resolve, state.messagingResponseDelayMs))
      }

      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? ''

      if (!state.validTokens.has(token)) {
        json(401, {
          error: {
            code: 'token_expired',
            message_key: 'messaging.error.token_expired',
            retryable: true,
            request_id: 'req-auth'
          }
        })

        return
      }

      if (url.pathname.endsWith('/session')) {
        if (state.hostedSessionNeverRespond) {
          return
        }

        if (state.hostedSessionStatus) {
          if (state.hostedSessionHtmlError) {
            response.writeHead(state.hostedSessionStatus, { 'content-type': 'text/html' })
            response.end('<html>upstream unavailable</html>')

            return
          }

          json(state.hostedSessionStatus, { error: 'hosted_session_failure' })

          return
        }

        const hostedUserId = state.hostedUserId ?? state.userId
        json(200, {
          user: { id: hostedUserId, display_name: hostedUserId === USER_A ? 'Minh' : 'Lan', handle: null },
          realtime: {
            transport: 'supabase_private_broadcast',
            topic: `user:${hostedUserId}:messaging:v1`,
            event: 'sync_available'
          },
          server_time: '2026-08-12T09:00:00.000Z',
          sync_cursor: null
        })

        return
      }

      if (url.pathname.endsWith('/read')) {
        json(200, { read_state: {}, replayed: false })

        return
      }

      if (url.pathname.endsWith('/sync')) {
        json(200, {
          changes: [],
          next_cursor: `cursor-${state.userId}`,
          has_more: false,
          server_time: '2026-08-12T09:00:00.000Z'
        })

        return
      }

      if (url.pathname.endsWith('/conversations')) {
        json(200, {
          conversations: [
            {
              id: CONVERSATION_ID,
              specialist: null,
              participants: [
                { type: 'user', id: state.userId, display_name: 'Minh' },
                { type: 'user', id: state.userId === USER_A ? USER_B : USER_A, display_name: 'Bạn' }
              ],
              read_state: { last_read_message_id: null, read_at: null },
              state: { pinned: false, muted: false, archived: false },
              created_at: '2026-08-12T02:00:00.000Z',
              updated_at: '2026-08-12T03:00:00.000Z'
            }
          ],
          next_cursor: null,
          has_more: false
        })

        return
      }

      if (url.pathname.endsWith(`/conversations/${CONVERSATION_ID}/messages`)) {
        json(200, {
          messages: [
            {
              id: MESSAGE_ID,
              conversation_id: CONVERSATION_ID,
              sender: { type: 'user', id: state.userId === USER_A ? USER_B : USER_A },
              content: 'Xin chào',
              kind: 'text',
              attachments: [],
              reply_to_message_id: null,
              forwarded_from: null,
              reactions: [],
              version: 1,
              created_at: '2026-08-12T03:00:00.000Z',
              edited_at: null,
              recalled_at: null,
              delivery: 'sent'
            }
          ],
          next_cursor: null,
          has_more: false
        })

        return
      }
    }

    json(404, { error: 'not_found' })
  })

  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return `http://127.0.0.1:${address.port}`
}

function initialState(overrides: Partial<FakeAuthState> = {}): FakeAuthState {
  return {
    authorizeMode: 'success',
    userId: USER_A,
    passwordAccepted: true,
    malformedToken: false,
    currentRefreshToken: null,
    refreshCount: 0,
    tokenCount: 0,
    validTokens: new Set(),
    requests: [],
    ...overrides
  }
}

async function harness(
  state: FakeAuthState,
  options: {
    timeoutMs?: number
    requestTimeoutMs?: number
    hostedAcquireTimeoutMs?: number
    hostedRestoreTimeoutMs?: number
    passwordTimeoutMs?: number
    accountSafeStorage?: SafeStorageLike
    providers?: { google: boolean; password: boolean }
    accountRoots?: boolean
    capabilities?: {
      activateAccount: (input: { accountId: string; generation: number; paths: AccountScopedPaths }) => unknown
      revokeAccount: (input: { accountId: string; accountGeneration: number }) => unknown
    }
    projectionChanged?: (roster: Awaited<ReturnType<AtumMessagingRuntime['roster']>>) => void
    switchTimeoutMs?: number
    onTerminal?: (event: AtumAuthTerminalEvent) => void
    onBrowserOpened?: () => void
    browserOpenGate?: Promise<void>
  } = {}
) {
  const origin = await fakeServer(state)
  const directory = userData()
  const accountRoots = options.accountRoots ? new AccountRootAuthority(directory) : null
  let client!: SupabaseAtumAccountClient
  let controller!: AtumAccountAuthController

  const runtime = new AtumMessagingRuntime({
    userDataPath: directory,
    safeStorage,
    officialAuthSession: null,
    databasePathForAccount: accountRoots ? accountId => accountRoots.prepare(accountId).messagingDatabase : undefined,
    projectionChanged: options.projectionChanged,
    refreshSession: (session, signal) => controller?.refresh(session, signal) ?? client.refresh(session, signal)
  })

  runtimes.push(runtime)
  // Stands in for the browser + OS seam: GoTrue's 302 lands on the platform
  // bridge page, which performs the `atum://auth-callback/<state>` handoff that
  // the OS would hand to `open-url`.
  const callbacks = new AtumAuthCallbackBroker()
  const delivered: string[] = []
  const storage = new SafeStorageAuthStorage(join(directory, 'atum-auth', 'official-session.json'), safeStorage)
  client = new SupabaseAtumAccountClient(
    resolveAtumAccountConfig({
      hostedBaseUrl: origin,
      supabaseUrl: origin,
      supabaseAnonKey: 'public-anon-key',
      providers: options.providers ?? { google: true, password: true }
    })!,
    {
      timeoutMs: options.timeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      hostedAcquireTimeoutMs: options.hostedAcquireTimeoutMs,
      hostedRestoreTimeoutMs: options.hostedRestoreTimeoutMs,
      passwordTimeoutMs: options.passwordTimeoutMs,
      callbacks,
      storage: accountRoots ? undefined : storage,
      storageForAccount: accountRoots
        ? accountId =>
            new SafeStorageAuthStorage(
              accountRoots.prepare(accountId).authStorage,
              options.accountSafeStorage ?? safeStorage
            )
        : undefined,
      openExternal: async url => {
        const response = await fetch(url, { redirect: 'manual' })
        const redirect = response.headers.get('location')

        options.onBrowserOpened?.()
        await options.browserOpenGate

        if (!redirect) {
          return
        }

        // The browser now lands on the platform's bridge page rather than on
        // the deep link itself. Stand in for that page: it turns
        // `<hosted>/auth/desktop/<state>?code=…` into
        // `atum://auth-callback/<state>?code=…` and hands that to the OS,
        // which is the seam `callbacks.deliver` models.
        const landed = new URL(redirect)
        const state = landed.pathname.slice(landed.pathname.lastIndexOf('/') + 1)

        delivered.push(callbacks.deliver(`atum://auth-callback/${state}${landed.search}`).outcome)
      }
    }
  )
  controller = new AtumAccountAuthController({
    runtime,
    client,
    accountRoots: accountRoots ?? undefined,
    capabilities: options.capabilities,
    switchTimeoutMs: options.switchTimeoutMs,
    onTerminal: options.onTerminal
  })

  return { accountRoots, callbacks, client, controller, delivered, directory, origin, runtime, storage }
}

async function waitForAuthRequest(state: FakeAuthState, pattern: string): Promise<void> {
  const deadline = Date.now() + 2_000

  while (!state.requests.some(request => request.path.includes(pattern))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${pattern}`)
    }

    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function waitForHostedRequestCount(state: FakeAuthState, path: string, count: number): Promise<void> {
  const deadline = Date.now() + 2_000

  while (state.requests.filter(request => request.path === path).length < count) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${count} requests to ${path}`)
    }

    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function waitForMessagingOnline(runtime: AtumMessagingRuntime): Promise<void> {
  const deadline = Date.now() + 2_000

  while ((await runtime.status()).connectivity !== 'online') {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for initial messaging sync')
    }

    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('system-browser deep-link PKCE carries real bytes and installs only a hosted-verified account', async () => {
  const state = initialState()
  const { controller, runtime } = await harness(state)
  const status = await controller.signIn()

  assert.equal(status.state, 'signed_in')
  assert.deepEqual(status.account, { id: USER_A, displayName: 'Minh', handle: null, avatarUrl: null, handleCustomized: null, nextHandleChangeAt: null })
  await waitForMessagingOnline(runtime)
  assert.equal(
    state.requests.some(request => request.path.includes('code_verifier')),
    false
  )
  const tokenRequest = state.requests.find(request => request.path.includes('grant_type=pkce'))!
  assert.equal(typeof JSON.parse(tokenRequest.body).code_verifier, 'string')
  const authorizeRequest = state.requests.find(request => request.path.startsWith('/auth/v1/authorize'))!
  assert.equal(new URL(authorizeRequest.path, 'https://auth.test').searchParams.get('prompt'), 'select_account')
})

test('sanitized provider capabilities gate unavailable flows without opening a request', async () => {
  const state = initialState()
  const { controller } = await harness(state, { providers: { google: false, password: true } })

  assert.deepEqual(controller.status().providers, { google: false, password: true })
  const unavailable = await controller.signIn()
  assert.equal(unavailable.state, 'signed_out')
  assert.equal(unavailable.errorCode, 'google_provider_unavailable')
  assert.deepEqual(unavailable.providers, { google: false, password: true })
  assert.equal(state.requests.length, 0)
})

test('official email/password auth installs only a hosted-verified encrypted session', async () => {
  const state = initialState()
  const { controller, directory, runtime } = await harness(state)
  const input = { identifier: 'owner@example.test', password: 'dogfood-password-123' }
  const status = await controller.signInWithPassword(input)

  assert.deepEqual(status, {
    state: 'signed_in',
    configured: true,
    account: { id: USER_A, displayName: 'Minh', handle: null, avatarUrl: null, handleCustomized: null, nextHandleChangeAt: null },
    current: status.current,
    errorCode: null,
    providers: { google: true, password: true }
  })
  await waitForMessagingOnline(runtime)
  const passwordRequest = state.requests.find(request => request.path.includes('grant_type=password'))!
  assert.deepEqual(JSON.parse(passwordRequest.body), {
    email: input.identifier,
    password: input.password,
    gotrue_meta_security: {}
  })
  assert.doesNotMatch(JSON.stringify(status), /owner@example|dogfood-password/i)
  assert.doesNotMatch(
    readFileSync(join(directory, 'atum-auth', 'official-session.json'), 'utf8'),
    /owner@example|dogfood-password/i
  )
})

test('commits account authority before a cumulative bounded initial backfill can exhaust the switch barrier', async () => {
  const state = initialState({ messagingResponseDelayMs: 30 })

  const { accountRoots, controller, runtime } = await harness(state, {
    accountRoots: true,
    requestTimeoutMs: 250,
    switchTimeoutMs: 45
  })

  const status = await controller.signIn()

  // The first `/session` verification precedes the barrier. The subsequent
  // session + sync + roster + history requests are each below requestTimeoutMs
  // but together exceed switchTimeoutMs; they must not roll back this account.
  assert.equal(status.state, 'signed_in')
  assert.equal(status.account?.id, USER_A)
  assert.equal(runtime.currentSession()?.user.id, USER_A)
  assert.equal(accountRoots!.committed()?.marker.accountKey, accountRoots!.pathsForAccount(USER_A).accountKey)
  assert.equal((await runtime.status()).connectivity, 'loading')

  await waitForMessagingOnline(runtime)
  assert.equal((await runtime.status()).synchronized, true)
})

test('sign-out aborts an asynchronous initial backfill without leaving account authority behind', async () => {
  const state = initialState({ messagingResponseDelayMs: 100 })

  const { accountRoots, controller, runtime } = await harness(state, {
    accountRoots: true,
    requestTimeoutMs: 500,
    switchTimeoutMs: 45
  })

  assert.equal((await controller.signIn()).state, 'signed_in')
  await waitForHostedRequestCount(state, '/api/desktop/v1/session', 2)
  await controller.signOut()

  assert.equal(runtime.currentSession(), null)
  assert.equal((await runtime.status()).accountId, null)
  assert.equal(accountRoots!.committed(), null)
})

test('account switch aborts a deferred backfill before it can publish the previous account roster', async () => {
  const state = initialState({ messagingResponseDelayMs: 50 })
  const published: Array<{ accountId: string | null; roster: Awaited<ReturnType<AtumMessagingRuntime['roster']>> }> = []
  let runtime: AtumMessagingRuntime | null = null

  const harnessed = await harness(state, {
    accountRoots: true,
    requestTimeoutMs: 500,
    switchTimeoutMs: 45,
    projectionChanged: roster => published.push({ accountId: runtime?.currentSession()?.user.id ?? null, roster })
  })

  runtime = harnessed.runtime

  assert.equal((await harnessed.controller.signIn()).account?.id, USER_A)
  await waitForHostedRequestCount(state, '/api/desktop/v1/session', 2)

  state.userId = USER_B
  assert.equal((await harnessed.controller.signIn()).account?.id, USER_B)
  const publishedAfterSwitch = published.length

  await waitForMessagingOnline(runtime)
  await new Promise(resolve => setTimeout(resolve, 100))

  const backfillsAfterSwitch = published.slice(publishedAfterSwitch).filter(event => event.roster.length > 0)
  assert.equal(backfillsAfterSwitch.length, 1)
  assert.equal(backfillsAfterSwitch[0]?.accountId, USER_B)
})

test('physical account switch commits separate private auth and messaging roots', async () => {
  const state = initialState()
  const { accountRoots, controller, runtime } = await harness(state, { accountRoots: true })
  const input = { identifier: 'owner@example.test', password: 'dogfood-password-123' }

  assert.equal((await controller.signInWithPassword(input)).account?.id, USER_A)
  const pathsA = accountRoots!.pathsForAccount(USER_A)
  const authA = readFileSync(pathsA.authStorage, 'utf8')
  assert.equal(existsSync(pathsA.messagingDatabase), true)

  state.userId = USER_B
  assert.equal((await controller.signInWithPassword(input)).account?.id, USER_B)
  const pathsB = accountRoots!.pathsForAccount(USER_B)

  assert.notEqual(pathsA.root, pathsB.root)
  assert.equal(pathsA.root.includes(USER_A), false)
  assert.equal(pathsB.root.includes(USER_B), false)
  assert.equal(readFileSync(pathsA.authStorage, 'utf8'), authA)
  assert.equal(existsSync(pathsA.messagingDatabase), true)
  assert.equal(existsSync(pathsB.authStorage), true)
  assert.equal(existsSync(pathsB.messagingDatabase), true)
  assert.equal(statSync(pathsB.authStorage).mode & 0o777, 0o600)
  assert.equal(statSync(pathsB.messagingDatabase).mode & 0o777, 0o600)
  assert.equal(accountRoots!.committed()!.marker.accountKey, pathsB.accountKey)
  assert.equal(runtime.currentSession()?.user.id, USER_B)
})

test('physical account lifecycle activates and revokes the exact capability generation before publication', async () => {
  const state = initialState()
  const activated: Array<{ accountId: string; generation: number; paths: AccountScopedPaths }> = []
  const revoked: Array<{ accountId: string; accountGeneration: number }> = []

  const capabilities = {
    activateAccount: vi.fn((input: { accountId: string; generation: number; paths: AccountScopedPaths }) => {
      activated.push(input)
    }),
    revokeAccount: vi.fn((input: { accountId: string; accountGeneration: number }) => {
      revoked.push(input)
    })
  }

  const { controller } = await harness(state, { accountRoots: true, capabilities })
  const input = { identifier: 'owner@example.test', password: 'dogfood-password-123' }

  await controller.signInWithPassword(input)
  assert.equal(activated[0]?.accountId, USER_A)
  assert.equal(activated[0]?.generation, 1)

  state.userId = USER_B
  await controller.signInWithPassword(input)
  assert.deepEqual(revoked[0], {
    accountId: USER_A,
    accountGeneration: 1
  })
  assert.equal(activated[1]?.accountId, USER_B)
  assert.equal(activated[1]?.generation, 2)

  await controller.signOut()
  assert.deepEqual(revoked[1], {
    accountId: USER_B,
    accountGeneration: 2
  })
})

test('capability revocation failure still closes runtime and auth on sign-out', async () => {
  const state = initialState()

  const capabilities = {
    activateAccount: vi.fn((_input: { accountId: string; generation: number; paths: AccountScopedPaths }) => undefined),
    revokeAccount: vi.fn((_input: { accountId: string; accountGeneration: number }) => {
      throw new Error('capability_revoke_failed')
    })
  }

  const { accountRoots, controller, runtime } = await harness(state, { accountRoots: true, capabilities })
  const input = { identifier: 'owner@example.test', password: 'dogfood-password-123' }

  await controller.signInWithPassword(input)
  const status = await controller.signOut()

  assert.equal(status.state, 'error')
  assert.equal(status.errorCode, 'account_local_failure')
  assert.equal(runtime.currentSession(), null)
  assert.equal(accountRoots!.committed(), null)
})

test('an absent interaction grant cannot prevent global Auth revocation', async () => {
  const state = initialState()

  const capabilities = {
    activateAccount: vi.fn((_input: { accountId: string; generation: number; paths: AccountScopedPaths }) => undefined),
    // Mirrors the interaction authority's idempotent no-active-account close.
    revokeAccount: vi.fn((_input: { accountId: string; accountGeneration: number }) => undefined)
  }

  const { controller } = await harness(state, { accountRoots: true, capabilities })
  await controller.signIn()

  const status = await controller.signOut()

  assert.equal(status.state, 'signed_out')
  assert.equal(capabilities.revokeAccount.mock.calls.length, 1)
  assert.equal(
    state.requests.some(request => request.path.startsWith('/auth/v1/logout')),
    true
  )
})

test('quiescence timeout fails closed while preserving the last committed account for restart', async () => {
  const state = initialState()

  const { accountRoots, client, controller, runtime } = await harness(state, {
    accountRoots: true,
    // This controller-wide budget also covers the initial installSession. Keep
    // enough headroom for a loaded hosted suite; the second quiesce is mocked
    // never to resolve, so the timeout behavior remains deterministic.
    switchTimeoutMs: 500
  })

  const input = { identifier: 'owner@example.test', password: 'dogfood-password-123' }

  const initial = await controller.signInWithPassword(input)
  const committedA = accountRoots!.committed()

  assert.equal(initial.state, 'signed_in')
  assert.equal(initial.account?.id, USER_A)
  assert.ok(committedA)
  const persistedA = readFileSync(committedA.paths.authStorage, 'utf8')
  state.userId = USER_B
  vi.spyOn(runtime, 'quiesce').mockImplementationOnce(() => new Promise<void>(() => undefined))

  const failed = await controller.signInWithPassword(input)

  assert.equal(failed.state, 'error')
  assert.equal(failed.errorCode, 'account_quiescence_timeout')
  assert.equal(runtime.currentSession(), null)
  assert.equal(accountRoots!.committed()!.marker.accountKey, committedA.marker.accountKey)
  assert.equal(readFileSync(committedA.paths.authStorage, 'utf8'), persistedA)

  state.userId = USER_A

  const restoredClient = new SupabaseAtumAccountClient(client.config, {
    callbacks: new AtumAuthCallbackBroker(),
    openExternal: async () => undefined,
    storage: new SafeStorageAuthStorage(committedA.paths.authStorage, safeStorage),
    storageForAccount: accountId =>
      new SafeStorageAuthStorage(accountRoots!.prepare(accountId).authStorage, safeStorage)
  })

  const restored = await restoredClient.restore()

  assert.equal(restored?.user.id, USER_A)
  accountRoots!.assertCommittedAccount(restored!.user.id)
  await restoredClient.dispose()
})

test('a renderer publication failure rolls back the candidate marker and leaves no account accessible', async () => {
  const state = initialState()

  const { accountRoots, controller, runtime } = await harness(state, { accountRoots: true })

  ;(
    runtime as unknown as {
      options: { projectionChanged: () => void }
    }
  ).options.projectionChanged = () => {
    throw new Error('renderer_projection_failed')
  }

  const failed = await controller.signInWithPassword({
    identifier: 'owner@example.test',
    password: 'dogfood-password-123'
  })

  assert.equal(failed.state, 'error')
  assert.equal(failed.errorCode, 'account_sign_in_failed')
  assert.equal(accountRoots!.committed(), null)
  assert.equal(runtime.currentSession(), null)
})

test('password auth rejection is sanitized even when upstream echoes credentials', async () => {
  const state = initialState({ passwordAccepted: false })
  const { controller, directory, runtime } = await harness(state)
  const identifier = '@owner'
  const password = 'wrong-password-123'

  const consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  ]

  const status = await controller.signInWithPassword({ identifier, password })

  assert.equal(status.state, 'error')
  assert.equal(status.errorCode, 'password_sign_in_failed:400')
  assert.doesNotMatch(JSON.stringify(status), new RegExp(`${identifier}|${password}`))
  assert.equal(runtime.accountProfile(), null)
  assert.throws(() => readFileSync(join(directory, 'atum-messaging', 'session.json'), 'utf8'))
  assert.equal(
    consoleSpies.some(spy => JSON.stringify(spy.mock.calls).includes(identifier)),
    false
  )
  assert.equal(
    consoleSpies.some(spy => JSON.stringify(spy.mock.calls).includes(password)),
    false
  )

  for (const spy of consoleSpies) {
    spy.mockRestore()
  }
})

test('identifier/password session is not installed when auth and session identities disagree', async () => {
  const { controller, runtime } = await harness(initialState({ hostedUserId: USER_B }))

  const status = await controller.signInWithPassword({
    identifier: '+12025550101',
    password: 'dogfood-password-123'
  })

  assert.equal(status.state, 'error')
  assert.equal(status.errorCode, 'hosted_account_mismatch')
  assert.equal(runtime.accountProfile(), null)
})

test('hosted identifier/password auth has bounded timeout and response body', async () => {
  const timed = await harness(initialState({ passwordNeverRespond: true }), { passwordTimeoutMs: 20 })

  const timedStatus = await timed.controller.signInWithPassword({
    identifier: 'owner',
    password: 'dogfood-password-123'
  })

  assert.equal(timedStatus.errorCode, 'password_sign_in_timeout')

  const cancelled = await harness(initialState({ passwordNeverRespond: true }), { passwordTimeoutMs: 5_000 })

  const pending = cancelled.controller.signInWithPassword({
    identifier: 'owner',
    password: 'dogfood-password-123'
  })

  await new Promise(resolve => setTimeout(resolve, 5))
  cancelled.controller.cancel()
  assert.equal((await pending).state, 'signed_out')

  const oversized = await harness(initialState({ passwordOversized: true }))

  const oversizedStatus = await oversized.controller.signInWithPassword({
    identifier: 'owner',
    password: 'dogfood-password-123'
  })

  assert.equal(oversizedStatus.errorCode, 'auth_response_too_large')
  assert.equal(oversized.runtime.accountProfile(), null)
})

test('PKCE token exchange and hosted verification each have bounded timeouts', async () => {
  const exchange = await harness(initialState({ pkceNeverRespond: true }), { requestTimeoutMs: 20 })
  const exchangeStatus = await exchange.controller.signIn()
  assert.equal(exchangeStatus.state, 'error')
  assert.equal(exchangeStatus.errorCode, 'token_exchange_timeout')
  assert.equal(exchange.runtime.accountProfile(), null)

  const verification = await harness(initialState({ hostedSessionNeverRespond: true }), {
    hostedAcquireTimeoutMs: 20
  })

  const verificationStatus = await verification.controller.signIn()
  assert.equal(verificationStatus.state, 'error')
  assert.equal(verificationStatus.errorCode, 'hosted_session_timeout')
  assert.equal(verification.runtime.accountProfile(), null)
})

test('hosted verification honors HTTP status before attempting to parse an HTML error body', async () => {
  const state = initialState({ hostedSessionStatus: 502, hostedSessionHtmlError: true })
  const { controller } = await harness(state)

  const status = await controller.signIn()

  assert.equal(status.errorCode, 'hosted_session_rejected:502')
})

test('hosted acquire and cold restore use distinct deadlines', async () => {
  const state = initialState()
  const signedIn = await harness(state)
  await signedIn.controller.signIn()
  state.hostedSessionNeverRespond = true

  const restoredClient = new SupabaseAtumAccountClient(signedIn.client.config, {
    callbacks: new AtumAuthCallbackBroker(),
    openExternal: async () => undefined,
    storage: new SafeStorageAuthStorage(join(signedIn.directory, 'atum-auth', 'official-session.json'), safeStorage),
    hostedAcquireTimeoutMs: 2_000,
    hostedRestoreTimeoutMs: 20
  })

  const startedAt = Date.now()

  assert.equal(await restoredClient.restore(), null)
  assert.equal(restoredClient.initialErrorCode(), 'hosted_session_timeout')
  assert.ok(Date.now() - startedAt < 1_000)
  await restoredClient.dispose()
})

test('cold restore retries one transient hosted-session failure and then succeeds', async () => {
  const state = initialState()
  const signedIn = await harness(state)
  await signedIn.controller.signIn()
  let attempts = 0

  const restoredClient = new SupabaseAtumAccountClient(signedIn.client.config, {
    callbacks: new AtumAuthCallbackBroker(),
    openExternal: async () => undefined,
    fetchImpl: async (input, init) => {
      if (String(input).endsWith('/api/desktop/v1/session') && attempts++ === 0) {
        throw new TypeError('temporary network failure')
      }

      return fetch(input, init)
    },
    storage: new SafeStorageAuthStorage(join(signedIn.directory, 'atum-auth', 'official-session.json'), safeStorage)
  })

  assert.equal((await restoredClient.restore())?.user.id, USER_A)
  assert.equal(attempts, 2)
  await restoredClient.dispose()
})

test('activation fails closed when safeStorage is unavailable or encryption fails', async () => {
  const unavailable = await harness(initialState(), {
    accountRoots: true,
    accountSafeStorage: { ...safeStorage, isEncryptionAvailable: () => false }
  })

  const unavailableStatus = await unavailable.controller.signInWithPassword({
    identifier: 'owner@example.test',
    password: 'dogfood-password-123'
  })

  assert.equal(unavailableStatus.errorCode, 'account_storage_unavailable')
  assert.equal(unavailable.runtime.currentSession(), null)
  assert.equal(unavailable.accountRoots!.committed(), null)

  const encryptFailed = await harness(initialState(), {
    accountRoots: true,
    accountSafeStorage: {
      ...safeStorage,
      encryptString: () => {
        throw new Error('private keychain detail')
      }
    }
  })

  const encryptStatus = await encryptFailed.controller.signInWithPassword({
    identifier: 'owner@example.test',
    password: 'dogfood-password-123'
  })

  assert.equal(encryptStatus.errorCode, 'account_storage_encrypt_failed')
  assert.equal(encryptFailed.runtime.currentSession(), null)
  assert.equal(encryptFailed.accountRoots!.committed(), null)
})

test('terminal auth outcomes are closed enums without account, token, or upstream detail', async () => {
  const events: AtumAuthTerminalEvent[] = []
  const state = initialState()
  const { controller } = await harness(state, { onTerminal: event => events.push(event) })

  await controller.restore()
  await controller.signIn()
  await controller.signOut()

  assert.deepEqual(events, [
    { operation: 'restore', outcome: 'signed_out', code: 'none' },
    { operation: 'acquire', provider: 'google', outcome: 'success', code: 'none' },
    { operation: 'sign_out', outcome: 'success', code: 'none' }
  ])
  assert.doesNotMatch(JSON.stringify(events), new RegExp(`${USER_A}|Bearer|access`, 'iu'))
})

test('every main-process terminal failure code is preserved by the closed sanitizer', () => {
  for (const code of ATUM_AUTH_STABLE_FAILURE_CODES) {
    assert.equal(stableAtumAuthFailureCode(code), code)
  }

  assert.equal(
    stableAtumAuthFailureCode(new Error('authorization_callback_error:access_denied')),
    'authorization_callback_denied'
  )
  assert.equal(
    stableAtumAuthFailureCode(new Error('authorization_callback_error:server_error')),
    'authorization_callback_failed'
  )
  assert.equal(stableAtumAuthFailureCode(new Error('private upstream detail')), 'account_local_failure')
})

test('cancelling a hung hosted verification returns to signed out without installing credentials', async () => {
  const state = initialState({ hostedSessionNeverRespond: true })
  const { controller, runtime } = await harness(state, { requestTimeoutMs: 5_000 })
  const pending = controller.signIn()

  await waitForAuthRequest(state, '/api/desktop/v1/session')
  controller.cancel()

  const status = await pending
  assert.equal(status.state, 'signed_out')
  assert.equal(status.errorCode, null)
  assert.equal(runtime.accountProfile(), null)
})

test('an upstream authorization error is surfaced without installing a partial session', async () => {
  const { controller, runtime } = await harness(initialState({ authorizeMode: 'callback_error' }))
  const status = await controller.signIn()
  assert.equal(status.state, 'error')
  assert.equal(status.errorCode, 'authorization_callback_denied')
  assert.equal(runtime.accountProfile(), null)
})

test('a callback whose state was tampered with is dropped, not exchanged', async () => {
  // The deep link is a public channel: a forged state must neither complete
  // the sign-in NOR abort the real request (that would be a one-line DoS).
  // It is simply not delivered, and the attempt runs out its own clock.
  const { controller, delivered, runtime } = await harness(initialState({ authorizeMode: 'state_mismatch' }), {
    timeoutMs: 50
  })

  const status = await controller.signIn()

  assert.deepEqual(delivered, ['state_mismatch'])
  assert.equal(status.state, 'error')
  assert.equal(status.errorCode, 'authorization_timeout')
  assert.equal(runtime.accountProfile(), null)
})

test('timeout and explicit cancel close the browser attempt', async () => {
  const timed = await harness(initialState({ authorizeMode: 'never' }), { timeoutMs: 20 })
  const timedStatus = await timed.controller.signIn()
  assert.equal(timedStatus.errorCode, 'authorization_timeout')

  let cancelledBrowserOpened!: () => void
  let releaseCancelledBrowser!: () => void

  const cancelledBrowserReady = new Promise<void>(resolve => {
    cancelledBrowserOpened = resolve
  })

  const cancelledBrowserGate = new Promise<void>(resolve => {
    releaseCancelledBrowser = resolve
  })

  const cancelled = await harness(initialState({ authorizeMode: 'never' }), {
    timeoutMs: 5_000,
    onBrowserOpened: cancelledBrowserOpened,
    browserOpenGate: cancelledBrowserGate
  })

  const pending = cancelled.controller.signIn()
  await cancelledBrowserReady
  assert.equal(cancelled.controller.status().state, 'signing_in')
  cancelled.controller.cancel()
  await new Promise<void>(resolve => setImmediate(resolve))
  releaseCancelledBrowser()
  assert.deepEqual(await pending, {
    state: 'signed_out',
    configured: true,
    account: null,
    current: null,
    errorCode: null,
    providers: { google: true, password: true }
  })

  let shutdownBrowserOpened!: () => void
  let releaseShutdownBrowser!: () => void

  const shutdownBrowserReady = new Promise<void>(resolve => {
    shutdownBrowserOpened = resolve
  })

  const shutdownBrowserGate = new Promise<void>(resolve => {
    releaseShutdownBrowser = resolve
  })

  const shutdown = await harness(initialState({ authorizeMode: 'never' }), {
    timeoutMs: 5_000,
    onBrowserOpened: shutdownBrowserOpened,
    browserOpenGate: shutdownBrowserGate
  })

  const shutdownPending = shutdown.controller.signIn()
  await shutdownBrowserReady
  shutdown.controller.stop()
  await new Promise<void>(resolve => setImmediate(resolve))
  releaseShutdownBrowser()
  assert.equal((await shutdownPending).state, 'signed_out')
})

test('malformed token response is an error and never reaches the encrypted runtime vault', async () => {
  const { controller, runtime } = await harness(initialState({ malformedToken: true }))
  const status = await controller.signIn()
  assert.equal(status.errorCode, 'invalid_token_response')
  assert.equal(runtime.accountProfile(), null)
})

test('a hosted 401 performs exactly one main-process refresh and one replay', async () => {
  const state = initialState()
  const { controller, runtime } = await harness(state)
  await controller.signIn()
  const firstAccess = [...state.validTokens][0]!
  state.validTokens.delete(firstAccess)

  const status = await runtime.sync()
  assert.equal(status.connectivity, 'online')
  assert.equal(state.refreshCount, 1)
  const refreshRequests = state.requests.filter(request => request.path.includes('grant_type=refresh_token'))
  assert.equal(refreshRequests.length, 1)
})

test('parallel 401s share one refresh-token rotation and each replay with the refreshed session', async () => {
  const state = initialState({ refreshDelayMs: 40 })
  const { controller, runtime } = await harness(state)
  await controller.signIn()
  const firstAccess = [...state.validTokens][0]!
  state.validTokens.delete(firstAccess)

  // The engine's durable receipt queue deliberately collapses repeated
  // markReads for one position (see store.markRead), so exercise the
  // refresh-sharing contract at the HTTP layer it belongs to: six truly
  // concurrent authenticated requests against one revoked access token.
  const hosted = (runtime as unknown as { http: { markRead(c: string, m: string, o: string): Promise<void> } }).http
  await Promise.all(Array.from({ length: 6 }, () => hosted.markRead(CONVERSATION_ID, MESSAGE_ID, randomUUID())))

  assert.equal(state.refreshCount, 1)
  assert.equal(
    state.requests.filter(
      request => request.path.endsWith('/read') && request.authorization === `Bearer ${firstAccess}`
    ).length,
    6
  )
  assert.equal(
    state.requests.filter(
      request => request.path.endsWith('/read') && request.authorization !== `Bearer ${firstAccess}`
    ).length,
    6
  )
})

test('refresh is bounded and stop aborts a hung refresh without a late replay', async () => {
  const timedState = initialState()
  const timed = await harness(timedState)
  const signedIn = await timed.controller.signIn()
  assert.equal(signedIn.state, 'signed_in')
  assert.equal(signedIn.errorCode, null)
  const timedAccess = [...timedState.validTokens][0]!
  timedState.validTokens.delete(timedAccess)
  timedState.refreshNeverRespond = true

  // The refresh must have REACHED the stub before its count can be asserted.
  // This used to race a 20ms deadline against the request being dispatched at
  // all: under a loaded full-suite run the abort won, the stub never saw the
  // request, and `refreshCount` was still 0. Waiting on arrival makes the
  // assertion observe a real happens-before, and the deadline is loose enough
  // that scheduling jitter cannot beat the request to a loopback socket.
  const refreshArrived = new Promise<void>(resolve => {
    timedState.onRefreshReceived = resolve
  })

  // OAuth setup and refresh use the same configured request deadline. Tighten
  // only the active-session tracker after setup to isolate the hung refresh.
  ;(timed.client as unknown as { tracker: { timeoutMs: number } }).tracker.timeoutMs = 200

  const syncing = timed.runtime.sync()
  await Promise.race([
    refreshArrived,
    // A genuine regression must fail loudly here rather than hang the suite.
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('refresh never reached the stub')), 5000).unref?.()
    )
  ])
  // Arrived; now let the hung refresh run out its own deadline.
  await syncing
  assert.equal(timedState.refreshCount, 1)
  assert.equal(
    timedState.requests.filter(request => request.path.includes('grant_type=refresh_token')).length,
    1
  )
  assert.equal(timed.controller.status().state, 'expired')
  assert.equal(timed.controller.status().errorCode, 'account_refresh_timeout')

  const stoppedState = initialState()
  const stopped = await harness(stoppedState, { requestTimeoutMs: 5_000 })
  await stopped.controller.signIn()
  const stoppedAccess = [...stoppedState.validTokens][0]!
  stoppedState.validTokens.delete(stoppedAccess)
  stoppedState.refreshNeverRespond = true
  const pending = stopped.runtime.sync()

  await waitForAuthRequest(stoppedState, 'grant_type=refresh_token')
  stopped.runtime.stop()
  await pending
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(
    stoppedState.requests.some(
      request => request.authorization?.startsWith('Bearer ') && request.authorization !== `Bearer ${stoppedAccess}`
    ),
    false
  )
})

test('logout aborts the previous refresh and cannot reuse its rotated token', async () => {
  const state = initialState()
  const { controller, origin, runtime } = await harness(state, { requestTimeoutMs: 5_000 })
  await controller.signIn()
  const oldAccess = [...state.validTokens][0]!
  state.validTokens.delete(oldAccess)
  state.refreshNeverRespond = true
  const staleSync = runtime.sync()
  await waitForAuthRequest(state, 'grant_type=refresh_token')

  await controller.signOut()
  await staleSync

  assert.equal(runtime.accountProfile(), null)
  assert.equal((await runtime.status()).accountId, null)
  assert.equal(
    state.requests.some(
      request => request.authorization?.startsWith('Bearer ') && request.authorization !== `Bearer ${oldAccess}`
    ),
    false
  )
})

test('transient refresh timeout preserves the encrypted official session for retry', async () => {
  const state = initialState()
  const { controller, runtime, storage } = await harness(state, { requestTimeoutMs: 25 })
  await controller.signIn()
  const persisted = storage.getItem(ACTIVE_AUTH_STORAGE_KEY)
  const oldAccess = [...state.validTokens][0]!
  state.validTokens.delete(oldAccess)
  state.refreshNeverRespond = true

  await runtime.sync()

  assert.equal(controller.status().state, 'expired')
  assert.match(controller.status().errorCode ?? '', /account_refresh_(failed|timeout)/)
  assert.equal(storage.getItem(ACTIVE_AUTH_STORAGE_KEY), persisted)
  assert.equal(runtime.accountProfile()?.id, USER_A)
})

test('transient hosted restore failure preserves credentials while positive revocation clears them', async () => {
  const state = initialState()
  const { client, controller, directory, storage } = await harness(state)
  await controller.signIn()
  const persisted = storage.getItem(ACTIVE_AUTH_STORAGE_KEY)
  state.hostedSessionStatus = 500

  const transientStorage = new SafeStorageAuthStorage(
    join(directory, 'atum-auth', 'official-session.json'),
    safeStorage
  )

  const transientClient = new SupabaseAtumAccountClient(client.config, {
    callbacks: new AtumAuthCallbackBroker(),
    openExternal: async () => undefined,
    storage: transientStorage
  })

  assert.equal(await transientClient.restore(), null)
  assert.equal(transientClient.initialErrorCode(), 'hosted_session_rejected:500')
  assert.equal(transientStorage.getItem(ACTIVE_AUTH_STORAGE_KEY), persisted)

  state.hostedSessionStatus = 401

  const revokedClient = new SupabaseAtumAccountClient(client.config, {
    callbacks: new AtumAuthCallbackBroker(),
    openExternal: async () => undefined,
    storage: transientStorage
  })

  assert.equal(await revokedClient.restore(), null)
  assert.equal(revokedClient.initialErrorCode(), 'account_restore_rejected')
  assert.equal(transientStorage.getItem(ACTIVE_AUTH_STORAGE_KEY), null)
})

// A cold restore that finds a lapsed credential learns exactly what a failed
// refresh learns, and `refresh()` already calls that 'expired'. Reporting it as
// 'error' put a red sign-in failure on a window nobody had touched yet, and
// picked the wrong story on top of it: 'account_restore_rejected' classifies as
// 'provider', so a session that simply ran out was announced to the renderer as
// a sign-in outage. A transport failure is still an error — nothing was learned
// about the credential there.
test('saved-session retry recovers a transient startup failure without OAuth and coalesces clicks', async () => {
  const state = initialState()
  const { client, controller, directory, runtime } = await harness(state)
  await controller.signIn()
  await runtime.sync()
  controller.stop()
  await client.dispose()
  runtime.stop()
  state.hostedSessionStatus = 503
  const openExternal = vi.fn(async () => undefined)

  const restoredClient = new SupabaseAtumAccountClient(client.config, {
    callbacks: new AtumAuthCallbackBroker(), openExternal,
    storage: new SafeStorageAuthStorage(join(directory, 'atum-auth', 'official-session.json'), safeStorage)
  })

  const restarted = new AtumMessagingRuntime({
    userDataPath: directory, safeStorage, officialAuthSession: null,
    refreshSession: (session, signal) => restoredClient.refresh(session, signal)
  })

  runtimes.push(restarted)
  const restoredController = new AtumAccountAuthController({ runtime: restarted, client: restoredClient })
  const failClosed = vi.spyOn(restoredClient, 'failClosed')
  assert.equal((await restoredController.restore()).errorCode, 'hosted_session_rejected:503')
  assert.equal(failClosed.mock.calls.length, 0, 'transient restore must retain saved credentials')
  assert.equal(restarted.currentSession(), null, 'unverified credentials cannot install an account')
  assert.equal((await restoredController.retryRestore()).errorCode, 'hosted_session_rejected:503')
  assert.equal(failClosed.mock.calls.length, 0, 'a failed retry must also retain saved credentials')
  state.hostedSessionStatus = undefined
  const restore = vi.spyOn(restoredClient, 'restore')
  const verification = vi.spyOn(restoredClient, 'verifyHostedSession')
  const [first, second] = await Promise.all([restoredController.retryRestore(), restoredController.retryRestore()])
  assert.equal(restore.mock.calls.length, 1, 'must invoke restore')
  assert.equal(verification.mock.calls.length, 1, 'must verify retained session')
  assert.equal(first.state, 'signed_in', first.errorCode ?? '')
  assert.equal(second.account?.id, USER_A)
  assert.equal(restore.mock.calls.length, 1)
  assert.equal(openExternal.mock.calls.length, 0)
  await restoredController.retryRestore()
  assert.equal(restore.mock.calls.length, 1, 'signed-in accounts cannot be restored again')
})

test('saved-session retry refuses a failed switch while an account remains installed', async () => {
  const state = initialState()
  const { client, controller, runtime } = await harness(state, { accountRoots: true })
  assert.equal((await controller.signIn()).state, 'signed_in')
  state.userId = USER_B
  state.hostedSessionStatus = 503
  const failedSwitch = await controller.signIn()
  assert.equal(failedSwitch.state, 'error')
  assert.equal(failedSwitch.errorCode, 'hosted_session_rejected:503')
  assert.equal(runtime.currentSession()?.user.id, USER_A)
  const restore = vi.spyOn(client, 'restore')
  assert.deepEqual(await controller.retryRestore(), failedSwitch)
  assert.equal(restore.mock.calls.length, 0, 'startup restore cannot suppress events on a live account')
  await client.failClosed()
  await vi.waitFor(() => assert.equal(runtime.accountProfile(), null))
  assert.equal(controller.status().state, 'expired', 'live revocation remains observable')
})

test('a locally invalid saved session returns to ordinary sign-in without an outage notice', async () => {
  const { controller, runtime, storage } = await harness(initialState())
  storage.setItem(ACTIVE_AUTH_STORAGE_KEY, JSON.stringify({ invalid: true }))
  const status = await controller.restore()
  assert.equal(status.state, 'signed_out')
  assert.equal(status.errorCode, null)
  assert.equal(runtime.currentSession(), null)
  assert.equal(storage.getItem(ACTIVE_AUTH_STORAGE_KEY), null)
})

test('cold restore reports a lapsed credential as expiry, not a sign-in failure', async () => {
  const state = initialState()
  const { client, controller, directory, runtime } = await harness(state)
  await controller.signIn()
  runtime.stop()

  // Positive revocation: the hosted plane says this credential is no longer
  // good. That is reauthentication, and `refresh()` already calls it 'expired'.
  state.hostedSessionStatus = 401

  const restoredClient = new SupabaseAtumAccountClient(client.config, {
    callbacks: new AtumAuthCallbackBroker(),
    openExternal: async () => undefined,
    storage: new SafeStorageAuthStorage(join(directory, 'atum-auth', 'official-session.json'), safeStorage)
  })

  const restarted = new AtumMessagingRuntime({
    userDataPath: directory,
    safeStorage,
    officialAuthSession: null,
    refreshSession: (session, signal) => restoredClient.refresh(session, signal)
  })

  runtimes.push(restarted)

  const restoredController = new AtumAccountAuthController({ runtime: restarted, client: restoredClient })
  const status = await restoredController.restore()

  // Before this, the renderer got `state: 'error'` with a code that classifies
  // as 'provider' — so a session that simply ran out was announced on an
  // untouched window as "Sign-in is temporarily unavailable."
  assert.equal(status.state, 'expired')
  assert.equal(status.errorCode, 'account_restore_rejected')
  const restore = vi.spyOn(restoredClient, 'restore')
  assert.equal((await restoredController.retryRestore()).state, 'expired')
  assert.equal(restore.mock.calls.length, 0, 'revoked credentials require sign-in, not retry')
})

test('locked safeStorage restore surfaces a stable error without deleting the encrypted session', async () => {
  const state = initialState()
  const { client, controller, directory, storage } = await harness(state)
  await controller.signIn()
  const persisted = storage.getItem(ACTIVE_AUTH_STORAGE_KEY)

  const lockedStorage = new SafeStorageAuthStorage(join(directory, 'atum-auth', 'official-session.json'), {
    ...safeStorage,
    isEncryptionAvailable: () => false
  })

  const lockedClient = new SupabaseAtumAccountClient(client.config, {
    callbacks: new AtumAuthCallbackBroker(),
    openExternal: async () => undefined,
    storage: lockedStorage
  })

  assert.equal(await lockedClient.restore(), null)
  assert.equal(lockedClient.initialErrorCode(), 'account_storage_unavailable')
  assert.equal(storage.getItem(ACTIVE_AUTH_STORAGE_KEY), persisted)
})

test('official-client revocation clears runtime and reports expiration instead of deliberate logout', async () => {
  const state = initialState()
  const { client, controller, runtime } = await harness(state)
  await controller.signIn()

  await client.failClosed()
  await vi.waitFor(() => assert.equal(runtime.accountProfile(), null))

  assert.equal(controller.status().state, 'expired')
  assert.equal(controller.status().errorCode, 'account_session_expired')
})

test('encrypted session restores across restart and logout clears it without renderer credentials', async () => {
  const state = initialState()
  const { client, controller, directory, origin, runtime } = await harness(state)
  await controller.signIn()
  runtime.stop()

  const restoredClient = new SupabaseAtumAccountClient(client.config, {
    callbacks: new AtumAuthCallbackBroker(),
    openExternal: async () => undefined,
    storage: new SafeStorageAuthStorage(join(directory, 'atum-auth', 'official-session.json'), safeStorage)
  })

  const restoredSession = await restoredClient.restore()

  const restarted = new AtumMessagingRuntime({
    userDataPath: directory,
    safeStorage,
    officialAuthSession: restoredSession,
    refreshSession: session => restoredClient.refresh(session)
  })

  runtimes.push(restarted)
  const restoredController = new AtumAccountAuthController({ runtime: restarted, client: restoredClient })
  assert.equal(restoredController.status().account?.id, USER_A)
  assert.equal(restoredController.status().state, 'signed_in')

  const signedOut = await restoredController.signOut()
  assert.equal(signedOut.state, 'signed_out')
  assert.equal(restarted.accountProfile(), null)
})

test('a mismatched account marker is cleared while the configured Google sign-in path remains available', async () => {
  const state = initialState()
  const first = await harness(state, { accountRoots: true })
  await first.controller.signIn()
  const accountA = first.accountRoots!.committed()!
  const accountB = first.accountRoots!.prepare(USER_B)
  copyFileSync(accountA.paths.authStorage, accountB.authStorage)
  first.accountRoots!.commit(USER_B, 2)

  const restoredClient = new SupabaseAtumAccountClient(first.client.config, {
    callbacks: new AtumAuthCallbackBroker(),
    openExternal: async () => undefined,
    storage: new SafeStorageAuthStorage(accountB.authStorage, safeStorage),
    storageForAccount: accountId =>
      new SafeStorageAuthStorage(first.accountRoots!.prepare(accountId).authStorage, safeStorage)
  })

  const restarted = new AtumMessagingRuntime({
    userDataPath: first.directory,
    safeStorage,
    officialAuthSession: null,
    databasePathForAccount: accountId => first.accountRoots!.prepare(accountId).messagingDatabase,
    refreshSession: (session, signal) => restoredClient.refresh(session, signal)
  })

  runtimes.push(restarted)

  const restoredController = new AtumAccountAuthController({
    runtime: restarted,
    client: restoredClient,
    accountRoots: first.accountRoots!
  })

  const status = await restoredController.restore()

  assert.equal(status.state, 'error')
  assert.equal(status.errorCode, 'account_context_unavailable')
  assert.equal(status.configured, true)
  assert.equal(status.providers.google, true)
  assert.equal(first.accountRoots!.committed(), null)
  assert.equal(restarted.currentSession(), null)
})

test('global logout waits for cold restore so restored custody cannot be republished afterward', async () => {
  const state = initialState()
  const first = await harness(state, { accountRoots: true })
  await first.controller.signIn()

  let releaseHostedRestore!: () => void
  let hostedRestoreStarted!: () => void
  const restoreGate = new Promise<void>(resolve => (releaseHostedRestore = resolve))
  const restoreStarted = new Promise<void>(resolve => (hostedRestoreStarted = resolve))
  let gated = false

  const restoredClient = new SupabaseAtumAccountClient(first.client.config, {
    callbacks: new AtumAuthCallbackBroker(),
    openExternal: async () => undefined,
    fetchImpl: async (input, init) => {
      if (!gated && String(input).endsWith('/api/desktop/v1/session')) {
        gated = true
        hostedRestoreStarted()
        await restoreGate
      }

      return fetch(input, init)
    },
    storage: new SafeStorageAuthStorage(first.accountRoots!.committed()!.paths.authStorage, safeStorage),
    storageForAccount: accountId =>
      new SafeStorageAuthStorage(first.accountRoots!.prepare(accountId).authStorage, safeStorage)
  })

  const restarted = new AtumMessagingRuntime({
    userDataPath: first.directory,
    safeStorage,
    officialAuthSession: null,
    databasePathForAccount: accountId => first.accountRoots!.prepare(accountId).messagingDatabase,
    refreshSession: (session, signal) => restoredClient.refresh(session, signal)
  })

  runtimes.push(restarted)

  const restoredController = new AtumAccountAuthController({
    runtime: restarted,
    client: restoredClient,
    accountRoots: first.accountRoots!
  })

  const restoring = restoredController.restore()
  await restoreStarted
  let signOutSettled = false
  const signingOut = restoredController.signOut().finally(() => (signOutSettled = true))
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(signOutSettled, false)
  releaseHostedRestore()
  await restoring
  const status = await signingOut

  assert.equal(status.state, 'signed_out')
  assert.equal(restarted.currentSession(), null)
})

test('two sequential sign-ins require a fail-closed logout between accounts', async () => {
  const state = initialState()
  const { controller, runtime } = await harness(state)
  await controller.signIn()
  assert.equal(runtime.accountProfile()?.id, USER_A)

  await controller.signOut()
  state.userId = USER_B
  const switched = await controller.signIn()
  assert.equal(switched.state, 'signed_in')
  assert.equal(switched.account?.id, USER_B)
  assert.equal((await runtime.status()).accountId, USER_B)
})

test('renderer cannot initiate physical account replacement while one account is active', async () => {
  const state = initialState()
  const { controller, runtime } = await harness(state)
  await controller.signIn()
  const tokenRequests = state.requests.filter(request => request.path.startsWith('/auth/v1/token')).length

  const failed = await controller.signIn()
  assert.equal(failed.state, 'signed_in')
  assert.equal(failed.account?.id, USER_A)
  assert.equal(failed.errorCode, 'account_already_active')
  assert.equal(runtime.accountProfile()?.id, USER_A)
  assert.equal(state.requests.filter(request => request.path.startsWith('/auth/v1/token')).length, tokenRequests)
})

test('configuration is complete, HTTPS outside loopback, and credential-free', () => {
  assert.equal(resolveAtumAccountConfig({}), null)
  assert.throws(
    () => resolveAtumAccountConfig({ hostedBaseUrl: 'https://atum.test', supabaseUrl: 'https://project.supabase.co' }),
    /incomplete/
  )
  assert.throws(
    () =>
      resolveAtumAccountConfig({
        hostedBaseUrl: 'http://atum.test',
        supabaseUrl: 'https://project.supabase.co',
        supabaseAnonKey: 'public-key'
      }),
    /https/
  )
  assert.throws(
    () =>
      resolveAtumAccountConfig({
        hostedBaseUrl: 'https://user:password@atum.test',
        supabaseUrl: 'https://project.supabase.co',
        supabaseAnonKey: 'public-key'
      }),
    /credentials/
  )
})
