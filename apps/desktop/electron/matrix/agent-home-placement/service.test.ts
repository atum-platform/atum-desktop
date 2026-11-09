import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createHomeRuntimeOps } from './runtime-adapter'
import { AgentHomeService } from './service'
import { createServiceNode, type ServiceNode, settleServices } from './service.fixture'
import { createWorld, signal } from './world.fixture'

const read = (node: ServiceNode, relative: string): string | null => {
  const file = path.join(node.home, relative)

  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

async function twoMacs() {
  const w = await createWorld({ at: 'a' })

  const a = createServiceNode(w, w.a, {
    files: { 'memories/MEMORY.md': 'A: the code word is lotus.', 'SOUL.md': 'You are Test.', 'skills/notes/SKILL.md': '# Notes' }
  })

  const b = createServiceNode(w, w.b, { files: { 'SOUL.md': 'You are Test.' } })

  return { w, a, b }
}

describe('an agent the model has not taken over', () => {
  it('is looked at and never touched: no hold, nothing stopped, nothing started', async () => {
    const { w, a, b } = await twoMacs()

    await settleServices(w, [a, b], 4)

    for (const node of [a, b]) {
      expect(node.service.holds(w.agent)).toBe(false)
      expect(node.handle.calls).toEqual([])
      expect(node.journal.read(w.agent).managed).toBe(false)
    }

    expect(a.service.view(w.agent)).toMatchObject({ lives: { kind: 'mac', thisMac: true }, move: null, canMove: true })
    expect(b.service.view(w.agent)).toMatchObject({ lives: { kind: 'mac', thisMac: false }, move: null, canMove: true })
    // Both can still say what they like: today's rules govern.
    expect(await a.handle.say('hello')).toBe('sent')
    expect(await b.handle.say('hello')).toBe('sent')
  })

  it('is looked at slowly, so many agents and a long evening cost the platform little', async () => {
    const { w, a } = await twoMacs()

    await a.service.tick()
    const first = w.stub.requests.length
    expect(first).toBeGreaterThan(0)

    // Three seconds on: not due again, as it is not managed.
    w.clock.advance(3_000)
    await a.service.tick()
    expect(w.stub.requests.length).toBe(first)

    w.clock.advance(30_000)
    await a.service.tick()
    expect(w.stub.requests.length).toBeGreaterThan(first)
  })

  it('does nothing at all while signed out, or before the account is known', async () => {
    const w = await createWorld({ at: 'a' })
    let ready = false
    const a = createServiceNode(w, w.a, { ready: () => ready })

    await a.service.tick()
    expect(w.stub.requests).toHaveLength(0)

    ready = true
    await a.service.tick()
    expect(w.stub.requests.length).toBeGreaterThan(0)
  })

  it('asks a platform that has no such routes once in a while, not on every beat', async () => {
    const { w, a } = await twoMacs()
    w.stub.unsupported = 'absent'

    for (let i = 0; i < 6; i += 1) {
      a.service.kick()
      await a.service.tick()
      w.clock.advance(35_000)
    }

    expect(w.stub.requests).toHaveLength(1)
    expect(a.service.view(w.agent)).toBeNull()
    expect(a.service.holds(w.agent)).toBe(false)
    expect(await a.service.move(w.agent, w.b.deviceServiceId)).toEqual({ ok: false, reason: 'unsupported' })
  })
})

describe('a manual move between two Macs and back', () => {
  it('resumes a returned forced-ready source after cancellation, including a stale acknowledgement from an older move', async () => {
    const { w, a, b } = await twoMacs()
    await a.service.move(w.agent, b.mac.deviceServiceId)
    await a.controller.reconcile(w.agent, signal())
    const move = a.journal.read(w.agent).move!
    // This source returns with only an older move journal. The platform has accepted offline recovery already.
    a.journal.update(w.agent, entry => { entry.move = { ...move, moveId: '00000000-0000-4000-8000-8cca3400b26b' } })
    const drains = a.handle.calls.filter(call => call === 'drain').length
    await a.controller.reconcile(w.agent, signal())
    expect(a.journal.read(w.agent).move).toMatchObject({ moveId: move.moveId, phase: 'drained', forced: true })
    expect(a.journal.read(w.agent).move?.ackedAt).toBeUndefined()
    expect(a.holds.reasons(w.agent)).toContain('standDown')
    expect(a.handle.calls.filter(call => call === 'drain')).toHaveLength(drains)
    a.restart()
    a.holds.seed(w.agent)
    expect(a.holds.reasons(w.agent)).toContain('standDown')
    expect(await a.controller.cancelMove(w.agent, signal())).toEqual({ ok: true })
    await a.controller.reconcile(w.agent, signal())
    expect(a.journal.read(w.agent).move).toBeUndefined()
    expect(a.holds.has(w.agent)).toBe(false)
    expect(a.handle.up).toBe(true)
    expect(await a.handle.say('home again')).toBe('sent')
  })

  it('keeps a quarantine copy when a forced-ready source commits elsewhere', async () => {
    const { w, a, b } = await twoMacs()
    await a.service.move(w.agent, b.mac.deviceServiceId)
    await a.controller.reconcile(w.agent, signal())
    a.journal.update(w.agent, entry => { entry.move = undefined })
    writeFileSync(path.join(a.home, 'memories/MEMORY.md'), 'post-checkpoint source state')
    await a.controller.reconcile(w.agent, signal())
    await b.controller.reconcile(w.agent, signal())
    await a.controller.reconcile(w.agent, signal())
    expect(a.tool.exports).toHaveLength(1)
    expect(a.tool.exports[0]!.out.startsWith(path.join(a.root, 'quarantine', w.agent))).toBe(true)
    const kept = JSON.parse(readFileSync(a.tool.exports[0]!.out, 'utf8')) as { files: Record<string, string> }
    expect(Buffer.from(kept.files['memories/MEMORY.md']!, 'base64').toString()).toBe('post-checkpoint source state')
    expect(a.journal.read(w.agent).move).toBeUndefined()
    expect(a.handle.up).toBe(false)
  })

  it.each([false, true])('lets a slow cold gate progress without restart churn and keeps reporting readiness (interrupted journal: %s)', async interrupted => {
    const { w, a, b } = await twoMacs()
    const modelGate = vi.fn(async () => true)
    const restart = b.handle.restart.bind(b.handle)
    b.handle.restart = () => { restart(); b.handle.up = false }
    // Use the app's real runtime adapter with a live model gate; the fake host acquires a real stub lease.
    const ops = createHomeRuntimeOps({ handle: () => b.handle, holds: b.holds, modelGate })
    Object.assign(b.controller.ctx.runtime, ops)
    await a.service.move(w.agent, b.mac.deviceServiceId)
    await a.controller.reconcile(w.agent, signal())
    if (interrupted) {
      b.controller.ctx.step = name => {
        if (name === 'target:activated') {
          b.controller.ctx.step = undefined
          throw new Error('interrupted_after_startup')
        }
      }
      await expect(b.controller.reconcile(w.agent, signal())).rejects.toThrow('interrupted_after_startup')
      expect(b.journal.read(w.agent).move).toMatchObject({ activationStarted: true })
      await b.controller.reconcile(w.agent, signal())
    } else {
      await b.controller.reconcile(w.agent, signal())
    }
    await a.controller.reconcile(w.agent, signal())
    expect(b.journal.read(w.agent).move).toBeUndefined()
    const reportsBefore = w.stub.requests.filter(request => request.path.endsWith('/readiness')).length
    for (let pass = 0; pass < 3; pass += 1) {
      w.clock.advance(60_001)
      await b.controller.reconcile(w.agent, signal())
      expect(b.controller.view(w.agent)).toMatchObject({ activation: { state: 'not_ready' } })
      expect(w.stub.readiness(w.agent)).toMatchObject({ reachable: false })
    }
    expect(b.handle.calls.filter(call => call === 'restart')).toHaveLength(1)
    expect(modelGate).toHaveBeenCalledTimes(1)
    expect(w.stub.requests.filter(request => request.path.endsWith('/readiness'))).toHaveLength(reportsBefore + 3)
    b.handle.up = true
    w.clock.advance(60_001)
    await b.controller.reconcile(w.agent, signal())
    expect(w.stub.readiness(w.agent)).toMatchObject({ reachable: true })
    expect(b.controller.view(w.agent)).toMatchObject({ activation: { state: 'ready', reason: null } })
    expect(b.handle.calls.filter(call => call === 'restart')).toHaveLength(1)
  })

  it('holds the agent on exactly the Mac that is not its home, and hands the home over with its memory', async () => {
    const { w, a, b } = await twoMacs()
    await settleServices(w, [a, b], 2)

    const asked = await a.service.move(w.agent, w.b.deviceServiceId)
    expect(asked.ok).toBe(true)
    await settleServices(w, [a, b])

    expect(w.stub.placement(w.agent)).toMatchObject({ location: { kind: 'mac', deviceServiceId: w.b.deviceServiceId }, homeEpoch: 2, activeMove: null })

    // The MacBook stopped and is held; the Mac mini runs it, from a fresh start, with the MacBook's memory.
    expect(a.service.holds(w.agent)).toBe(true)
    expect(a.handle.up).toBe(false)
    expect(b.service.holds(w.agent)).toBe(false)
    expect(b.handle.up).toBe(true)
    expect(b.handle.freshSessions).toBe(1)
    expect(read(b, 'memories/MEMORY.md')).toBe('A: the code word is lotus.')

    expect(a.service.view(w.agent)).toMatchObject({ lives: { kind: 'mac', deviceServiceId: w.b.deviceServiceId, thisMac: false }, move: null })
    expect(b.service.view(w.agent)).toMatchObject({ lives: { kind: 'mac', deviceServiceId: w.b.deviceServiceId, thisMac: true }, move: null })

    // Only the home speaks.
    expect(await a.handle.say('still here?')).toBe('refused')
    expect(await b.handle.say('here')).toBe('sent')

    // And back again, with what the Mac mini learnt meanwhile.
    writeFileSync(path.join(b.home, 'memories/learned-on-b.md'), 'learned on B')
    expect((await b.service.move(w.agent, w.a.deviceServiceId)).ok).toBe(true)
    await settleServices(w, [a, b])

    expect(w.stub.placement(w.agent)).toMatchObject({ location: { kind: 'mac', deviceServiceId: w.a.deviceServiceId }, homeEpoch: 3, activeMove: null })
    expect(a.service.holds(w.agent)).toBe(false)
    expect(a.handle.up).toBe(true)
    expect(a.handle.freshSessions).toBe(1)
    expect(read(a, 'memories/learned-on-b.md')).toBe('learned on B')
    expect(b.service.holds(w.agent)).toBe(true)
    expect(b.handle.up).toBe(false)
    expect(await b.handle.say('late')).toBe('refused')
    expect(await a.handle.say('back')).toBe('sent')
  })

  it('keeps the target Mac off the agent while the move is still being prepared', async () => {
    const { w, a, b } = await twoMacs()
    await settleServices(w, [a, b], 2)
    expect((await a.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)

    // The target hears of the move and is held at once; the source has not finished draining yet.
    b.service.kick()
    await b.service.tick()
    expect(b.service.holds(w.agent)).toBe(true)
    expect(b.journal.read(w.agent).standDown).toBe(true)
    expect(b.handle.up).toBe(false)

    // Cancelled before anything was committed: the target stays off it, the source goes on.
    expect((await a.service.cancel(w.agent)).ok).toBe(true)
    await settleServices(w, [a, b], 4)
    expect(w.stub.placement(w.agent).location).toEqual({ kind: 'mac', deviceServiceId: w.a.deviceServiceId })
    expect(a.service.holds(w.agent)).toBe(false)
    expect(a.handle.up).toBe(true)
    expect(b.service.holds(w.agent)).toBe(true)
  })

  it('lets the turn in flight finish and say its piece before the home moves', async () => {
    const { w, a, b } = await twoMacs()
    await settleServices(w, [a, b], 2)
    a.handle.startTurn()
    expect((await a.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)

    // The drain waits for the turn: the MacBook is held, still the home, and can still publish.
    a.service.kick()
    const draining = a.service.tick()

    for (let spins = 0; spins < 200 && !a.handle.calls.includes('drain'); spins += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    expect(a.handle.calls).toContain('drain')
    expect(a.service.holds(w.agent)).toBe(true)
    expect(w.stub.placement(w.agent).location).toEqual({ kind: 'mac', deviceServiceId: w.a.deviceServiceId })
    expect(await a.handle.say('the answer, in flight')).toBe('sent')

    a.handle.turn!.finish()
    await draining
    await settleServices(w, [a, b])
    expect(w.stub.placement(w.agent).location).toEqual({ kind: 'mac', deviceServiceId: w.b.deviceServiceId })
  })
})

describe('a restart', () => {
  it('leaves a Mac that stood down stopped before the platform has been asked, and unable to speak when it is down', async () => {
    const { w, a, b } = await twoMacs()
    await settleServices(w, [a, b], 2)
    expect((await a.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)
    await settleServices(w, [a, b])
    expect(a.service.holds(w.agent)).toBe(true)

    a.restart()
    b.restart()

    // No beat has run on either: the hold comes from the journal alone.
    expect(a.service.holds(w.agent)).toBe(true)
    expect(b.service.holds(w.agent)).toBe(false)

    // The platform is down: a managed agent fails closed, so the stood-down Mac says nothing.
    w.stub.failNext = { status: 500 }
    w.clock.advance(10_000)
    expect(await a.handle.say('hello?')).toBe('refused')
  })

  it('finishes a move whose commit landed while the source was closed', async () => {
    const { w, a, b } = await twoMacs()
    await settleServices(w, [a, b], 2)
    expect((await a.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)

    // The source drains and checkpoints, then the app quits; the target commits meanwhile.
    a.service.kick()
    await a.service.tick()
    expect(a.service.holds(w.agent)).toBe(true)
    a.restart()
    expect(a.service.holds(w.agent)).toBe(true)

    await settleServices(w, [b], 4)
    expect(w.stub.placement(w.agent).location).toEqual({ kind: 'mac', deviceServiceId: w.b.deviceServiceId })

    await settleServices(w, [a], 3)
    expect(a.service.holds(w.agent)).toBe(true)
    expect(a.journal.read(w.agent).standDown).toBe(true)
    expect(a.journal.read(w.agent).move).toBeUndefined()
    expect(a.handle.up).toBe(false)
  })
})

describe('what the owner can do', () => {
  it('is told before anything is disturbed when the platform cannot finish a move', async () => {
    const { w, a, b } = await twoMacs()
    await settleServices(w, [a, b], 2)

    // The placement routes are there; the archive and key routes are not (they are not in #653).
    w.stub.archiveRoutes = false

    expect(await a.service.move(w.agent, w.b.deviceServiceId)).toEqual({ ok: false, reason: 'unsupported' })
    await settleServices(w, [a, b], 3)

    expect(w.stub.placement(w.agent).activeMove).toBeNull()
    expect(a.handle.calls).toEqual([])
    expect(b.handle.calls).toEqual([])
    expect(a.service.holds(w.agent)).toBe(false)
    expect(await a.handle.say('still here')).toBe('sent')
  })

  it('cannot move an agent that is not on a Mac of theirs, or onto the Mac it already is on', async () => {
    const { w, a } = await twoMacs()
    await settleServices(w, [a], 1)

    expect(await a.service.move(w.agent, w.a.deviceServiceId)).toEqual({ ok: false, reason: 'already_there' })
  })

  it('is told when nothing can be done because the account is not ready', async () => {
    const w = await createWorld({ at: 'a' })
    const a = createServiceNode(w, w.a, { ready: () => false })

    expect(await a.service.move(w.agent, w.b.deviceServiceId)).toEqual({ ok: false, reason: 'unavailable' })
    expect(await a.service.cancel(w.agent)).toEqual({ ok: false })
  })

  it('is told when the view changes, once per change', async () => {
    const { w, a, b } = await twoMacs()
    await settleServices(w, [a, b], 2)
    const before = a.changes
    await settleServices(w, [a, b], 2)
    expect(a.changes).toBe(before)

    expect((await a.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)
    await settleServices(w, [a, b], 4)
    expect(a.changes).toBeGreaterThan(before)
  })
})

describe('an agent that leaves this Mac', () => {
  it('is forgotten everywhere it was kept: holds, checkpoint cadence, and whatever the connection model kept', async () => {
    const agents = ['agent-a', 'agent-b']
    const forgotten: string[] = []
    const service = new AgentHomeService({
      controller: {
        reconcile: async () => null,
        view: () => null,
        ctx: { journal: { read: () => ({ managed: false }) } }
      } as never,
      holds: { seed: () => undefined, has: () => false, forget: (agent: string) => forgotten.push(`holds:${agent}`) } as never,
      agents: () => agents,
      ready: () => true,
      scope: () => 'account:1',
      forget: agent => forgotten.push(`connection:${agent}`)
    })

    await service.tick()
    expect(forgotten).toEqual([])

    agents.pop()
    await service.tick()

    expect(forgotten).toEqual(['holds:agent-b', 'connection:agent-b'])
  })
})


it('polls managed idle agents slowly, keeps moves fast, and kick bypasses the deadline', async () => {
  const { w, a } = await twoMacs()
  await a.service.tick()
  const idle = a.service.view(w.agent)!
  a.journal.update(w.agent, entry => { entry.managed = true })
  const reconcile = vi.spyOn(a.controller, 'reconcile').mockResolvedValue(idle)
  // Use the real service timer, with the fixture platform clock advanced alongside it.
  vi.useFakeTimers()
  const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
      w.clock.advance(1_000)
      await vi.advanceTimersByTimeAsync(1_000)
    }
  }
  try {
    a.service.start()
    await advance(29_000)
    expect(reconcile).not.toHaveBeenCalled()
    await advance(1_000)
    expect(reconcile).toHaveBeenCalledTimes(1)
    reconcile.mockResolvedValue({ ...idle, move: { step: 'saving', role: 'source',
      from: { kind: 'mac', deviceServiceId: w.a.deviceServiceId },
      to: { kind: 'mac', deviceServiceId: w.b.deviceServiceId } } })
    a.service.kick(w.agent)
    await vi.advanceTimersByTimeAsync(0)
    expect(reconcile).toHaveBeenCalledTimes(2)
    await advance(4_000)
    expect(reconcile).toHaveBeenCalledTimes(3)
    reconcile.mockResolvedValue(idle)
    await advance(4_000)
    expect(reconcile).toHaveBeenCalledTimes(4)
    await advance(29_000)
    expect(reconcile).toHaveBeenCalledTimes(4)
    await advance(1_000)
    expect(reconcile).toHaveBeenCalledTimes(5)
  } finally { a.service.stop(); vi.useRealTimers() }
})
