/**
 * The checkpoint cadence (owner decision D1): every 15 minutes when something changed, and on idle (5 minutes of
 * nothing), never while a move is under way or the agent is held, never for an agent the model does not govern, and
 * always BESIDE the running agent: nothing is stopped, restarted or held, and the next message finds it warm.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { beats, macApp } from './app.fixture'
import { CADENCE_EVERY_MS, CADENCE_IDLE_AFTER_MS, CheckpointCadence } from './cadence'
import type { CheckpointOutcome } from './checkpoint'
import { AgentHomeJournal } from './journal'
import { MemoryStore } from './mac.fixture'
import { FakeHomeTool } from './node.fixture'
import { createWorld } from './world.fixture'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const MINUTE = 60_000
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
/** Fingerprints are digests: the journal keeps nothing else. */
const OLD = 'a'.repeat(64)
const NEW = 'b'.repeat(64)
const OLDER = 'c'.repeat(64)

describe('when an agent is checkpointed', () => {
  function rig(overrides: Partial<ConstructorParameters<typeof CheckpointCadence>[0]> = {}) {
    const clock = { now: 1_800_000_000_000 }
    const journal = new AgentHomeJournal(new MemoryStore())
    const state = { eligible: true, busy: false, atRest: true, fingerprint: NEW as string | null, outcome: null as CheckpointOutcome | null }
    const calls: Array<{ reason: string; aborted: () => boolean }> = []
    const logs: string[] = []
    let restAsked = 0

    journal.update(AGENT, entry => {
      entry.managed = true
      entry.lastFingerprint = undefined
    })

    const committed = (): CheckpointOutcome => ({
      state: 'committed',
      generation: calls.length + 1,
      selectedGeneration: calls.length + 1,
      placementRevision: 2,
      manifestSha256: 'a'.repeat(64),
      contentSha256: 'b'.repeat(64),
      included: 1,
      skipped: 0
    })

    const cadence = new CheckpointCadence({
      journal,
      now: () => clock.now,
      eligible: () => state.eligible,
      busy: () => state.busy,
      atRest: async () => {
        restAsked += 1

        return state.atRest
      },
      fingerprint: async () => state.fingerprint,
      checkpoint: async (_agent, reason, signal) => {
        calls.push({ reason, aborted: () => signal.aborted })
        const outcome = state.outcome ?? committed()

        if (outcome.state === 'committed') {
          journal.update(AGENT, entry => {
            entry.lastCommittedAt = clock.now
            entry.lastFingerprint = state.fingerprint ?? undefined
          })
        }

        return outcome
      },
      tickMs: 0,
      log: line => logs.push(line),
      ...overrides
    })

    const advance = (ms: number) => {
      clock.now += ms
    }

    return { cadence, journal, state, calls, logs, advance, clock, restAsked: () => restAsked }
  }

  it('says what the owner decided: a quarter of an hour when something changed, five minutes of nothing for idle', () => {
    expect(CADENCE_EVERY_MS).toBe(15 * MINUTE)
    expect(CADENCE_IDLE_AFTER_MS).toBe(5 * MINUTE)
  })

  it('does nothing while the agent is active and the quarter hour has not come', async () => {
    const { cadence, calls, advance } = rig()
    await cadence.look(AGENT)

    for (let minute = 0; minute < 14; minute += 1) {
      advance(MINUTE)
      cadence.touch(AGENT)
      expect(await cadence.look(AGENT)).toBe('skipped')
    }

    expect(calls).toEqual([])
  })

  it('takes a checkpoint when the quarter hour has come and the home has changed, and not again within it', async () => {
    const { cadence, calls, advance, logs } = rig()
    await cadence.look(AGENT)

    advance(15 * MINUTE)
    cadence.touch(AGENT)

    expect(await cadence.look(AGENT)).toBe('checkpointed')
    expect(calls.map(call => call.reason)).toEqual(['cadence_dirty'])
    expect(logs.some(line => line.includes('checkpoint cadence_dirty generation 2'))).toBe(true)

    // Not for another quarter hour, however active the agent.
    for (let minute = 0; minute < 14; minute += 1) {
      advance(MINUTE)
      cadence.touch(AGENT)
      expect(await cadence.look(AGENT)).toBe('skipped')
    }

    expect(calls).toHaveLength(1)

    // The next quarter hour has come, and the home is as the checkpoint saw it: nothing is taken.
    advance(MINUTE)
    cadence.touch(AGENT)
    expect(await cadence.look(AGENT)).toBe('clean')
    expect(calls).toHaveLength(1)
  })

  it('reserves, quiesces, captures and uploads nothing for a home that has not changed', async () => {
    const { cadence, calls, journal, state, advance } = rig()
    journal.update(AGENT, entry => {
      entry.lastFingerprint = NEW
      entry.lastCommittedAt = 1_800_000_000_000
    })
    state.fingerprint = NEW
    await cadence.look(AGENT)

    advance(16 * MINUTE)
    cadence.touch(AGENT)

    expect(await cadence.look(AGENT)).toBe('clean')
    expect(calls).toEqual([])
  })

  it('takes a checkpoint on idle: five minutes of nothing after a change, once for that period of nothing', async () => {
    const { cadence, calls, journal, advance } = rig()
    journal.update(AGENT, entry => {
      entry.lastCommittedAt = 1_800_000_000_000
      entry.lastFingerprint = OLD
    })
    cadence.touch(AGENT)

    advance(4 * MINUTE)
    expect(await cadence.look(AGENT)).toBe('skipped')

    advance(MINUTE)
    expect(await cadence.look(AGENT)).toBe('checkpointed')
    expect(calls.map(call => call.reason)).toEqual(['idle'])

    // Quiet a few minutes longer, and changed again: it is not checkpointed again and again; the agent has not stirred.
    journal.update(AGENT, entry => {
      entry.lastFingerprint = OLDER
    })
    advance(4 * MINUTE)
    expect(await cadence.look(AGENT)).toBe('skipped')

    // The agent works again, then stops again: a new period of nothing, a new idle checkpoint.
    cadence.touch(AGENT)
    advance(CADENCE_IDLE_AFTER_MS)
    expect(await cadence.look(AGENT)).toBe('checkpointed')
    expect(calls.map(call => call.reason)).toEqual(['idle', 'idle'])
  })

  it('does not take an idle checkpoint of a home that has not changed, and settles that idle period', async () => {
    const { cadence, calls, journal, state, advance } = rig()
    journal.update(AGENT, entry => {
      entry.lastCommittedAt = 1_800_000_000_000
      entry.lastFingerprint = NEW
    })
    state.fingerprint = NEW
    cadence.touch(AGENT)

    advance(6 * MINUTE)
    expect(await cadence.look(AGENT)).toBe('clean')
    // The same idle period is not looked at again a minute later: it was settled.
    advance(2 * MINUTE)
    expect(await cadence.look(AGENT)).toBe('skipped')
    expect(calls).toEqual([])
  })

  it('does not checkpoint the same agent twice within two minutes, whatever it says', async () => {
    const { cadence, calls, journal, advance } = rig()
    journal.update(AGENT, entry => {
      entry.lastCommittedAt = 1_800_000_000_000
      entry.lastFingerprint = OLD
    })
    cadence.touch(AGENT)
    advance(6 * MINUTE)
    expect(await cadence.look(AGENT)).toBe('checkpointed')

    // Active again, then quiet for the whole idle time, with the home changed again: two minutes have not passed since.
    journal.update(AGENT, entry => {
      entry.lastFingerprint = OLDER
    })
    cadence.touch(AGENT)
    advance(CADENCE_IDLE_AFTER_MS)
    journal.update(AGENT, entry => {
      entry.lastCommittedAt = 1_800_000_000_000 + 6 * MINUTE + CADENCE_IDLE_AFTER_MS - MINUTE
    })

    expect(await cadence.look(AGENT)).toBe('skipped')
    expect(calls).toHaveLength(1)

    advance(2 * MINUTE)
    expect(await cadence.look(AGENT)).toBe('checkpointed')
  })

  it('does not interrupt a turn: a due checkpoint waits for it, and goes ahead the moment it ends', async () => {
    const { cadence, calls, state, advance } = rig()
    await cadence.look(AGENT)
    state.busy = true

    advance(15 * MINUTE)
    expect(await cadence.look(AGENT)).toBe('skipped')
    advance(4 * MINUTE)
    expect(await cadence.look(AGENT)).toBe('skipped')
    expect(calls).toEqual([])

    // The turn ends: the checkpoint goes ahead at once.
    state.busy = false
    expect(await cadence.look(AGENT)).toBe('checkpointed')
    expect(calls.map(call => call.reason)).toEqual(['cadence_dirty'])
  })

  it('never goes ahead beside a turn, however long it lasts: a due checkpoint waits for the next quiet moment', async () => {
    const { cadence, calls, state, advance } = rig()
    await cadence.look(AGENT)
    state.busy = true

    // A turn of six hours. The quarter hour is long past; there is no grace after which it is forced.
    for (let step = 0; step < 24; step += 1) {
      advance(15 * MINUTE)
      expect(await cadence.look(AGENT)).toBe('skipped')
    }

    expect(calls).toEqual([])

    state.busy = false
    expect(await cadence.look(AGENT)).toBe('checkpointed')
    expect(calls.map(call => call.reason)).toEqual(['cadence_dirty'])
  })

  it('takes a checkpoint only beside an agent at rest, and asks nothing of Hermes about a home that has not changed', async () => {
    const { cadence, calls, journal, state, advance, restAsked } = rig()
    await cadence.look(AGENT)

    // Nothing changed since the last checkpoint: it never asks whether the agent is at rest.
    journal.update(AGENT, entry => {
      entry.lastFingerprint = NEW
    })
    advance(15 * MINUTE)
    expect(await cadence.look(AGENT)).toBe('clean')
    expect(restAsked()).toBe(0)

    // Changed and due, but Hermes's review of the last answer is still writing: not now. Nothing is taken.
    journal.update(AGENT, entry => {
      entry.lastFingerprint = OLD
    })
    state.atRest = false
    advance(MINUTE)
    expect(await cadence.look(AGENT)).toBe('busy')
    expect(calls).toEqual([])
    expect(restAsked()).toBe(1)

    // The review is over: the next look (a minute on) takes it.
    state.atRest = true
    advance(MINUTE)
    expect(await cadence.look(AGENT)).toBe('checkpointed')
    expect(calls).toHaveLength(1)
  })

  it('does not back off when the writers were busy or the home was written while they were held: it tries again a minute on, and says why', async () => {
    const { cadence, calls, state, advance, logs } = rig()
    await cadence.look(AGENT)
    advance(15 * MINUTE)
    state.outcome = { state: 'failed', reason: 'home_changed', detail: 'writers_busy', selectedGeneration: 1 }

    expect(await cadence.look(AGENT)).toBe('busy')
    expect(logs.some(line => line.includes('the agent’s writers were busy when they were to be held still'))).toBe(true)

    // Not the five minutes of a platform that failed: the look's own throttle of a minute is all there is.
    advance(MINUTE)
    state.outcome = { state: 'failed', reason: 'home_changed', detail: 'changed', selectedGeneration: 1 }
    expect(await cadence.look(AGENT)).toBe('busy')
    expect(logs.some(line => line.includes('something wrote the home while its writers were held still'))).toBe(true)

    advance(MINUTE)
    state.outcome = null
    expect(await cadence.look(AGENT)).toBe('checkpointed')
    expect(calls).toHaveLength(3)
  })

  it.each(['moving or held', 'not the home', 'not governed'])('does nothing for an agent this Mac may not checkpoint (%s), however long it waits', async () => {
    const { cadence, calls, state, advance } = rig()
    state.eligible = false
    await cadence.look(AGENT)

    for (let step = 0; step < 6; step += 1) {
      advance(10 * MINUTE)
      expect(await cadence.look(AGENT)).toBe('skipped')
    }

    expect(calls).toEqual([])

    // And once it may, the clocks are not those of the hour it waited: nothing is owed for the time it was not the home's.
    state.eligible = true
    expect(await cadence.look(AGENT)).toBe('checkpointed')
  })

  it('ends a checkpoint in flight when the agent can no longer be checkpointed, and does not blame the platform for it', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })

    const { cadence, calls, advance } = rig({
      checkpoint: async (_agent, reason, signal) => {
        calls.push({ reason, aborted: () => signal.aborted })
        await gate

        return { state: 'failed', reason: 'unavailable', selectedGeneration: 1 }
      }
    })

    await cadence.look(AGENT)
    advance(15 * MINUTE)

    const running = cadence.look(AGENT)
    await wait(5)
    expect(cadence.running(AGENT)).toBe(true)

    cadence.cancel(AGENT)
    expect(calls[0]!.aborted()).toBe(true)
    finish()

    expect(await running).toBe('skipped')
    expect(cadence.running(AGENT)).toBe(false)

    // No back-off: a move that ended without a commit does not leave the agent unprotected for five minutes.
    expect(await cadence.look(AGENT)).not.toBe('failed')
  })

  it('leaves an agent alone for five minutes after a failure, and half an hour when the platform has no such routes', async () => {
    const { cadence, calls, state, advance } = rig()
    await cadence.look(AGENT)
    advance(15 * MINUTE)
    state.outcome = { state: 'failed', reason: 'upload_failed', selectedGeneration: 1 }

    expect(await cadence.look(AGENT)).toBe('failed')
    advance(4 * MINUTE)
    expect(await cadence.look(AGENT)).toBe('skipped')
    advance(2 * MINUTE)
    state.outcome = { state: 'failed', reason: 'unsupported', selectedGeneration: 1 }
    expect(await cadence.look(AGENT)).toBe('failed')

    advance(29 * MINUTE)
    expect(await cadence.look(AGENT)).toBe('skipped')
    advance(2 * MINUTE)
    state.outcome = null
    expect(await cadence.look(AGENT)).toBe('checkpointed')
    expect(calls).toHaveLength(3)
  })

  it('says why a checkpoint failed, in the checkpoint’s closed words, once for each back-off', async () => {
    const { cadence, state, advance, logs } = rig()
    await cadence.look(AGENT)
    advance(15 * MINUTE)

    // The store refuses the archive's size: the home stays unprotected, and that must not be silent.
    state.outcome = { state: 'failed', reason: 'upload_failed', detail: 'too_large', selectedGeneration: 1 }
    expect(await cadence.look(AGENT)).toBe('failed')
    expect(logs.filter(line => line.includes('failed: upload_failed (too_large)'))).toHaveLength(1)

    // Within the back-off nothing is tried and nothing is said again.
    advance(MINUTE)
    expect(await cadence.look(AGENT)).toBe('skipped')
    expect(logs.filter(line => line.includes('failed: upload_failed'))).toHaveLength(1)

    advance(5 * MINUTE)
    state.outcome = { state: 'failed', reason: 'unsupported', selectedGeneration: 1 }
    expect(await cadence.look(AGENT)).toBe('failed')
    expect(logs.some(line => line.endsWith('failed: unsupported'))).toBe(true)
  })

  it('treats a tool that cannot say whether the home changed as a home that may have: the quarter hour decides', async () => {
    const { cadence, calls, state, advance } = rig()
    state.fingerprint = null
    await cadence.look(AGENT)
    advance(15 * MINUTE)
    cadence.touch(AGENT)

    expect(await cadence.look(AGENT)).toBe('checkpointed')
    expect(calls).toHaveLength(1)
  })

  it('looks at every agent at most once per beat of its own, and never waits for a checkpoint', async () => {
    const { cadence, advance, calls } = rig({ tickMs: 30_000 })
    await cadence.look(AGENT)
    advance(15 * MINUTE)
    cadence.touch(AGENT)

    cadence.tick([AGENT])
    cadence.tick([AGENT])
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    // The second call within the beat looked at nothing.
    advance(10_000)
    cadence.tick([AGENT])
    await wait(10)
    expect(calls).toHaveLength(1)
  })

  it('forgets an agent that is gone, ending what it was doing', async () => {
    let signalSeen: AbortSignal | undefined
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })

    const { cadence, advance } = rig({
      checkpoint: async (_agent, _reason, signal) => {
        signalSeen = signal
        await gate

        return { state: 'failed', reason: 'unavailable', selectedGeneration: 1 }
      }
    })

    await cadence.look(AGENT)
    advance(15 * MINUTE)
    const running = cadence.look(AGENT)
    await wait(5)

    cadence.forget(AGENT)
    expect(signalSeen!.aborted).toBe(true)
    finish()
    await running
    expect(cadence.running(AGENT)).toBe(false)
  })
})

describe('in the app', () => {
  /** An agent that has moved to the Mac mini, which is now its home. */
  async function homeOnTheMini() {
    const w = await createWorld({ at: 'a' })
    const options = { cadence: { tickMs: 0 } }
    const tool = new FakeHomeTool()
    const a = macApp(w, w.a, options)
    const b = macApp(w, w.b, { ...options, tool })
    await beats(w, [a, b], 2)
    expect((await a.app.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)
    await beats(w, [a, b])
    expect(w.stub.placement(w.agent).location).toEqual({ kind: 'mac', deviceServiceId: w.b.deviceServiceId })
    expect(b.app.controller.ctx.journal.read(w.agent).lastFingerprint).toBeTruthy()
    AGENT_OF.current = w.agent

    // The arrival stopped and started the agent (a restore does); the first message after it is cold, and that is not
    // what these tests are about. What they watch is what happens from here on.
    b.handle.ask()

    return { w, a, b, tool }
  }

  /** What the agent's runtime had been asked to do, and how often it was stopped and started, at a moment. */
  const runtimeNow = (handle: { calls: string[]; stops: number; coldStarts: number; up: boolean }) => ({
    calls: [...handle.calls],
    stops: handle.stops,
    coldStarts: handle.coldStarts,
    up: handle.up
  })

  /** The agent of the world a test is running in (the helper below waits for its checkpoint). */
  const AGENT_OF = { current: '' }
  const generation = (w: Awaited<ReturnType<typeof createWorld>>) => w.stub.placement(w.agent).selectedGeneration

  /**
   * Beats of the app's loop, each followed by waiting for whatever the cadence started to be over: a checkpoint is real
   * work (capture, seal, upload) and the loop does not wait for it, so the test waits for `running` to end, not for a guess.
   */
  async function settleCadence(b: { app: { service: { tick(): Promise<void> }; cadence: { running(agent: string): boolean } } }, rounds = 3) {
    for (let round = 0; round < rounds; round += 1) {
      await b.app.service.tick()

      for (let waited = 0; b.app.cadence.running(AGENT_OF.current) && waited < 10_000; waited += 5) {
        await wait(5)
      }

      await wait(5)
    }
  }

  it('takes a checkpoint of a changed home after a quarter of an hour, and a second one only after another', async () => {
    const { w, b } = await homeOnTheMini()
    const before = generation(w)
    writeFileSync(path.join(b.home, 'memories/MEMORY.md'), 'B remembers something new, at length.')
    b.app.cadence.touch(w.agent)

    w.clock.advance(16 * MINUTE)
    b.app.cadence.touch(w.agent)
    await settleCadence(b)

    expect(generation(w)).toBe(before + 1)
    expect(b.logs.some(line => line.includes('checkpoint cadence_dirty'))).toBe(true)

    // Changed again, but not for a quarter of an hour.
    writeFileSync(path.join(b.home, 'memories/MEMORY.md'), 'B remembers something newer still, at greater length.')
    w.clock.advance(3 * MINUTE)
    b.app.cadence.touch(w.agent)
    await settleCadence(b)
    expect(generation(w)).toBe(before + 1)
  })

  it('takes nothing of a home that has not changed', async () => {
    const { w, b } = await homeOnTheMini()
    const before = generation(w)

    w.clock.advance(16 * MINUTE)
    b.app.cadence.touch(w.agent)
    await settleCadence(b)

    expect(generation(w)).toBe(before)
  })

  it('takes a checkpoint on idle, five minutes after the last thing the agent did', async () => {
    const { w, b } = await homeOnTheMini()
    const before = generation(w)
    writeFileSync(path.join(b.home, 'memories/learned.md'), 'something it learned a moment ago')
    b.app.cadence.touch(w.agent)

    w.clock.advance(4 * MINUTE)
    await settleCadence(b)
    expect(generation(w)).toBe(before)

    w.clock.advance(2 * MINUTE)
    await settleCadence(b)

    expect(generation(w)).toBe(before + 1)
    expect(b.logs.some(line => line.includes('checkpoint idle'))).toBe(true)
  })

  it('counts what the agent says as activity, so an agent that is talking is not idle', async () => {
    const { w, b } = await homeOnTheMini()
    const before = generation(w)
    writeFileSync(path.join(b.home, 'memories/learned.md'), 'something it learned a moment ago')

    for (let minute = 0; minute < 8; minute += 1) {
      w.clock.advance(MINUTE)
      expect(await b.handle.emit({ kind: 'publishNotice', roomId: '!room:atum.example', body: 'working' })).toBe('sent')
      await settleCadence(b, 1)
    }

    expect(generation(w)).toBe(before)
  })

  it('does not take a checkpoint for the old home, which has stood the agent down', async () => {
    const { w, a } = await homeOnTheMini()
    const checkpoint = vi.spyOn(a.app.controller, 'checkpoint')
    writeFileSync(path.join(a.home, 'memories/MEMORY.md'), 'A is stale, and changing')

    w.clock.advance(40 * MINUTE)
    a.app.cadence.touch(w.agent)
    await settleCadence(a)

    expect(checkpoint).not.toHaveBeenCalled()
    expect(a.app.cadence.running(w.agent)).toBe(false)
  })

  it('does not take a checkpoint of an agent that was never moved', async () => {
    const w = await createWorld({ at: 'a' })
    const a = macApp(w, w.a, { cadence: { tickMs: 0 } })
    AGENT_OF.current = w.agent
    await beats(w, [a], 2)
    const checkpoint = vi.spyOn(a.app.controller, 'checkpoint')

    w.clock.advance(40 * MINUTE)
    a.app.cadence.touch(w.agent)
    await settleCadence(a)

    expect(checkpoint).not.toHaveBeenCalled()
    expect(w.stub.checkpoints(w.agent)).toEqual([])
  })

  it('does not take one while a move of the agent is under way', async () => {
    const { w, a, b } = await homeOnTheMini()
    const checkpoint = vi.spyOn(b.app.controller, 'checkpoint')
    writeFileSync(path.join(b.home, 'memories/MEMORY.md'), 'changed while the move is asked for')
    expect((await b.app.service.move(w.agent, w.a.deviceServiceId)).ok).toBe(true)

    w.clock.advance(16 * MINUTE)
    b.app.cadence.touch(w.agent)
    await settleCadence(b, 2)

    // The move's own final checkpoint is the move flow's; the cadence has none of its own to take meanwhile.
    expect(checkpoint).not.toHaveBeenCalled()

    await beats(w, [a, b])
    expect(w.stub.placement(w.agent).location).toEqual({ kind: 'mac', deviceServiceId: w.a.deviceServiceId })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it('does not take one while something holds the agent still (a drain, a restore, a checkpoint of the move)', async () => {
    const { w, b } = await homeOnTheMini()
    const checkpoint = vi.spyOn(b.app.controller, 'checkpoint')
    writeFileSync(path.join(b.home, 'memories/MEMORY.md'), 'changed while it is held')
    b.app.holds.add(w.agent, 'quiesce')

    w.clock.advance(16 * MINUTE)
    b.app.cadence.touch(w.agent)
    expect(await b.app.cadence.look(w.agent)).toBe('skipped')
    expect(checkpoint).not.toHaveBeenCalled()

    b.app.holds.remove(w.agent, 'quiesce')
    expect(await b.app.cadence.look(w.agent)).toBe('checkpointed')
    expect(checkpoint).toHaveBeenCalledTimes(1)
  })

  it('leaves a busy agent to finish its turn', async () => {
    const { w, b } = await homeOnTheMini()
    const before = generation(w)
    writeFileSync(path.join(b.home, 'memories/MEMORY.md'), 'changed during a long turn')
    b.handle.working = true

    w.clock.advance(16 * MINUTE)
    await settleCadence(b)
    expect(generation(w)).toBe(before)

    b.handle.working = false
    b.app.cadence.touch(w.agent)
    w.clock.advance(MINUTE)
    await settleCadence(b)
    expect(generation(w)).toBe(before + 1)
  })

  it('takes its checkpoints beside the running agent: nothing is stopped, restarted or held, and the next message finds it warm', async () => {
    const { w, b } = await homeOnTheMini()
    const before = generation(w)
    const started = runtimeNow(b.handle)

    // Two quarter hours, a memory changed in each.
    for (const text of ['B learned this at noon.', 'B learned something else in the afternoon, at some length.']) {
      writeFileSync(path.join(b.home, 'memories/MEMORY.md'), text)
      w.clock.advance(16 * MINUTE)
      b.app.cadence.touch(w.agent)
      await settleCadence(b)
    }

    expect(generation(w)).toBe(before + 2)
    expect(b.logs.filter(line => line.includes('checkpoint cadence_dirty'))).toHaveLength(2)
    // Held still twice, for a snapshot each time, and let go: admission only, no stop.
    expect(b.handle.writeHolds).toBe(2)
    expect(b.handle.held).toBe(false)

    // Not one stop, start, drain or cold start: the process the agent runs in was never touched ...
    expect(runtimeNow(b.handle)).toEqual(started)
    expect(b.handle.up).toBe(true)
    expect(b.app.holds.has(w.agent)).toBe(false)
    // ... so the next message is answered warm, with no restart to wait for.
    expect(b.handle.ask()).toBe('warm')
  })

  it('is what keeps the cold start away: a checkpoint that stops the writers (the owner\'s own, a move\'s) leaves the next message cold', async () => {
    const { w, b } = await homeOnTheMini()
    const started = runtimeNow(b.handle)
    writeFileSync(path.join(b.home, 'memories/MEMORY.md'), 'changed')

    const outcome = await b.app.controller.checkpoint(w.agent, new AbortController().signal, 'manual')

    expect(outcome.state).toBe('committed')
    expect(b.handle.stops).toBe(started.stops + 1)
    expect(b.handle.coldStarts).toBe(started.coldStarts + 1)
    expect(b.handle.ask()).toBe('cold')
  })

  it('never takes one beside a turn that goes on for hours, and stops nothing while it waits', async () => {
    const { w, b } = await homeOnTheMini()
    const before = generation(w)
    const started = runtimeNow(b.handle)
    writeFileSync(path.join(b.home, 'memories/MEMORY.md'), 'changed during a very long task')
    b.handle.working = true

    for (let hour = 0; hour < 3; hour += 1) {
      w.clock.advance(60 * MINUTE)
      await settleCadence(b, 1)
    }

    expect(generation(w)).toBe(before)
    expect(runtimeNow(b.handle)).toEqual(started)

    // The task ends: the next look takes it, and still touches nothing.
    b.handle.working = false
    w.clock.advance(MINUTE)
    await settleCadence(b)

    expect(generation(w)).toBe(before + 1)
    expect(runtimeNow(b.handle)).toEqual(started)
    expect(b.handle.ask()).toBe('warm')
  })

  it('waits for Hermes to finish reviewing the last answer, then takes it', async () => {
    const { w, b } = await homeOnTheMini()
    const before = generation(w)
    const started = runtimeNow(b.handle)
    const asked = b.handle.restAsked
    writeFileSync(path.join(b.home, 'memories/MEMORY.md'), 'what the review wrote, a moment ago')
    b.handle.reviewing = true

    w.clock.advance(16 * MINUTE)
    b.app.cadence.touch(w.agent)
    await settleCadence(b)

    expect(generation(w)).toBe(before)
    expect(b.handle.restAsked).toBeGreaterThan(asked)

    b.handle.reviewing = false
    w.clock.advance(MINUTE)
    b.app.cadence.touch(w.agent)
    await settleCadence(b)

    expect(generation(w)).toBe(before + 1)
    expect(runtimeNow(b.handle)).toEqual(started)
  })

  it('throws a snapshot away when a file it carries is written inside its window by something the barrier cannot see, and takes the next quiet moment: the agent is never stopped', async () => {
    const { w, b, tool } = await homeOnTheMini()
    const before = generation(w)
    const started = runtimeNow(b.handle)
    writeFileSync(path.join(b.home, 'memories/learned.md'), 'something it learned a moment ago')
    let wrote = false

    tool.midSnapshot = home => {
      if (!wrote) {
        wrote = true
        writeFileSync(path.join(home, 'memories/MEMORY.md'), 'something wrote this while the writers were held, and it is longer than it was before')
      }
    }

    w.clock.advance(16 * MINUTE)
    b.app.cadence.touch(w.agent)
    await settleCadence(b)

    // The snapshot was not one moment of the home, so it was neither captured nor uploaded nor committed.
    expect(wrote).toBe(true)
    expect(generation(w)).toBe(before)
    expect(b.logs.some(line => line.includes('something wrote the home while its writers were held still'))).toBe(true)
    expect(w.stub.checkpoints(w.agent).at(-1)?.state).toBe('failed')
    expect(w.stub.archives.has(`${w.stub.placement(w.agent).homeId}:${before + 1}`)).toBe(false)
    expect(b.handle.held).toBe(false)

    // A minute on, with the home still, it is taken.
    w.clock.advance(MINUTE)
    b.app.cadence.touch(w.agent)
    await settleCadence(b)

    expect(generation(w)).toBe(before + 1)
    expect(runtimeNow(b.handle)).toEqual(started)
  })

  it('leaves it for the next quiet moment when a turn begins between the cadence’s look and the hold: the hold is refused, nothing is stopped', async () => {
    const { w, b, tool } = await homeOnTheMini()
    const before = generation(w)
    const started = runtimeNow(b.handle)
    writeFileSync(path.join(b.home, 'memories/MEMORY.md'), 'what it learned before the turn')

    // The cadence finds the agent at rest ...
    tool.midSnapshot = undefined
    const rested = b.handle.atRest.bind(b.handle)

    b.handle.atRest = async () => {
      const answer = await rested()
      // ... and a turn begins before the checkpoint can hold the writers.
      b.handle.startTurn()

      return answer
    }

    w.clock.advance(16 * MINUTE)
    b.app.cadence.touch(w.agent)
    await settleCadence(b)

    expect(generation(w)).toBe(before)
    expect(b.logs.some(line => line.includes('the agent’s writers were busy when they were to be held still'))).toBe(true)
    expect(w.stub.checkpoints(w.agent).at(-1)?.state).toBe('failed')
    expect(b.handle.writeHolds).toBe(0)
    expect(runtimeNow(b.handle)).toEqual(started)

    // The turn ends; a minute on, the next look takes it.
    b.handle.atRest = rested
    b.handle.turn?.finish()
    b.handle.turn = null
    w.clock.advance(MINUTE)
    b.app.cadence.touch(w.agent)
    await settleCadence(b)

    expect(generation(w)).toBe(before + 1)
    expect(runtimeNow(b.handle)).toEqual(started)
  })

  it('records the fingerprint of every checkpoint it takes, so the next look has something to compare with', async () => {
    const { w, b } = await homeOnTheMini()
    writeFileSync(path.join(b.home, 'memories/MEMORY.md'), 'changed')

    w.clock.advance(16 * MINUTE)
    b.app.cadence.touch(w.agent)
    await settleCadence(b)

    const journal = b.app.controller.ctx.journal.read(w.agent)
    const fingerprint = await b.app.controller.ctx.tool.fingerprint({ home: b.home }, new AbortController().signal)

    expect(journal.lastFingerprint).toBe(fingerprint.fingerprintSha256)
  })
})
