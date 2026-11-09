import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test, vi } from 'vitest'

import { AtumManagedModelProxy } from '../atum-managed-model-proxy'

import { SharedGroupDevice } from './shared-group-device'
import { type SharedGroupContext, SharedGroupRunner } from './shared-group-runner'
import { MessagingSyncCoordinator } from './sync-coordinator'

const accountA = '00000000-0000-4000-8000-bd7662a5eeb4'
const accountB = '00000000-0000-4000-8000-3a3b46e67b58'
const conversationId = '00000000-0000-4000-8000-b454f82c5857'
const jobId = '00000000-0000-4000-8000-f6222a1106ee'
const assistantId = '00000000-0000-4000-8000-f1d11edf5c5c'
const profileIdentity = '00000000-0000-4000-8000-fbfe405ca65f'
const lease = '00000000-0000-4000-8000-a9703d75e616'
const reservation = '00000000-0000-4000-8000-f2da1f9533d4'

const soul = Buffer.from('I am the approved shared persona.', 'utf8')
const digest = createHash('sha256').update(soul).digest('hex')

const context: SharedGroupContext = {
  conversation_id: conversationId,
  messages: [
    {
      id: '00000000-0000-4000-8000-c8f367a876b2',
      version: 1,
      speaker: { kind: 'user', id: accountA, display_name: 'Member' },
      text: 'What do you think?'
    }
  ],
  watermark: '00000000-0000-4000-8000-c8f367a876b2',
  truncated: false,
  source_clipped: false,
  context_mode: 'shared_group'
}

function ready() {
  return {
    state: 'ready',
    job_id: jobId,
    binding: {
      assistant: assistantId,
      profile_identity: profileIdentity,
      model_alias: 'binh-minh',
      persona_digest: digest,
      persona_revision: 4
    },
    context
  }
}

function memoryStorage() {
  const values = new Map<string, string>()

  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    failureCode: () => null,
    values
  }
}

function harness() {
  let scope = { accountId: accountA, baseUrl: 'https://atum.test' }
  const storage = memoryStorage()
  const requests: Array<{ path: string; input: RequestInit }> = []
  const revoke = vi.fn()

  const issueSharedJobToken = vi.fn((input: { onReservation?: (id: string) => Promise<void> }) => {
    void input.onReservation?.(reservation)

    return { baseUrl: 'http://127.0.0.1:31234/v1', token: 'only-per-job-token', revoke }
  })

  const device = {
    heartbeat: vi.fn(async () => ({
      acceptedAt: new Date().toISOString(),
      nextHeartbeatSeconds: 30,
      credentialState: 'active'
    })),
    credentialForAccount: vi.fn(() => 'device-credential'),
    authenticatedRequest: vi.fn(async (path: string, input: RequestInit) => {
      requests.push({ path, input })

      if (path.endsWith('/recover')) {
        return { outcomes: [] }
      }

      if (path.endsWith('/claim')) {
        return {
          job: {
            job_id: jobId,
            conversation_id: conversationId,
            lease_token: lease,
            reservation_id: null,
            request: ready()
          }
        }
      }

      if (path.endsWith('/heartbeat')) {
        return ready()
      }

      if (path.endsWith('/preflight')) {
        return ready()
      }

      if (path.endsWith('/complete')) {
        return { state: 'completed', reply_id: '00000000-0000-4000-8000-e8d95748107a' }
      }

      if (path.endsWith('/fail')) {
        return { ok: true }
      }

      throw new Error('unexpected request')
    })
  }

  return {
    scope: () => scope,
    setScope: (next: typeof scope) => {
      scope = next
    },
    storage,
    requests,
    revoke,
    issueSharedJobToken,
    device
  }
}

test('shared runner uses the closed job route, persists reservation before child I/O, and launches an isolated child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atum-shared-runner-'))
  const h = harness()

  const executeChild = vi.fn(async (_input, launch) => {
    assert.equal(launch.command, '/runtime/python')
    assert.equal(launch.args.join(' '), '-m hermes_cli.shared_group_turn')
    assert.equal(launch.env.HOME.includes('shared-group-homes'), true)
    assert.equal(launch.env.HERMES_HOME.startsWith(launch.env.HOME), true)
    assert.equal(launch.cwd.startsWith(launch.env.HOME), true)
    assert.equal(launch.env.SHARED_MODEL_API_KEY, 'only-per-job-token')
    assert.equal(Object.hasOwn(launch.env, 'PRIVATE_CANARY'), false)
    assert.equal((await readFile(join(launch.env.HERMES_HOME, 'SOUL.md'))).equals(soul), true)

    return {
      profile: 'atum.shared-group-turn/1' as const,
      job_id: jobId,
      state: 'completed' as const,
      reply_text: 'A room-safe reply.'
    }
  })

  const runner = new SharedGroupRunner({
    device: h.device as never,
    proxy: { issueSharedJobToken: h.issueSharedJobToken } as never,
    account: h.scope,
    storageForAccount: () => h.storage as never,
    runtime: async () => ({ pythonPath: '/runtime/python', sourceRoot: '/runtime/source', path: '/runtime/bin' }),
    persona: async () => ({ assistantId, profileIdentity, personaDigest: digest, personaRevision: 4, soulBytes: soul }),
    userDataPath: directory,
    executeChild
  })

  assert.deepEqual(await runner.tick(), { state: 'completed', jobId, error: null })
  assert.equal(executeChild.mock.calls.length, 1)
  assert.equal(h.issueSharedJobToken.mock.calls[0]?.[0].onReservation !== undefined, true)
  assert.equal(
    h.requests.some(request => request.path.endsWith('/complete')),
    true
  )
  assert.equal(h.revoke.mock.calls.length, 1)
  assert.equal(h.storage.values.get('atum-shared-group-runner-v1')?.includes(reservation), false)
  await assert.rejects(access(join(directory, 'atum-messaging', 'shared-group-homes', conversationId, assistantId)))
})

test('account transition fences a child result and revokes its scoped proxy token before publication', async () => {
  const h = harness()

  const runner = new SharedGroupRunner({
    device: h.device as never,
    proxy: { issueSharedJobToken: h.issueSharedJobToken } as never,
    account: h.scope,
    storageForAccount: () => h.storage as never,
    runtime: async () => ({ pythonPath: '/runtime/python', sourceRoot: '/runtime/source', path: '/runtime/bin' }),
    persona: async () => ({ assistantId, profileIdentity, personaDigest: digest, personaRevision: 4, soulBytes: soul }),
    userDataPath: await mkdtemp(join(tmpdir(), 'atum-shared-runner-')),
    executeChild: async () => {
      h.setScope({ accountId: accountB, baseUrl: 'https://atum.test' })

      return { profile: 'atum.shared-group-turn/1', job_id: jobId, state: 'completed', reply_text: 'late' }
    }
  })

  const result = await runner.tick()
  assert.equal(result.state, 'failed')
  assert.equal(result.error, 'account_changed')
  assert.equal(
    h.requests.some(request => request.path.endsWith('/complete')),
    false
  )
  assert.equal(h.revoke.mock.calls.length, 1)
})

test('a durable exact reply is recovered before claiming new work and is never regenerated', async () => {
  const h = harness()
  h.storage.setItem(
    'atum-shared-group-runner-v1',
    JSON.stringify({
      version: 1,
      accountId: accountA,
      baseUrl: 'https://atum.test',
      jobs: {
        [jobId]: {
          jobId,
          conversationId,
          leaseToken: lease,
          reservationId: reservation,
          replyId: '00000000-0000-4000-8000-e8d95748107a',
          replyText: 'saved exact reply'
        }
      }
    })
  )

  const runner = new SharedGroupRunner({
    device: h.device as never,
    proxy: { issueSharedJobToken: h.issueSharedJobToken } as never,
    account: h.scope,
    storageForAccount: () => h.storage as never,
    runtime: async () => {
      throw new Error('must not start runtime')
    },
    persona: async () => {
      throw new Error('must not load persona')
    },
    userDataPath: await mkdtemp(join(tmpdir(), 'atum-shared-runner-')),
    executeChild: async () => {
      throw new Error('must not regenerate')
    }
  })

  await runner.tick()
  assert.equal(h.requests.filter(request => request.path.endsWith('/complete')).length, 1)
  assert.equal(h.requests.filter(request => request.path.endsWith('/claim')).length, 1)
})

test('stop quiesces an active account before a late child response can publish', async () => {
  const h = harness()

  let release:
    | ((value: { profile: 'atum.shared-group-turn/1'; job_id: string; state: 'completed'; reply_text: string }) => void)
    | null = null

  let started: (() => void) | null = null

  const child = new Promise<{
    profile: 'atum.shared-group-turn/1'
    job_id: string
    state: 'completed'
    reply_text: string
  }>(resolve => {
    release = resolve
  })

  const running = new Promise<void>(resolve => {
    started = resolve
  })

  const runner = new SharedGroupRunner({
    device: h.device as never,
    proxy: { issueSharedJobToken: h.issueSharedJobToken } as never,
    account: h.scope,
    storageForAccount: () => h.storage as never,
    runtime: async () => ({ pythonPath: '/runtime/python', sourceRoot: '/runtime/source', path: '/runtime/bin' }),
    persona: async () => ({ assistantId, profileIdentity, personaDigest: digest, personaRevision: 4, soulBytes: soul }),
    userDataPath: await mkdtemp(join(tmpdir(), 'atum-shared-runner-')),
    executeChild: async () => {
      started?.()

      return child
    }
  })

  const tick = runner.tick()
  await running
  runner.quiesceAccount(accountA)
  release?.({ profile: 'atum.shared-group-turn/1', job_id: jobId, state: 'completed', reply_text: 'late reply' })
  const result = await tick

  assert.equal(result.error, 'account_changed')
  assert.equal(h.revoke.mock.calls.length, 2)
  assert.equal(
    h.requests.some(request => request.path.endsWith('/complete')),
    false
  )
})

test('account quiescence fences an A→B→A late child while allowing the next account tick', async () => {
  const h = harness()

  let release:
    | ((value: { profile: 'atum.shared-group-turn/1'; job_id: string; state: 'completed'; reply_text: string }) => void)
    | null = null

  let started: (() => void) | null = null
  let childCalls = 0

  const firstChild = new Promise<{
    profile: 'atum.shared-group-turn/1'
    job_id: string
    state: 'completed'
    reply_text: string
  }>(resolve => {
    release = resolve
  })

  const firstStarted = new Promise<void>(resolve => {
    started = resolve
  })

  const runner = new SharedGroupRunner({
    device: h.device as never,
    proxy: { issueSharedJobToken: h.issueSharedJobToken } as never,
    account: h.scope,
    storageForAccount: () => h.storage as never,
    runtime: async () => ({ pythonPath: '/runtime/python', sourceRoot: '/runtime/source', path: '/runtime/bin' }),
    persona: async () => ({ assistantId, profileIdentity, personaDigest: digest, personaRevision: 4, soulBytes: soul }),
    userDataPath: await mkdtemp(join(tmpdir(), 'atum-shared-runner-')),
    executeChild: async () => {
      childCalls += 1

      if (childCalls === 1) {
        started?.()

        return firstChild
      }

      return {
        profile: 'atum.shared-group-turn/1',
        job_id: jobId,
        state: 'completed',
        reply_text: 'fresh account turn'
      }
    }
  })

  const oldTick = runner.tick()
  await firstStarted
  runner.quiesceAccount(accountA)
  h.setScope({ accountId: accountB, baseUrl: 'https://atum.test' })
  h.setScope({ accountId: accountA, baseUrl: 'https://atum.test' })
  release?.({ profile: 'atum.shared-group-turn/1', job_id: jobId, state: 'completed', reply_text: 'old turn' })

  assert.equal((await oldTick).error, 'account_changed')
  assert.equal((await runner.tick()).state, 'recovered')
  assert.equal(childCalls, 1)
  const terminal = h.requests.find(request => request.path.endsWith('/fail'))
  assert.equal(terminal !== undefined, true)
  assert.match(String(terminal?.input.body), /provider_reply_unavailable/u)
})

test('tick reserves its single-flight before a device heartbeat can finish', async () => {
  const h = harness()
  let release: (() => void) | null = null

  const heartbeat = new Promise<void>(resolve => {
    release = resolve
  })

  h.device.heartbeat.mockImplementationOnce(async () => {
    await heartbeat

    return { acceptedAt: new Date().toISOString(), nextHeartbeatSeconds: 30, credentialState: 'active' }
  })

  const runner = new SharedGroupRunner({
    device: h.device as never,
    proxy: { issueSharedJobToken: h.issueSharedJobToken } as never,
    account: h.scope,
    storageForAccount: () => h.storage as never,
    runtime: async () => ({ pythonPath: '/runtime/python', sourceRoot: '/runtime/source', path: '/runtime/bin' }),
    persona: async () => ({ assistantId, profileIdentity, personaDigest: digest, personaRevision: 4, soulBytes: soul }),
    userDataPath: await mkdtemp(join(tmpdir(), 'atum-shared-runner-')),
    executeChild: async () => ({
      profile: 'atum.shared-group-turn/1',
      job_id: jobId,
      state: 'completed',
      reply_text: 'one turn'
    })
  })

  const first = runner.tick()
  assert.deepEqual(await runner.tick(), { state: 'busy', jobId: null, error: null })
  release?.()
  assert.equal((await first).state, 'completed')
  assert.equal(h.device.heartbeat.mock.calls.length, 1)
})

test('real device transport launches Hermes through the job proxy with multilingual and app history', async () => {
  const { createServer } = await import('node:http')
  const { resolve } = await import('node:path')
  const reply = 'Loopback provider completed the shared turn.'
  const requests: Array<Record<string, unknown>> = []
  let reservations = 0
  const h = harness()

  const wireContext = structuredClone(context)
  wireContext.messages.unshift({ id: '00000000-0000-4000-8000-b764e2b951d3', version: 1,
    speaker: { kind: 'specialist', id: 'moon', display_name: 'Moon' }, text: 'Đây là ý kiến của Moon.' })
  wireContext.messages[1].text = 'Bạn nghĩ thế nào? 🌙 '.repeat(230)
  assert.ok([...JSON.stringify(wireContext)].length < 6000)
  assert.ok(Buffer.byteLength(JSON.stringify(wireContext)) > 6250)

  const server = createServer(async (request, response) => {
    const prefix = '/api/desktop/v1/group-conversations'

    if (request.url?.startsWith(prefix)) {
      response.setHeader('content-type', 'application/json')

      if (request.url === `${prefix}/device`) {
        response.statusCode = 201
        response.end(JSON.stringify({ installation_id: assistantId, device_credential: 'a'.repeat(43),
          credential_expires_at: new Date(Date.now() + 86400000).toISOString(), heartbeat_interval_seconds: 30 }))

        return
      }

      assert.equal(request.headers['x-atum-device-credential'], 'a'.repeat(43))
      assert.equal(request.headers['x-atum-group-shared-agents'], '1')

      if (request.url === `${prefix}/device/heartbeat`) {
        response.end(JSON.stringify({ accepted_at: new Date().toISOString(), next_heartbeat_seconds: 30, credential_state: 'active' }))

        return
      }

      let body = ''

      for await (const chunk of request) {body += chunk}

      if (body) {assert.equal(request.headers['content-type'], 'application/json')}
      assert.ok([`${prefix}/claim`, `${prefix}/recover`,
        ...['preflight', 'heartbeat', 'complete', 'fail'].map(action => `${prefix}/${conversationId}/jobs/${jobId}/${action}`)
      ].includes(request.url))
      const result = await h.device.authenticatedRequest(request.url, { method: 'POST', body })
      const wire = structuredClone(result) as Record<string, any>

      if (wire.context) {wire.context = wireContext}

      if (wire.job?.request?.context) {wire.job.request.context = wireContext}
      response.end(JSON.stringify(wire))

      return
    }

    if (request.url === '/api/managed-model/reservations') {
      let body = ''

      for await (const chunk of request) {body += chunk}
      const payload = JSON.parse(body)
      assert.equal(payload.shared_job_id, jobId)
      assert.equal(payload.lease_token, lease)
      reservations++
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({reservation_id: reservation, claim_id: lease, expires_at: new Date(Date.now() + 300_000).toISOString()}))

      return
    }

    if (request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ object: 'list', data: [] }))

      return
    }

    let body = ''

    for await (const chunk of request) {
      body += chunk
    }

    const payload = JSON.parse(body) as { model?: string; messages?: Array<{ role: string }> }

    if (!payload.messages) {
      response.statusCode = 404
      response.end()

      return
    }

    assert.ok([...h.storage.values.values()].some(value => value.includes(reservation)))
    requests.push(payload)
    const deniedTool = payload.messages.at(-1)?.role === 'tool'
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        id: 'chatcmpl-fixture',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-chat',
        choices: [
          {
            index: 0,
            message: deniedTool
              ? { role: 'assistant', content: reply }
              : {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'forged',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"path":"private.txt"}' }
                    }
                  ]
                },
            finish_reason: deniedTool ? 'stop' : 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 1, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    )
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.equal(typeof address === 'object' && address !== null, true)
  const baseUrl = `http://127.0.0.1:${(address as { port: number }).port}/v1`

  const proxy = new AtumManagedModelProxy({
    tokens: {
      current: () => ({baseUrl: h.scope().baseUrl, user: {id: accountA, displayName: 'Owner', handle: null}, tokens: {accessToken: 'fixture-access', refreshToken: null, expiresAt: null}}),
      refresh: async () => null
    },
    fetchImpl: (input, init) => fetch(new URL(new URL(String(input)).pathname, baseUrl), init)
  })

  await proxy.start()
  const sourceRoot = resolve(process.cwd(), '../..')

  const realDevice = new SharedGroupDevice({
    tokens: { current: () => ({ baseUrl: baseUrl.slice(0, -3), user: { id: accountA, displayName: 'Owner', handle: null },
      tokens: { accessToken: 'fixture-access', refreshToken: null, expiresAt: null } }), refresh: async () => null },
    storageForAccount: () => h.storage as never, installationNonce: profileIdentity, clientVersion: '1.0.0'
  })

  await realDevice.enable()

  const runner = new SharedGroupRunner({
    device: realDevice,
    proxy,
    account: h.scope,
    storageForAccount: () => h.storage as never,
    runtime: async () => ({
      pythonPath: join(sourceRoot, '.venv', 'bin', 'python'),
      sourceRoot,
      path: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'
    }),
    persona: async () => ({ assistantId, profileIdentity, personaDigest: digest, personaRevision: 4, soulBytes: soul }),
    userDataPath: await mkdtemp(join(tmpdir(), 'atum-shared-runner-')),
    // The full Electron suite runs hundreds of process-heavy files in parallel. The real Python
    // child normally finishes in under a second, but a saturated hosted runner can leave it
    // descheduled beyond 30s; that is test-host pressure, not a product runtime failure.
    childTimeoutMs: 90_000
  })

  try {
    const result = await runner.tick()
    assert.equal(result.state, 'completed', JSON.stringify(result))
    assert.equal(requests.length, 2)
    assert.equal(reservations, 1)
    assert.equal(
      requests.every(request => !Object.hasOwn(request, 'tools')),
      true
    )
    assert.equal(JSON.stringify(requests).includes('private.txt'), true)
  } finally {
    runner.stop()
    await proxy.stop()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }
}, 105_000)

async function runnerFixture(h = harness()) {
  const executeChild = vi.fn(async () => ({ profile: 'atum.shared-group-turn/1' as const,
    job_id: jobId, state: 'completed' as const, reply_text: 'exact reply' }))

  const runner = new SharedGroupRunner({
    device: h.device as never, proxy: { issueSharedJobToken: h.issueSharedJobToken } as never,
    account: h.scope, storageForAccount: () => h.storage as never,
    runtime: async () => ({ pythonPath: '/runtime/python', sourceRoot: '/runtime/source', path: '/runtime/bin' }),
    persona: async () => ({ assistantId, profileIdentity, personaDigest: digest, personaRevision: 4, soulBytes: soul }),
    userDataPath: await mkdtemp(join(tmpdir(), 'atum-shared-runner-')), executeChild
  })

  return { h, runner, executeChild }
}

function persist(h: ReturnType<typeof harness>, text: string | null = 'saved exact reply') {
  h.storage.setItem('atum-shared-group-runner-v1', JSON.stringify({ version: 1, accountId: accountA,
    baseUrl: 'https://atum.test', jobs: { [jobId]: { jobId, conversationId, leaseToken: lease,
      reservationId: reservation, replyId: text ? profileIdentity : null, replyText: text } } }))
}

function pendingJobs(h: ReturnType<typeof harness>) {
  return JSON.parse(h.storage.getItem('atum-shared-group-runner-v1') ?? '{"jobs":{}}').jobs
}

test('a denied fresh claim closes its lease without running a child or reporting completion', async () => {
  const { h, runner, executeChild } = await runnerFixture()
  const original = h.device.authenticatedRequest.getMockImplementation()!
  h.device.authenticatedRequest.mockImplementation(async (path, input) => {
    const result = await original(path, input)

    if (path.endsWith('/claim')) {return { job: { ...(result as any).job, request: { state: 'denied', error: 'source_too_large', conversation_id: conversationId } } }}

    return result
  })
  assert.equal((await runner.tick()).state, 'recovered')
  assert.equal(executeChild.mock.calls.length, 0)
  assert.equal(h.requests.filter(request => request.path.endsWith('/fail')).length, 1)
  assert.deepEqual(pendingJobs(h), {})
})

for (const terminal of ['completed', 'denied', 'gone', 'transport_failure', 'lost_lease'] as const) {
  test(`recovery distinguishes ${terminal} from retriable local evidence`, async () => {
    const { h, runner, executeChild } = await runnerFixture()
    persist(h)
    const original = h.device.authenticatedRequest.getMockImplementation()!
    h.device.authenticatedRequest.mockImplementation(async (path, input) => {
      if (path.endsWith('/claim')) {return { job: null } as never}

      if (path.endsWith('/preflight')) {
        if (terminal === 'gone') {throw new Error('shared_group_device_job_gone')}

        if (terminal === 'transport_failure') {throw new Error('shared_group_device_request_failed')}

        if (terminal === 'lost_lease') {throw new Error('shared_group_device_request_rejected')}

        return { state: terminal, reply_id: profileIdentity, conversation_id: conversationId } as never
      }

      return original(path, input)
    })
    assert.equal((await runner.tick()).state, 'recovered')
    assert.equal(executeChild.mock.calls.length, 0)
    assert.equal(Boolean(pendingJobs(h)[jobId]), terminal === 'transport_failure' || terminal === 'lost_lease')
  })
}

test('an interrupted reservation without a reply is closed and removed after its next claim', async () => {
  const { h, runner, executeChild } = await runnerFixture()
  persist(h, null)
  assert.equal((await runner.tick()).state, 'recovered')
  assert.equal(executeChild.mock.calls.length, 0)
  assert.deepEqual(pendingJobs(h), {})
})

test('a lost publication response retains exact bytes for idempotent replay', async () => {
  const { h, runner, executeChild } = await runnerFixture()
  const original = h.device.authenticatedRequest.getMockImplementation()!
  h.device.authenticatedRequest.mockImplementation(async (path, input) => {
    if (path.endsWith('/complete')) {throw new Error('network lost after publish')}

    return original(path, input)
  })
  assert.equal((await runner.tick()).state, 'failed')
  assert.equal(pendingJobs(h)[jobId].replyText, 'exact reply')
  assert.equal(h.requests.filter(request => request.path.endsWith('/fail')).length, 0)
  h.device.authenticatedRequest.mockImplementation(original)
  assert.equal((await runner.tick()).state, 'completed')
  assert.equal(executeChild.mock.calls.length, 1)
  assert.deepEqual(pendingJobs(h), {})
})

test('main polls without renderer activity, obeys heartbeat/recovery cadence, and stops cleanly', async () => {
  const { h, runner } = await runnerFixture()
  h.device.authenticatedRequest.mockImplementation(async path => path.endsWith('/claim') ? { job: null } as never : { outcomes: [] } as never)
  vi.useFakeTimers()

  try {
    runner.start()
    runner.start()
    await vi.advanceTimersByTimeAsync(25_000)
    assert.equal(h.device.heartbeat.mock.calls.length, 1)
    assert.equal(h.device.authenticatedRequest.mock.calls.filter(([path]) => path.endsWith('/claim')).length, 3)
    assert.equal(h.device.authenticatedRequest.mock.calls.filter(([path]) => path.endsWith('/recover')).length, 1)
    await vi.advanceTimersByTimeAsync(5_000)
    assert.equal(h.device.heartbeat.mock.calls.length, 2)
    assert.equal(h.device.authenticatedRequest.mock.calls.filter(([path]) => path.endsWith('/recover')).length, 2)
    runner.stop()
    const count = h.device.authenticatedRequest.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    assert.equal(h.device.authenticatedRequest.mock.calls.length, count)
  } finally {runner.stop(); vi.useRealTimers()}
})

test('main does no network work before explicit device enablement', async () => {
  const { h, runner } = await runnerFixture()
  h.device.credentialForAccount.mockReturnValue(null as never)
  assert.equal((await runner.tick()).state, 'idle')
  assert.equal(h.device.heartbeat.mock.calls.length, 0)
  assert.equal(h.device.authenticatedRequest.mock.calls.length, 0)
})

test('device presence continues during a long child without another claim', async () => {
  const { h, runner, executeChild } = await runnerFixture()
  let finish!: (value: any) => void
  let started!: () => void
  const readyChild = new Promise<void>(resolve => {started = resolve})
  executeChild.mockImplementation(() => {started();

 return new Promise(resolve => {finish = resolve})})
  const flight = runner.tick()
  await readyChild
  vi.useFakeTimers()

  try {
    await vi.advanceTimersByTimeAsync(31_000)
    assert.equal((await runner.tick()).state, 'busy')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(h.device.heartbeat.mock.calls.length, 2)
    assert.equal(h.requests.filter(request => request.path.endsWith('/claim')).length, 1)
  } finally {
    vi.useRealTimers()
    finish({ profile: 'atum.shared-group-turn/1', job_id: jobId, state: 'completed', reply_text: 'long reply' })
    assert.equal((await flight).state, 'completed')
    runner.stop()
  }
})

test('a failed persona lookup closes the lease before any provider dispatch', async () => {
  const h = harness()

  const runner = new SharedGroupRunner({
    device: h.device as never, proxy: { issueSharedJobToken: h.issueSharedJobToken } as never,
    account: h.scope, storageForAccount: () => h.storage as never,
    runtime: async () => {throw new Error('must not start runtime')},
    persona: async () => {throw new Error('approval no longer exists')},
    userDataPath: await mkdtemp(join(tmpdir(), 'atum-shared-runner-'))
  })

  assert.equal((await runner.tick()).state, 'failed')
  assert.equal(h.issueSharedJobToken.mock.calls.length, 0)
  assert.equal(h.requests.filter(request => request.path.endsWith('/fail')).length, 1)
})

test('publication denied after the child reply closes work without reporting completion', async () => {
  const { h, runner } = await runnerFixture()
  const original = h.device.authenticatedRequest.getMockImplementation()!
  h.device.authenticatedRequest.mockImplementation(async (path, input) => {
    if (path.endsWith('/complete')) {return { state: 'denied', conversation_id: conversationId, error: 'context_changed' } as never}

    return original(path, input)
  })
  assert.equal((await runner.tick()).state, 'recovered')
  assert.deepEqual(pendingJobs(h), {})
  assert.equal(h.requests.filter(request => request.path.endsWith('/fail')).length, 1)
})


test('empty claims recover every 60 seconds while presence stays live; wake and work reset', async () => {
  const { h, runner } = await runnerFixture()
  h.device.authenticatedRequest.mockImplementation(async path => path.endsWith('/claim') ? { job: null } as never : { outcomes: [] } as never)
  vi.useFakeTimers()
  const claims = () => h.device.authenticatedRequest.mock.calls.filter(([path]) => path.endsWith('/claim')).length
  try {
    runner.start()
    await vi.advanceTimersByTimeAsync(75_000)
    assert.equal(claims(), 5)
    await vi.advanceTimersByTimeAsync(59_999)
    assert.equal(claims(), 5)
    assert.equal(h.device.heartbeat.mock.calls.length, 5)
    assert.equal(h.device.authenticatedRequest.mock.calls.filter(([path]) => path.endsWith('/recover')).length, 5)
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(claims(), 6)
    runner.wake()
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(claims(), 7)
    await vi.advanceTimersByTimeAsync(5_000)
    assert.equal(claims(), 8)
    // A denied job still counts as work and drains at the fast cadence.
    const original = harness().device.authenticatedRequest.getMockImplementation()!
    h.device.authenticatedRequest.mockImplementation(async (path, input) => {
      const result = await original(path, input)
      if (path.endsWith('/claim')) {
        return { job: { ...(result as any).job, request: { state: 'denied', error: 'source_too_large', conversation_id: conversationId } } }
      }
      return result
    })
    await vi.advanceTimersByTimeAsync(10_000)
    const worked = claims()
    await vi.advanceTimersByTimeAsync(5_000)
    assert.equal(claims(), worked + 1)
  } finally { runner.stop(); vi.useRealTimers() }
})


test('claim transport failures retain the existing 30-second retry and recover', async () => {
  const { h, runner } = await runnerFixture()
  let failed = false
  h.device.authenticatedRequest.mockImplementation(async path => {
    if (path.endsWith('/claim')) {
      if (!failed) { failed = true; throw new Error('network') }
      return { job: null } as never
    }
    return { outcomes: [] } as never
  })
  vi.useFakeTimers()
  const claims = () => h.device.authenticatedRequest.mock.calls.filter(([path]) => path.endsWith('/claim')).length
  try {
    runner.start()
    await vi.advanceTimersByTimeAsync(25_000)
    assert.equal(claims(), 1)
    await vi.advanceTimersByTimeAsync(5_000)
    assert.equal(claims(), 2)
    await vi.advanceTimersByTimeAsync(5_000)
    assert.equal(claims(), 3)
  } finally { runner.stop(); vi.useRealTimers() }
})


test('a cursor-ahead Realtime hint immediately claims while idle backoff is 60 seconds', async () => {
  const { h, runner } = await runnerFixture()
  h.device.authenticatedRequest.mockImplementation(async path => path.endsWith('/claim') ? { job: null } as never : { outcomes: [] } as never)
  let hint!: (message: unknown) => void
  const channel = {
    on: (_type: string, _filter: unknown, callback: (message: unknown) => void) => { hint = callback; return channel },
    subscribe: () => channel,
    unsubscribe: () => undefined
  }
  const wake = vi.spyOn(runner, 'wake')
  const coordinator = new MessagingSyncCoordinator({
    realtimeUrl: 'https://project.test', anonKey: 'public-key',
    tokens: { current: () => ({ ...h.scope(), user: { id: accountA, displayName: null, handle: null },
      tokens: { accessToken: 'fixture-token', refreshToken: null, expiresAt: null } }), refresh: async () => null },
    advertisement: async () => ({ transport: 'supabase_private_broadcast', topic: `user:${accountA}:messaging:v1`, event: 'sync_available' }),
    status: async () => ({ accountId: accountA, connectivity: 'online', synchronized: true, cursor: 'cursor-1',
      lastSuccessfulSyncAt: null, nextRetryAt: null, errorCode: null }),
    sync: vi.fn(),
    onActivity: () => runner.wake(),
    createClient: async () => ({ channel: () => channel, connect() {}, disconnect() {}, setAuth() {} })
  })
  vi.useFakeTimers()
  const claims = () => h.device.authenticatedRequest.mock.calls.filter(([path]) => path.endsWith('/claim')).length
  try {
    await coordinator.start()
    runner.start()
    await vi.advanceTimersByTimeAsync(76_000)
    assert.equal(claims(), 5) // Last empty claim at 75 s; next recovery claim due at 135 s.
    const heartbeats = h.device.heartbeat.mock.calls.length
    const recoveries = h.device.authenticatedRequest.mock.calls.filter(([path]) => path.endsWith('/recover')).length
    hint({ payload: { cursor_hint: 'cursor-1' } })
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(wake.mock.calls.length, 0)
    hint({ payload: { cursor_hint: 'cursor-2' } })
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(wake.mock.calls.length, 1)
    assert.equal(claims(), 6)
    assert.equal(h.device.heartbeat.mock.calls.length, heartbeats)
    assert.equal(h.device.authenticatedRequest.mock.calls.filter(([path]) => path.endsWith('/recover')).length, recoveries)
  } finally { runner.stop(); await coordinator.stop(); vi.useRealTimers() }
})
