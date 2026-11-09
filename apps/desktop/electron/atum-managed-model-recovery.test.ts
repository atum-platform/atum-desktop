import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test, vi } from 'vitest'

import { AtumManagedModelProxy, type AtumManagedModelProxyOptions } from './atum-managed-model-proxy'
import { managedResponseCanRetry, managedRetryDelay } from './atum-managed-request-retry'

const proxies: AtumManagedModelProxy[] = []
const directories: string[] = []
const body = JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content: 'private task content' }] })
const reservationId = '00000000-0000-4000-8000-8ed3eb6a6170'
const claimId = '00000000-0000-4000-8000-967df44633da'
const reply = { id: 'reply', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] }

function reservation() {
  return Response.json({ reservation_id: reservationId, claim_id: claimId }, { status: 201 })
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })

  return { promise, resolve }
}

async function start(fetchImpl: typeof fetch, options: Partial<AtumManagedModelProxyOptions> = {}) {
  const proxy = new AtumManagedModelProxy({
    fetchImpl,
    tokens: { current: () => ({
      baseUrl: 'https://atum.test', user: { id: 'owner', displayName: 'Owner', handle: 'owner' },
      tokens: { accessToken: 'private-token', refreshToken: 'private-refresh', expiresAt: null }
    }), refresh: async () => null },
    ...options
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()
  const endpoint = `${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`

  const headers = (session: string, requestId = crypto.randomUUID()) => ({
    authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
    'content-type': 'application/json', 'x-atum-session-id': session, 'x-atum-request-id': requestId
  })

  return { proxy, endpoint, headers }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(proxies.splice(0).map(proxy => proxy.stop()))

  for (const directory of directories.splice(0)) { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('five independent conversations reach the model concurrently', async () => {
  const allStarted = deferred()
  const finish = deferred()
  let active = 0

  const app = await start(async input => {
    if (String(input).endsWith('/reservations')) { return reservation() }
    active += 1

    if (active === 5) { allStarted.resolve() }
    await finish.promise

    return Response.json(reply)
  })

  const requests = Array.from({ length: 5 }, (_, index) => fetch(app.endpoint, { method: 'POST', headers: app.headers(`task-${index}`), body }))
  await allStarted.promise
  assert.equal(active, 5)
  finish.resolve()
  assert.deepEqual((await Promise.all(requests)).map(response => response.status), [200, 200, 200, 200, 200])
})

test('one conversation stays ordered while another is working', async () => {
  const firstStarted = deferred()
  const finish = deferred()
  let calls = 0

  const app = await start(async input => {
    if (String(input).endsWith('/reservations')) { return reservation() }
    calls += 1

    if (calls === 1) {
      firstStarted.resolve()
      await finish.promise
    }

    return Response.json(reply)
  })

  const first = fetch(app.endpoint, { method: 'POST', headers: app.headers('same'), body })
  await firstStarted.promise
  const second = fetch(app.endpoint, { method: 'POST', headers: app.headers('same'), body })
  const other = await fetch(app.endpoint, { method: 'POST', headers: app.headers('other'), body })
  assert.equal(other.status, 200)
  assert.equal(calls, 2, 'the second same-conversation request has not overtaken the first')
  finish.resolve()
  assert.deepEqual((await Promise.all([first, second])).map(response => response.status), [200, 200])
})

test('capacity and in-progress recovery retain reservation, payload and request ID', async () => {
  const ids: Array<string | null> = []
  const payloads: unknown[] = []
  let reservations = 0

  const app = await start(async (input, init) => {
    if (String(input).endsWith('/reservations')) {
      reservations += 1

      return reservation()
    }

    ids.push(new Headers(init?.headers).get('x-atum-request-id'))
    payloads.push(init?.body)

    if (ids.length <= 2) {
      return Response.json({ error: ids.length === 1 ? 'managed_capacity_wait' : 'managed_request_in_progress', retryable: true }, {
        status: ids.length === 1 ? 429 : 409, headers: { 'retry-after': '0.01' }
      })
    }

    return Response.json(reply)
  })

  const response = await fetch(app.endpoint, { method: 'POST', headers: app.headers('task'), body })
  assert.equal(response.status, 200)
  assert.equal(reservations, 1)
  assert.equal(ids.length, 3)
  assert.equal(new Set(ids).size, 1)
  assert.equal(new Set(payloads).size, 1)
})

test('unknown outcomes are not replayed and cannot be bypassed with a new request ID', async () => {
  let attempts = 0

  const app = await start(async input => {
    if (String(input).endsWith('/reservations')) { return reservation() }
    attempts += 1

    return Response.json({ error: 'managed_request_outcome_unknown', retryable: false }, { status: 409 })
  })

  assert.equal((await fetch(app.endpoint, { method: 'POST', headers: app.headers('task'), body })).status, 409)
  assert.equal((await fetch(app.endpoint, { method: 'POST', headers: app.headers('task'), body })).status, 409)
  assert.equal(attempts, 1)
})

test('live capacity waiting survives the provider retry deadline', async () => {
  const clock = vi.spyOn(Date, 'now')
  let now = 1_800_000_000_000
  clock.mockImplementation(() => now)
  let attempts = 0

  const app = await start(async input => {
    if (String(input).endsWith('/reservations')) { return reservation() }
    attempts += 1
    now += 180_000

    return attempts < 3
      ? Response.json({ error: 'managed_capacity_wait', retryable: true }, { status: 429 })
      : Response.json(reply)
  })

  assert.equal((await fetch(app.endpoint, { method: 'POST', headers: app.headers('waiting'), body })).status, 200)
  assert.equal(attempts, 3)
})

test('confirmed stop clears uncertain work before allowing a new prompt', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-request-stop-'))
  directories.push(directory)
  const filename = path.join(directory, 'pending.json')
  let cancelled = false
  let attempts = 0

  const app = await start(async (input, init) => {
    if (init?.method === 'DELETE') {
      assert.deepEqual(JSON.parse(String(init.body)), { reservation_id: reservationId })
      cancelled = true

      return Response.json({ state: 'cancelled' })
    }

    if (String(input).endsWith('/reservations')) { return reservation() }
    attempts += 1

    return cancelled ? Response.json(reply)
      : Response.json({ error: 'managed_request_outcome_unknown', retryable: false }, { status: 409 })
  }, { pendingRequestsPath: () => filename })

  assert.equal((await fetch(app.endpoint, { method: 'POST', headers: app.headers('task'), body })).status, 409)
  assert.equal((await fetch(app.endpoint, { method: 'POST', headers: app.headers('task'), body })).status, 409)
  assert.equal(attempts, 1)
  const stop = await fetch(app.endpoint, { method: 'DELETE', headers: app.headers('task'), body: '{}' })
  assert.equal(stop.status, 200)
  assert.equal(cancelled, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), {})
  assert.equal((await fetch(app.endpoint, { method: 'POST', headers: app.headers('task'), body })).status, 200)
  assert.equal(attempts, 2)
})

test('a 200 cancellation response keeps an in-flight or reconciling turn recoverable', async () => {
  for (const state of ['in_flight', 'reconciliation_pending']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `atum-request-${state}-`))
    directories.push(directory)
    const filename = path.join(directory, 'pending.json')
    const requestId = crypto.randomUUID()
    let attempts = 0

    const app = await start(async (input, init) => {
      if (init?.method === 'DELETE') {
        assert.deepEqual(JSON.parse(String(init.body)), { reservation_id: reservationId })

        return Response.json({ state })
      }

      if (String(input).endsWith('/reservations')) { return reservation() }
      attempts += 1

      return Response.json({ error: 'managed_request_outcome_unknown', retryable: false }, { status: 409 })
    }, { pendingRequestsPath: () => filename })

    assert.equal((await fetch(app.endpoint, { method: 'POST', headers: app.headers('task', requestId), body })).status, 409)
    const stop = await fetch(app.endpoint, { method: 'DELETE', headers: app.headers('task'), body: '{}' })
    assert.equal(stop.status, 503)
    assert.equal((await stop.json()).error.code, 'managed_request_outcome_unknown')
    const retained = fs.readFileSync(filename, 'utf8')
    assert.ok(retained.includes(requestId))
    assert.ok(retained.includes(reservationId))
    assert.equal((await fetch(app.endpoint, { method: 'POST', headers: app.headers('task'), body })).status, 409)
    assert.equal(attempts, 1, 'an uncertain Stop cannot permit a fresh model request')
  }
})

test('all terminal platform cancellation states clear the exact pending request', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-request-terminal-'))
  directories.push(directory)
  const filename = path.join(directory, 'pending.json')
  const states = ['released', 'cancelled', 'settled', 'corrected']

  const app = await start(async (input, init) => {
    if (init?.method === 'DELETE') { return Response.json({ state: states.shift() }) }

    if (String(input).endsWith('/reservations')) { return reservation() }

    return Response.json({ error: 'managed_request_outcome_unknown', retryable: false }, { status: 409 })
  }, { pendingRequestsPath: () => filename })

  for (const state of ['released', 'cancelled', 'settled', 'corrected']) {
    assert.equal((await fetch(app.endpoint, { method: 'POST', headers: app.headers('task'), body })).status, 409)
    const stop = await fetch(app.endpoint, { method: 'DELETE', headers: app.headers('task'), body: '{}' })
    assert.equal(stop.status, 200, state)
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), {})
  }
})

test('a malformed scope retains evidence, lets independent work continue, and permits confirmed Stop', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-request-corrupt-'))
  directories.push(directory)
  const filename = path.join(directory, 'pending.json')
  const affected = 'affected'
  const retainedRequestId = crypto.randomUUID()
  const scope = `private:https://atum.test:owner::${affected}`
  const key = crypto.createHash('sha256').update(scope).digest('hex')
  const malformed = { requestId: retainedRequestId, turnRequestId: retainedRequestId, reservationId: null, createdAt: Date.now() }
  fs.writeFileSync(filename, JSON.stringify({ [key]: malformed }))
  let hosted = 0

  const app = await start(async (input, init) => {
    if (init?.method === 'DELETE') {
      assert.deepEqual(JSON.parse(String(init.body)), { request_id: retainedRequestId })

      return Response.json({ state: 'cancelled' })
    }

    hosted += 1

    if (String(input).endsWith('/reservations')) { return reservation() }

    return Response.json(reply)
  }, { pendingRequestsPath: () => filename })

  const blocked = await fetch(app.endpoint, { method: 'POST', headers: app.headers(affected), body })
  assert.equal(blocked.status, 503)
  assert.deepEqual(await blocked.json(), {
    error: {
      message: 'managed_request_recovery_corrupt',
      type: 'atum_managed_model_error',
      code: 'managed_request_recovery_corrupt'
    }
  })
  assert.equal(hosted, 0)

  const unrelatedStop = await fetch(app.endpoint, { method: 'DELETE', headers: app.headers(affected),
    body: JSON.stringify({ request_id: crypto.randomUUID() }) })

  assert.equal(unrelatedStop.status, 409)
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { [key]: malformed })
  assert.equal((await fetch(app.endpoint, { method: 'POST', headers: app.headers('independent'), body })).status, 200)
  assert.equal(hosted, 2)
  assert.equal((await fetch(app.endpoint, { method: 'DELETE', headers: app.headers(affected), body: '{}' })).status, 200)
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), {})
  const evidence = fs.readdirSync(directory).find(entry => entry.endsWith('.corrupt'))
  assert.ok(evidence)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, evidence), 'utf8')), { [key]: malformed })
})

test('Stop without a supplied ID resolves a later model request in the same turn', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-request-later-'))
  directories.push(directory)
  const filename = path.join(directory, 'pending.json')
  const key = crypto.createHash('sha256').update('private:https://atum.test:owner::task').digest('hex')
  fs.writeFileSync(filename, JSON.stringify({ [key]: {
    requestId: crypto.randomUUID(), turnRequestId: crypto.randomUUID(),
    reservationId, createdAt: Date.now(), bodyHash: 'a'.repeat(64)
  } }))
  let cancellations = 0

  const app = await start(async (_input, init) => {
    assert.equal(init?.method, 'DELETE')
    assert.deepEqual(JSON.parse(String(init.body)), { reservation_id: reservationId })
    cancellations += 1

    return Response.json({ state: 'settled' })
  }, { pendingRequestsPath: () => filename })

  assert.equal((await fetch(app.endpoint, { method: 'DELETE', headers: app.headers('task'), body: '{}' })).status, 200)
  assert.equal(cancellations, 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), {})
})

test('a surviving model ID cannot stand in for lost turn and reservation identities', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-request-lost-turn-'))
  directories.push(directory)
  const filename = path.join(directory, 'pending.json')
  const key = crypto.createHash('sha256').update('private:https://atum.test:owner::task').digest('hex')

  const records = { [key]: {
    requestId: crypto.randomUUID(), turnRequestId: 'damaged', reservationId: null,
    createdAt: Date.now(), bodyHash: 'a'.repeat(64)
  } }

  fs.writeFileSync(filename, JSON.stringify(records))
  let hosted = 0

  const app = await start(async () => {
    hosted += 1

    // A tombstone for an unknown turn would also say cancelled. The client
    // must never send the unrelated model ID and treat this as proof of Stop.
    return Response.json({ state: 'cancelled' })
  }, { pendingRequestsPath: () => filename })

  assert.equal((await fetch(app.endpoint, { method: 'DELETE', headers: app.headers('task'), body: '{}' })).status, 503)
  assert.equal((await fetch(app.endpoint, { method: 'POST', headers: app.headers('task'), body })).status, 503)
  assert.equal(hosted, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), records)
})

test('a fully unreadable journal blocks unsafe recovery but exposes retained server IDs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-request-unreadable-'))
  directories.push(directory)
  const filename = path.join(directory, 'pending.json')
  const retainedRequestId = crypto.randomUUID()
  fs.writeFileSync(filename, `{broken:${retainedRequestId}`)
  let hosted = 0
  const logs: string[] = []

  const app = await start(async () => {
    hosted += 1

    return Response.json(reply)
  }, { pendingRequestsPath: () => filename, log: message => logs.push(message) })

  const response = await fetch(app.endpoint, { method: 'POST', headers: app.headers('affected'), body })
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    error: {
      message: 'managed_request_recovery_unavailable',
      type: 'atum_managed_model_error',
      code: 'managed_request_recovery_unavailable'
    }
  })
  assert.equal(hosted, 0)
  assert.equal(fs.readFileSync(filename, 'utf8'), `{broken:${retainedRequestId}`)
  assert.ok(logs.some(message => message.includes(`request_ids=${retainedRequestId}`)))
})

test('disconnect cancels capacity waiting without another model attempt', async () => {
  const waiting = deferred()
  const cancelled = deferred()
  let attempts = 0

  const app = await start(async (input, init) => {
    if (init?.method === 'DELETE') {
      assert.deepEqual(JSON.parse(String(init.body)), { reservation_id: reservationId })
      cancelled.resolve()

      return Response.json({ state: 'cancelled' })
    }

    if (String(input).endsWith('/reservations')) { return reservation() }
    attempts += 1
    waiting.resolve()

    return Response.json({ error: 'managed_capacity_wait', retryable: true }, { status: 429, headers: { 'retry-after': '30' } })
  })

  const controller = new AbortController()
  const request = fetch(app.endpoint, { method: 'POST', headers: app.headers('task'), body, signal: controller.signal })
  await waiting.promise
  controller.abort()
  await assert.rejects(request)
  await cancelled.promise
  assert.equal(attempts, 1)
})

test('restart retains a pending exact request and refuses different new work until recovery', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-request-recovery-'))
  directories.push(directory)
  const filename = path.join(directory, 'pending.json')
  const requestId = crypto.randomUUID()

  const first = await start(async input => String(input).endsWith('/reservations') ? reservation()
    : Response.json({ error: 'managed_request_outcome_unknown', retryable: false }, { status: 409 }), {
    pendingRequestsPath: () => filename
  })

  assert.equal((await fetch(first.endpoint, { method: 'POST', headers: first.headers('task', requestId), body })).status, 409)
  await first.proxy.stop()
  const persisted = fs.readFileSync(filename, 'utf8')
  assert.ok(persisted.includes(requestId))
  assert.ok(!persisted.includes('private task content'))
  assert.ok(!persisted.includes('private-token'))
  assert.ok(!persisted.includes(claimId))
  let hosted = 0

  const second = await start(async (input, init) => {
    hosted += 1

    if (String(input).endsWith('/reservations')) {
      assert.equal(JSON.parse(String(init?.body)).request_id, requestId)

      return reservation()
    }

    assert.equal(new Headers(init?.headers).get('x-atum-request-id'), requestId)

    return Response.json(reply)
  }, { pendingRequestsPath: () => filename })

  assert.equal((await fetch(second.endpoint, { method: 'POST', headers: second.headers('task'), body })).status, 409)
  assert.equal(hosted, 0, 'same content with a different new ID is never treated as recovery')
  assert.equal((await fetch(second.endpoint, { method: 'POST', headers: second.headers('task', requestId), body })).status, 200)
  assert.equal(hosted, 2)
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), {})
})

test('retry policy requires explicit safe server evidence and honors Retry-After', () => {
  assert.equal(managedResponseCanRetry(500, { error: 'provider_failed', retryable: true }), false)
  assert.equal(managedResponseCanRetry(429, { error: 'provider_rate_limited' }), false)
  assert.equal(managedResponseCanRetry(409, { error: 'managed_request_outcome_unknown', retryable: true }), false)
  assert.equal(managedResponseCanRetry(409, { error: 'managed_request_in_progress', retryable: true }), true)
  assert.ok(managedRetryDelay(1, '10') >= 10_000)
  assert.ok(managedRetryDelay(1, 'Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:00 GMT')) >= 60_000)
})

test('training identity and task binding stay on every hosted call including recovery', async () => {
  const identity = crypto.randomUUID()
  const task = crypto.randomUUID()
  const expected = { 'x-atum-assistant-identity-id': identity, 'x-atum-conversation-id': 'compression-root', 'x-atum-training-task-id': task }
  const seen: Headers[] = []

  const app = await start(async (input, init) => {
    seen.push(new Headers(init?.headers))

    if (String(input).endsWith('/reservations')) { return reservation() }

    if (seen.length === 2) {
      return Response.json({ error: 'managed_request_in_progress', retryable: true }, { status: 409 })
    }

    return Response.json(reply)
  })

  const response = await fetch(app.endpoint, { method: 'POST', headers: { ...app.headers('compressed-runtime'), ...expected, 'skill_id': 'must-not-forward' }, body })
  assert.equal(response.status, 200)
  assert.equal(seen.length, 3)

  for (const headers of seen) {
    for (const [key, value] of Object.entries(expected)) { assert.equal(headers.get(key), value) }
    assert.equal(headers.has('skill_id'), false)
  }
})
