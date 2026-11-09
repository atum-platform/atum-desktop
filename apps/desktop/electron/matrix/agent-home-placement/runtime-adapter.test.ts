import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { AgentHomeHolds } from './holds'
import { AgentHomeJournal } from './journal'
import { MemoryStore } from './mac.fixture'
import { createHomeRuntimeOps, type MacAgentHandle } from './runtime-adapter'

/** A handle that only records what it was asked to do. */
class Recorder implements MacAgentHandle {
  readonly calls: string[] = []
  finishDrain: (() => void) | undefined
  drainRejects = false
  up = true

  home() {
    return '/home/agent'
  }

  leaseFacts() {
    return { leaseId: 'lease', executorTerm: 1, leaseExpiresAtPlatform: Date.now() + 60_000 }
  }

  drain(): Promise<void> {
    this.calls.push('drain')

    if (this.drainRejects) {
      return Promise.reject(new Error('listener_failed'))
    }

    return new Promise<void>(resolve => {
      this.finishDrain = resolve
    })
  }

  async stopWriters(options: { keepLease: boolean }) {
    this.calls.push(options.keepLease ? 'stopWriters(keepLease)' : 'stopWriters')
  }

  restart() {
    this.calls.push('restart')
  }

  beginHere() {
    this.calls.push('beginHere')
  }

  async running() {
    return this.up
  }

  /** What the agent answers when asked whether it is at rest. */
  rested = true

  async atRest() {
    this.calls.push('atRest')

    return this.rested
  }

  /** Whether the agent's writers can be held still now; the function it hands back records that they were let go. */
  holdable = true

  async holdWrites() {
    this.calls.push('holdWrites')

    return this.holdable ? () => void this.calls.push('letGo') : null
  }

  readiness() {
    return { homeAccessible: true, runtimeUsable: this.up, matrixIntakeWorking: true }
  }
}

function setup(options: { handle?: Recorder | null } = {}) {
  const store = new MemoryStore()
  const journal = new AgentHomeJournal(store)
  const holds = new AgentHomeHolds(journal)
  const agent = randomUUID()
  const handle = options.handle === null ? null : (options.handle ?? new Recorder())
  const logs: string[] = []
  const ops = createHomeRuntimeOps({ handle: () => handle, holds, log: line => logs.push(line), activationWaitMs: 50 })

  return { store, journal, holds, agent, handle, ops, logs, signal: new AbortController().signal }
}

describe('draining for a move', () => {
  it('bounds the handle\'s follow-up work early enough that a slow managed delivery still quiesces in budget', async () => {
    const handle = new Recorder()
    let deadline: AbortSignal | undefined

    handle.drain = (bound?: AbortSignal) => {
      deadline = bound
      handle.calls.push('drain')

      // The managed share gives way at its deadline (drainMacJobs), so the drain itself ends in time.
      return new Promise<void>(resolve => bound?.addEventListener('abort', () => resolve(), { once: true }))
    }

    const s = setup({ handle })
    const started = Date.now()
    await expect(s.ops.drain(s.agent, 200, s.signal)).resolves.toBe('quiesced')
    expect(deadline?.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('stops new work at once and answers quiesced when the turn in flight ends', async () => {
    const s = setup()
    const drained = s.ops.drain(s.agent, 60_000, s.signal)

    expect(s.holds.has(s.agent)).toBe(true)
    expect(s.holds.reasons(s.agent)).toEqual(['drain'])

    s.handle!.finishDrain!()
    await expect(drained).resolves.toBe('quiesced')
  })

  it('gives up waiting after its budget without ending the turn, and the hold stays until the agent is resumed', async () => {
    const s = setup()

    await expect(s.ops.drain(s.agent, 5, s.signal)).resolves.toBe('timed_out')
    // Nothing aborted the turn: the handle was only asked to drain, once.
    expect(s.handle!.calls).toEqual(['drain'])
    expect(s.holds.has(s.agent)).toBe(true)

    await s.ops.resume(s.agent)
    expect(s.holds.has(s.agent)).toBe(false)
    expect(s.handle!.calls).toEqual(['drain', 'restart'])
  })

  it('counts an aborted wait, and a drain that failed, as not drained', async () => {
    const aborted = setup()
    const controller = new AbortController()
    const waiting = aborted.ops.drain(aborted.agent, 60_000, controller.signal)
    controller.abort()
    await expect(waiting).resolves.toBe('timed_out')

    const failing = setup({ handle: Object.assign(new Recorder(), { drainRejects: true }) })
    await expect(failing.ops.drain(failing.agent, 60_000, failing.signal)).resolves.toBe('timed_out')
  })

  it('has nothing to wait for when the agent does not run on this Mac, and still holds it', async () => {
    const s = setup({ handle: null })

    await expect(s.ops.drain(s.agent, 60_000, s.signal)).resolves.toBe('quiesced')
    expect(s.holds.has(s.agent)).toBe(true)
  })
})

describe('holding the writers still', () => {
  it('lets the agent go on release only when no other hold remains', async () => {
    const s = setup()
    const drained = s.ops.drain(s.agent, 60_000, s.signal)

    const release = await s.ops.quiesce(s.agent)
    expect([...s.holds.reasons(s.agent)].sort()).toEqual(['drain', 'quiesce'])

    await release()
    // The move is still draining: the agent stays down, however often the release is asked.
    await release()
    expect(s.handle!.calls).not.toContain('restart')
    expect(s.holds.reasons(s.agent)).toEqual(['drain'])

    s.handle!.finishDrain!()
    await drained
  })

  it('restarts the agent when a quiesce on its own is released, once', async () => {
    const s = setup()
    const release = await s.ops.quiesce(s.agent)

    // The answering lease stays: the checkpoint this is for is signed with it.
    expect(s.handle!.calls).toEqual(['stopWriters(keepLease)'])
    expect(s.holds.keepsLease(s.agent)).toBe(true)
    await release()
    await release()
    expect(s.handle!.calls).toEqual(['stopWriters(keepLease)', 'restart'])
    expect(s.holds.has(s.agent)).toBe(false)
  })

  it('drops its own hold when the writers could not be stopped', async () => {
    const handle = new Recorder()
    handle.stopWriters = async () => {
      throw new Error('executor_stuck')
    }
    const s = setup({ handle })

    await expect(s.ops.quiesce(s.agent)).rejects.toThrow('executor_stuck')
    expect(s.holds.has(s.agent)).toBe(false)
  })
})

describe('asking whether the agent is at rest', () => {
  it('asks the agent and nothing else: no hold, no stop, no drain, no restart, no lease change', async () => {
    const s = setup()

    await expect(s.ops.atRest(s.agent)).resolves.toBe(true)
    s.handle!.rested = false
    await expect(s.ops.atRest(s.agent)).resolves.toBe(false)
    await expect(s.ops.atRest(s.agent)).resolves.toBe(false)

    // This is what a checkpoint every quarter hour does to the agent: it asks, and the agent does not notice.
    expect(s.handle!.calls).toEqual(['atRest', 'atRest', 'atRest'])
    expect(s.holds.has(s.agent)).toBe(false)
    expect(s.holds.keepsLease(s.agent)).toBe(false)
  })

  it('does not disturb a drain or a stand-down that is under way, and is not disturbed by one', async () => {
    const s = setup()
    const drained = s.ops.drain(s.agent, 60_000, s.signal)

    await expect(s.ops.atRest(s.agent)).resolves.toBe(true)
    expect(s.holds.reasons(s.agent)).toEqual(['drain'])

    s.handle!.finishDrain!()
    await drained
  })

  it('has nothing running to write a home that is not on this Mac, so it is at rest', async () => {
    const s = setup({ handle: null })

    await expect(s.ops.atRest(s.agent)).resolves.toBe(true)
    expect(s.holds.has(s.agent)).toBe(false)
  })
})

describe('holding the writers still for a snapshot, without stopping them', () => {
  it('asks the agent to hold admission and lets it go when told: no agent-home hold, no stop, no restart, no lease change', async () => {
    const s = setup()
    const letGo = await s.ops.holdWrites(s.agent)

    expect(letGo).toBeTypeOf('function')
    // The executor-stopping holds (`holds.ts`) are for a move and for the owner's own checkpoint, not for this.
    expect(s.holds.has(s.agent)).toBe(false)
    expect(s.holds.keepsLease(s.agent)).toBe(false)
    letGo!()
    expect(s.handle!.calls).toEqual(['holdWrites', 'letGo'])
  })

  it('answers null when the agent cannot be held now, and has changed nothing', async () => {
    const handle = new Recorder()
    handle.holdable = false
    const s = setup({ handle })

    await expect(s.ops.holdWrites(s.agent)).resolves.toBeNull()
    expect(s.handle!.calls).toEqual(['holdWrites'])
    expect(s.holds.has(s.agent)).toBe(false)
  })

  it('has nothing running to write a home that is not on this Mac, so there is nothing to hold', async () => {
    const s = setup({ handle: null })
    const letGo = await s.ops.holdWrites(s.agent)

    expect(letGo).toBeTypeOf('function')
    expect(() => letGo!()).not.toThrow()
  })
})

describe('standing down and coming back', () => {
  it('stand-down always stops writers even after another startup, while resume removes the persisted hold', async () => {
    const s = setup()
    await s.ops.standDown(s.agent)
    s.handle!.restart()
    await s.ops.standDown(s.agent)
    expect(s.handle!.calls.filter(call => call === 'stopWriters')).toHaveLength(2)
    expect(s.holds.reasons(s.agent)).toContain('standDown')
    await s.ops.resume(s.agent)
    expect(s.holds.has(s.agent)).toBe(false)
    expect(s.journal.read(s.agent).standDown).toBeUndefined()
    expect(s.handle!.calls.at(-1)).toBe('restart')
  })

  it('materializes target custody before restore even when no local handle existed', async () => {
    const store = new MemoryStore()
    const holds = new AgentHomeHolds(new AgentHomeJournal(store))
    let handle: Recorder | null = null
    const materialize = async () => {
      handle = new Recorder()
    }
    const ops = createHomeRuntimeOps({ handle: () => handle, materialize, holds })

    await expect(ops.materialize(randomUUID(), new AbortController().signal)).resolves.toBe('/home/agent')
    expect(handle).not.toBeNull()
  })

  it('stands down for good: stopped, held, and remembered across a restart before anything is asked', async () => {
    const s = setup()
    const drained = s.ops.drain(s.agent, 60_000, s.signal)
    s.journal.update(s.agent, entry => {
      entry.managed = true
    })

    await s.ops.standDown(s.agent)
    expect(s.holds.reasons(s.agent)).toEqual(['standDown'])
    // This Mac is no longer the home: the lease goes too.
    expect(s.handle!.calls).toContain('stopWriters')
    expect(s.holds.keepsLease(s.agent)).toBe(false)
    s.handle!.finishDrain!()
    await drained

    // The app is opened again: new holds over the same journal.
    const reopened = new AgentHomeHolds(new AgentHomeJournal(s.store))
    expect(reopened.has(s.agent)).toBe(false)
    reopened.seed(s.agent)
    expect(reopened.reasons(s.agent)).toEqual(['standDown'])
  })

  it('keeps a Mac that was draining for a move quiet after a restart until the move is settled', () => {
    const s = setup()

    s.journal.update(s.agent, entry => {
      entry.managed = true
      entry.move = {
        moveId: randomUUID(),
        idempotencyKey: randomUUID(),
        role: 'source',
        phase: 'drained',
        expectedHomeEpoch: 1,
        expectedPlacementRevision: 1,
        startedAt: 1
      }
    })

    const reopened = new AgentHomeHolds(new AgentHomeJournal(s.store))
    reopened.seed(s.agent)
    expect(reopened.reasons(s.agent)).toEqual(['drain'])
  })

  it('activates with a fresh start, lifts every hold, and forgets the persisted stand-down', async () => {
    const s = setup()
    s.journal.update(s.agent, entry => {
      entry.managed = true
    })
    await s.ops.standDown(s.agent)
    expect(s.journal.read(s.agent).standDown).toBe(true)

    await s.ops.activate(s.agent, s.signal)

    expect(s.holds.has(s.agent)).toBe(false)
    expect(s.journal.read(s.agent).standDown).toBeUndefined()
    // Fresh conversation sessions first, then the app starts the agent the way it starts any agent.
    expect(s.handle!.calls.slice(-2)).toEqual(['beginHere', 'restart'])
  })

  it('does not fail a move because the agent is slow to run: readiness reports tell the truth', async () => {
    const handle = new Recorder()
    handle.up = false
    const s = setup({ handle })

    await expect(s.ops.activate(s.agent, s.signal)).resolves.toBeUndefined()
    expect(s.logs.join('\n')).toContain('not running yet after activation')
    expect(s.ops.readiness(s.agent)).toEqual({ homeAccessible: true, runtimeUsable: false, matrixIntakeWorking: true })
  })

  it('refuses to activate an agent that has no runtime on this Mac, with a closed code', async () => {
    const s = setup({ handle: null })

    await expect(s.ops.activate(s.agent, s.signal)).rejects.toThrow('no_local_agent')
    expect(s.ops.home(s.agent)).toBeNull()
    expect(s.ops.readiness(s.agent)).toEqual({ homeAccessible: false, runtimeUsable: false, matrixIntakeWorking: false })
  })
})

describe('the saved home default model', () => {
  function gated(ready: boolean | Error | (() => Promise<boolean>)) {
    const store = new MemoryStore()
    const journal = new AgentHomeJournal(store)
    const holds = new AgentHomeHolds(journal)
    const agent = randomUUID()
    const handle = new Recorder()
    const asked: string[] = []
    const ops = createHomeRuntimeOps({
      handle: () => handle,
      holds,
      activationWaitMs: 50,
      modelGate: async () => {
        // The agent must already be held, in the journal, while the gate decides: nothing can start it meanwhile.
        asked.push(`held=${holds.reasons(agent).includes('model')} persisted=${journal.read(agent).modelHold === true} stopped=${holds.has(agent)}`)
        if (typeof ready === 'function') {return ready()}
        if (ready instanceof Error) {throw ready}
        return ready
      }
    })

    return { store, journal, holds, agent, handle, ops, asked, signal: new AbortController().signal }
  }

  it('is held, in the journal, before the agent can start, and let go with a start once it is this Mac\'s own', async () => {
    const s = gated(true)
    s.journal.update(s.agent, entry => {
      entry.managed = true
    })
    await s.ops.standDown(s.agent)

    await s.ops.activate(s.agent, s.signal)

    expect(s.asked).toEqual(['held=true persisted=true stopped=true'])
    expect(s.holds.has(s.agent)).toBe(false)
    expect(s.journal.read(s.agent).modelHold).toBeUndefined()
    expect(s.handle.calls.slice(-2)).toEqual(['beginHere', 'restart'])
  })

  it.each([
    ['the choice is not this Mac\'s own yet', false as const],
    ['the choice cannot be read', new Error('platform_unavailable')]
  ])('keeps the agent from starting when %s, and a restart still finds it held', async (_name, ready) => {
    const s = gated(ready)
    s.journal.update(s.agent, entry => {
      entry.managed = true
    })
    await s.ops.standDown(s.agent)

    await expect(s.ops.activate(s.agent, s.signal)).rejects.toThrow('model_unavailable')

    expect(s.handle.calls).not.toContain('restart')
    expect(s.holds.reasons(s.agent)).toEqual(['model'])
    expect(s.holds.keepsLease(s.agent)).toBe(true)
    // The stand-down is lifted (this Mac is the home) but the model hold is the one thing left, and it is persisted.
    expect(s.journal.read(s.agent).standDown).toBeUndefined()
    expect(s.journal.read(s.agent).modelHold).toBe(true)

    const reopened = new AgentHomeHolds(new AgentHomeJournal(s.store))
    expect(reopened.has(s.agent)).toBe(false)
    reopened.seed(s.agent)
    expect(reopened.reasons(s.agent)).toEqual(['model'])
  })

  it('does not decide for an agent whose gate is still deciding', async () => {
    let release: (value: boolean) => void = () => undefined
    const s = gated(() => new Promise<boolean>(resolve => (release = resolve)))
    const activated = s.ops.activate(s.agent, s.signal)

    await Promise.resolve()
    expect(s.holds.has(s.agent)).toBe(true)
    expect(s.handle.calls).not.toContain('restart')

    release(true)
    await activated
    expect(s.holds.has(s.agent)).toBe(false)
    expect(s.handle.calls).toContain('restart')
  })

  it('changes nothing about activation where no gate was given', async () => {
    const s = setup()

    await s.ops.activate(s.agent, s.signal)

    expect(s.holds.has(s.agent)).toBe(false)
    expect(s.journal.read(s.agent).modelHold).toBeUndefined()
    expect(s.handle!.calls.slice(-2)).toEqual(['beginHere', 'restart'])
  })
})
