import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, expect, test } from 'vitest'

import {
  APP_MANIFEST_TTL_MS,
  AtumAppSurfacesClient,
  parseAppLaunchIssue,
  parseAppManifestResponse
} from './app-surfaces'
import { projectAppRoutes } from './app-surfaces-ipc'
import { MessagingHttpError } from './http-client'
import type { MessagingAccountSession } from './types'

const servers: http.Server[] = []
const participantFixtures = JSON.parse(readFileSync(new URL('../../../../spec/participants/v1/fixtures.json', import.meta.url), 'utf8'))

afterEach(async () => {
  for (const server of servers) {server.closeAllConnections()}
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

interface Route { status: number; body: unknown; raw?: string }
interface Fake { routes: Map<string, Route>; requests: { method: string; path: string; body: string; launchProfile?: string }[] }

function session(baseUrl: string): MessagingAccountSession {
  return {
    baseUrl,
    user: { id: '00000000-0000-4000-8000-303617b97302', displayName: 'Minh', handle: null },
    tokens: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null }
  }
}

async function fakeHost(routes: Record<string, Route>): Promise<{ origin: string; fake: Fake }> {
  const fake: Fake = { routes: new Map(Object.entries(routes)), requests: [] }

  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => (body += chunk))
    request.on('end', () => {
      const path = request.url ?? '/'
      fake.requests.push({ method: request.method ?? 'GET', path, body, launchProfile: request.headers['atum-app-launch-profile'] as string | undefined })
      const route = fake.routes.get(`${request.method} ${path}`)

      if (!route) {
        response.writeHead(404, { 'content-type': 'text/html' })
        response.end('<html>not here</html>')

        return
      }

      response.writeHead(route.status, { 'content-type': 'application/json' })
      response.end(route.raw ?? JSON.stringify(route.body))
    })
  })

  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return { origin: `http://127.0.0.1:${port}`, fake }
}

const WEB_ORIGIN = 'https://moon.atumplatform.com'

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    profile: 'atum.remote-app-manifest/1',
    manifest_version: '1.0.0',
    app: {
      id: '00000000-0000-4000-8000-e79acd97ac88',
      slug: 'moon',
      app_version_id: '00000000-0000-4000-8000-a9703d75e616',
      name: { vi: 'Moon', en: 'Moon' },
      icon: null,
      verified: true,
      availability: 'available'
    },
    compatibility: { desktop: { minimum: '0.1.0', maximum_exclusive: null }, provider_protocol_header: '0', provider_profiles: ['atum.turn/1'] },
    link: { mode: 'external_account', state: 'linked' },
    agent: { mode: 'remote_turn', profile: 'moon', context_profile: 'app-thread/1', capabilities: [] },
    launch: { profile: 'atum.app-launch/1', path: '/atum/launch' },
    routes: [
      { id: 'readings', label: { vi: 'Lá số', en: 'Readings' }, icon: 'moon', path: '/readings', placements: ['menu'], session: 'required' },
      { id: 'chat', label: { vi: 'Trò chuyện', en: 'Chat' }, icon: 'chat', path: '/chat', placements: ['menu', 'composer'], session: 'required' },
      { id: 'pricing', label: { vi: 'Giá', en: 'Pricing' }, icon: 'tag', path: '/pricing', placements: ['menu'], session: 'none' }
    ],
    artifacts: { profile: 'atum.artifact/1' },
    ...overrides
  }
}

function manifestResponse(overrides: Record<string, unknown> = {}) {
  return { manifest: manifest(overrides), web_origin: WEB_ORIGIN }
}

function launchUrl(code = 'Q'.repeat(43)) {
  return `${WEB_ORIGIN}/atum/launch?code=${code}`
}

function refusal(launchError: string, code = 'feature_unavailable', extra: Record<string, unknown> = {}) {
  return { error: { code, message_key: `messaging.error.${code}`, retryable: false, request_id: 'r', details: { launch_error: launchError }, ...extra } }
}

function client(origin: string, extra: Partial<ConstructorParameters<typeof AtumAppSurfacesClient>[0]> = {}) {
  return new AtumAppSurfacesClient({
    session: () => session(origin),
    refresh: async () => null,
    openExternal: async () => undefined,
    ...extra
  })
}

test('the manifest parser is a strict mirror of the contract', () => {
  const parsed = parseAppManifestResponse(manifestResponse())
  expect(parsed.web_origin).toBe(WEB_ORIGIN)
  expect(parsed.manifest.launch).toEqual({ profile: 'atum.app-launch/1', path: '/atum/launch' })
  expect(parsed.manifest.routes.map(route => route.id)).toEqual(['readings', 'chat', 'pricing'])
  expect(parsed.manifest.link).toEqual({ mode: 'external_account', state: 'linked' })

  const rejects = (value: unknown) => assert.throws(() => parseAppManifestResponse(value), (error: unknown) => error instanceof MessagingHttpError && error.code === 'app_manifest_invalid')
  rejects({ manifest: manifest(), web_origin: 'http://moon.atumplatform.com' })
  rejects({ manifest: manifest(), web_origin: `${WEB_ORIGIN}/path` })
  rejects({ manifest: manifest({ profile: 'atum.remote-app-manifest/2' }), web_origin: WEB_ORIGIN })
  rejects({ manifest: manifest({ launch: { profile: 'atum.app-launch/1', path: '/atum/%2e%2e/launch' } }), web_origin: WEB_ORIGIN })
  rejects({ manifest: manifest({ launch: { profile: 'atum.app-launch/1', path: 'https://evil.example/launch' } }), web_origin: WEB_ORIGIN })
  rejects({ manifest: manifest({ launch: null }), web_origin: WEB_ORIGIN }) // session-required routes need a launch declaration
  rejects({ manifest: manifest({ routes: [manifest().routes[0], manifest().routes[0]] }), web_origin: WEB_ORIGIN })
  rejects({ manifest: manifest({ routes: [{ ...manifest().routes[0], path: '/readings?x=1' }] }), web_origin: WEB_ORIGIN })
  rejects({ manifest: manifest({ link: { mode: 'none', state: 'linked' } }), web_origin: WEB_ORIGIN })
  rejects({ manifest: manifest({ app: { ...manifest().app, slug: 'Moon' } }), web_origin: WEB_ORIGIN })
})

test('trusted participant bytes bind the app and expose only a display projection through IPC', () => {
  const response = { ...manifestResponse(), participant_ref: participantFixtures.refs[2], participant: participantFixtures.snapshots.aliceMoon }
  const parsed = parseAppManifestResponse(response)
  expect(parsed.participantRef?.kind).toBe('app')
  const projection = JSON.parse(JSON.stringify(projectAppRoutes(parsed)))
  expect(projection.participant).toEqual({ kind: 'app', id: response.participant.id, displayName: 'Moon', ownerUserId: response.participant.owner_user_id, ownerDisplayName: 'Alice' })
  const bytes = JSON.stringify(projection)

  for (const denied of ['app_installation_id', 'appInstallationId', 'subject', 'epoch', 'participantRef', 'web_origin']) {expect(bytes).not.toContain(denied)}
  expect(() => parseAppManifestResponse({ ...response, participant_ref: { ...response.participant_ref, id: participantFixtures.refs[0].id } })).toThrow()
  expect(() => parseAppManifestResponse({ ...response, participant: { ...response.participant, owner_user_id: undefined } })).toThrow()
  expect(() => parseAppManifestResponse({ ...response, manifest: manifest({ link: { mode: 'external_account', state: 'unlinked' } }) })).toThrow()
  expect(parseAppManifestResponse({ ...manifestResponse(), participant_ref: null, participant: null }).participantRef).toBeNull()
})

test('a manifest cannot label another account relationship as the current user', async () => {
  const host = await fakeHost({ 'GET /api/desktop/v1/apps/moon/manifest': { status: 200, body: {
    ...manifestResponse(), participant_ref: participantFixtures.refs[2], participant: participantFixtures.snapshots.aliceMoon
  } } })

  await expect(client(host.origin).manifest('moon')).rejects.toMatchObject({ code: 'app_manifest_invalid' })
})

test('A → B → A discards old participant results even if a fetch ignores cancellation', async () => {
  const a = participantFixtures.snapshots.aliceMoon.owner_user_id
  const b = participantFixtures.snapshots.bobMoon.owner_user_id
  let current = { ...session('https://atum.example'), user: { ...session('').user, id: a } }
  const pending: Array<(response: Response) => void> = []

  const surfaces = client('https://atum.example', {
    session: () => current,
    fetchImpl: async (_url, init) => {
      expect(new Headers(init?.headers).get('x-atum-participant-refs')).toBe('1')

      return new Promise<Response>(resolve => pending.push(resolve))
    }
  })

  const old = surfaces.manifest('moon')
  const refused = expect(old).rejects.toMatchObject({ code: 'app_surface_cancelled' })
  surfaces.revokeAccount({ accountId: a, accountGeneration: 1 })
  current = { ...current, user: { ...current.user, id: b } }
  surfaces.revokeAccount({ accountId: b, accountGeneration: 2 })
  current = { ...current, user: { ...current.user, id: a } }
  const fresh = surfaces.manifest('moon')
  const body = { ...manifestResponse(), participant_ref: participantFixtures.refs[2], participant: participantFixtures.snapshots.aliceMoon }
  pending[0](Response.json(body))
  await refused
  pending[1](Response.json({ ...body, participant: { ...body.participant, owner_display_name: 'Alice current' } }))
  expect((await fresh).participant?.ownerDisplayName).toBe('Alice current')
  expect((await surfaces.manifest('moon')).participant?.ownerDisplayName).toBe('Alice current')
})

test('a launch URL is bound to the manifest before it can ever be navigated to', () => {
  const expected = { webOrigin: WEB_ORIGIN, launchPath: '/atum/launch' }
  const issued = parseAppLaunchIssue({ launch_url: launchUrl(), expires_at: '2026-09-03T10:01:00.000Z' }, expected)
  expect(issued.launchUrl).toBe(launchUrl())
  expect(issued.expiresAt).toBe(Date.parse('2026-09-03T10:01:00.000Z'))

  const rejects = (launch_url: string) => assert.throws(
    () => parseAppLaunchIssue({ launch_url, expires_at: '2026-09-03T10:01:00.000Z' }, expected),
    (error: unknown) => error instanceof MessagingHttpError && error.code === 'app_launch_invalid'
  )

  rejects(`https://evil.example/atum/launch?code=${'Q'.repeat(43)}`)
  rejects(`${WEB_ORIGIN}/other?code=${'Q'.repeat(43)}`)
  rejects(`${WEB_ORIGIN}/atum/launch?code=${'Q'.repeat(43)}&next=/x`)
  rejects(`${WEB_ORIGIN}/atum/launch?code=short`)
  rejects(`${WEB_ORIGIN}/atum/launch?code=${'Q'.repeat(43)}#frag`)
  rejects(`https://user:pw@moon.atumplatform.com/atum/launch?code=${'Q'.repeat(43)}`)
  assert.throws(() => parseAppLaunchIssue({ launch_url: launchUrl(), expires_at: 'soon' }, expected))
  assert.throws(() => parseAppLaunchIssue({ launch_url: launchUrl(), expires_at: '2026-09-03T10:01:00.000Z', extra: 1 }, expected))
})

test('the manifest is fetched with the bearer, cached per account for the TTL, and never trusted for another slug', async () => {
  let now = 1_000
  const { origin, fake } = await fakeHost({ 'GET /api/desktop/v1/apps/moon/manifest': { status: 200, body: manifestResponse() } })
  const surfaces = client(origin, { now: () => now })
  const first = await surfaces.manifest('moon')
  expect(first.manifest.app.slug).toBe('moon')
  await surfaces.manifest('moon')
  expect(fake.requests).toHaveLength(1)
  now += APP_MANIFEST_TTL_MS + 1
  await surfaces.manifest('moon')
  expect(fake.requests).toHaveLength(2)

  fake.routes.set('GET /api/desktop/v1/apps/andy/manifest', { status: 200, body: manifestResponse() })
  await assert.rejects(surfaces.manifest('andy'), (error: unknown) => error instanceof MessagingHttpError && error.code === 'app_manifest_invalid')
})

test('a launch posts only the route id, binds the answer to the manifest, and hands back the URL', async () => {
  const { origin, fake } = await fakeHost({
    'GET /api/desktop/v1/apps/moon/manifest': { status: 200, body: manifestResponse() },
    'POST /api/desktop/v1/apps/moon/launch': { status: 200, body: { launch_url: launchUrl(), expires_at: '2026-09-03T10:01:00.000Z' } }
  })

  const issued = await client(origin).launch('moon', 'readings')
  expect(issued.launchUrl).toBe(launchUrl())
  const post = fake.requests.find(request => request.method === 'POST')!
  expect(JSON.parse(post.body)).toEqual({ route_id: 'readings' })
  expect(fake.requests.map(request => request.launchProfile)).toEqual(['atum.app-launch/2', 'atum.app-launch/2'])
})

test('undeclared and session-free routes never reach the launch endpoint', async () => {
  const { origin, fake } = await fakeHost({ 'GET /api/desktop/v1/apps/moon/manifest': { status: 200, body: manifestResponse() } })
  const surfaces = client(origin)
  await assert.rejects(surfaces.launch('moon', 'nope'), (error: unknown) => error instanceof MessagingHttpError && error.code === 'route_unknown')
  await assert.rejects(surfaces.launch('moon', 'pricing'), (error: unknown) => error instanceof MessagingHttpError && error.code === 'route_session_not_required')
  await assert.rejects(surfaces.launch('moon', '/readings'), (error: unknown) => error instanceof MessagingHttpError && error.code === 'route_unknown')
  expect(fake.requests.filter(request => request.method === 'POST')).toHaveLength(0)
})

test('a launch URL that does not bind to the manifest is refused, never returned', async () => {
  const { origin } = await fakeHost({
    'GET /api/desktop/v1/apps/moon/manifest': { status: 200, body: manifestResponse() },
    'POST /api/desktop/v1/apps/moon/launch': { status: 200, body: { launch_url: `https://evil.example/atum/launch?code=${'Q'.repeat(43)}`, expires_at: '2026-09-03T10:01:00.000Z' } }
  })

  await assert.rejects(client(origin).launch('moon', 'readings'), (error: unknown) => error instanceof MessagingHttpError && error.code === 'app_launch_invalid')
})

test('platform refusals surface in the launch vocabulary and evict the manifest when they change what the account may do', async () => {
  const { origin, fake } = await fakeHost({
    'GET /api/desktop/v1/apps/moon/manifest': { status: 200, body: manifestResponse() },
    'POST /api/desktop/v1/apps/moon/launch': { status: 409, body: refusal('unlinked') }
  })

  const surfaces = client(origin)
  await assert.rejects(surfaces.launch('moon', 'readings'), (error: unknown) => error instanceof MessagingHttpError && error.code === 'unlinked' && error.status === 409)
  const manifestFetches = () => fake.requests.filter(request => request.method === 'GET').length
  expect(manifestFetches()).toBe(1)
  // The cached manifest was evicted: the next launch refetches it.
  fake.routes.set('POST /api/desktop/v1/apps/moon/launch', { status: 403, body: refusal('membership_inactive', 'forbidden') })
  await assert.rejects(surfaces.launch('moon', 'readings'), (error: unknown) => error instanceof MessagingHttpError && error.code === 'membership_inactive')
  expect(manifestFetches()).toBe(2)
  // A non-evicting refusal keeps the cache.
  fake.routes.set('POST /api/desktop/v1/apps/moon/launch', { status: 503, body: refusal('temporarily_unavailable', 'temporarily_unavailable') })
  await assert.rejects(surfaces.launch('moon', 'readings'), (error: unknown) => error instanceof MessagingHttpError && error.code === 'temporarily_unavailable' && error.retryable)
  expect(manifestFetches()).toBe(2)
  // A 404 carrying the envelope is the platform's refusal, not capability absence.
  fake.routes.set('POST /api/desktop/v1/apps/moon/launch', { status: 404, body: refusal('route_unknown', 'not_found') })
  await assert.rejects(surfaces.launch('moon', 'readings'), (error: unknown) => error instanceof MessagingHttpError && error.code === 'route_unknown')
})

test('a rate limit carries its retry window and never spends a second launch', async () => {
  const { origin, fake } = await fakeHost({
    'GET /api/desktop/v1/apps/moon/manifest': { status: 200, body: manifestResponse() },
    'POST /api/desktop/v1/apps/moon/launch': { status: 429, body: { error: { code: 'rate_limited', message_key: 'messaging.error.rate_limited', retryable: true, request_id: 'r', retry_after_ms: 17_000 } } }
  })

  await assert.rejects(client(origin).launch('moon', 'readings'), (error: unknown) =>
    error instanceof MessagingHttpError && error.code === 'rate_limited' && error.retryable && error.details?.retry_after_ms === 17_000)
  expect(fake.requests.filter(request => request.method === 'POST')).toHaveLength(1)
})

test('an old deployment without the manifest route is capability absence, and an HTML 404 is never parsed', async () => {
  const { origin } = await fakeHost({})
  await assert.rejects(client(origin).manifest('moon'), (error: unknown) => error instanceof MessagingHttpError && error.code === 'app_surface_unavailable')
})

test('account revocation drops the manifest cache and cancels a launch before its URL escapes', async () => {
  const { origin, fake } = await fakeHost({
    'GET /api/desktop/v1/apps/moon/manifest': { status: 200, body: manifestResponse() },
    'POST /api/desktop/v1/apps/moon/launch': { status: 200, body: { launch_url: launchUrl(), expires_at: '2026-09-03T10:01:00.000Z' } }
  })

  const surfaces = client(origin)
  await surfaces.manifest('moon')
  surfaces.revokeAccount({ accountId: '00000000-0000-4000-8000-303617b97302', accountGeneration: 1 })
  await surfaces.manifest('moon')
  expect(fake.requests.filter(request => request.method === 'GET')).toHaveLength(2)

  const pending = surfaces.launch('moon', 'readings')
  surfaces.revokeAccount({ accountId: '00000000-0000-4000-8000-303617b97302', accountGeneration: 2 })
  await assert.rejects(pending, (error: unknown) => error instanceof MessagingHttpError && error.code === 'app_surface_cancelled')
})

/**
 * A network grant says an app may send the user's session token somewhere new.
 * Absent means none; anything present but malformed rejects the whole
 * manifest, because a half-understood grant is a grant.
 */
test('the network declaration is exact, closed, and fail-closed', () => {
  const accepted = parseAppManifestResponse({
    ...manifestResponse(),
    network_origins: [{ origin: 'https://data.example', kinds: ['connect'] }, { origin: 'https://data.example:8443', kinds: ['connect'] }]
  })

  // A punycoded host is canonical, so it is the spelling that is accepted.
  expect(parseAppManifestResponse({
    ...manifestResponse(),
    network_origins: [{ origin: 'https://xn--d-fga.example', kinds: ['connect'] }]
  }).network_origins[0]?.origin).toBe('https://xn--d-fga.example')

  expect(accepted.network_origins).toEqual([
    { origin: 'https://data.example', kinds: ['connect'] },
    { origin: 'https://data.example:8443', kinds: ['connect'] }
  ])

  // A response without the field is every response that shipped before it.
  expect(parseAppManifestResponse(manifestResponse()).network_origins).toEqual([])

  const rejects = (origins: unknown) =>
    assert.throws(
      () => parseAppManifestResponse({ ...manifestResponse(), network_origins: origins }),
      (error: unknown) => error instanceof MessagingHttpError && error.code === 'app_manifest_invalid'
    )

  rejects([{ origin: 'http://data.example', kinds: ['connect'] }])
  rejects([{ origin: 'wss://data.example', kinds: ['connect'] }])
  rejects([{ origin: 'https://data.example/path', kinds: ['connect'] }])
  rejects([{ origin: 'https://data.example?q=1', kinds: ['connect'] }])
  rejects([{ origin: 'https://data.example#f', kinds: ['connect'] }])
  rejects([{ origin: 'https://user:pass@data.example', kinds: ['connect'] }])
  rejects([{ origin: 'https://*.example', kinds: ['connect'] }])
  rejects([{ origin: 'data.example', kinds: ['connect'] }])
  rejects([{ origin: 'https://data.example', kinds: [] }])
  rejects([{ origin: 'https://data.example', kinds: ['script'] }])
  rejects([{ origin: 'https://data.example', kinds: ['connect', 'media'] }])
  rejects([{ origin: 'https://data.example' }])
  rejects([{ kinds: ['connect'] }])
  rejects(['https://data.example'])
  rejects({ origin: 'https://data.example', kinds: ['connect'] })
  // The same origin twice is a declaration nobody reviewed carefully.
  rejects([{ origin: 'https://data.example', kinds: ['connect'] }, { origin: 'https://data.example', kinds: ['connect'] }])
  // Present but not an array is a contract violation, not an absence.
  rejects(null)
  rejects([{ origin: 'https://DATA.example', kinds: ['connect'] }])
  rejects([{ origin: 'https://data.example.', kinds: ['connect'] }])
  rejects([{ origin: 'https://data.example:443', kinds: ['connect'] }])
  rejects([{ origin: 'https://[2001:db8::1]', kinds: ['connect'] }])
  rejects([{ origin: 'https://dữ-liệu.example', kinds: ['connect'] }])
  rejects([{ origin: `https://${'a'.repeat(64)}.example`, kinds: ['connect'] }])
  // A long list is a review failure rather than a need.
  rejects(Array.from({ length: 9 }, (_value, index) => ({ origin: `https://data${index}.example`, kinds: ['connect'] })))
})

/**
 * The public projection of the app-manifest envelope. Its digest binds these
 * sanitised fixture bytes; parser and policy behavior are exercised below.
 */
test('the wire shape the platform emits parses into the policy main enforces', () => {
  // The digest covers the published public snapshot.
  const bytes = readFileSync(new URL('./__fixtures__/app-manifest-response.json', import.meta.url))

  expect(createHash('sha256').update(bytes).digest('hex')).toBe('e0fbad4d11acba35445c1eedb517d08f5c94a2128cabd6dbbe0302d9320d3a44')

  const parsed = parseAppManifestResponse(JSON.parse(bytes.toString('utf8')))

  expect(parsed.web_origin).toBe(WEB_ORIGIN)
  expect(parsed.network_origins).toEqual([{ origin: 'https://data.example', kinds: ['connect'] }])
  expect(parsed.manifest.app.app_version_id).toBe('00000000-0000-4000-8000-a9703d75e616')
})
