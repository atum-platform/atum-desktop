import { describe, expect, it, vi } from 'vitest'

import { PlacementConnectionPlatform } from './connection-platform'
import { AGENT_HOME_V25_PROFILE, AGENT_HOME_V25_WIRE_HEADER, AGENT_HOME_V25_WIRE_VERSION } from './contract-v25'
import { serveFetch } from './http-fetch.fixture'
import { readPackV25Json } from './pack-v25.fixture'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const DEVICE = '00000000-0000-4000-8000-b454f82c5857'
const MOVE = '00000000-0000-4000-8000-f6222a1106ee'

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers }
  })
}

function client(reply: () => Response, options: { verifyController?: (message: string, value: unknown) => boolean } = {}) {
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => reply())
  const platform = new PlacementConnectionPlatform({
    request: async send => send('mas-token', 'https://platform.test'),
    fetch: fetch as typeof globalThis.fetch,
    ...options
  })

  return { platform, fetch }
}

describe('the 2.5 placement and connection client', () => {
  it('sends the 2.5 wire and accepts only a current negotiated owner profile', async () => {
    let reply = readPackV25Json('fixtures/owner.placement.snapshot.v25.json')
    const { platform, fetch } = client(() => jsonResponse(reply))

    const accepted = await platform.readOwner(AGENT, AbortSignal.timeout(1_000))
    expect(accepted).toMatchObject({ ok: true, value: { profile: AGENT_HOME_V25_PROFILE } })
    const headers = new Headers(fetch.mock.calls[0]![1]?.headers)
    expect(headers.get(AGENT_HOME_V25_WIRE_HEADER)).toBe(AGENT_HOME_V25_WIRE_VERSION)
    expect(headers.get('authorization')).toBe('Bearer mas-token')

    reply = readPackV25Json('fixtures/owner.placement.snapshot.json')
    await expect(platform.readOwner(AGENT, AbortSignal.timeout(1_000))).resolves.toEqual({
      ok: false,
      kind: 'invalid',
      status: 200
    })
  })

  it('rejects carried 2.4 profiles from every profiled response after negotiating 2.5', async () => {
    let reply: Record<string, unknown> = {}
    const { platform } = client(() => jsonResponse(reply))
    const signal = AbortSignal.timeout(1_000)
    const cases = [
      {
        body: readPackV25Json<Record<string, unknown>>('fixtures/owner.move.progress.finishing.json'),
        call: () => platform.readProgress(AGENT, MOVE, signal)
      },
      {
        body: readPackV25Json<Record<string, unknown>>('fixtures/mac.connection-catalog.fresh.json'),
        call: () => platform.readCatalog(AGENT, DEVICE, signal)
      },
      {
        body: readPackV25Json<Record<string, unknown>>('fixtures/model-choice.projection.pending-turn.json'),
        call: () => platform.readModelApplication(AGENT, signal)
      }
    ]

    for (const row of cases) {
      reply = row.body
      await expect(row.call()).resolves.toMatchObject({ ok: false, kind: 'invalid', status: 200 })

      reply = { ...row.body, profile: AGENT_HOME_V25_PROFILE }
      await expect(row.call()).resolves.toMatchObject({ ok: true, value: { profile: AGENT_HOME_V25_PROFILE } })
    }
  })

  it('refuses a malformed identifier before anything is sent', async () => {
    const { platform, fetch } = client(() => jsonResponse({}))
    const signal = AbortSignal.timeout(1_000)

    await expect(platform.readProgress(AGENT, 'not-a-uuid', signal)).resolves.toMatchObject({ ok: false, kind: 'invalid', status: 0 })
    await expect(platform.readCatalog(AGENT, '../../x', signal)).resolves.toMatchObject({ ok: false, kind: 'invalid', status: 0 })
    await expect(platform.readOwner('nope', signal)).resolves.toMatchObject({ ok: false, kind: 'invalid', status: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('a refusal keeps its reason', () => {
  const signal = () => AbortSignal.timeout(1_000)

  const moveRefusals = [
    'another_move_in_progress',
    'catalog_stale',
    'cloud_controller_version_unsupported',
    'committed_epoch_preserved',
    'feature_losses_changed',
    'idempotency_conflict',
    'not_eligible',
    'preflight_expired',
    'preflight_required',
    'stale',
    'surface_mismatch'
  ] as const

  it.each(moveRefusals)('a 409 move refusal names %s', async reason => {
    const body = readPackV25Json(`fixtures/owner.move.refusal.${reason}.json`)
    const { platform } = client(() => jsonResponse(body, { status: 409 }))
    const request = readPackV25Json<never>('fixtures/owner.move.request.desktop-back-to-cloud.json')
    const cancel = readPackV25Json<never>('fixtures/owner.move.cancel.json')

    await expect(platform.requestMove(AGENT, request, signal())).resolves.toEqual({
      ok: false,
      kind: 'conflict',
      status: 409,
      reason
    })
    await expect(platform.cancelMove(AGENT, cancel, signal())).resolves.toMatchObject({ ok: false, kind: 'conflict', reason })
  })

  it.each([
    'active_move_changed',
    'catalog_stale',
    'connection_unavailable',
    'destination_not_current',
    'idempotency_conflict',
    'model_unavailable',
    'stale_choice_revision',
    'stale_home',
    'surface_mismatch'
  ] as const)('a 409 model refusal names %s', async reason => {
    const body = readPackV25Json(`fixtures/owner.model-choice.refusal.${reason}.json`)
    const { platform } = client(() => jsonResponse(body, { status: 409 }))
    const write = readPackV25Json<never>('fixtures/owner.model-choice.write.mac.json')

    await expect(platform.writeModelChoice(AGENT, write, signal())).resolves.toEqual({
      ok: false,
      kind: 'conflict',
      status: 409,
      reason
    })
  })

  it.each(['active_move_changed', 'idempotency_conflict', 'stale_catalog_revision', 'stale_home'] as const)(
    'a 409 catalog receipt names %s',
    async reason => {
      const body = readPackV25Json(`fixtures/mac.connection-catalog.receipt.refused.${reason}.json`)
      const { platform } = client(() => jsonResponse(body, { status: 409 }))
      const ingest = readPackV25Json<never>('fixtures/mac.connection-catalog.ingest.json')

      await expect(platform.publishCatalog(AGENT, ingest, signal())).resolves.toEqual({
        ok: false,
        kind: 'conflict',
        status: 409,
        reason
      })
    }
  )

  it('reads the closed reason from the Matrix error envelope too', async () => {
    const { platform } = client(() =>
      jsonResponse({ error: 'matrix_409', details: { reason: 'stale_choice_revision' } }, { status: 409 })
    )
    const report = readPackV25Json<never>('fixtures/model-choice.application.report.json')

    await expect(platform.reportModelApplication(AGENT, report, signal())).resolves.toEqual({
      ok: false,
      kind: 'conflict',
      status: 409,
      reason: 'stale_choice_revision'
    })
  })

  it('does not trust a refusal whose controller signature does not verify', async () => {
    const body = readPackV25Json('fixtures/owner.move.refusal.committed_epoch_preserved.json')
    const verify = vi.fn(() => false)
    const { platform } = client(() => jsonResponse(body, { status: 409 }), { verifyController: verify })
    const cancel = readPackV25Json<never>('fixtures/owner.move.cancel.json')

    const result = await platform.cancelMove(AGENT, cancel, signal())

    expect(verify).toHaveBeenCalledWith('owner.home.move.refusal', expect.anything())
    expect(result).toEqual({ ok: false, kind: 'conflict', status: 409 })
  })

  it('never takes an open reason word from a body', async () => {
    const { platform } = client(() =>
      jsonResponse({ error: 'matrix_409', details: { reason: 'Free text with spaces <script>' } }, { status: 409 })
    )

    await expect(platform.readOwner(AGENT, signal())).resolves.toEqual({ ok: false, kind: 'conflict', status: 409 })
  })

  it('keeps how long the platform asked to wait', async () => {
    const { platform } = client(() =>
      jsonResponse({ error: 'matrix_429' }, { status: 429, headers: { 'retry-after': '90' } })
    )

    await expect(platform.readOwner(AGENT, signal())).resolves.toEqual({
      ok: false,
      kind: 'unavailable',
      status: 429,
      retryAfterMs: 90_000
    })
  })

  it('answers a refusal that arrives with a success status as the same conflict', async () => {
    const body = readPackV25Json('fixtures/owner.move.refusal.stale.json')
    const { platform } = client(() => jsonResponse(body, { status: 200 }))
    const request = readPackV25Json<never>('fixtures/owner.move.request.desktop-back-to-cloud.json')

    await expect(platform.requestMove(AGENT, request, signal())).resolves.toEqual({
      ok: false,
      kind: 'conflict',
      status: 200,
      reason: 'stale'
    })
  })
})


it('recovers the real owner HTTP read after a blackholed request without treating timeout as unsupported', async () => {
  let blackhole = true
  const http = await serveFetch(async () => {
    if (blackhole) {return new Promise<Response>(() => {})}
    return jsonResponse(readPackV25Json('fixtures/owner.placement.snapshot.v25.json'))
  })
  const platform = new PlacementConnectionPlatform({ request: async send => send('test-token', http.origin) })
  try {
    const start = Date.now()
    expect(await platform.readOwner(AGENT, AbortSignal.timeout(100))).toMatchObject({ ok: false, kind: 'unavailable', status: 0 })
    const failedAfter = Date.now() - start
    blackhole = false
    const resumed = Date.now()
    expect(await platform.readOwner(AGENT, AbortSignal.timeout(1000))).toMatchObject({ ok: true })
    expect(Date.now() - resumed).toBeLessThan(1000)
    expect(failedAfter).toBeLessThan(1000)
  } finally {await http.close()}
})
