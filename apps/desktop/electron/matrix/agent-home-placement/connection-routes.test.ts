import { describe, expect, it, vi } from 'vitest'

import { PlacementConnectionPlatform } from './connection-platform'
import { PLACEMENT_CONNECTION_ROUTE_TABLE, placementRoute, type PlacementRouteId } from './connection-routes'
import { AGENT_HOME_V25_PROFILE } from './contract-v25'
import { readPackV25Json } from './pack-v25.fixture'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const DEVICE = '00000000-0000-4000-8000-b454f82c5857'
const MOVE = '00000000-0000-4000-8000-f6222a1106ee'

/** Every client method, called once with a valid argument list: `id` is the table row it must use. */
const CALLS: Record<PlacementRouteId, (platform: PlacementConnectionPlatform, signal: AbortSignal) => Promise<unknown>> = {
  readOwner: (platform, signal) => platform.readOwner(AGENT, signal),
  preflight: (platform, signal) =>
    platform.preflight(AGENT, readPackV25Json<never>('fixtures/owner.move.preflight-request.json'), signal),
  requestMove: (platform, signal) =>
    platform.requestMove(AGENT, readPackV25Json<never>('fixtures/owner.move.request.desktop-back-to-cloud.json'), signal),
  cancelMove: (platform, signal) =>
    platform.cancelMove(AGENT, readPackV25Json<never>('fixtures/owner.move.cancel.json'), signal),
  readProgress: (platform, signal) => platform.readProgress(AGENT, MOVE, signal),
  writeModelChoice: (platform, signal) =>
    platform.writeModelChoice(AGENT, readPackV25Json<never>('fixtures/owner.model-choice.write.mac.json'), signal),
  readModelApplication: (platform, signal) => platform.readModelApplication(AGENT, signal),
  reportModelApplication: (platform, signal) =>
    platform.reportModelApplication(AGENT, readPackV25Json<never>('fixtures/model-choice.application.report.json'), signal),
  readImport: (platform, signal) => platform.readImport(AGENT, MOVE, signal),
  reportImport: (platform, signal) =>
    platform.reportImport(AGENT, readPackV25Json<never>('fixtures/portable.archive.import-receipt.mac.json'), signal),
  readCatalog: (platform, signal) => platform.readCatalog(AGENT, DEVICE, signal),
  publishCatalog: (platform, signal) =>
    platform.publishCatalog(AGENT, readPackV25Json<never>('fixtures/mac.connection-catalog.ingest.json'), signal)
}

const ids = Object.keys(PLACEMENT_CONNECTION_ROUTE_TABLE.routes) as PlacementRouteId[]

function recorder() {
  const requests: Array<{ method: string; url: string; body: string | undefined; headers: Headers }> = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      method: String(init?.method),
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: new Headers(init?.headers)
    })

    // Whatever the platform would say, it does not matter here: only the request line does.
    return new Response(JSON.stringify({ profile: AGENT_HOME_V25_PROFILE }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    })
  })

  return {
    requests,
    platform: new PlacementConnectionPlatform({
      request: async send => send('mas-token', 'https://platform.test/api/matrix/v1'),
      fetch: fetch as typeof globalThis.fetch
    })
  }
}

describe('the placement and connection route table', () => {
  it('is a well-formed table of home routes', () => {
    expect(PLACEMENT_CONNECTION_ROUTE_TABLE.contract).toBe('atum.agent-home/2.5')
    expect(PLACEMENT_CONNECTION_ROUTE_TABLE.wire).toBe('2.5')
    expect(ids.length).toBeGreaterThan(0)

    const lines = ids.map(id => {
      const row = PLACEMENT_CONNECTION_ROUTE_TABLE.routes[id]
      return `${row.method} ${row.path}`
    })
    expect(new Set(lines).size).toBe(lines.length)

    for (const id of ids) {
      const row = PLACEMENT_CONNECTION_ROUTE_TABLE.routes[id]
      expect(['GET', 'POST', 'PUT', 'DELETE'], id).toContain(row.method)
      expect(row.path, id).toMatch(/^\/home\/[A-Za-z0-9/{}-]+$/u)
      expect(row.path, id).not.toMatch(/[?#]/u)
      // A route with a body names the message it carries.
      expect('request' in row, id).toBe(row.method !== 'GET')
    }
  })

  it('has a client call for every row, and a row for every client call', () => {
    expect(Object.keys(CALLS).sort()).toEqual([...ids].sort())

    // Every public method of the client is a table row: a call that is not in the table is a route the platform's own
    // check of this table would never see. (The private helpers are the only methods that are not.)
    const helpers = new Set(['constructor', 'controller', 'signedRefusal', 'call'])
    const methods = Object.getOwnPropertyNames(PlacementConnectionPlatform.prototype).filter(name => !helpers.has(name))

    expect([...methods].sort()).toEqual([...ids].sort())
  })

  it.each(ids)('%s sends exactly the table row', async id => {
    const { platform, requests } = recorder()
    const row = PLACEMENT_CONNECTION_ROUTE_TABLE.routes[id]

    await CALLS[id](platform, AbortSignal.timeout(1_000))

    expect(requests).toHaveLength(1)
    const sent = requests[0]!
    const expected = placementRoute(id, { moveId: MOVE, deviceServiceId: DEVICE })!
    expect(sent.method).toBe(row.method)
    expect(sent.url).toBe(`https://platform.test/api/matrix/v1/agents/${AGENT}${expected.path}`)
    expect(sent.url).not.toMatch(/[?#]/u)
    expect(sent.headers.get('atum-agent-home-wire')).toBe(PLACEMENT_CONNECTION_ROUTE_TABLE.wire)
    expect(sent.headers.get('authorization')).toBe('Bearer mas-token')
    expect(sent.body !== undefined).toBe(row.method !== 'GET')
    if (sent.body !== undefined) {expect(sent.headers.get('content-type')).toBe('application/json')}
  })

  it('sends nothing outside the table across the whole surface', async () => {
    const { platform, requests } = recorder()

    for (const id of ids) {await CALLS[id](platform, AbortSignal.timeout(1_000))}

    const allowed = new Set(
      ids.map(id => {
        const row = PLACEMENT_CONNECTION_ROUTE_TABLE.routes[id]
        const route = placementRoute(id, { moveId: MOVE, deviceServiceId: DEVICE })!
        return `${row.method} https://platform.test/api/matrix/v1/agents/${AGENT}${route.path}`
      })
    )
    const sent = requests.map(request => `${request.method} ${request.url}`)

    expect(sent.sort()).toEqual([...allowed].sort())
  })

  it('refuses a placeholder that is missing or is not an identifier', () => {
    expect(placementRoute('readProgress')).toBeNull()
    expect(placementRoute('readProgress', { moveId: '../etc' })).toBeNull()
    expect(placementRoute('readCatalog', { moveId: MOVE })).toBeNull()
    expect(placementRoute('readProgress', { moveId: MOVE })).toEqual({
      id: 'readProgress',
      method: 'GET',
      path: `/home/owner/moves/${MOVE}`
    })
  })
})
