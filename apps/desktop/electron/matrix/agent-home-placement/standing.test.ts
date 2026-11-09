import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { HomeMove, HomePlacement } from './contract'
import { AgentHomeJournal, emptyJournal, type HomeJournal } from './journal'
import type { HomePlatform } from './platform-client'
import {
  AGENT_PUBLISH_KINDS,
  decideStanding,
  guardAgentPublication,
  HomeStanding,
  mayAct,
  mayCheckpoint,
  mayPublish,
  NotTheHomeError,
  placementManages
} from './standing'
import { createWorld, signal } from './world.fixture'

const ME = '00000000-0000-4000-8000-bd7662a5eeb4'
const OTHER = '00000000-0000-4000-8000-b454f82c5857'

const placement = (overrides: Partial<HomePlacement> = {}): HomePlacement => ({
  ownerUserId: '@owner:atum.example',
  agentPrincipal: randomUUID(),
  homeId: randomUUID(),
  location: { kind: 'mac', deviceServiceId: ME },
  homeEpoch: 1,
  placementRevision: 1,
  selectedGeneration: 1,
  rollbackFloorGeneration: 1,
  activeMove: null,
  policyRevision: 1,
  ...overrides
})

const move = (overrides: Partial<HomeMove> = {}): HomeMove => ({
  moveId: randomUUID(),
  idempotencyKey: randomUUID(),
  intent: 'manual',
  status: 'requested',
  source: { kind: 'mac', deviceServiceId: ME },
  target: { kind: 'mac', deviceServiceId: OTHER },
  expectedHomeEpoch: 1,
  expectedPlacementRevision: 1,
  requestedAtPlatform: 1,
  ...overrides
})

const journal = (overrides: Partial<HomeJournal> = {}): HomeJournal => ({ ...emptyJournal('agent'), ...overrides })

describe('whose home it is', () => {
  it('leaves an agent the model has not taken over to today\'s rules', () => {
    const standing = decideStanding({ placement: placement(), me: ME, journal: journal() })

    expect(standing).toEqual({ state: 'legacy' })
    expect(mayAct(standing)).toBe(true)
    expect(mayPublish(standing)).toBe(true)
    expect(mayCheckpoint(standing)).toBe(false)
  })

  it('takes an agent over by an epoch beyond the first, a move, or having seen it managed', () => {
    expect(placementManages(placement({ homeEpoch: 2 }), journal())).toBe(true)
    expect(placementManages(placement({ activeMove: move() }), journal())).toBe(true)
    expect(placementManages(placement(), journal({ managed: true }))).toBe(true)
    expect(placementManages(placement(), journal())).toBe(false)
  })

  it('is the home only when the placement names this exact Mac', () => {
    expect(decideStanding({ placement: placement({ homeEpoch: 2 }), me: ME, journal: journal() })).toMatchObject({ state: 'home' })
    expect(decideStanding({ placement: placement({ homeEpoch: 2, location: { kind: 'mac', deviceServiceId: OTHER } }), me: ME, journal: journal() })).toMatchObject({ state: 'elsewhere' })
    expect(decideStanding({ placement: placement({ homeEpoch: 2, location: { kind: 'cloud' } }), me: ME, journal: journal() })).toMatchObject({ state: 'elsewhere' })
  })

  it('never answers from a Mac that is not the home, and a Mac being moved to is not the home until the commit', () => {
    const target = decideStanding({
      placement: placement({ location: { kind: 'mac', deviceServiceId: OTHER }, activeMove: move({ source: { kind: 'mac', deviceServiceId: OTHER }, target: { kind: 'mac', deviceServiceId: ME }, status: 'ready_to_commit' }) }),
      me: ME,
      journal: journal({ managed: true })
    })

    expect(target).toMatchObject({ state: 'elsewhere' })
    expect(mayAct(target) || mayPublish(target) || mayCheckpoint(target)).toBe(false)
  })

  it('drains: finishes and publishes the turn in flight until its drain is acknowledged, then says nothing more', () => {
    const active = move({ status: 'draining' })
    const before = decideStanding({ placement: placement({ activeMove: active }), me: ME, journal: journal({ managed: true }) })

    expect(before).toMatchObject({ state: 'draining', quiesced: false })
    expect(mayAct(before)).toBe(false)
    expect(mayPublish(before)).toBe(true)
    expect(mayCheckpoint(before)).toBe(true)

    const acknowledged = decideStanding({
      placement: placement({ activeMove: active }),
      me: ME,
      journal: journal({
        managed: true,
        move: { moveId: active.moveId, idempotencyKey: active.idempotencyKey, role: 'source', phase: 'drained', expectedHomeEpoch: 1, expectedPlacementRevision: 1, startedAt: 1 }
      })
    })

    expect(acknowledged).toMatchObject({ state: 'draining', quiesced: true })
    expect(mayPublish(acknowledged)).toBe(false)
    expect(mayCheckpoint(acknowledged)).toBe(true)
  })

  it('is not the home yet while it is bringing the agent up after a commit', () => {
    const standing = decideStanding({
      placement: placement({ homeEpoch: 2 }),
      me: ME,
      journal: journal({
        managed: true,
        move: { moveId: randomUUID(), idempotencyKey: randomUUID(), role: 'target', phase: 'activating', expectedHomeEpoch: 1, expectedPlacementRevision: 1, startedAt: 1 }
      })
    })

    expect(standing).toMatchObject({ state: 'activating' })
    expect(mayAct(standing) || mayPublish(standing)).toBe(false)
  })
})

describe('asking the platform', () => {
  it('believes a verdict that lets it act for a few seconds, and asks again once that has passed', async () => {
    const w = await createWorld()

    const service = new HomeStanding({
      platform: w.a.platform,
      journal: new AgentHomeJournal(w.a.store),
      me: () => w.a.deviceServiceId,
      now: w.clock.now,
      cacheMs: 5_000
    })

    await service.check(w.agent, signal())
    await service.check(w.agent, signal())
    expect(w.stub.requests).toHaveLength(1)
    w.clock.advance(5_001)
    await service.check(w.agent, signal())
    expect(w.stub.requests).toHaveLength(2)
    await service.check(w.agent, signal(), { fresh: true })
    expect(w.stub.requests).toHaveLength(3)
  })

  it('shares one question between callers who ask at the same moment', async () => {
    const w = await createWorld()
    const service = new HomeStanding({ platform: w.a.platform, journal: new AgentHomeJournal(w.a.store), me: () => w.a.deviceServiceId, now: w.clock.now })

    await Promise.all([service.check(w.agent, signal()), service.check(w.agent, signal()), service.check(w.agent, signal())])
    expect(w.stub.requests).toHaveLength(1)
  })

  it('never believes a verdict that stops it acting: it asks again at once, so it hears the moment it may', async () => {
    const w = await createWorld({ at: 'b' })
    const journal = new AgentHomeJournal(w.a.store)
    journal.update(w.agent, entry => {
      entry.managed = true
    })
    const service = new HomeStanding({ platform: w.a.platform, journal, me: () => w.a.deviceServiceId, now: w.clock.now })

    expect(await service.check(w.agent, signal())).toMatchObject({ state: 'elsewhere' })
    expect(await service.check(w.agent, signal())).toMatchObject({ state: 'elsewhere' })
    expect(w.stub.requests).toHaveLength(2)

    w.stub.hijack(w.agent, { kind: 'mac', deviceServiceId: w.a.deviceServiceId })
    expect(await service.check(w.agent, signal())).toMatchObject({ state: 'home' })
  })

  it('holds a managed agent when the platform cannot be asked, and leaves a never-managed one alone', async () => {
    const w = await createWorld()
    const journal = new AgentHomeJournal(w.a.store)
    const service = new HomeStanding({ platform: w.a.platform, journal, me: () => w.a.deviceServiceId, now: w.clock.now })

    w.stub.failNext = { status: 500 }
    expect(await service.check(w.agent, signal())).toEqual({ state: 'legacy' })

    journal.update(w.agent, entry => {
      entry.managed = true
    })

    for (const [setup, reason] of [
      [() => { w.stub.failNext = { status: 500 } }, 'unreachable'],
      [() => { w.stub.unsupported = 'absent' }, 'unsupported'],
      [() => { w.stub.unsupported = null; w.stub.failNext = { status: 401 } }, 'unauthorized']
    ] as const) {
      setup()
      expect(await service.check(w.agent, signal(), { fresh: true })).toEqual({ state: 'unknown', reason })
    }

    // A Mac that is not enrolled is not a home either, once the agent is under the model.
    const unenrolled = new HomeStanding({ platform: w.a.platform, journal, me: () => null, now: w.clock.now })
    expect(await unenrolled.check(w.agent, signal())).toEqual({ state: 'unknown', reason: 'not_enrolled' })
  })

  it('asks a platform that has no such route only rarely, so an old platform is not hit on every message', async () => {
    const w = await createWorld()
    const service = new HomeStanding({ platform: w.a.platform, journal: new AgentHomeJournal(w.a.store), me: () => w.a.deviceServiceId, now: w.clock.now })
    w.stub.unsupported = 'absent'

    for (let i = 0; i < 5; i += 1) {
      expect(await service.check(w.agent, signal())).toEqual({ state: 'legacy' })
      w.clock.advance(30_000)
    }

    expect(w.stub.requests).toHaveLength(1)
    w.clock.advance(10 * 60_000)
    await service.check(w.agent, signal())
    expect(w.stub.requests).toHaveLength(2)
  })

  it('remembers that it has seen the agent under the model, and a platform answer that makes it managed', async () => {
    const w = await createWorld()
    const journal = new AgentHomeJournal(w.a.store)
    const service = new HomeStanding({ platform: w.a.platform, journal, me: () => w.a.deviceServiceId, now: w.clock.now })

    expect(await service.check(w.agent, signal())).toEqual({ state: 'legacy' })
    expect(journal.read(w.agent).managed).toBe(false)
    w.stub.hijack(w.agent, { kind: 'mac', deviceServiceId: w.a.deviceServiceId })
    expect(await service.check(w.agent, signal(), { fresh: true })).toMatchObject({ state: 'home' })
    expect(journal.read(w.agent)).toMatchObject({ managed: true })
  })
})

describe('what an agent says in a room', () => {
  it('is checked against the home before it is sent, and only what the agent says', async () => {
    const w = await createWorld()
    const journal = new AgentHomeJournal(w.a.store)
    journal.update(w.agent, entry => {
      entry.managed = true
    })
    const standing = new HomeStanding({ platform: w.a.platform, journal, me: () => w.a.deviceServiceId, now: w.clock.now })
    const sent: string[] = []

    const queue = guardAgentPublication(
      { command: async (value: unknown) => { sent.push((value as { kind: string }).kind);

 return { ok: true } } },
      { agent: () => w.agent, standing }
    )

    for (const kind of AGENT_PUBLISH_KINDS) {
      await queue.command({ kind })
    }

    expect(sent).toEqual([...AGENT_PUBLISH_KINDS])

    w.stub.hijack(w.agent, { kind: 'mac', deviceServiceId: w.b.deviceServiceId })
    w.clock.advance(6_000)
    sent.length = 0

    await expect(queue.command({ kind: 'publishResult' })).rejects.toBeInstanceOf(NotTheHomeError)
    await expect(queue.command({ kind: 'publishNotice' })).rejects.toMatchObject({ message: 'matrix_agent_not_home' })
    // Reading, typing and everything else is not publication.
    await queue.command({ kind: 'typing' })
    await queue.command({ kind: 'readInvocation' })
    expect(sent).toEqual(['typing', 'readInvocation'])
  })

  it('does not let a silent platform hold up an agent it does not govern, only a moment', async () => {
    const w = await createWorld()
    const journal = new AgentHomeJournal(w.a.store)

    // A platform that never answers until it is told to stop waiting.
    const silent = {
      readPlacement: (_agent: string, signal: AbortSignal) =>
        new Promise(resolve => {
          signal.addEventListener('abort', () => resolve({ ok: false, kind: 'unavailable', status: 0 }), { once: true })
        })
    } as unknown as HomePlatform

    const standing = new HomeStanding({ platform: silent, journal, me: () => w.a.deviceServiceId, now: w.clock.now, legacyWaitMs: 20 })
    const sent: string[] = []

    const queue = guardAgentPublication(
      { command: async (value: unknown) => { sent.push((value as { kind: string }).kind);

 return { ok: true } } },
      { agent: () => w.agent, standing }
    )

    // Never seen under the model: today's rules govern, after a moment's wait for the platform.
    for (const kind of AGENT_PUBLISH_KINDS) {
      await queue.command({ kind })
    }

    expect(sent).toEqual([...AGENT_PUBLISH_KINDS])
    expect(await standing.check(w.agent, signal())).toEqual({ state: 'legacy' })
  })

  it('does hold a managed agent for the platform, however silent: it fails closed', async () => {
    const w = await createWorld()
    const journal = new AgentHomeJournal(w.a.store)
    journal.update(w.agent, entry => {
      entry.managed = true
    })

    const controller = new AbortController()

    const silent = {
      readPlacement: (_agent: string, abort: AbortSignal) =>
        new Promise(resolve => {
          abort.addEventListener('abort', () => resolve({ ok: false, kind: 'unavailable', status: 0 }), { once: true })
        })
    } as unknown as HomePlatform

    const standing = new HomeStanding({ platform: silent, journal, me: () => w.a.deviceServiceId, now: w.clock.now, legacyWaitMs: 20 })
    const waiting = standing.check(w.agent, controller.signal)

    // Well past the bound an unmanaged agent would have waited: still waiting.
    await new Promise(resolve => setTimeout(resolve, 80))
    let settled = false
    void waiting.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    controller.abort()
    expect(await waiting).toEqual({ state: 'unknown', reason: 'unreachable' })
  })
})
