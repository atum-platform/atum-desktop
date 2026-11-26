import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixGoogleConnectionBridge, MatrixGoogleConnectionResult } from '../../shared/matrix-google-connections'
import type { MatrixGoogleWriteActionInput } from '../../shared/matrix-google-write-proposal'
import {
  GOOGLE_WORK_DRAFTS,
  GOOGLE_WORK_OWNER,
  GOOGLE_WRITE_IDS,
  googleWorkEntry,
  googleWriteEmail,
  googleWriteEntry
} from '../../shared/matrix-google-write-proposal.test-support'

import {
  createMatrixGoogleConnectionIpcHandler,
  createMatrixGoogleWriteIpcHandler,
  type MatrixGoogleConnectionBoundaryOwner,
  type MatrixGoogleFenceHost,
  matrixGoogleWriteProposals,
  publishMatrixGoogleFence,
  requestMatrixGoogleAccountConnect,
  requestMatrixGoogleAccountStatus,
  requestMatrixGoogleWriteAction,
  requestMatrixGoogleWriteProposals,
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

describe('Google write proposal transport', () => {
  afterEach(() => vi.unstubAllGlobals())

  const BASE = 'https://api.test'
  const PATH = `${BASE}/api/connections/google/proposals`
  const digest = 'c'.repeat(64)
  const approve: MatrixGoogleWriteActionInput = { proposalId: GOOGLE_WRITE_IDS.first, digest, action: 'approve' }

  const answering = (status: number, body: unknown, type = 'application/json') => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } }))

    vi.stubGlobal('fetch', fetch)

    return fetch
  }

  const sent = (fetch: ReturnType<typeof answering>, call = 0) => {
    const [url, init] = fetch.mock.calls[call]!

    return { url: String(url), init, headers: new Headers(init?.headers) }
  }

  it('lists the pending proposals with the owner bearer and the host bridge contract, dropping malformed entries', async () => {
    const good = await googleWriteEntry()
    const fetch = answering(200, { proposals: [good, { ...good, proposalId: GOOGLE_WRITE_IDS.second, status: 'confirmed' }] })

    await expect(requestMatrixGoogleWriteProposals(BASE, 'owner-bearer', AbortSignal.timeout(1000))).resolves.toEqual({
      state: 'ok',
      proposals: [{ proposalId: good.proposalId, agent: good.agent, room: good.room, digest: good.digest, draft: googleWriteEmail() }],
      work: []
    })

    const request = sent(fetch)

    expect(request.url).toBe(PATH)
    expect(request.init?.method ?? 'GET').toBe('GET')
    expect(request.init?.redirect).toBe('error')
    expect(request.init?.credentials).toBe('omit')
    expect(request.headers.get('authorization')).toBe('Bearer owner-bearer')
    expect(request.headers.get('x-atum-host-bridge-contract')).toBe('atum.s2.host-bridge/1.0.0')
  })

  it.each(['delivered', 'approve', 'decline'] as const)('posts %s with exactly the rendered digest to its own path', async action => {
    const status = { delivered: 'delivered', approve: 'confirmed', decline: 'declined' }[action]
    const fetch = answering(200, { proposalId: approve.proposalId, digest, status })

    await expect(requestMatrixGoogleWriteAction(BASE, 'owner-bearer', { ...approve, action }, AbortSignal.timeout(1000)))
      .resolves.toEqual({ state: 'ok', status })

    const request = sent(fetch)

    expect(request.url).toBe(`${PATH}/${approve.proposalId}/${action}`)
    expect(request.init?.method).toBe('POST')
    expect(request.headers.get('authorization')).toBe('Bearer owner-bearer')
    expect(request.headers.get('x-atum-host-bridge-contract')).toBe('atum.s2.host-bridge/1.0.0')
    expect(JSON.parse(request.init?.body as string)).toEqual({ digest })
  })

  it.each([
    [400, { state: 'refused' }, 'refused'],
    [403, { state: 'refused' }, 'refused'],
    [409, { state: 'refused' }, 'refused'],
    [503, { state: 'unavailable' }, 'unavailable'],
    [500, 'oops', 'unavailable'],
    [200, { proposalId: GOOGLE_WRITE_IDS.second, digest, status: 'confirmed' }, 'unavailable'],
    [200, { proposalId: GOOGLE_WRITE_IDS.first, digest: 'd'.repeat(64), status: 'confirmed' }, 'unavailable'],
    [200, { proposalId: GOOGLE_WRITE_IDS.first, digest, status: 'declined' }, 'unavailable'],
    [200, { proposalId: GOOGLE_WRITE_IDS.first, digest, status: 'sent' }, 'unavailable'],
    [200, { proposalId: GOOGLE_WRITE_IDS.first, digest, status: 'confirmed', receipt: 'r' }, 'unavailable'],
    [200, '{"status":', 'unavailable']
  ] as const)('maps an approval answered %s %j to %s, never to confirmed', async (status, body, expected) => {
    answering(status, body)

    await expect(requestMatrixGoogleWriteAction(BASE, 'owner-bearer', approve, AbortSignal.timeout(1000)))
      .resolves.toEqual({ state: expected })
  })

  it('maps a list refusal and an unreadable list to their states', async () => {
    answering(409, { state: 'refused' })
    await expect(requestMatrixGoogleWriteProposals(BASE, 'owner-bearer', AbortSignal.timeout(1000))).resolves.toEqual({ state: 'refused' })
    answering(503, { state: 'unavailable' })
    await expect(requestMatrixGoogleWriteProposals(BASE, 'owner-bearer', AbortSignal.timeout(1000))).resolves.toEqual({ state: 'unavailable' })
    answering(200, { proposals: 'none' })
    await expect(requestMatrixGoogleWriteProposals(BASE, 'owner-bearer', AbortSignal.timeout(1000))).resolves.toEqual({ state: 'unavailable' })
    answering(200, '<html></html>', 'text/html')
    await expect(requestMatrixGoogleWriteProposals(BASE, 'owner-bearer', AbortSignal.timeout(1000))).resolves.toEqual({ state: 'unavailable' })
  })

  it('asks the account to refresh its bearer on 401 and never talks to a plain-http domain', async () => {
    answering(401, { state: 'refused' })
    await expect(requestMatrixGoogleWriteAction(BASE, 'owner-bearer', approve, AbortSignal.timeout(1000)))
      .rejects.toThrow('matrix_s1_authentication')

    const fetch = answering(200, { proposals: [] })
    await expect(requestMatrixGoogleWriteProposals('http://api.test', 'owner-bearer', AbortSignal.timeout(1000))).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  function ownerAccount(answers: Response[]) {
    const fetch = vi.fn<typeof globalThis.fetch>()

    for (const answer of answers) {
      fetch.mockResolvedValueOnce(answer)
    }

    vi.stubGlobal('fetch', fetch)
    const scope = { accountKey: ACCOUNT_A, generation: 1 }

    const account = {
      appScope: () => scope,
      // MatrixAccount.s1Request's contract: the native bearer, the domain base, one refresh after a 401.
      async s1Request<T>(send: (token: string, resource: string, signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
        try {
          return await send('owner-bearer-1', BASE, signal)
        } catch (error) {
          if ((error as Error).message !== 'matrix_s1_authentication') { throw error }

          return send('owner-bearer-2', BASE, signal)
        }
      }
    }

    return { fetch, account }
  }

  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('goes through the owner seam: one refresh after a 401, then refused if Shell still refuses the owner', async () => {
    const refreshed = ownerAccount([reply(401, { state: 'refused' }), reply(200, { proposalId: approve.proposalId, digest, status: 'confirmed' })])

    await expect(matrixGoogleWriteProposals(refreshed.account).act(approve)).resolves.toEqual({ state: 'ok', status: 'confirmed' })
    expect(refreshed.fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')))
      .toEqual(['Bearer owner-bearer-1', 'Bearer owner-bearer-2'])

    const refused = ownerAccount([reply(401, { state: 'refused' }), reply(401, { state: 'refused' })])

    await expect(matrixGoogleWriteProposals(refused.account).list()).resolves.toEqual({ state: 'refused' })
  })

  it('answers unavailable when the request fails or the account changed while it ran', async () => {
    let scope = { accountKey: ACCOUNT_A, generation: 1 }
    const failing = { appScope: () => scope, s1Request: async () => { throw new Error('matrix_s1_cancelled') } }

    await expect(matrixGoogleWriteProposals(failing).act(approve)).resolves.toEqual({ state: 'unavailable' })

    const switching = {
      appScope: () => scope,
      async s1Request<T>(): Promise<T> {
        scope = { accountKey: ACCOUNT_B, generation: 1 }

        return { state: 'ok', status: 'confirmed' } as T
      }
    }

    await expect(matrixGoogleWriteProposals(switching).act(approve)).resolves.toEqual({ state: 'unavailable' })
  })

  it('keeps Work entries apart from agent cards, so a Work request never lands in an agent chat', async () => {
    const agent = await googleWriteEntry()
    const work = await googleWorkEntry(GOOGLE_WORK_DRAFTS.mailbox)

    answering(200, { proposals: [agent, work] })

    await expect(requestMatrixGoogleWriteProposals(BASE, 'owner-bearer', AbortSignal.timeout(1000))).resolves.toEqual({
      state: 'ok',
      proposals: [{ proposalId: agent.proposalId, agent: agent.agent, room: agent.room, digest: agent.digest, draft: googleWriteEmail() }],
      work: [{ proposalId: work.proposalId, digest: work.digest, draft: GOOGLE_WORK_DRAFTS.mailbox }]
    })
  })

  it('names the account the list was read for, and names none when the account changed while it ran', async () => {
    const work = await googleWorkEntry()
    const named = ownerAccount([reply(200, { proposals: [work] })])

    await expect(matrixGoogleWriteProposals(named.account, () => GOOGLE_WORK_OWNER).list()).resolves.toMatchObject({
      state: 'ok',
      owner: GOOGLE_WORK_OWNER,
      work: [{ proposalId: work.proposalId }]
    })

    let user: string | undefined = GOOGLE_WORK_OWNER
    const switching = ownerAccount([reply(200, { proposals: [work] })])

    const read = matrixGoogleWriteProposals(switching.account, () => {
      const now = user
      user = '@someone:example.org'

      return now
    }).list()

    const answer = await read

    expect(answer).not.toHaveProperty('owner')
  })

  it('checks the window before reading its input, and passes on only the list or one closed action', async () => {
    const bridge = {
      list: vi.fn(async () => ({ state: 'ok' as const, proposals: [] })),
      act: vi.fn(async () => ({ state: 'ok' as const, status: 'declined' as const }))
    }

    const denied = createMatrixGoogleWriteIpcHandler({
      assertSender: () => { throw new Error('matrix_ipc_denied') },
      proposals: () => bridge
    })

    const input = new Proxy({}, { get: () => { throw new Error('input was read') }, ownKeys: () => { throw new Error('input was read') } })

    await expect(denied({ sender: 'foreign' }, input)).rejects.toThrow('matrix_ipc_denied')

    const handler = createMatrixGoogleWriteIpcHandler({ assertSender: () => {}, proposals: () => bridge })
    const decline = { ...approve, action: 'decline' }

    await expect(handler({}, { kind: 'action', input: { ...decline, draft: { to: ['info@example.org'] } } })).resolves.toEqual({ state: 'unavailable' })
    await expect(handler({}, { kind: 'action', input: { ...decline, action: 'send' } })).resolves.toEqual({ state: 'unavailable' })
    await expect(handler({}, { kind: 'list', room: '!personal:example.org' })).resolves.toEqual({ state: 'unavailable' })
    expect(bridge.act).not.toHaveBeenCalled()
    expect(bridge.list).not.toHaveBeenCalled()
    await expect(handler({}, { kind: 'action', input: decline })).resolves.toEqual({ state: 'ok', status: 'declined' })
    expect(bridge.act).toHaveBeenCalledWith(decline)
    await expect(handler({}, { kind: 'list' })).resolves.toEqual({ state: 'ok', proposals: [] })

    const signedOut = createMatrixGoogleWriteIpcHandler({ assertSender: () => {}, proposals: () => undefined })

    await expect(signedOut({}, { kind: 'list' })).resolves.toEqual({ state: 'unavailable' })
  })
})
