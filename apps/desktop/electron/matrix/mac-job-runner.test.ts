import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import { MatrixCronDelivery } from './cron-delivery'
import { completeMacJobDelivery, settleMacJobDelivery } from './mac-job-delivery'
import { runMacJobs, tickMacJobs } from './mac-job-runner'
import { MacJobsClient } from './mac-jobs'
import { fixture } from './mac-jobs.fixture'

it.each(['none', 'after_persist', 'after_publish', 'authority_loss', 'lost_dispatch', 'conflict', 'lost_settlement', 'vault_persist', 'vault_transient', 'vault_receipt', 'vault_settled', 'cancel_fire', 'cancel_claim', 'cancel_dispatch', 'cancel_grant'])('runs native Hermes and recovers %s without model replay', async crash => {
  const f = fixture()
  const root = path.resolve(import.meta.dirname, '../../../..')
  const temp = await mkdtemp(path.join(os.tmpdir(), 'n7-native-'))
  const stop = new AbortController()
  const occurrenceId = randomUUID(), reservationId = randomUUID(), executorId = randomUUID()

  const model = { token: 'g'.repeat(43), expiresAt: Date.now() + 120000, aliases: ['atum'], alias: 'atum', model: 'private-model',
    ceilingMicroProtons: 1000, funding: 'trial' as const, contextBudget: 100000, outputBudget: 1000,
    maxTurnMicroProtons: 1000, effort: 'low', policyDigest: 'a'.repeat(64) }

  let calls = 0, checks = 0, writeFailures = 0, failedOccurrences = 0
  const output: string[] = []
  const storeFile = path.join(temp, 'outbox.json')

  const store = { getItem: (_key: string) => existsSync(storeFile) ? readFileSync(storeFile, 'utf8') : null,
    setItem: (_key: string, value: string) => {
      if (fault && crash === 'vault_transient' && value.includes('Native child answer') && writeFailures++ < 2) {throw Error('vault_write_failed')}

      if (fault && ((crash === 'vault_persist' && value.includes('Native child answer')) ||
        (crash === 'vault_receipt' && value.includes('$answer')) ||
        (crash === 'vault_settled' && value.includes('settled')))) {throw Error('vault_write_failed')}

      writeFileSync(storeFile, value, { mode: 0o600 })
    } }

  let fault = crash !== 'none', armCompleted = false, dispatched = false
  let settlements = 0, receipts = 0, dispatches = 0

  const makeDelivery = () => new MatrixCronDelivery({
    store,
    requireRoom: async () => {},
    authorizeManaged: async post => {
      stop.signal.throwIfAborted()
      expect(readFileSync(storeFile, 'utf8')).toContain('Native child answer')

      if (fault && crash === 'after_persist') {throw Error('simulated_process_loss')}
      await completeMacJobDelivery(client, post, stop.signal)
    },
    settleManaged: (post, eventId) => settleMacJobDelivery(client, post, eventId, stop.signal),
    find: async () => output.length ? { state: 'found', eventId: '$answer' } : { state: 'absent' },
    publish: async post => {
      // D1's job-operation fence refuses a still-dispatched occurrence.
      expect(settlements).toBe(1)
      output.push(post.text)

      if (fault && crash === 'after_publish') {throw Error('simulated_process_loss')}

      return '$answer'
    }, log: () => {}
  })

  const transport = { ...f.options, fetch: async (url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body))

    if (String(url).endsWith('/jobs/fire')) {
      if (request.request.operation === 'claim') {
        if (crash === 'cancel_fire') {stop.abort()}

        return Response.json({ profile: 'atum.controller-job-fire/1', operation: 'claimed', agentPrincipal: f.home.agentPrincipal,
          fire: armCompleted ? null : fire })
      }

      armCompleted = true

      return Response.json({ profile: 'atum.controller-job-fire/1', operation: 'completed', agentPrincipal: f.home.agentPrincipal,
        armId: fire.arm.armId, occurrenceId, outcome: 'queued' })
    }

    if (String(url).endsWith('/jobs/occurrence')) {
      const op = request.request.operation

      if (op === 'claim') {
        if (crash === 'cancel_claim') {stop.abort()}

        return Response.json({ ...occurrence, state: dispatched ? 'dispatched' : 'claimed', grants: undefined, budget: undefined })}

      if (op === 'dispatch') {
        dispatches++

        if (dispatched) {return Response.json({ profile: 'atum.mac-job-fire/1', code: 'conflict' }, { status: 409 })}
        dispatched = true

        if (crash === 'cancel_dispatch') {stop.abort()}

        if (crash === 'lost_dispatch') {throw Error('lost_response_after_dispatch')}

        if (crash === 'conflict') {return Response.json({ profile: 'atum.mac-job-fire/1', code: 'conflict' }, { status: 409 })}

        return Response.json(occurrence)
      }

      if (op === 'complete') {
        if (request.request.outcome === 'failed') {
          failedOccurrences++

          return Response.json({ ...occurrence, grants: undefined, budget: undefined, state: 'completed', outcome: 'failed' })
        }

        // Business effect is idempotent even when the accepted response is lost.
        settlements = 1

        if (fault && crash === 'lost_settlement') {throw Error('lost_accepted_settlement')}
      }

      if (op === 'published') {receipts = 1}

      return Response.json({ ...occurrence, grants: undefined, budget: undefined, state: 'completed', outcome: 'answered',
        ...(op === 'published' ? { publishedEvent: '$answer' } : {}) })
    }

    if (String(url).endsWith('/jobs/grant')) {
      checks++

      if (crash === 'cancel_grant') {stop.abort()}
      const { token: _token, ...active } = model

      return Response.json({ ...active, state: 'active', owner: randomUUID(), agentPrincipal: f.home.agentPrincipal, reservationId })
    }

    calls++

    if (crash === 'authority_loss' || crash.startsWith('cancel_')) {stop.abort()}
    expect(new Headers(init?.headers).get('x-atum-model-grant')).toBe(model.token)
    const body = JSON.parse(String(init?.body))

    const result = { id: 'completion', object: 'chat.completion', created: 1, model: 'private-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Native child answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }

    if (body.stream) {
      return new Response(`data: ${JSON.stringify({ ...result, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Native child answer' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...result, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }

    return Response.json(result)
  } }

  const nativeDefinition = { id: 'managed', name: 'Native proof', prompt: 'Say Native child answer.', skills: [], skill: null,
    model: null, provider: null, base_url: null, script: null, no_agent: false, monitor_script: null, monitor_url: null,
    context_from: null, schedule: { kind: 'once' as const, run_at: new Date().toISOString(), display: 'once' }, schedule_display: 'once',
    repeat: { times: null, completed: 0 as const }, deliver: 'origin' as const,
    origin: { platform: 'atum' as const, kind: 'managed_job' as const, job_id: 'managed' }, enabled_toolsets: [], workdir: null,
    attach_to_session: false as const, reasoning_effort: null, failure_deliver: null, interpreter: null }

  const fire = { jobId: 'managed', definitionRevision: 1, definitionDigest: 'a'.repeat(64), nativeDefinition,
      atumExtension: { profile: 'atum.managed-job-extension/1', source: { kind: 'routine', routineId: randomUUID() },
        creator: { kind: 'user', templateKey: null, originalHomeJobId: null },
        routine: { schedule: { kind: 'once', runAt: new Date().toISOString() }, timezone: 'UTC', notifications: true },
        execution: { class: 'agent_turn', budgetClass: 'scheduled_occurrence', audiencePolicyRef: 'agent-room/current', sourcePolicyRef: 'agent-runtime/current' } },
      arm: { armId: randomUUID(), executionGeneration: 1, occurrenceAt: Date.now(), nextTrigger: 'scheduled', catchupWindowMs: 120000, claimExpiresAt: null, state: 'claimed' } }

  const occurrence = { occurrenceId, state: 'dispatched', scheduleId: 'managed', occurrenceAt: Date.now(), agentPrincipal: f.home.agentPrincipal,
      executorId, roomId: '!home:test', budget: { reservationId, funding: 'trial', ceilingMicroProtons: 1000, computeSeconds: 90, firstAdmission: true }, grants: { model } }

  const client = new MacJobsClient(transport)

  const options = { runtime: { python: path.join(root, '.venv/bin/python'), source: root, profiles: temp, workspaceHome: temp },
      owner: '@owner:atum.test', executorId, assistantId: f.assistantId, principal: f.home.agentPrincipal, home: path.join(temp, 'a'.repeat(64)),
      room: () => '!home:test', baseUrl: 'https://gateway.test/v1', transport, client, delivery: makeDelivery(), signal: stop.signal }

  try {
    if (crash === 'authority_loss' || crash.startsWith('cancel_')) {
      await expect(tickMacJobs(options)).rejects.toThrow()
      await expect(tickMacJobs(options)).rejects.toThrow()
      expect(calls).toBe(crash === 'authority_loss' ? 1 : 0)
      expect(output).toHaveLength(0)
      expect(settlements).toBe(0)

      return
    }

    if (crash === 'lost_dispatch' || crash === 'conflict') {
      await expect(tickMacJobs(options)).rejects.toThrow()
      await tickMacJobs(options)
      expect(dispatches).toBe(1)
      expect(calls).toBe(0)
      expect(output).toHaveLength(0)
      expect(armCompleted).toBe(true)

      return
    }

    if (crash === 'vault_persist') {
      await expect(tickMacJobs(options)).rejects.toThrow('mac_job_durable_delivery_unavailable')
      expect(failedOccurrences).toBe(1)
      expect(armCompleted).toBe(false)
    } else if (['none', 'vault_transient'].includes(crash)) {
      await tickMacJobs(options)
    } else {
      await expect(tickMacJobs(options)).rejects.toThrow('mac_job_delivery_pending')
    }

    expect(calls).toBe(1)
    expect(checks).toBe(calls)

    if (['after_persist', 'vault_persist'].includes(crash)) {expect(settlements).toBe(0)}

    if (['after_publish', 'vault_receipt'].includes(crash)) {expect(settlements).toBe(1)}
    fault = false
    // Discard the whole delivery instance: only persisted outbox plus remote events survive.
    await tickMacJobs({ ...options, delivery: makeDelivery() })
    await tickMacJobs({ ...options, delivery: makeDelivery() })
    expect(calls).toBe(1)
    expect(dispatches).toBe(1)

    if (crash === 'vault_persist') {
      expect(output).toHaveLength(0)
      expect(settlements).toBe(0)

      return
    }

    expect(output).toHaveLength(1)
    expect(output[0]).toContain('Native child answer')
    expect(settlements).toBe(1)
    expect(receipts).toBe(1)
    expect(armCompleted).toBe(true)
  } finally { stop.abort(); await rm(temp, { recursive: true, force: true }) }
}, 120000)

it('keeps scheduling after a failed tick, backing off, until the lifecycle aborts', async () => {
  const stop = new AbortController()
  const home = { ownerUserId: '@o:test', agentPrincipal: randomUUID(), homeId: randomUUID(), homeEpoch: 1, executorTerm: 1, leaseId: randomUUID(), leaseExpiresAtPlatform: 1 }

  const fire = vi.fn()
    .mockRejectedValueOnce(new Error('mac_job_unavailable'))
    .mockResolvedValueOnce({ code: 'busy' })
    .mockImplementation(async () => {
      stop.abort()

      return { profile: 'atum.controller-job-fire/1', operation: 'claimed', agentPrincipal: home.agentPrincipal, fire: null }
    })

  const pauses: number[] = []
  const log = vi.fn()
  await runMacJobs({ signal: stop.signal, assistantId: randomUUID(), executorId: randomUUID(), principal: home.agentPrincipal,
    client: { fire } as unknown as MacJobsClient, delivery: { resume: async () => {} } as unknown as MatrixCronDelivery,
    transport: { authority: async () => home } as never, log, pause: async ms => void pauses.push(ms) } as never)
  expect(fire).toHaveBeenCalledTimes(3)
  expect(pauses).toEqual([2000, 4000, 1000])
  expect(log.mock.calls.map(call => call[0])).toEqual(['[Matrix] managed job tick deferred: mac_job_unavailable', '[Matrix] managed job tick deferred: mac_job_busy'])
})
