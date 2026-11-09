import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { beats, kindsSent, macApp } from './app.fixture'
import { HomeToolError } from './home-tool'
import { AgentHomeJournal } from './journal'
import { StubMatrixServer } from './stub-platform.fixture'
import { createWorld } from './world.fixture'

describe('the model assembled for the app', () => {
  it('moves an agent between two Macs and back through the same objects the app builds', async () => {
    const w = await createWorld({ at: 'a' })
    const a = macApp(w, w.a)
    const b = macApp(w, w.b)
    await beats(w, [a, b], 2)

    expect(a.app.isHeld(w.agent) || b.app.isHeld(w.agent)).toBe(false)
    expect((await a.app.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)
    await beats(w, [a, b])

    expect(w.stub.placement(w.agent).location).toEqual({ kind: 'mac', deviceServiceId: w.b.deviceServiceId })
    expect(a.app.isHeld(w.agent)).toBe(true)
    expect(a.app.keepsLease(w.agent)).toBe(false)
    expect(b.app.isHeld(w.agent)).toBe(false)

    expect((await b.app.service.move(w.agent, w.a.deviceServiceId)).ok).toBe(true)
    await beats(w, [a, b])

    expect(w.stub.placement(w.agent).location).toEqual({ kind: 'mac', deviceServiceId: w.a.deviceServiceId })
    expect(a.app.isHeld(w.agent)).toBe(false)
    expect(b.app.isHeld(w.agent)).toBe(true)
    expect(a.changes()).toBeGreaterThan(0)
  })

  it('keeps the answering lease for the drain and the checkpoint, and gives it up only when the move is over', async () => {
    const w = await createWorld({ at: 'a' })
    const a = macApp(w, w.a)
    const b = macApp(w, w.b)
    await beats(w, [a, b], 2)
    expect((await a.app.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)

    // The source drains and checkpoints: held, but the lease is still its own.
    a.app.service.kick()
    await a.app.service.tick()

    expect(a.app.isHeld(w.agent)).toBe(true)
    expect(a.app.keepsLease(w.agent)).toBe(true)
    expect(w.stub.lease(w.agent)?.executorDevice).toBe(w.a.deviceServiceId)

    await beats(w, [a, b])
    expect(a.app.keepsLease(w.agent)).toBe(false)
    expect(a.handle.calls).toContain('stopWriters(keepLease)')
    expect(a.handle.calls).toContain('stopWriters')
  })

  it('publishes nothing from a managed agent on a Mac that is not its home', async () => {
    const w = await createWorld({ at: 'a' })
    const a = macApp(w, w.a)
    const b = macApp(w, w.b)
    await beats(w, [a, b], 2)
    expect((await a.app.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)
    await beats(w, [a, b])

    expect(await a.handle.say('I am still here')).toBe('refused')
    expect(await b.handle.say('I am here')).toBe('sent')
  })

  it('refuses on its own word, before asking anyone, to publish for an agent this Mac stood down', async () => {
    const w = await createWorld({ at: 'a' })
    const a = macApp(w, w.a)
    const b = macApp(w, w.b)
    await beats(w, [a, b], 2)
    expect((await a.app.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)
    await beats(w, [a, b])
    expect(a.app.isHeld(w.agent)).toBe(true)

    // The platform now says this Mac is the home again (nobody activated the agent here): the stand-down still
    // stands, and nothing is asked to say no.
    w.stub.hijack(w.agent, { kind: 'mac', deviceServiceId: w.a.deviceServiceId })
    w.clock.advance(10_000)
    const asked = w.stub.requests.length

    expect(await a.handle.say('I am the home again?')).toBe('refused')
    expect(w.stub.requests.length).toBe(asked)
  })

  it('ends a move cleanly when the Hermes runtime is not there: the agent keeps answering where it is', async () => {
    const w = await createWorld({ at: 'a' })
    const a = macApp(w, w.a, { runtime: false })
    const b = macApp(w, w.b)
    await beats(w, [a, b], 2)
    expect((await a.app.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)
    await beats(w, [a, b], 16)

    expect(w.stub.placement(w.agent).location).toEqual({ kind: 'mac', deviceServiceId: w.a.deviceServiceId })
    expect(w.stub.placement(w.agent).activeMove).toBeNull()
    expect(a.app.isHeld(w.agent)).toBe(false)
    expect(await a.handle.say('still here')).toBe('sent')
    await expect(a.app.controller.ctx.tool.capture({ home: a.home, out: '/x', homeId: w.agent, generation: 2, parentGeneration: 1, homeEpoch: 1 }, new AbortController().signal)).rejects.toBeInstanceOf(HomeToolError)
  })

  it('sweeps what a killed process left in its work folder when the app starts, keeping only the checkpoint the journal names', async () => {
    const w = await createWorld({ at: 'a' })
    const live = randomUUID()
    let kept = ''
    let gone: string[] = []

    macApp(w, w.a, {
      beforeStart: ({ work }) => {
        // What the dead process had staged: the checkpoint the journal still names, an older one, and a restore.
        const stage = (name: string) => {
          mkdirSync(path.join(work, w.agent, name), { recursive: true })
          writeFileSync(path.join(work, w.agent, name, 'checkpoint.sealed'), 'sealed')

          return path.join(work, w.agent, name)
        }

        kept = stage(live)
        gone = [stage(randomUUID()), stage(`restore-2-${randomUUID()}`)]

        new AgentHomeJournal(w.a.store).update(w.agent, entry => {
          entry.checkpoint = { checkpointId: live, reason: 'idle', phase: 'reserved', startedAt: w.clock.now() }
        })
      }
    })

    expect(existsSync(path.join(kept, 'checkpoint.sealed'))).toBe(true)

    for (const folder of gone) {
      expect(existsSync(folder), folder).toBe(false)
    }
  })

  it('does nothing at all until the account is ready', async () => {
    const w = await createWorld({ at: 'a' })
    const a = macApp(w, w.a, { ready: () => false })

    await a.app.service.tick()
    expect(w.stub.requests).toHaveLength(0)
    expect(a.app.isHeld(w.agent)).toBe(false)
  })
})

describe('what a migrated agent says in a room', () => {
  /** An agent that has moved once: it is under the model on both Macs, and the Mac mini is its home. */
  async function moved() {
    const matrix = new StubMatrixServer()
    const w = await createWorld({ at: 'a' })
    const a = macApp(w, w.a, { matrix })
    const b = macApp(w, w.b, { matrix })
    await beats(w, [a, b], 2)
    expect((await a.app.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)
    await beats(w, [a, b])
    expect(w.stub.placement(w.agent).location).toEqual({ kind: 'mac', deviceServiceId: w.b.deviceServiceId })

    return { w, a, b, matrix }
  }

  it('reaches the room only through the platform: prepared in the SDK window, never sent from it', async () => {
    const { w, b, matrix } = await moved()
    const invocationId = '00000000-0000-4000-8000-bd7662a5eeb4'

    expect(b.app.isMigrated(w.agent)).toBe(true)
    expect(await b.handle.say('from the Mac mini', { invocationId })).toBe('sent')

    // The window was asked to prepare the bytes and was never asked to send.
    expect(kindsSent(b)).toContain('prepareResult')
    expect(kindsSent(b)).not.toContain('publishResult')
    // The platform's worker sent them, once, and its ledger recorded the event.
    expect(matrix.events).toHaveLength(1)
    expect(JSON.parse(matrix.events[0]!.bytes.toString('utf8')).body).toBe('from the Mac mini')
    expect(w.stub.ledgerPublished(w.agent, { kind: 'invocation', id: invocationId })).toBe(matrix.events[0]!.eventId)
    // So the legacy acknowledgement is not due for it.
    expect(b.app.outboxed(w.agent, invocationId)).toBe(true)
    expect(b.app.outboxed(w.agent, '00000000-0000-4000-8000-b454f82c5857')).toBe(false)
  })

  it('leaves an agent the model has not taken over exactly as it was: its result goes straight to the room', async () => {
    const matrix = new StubMatrixServer()
    const w = await createWorld({ at: 'a' })
    const a = macApp(w, w.a, { matrix })
    await beats(w, [a], 2)

    expect(a.app.isMigrated(w.agent)).toBe(false)
    expect(await a.handle.say('as before')).toBe('sent')

    expect(kindsSent(a)).toEqual(['publishResult'])
    expect(matrix.events).toHaveLength(0)
    expect(w.stub.outboxRows(w.agent)).toHaveLength(0)
  })

  it('has nowhere to put a result that is not on the platform’s ledger: it is refused, not sent', async () => {
    const { b, matrix } = await moved()

    expect(await b.handle.say('a notice with no invocation behind it', { ledger: false })).toBe('refused')

    expect(kindsSent(b)).toEqual([])
    expect(matrix.events).toHaveLength(0)
  })

  it('still says its piece when a move is only asked for: the turn in flight finishes, and the move waits for it', async () => {
    const { w, a, b, matrix } = await moved()
    // The agent comes home again: a move back is asked for while the Mac mini is still answering.
    expect((await b.app.service.move(w.agent, w.a.deviceServiceId)).ok).toBe(true)
    expect(w.stub.placement(w.agent).activeMove).not.toBeNull()
    const invocationId = '00000000-0000-4000-8000-f1d11edf5c5c'

    // Before the drain is acknowledged the platform still takes the source's result, tagged with the move.
    expect(await b.handle.say('a turn that finished after the move was asked for', { invocationId })).toBe('sent')

    expect(kindsSent(b)).not.toContain('publishResult')
    expect(matrix.events).toHaveLength(1)
    expect(w.stub.ledgerPublished(w.agent, { kind: 'invocation', id: invocationId })).toBe(matrix.events[0]!.eventId)
    expect(w.stub.outboxRows(w.agent).at(-1)).toMatchObject({ sourceMoveId: w.stub.placement(w.agent).activeMove!.moveId, state: 'published' })

    // And the move goes on to its end with that message in the room exactly once.
    await beats(w, [a, b])
    expect(w.stub.placement(w.agent).location).toEqual({ kind: 'mac', deviceServiceId: w.a.deviceServiceId })
    expect(matrix.events).toHaveLength(1)
  })

  it('is refused for good once the drain is acknowledged, and nothing is sent in its place', async () => {
    const { w, a, b, matrix } = await moved()
    expect((await b.app.service.move(w.agent, w.a.deviceServiceId)).ok).toBe(true)

    // The Mac mini drains and acknowledges: from here it says nothing more as the home.
    b.app.service.kick(w.agent)
    await b.app.service.tick()
    expect(w.stub.moves(w.agent).at(-1)!.status).not.toBe('requested')

    expect(await b.handle.say('a turn that finished after the drain was acknowledged')).toBe('refused')

    expect(kindsSent(b)).not.toContain('publishResult')
    expect(matrix.events).toHaveLength(0)
    void a
  })

  it('keeps what it prepared when the platform has no such route, and does not prepare it again when the route is there', async () => {
    const { w, b, matrix } = await moved()
    const invocationId = '00000000-0000-4000-8000-f6222a1106ee'

    w.stub.publicationsRoute = false
    expect(await b.handle.say('said twice, prepared once', { invocationId })).toBe('refused')
    expect(kindsSent(b).filter(kind => kind === 'prepareResult')).toHaveLength(1)
    expect(matrix.events).toHaveLength(0)

    w.stub.publicationsRoute = true
    expect(await b.handle.say('said twice, prepared once', { invocationId })).toBe('sent')

    expect(kindsSent(b).filter(kind => kind === 'prepareResult')).toHaveLength(1)
    expect(kindsSent(b)).not.toContain('publishResult')
    expect(matrix.events).toHaveLength(1)
  })
})

/** What each kind of command would be, as the app sends it. */
const EMISSIONS: Record<string, { kind: string; [key: string]: unknown }> = {
  publishCron: { kind: 'publishCron', roomId: '!room:atum.example', body: 'daily', runId: 'run-1', jobId: 'job-1' },
  publishNotice: { kind: 'publishNotice', roomId: '!room:atum.example', body: 'working' },
  publishGroupNotice: { kind: 'publishGroupNotice', roomId: '!room:atum.example', body: 'joined' },
  sendAgentTask: { kind: 'sendAgentTask', roomId: '!room:atum.example', taskId: 't-1', action: 'stopped', body: 'stopped' }
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe('one writer for an agent, whatever it says', () => {
  /** An agent that has moved to the Mac mini: the MacBook has stood it down, the Mac mini is the home. */
  async function movedToMini() {
    const matrix = new StubMatrixServer()
    const w = await createWorld({ at: 'a' })
    const a = macApp(w, w.a, { matrix })
    const b = macApp(w, w.b, { matrix })
    await beats(w, [a, b], 2)
    expect((await a.app.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)
    await beats(w, [a, b])
    expect(w.stub.placement(w.agent).location).toEqual({ kind: 'mac', deviceServiceId: w.b.deviceServiceId })
    expect(a.app.isHeld(w.agent)).toBe(true)

    return { w, a, b, matrix }
  }

  it.each(Object.keys(EMISSIONS))('refuses %s from the Mac that stood the agent down, asks nobody, and sends nothing', async name => {
    const { w, a } = await movedToMini()
    const asked = w.stub.requests.length
    const sent = a.handle.queue.sent.length

    expect(await a.handle.emit(EMISSIONS[name]!)).toBe('refused')

    expect(w.stub.requests.length).toBe(asked)
    expect(a.handle.queue.sent.length).toBe(sent)
  })

  it('refuses a result too from the Mac that stood the agent down, ledgered or not', async () => {
    const { w, a, matrix } = await movedToMini()
    const asked = w.stub.requests.length

    expect(await a.handle.say('a result from the old home')).toBe('refused')
    expect(await a.handle.say('a notice with no invocation', { ledger: false })).toBe('refused')

    expect(w.stub.requests.length).toBe(asked)
    expect(a.handle.queue.sent).toEqual([])
    expect(matrix.events).toHaveLength(0)
  })

  it('refuses the owner’s task files for an agent this Mac stood down, before anything is sent', async () => {
    const { w, a } = await movedToMini()
    const asked = w.stub.requests.length
    let sent = 0

    await expect(a.app.fence(w.agent, 'sendTaskFiles', async () => { sent += 1 })).rejects.toMatchObject({ name: 'NotTheHomeError' })

    expect(sent).toBe(0)
    expect(w.stub.requests.length).toBe(asked)
  })

  it('answers "not available" for the owner’s task files on a Mac that stood the agent down, and "available" on the home, without sending anything', async () => {
    const { w, a, b } = await movedToMini()
    const asked = w.stub.requests.length

    expect(await a.app.allows(w.agent, 'sendTaskFiles')).toBe(false)
    expect(w.stub.requests.length).toBe(asked)

    expect(await b.app.allows(w.agent, 'sendTaskFiles')).toBe(true)
    expect(w.stub.requests.length).toBe(asked + 1)
  })

  it('does not ask the platform whether the owner’s task files may go for an agent that was never moved', async () => {
    const w = await createWorld({ at: 'a' })
    const a = macApp(w, w.a)
    await beats(w, [a], 2)
    const asked = w.stub.requests.length

    expect(await a.app.allows(w.agent, 'sendTaskFiles')).toBe(true)
    expect(w.stub.requests.length).toBe(asked)
  })

  it.each(Object.keys(EMISSIONS))('lets the new home say %s, after asking the platform right then', async name => {
    const { w, b } = await movedToMini()
    const before = w.stub.requests.filter(request => request.method === 'GET').length

    expect(await b.handle.emit(EMISSIONS[name]!)).toBe('sent')
    expect(await b.handle.emit(EMISSIONS[name]!)).toBe('sent')

    expect(kindsSent(b).filter(kind => kind === EMISSIONS[name]!.kind)).toHaveLength(2)
    // Two sends, two questions: no verdict from the first stands in for the second.
    expect(w.stub.requests.filter(request => request.method === 'GET').length - before).toBe(2)
  })

  it('lets the new home send the owner’s task files, and counts them while they go', async () => {
    const { w, b } = await movedToMini()
    let sent = 0

    await expect(b.app.fence(w.agent, 'sendTaskFiles', async () => { sent += 1;

 return '$task' })).resolves.toBe('$task')

    expect(sent).toBe(1)
  })

  it('does not acknowledge the drain until what the agent was saying directly has landed, then says nothing more directly', async () => {
    const w = await createWorld({ at: 'a' })
    const a = macApp(w, w.a)
    const b = macApp(w, w.b)
    await beats(w, [a, b], 2)

    // A status notice is on its way to the room when the owner asks for the move.
    let land!: () => void
    a.handle.queue.pause = command => (command.kind === 'publishNotice' ? new Promise<void>(resolve => { land = resolve }) : undefined)
    const notice = a.handle.emit(EMISSIONS.publishNotice!)
    await wait(5)

    expect((await a.app.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)
    a.app.service.kick(w.agent)
    const pass = a.app.service.tick()
    await wait(120)

    // The Mac is waiting for the notice: the move has not been told the agent is quiet.
    expect(w.stub.requests.some(request => request.action === 'DrainAck')).toBe(false)
    expect(w.stub.moves(w.agent)[0]!.status).toBe('requested')

    // Nothing new starts meanwhile: the barrier is up.
    a.handle.queue.pause = null
    expect(await a.handle.emit(EMISSIONS.publishCron!)).toBe('refused')
    expect(kindsSent(a)).not.toContain('publishCron')

    const requestsBefore = w.stub.requests.length
    land()
    expect(await notice).toBe('sent')
    await pass

    // Only now is the drain acknowledged, after the notice and never before it.
    const ack = w.stub.requests.findIndex(request => request.action === 'DrainAck')
    expect(ack).toBeGreaterThanOrEqual(requestsBefore)
    expect(w.stub.moves(w.agent)[0]!.status).not.toBe('requested')
  })

  it('does not acknowledge a drain it cannot make quiet: the move ends and the agent speaks again', async () => {
    const w = await createWorld({ at: 'a' })
    const a = macApp(w, w.a)
    const b = macApp(w, w.b)
    await beats(w, [a, b], 2)

    // A send that never lands (a window that stopped answering).
    a.handle.queue.pause = command => (command.kind === 'publishNotice' ? new Promise<void>(() => undefined) : undefined)
    void a.handle.emit(EMISSIONS.publishNotice!)
    await wait(5)
    a.handle.queue.pause = null

    expect((await a.app.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)
    await beats(w, [a, b], 6)

    // The drain ran out of time and said so: the platform ended the move, the agent is where it was, and speaks.
    expect(w.stub.moves(w.agent)[0]).toMatchObject({ status: 'aborted' })
    expect(w.stub.placement(w.agent).location).toEqual({ kind: 'mac', deviceServiceId: w.a.deviceServiceId })
    expect(await a.handle.emit(EMISSIONS.publishCron!)).toBe('sent')
  })

  it('lets a move that ends without a commit leave the agent able to speak directly again', async () => {
    const w = await createWorld({ at: 'a' })
    const a = macApp(w, w.a)
    const b = macApp(w, w.b)
    await beats(w, [a, b], 2)
    expect((await a.app.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)
    a.app.service.kick(w.agent)
    await a.app.service.tick()
    expect(await a.handle.emit(EMISSIONS.publishNotice!)).toBe('refused')

    expect((await a.app.service.cancel(w.agent)).ok).toBe(true)
    await beats(w, [a, b], 4)

    expect(w.stub.placement(w.agent).activeMove).toBeNull()
    expect(await a.handle.emit(EMISSIONS.publishNotice!)).toBe('sent')
  })

  describe('an agent that was never moved', () => {
    it('speaks without waiting for a platform that never answers', async () => {
      const w = await createWorld({ at: 'a' })
      const never: typeof fetch = () => new Promise<Response>(() => undefined)
      const a = macApp(w, w.a, { fetch: never })

      for (const name of Object.keys(EMISSIONS)) {
        const outcome = await Promise.race([a.handle.emit(EMISSIONS[name]!), wait(100).then(() => 'still waiting')])

        expect(outcome).toBe('sent')
      }

      expect(await Promise.race([a.handle.say('an answer'), wait(100).then(() => 'still waiting')])).toBe('sent')
    })

    it('is looked at in the background while it speaks, not before it may', async () => {
      const w = await createWorld({ at: 'a' })
      const a = macApp(w, w.a)
      const kicked: Array<string | undefined> = []
      const kick = a.app.service.kick.bind(a.app.service)

      a.app.service.kick = (agent?: string) => {
        kicked.push(agent)
        kick(agent)
      }

      expect(await a.handle.emit(EMISSIONS.publishNotice!)).toBe('sent')
      expect(await a.handle.emit(EMISSIONS.publishCron!)).toBe('sent')

      // Once, not once per word: the throttle is a quarter minute.
      expect(kicked).toEqual([w.agent])

      w.clock.advance(16_000)
      expect(await a.handle.emit(EMISSIONS.publishNotice!)).toBe('sent')
      expect(kicked).toEqual([w.agent, w.agent])
    })

    it('is noticed as moved by its own background look, even if it never spoke', async () => {
      const w = await createWorld({ at: 'a' })
      const a = macApp(w, w.a)
      const b = macApp(w, w.b)
      await beats(w, [a, b], 2)
      expect(a.app.isMigrated(w.agent)).toBe(false)

      // The owner asks, on the Mac mini, for the agent to come to it. The MacBook was not asked anything.
      expect((await b.app.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)
      expect(a.app.isMigrated(w.agent)).toBe(false)

      // Its slow loop (every thirty seconds, no kick) is what finds out; the agent never had to speak first.
      w.clock.advance(31_000)
      await a.app.service.tick()

      expect(a.app.controller.ctx.journal.read(w.agent).managed).toBe(true)
      expect(a.app.service.view(w.agent)?.move?.role).toBe('source')
    })
  })

  describe('the rollout: the platform’s publication worker is switched off', () => {
    it('sends a governed agent’s result the way it always did, once, and the legacy acknowledgement is due for it', async () => {
      const { w, b, matrix } = await movedToMini()
      const invocationId = '00000000-0000-4000-8000-fbfe405ca65f'
      w.stub.publicationsEnabled = false

      expect(await b.handle.say('answered while the worker is off', { invocationId })).toBe('sent')

      // Straight from the window, as before; the platform's outbox never saw it.
      expect(kindsSent(b).filter(kind => kind === 'publishResult')).toHaveLength(1)
      expect(w.stub.outboxRows(w.agent)).toHaveLength(0)
      expect(matrix.events).toHaveLength(0)
      expect(b.app.outboxed(w.agent, invocationId)).toBe(false)
    })

    it('goes through the outbox again once the worker is on, and never sends directly around an accepted row', async () => {
      const { w, b, matrix } = await movedToMini()
      w.stub.publicationsEnabled = false
      expect(await b.handle.say('direct while off')).toBe('sent')
      w.stub.publicationsEnabled = true
      const invocationId = '00000000-0000-4000-8000-a9703d75e616'

      expect(await b.handle.say('through the platform', { invocationId })).toBe('sent')

      expect(kindsSent(b).filter(kind => kind === 'publishResult')).toHaveLength(1)
      expect(matrix.events).toHaveLength(1)
      expect(b.app.outboxed(w.agent, invocationId)).toBe(true)
    })

    it('does not send directly from a Mac that is draining the agent away once the barrier is up', async () => {
      const w = await createWorld({ at: 'a' })
      const matrix = new StubMatrixServer()
      const a = macApp(w, w.a, { matrix })
      const b = macApp(w, w.b, { matrix })
      await beats(w, [a, b], 2)
      expect((await a.app.service.move(w.agent, w.b.deviceServiceId)).ok).toBe(true)
      a.app.service.kick(w.agent)
      await a.app.service.tick()
      w.stub.publicationsEnabled = false

      // The agent is switched to the outbox only; the outbox is off; so nothing is said, and nothing is said around it.
      expect(await a.handle.say('a result after the drain')).toBe('refused')
      expect(kindsSent(a)).not.toContain('publishResult')
    })
  })
})
