import { randomUUID } from 'node:crypto'

import { expect, it, vi } from 'vitest'

import { AgentHomeJournal } from './agent-home-placement/journal'
import { HomeStanding } from './agent-home-placement/standing'
import { createWorld, requestMove } from './agent-home-placement/world.fixture'
import type { MacJobHomeContext } from './mac-job-lifecycle'
import { macJobAuthority, MacJobLifecycle } from './mac-job-lifecycle'

async function setup() {
  const w = await createWorld({ at: 'a' })
  const journal = new AgentHomeJournal(w.a.store)
  const standing = new HomeStanding({ platform: w.a.platform, journal, me: () => w.a.deviceServiceId, now: w.clock.now })

  const ctx = { platform: w.a.platform, standing, auth: w.a.auth, me: () => w.a.deviceServiceId,
    runtime: { leaseFacts: () => {
      const lease = w.stub.lease(w.agent)

      return lease && lease.expiresAt > w.clock.now()
        ? { leaseId: lease.leaseId, executorTerm: lease.term, leaseExpiresAtPlatform: lease.expiresAt } : null
    } } } satisfies MacJobHomeContext

  const holds = { managed: vi.fn(), clearManaged: vi.fn() }
  const run = vi.fn(async (_selection: unknown, _client: unknown, _signal: AbortSignal) => {})
  let selected = false

  const lifecycle = new MacJobLifecycle({ context: ctx, assistantId: randomUUID(), principal: w.agent, agentKey: 'agent', holds, run,
    request: send => send('mas', 'https://shell.test/api/matrix/v1'),
    fetch: async () => new Response(JSON.stringify({ profile: 'atum.mac-job-snapshot/1', selected, generation: selected ? 'a'.repeat(64) : null,
      managedJobIds: selected ? ['managed'] : [] }), { headers: { 'content-type': 'application/json' } }) })

  return { w, ctx, journal, holds, run, lifecycle, select: () => { selected = true } }
}

it('uses real standing and D1 fences and refuses a home move', async () => {
  const f = await setup()
  expect(await macJobAuthority(f.ctx, f.w.agent, new AbortController().signal)).toMatchObject({ agentPrincipal: f.w.agent, homeEpoch: 1 })
  await requestMove(f.w)
  expect(await macJobAuthority(f.ctx, f.w.agent, new AbortController().signal)).toBeNull()
})

it('leaves unselected jobs on the legacy path and uses only platform generation when selected', async () => {
  const f = await setup()
  await f.lifecycle.refresh()
  expect(f.run).not.toHaveBeenCalled()
  expect(f.holds.managed).not.toHaveBeenCalled()
  f.select()
  await f.lifecycle.refresh()
  expect(f.holds.managed).toHaveBeenCalledWith('agent', ['managed'])
  expect(f.run.mock.calls[0]![0]).toEqual({ generation: 'a'.repeat(64), managedJobIds: ['managed'] })
})

it('cancels in-flight work synchronously and keeps managed inventory on authority loss', async () => {
  const f = await setup()
  f.select()
  let admitted!: () => void
  const started = new Promise<void>(resolve => { admitted = resolve })
  let active!: AbortSignal
  f.run.mockImplementation(async (_selection, _client, signal) => {
    active = signal
    admitted()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  const pending = f.lifecycle.refresh()
  await started
  f.lifecycle.stop()
  expect(active.aborted).toBe(true)
  await pending
  expect(f.holds.clearManaged).not.toHaveBeenCalled()
})

it('waits for cancelled execution cleanup before replacement and drops superseded refreshes', async () => {
  const f = await setup()
  f.select()
  let started!: () => void
  let cleanup!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const cleaned = new Promise<void>(resolve => { cleanup = resolve })
  f.run.mockImplementationOnce(async (_selection, _client, signal) => {
    started()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    await cleaned
  })
  const first = f.lifecycle.refresh()
  await ready
  const obsolete = f.lifecycle.refresh()
  const replacement = f.lifecycle.refresh()
  await Promise.resolve()
  expect(f.run).toHaveBeenCalledTimes(1)
  cleanup()
  await Promise.all([first, obsolete, replacement])
  expect(f.run).toHaveBeenCalledTimes(2)
})

it('allows only pending delivery during the unacknowledged D1 source drain', async () => {
  const f = await setup()
  const signal = new AbortController().signal
  const before = await macJobAuthority(f.ctx, f.w.agent, signal)
  await requestMove(f.w)
  expect(await macJobAuthority(f.ctx, f.w.agent, signal)).toBeNull()
  expect(await macJobAuthority(f.ctx, f.w.agent, signal, true)).toEqual(before)
  const move = f.w.stub.placement(f.w.agent).activeMove!
  f.journal.update(f.w.agent, entry => {
    entry.move = { moveId: move.moveId, idempotencyKey: move.idempotencyKey, role: 'source',
      phase: 'drained', expectedHomeEpoch: 1, expectedPlacementRevision: 1, startedAt: 0, attempts: 0 }
  })
  expect(await macJobAuthority(f.ctx, f.w.agent, signal, true)).toBeNull()
})
