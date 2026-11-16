import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixGoogleConnectionBridge, MatrixGoogleConnectionResult } from '../../shared/matrix-google-connections'
import type { MatrixGoogleWriteDecisionInput } from '../../shared/matrix-google-write-proposal'

import {
  createMatrixGoogleConnectionIpcHandler,
  createMatrixGoogleWriteIpcHandler,
  type MatrixGoogleConnectionBoundaryOwner,
  type MatrixGoogleFenceHost,
  matrixGoogleWriteDecider,
  publishMatrixGoogleFence,
  requestMatrixGoogleAccountConnect,
  requestMatrixGoogleAccountStatus,
  requestMatrixGoogleWriteDecision,
  sameMatrixGoogleConnectionOwner
} from './google-connection-boundary'

const ACCOUNT_A = 'a'.repeat(64)
const ACCOUNT_B = 'b'.repeat(64)

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })

  return { promise, resolve }
}

function bridge(): MatrixGoogleConnectionBridge & {
  status: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  setSourcePreferences: ReturnType<typeof vi.fn>
} {
  const result: MatrixGoogleConnectionResult = { status: { sources: [], available: true } }

  return {
    status: vi.fn(async () => result),
    connect: vi.fn(async () => result),
    disconnect: vi.fn(async () => result),
    setSourcePreferences: vi.fn(async () => result)
  }
}

function owner(host: MatrixGoogleFenceHost = { queue: { command: vi.fn(async () => ({ v: 1, since: 7 })) } }): MatrixGoogleConnectionBoundaryOwner {
  return {
    accountKey: ACCOUNT_A,
    generation: 1,
    userId: '@person:matrix.test',
    deviceId: 'DEVICE',
    host
  }
}

describe('Matrix Google connection IPC boundary', () => {
  it('checks the sender before reading an input or resolving the bridge', () => {
    const connections = bridge()
    const assertSender = vi.fn(() => { throw new Error('matrix_ipc_denied') })
    const resolveConnections = vi.fn(() => connections)
    const handler = createMatrixGoogleConnectionIpcHandler({ assertSender, connections: resolveConnections })

    const input = new Proxy({ kind: 'status' }, {
      ownKeys: () => {
        throw new Error('input was read')
      },
      get: () => {
        throw new Error('input was read')
      }
    })

    expect(() => handler({ sender: 'foreign' }, input)).toThrow('matrix_ipc_denied')
    expect(resolveConnections).not.toHaveBeenCalled()
    expect(connections.status).not.toHaveBeenCalled()
  })

  it('dispatches only the fixed request union', async () => {
    const connections = bridge()
    const assertSender = vi.fn()
    const handler = createMatrixGoogleConnectionIpcHandler({ assertSender, connections: () => connections })

    await expect(handler({ sender: 'ui' }, { kind: 'status' })).resolves.toEqual({ status: { sources: [], available: true } })
    await handler({ sender: 'ui' }, { kind: 'connect', grant: 'google' })
    await handler({ sender: 'ui' }, { kind: 'connect', grant: 'email-calendar' })
    await handler({ sender: 'ui' }, { kind: 'connect', grant: 'drive' })
    await handler({ sender: 'ui' }, { kind: 'disconnect', groupId: 'source-a' })
    await handler({ sender: 'ui' }, { kind: 'preferences', preferences: [{ id: 'source-a', enabled: true }] })

    expect(assertSender).toHaveBeenCalledTimes(6)

    // The one consent for Gmail, Calendar and Drive, and the earlier separate grants.
    expect(connections.connect).toHaveBeenNthCalledWith(1, 'google')
    expect(connections.connect).toHaveBeenNthCalledWith(2, 'email-calendar')
    expect(connections.connect).toHaveBeenNthCalledWith(3, 'drive')
    expect(connections.disconnect).toHaveBeenCalledWith('source-a')
    expect(connections.setSourcePreferences).toHaveBeenCalledWith([{ id: 'source-a', enabled: true }])
  })

  it('reports a first-run connection only after the provider confirms a connected source', async () => {
    const connections = bridge()
    const firstRunConnected = vi.fn()
    const handler = createMatrixGoogleConnectionIpcHandler({
      assertSender: vi.fn(),
      connections: () => connections,
      firstRunConnected
    })
    const context = { origin: 'first_run' as const, locale: 'vi' as const }

    await handler({}, { kind: 'connect', grant: 'google', context })
    expect(firstRunConnected).not.toHaveBeenCalled()

    connections.connect.mockResolvedValueOnce({
      status: {
        available: true,
        sources: [{ id: 'gmail', groupId: 'google', provider: 'google', kind: 'email', label: 'a@example.test', state: 'connected', enabled: true }]
      }
    })
    await handler({}, { kind: 'connect', grant: 'google', context })
    expect(firstRunConnected).toHaveBeenCalledExactlyOnceWith(context, expect.objectContaining({ available: true }))

    connections.status.mockResolvedValueOnce({ status: null, error: 'network' })
    await handler({}, { kind: 'status', context })
    expect(firstRunConnected).toHaveBeenCalledTimes(1)

    connections.status.mockResolvedValueOnce({
      status: {
        available: true,
        degraded: true,
        sources: [{ id: 'gmail', groupId: 'google', provider: 'google', kind: 'email', label: 'a@example.test', state: 'connected', enabled: true }]
      }
    })
    await handler({}, { kind: 'status', context })
    expect(firstRunConnected).toHaveBeenCalledTimes(1)
  })

  it.each([
    [null, 'unavailable'],
    [[], 'unavailable'],
    ['status', 'unavailable'],
    [{ kind: 'status', extra: true }, 'invalid_input'],
    [{ kind: 'status', context: { origin: 'first_run', locale: 'xx' } }, 'invalid_input'],
    [{ kind: 'status', context: { origin: 'settings', locale: 'vi' } }, 'invalid_input'],
    [{ kind: 'connect' }, 'invalid_input'],
    [{ kind: 'connect', grant: 'other' }, 'invalid_input'],
    [{ kind: 'connect', grant: 'drive', extra: true }, 'invalid_input'],
    [{ kind: 'disconnect', groupId: 'x'.repeat(129) }, 'invalid_input'],
    [{ kind: 'disconnect', groupId: 1 }, 'invalid_input'],
    [{ kind: 'preferences', preferences: [{ id: 'source-a', enabled: true, extra: true }] }, 'invalid_input'],
    [{ kind: 'preferences', preferences: [{ id: 'source-a', enabled: 'true' }] }, 'invalid_input'],
    [{ kind: 'preferences', preferences: Array.from({ length: 257 }, () => ({ id: 'source-a', enabled: true })) }, 'invalid_input']
  ])('rejects malformed or extended request %j without dispatch', async (input, error) => {
    const connections = bridge()
    const handler = createMatrixGoogleConnectionIpcHandler({ assertSender: vi.fn(), connections: () => connections })

    expect(await handler({}, input)).toEqual({ status: null, error })
    expect(connections.status).not.toHaveBeenCalled()
    expect(connections.connect).not.toHaveBeenCalled()
    expect(connections.disconnect).not.toHaveBeenCalled()
    expect(connections.setSourcePreferences).not.toHaveBeenCalled()
  })

  it('closes unavailable before input dispatch', async () => {
    const handler = createMatrixGoogleConnectionIpcHandler({ assertSender: vi.fn(), connections: () => undefined })

    expect(await handler({}, { kind: 'status' })).toEqual({ status: null, error: 'unavailable' })
    expect(await handler({}, { kind: 'unknown' })).toEqual({ status: null, error: 'unavailable' })
  })
})

describe('Matrix Google fence publisher', () => {
  it('compares every captured owner field, including the exact host', () => {
    const captured = owner()

    expect(sameMatrixGoogleConnectionOwner(captured, captured)).toBe(true)

    for (const field of ['accountKey', 'generation', 'userId', 'deviceId', 'host'] as const) {
      const current = { ...captured }

      if (field === 'accountKey') { current.accountKey = ACCOUNT_B }

      if (field === 'generation') { current.generation = 2 }

      if (field === 'userId') { current.userId = '@other:matrix.test' }

      if (field === 'deviceId') { current.deviceId = 'OTHER' }

      if (field === 'host') { current.host = {} }
      expect(sameMatrixGoogleConnectionOwner(captured, current)).toBe(false)
    }
  })

  it('publishes only the captured identity through its exact host queue', async () => {
    const command = vi.fn(async () => ({ v: 1, since: 7 }))
    const captured = owner({ queue: { command } })

    await expect(publishMatrixGoogleFence(captured, () => captured)).resolves.toEqual({ v: 1, since: 7 })
    expect(command).toHaveBeenCalledExactlyOnceWith({
      kind: 'publishGoogleFence',
      identity: { userId: '@person:matrix.test', deviceId: 'DEVICE' }
    }, 30_000)
  })

  it.each([
    null,
    {},
    { v: 2, since: 7 },
    { v: 1, since: -1 },
    { v: 1, since: 7, extra: true },
    { v: 1, since: '7' }
  ])('fails closed for an invalid SDK fence receipt %j', async raw => {
    const captured = owner({ queue: { command: vi.fn(async () => raw) } })

    await expect(publishMatrixGoogleFence(captured, () => captured)).rejects.toThrow('matrix_google_fence_unavailable')
  })

  it.each(['accountKey', 'generation', 'userId', 'deviceId', 'host'] as const)(
    'rejects a %s handoff after the SDK queue is pending',
    async field => {
      const pending = deferred<unknown>()
      const captured = owner({ queue: { command: vi.fn(() => pending.promise) } })
      let current: MatrixGoogleConnectionBoundaryOwner | null = captured
      const publication = publishMatrixGoogleFence(captured, () => current)
      const next = { ...captured }

      if (field === 'accountKey') { next.accountKey = ACCOUNT_B }

      if (field === 'generation') { next.generation = 2 }

      if (field === 'userId') { next.userId = '@other:matrix.test' }

      if (field === 'deviceId') { next.deviceId = 'OTHER' }

      if (field === 'host') { next.host = { queue: { command: vi.fn(async () => ({ v: 1, since: 8 })) } } }
      current = next
      pending.resolve({ v: 1, since: 7 })

      await expect(publication).rejects.toThrow('matrix_google_fence_stale')
    }
  )
})

describe('Google account status transport', () => {
  afterEach(() => vi.unstubAllGlobals())
  it.each(['ready', 'disconnected', 'attention'] as const)('projects remote %s without vault sources', async state => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      profile: 'atum.google-connection/1', revision: 2, state, scopes: []
    }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(requestMatrixGoogleAccountStatus('https://api.test', 'test-bearer', AbortSignal.timeout(1000)))
      .resolves.toEqual({ status: { accountState: state, available: true, sources: [] } })
    expect(fetch.mock.calls[0][0]).toBe('https://api.test/google/status')
  })
  it('carries the pinned Google account and a mismatch refusal, only while connected, and drops malformed values', async () => {
    const read = async (body: Record<string, unknown>) => {
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
        profile: 'atum.google-connection/1', revision: 2, scopes: [], ...body
      }), { headers: { 'content-type': 'application/json' } })))

      return requestMatrixGoogleAccountStatus('https://api.test', 'test-bearer', AbortSignal.timeout(1000))
    }

    await expect(read({ state: 'ready', googleEmail: 'hello@example.com', refusal: 'google_account_mismatch' }))
      .resolves.toEqual({ status: { accountState: 'ready', available: true, sources: [],
        accountEmail: 'hello@example.com', accountNotice: 'google_account_mismatch' } })
    await expect(read({ state: 'attention', googleEmail: 'hello@example.com' }))
      .resolves.toEqual({ status: { accountState: 'attention', available: true, sources: [], accountEmail: 'hello@example.com' } })
    await expect(read({ state: 'ready' }))
      .resolves.toEqual({ status: { accountState: 'ready', available: true, sources: [] } })
    await expect(read({ state: 'ready', googleEmail: 'not an email', refusal: 'other' }))
      .resolves.toEqual({ status: { accountState: 'ready', available: true, sources: [] } })
    await expect(read({ state: 'disconnected', googleEmail: 'hello@example.com', refusal: 'google_account_mismatch' }))
      .resolves.toEqual({ status: { accountState: 'disconnected', available: true, sources: [] } })
  })
  it.each([401, 503, 200])('never turns an unreadable status into disconnected (%s)', async code => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: code, headers: { 'content-type': 'application/json' } })))
    const result = requestMatrixGoogleAccountStatus('https://api.test', 'test-bearer', AbortSignal.timeout(1000))
    if (code === 401) {await expect(result).rejects.toThrow('matrix_s1_authentication')}
    else {await expect(result).resolves.toEqual({ status: null, error: 'network' })}
  })
})

describe('account Google OAuth handoff', () => {
  afterEach(() => vi.unstubAllGlobals())
  it.each(['https://accounts.google.com/o/oauth2/v2/auth?state=test', 'https://untrusted.test/oauth'])('only accepts Google authorization URLs: %s', async authorizeUrl => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      profile: 'atum.google-connection/1', state: 'authorization_required', authorizeUrl
    }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const result = requestMatrixGoogleAccountConnect('https://api.test', 'test-bearer', AbortSignal.timeout(1000))
    if (authorizeUrl.startsWith('https://accounts.google.com/')) {
      await expect(result).resolves.toBe(authorizeUrl)
    } else {
      await expect(result).rejects.toThrow('matrix_google_unavailable')
    }
    expect(fetch.mock.calls[0][0]).toBe('https://api.test/google/connect')
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toMatchObject({ returnTo: 'desktop' })
  })
})

describe('Google write decision transport', () => {
  afterEach(() => vi.unstubAllGlobals())

  const GOOGLE_WRITE_IDS = { first: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', second: '7a2d3b4c-5e6f-4a71-9b8c-ad1e2f3a4b5c' }

  const digest = `sha256:${'c'.repeat(64)}`
  const approve: MatrixGoogleWriteDecisionInput = { proposalId: GOOGLE_WRITE_IDS.first, digest, decision: 'approve' }
  const decline: MatrixGoogleWriteDecisionInput = { ...approve, decision: 'decline' }
  const profile = 'atum.google-write-confirmation/1'

  const answering = (status: number, body: unknown, type = 'application/json') => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } }))
    vi.stubGlobal('fetch', fetch)

    return fetch
  }

  it('posts only the decision and the rendered digest, with the owner bearer, contract and a fixed idempotency key', async () => {
    const fetch = answering(200, { profile, proposalId: approve.proposalId, state: 'done' })

    await expect(requestMatrixGoogleWriteDecision('https://api.test', 'owner-bearer', approve, AbortSignal.timeout(1000)))
      .resolves.toBe('done')

    const [url, init] = fetch.mock.calls[0]!
    const headers = new Headers(init?.headers)

    expect(url).toBe(`https://api.test/google/proposals/${approve.proposalId}/decision`)
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('error')
    expect(headers.get('authorization')).toBe('Bearer owner-bearer')
    expect(headers.get('x-atum-google-write-contract')).toBe(profile)
    expect(headers.get('idempotency-key')).toBe(`${approve.proposalId}:approve`)
    expect(JSON.parse(init?.body as string)).toEqual({ decision: 'approve', digest })
  })

  it.each([
    ['approve', 202, { state: 'approved' }, 'approved'],
    ['decline', 200, { state: 'declined' }, 'declined'],
    ['approve', 409, { error: 'digest_mismatch' }, 'changed'],
    ['approve', 409, { error: 'superseded' }, 'superseded'],
    ['approve', 409, { error: 'already_decided' }, 'answered'],
    ['approve', 410, { error: 'expired' }, 'expired'],
    ['decline', 404, { error: 'not_found' }, 'expired'],
    ['approve', 422, { error: 'write_failed' }, 'failed'],
    ['decline', 422, { error: 'write_failed' }, 'retry'],
    ['decline', 200, { state: 'done' }, 'retry'],
    ['approve', 200, { state: 'declined' }, 'retry'],
    ['approve', 200, { state: 'approved' }, 'retry'],
    ['approve', 202, { state: 'done' }, 'retry'],
    ['approve', 200, { state: 'done', receipt: 'r' }, 'retry'],
    ['approve', 409, { error: 'conflict' }, 'retry'],
    ['approve', 403, { error: 'owner_required' }, 'retry'],
    ['approve', 503, { error: 'unavailable' }, 'retry']
  ] as const)('maps %s answered %s %j to %s', async (decision, status, body, expected) => {
    answering(status, { profile, proposalId: approve.proposalId, ...body })

    await expect(requestMatrixGoogleWriteDecision('https://api.test', 'owner-bearer', decision === 'approve' ? approve : decline,
      AbortSignal.timeout(1000))).resolves.toBe(expected)
  })

  it.each([
    ['another proposal', { profile, proposalId: GOOGLE_WRITE_IDS.second, state: 'done' }, 'application/json'],
    ['another profile', { profile: 'atum.google-connection/1', proposalId: GOOGLE_WRITE_IDS.first, state: 'done' }, 'application/json'],
    ['a page', '<html>done</html>', 'text/html'],
    ['broken JSON', '{"state":', 'application/json']
  ])('never reads an answer for %s as approved', async (_name, body, type) => {
    answering(200, body, type)

    await expect(requestMatrixGoogleWriteDecision('https://api.test', 'owner-bearer', approve, AbortSignal.timeout(1000)))
      .resolves.toBe('retry')
  })

  it('asks the account to refresh its bearer on 401', async () => {
    answering(401, { error: 'unauthorized' })

    await expect(requestMatrixGoogleWriteDecision('https://api.test', 'owner-bearer', approve, AbortSignal.timeout(1000)))
      .rejects.toThrow('matrix_s1_authentication')
  })

  it('goes through the owner seam: one refresh after a 401 resends the same decision under the same key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ profile, proposalId: approve.proposalId, state: 'done' }),
        { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const scope = { accountKey: ACCOUNT_A, generation: 1 }
    const options: unknown[] = []
    const account = {
      appScope: () => scope,
      // MatrixAccount.s1Request's contract: the native bearer, the domain base, one refresh after a 401.
      async s1Request<T>(send: (token: string, resource: string, signal: AbortSignal) => Promise<T>, signal: AbortSignal,
        option?: { timeoutMs?: number }): Promise<T> {
        options.push(option)

        try {
          return await send('owner-bearer-1', 'https://api.test', signal)
        } catch (error) {
          if ((error as Error).message !== 'matrix_s1_authentication') { throw error }

          return send('owner-bearer-2', 'https://api.test', signal)
        }
      }
    }

    await expect(matrixGoogleWriteDecider(account)(approve)).resolves.toBe('done')

    expect(options).toEqual([{ timeoutMs: 120_000 }])
    const sent = fetch.mock.calls.map(([, init]) => new Headers(init?.headers))
    expect(sent.map(headers => headers.get('authorization'))).toEqual(['Bearer owner-bearer-1', 'Bearer owner-bearer-2'])
    expect(sent.map(headers => headers.get('idempotency-key'))).toEqual([`${approve.proposalId}:approve`, `${approve.proposalId}:approve`])
  })

  it('answers retry when the request fails or the account changed while it ran', async () => {
    let scope = { accountKey: ACCOUNT_A, generation: 1 }
    const failing = { appScope: () => scope, s1Request: async () => { throw new Error('matrix_s1_cancelled') } }

    await expect(matrixGoogleWriteDecider(failing)(approve)).resolves.toBe('retry')

    const switching = {
      appScope: () => scope,
      async s1Request<T>(): Promise<T> {
        scope = { accountKey: ACCOUNT_B, generation: 1 }

        return 'done' as T
      }
    }

    await expect(matrixGoogleWriteDecider(switching)(approve)).resolves.toBe('retry')
  })

  it('checks the window before reading its input, and passes on only a closed decision', async () => {
    const decide = vi.fn(async () => 'declined' as const)
    const denied = createMatrixGoogleWriteIpcHandler({
      assertSender: () => { throw new Error('matrix_ipc_denied') },
      decide: () => decide
    })
    const input = new Proxy({}, { get: () => { throw new Error('input was read') }, ownKeys: () => { throw new Error('input was read') } })

    await expect(denied({ sender: 'foreign' }, input)).rejects.toThrow('matrix_ipc_denied')

    const handler = createMatrixGoogleWriteIpcHandler({ assertSender: () => {}, decide: () => decide })

    await expect(handler({}, { ...decline, draft: { to: ['privacy@example.org'] } })).resolves.toBe('retry')
    await expect(handler({}, { ...decline, decision: 'send' })).resolves.toBe('retry')
    expect(decide).not.toHaveBeenCalled()
    await expect(handler({}, decline)).resolves.toBe('declined')
    expect(decide).toHaveBeenCalledWith(decline)

    const signedOut = createMatrixGoogleWriteIpcHandler({ assertSender: () => {}, decide: () => undefined })

    await expect(signedOut({}, approve)).resolves.toBe('retry')
  })
})
