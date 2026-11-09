import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MATRIX_PROVIDER_CONNECTIONS_PROFILE,
  MatrixProviderConnections,
  matrixSubscriptionsWithProviderConnections,
  parseMatrixOpenCodeGoKey,
  parseMatrixProviderConnectionsStatus,
  requestMatrixProviderConnections
} from './provider-connections'

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/device-protocol/fixtures/provider-connections/fixtures'
)

const fixture = (name: string): any => JSON.parse(readFileSync(join(fixtures, name), 'utf8'))
const STATUS = fixture('status-connected.response.json')
const CONNECT = fixture('connect.request.json')
const DISCONNECT = fixture('disconnect.request.json')

afterEach(() => vi.unstubAllGlobals())

describe('the provider-connections status reader', () => {
  it('reads the closed connected shape and its safe model descriptors', () => {
    const parsed = parseMatrixProviderConnectionsStatus(STATUS)

    expect(parsed).toMatchObject({
      revision: 1,
      connection: { state: 'connected', revision: 1, connectedAt: 1793148000000 }
    })
    expect(parsed!.connection.models).toHaveLength(13)
    expect(parsed!.connection.models[0]).toEqual({
      id: 'glm-5.2',
      displayName: 'GLM-5.2',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      contextBudget: 131072,
      outputBudget: 16384
    })
    expect(JSON.stringify(parsed)).not.toMatch(/secret|ciphertext|api_key|keyVersion/)
  })

  it('refuses a status carrying a credential-shaped field or an unknown key', () => {
    expect(parseMatrixProviderConnectionsStatus(fixture('status-secret.response.json'))).toBeUndefined()
    expect(parseMatrixProviderConnectionsStatus({ ...STATUS, profile: 'atum.provider-connections/2' })).toBeUndefined()
    expect(parseMatrixProviderConnectionsStatus({ ...STATUS, extra: true })).toBeUndefined()
    expect(parseMatrixProviderConnectionsStatus({
      ...STATUS,
      connections: [{ ...STATUS.connections[0], state: 'disconnected' }]
    })).toBeUndefined()
  })

  it('reads a disconnected row with no models offered', () => {
    const row = { provider: 'opencode_go', state: 'disconnected', revision: 2, models: [], modelPolicy: 'none' }

    expect(parseMatrixProviderConnectionsStatus({ profile: MATRIX_PROVIDER_CONNECTIONS_PROFILE, revision: 2, connections: [row] }))
      .toEqual({ revision: 2, connection: { state: 'disconnected', revision: 2, models: [] } })
  })
})

describe('the OpenCode Go key rule', () => {
  it('accepts a bounded key and refuses empty, control-character or oversized values', () => {
    expect(parseMatrixOpenCodeGoKey('sk-opencode-go-synthetic')).toBe('sk-opencode-go-synthetic')

    for (const value of ['', 'short', 'bad\nkey', 'x'.repeat(513)]) {
      expect(parseMatrixOpenCodeGoKey(value), value.length.toString()).toBeUndefined()
    }
  })
})

describe('the provider-connections client', () => {
  const scope = { accountKey: 'account', generation: 1 }

  function client(responses: Array<{ status: number; value: unknown }>) {
    const calls: Array<{ action: string; body?: unknown }> = []
    const changed = vi.fn()

    const subject = new MatrixProviderConnections({
      scope: () => scope,
      call: async (action, _signal, body) => {
        calls.push({ action, ...(body ? { body } : {}) })

        return responses.shift() ?? { status: 500, value: null }
      },
      changed
    })

    subject.activate(scope)

    return { subject, calls, changed }
  }

  it('connects with one write-only key and stores only the platform status', async () => {
    const { subject, calls, changed } = client([{ status: 200, value: STATUS }])
    const key = 'sk-opencode-go-synthetic'

    expect(await subject.connect(key)).toBe(true)
    expect(calls[0]).toMatchObject({
      action: 'connect',
      body: {
        profile: MATRIX_PROVIDER_CONNECTIONS_PROFILE,
        provider: 'opencode_go',
        credential: { kind: 'api_key', value: key }
      }
    })
    expect(calls[0]!.body).toHaveProperty('requestId')
    expect(JSON.stringify(subject.view())).not.toContain(key)
    expect(changed).toHaveBeenCalled()
  })

  it('refuses to keep a key the platform did not accept', async () => {
    const { subject } = client([{ status: 403, value: null }])

    expect(await subject.connect('sk-opencode-go-synthetic')).toBe(false)
    expect(subject.view()).toBeUndefined()
  })

  it('reads once, then reuses the fresh status', async () => {
    const { subject, calls } = client([{ status: 200, value: STATUS }])

    expect(await subject.refresh()).toBeDefined()
    expect(await subject.refresh()).toBeDefined()
    expect(calls).toHaveLength(1)
  })

  it('disconnects with the live revision and adopts the platform answer', async () => {
    const disconnected = {
      profile: MATRIX_PROVIDER_CONNECTIONS_PROFILE,
      revision: 2,
      connections: [{ provider: 'opencode_go', state: 'disconnected', revision: 2, models: [], modelPolicy: 'none' }]
    }

    const { subject, calls } = client([
      { status: 200, value: STATUS },
      { status: 200, value: disconnected }
    ])

    expect(await subject.disconnect()).toBe(true)
    expect(calls.map(call => call.action)).toEqual(['status', 'disconnect'])
    expect(calls[1]!.body).toMatchObject({
      profile: MATRIX_PROVIDER_CONNECTIONS_PROFILE,
      provider: 'opencode_go',
      expectedRevision: 1
    })
    expect(subject.view()?.connection.state).toBe('disconnected')
  })

  it('re-reads once on a revision conflict and fences the retry with the fresh revision', async () => {
    const disconnected = {
      profile: MATRIX_PROVIDER_CONNECTIONS_PROFILE,
      revision: 2,
      connections: [{ provider: 'opencode_go', state: 'disconnected', revision: 2, models: [], modelPolicy: 'none' }]
    }

    const { subject, calls } = client([
      { status: 200, value: STATUS },
      { status: 409, value: null },
      { status: 200, value: { ...STATUS, revision: 2, connections: [{ ...STATUS.connections[0], revision: 2 }] } },
      { status: 200, value: disconnected }
    ])

    expect(await subject.disconnect()).toBe(true)
    expect(calls.map(call => call.action)).toEqual(['status', 'disconnect', 'status', 'disconnect'])
    expect(calls[3]!.body).toMatchObject({ expectedRevision: 2 })
  })
})

describe('the fixed owner route', () => {
  it('sends the connect body once to the platform route and never a renderer URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(STATUS), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))

    vi.stubGlobal('fetch', fetchMock)

    const response = await requestMatrixProviderConnections(
      'https://platform.test/api/matrix/v1',
      'synthetic-token',
      'connect',
      AbortSignal.timeout(1000),
      CONNECT
    )

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://platform.test/api/matrix/v1/provider-connections/connect')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual(CONNECT)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-token')
    expect(init.redirect).toBe('error')
  })

  it('reads the status at the bare provider-connections route', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(STATUS), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))

    vi.stubGlobal('fetch', fetchMock)

    await requestMatrixProviderConnections(
      'https://platform.test/api/matrix/v1', 'synthetic-token', 'status', AbortSignal.timeout(1000))

    expect((fetchMock.mock.calls[0] as unknown as [string])[0])
      .toBe('https://platform.test/api/matrix/v1/provider-connections')
  })

  it('sends the disconnect body exactly', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(STATUS), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))

    vi.stubGlobal('fetch', fetchMock)

    await requestMatrixProviderConnections(
      'https://platform.test/api/matrix/v1', 'synthetic-token', 'disconnect', AbortSignal.timeout(1000), DISCONNECT)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://platform.test/api/matrix/v1/provider-connections/disconnect')
    expect(JSON.parse(String(init.body))).toEqual(DISCONNECT)
  })
})


describe('the account status Settings and the picker share', () => {
  const local = {
    scope: 'account' as const,
    providers: [
      { id: 'openai-codex' as const, connected: false },
      { id: 'opencode-go' as const, connected: true, models: ['kimi-k3'] }
    ]
  }

  it('makes the platform connection authoritative for OpenCode Go', () => {
    const merged = matrixSubscriptionsWithProviderConnections(local, parseMatrixProviderConnectionsStatus(STATUS))

    expect(merged.providers[0]).toEqual({ id: 'openai-codex', connected: false })
    expect(merged.providers[1]).toMatchObject({
      id: 'opencode-go',
      connected: true,
      source: 'platform',
      revision: 1
    })
    expect(merged.providers[1]!.models).toContain('glm-5.2')
    expect(merged.providers[1]!.modelDetails).toHaveLength(13)
  })

  it('reports a platform disconnect even when an older local key remains', () => {
    const disconnected = parseMatrixProviderConnectionsStatus({
      profile: MATRIX_PROVIDER_CONNECTIONS_PROFILE,
      revision: 2,
      connections: [{ provider: 'opencode_go', state: 'disconnected', revision: 2, models: [], modelPolicy: 'none' }]
    })

    const merged = matrixSubscriptionsWithProviderConnections(local, disconnected)

    expect(merged.providers[1]).toEqual({
      id: 'opencode-go',
      connected: false,
      source: 'platform',
      revision: 2
    })
  })

  it('falls back to the pre-R1 local key only when the platform route was not read', () => {
    expect(matrixSubscriptionsWithProviderConnections(local, undefined).providers[1]).toEqual({
      id: 'opencode-go',
      connected: true,
      models: ['kimi-k3'],
      source: 'local'
    })
  })
})
