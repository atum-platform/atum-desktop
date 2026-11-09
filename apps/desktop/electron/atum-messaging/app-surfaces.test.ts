import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, expect, test } from 'vitest'

import {
  AtumAppSurfacesClient,
  parseAuthorizeUrl,
  parseConnectCandidate,
  parseConnectLifecycle,
  parseDesktopAppCatalog,
  parseIntakeStatus
} from './app-surfaces'
import { registerAtumAppSurfaceIpc } from './app-surfaces-ipc'
import { MessagingHttpError } from './http-client'
import type { MessagingAccountSession } from './types'

const servers: http.Server[] = []

test('catalog projection accepts a generic third provider and excludes app network authority', () => {
  const catalog = parseDesktopAppCatalog({ apps: [{
    app: 'third-provider', app_id: '00000000-0000-0000-0000-000000000001', app_version_id: '00000000-0000-0000-0000-000000000002',
    name: { vi: 'Nhà cung cấp thứ ba', en: 'Third Provider' }, subtitle: { vi: 'Hỗ trợ trực tiếp', en: 'Direct help' },
    icon: { url: 'https://assets.example/third.png', sha256: 'a'.repeat(64) }, verified: false,
    availability: 'available', supported_modes: ['direct'], link: { mode: 'none', state: 'never_linked' }
  }] })

  assert.deepEqual(catalog.apps[0]?.supported_modes, ['direct'])
  assert.deepEqual(Object.keys(catalog.apps[0] ?? {}).sort(), [
    'app', 'app_id', 'app_version_id', 'availability', 'icon', 'link', 'name', 'subtitle', 'supported_modes', 'verified'
  ])
})

test('catalog projection rejects malformed display authority', () => {
  expect(() => parseDesktopAppCatalog({ apps: [{
    app: 'third-provider', app_id: '00000000-0000-0000-0000-000000000001', app_version_id: '00000000-0000-0000-0000-000000000002',
    name: { vi: 'A', en: 'A' }, subtitle: null, icon: { url: 'not-a-url', sha256: 'a'.repeat(64) }, verified: false,
    availability: 'available', supported_modes: ['arbitrary'], link: { mode: 'none', state: 'never_linked' }
  }] })).toThrow(MessagingHttpError)
  expect(() => parseDesktopAppCatalog({ apps: [{
    app: 'third-provider', app_id: '00000000-0000-0000-0000-000000000001', app_version_id: '00000000-0000-0000-0000-000000000002',
    name: { vi: 'A', en: 'A' }, subtitle: null, icon: { url: 'https://user:password@assets.example/third.png', sha256: 'a'.repeat(64) }, verified: 'yes',
    availability: 'available', supported_modes: ['direct'], link: { mode: 'none', state: 'never_linked' }
  }] })).toThrow(MessagingHttpError)
})

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections()
  }

  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

interface Route {
  status: number
  body: unknown
  /** Raw body wins over `body` — for non-JSON responses. */
  raw?: string
  headers?: http.OutgoingHttpHeaders
}

interface Fake {
  routes: Map<string, Route>
  requests: { method: string; path: string; body: string; authorization: string | undefined }[]
}

function session(baseUrl: string, accessToken = 'access-1'): MessagingAccountSession {
  return {
    baseUrl,
    user: { id: '00000000-0000-4000-8000-303617b97302', displayName: 'Minh', handle: null },
    tokens: { accessToken, refreshToken: 'refresh-1', expiresAt: null }
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
      fake.requests.push({
        method: request.method ?? 'GET',
        path,
        body,
        authorization: request.headers.authorization
      })

      const route = fake.routes.get(`${request.method} ${path}`)

      if (!route) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'not_found' } }))

        return
      }

      response.writeHead(route.status, { 'content-type': 'application/json', ...route.headers })
      response.end(route.raw ?? JSON.stringify(route.body))
    })
  })

  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return { origin: `http://127.0.0.1:${address.port}`, fake }
}

function harness(
  origin: string,
  overrides: Partial<{
    opened: string[]
    openExternal: (url: string) => Promise<void>
    refresh: () => Promise<MessagingAccountSession | null>
  }> = {}
) {
  const opened = overrides.opened ?? []

  const client = new AtumAppSurfacesClient({
    session: () => session(origin),
    refresh: overrides.refresh ?? (async () => null),
    openExternal:
      overrides.openExternal ??
      (async url => {
        opened.push(url)
      })
  })

  return { client, opened }
}

// ---------------------------------------------------------------------------
// Intake status parsing — the form IS the declaration, never a hardcoded list
// ---------------------------------------------------------------------------

test('an app that declares nothing yields no form at all', () => {
  // THE case that must never regress: Andy declares no intake, so nothing is
  // ever rendered for it. A client that hardcoded Moon's five fields would
  // show a birth-chart form in a mental-health conversation.
  assert.deepEqual(parseIntakeStatus({ complete: true, missing: [] }), { complete: true, fields: [] })
  assert.deepEqual(parseIntakeStatus({ complete: true }), { complete: true, fields: [] })
})

test('the form is exactly what the server says is missing, in server order', () => {
  const status = parseIntakeStatus({ complete: false, missing: ['preferred_name', 'dob', 'gender'] })

  assert.equal(status.complete, false)
  assert.deepEqual(
    status.fields.map(field => field.name),
    ['preferred_name', 'dob', 'gender']
  )
  // No declaration was sent, so every control degrades to text rather than
  // being guessed at from the field name.
  assert.deepEqual(new Set(status.fields.map(field => field.type)), new Set(['text']))
})

test('a declaration supplies control types, options, and labels', () => {
  const status = parseIntakeStatus({
    complete: false,
    missing: ['dob', 'gender'],
    fields: [
      { name: 'dob', type: 'date', label: 'Ngày sinh' },
      {
        name: 'gender',
        type: 'select',
        label: 'Giới tính',
        options: [
          { value: 'male', label: 'Nam' },
          { value: 'female', label: 'Nữ' }
        ]
      },
      // Declared but not missing — already answered, so not rendered.
      { name: 'birth_city', type: 'text' }
    ]
  })

  assert.deepEqual(
    status.fields.map(field => [field.name, field.type, field.label]),
    [
      ['dob', 'date', 'Ngày sinh'],
      ['gender', 'select', 'Giới tính']
    ]
  )
  assert.deepEqual(status.fields[1]!.options, [
    { value: 'male', label: 'Nam' },
    { value: 'female', label: 'Nữ' }
  ])
})

test('a select with no options is a text input, not a broken control', () => {
  const status = parseIntakeStatus({
    complete: false,
    missing: ['gender'],
    fields: [{ name: 'gender', type: 'select', options: [] }]
  })

  assert.equal(status.fields[0]!.type, 'text')
})

test('a malformed declaration degrades the controls but never the field list', () => {
  const status = parseIntakeStatus({
    complete: false,
    missing: ['dob', 'gender'],
    fields: ['nonsense', { name: 'dob', type: 'weird-type' }, { type: 'date' }, null]
  })

  assert.deepEqual(
    status.fields.map(field => [field.name, field.type]),
    [
      ['dob', 'text'],
      ['gender', 'text']
    ]
  )
})

test('hostile intake status bodies are rejected or sanitized, never rendered', () => {
  for (const body of [null, 'complete', [], { complete: 'yes' }, {}]) {
    assert.throws(() => parseIntakeStatus(body), MessagingHttpError)
  }

  // Field names outside the protocol's snake_case rule, duplicates, and
  // absurd volumes are dropped rather than rendered.
  const status = parseIntakeStatus({
    complete: false,
    missing: ['dob', 'dob', 'Bad-Name', '<script>', '', 'ok_field', ...Array.from({ length: 80 }, (_, i) => `f${i}`)]
  })

  assert.deepEqual(
    status.fields.slice(0, 3).map(field => field.name),
    ['dob', 'ok_field', 'f0']
  )
  assert.ok(status.fields.length <= 32)
})

test('complete-with-missing-fields resolves in favour of showing the form', () => {
  // The protocol forbids this combination; if a server ever emits it, stranding
  // the conversation behind an invisible gate is the worse failure.
  const status = parseIntakeStatus({ complete: true, missing: ['dob'] })

  assert.equal(status.complete, false)
  assert.deepEqual(
    status.fields.map(field => field.name),
    ['dob']
  )
})

// ---------------------------------------------------------------------------
// Connect parsing
// ---------------------------------------------------------------------------

test.each(['none', 'available', 'dismissed', 'linked'])('candidate status %s parses', status => {
  assert.deepEqual(parseConnectCandidate({ status }), { status })
})

test.each([{ status: 'matched' }, { status: 'AVAILABLE' }, {}, null, 'available'])(
  'an unknown candidate status %# is rejected rather than guessed',
  body => {
    assert.throws(() => parseConnectCandidate(body), MessagingHttpError)
  }
)

test.each(['never_linked', 'linked', 'unlinked'])('lifecycle status %s parses', status => {
  assert.deepEqual(parseConnectLifecycle({ status }), { status })
})

test('the lifecycle parser preserves browser_step for the renderer state machine', () => {
  assert.deepEqual(parseConnectLifecycle({ status: 'never_linked', browser_step: 'authorize' }), {
    status: 'never_linked',
    browserStep: 'authorize'
  })
})

test.each([{ status: 'available' }, { status: 'LINKED' }, {}, null])(
  'an unknown lifecycle status %# is rejected rather than guessed',
  body => {
    assert.throws(() => parseConnectLifecycle(body), MessagingHttpError)
  }
)

test('connection readiness is an additive public projection', () => {
  assert.deepEqual(
    parseConnectLifecycle({
      status: 'linked',
      connection_required: true,
      available: true,
      readiness: 'pending',
      installation_id: 'private'
    }),
    {
      status: 'linked',
      connectionRequired: true,
      available: true,
      readiness: 'pending'
    }
  )
})

test.each([
  { status: 'linked', connection_required: true },
  { status: 'linked', connection_required: true, available: true, readiness: 'not_linked' },
  { status: 'never_linked', connection_required: true, available: true, readiness: 'ready' },
  { status: 'linked', connection_required: 'true', available: true, readiness: 'ready' },
  { status: 'linked', connection_required: true, available: true, readiness: 'unknown' }
])('refuses malformed or contradictory readiness %#', body => {
  assert.throws(() => parseConnectLifecycle(body), MessagingHttpError)
})

test('only an absolute https authorize URL without credentials is ever opened', () => {
  assert.equal(
    parseAuthorizeUrl({ authorize_url: 'https://moon.example/connect?t=1' }),
    'https://moon.example/connect?t=1'
  )

  for (const authorize_url of [
    'http://moon.example/connect',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'atum://auth-callback/x',
    'https://user:pass@moon.example/connect',
    '/connect',
    '',
    42
  ]) {
    assert.throws(() => parseAuthorizeUrl({ authorize_url }), MessagingHttpError)
  }

  assert.throws(() => parseAuthorizeUrl(null), MessagingHttpError)
})

// ---------------------------------------------------------------------------
// Client behaviour against a real socket
// ---------------------------------------------------------------------------

const INTAKE = 'GET /api/desktop/v1/specialists/moon/intake'
const INTAKE_POST = 'POST /api/desktop/v1/specialists/moon/intake'
const CANDIDATE = 'POST /api/desktop/v1/apps/moon/connect/candidate'
const STATUS = 'GET /api/desktop/v1/apps/moon/connect/status'
const START = 'POST /api/desktop/v1/apps/moon/connect/start'
const DISMISS = 'POST /api/desktop/v1/apps/moon/connect/dismiss'

test('intake status is fetched with the bearer token and no cookie', async () => {
  const { origin, fake } = await fakeHost({
    [INTAKE]: { status: 200, body: { complete: false, missing: ['dob'] } }
  })

  const { client } = harness(origin)

  const status = await client.intakeStatus('moon')

  assert.deepEqual(
    status.fields.map(field => field.name),
    ['dob']
  )
  assert.equal(fake.requests[0]!.authorization, 'Bearer access-1')
})

test('submitting sends the collected values and reports completion', async () => {
  const { origin, fake } = await fakeHost({
    [INTAKE_POST]: { status: 200, body: { complete: true } }
  })

  const { client } = harness(origin)

  const status = await client.intakeSubmit('moon', { preferred_name: 'Minh', dob: '1990-01-01' })

  assert.deepEqual(status, { complete: true, fields: [] })
  assert.deepEqual(JSON.parse(fake.requests[0]!.body), { preferred_name: 'Minh', dob: '1990-01-01' })
})

test('a field-addressed rejection keeps the field so the form can point at it', async () => {
  const { origin } = await fakeHost({
    [INTAKE_POST]: { status: 400, body: { error: 'invalid_intake', field: 'dob' } }
  })

  const { client } = harness(origin)

  await expect(client.intakeSubmit('moon', { dob: 'not-a-date' })).rejects.toMatchObject({
    code: 'invalid_intake',
    details: { field: 'dob' }
  })
})

test('malformed submission input never reaches the network', async () => {
  const { origin, fake } = await fakeHost({})
  const { client } = harness(origin)

  for (const values of [null, 'x', [], {}, { 'Bad-Name': 'x' }, { ok: 1 }, { ok: 'x'.repeat(600) }]) {
    await expect(client.intakeSubmit('moon', values)).rejects.toMatchObject({ code: 'intake_values_invalid' })
  }

  assert.equal(fake.requests.length, 0)
})

test.each(['', 'Moon Rising', '../admin', 'a'.repeat(70), 42, null])(
  'a bogus app id %# is refused before any request',
  async app => {
    const { origin, fake } = await fakeHost({})
    const { client } = harness(origin)

    await expect(client.intakeStatus(app)).rejects.toMatchObject({ code: 'app_id_invalid' })
    assert.equal(fake.requests.length, 0)
  }
)

test('a successful candidate probe is cached per app — never polled or spent twice', async () => {
  // atum.app_match_candidates.probe_attempts is capped at 3 server-side. A
  // client retry loop would permanently burn a real user's match.
  const { origin, fake } = await fakeHost({
    [CANDIDATE]: { status: 200, body: { status: 'available' } }
  })

  const { client } = harness(origin)

  assert.deepEqual(await client.connectCandidate('moon'), { status: 'available' })
  assert.deepEqual(await client.connectCandidate('moon'), { status: 'available' })
  assert.deepEqual(await client.connectCandidate('moon'), { status: 'available' })

  assert.equal(fake.requests.filter(request => request.path.endsWith('/candidate')).length, 1)
})

test('overlapping candidate callers share one scarce request', async () => {
  const { origin, fake } = await fakeHost({
    [CANDIDATE]: { status: 200, body: { status: 'available' } }
  })

  const { client } = harness(origin)

  assert.deepEqual(await Promise.all([client.connectCandidate('moon'), client.connectCandidate('moon')]), [
    { status: 'available' },
    { status: 'available' }
  ])
  assert.equal(fake.requests.filter(request => request.path.endsWith('/candidate')).length, 1)
})

test('link lifecycle status is authoritative and safe to refresh', async () => {
  const { origin, fake } = await fakeHost({
    [STATUS]: { status: 200, body: { status: 'never_linked' } }
  })

  const { client } = harness(origin)

  assert.deepEqual(await client.connectStatus('moon'), { status: 'never_linked' })
  fake.routes.set(STATUS, { status: 200, body: { status: 'linked' } })
  assert.deepEqual(await client.connectStatus('moon'), { status: 'linked' })
  assert.equal(fake.requests.length, 2)
})

test('the attested connect route set preserves lifecycle, browser handoff, and dismissal authority', async () => {
  const { origin, fake } = await fakeHost({
    [STATUS]: { status: 200, body: { status: 'never_linked' } },
    [CANDIDATE]: { status: 200, body: { status: 'available' } },
    [START]: { status: 200, body: { authorize_url: 'https://moon.example/atum/authorize?state=x' } },
    [DISMISS]: { status: 200, body: { status: 'dismissed' } }
  })

  const { client, opened } = harness(origin)

  assert.deepEqual(await client.connectStatus('moon'), { status: 'never_linked' })
  assert.deepEqual(await client.connectCandidate('moon'), { status: 'available' })
  assert.deepEqual(await client.connectStart('moon'), { opened: true })
  assert.deepEqual(opened, ['https://moon.example/atum/authorize?state=x'])
  assert.deepEqual(await client.connectDismiss('moon'), { status: 'dismissed' })
  assert.deepEqual(
    fake.requests.map(request => `${request.method} ${request.path}`),
    [STATUS, CANDIDATE, START, DISMISS]
  )
  assert.ok(fake.requests.every(request => request.authorization === 'Bearer access-1'))
})

test.each([
  ['HTML', '<!doctype html><html><body>Not found</body></html>'],
  ['empty', '']
])('an undeployed connect route is capability absence for an %s 404 body', async (_kind, raw) => {
  const { origin } = await fakeHost({
    [STATUS]: {
      status: 404,
      body: null,
      raw,
      headers: { 'content-type': 'text/html' }
    }
  })

  const { client } = harness(origin)

  await expect(client.connectStatus('moon')).rejects.toMatchObject({
    code: 'app_surface_unavailable',
    status: 404
  })
})

test('the legacy same-origin login redirect is capability absence for a desktop route', async () => {
  const { origin } = await fakeHost({
    [STATUS]: { status: 307, body: null, headers: { location: '/login' } },
    'GET /login': {
      status: 200,
      body: null,
      raw: '<!doctype html><html><body>Login</body></html>',
      headers: { 'content-type': 'text/html' }
    }
  })

  const { client } = harness(origin)

  await expect(client.connectStatus('moon')).rejects.toMatchObject({
    code: 'app_surface_unavailable',
    status: 200
  })
})

test('a failed probe is also spent — a failure is reported, not retried', async () => {
  const { origin, fake } = await fakeHost({
    [CANDIDATE]: { status: 503, body: { error: 'match_unavailable' } }
  })

  const { client } = harness(origin)

  await expect(client.connectCandidate('moon')).rejects.toMatchObject({ code: 'match_unavailable' })
  await expect(client.connectCandidate('moon')).rejects.toMatchObject({ code: 'connect_probe_already_spent' })
  assert.equal(fake.requests.length, 1)
})

test('a different app keeps its own probe budget', async () => {
  const { origin } = await fakeHost({
    [CANDIDATE]: { status: 200, body: { status: 'available' } },
    'POST /api/desktop/v1/apps/andy/connect/candidate': { status: 200, body: { status: 'none' } }
  })

  const { client } = harness(origin)

  assert.deepEqual(await client.connectCandidate('moon'), { status: 'available' })
  assert.deepEqual(await client.connectCandidate('andy'), { status: 'none' })
})

test('a different signed-in account gets its own candidate probe budget', async () => {
  const { origin, fake } = await fakeHost({
    [CANDIDATE]: { status: 200, body: { status: 'available' } }
  })

  let current = session(origin)

  const client = new AtumAppSurfacesClient({
    session: () => current,
    refresh: async () => null,
    openExternal: async () => undefined
  })

  assert.deepEqual(await client.connectCandidate('moon'), { status: 'available' })
  current = {
    ...current,
    user: { ...current.user, id: '00000000-0000-4000-8000-00f765af1c54' }
  }
  assert.deepEqual(await client.connectCandidate('moon'), { status: 'available' })
  assert.equal(fake.requests.length, 2)
})

test('connect start opens the authorize URL in the system browser and returns nothing else', async () => {
  const { origin } = await fakeHost({
    [START]: { status: 200, body: { authorize_url: 'https://moon.example/atum/authorize?state=x' } }
  })

  const { client, opened } = harness(origin)

  // The renderer gets a bare acknowledgement — the URL stays in main, so this
  // seam can never become an arbitrary-navigation primitive.
  assert.deepEqual(await client.connectStart('moon'), { opened: true })
  assert.deepEqual(opened, ['https://moon.example/atum/authorize?state=x'])
})

test('account revocation cancels connect start before an authorize URL can escape to the OS', async () => {
  let resolveFetch: ((response: Response) => void) | null = null
  const opened: string[] = []
  const accountId = '00000000-0000-4000-8000-303617b97302'

  const client = new AtumAppSurfacesClient({
    fetchImpl: async () =>
      await new Promise<Response>(resolve => {
        resolveFetch = resolve
      }),
    session: () => session('https://atum.example'),
    refresh: async () => null,
    openExternal: async url => {
      opened.push(url)
    }
  })

  const starting = client.connectStart('moon')
  client.revokeAccount({ accountGeneration: 2, accountId })
  resolveFetch!(
    new Response(JSON.stringify({ authorize_url: 'https://moon.example/atum/authorize?state=x' }), {
      headers: { 'content-type': 'application/json' },
      status: 200
    })
  )

  await expect(starting).rejects.toMatchObject({ code: 'app_surface_cancelled' })
  assert.deepEqual(opened, [])
})

test('a non-https authorize URL is never handed to the OS', async () => {
  const { origin } = await fakeHost({
    [START]: { status: 200, body: { authorize_url: 'file:///Applications/Calculator.app' } }
  })

  const { client, opened } = harness(origin)

  await expect(client.connectStart('moon')).rejects.toMatchObject({ code: 'connect_authorize_url_invalid' })
  assert.deepEqual(opened, [])
})

test('a browser that will not open is a real error, not a silent success', async () => {
  const { origin } = await fakeHost({
    [START]: { status: 200, body: { authorize_url: 'https://moon.example/authorize' } }
  })

  const { client } = harness(origin, {
    openExternal: async () => {
      throw new Error('no handler')
    }
  })

  await expect(client.connectStart('moon')).rejects.toMatchObject({ code: 'connect_browser_unavailable' })
})

test('start reports the 409 the server uses when the candidate is no longer connectable', async () => {
  const { origin } = await fakeHost({ [START]: { status: 409, body: { error: 'match_not_available' } } })
  const { client } = harness(origin)

  await expect(client.connectStart('moon')).rejects.toMatchObject({ code: 'match_not_available', status: 409 })
})

test('dismiss reports the resulting status', async () => {
  const { origin, fake } = await fakeHost({
    [CANDIDATE]: { status: 200, body: { status: 'available' } },
    [DISMISS]: { status: 200, body: { status: 'dismissed' } }
  })

  const { client } = harness(origin)

  assert.deepEqual(await client.connectCandidate('moon'), { status: 'available' })
  assert.deepEqual(await client.connectDismiss('moon'), { status: 'dismissed' })
  assert.deepEqual(await client.connectCandidate('moon'), { status: 'dismissed' })
  assert.equal(fake.requests.length, 2)
})

test('dismiss cannot manufacture an offer before an available candidate was observed', async () => {
  const { origin, fake } = await fakeHost({
    [DISMISS]: { status: 200, body: { status: 'dismissed' } }
  })

  const { client } = harness(origin)

  await expect(client.connectDismiss('moon')).rejects.toMatchObject({
    code: 'connect_candidate_unavailable',
    status: 409
  })
  assert.equal(fake.requests.length, 0)
})

test('dismiss rejects a settled non-available candidate without contacting the server', async () => {
  const { origin, fake } = await fakeHost({
    [CANDIDATE]: { status: 200, body: { status: 'none' } },
    [DISMISS]: { status: 200, body: { status: 'dismissed' } }
  })

  const { client } = harness(origin)

  assert.deepEqual(await client.connectCandidate('moon'), { status: 'none' })
  await expect(client.connectDismiss('moon')).rejects.toMatchObject({ code: 'connect_candidate_unavailable' })
  assert.deepEqual(
    fake.requests.map(request => `${request.method} ${request.path}`),
    [CANDIDATE]
  )
})

test('one account cannot dismiss a candidate observed for another account', async () => {
  const { origin, fake } = await fakeHost({
    [CANDIDATE]: { status: 200, body: { status: 'available' } },
    [DISMISS]: { status: 200, body: { status: 'dismissed' } }
  })

  let current = session(origin)

  const client = new AtumAppSurfacesClient({
    session: () => current,
    refresh: async () => null,
    openExternal: async () => undefined
  })

  assert.deepEqual(await client.connectCandidate('moon'), { status: 'available' })
  current = {
    ...current,
    user: { ...current.user, id: '00000000-0000-4000-8000-00f765af1c54' }
  }

  await expect(client.connectDismiss('moon')).rejects.toMatchObject({ code: 'connect_candidate_unavailable' })
  assert.deepEqual(
    fake.requests.map(request => `${request.method} ${request.path}`),
    [CANDIDATE]
  )
})

test('a 401 refreshes the session once and replays with the new token', async () => {
  const { origin, fake } = await fakeHost({
    [INTAKE]: { status: 401, body: { error: { code: 'token_expired' } } }
  })

  let refreshed = false

  const { client } = harness(origin, {
    refresh: async () => {
      refreshed = true
      fake.routes.set(INTAKE, { status: 200, body: { complete: true, missing: [] } })

      return session(origin, 'access-2')
    }
  })

  assert.deepEqual(await client.intakeStatus('moon'), { complete: true, fields: [] })
  assert.equal(refreshed, true)
  assert.deepEqual(
    fake.requests.map(request => request.authorization),
    ['Bearer access-1', 'Bearer access-2']
  )
})

test('with no session nothing is attempted', async () => {
  const { origin, fake } = await fakeHost({})

  const client = new AtumAppSurfacesClient({
    session: () => null,
    refresh: async () => null,
    openExternal: async () => undefined
  })

  await expect(client.intakeStatus('moon')).rejects.toMatchObject({ code: 'auth_unavailable' })
  assert.equal(fake.requests.length, 0)
  assert.ok(origin)
})

test('a cookie-era HTML login redirect is an error, never parsed as a form', async () => {
  // Until the desktop/v1 handlers exist, calling the shell routes returns the
  // login page. It must fail loudly rather than render an empty gate.
  const { origin } = await fakeHost({
    [INTAKE]: { status: 200, body: null, raw: '<!doctype html><html><body>Login</body></html>' }
  })

  const { client } = harness(origin)

  await expect(client.intakeStatus('moon')).rejects.toMatchObject({ code: 'app_surface_invalid_response' })
})

test('a transport failure stays distinguishable from an absent optional capability', async () => {
  const client = new AtumAppSurfacesClient({
    fetchImpl: async () => {
      throw new TypeError('socket closed')
    },
    session: () => session('https://atum.invalid'),
    refresh: async () => null,
    openExternal: async () => undefined
  })

  await expect(client.connectStatus('moon')).rejects.toMatchObject({ code: 'app_surface_request_failed' })
})

test('an oversized response is cut off rather than buffered', async () => {
  const { origin } = await fakeHost({
    [INTAKE]: { status: 200, body: null, raw: JSON.stringify({ complete: false, pad: 'x'.repeat(200_000) }) }
  })

  const { client } = harness(origin)

  await expect(client.intakeStatus('moon')).rejects.toMatchObject({ code: 'app_surface_response_too_large' })
})

// ---------------------------------------------------------------------------
// IPC seam
// ---------------------------------------------------------------------------

function ipcHarness() {
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()

  return {
    handlers,
    ipc: {
      handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) =>
        handlers.set(channel, listener),
      removeHandler: (channel: string) => handlers.delete(channel)
    }
  }
}

test('IPC returns parsed results and stable error codes, never an upstream body', async () => {
  const { origin } = await fakeHost({
    [INTAKE]: { status: 200, body: { complete: false, missing: ['dob'] } },
    [INTAKE_POST]: { status: 400, body: { error: 'invalid_intake', field: 'dob', hint: 'do not echo me' } },
    [STATUS]: { status: 200, body: { status: 'linked', pairwise_subject: 'must-not-cross-ipc' } },
    [START]: { status: 200, body: { authorize_url: 'https://moon.example/authorize' } }
  })

  const { client, opened } = harness(origin)
  const { handlers, ipc } = ipcHarness()
  const dispose = registerAtumAppSurfaceIpc(ipc, client)

  const status = await handlers.get('atum:app:intake:status')!(null, 'moon')

  assert.deepEqual(status, {
    complete: false,
    fields: [{ name: 'dob', type: 'text', label: null, placeholder: null, options: [] }]
  })

  const rejected = await handlers.get('atum:app:intake:submit')!(null, 'moon', { dob: 'x' })

  assert.deepEqual(rejected, { error: 'invalid_intake', field: 'dob' })
  assert.doesNotMatch(JSON.stringify(rejected), /do not echo me/)

  const lifecycle = await handlers.get('atum:app:connect:status')!(null, 'moon')

  assert.deepEqual(lifecycle, { status: 'linked' })
  assert.doesNotMatch(JSON.stringify(lifecycle), /pairwise_subject/)

  const started = await handlers.get('atum:app:connect:start')!(null, 'moon')

  assert.deepEqual(started, { opened: true })
  assert.doesNotMatch(JSON.stringify(started), /moon\.example/)
  assert.deepEqual(opened, ['https://moon.example/authorize'])

  dispose()
  assert.equal(handlers.size, 0)
})

test('IPC never throws at the renderer, whatever it is handed', async () => {
  const { origin } = await fakeHost({})
  const { client } = harness(origin)
  const { handlers, ipc } = ipcHarness()
  registerAtumAppSurfaceIpc(ipc, client)

  for (const channel of [
    'atum:app:routes',
    'atum:app:intake:status',
    'atum:app:connect:status',
    'atum:app:connect:candidate',
    'atum:app:connect:start',
    'atum:app:connect:dismiss'
  ]) {
    assert.deepEqual(await handlers.get(channel)!(null, { not: 'a string' }), { error: 'app_id_invalid' })
  }

  assert.deepEqual(await handlers.get('atum:app:intake:submit')!(null, 'moon', 'nope'), {
    error: 'intake_values_invalid'
  })
})

test('Connect rollout availability crosses the HTTP parser without changing use availability', () => {
  assert.deepEqual(parseConnectLifecycle({ status: 'never_linked', connection_required: false, available: true, readiness: 'not_linked', connect_available: false }), {
    status: 'never_linked', connectionRequired: false, available: true, readiness: 'not_linked', connectAvailable: false
  })
  assert.throws(() => parseConnectLifecycle({ status: 'linked', connect_available: 'yes' }), MessagingHttpError)
})

test('per-app withdrawal cancels only that app before browser launch', async () => {
  const responses = new Map<string, (response: Response) => void>()
  const signals = new Map<string, AbortSignal>()
  const opened: string[] = []

  const client = new AtumAppSurfacesClient({
    session: () => session('https://atum.example'), refresh: async () => null,
    openExternal: async url => { opened.push(url) },
    fetchImpl: async (url, init) => new Promise<Response>(resolve => {
      const app = String(url).includes('/moon/') ? 'moon' : 'andy'
      responses.set(app, resolve)
      signals.set(app, init!.signal!)
    })
  })

  const moon = client.connectStart('moon')
  const moonRejected = expect(moon).rejects.toMatchObject({ code: 'app_surface_cancelled' })
  const andy = client.connectStart('andy')
  client.revokeApp({ accountId: session('https://atum.example').user.id, app: 'moon' })
  expect(signals.get('moon')!.aborted).toBe(true)
  expect(signals.get('andy')!.aborted).toBe(false)

  for (const [app, resolve] of responses) {
    resolve(Response.json({ authorize_url: `https://${app}.example/connect` }))
  }

  await moonRejected
  expect(await andy).toEqual({ opened: true })
  expect(opened).toEqual(['https://andy.example/connect'])
})

test('per-app withdrawal evicts its settled caches while retaining other app caches and probe budgets', async () => {
  const fake = await fakeHost({
    [CANDIDATE]: { status: 200, body: { status: 'available' } },
    'POST /api/desktop/v1/apps/andy/connect/candidate': { status: 200, body: { status: 'none' } }
  })

  const { client } = harness(fake.origin)
  await client.connectCandidate('moon')
  await client.connectCandidate('andy')
  client.revokeApp({ accountId: session(fake.origin).user.id, app: 'moon' })
  expect(await client.connectCandidate('andy')).toEqual({ status: 'none' })
  await expect(client.connectCandidate('moon')).rejects.toMatchObject({ code: 'connect_probe_already_spent' })
  expect(fake.fake.requests).toHaveLength(2)
})
