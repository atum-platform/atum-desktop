import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test, vi } from 'vitest'

import { type ClaimedPrivateAdvisoryJob, PrivateAdvisoryRunner } from './private-advisory-runner'

const accountId = '00000000-0000-4000-8000-bd7662a5eeb4'
const jobId = '00000000-0000-4000-8000-b454f82c5857'
const conversationId = '00000000-0000-4000-8000-f6222a1106ee'
const targetId = '00000000-0000-4000-8000-f1d11edf5c5c'

function job(): ClaimedPrivateAdvisoryJob {
  return {
    job_id: jobId,
    lease_token: 'lease-secret',
    request: {
      job_id: jobId,
      turn_id: '00000000-0000-4000-8000-fbfe405ca65f',
      conversation_id: conversationId,
      source_message_id: '00000000-0000-4000-8000-a9703d75e616',
      round: { id: '00000000-0000-4000-8000-f2da1f9533d4', slot: 1 },
      audience_revision: 1,
      target: { type: 'assistant', id: targetId },
      subject: null,
      context: {
        mode: 'private_advisory',
        conversation_id: conversationId,
        audience_revision: 1,
        advisor: { kind: 'assistant', id: targetId },
        context_revision: 1,
        invalidations: [],
        messages: [
          {
            id: '00000000-0000-4000-8000-c8f367a876b2',
            version: 1,
            sequence: 1,
            speaker: { kind: 'owner', id: accountId },
            text: 'Help.'
          }
        ],
        watermark: { sequence: 1, message_id: '00000000-0000-4000-8000-c8f367a876b2' }
      }
    }
  }
}

test('advisory runner keeps the lease in main, persists completion, and never regenerates a replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atum-advisory-runner-'))
  const dispatch = vi.fn()

  const client = {
    status: vi.fn(async () => ({ accountId })),
    advisoryClaim: vi.fn(async () => ({ job: job(), replayed: false })),
    advisoryComplete: vi.fn(async () => undefined),
    advisoryFail: vi.fn(async () => undefined),
    advisoryPreflight: vi.fn(async () => job().request),
    advisoryHeartbeat: vi.fn(),
    advisoryRefresh: vi.fn()
  }

  const runner = new PrivateAdvisoryRunner(client as never, join(directory, 'jobs.json'), dispatch, vi.fn())

  await runner.claim('00000000-0000-4000-8000-e8d95748107a')
  assert.equal(dispatch.mock.calls[0]?.[0].request.target.id, targetId)
  assert.equal(JSON.stringify(dispatch.mock.calls[0]).includes('lease-secret'), false)
  assert.equal((await readFile(join(directory, 'jobs.json'), 'utf8')).includes('lease-secret'), false)
  await runner.running(jobId, 'runtime-1')
  await runner.complete(jobId, 'A real Hermes reply.')
  await runner.claim('00000000-0000-4000-8000-303617b97302')

  assert.equal(client.advisoryComplete.mock.calls.length, 2)
  assert.equal(dispatch.mock.calls.length, 1)
  assert.equal(client.advisoryClaim.mock.calls.length, 2)
})

test('account revocation cancels the background profile turn and rejects late completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atum-advisory-runner-'))
  const cancel = vi.fn()

  const client = {
    status: vi.fn(async () => ({ accountId })),
    advisoryClaim: vi.fn(async () => ({ job: job(), replayed: false })),
    advisoryComplete: vi.fn(async () => undefined),
    advisoryFail: vi.fn(async () => undefined),
    advisoryPreflight: vi.fn(async () => job().request),
    advisoryHeartbeat: vi.fn(),
    advisoryRefresh: vi.fn()
  }

  const runner = new PrivateAdvisoryRunner(client as never, join(directory, 'jobs.json'), vi.fn(), cancel)
  await runner.claim('00000000-0000-4000-8000-00f765af1c54')
  await runner.running(jobId, 'runtime-1')
  await runner.revokeAll()

  assert.deepEqual(cancel.mock.calls[0], [jobId, 'runtime-1', null])
  await assert.rejects(runner.complete(jobId, 'late'), /not_active/)
  assert.equal(client.advisoryComplete.mock.calls.length, 0)
})

test('reclaim publishes a durable reply after the original completion acknowledgement is lost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atum-advisory-runner-'))

  const first = {
    status: vi.fn(async () => ({ accountId })),
    advisoryClaim: vi.fn(async () => ({ job: job(), replayed: false })),
    advisoryComplete: vi.fn(async () => {
      throw new Error('network_lost')
    }),
    advisoryFail: vi.fn(),
    advisoryPreflight: vi.fn(async () => job().request),
    advisoryHeartbeat: vi.fn(),
    advisoryRefresh: vi.fn()
  }

  const runner = new PrivateAdvisoryRunner(first as never, join(directory, 'jobs.json'), vi.fn(), vi.fn())
  await runner.claim('00000000-0000-4000-8000-50d86b120e98')
  await runner.running(jobId, 'runtime-1')
  await assert.rejects(runner.complete(jobId, 'canonical reply'), /network_lost/)

  const recovered = {
    status: vi.fn(async () => ({ accountId })),
    advisoryClaim: vi.fn(async () => ({ job: job(), replayed: true })),
    advisoryComplete: vi.fn(async () => undefined),
    advisoryFail: vi.fn(),
    advisoryPreflight: vi.fn(async () => job().request),
    advisoryHeartbeat: vi.fn(),
    advisoryRefresh: vi.fn()
  }

  const afterRestart = new PrivateAdvisoryRunner(recovered as never, join(directory, 'jobs.json'), vi.fn(), vi.fn())
  const result = await afterRestart.claim('00000000-0000-4000-8000-0bb5de138389')

  assert.deepEqual(result, { claimed: false, replayed: true, jobId })
  assert.deepEqual(recovered.advisoryComplete.mock.calls[0], [conversationId, jobId, 'lease-secret', 'canonical reply'])
})

test('account change during claim prevents dispatch under the stale account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atum-advisory-runner-'))
  const dispatch = vi.fn()

  const client = {
    status: vi
      .fn()
      .mockResolvedValueOnce({ accountId })
      .mockResolvedValueOnce({ accountId: '00000000-0000-4000-8000-6cc9b1298c8f' }),
    advisoryClaim: vi.fn(async () => ({ job: job(), replayed: false })),
    advisoryComplete: vi.fn(),
    advisoryFail: vi.fn(),
    advisoryPreflight: vi.fn(async () => job().request),
    advisoryHeartbeat: vi.fn(),
    advisoryRefresh: vi.fn()
  }

  const runner = new PrivateAdvisoryRunner(client as never, join(directory, 'jobs.json'), dispatch, vi.fn())
  await assert.rejects(runner.claim('00000000-0000-4000-8000-2dab195ed4f7'), /account_changed/)
  assert.equal(dispatch.mock.calls.length, 0)
})

test('heartbeat fences edited context by interrupting the old session and redispatching the new projection', async () => {
  vi.useFakeTimers()

  try {
    const directory = await mkdtemp(join(tmpdir(), 'atum-advisory-runner-'))
    const dispatch = vi.fn()
    const cancel = vi.fn()
    const revised = job().request
    revised.context = {
      ...revised.context,
      context_revision: 2,
      invalidations: [{ message_id: revised.source_message_id, version: 1, kind: 'superseded' }]
    }

    const client = {
      status: vi.fn(async () => ({ accountId })),
      advisoryClaim: vi.fn(async () => ({ job: job(), replayed: false })),
      advisoryPreflight: vi.fn(async () => job().request),
      advisoryHeartbeat: vi.fn(async () => ({ request: revised, nextHeartbeatSeconds: 30 })),
      advisoryComplete: vi.fn(),
      advisoryFail: vi.fn(),
      advisoryRefresh: vi.fn()
    }

    const runner = new PrivateAdvisoryRunner(client as never, join(directory, 'jobs.json'), dispatch, cancel)
    await runner.claim('00000000-0000-4000-8000-cd2a20671fb6')
    await runner.running(jobId, 'runtime-1', 'stored-1')
    await (runner as any).heartbeat(jobId)

    assert.deepEqual(cancel.mock.calls[0], [jobId, 'runtime-1', 'stored-1'])
    assert.equal(dispatch.mock.calls.length, 2)
    assert.equal(dispatch.mock.calls[1]?.[0].request.context.context_revision, 2)
    assert.equal(dispatch.mock.calls[1]?.[0].runtime_session_id, null)
  } finally {
    vi.useRealTimers()
  }
})

test('history reads use only the active runtime job and survive a compaction continuation', async () => {
  vi.useFakeTimers()

  try {
    const directory = await mkdtemp(join(tmpdir(), 'atum-advisory-search-scope-'))

    const client = {
      status: vi.fn(async () => ({ accountId })),
      advisoryClaim: vi.fn(async () => ({ job: job(), replayed: false })),
      advisoryPreflight: vi.fn(async () => job().request),
      advisoryHeartbeat: vi.fn()
    }

    const runner = new PrivateAdvisoryRunner(client as never, join(directory, 'jobs.json'), vi.fn(), vi.fn())
    assert.equal(await runner.searchConversation(accountId, 'new-runtime', targetId, 'desktop'), null)
    await assert.rejects(runner.searchConversation(accountId, 'new-runtime', targetId, 'atum-private-advisory'))
    await runner.claim('00000000-0000-4000-8000-7d338194c358')
    await runner.running(jobId, 'runtime', 'original', 'advisor')
    assert.equal(
      await runner.searchConversation(accountId, 'runtime', targetId, 'atum-private-advisory'),
      conversationId
    )
    await assert.rejects(runner.searchConversation(accountId, 'runtime', 'wrong-advisor', 'atum-private-advisory'))
    await runner.cancelConversation(conversationId)
    await assert.rejects(runner.searchConversation(accountId, 'runtime', targetId, 'atum-private-advisory'))
  } finally {
    vi.useRealTimers()
  }
})

test('renderer attachment preflights and redelivers the existing Hermes runtime without persisted meeting text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atum-advisory-runner-'))
  const dispatch = vi.fn()

  const client = {
    status: vi.fn(async () => ({ accountId })),
    advisoryClaim: vi.fn(async () => ({ job: job(), replayed: false })),
    advisoryComplete: vi.fn(),
    advisoryFail: vi.fn(),
    advisoryHeartbeat: vi.fn(),
    advisoryRefresh: vi.fn(),
    advisoryPreflight: vi.fn(async () => job().request)
  }

  const runner = new PrivateAdvisoryRunner(client as never, join(directory, 'jobs.json'), dispatch, vi.fn())
  await runner.claim('00000000-0000-4000-8000-dea2ac90c00c')
  await runner.running(jobId, 'runtime-live', 'stored-live', 'andy')
  const state = await readFile(join(directory, 'jobs.json'), 'utf8')
  assert.equal(state.includes('Help.'), false)

  dispatch.mockClear()
  await runner.attachRenderer()

  assert.equal(client.advisoryPreflight.mock.calls.length, 2)
  assert.deepEqual(dispatch.mock.calls[0]?.[0], {
    job_id: jobId,
    request: job().request,
    runtime_session_id: 'runtime-live',
    durable_session_id: 'stored-live',
    account_id: accountId
  })
})

test('main restart recovers an active job only after a new claim/preflight and never needs cached context text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atum-advisory-runner-'))

  const firstClient = {
    status: vi.fn(async () => ({ accountId })),
    advisoryClaim: vi.fn(async () => ({ job: job(), replayed: false })),
    advisoryComplete: vi.fn(),
    advisoryFail: vi.fn(),
    advisoryHeartbeat: vi.fn(),
    advisoryRefresh: vi.fn(),
    advisoryPreflight: vi.fn(async () => job().request)
  }

  const first = new PrivateAdvisoryRunner(firstClient as never, join(directory, 'jobs.json'), vi.fn(), vi.fn())
  await first.claim('00000000-0000-4000-8000-ba5aca4031c9')
  await first.running(jobId, 'runtime-before-restart', 'stored-before-restart', 'andy')

  const dispatch = vi.fn()

  const restartedClient = {
    status: vi.fn(async () => ({ accountId })),
    advisoryClaim: vi.fn(async () => ({ job: job(), replayed: true })),
    advisoryComplete: vi.fn(),
    advisoryFail: vi.fn(),
    advisoryHeartbeat: vi.fn(),
    advisoryRefresh: vi.fn(),
    advisoryPreflight: vi.fn(async () => job().request)
  }

  const restarted = new PrivateAdvisoryRunner(restartedClient as never, join(directory, 'jobs.json'), dispatch, vi.fn())
  assert.deepEqual(await restarted.attachRenderer(), { attached: 0 })
  await restarted.claim('00000000-0000-4000-8000-5bf4b25eb065')

  assert.equal(restartedClient.advisoryPreflight.mock.calls.length, 1)
  assert.equal(dispatch.mock.calls.length, 1)
  assert.equal(dispatch.mock.calls[0]?.[0].runtime_session_id, 'runtime-before-restart')
  assert.equal(JSON.stringify(dispatch.mock.calls[0]?.[0]).includes('Help.'), true)
})

test('private runner refuses a shared-group preflight before runtime dispatch or completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atum-shared-refusal-'))
  const dispatch = vi.fn()
  const preflight = job().request
  // Deliberately violate the typed private transport contract, as a stale or
  // malformed server response could. A UI label must never widen execution.
  preflight.context.mode = 'shared_group' as typeof preflight.context.mode
  const client = {
    status: vi.fn(async () => ({ accountId })),
    advisoryClaim: vi.fn(async () => ({ job: job(), replayed: false })),
    advisoryPreflight: vi.fn(async () => preflight),
    advisoryComplete: vi.fn(),
    advisoryFail: vi.fn(),
    advisoryHeartbeat: vi.fn(),
    advisoryRefresh: vi.fn()
  }
  const runner = new PrivateAdvisoryRunner(client as never, join(directory, 'jobs.json'), dispatch, vi.fn())

  await assert.rejects(runner.claim('00000000-0000-4000-8000-95a2db280f1b'), /advisory_preflight_scope_mismatch/)
  assert.equal(dispatch.mock.calls.length, 0)
  assert.equal(client.advisoryComplete.mock.calls.length, 0)
})
