import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { AgentHomeController, type ControllerOptions } from './controller'
import { Crash, createNode, type Node, pass } from './node.fixture'
import { createWorld, signal, type World } from './world.fixture'

const read = (node: Node, relative: string): string | null => {
  const file = path.join(node.home, relative)

  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/** Keep the answering lease alive the way the Mac's renewal loop would. */
function renew(w: World): void {
  if (w.stub.lease(w.agent)) {
    w.stub.renewLease(w.agent)
  }
}

/** Passes for each node in turn until nothing changes; a crash restarts that node and carries on. */
async function settle(w: World, nodes: Node[], rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const node of nodes) {
      renew(w)

      try {
        await pass(node, w.agent)
      } catch (error) {
        if (!(error instanceof Crash)) {
          throw error
        }

        node.restart()
      }
    }

    w.clock.advance(1_000)
  }
}

async function twoMacs(options: { budgets?: ControllerOptions['budgets'] } = {}) {
  const w = await createWorld({ at: 'a' })

  const a = createNode(w, w.a, {
    budgets: options.budgets,
    files: {
      'memories/MEMORY.md': 'A: the code word is lotus.',
      'memories/only-on-a.md': 'learned on A',
      'SOUL.md': 'You are Test.',
      'skills/notes/SKILL.md': '# Notes (A)',
      'state.db': 'A-SESSION-HISTORY',
      '.env': 'OPENAI_API_KEY=a-own-key',
      'auth.json': '{"token":"a-token"}',
      'cron/jobs.json': '[]'
    }
  })

  const b = createNode(w, w.b, {
    budgets: options.budgets,
    files: {
      'memories/MEMORY.md': 'B: an older memory.',
      'memories/only-on-b.md': 'stale on B',
      'state.db': 'B-SESSION-HISTORY',
      '.env': 'OPENAI_API_KEY=b-own-key',
      'auth.json': '{"token":"b-token"}'
    }
  })

  // A is the home and holds the lease (the world granted it); the agent answers there.
  a.runtime.wantsLease = true

  return { w, a, b }
}

const moveTo = async (node: Node, w: World, target: Node) => {
  const result = await node.controller.requestMove(w.agent, target.mac.deviceServiceId, signal())

  if (!result.ok) {
    throw new Error(`move not requested: ${result.ok === false ? result.reason : ''}`)
  }

  return result.moveId
}

describe('moving an agent from one Mac to another and back', () => {
  it('a ready recovery on a fresh source never asks for another drain acknowledgement', async () => {
    const { w, a, b } = await twoMacs()
    await moveTo(a, w, b)
    const ready = w.stub.placement(w.agent)
    ready.activeMove!.status = 'ready_to_commit'
    a.controller.ctx.platform.readPlacement = async () => ({ ok: true, value: ready })
    await pass(a, w.agent)
    expect(a.runtime.calls).not.toContain('drain')
    expect(a.controller.ctx.journal.read(w.agent).move).toMatchObject({ role: 'source', phase: 'drained', forced: true })
  })

  it('stands a non-home Mac down only once per observed home epoch', async () => {
    const { w, a, b } = await twoMacs()
    const placement = w.stub.placement(w.agent)
    placement.location = { kind: 'mac', deviceServiceId: b.mac.deviceServiceId }
    placement.homeEpoch = 2
    const notHome = vi.fn(async () => undefined)
    const controller = new AgentHomeController({ ...a.controller.ctx, journalStore: a.mac.store, notHome })
    controller.ctx.platform.readPlacement = async () => ({ ok: true, value: placement })
    await controller.reconcile(w.agent, signal())
    await controller.reconcile(w.agent, signal())
    expect(notHome).toHaveBeenCalledTimes(1)
    placement.homeEpoch = 3
    await controller.reconcile(w.agent, signal())
    expect(notHome).toHaveBeenCalledTimes(2)
  })

  it('reports post-commit startup failure and retries activation without restoring over the new home', async () => {
    const { w, a, b } = await twoMacs()
    await moveTo(a, w, b)
    await pass(a, w.agent)
    const activate = b.runtime.activate.bind(b.runtime)
    b.runtime.activate = async () => { throw new Error('runtime_not_ready') }
    await pass(b, w.agent)
    expect(b.controller.view(w.agent)).toMatchObject({ activation: { state: 'not_ready', reason: 'runtime_not_ready' } })
    expect(w.stub.placement(w.agent).location).toMatchObject({ deviceServiceId: b.mac.deviceServiceId })
    writeFileSync(path.join(b.home, 'memories/MEMORY.md'), 'new home already restored')
    b.runtime.activate = activate
    await pass(a, w.agent)
    await pass(b, w.agent)
    expect(b.tool.restores.filter(each => !each.verifyOnly)).toHaveLength(1)
    expect(read(b, 'memories/MEMORY.md')).toBe('new home already restored')
  })

  it('A -> B: the source drains and saves, the target takes over, the old home stands down', async () => {
    const { w, a, b } = await twoMacs()

    // Before the move the agent answers on A and nothing in the placement model touches it.
    expect(await a.runtime.say('hello from A')).toBe('sent')
    expect(await b.runtime.say('hello from B')).toBe('sent')
    expect(a.controller.view(w.agent)).toBeNull()

    await moveTo(a, w, b)

    // The source: drain, acknowledge, final checkpoint. Not one new word is admitted from here on.
    await pass(a, w.agent)
    expect(a.runtime.calls.slice(0, 3)).toEqual(['drain', 'quiesce', 'release'])
    expect(w.stub.moves(w.agent)[0]).toMatchObject({ status: 'ready_to_commit', checkpointGeneration: 2 })
    expect(await a.runtime.say('still talking')).toBe('refused')
    expect(a.controller.view(w.agent)).toMatchObject({ lives: { kind: 'mac', thisMac: true }, move: { step: 'handing_over', role: 'source' } })

    // The target: verify, then the point of no return, then restore and activate.
    await pass(b, w.agent)
    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 2, location: { kind: 'mac', deviceServiceId: w.b.deviceServiceId }, selectedGeneration: 2, activeMove: null })
    expect(read(b, 'memories/MEMORY.md')).toBe('A: the code word is lotus.')
    expect(read(b, 'memories/only-on-a.md')).toBe('learned on A')
    expect(read(b, 'skills/notes/SKILL.md')).toBe('# Notes (A)')
    // Its own state that was never moved stays: the replaced memory is saved, the stale one removed after saving.
    expect(read(b, 'memories/only-on-b.md')).toBeNull()
    expect(readdirSync(path.join(b.root, 'backups', w.agent, '2', 'memories')).sort()).toEqual(['MEMORY.md', 'only-on-b.md'])
    expect(readFileSync(path.join(b.root, 'backups', w.agent, '2', 'memories', 'MEMORY.md'), 'utf8')).toBe('B: an older memory.')
    // Session history and credentials never move: B keeps its own and gets none of A's.
    expect(read(b, 'state.db')).toBe('B-SESSION-HISTORY')
    expect(read(b, '.env')).toBe('OPENAI_API_KEY=b-own-key')
    expect(read(b, 'auth.json')).toBe('{"token":"b-token"}')
    expect(b.runtime.freshSessions).toBe(1)
    expect(b.runtime.calls).toContain('activate')

    // The old home notices and stands down: it gives up its lease and answers nothing.
    await pass(a, w.agent)
    expect(a.runtime.calls).toContain('standDown')
    expect(w.stub.lease(w.agent)).toBeNull()
    expect(await a.runtime.say('I am stale')).toBe('refused')
    expect(a.controller.view(w.agent)).toMatchObject({ lives: { kind: 'mac', thisMac: false }, move: null })
    // Nothing newer than the committed generation: no quarantined copy is needed.
    expect(a.tool.exports).toEqual([])

    // The new home answers, holds the lease once it is free, and reports it can.
    expect(await b.runtime.say('hello from the new home')).toBe('sent')
    await pass(b, w.agent)
    expect(w.stub.lease(w.agent)?.executorDevice).toBe(w.b.deviceServiceId)
    expect(w.stub.readiness(w.agent)).toMatchObject({ reachable: true, homeEpoch: 2 })
    expect(b.controller.view(w.agent)).toMatchObject({ lives: { kind: 'mac', thisMac: true }, move: null, issue: null })
  })

  it('B -> A: the agent comes back with what it learned on the other Mac, and still no history or credential moves', async () => {
    const { w, a, b } = await twoMacs()

    await moveTo(a, w, b)
    await settle(w, [a, b], 4)

    // While it lives on B it learns something and B's own state grows.
    writeFileSync(path.join(b.home, 'memories', 'learned-on-b.md'), 'learned on B while it lived there')
    writeFileSync(path.join(b.home, 'memories', 'MEMORY.md'), 'B: the code word is now jasmine.')
    writeFileSync(path.join(b.home, 'state.db'), 'B-SESSION-HISTORY-GREW')
    writeFileSync(path.join(a.home, 'memories', 'stale-on-a.md'), 'a copy of old state left on A')

    await moveTo(b, w, a)
    await settle(w, [a, b], 6)

    expect(w.stub.placement(w.agent)).toMatchObject({
      homeEpoch: 3,
      selectedGeneration: 3,
      location: { kind: 'mac', deviceServiceId: w.a.deviceServiceId },
      activeMove: null
    })
    expect(read(a, 'memories/MEMORY.md')).toBe('B: the code word is now jasmine.')
    expect(read(a, 'memories/learned-on-b.md')).toBe('learned on B while it lived there')
    // A kept nothing of the old copy the checkpoint does not have, but saved it first.
    expect(read(a, 'memories/stale-on-a.md')).toBeNull()
    expect(readFileSync(path.join(a.root, 'backups', w.agent, '3', 'memories', 'stale-on-a.md'), 'utf8')).toBe('a copy of old state left on A')
    // History and credentials stayed where they were.
    expect(read(a, 'state.db')).toBe('A-SESSION-HISTORY')
    expect(read(a, '.env')).toBe('OPENAI_API_KEY=a-own-key')
    expect(read(b, 'state.db')).toBe('B-SESSION-HISTORY-GREW')
    expect(a.runtime.freshSessions).toBe(1)

    // A answers again; B does not.
    expect(await a.runtime.say('back on A')).toBe('sent')
    expect(await b.runtime.say('I am stale now')).toBe('refused')
    await pass(a, w.agent)
    expect(w.stub.lease(w.agent)?.executorDevice).toBe(w.a.deviceServiceId)
    expect(w.stub.readiness(w.agent)).toMatchObject({ reachable: true, homeEpoch: 3 })
    // Each Mac has been the source of one move and the target of one, and every generation is in order.
    expect(w.stub.checkpoints(w.agent).map(checkpoint => [checkpoint.generation, checkpoint.state])).toEqual([[2, 'committed'], [3, 'committed']])
  })

  it('never has two Macs answering at once, at any step of the move', async () => {
    const { w, a, b } = await twoMacs()
    const seen: string[] = []

    // An agent the model does not govern (yet) on a Mac answers only if that Mac holds its answering lease: today's rule,
    // which this model leaves alone and which is what keeps a Mac that has not heard of the move quiet. A governed
    // agent is the placement model's: its guard asks the platform every time.
    const mayAnswer = (node: typeof a) => {
      const lease = w.stub.lease(w.agent)

      return (
        node.controller.ctx.journal.read(w.agent).managed ||
        (lease?.executorDevice === node.mac.deviceServiceId && lease.expiresAt > w.clock.now())
      )
    }

    const answering = async () => {
      const sent = [
        mayAnswer(a) && (await a.runtime.say('x')) === 'sent' ? 'A' : '',
        mayAnswer(b) && (await b.runtime.say('x')) === 'sent' ? 'B' : ''
      ].filter(Boolean)

      w.clock.advance(6_000)

      if (w.stub.lease(w.agent)) {
        w.stub.renewLease(w.agent)
      }

      seen.push(sent.join('+') || 'none')

      return sent.length
    }

    expect(await answering()).toBe(1) // before the move neither Mac is governed: the lease holder answers, as today
    await moveTo(a, w, b)
    expect(await answering()).toBeLessThanOrEqual(1)
    await pass(a, w.agent)
    expect(await answering()).toBeLessThanOrEqual(1)
    await pass(b, w.agent)
    expect(await answering()).toBeLessThanOrEqual(1)
    await pass(a, w.agent)
    expect(await answering()).toBe(1)
    expect(seen.at(-1)).toBe('B')
  })
})

describe('a move that does not finish', () => {
  it('ends when the turn in flight will not finish: the drain says so, the platform ends the move, the agent answers on', async () => {
    const { w, a, b } = await twoMacs()
    a.runtime.startTurn()
    a.runtime.drainTimesOut = true
    await moveTo(a, w, b)

    await pass(a, w.agent)

    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 1, activeMove: null, location: { deviceServiceId: w.a.deviceServiceId } })
    expect(a.runtime.calls).toContain('resume')
    expect(w.stub.checkpoints(w.agent)).toEqual([])
    expect(a.controller.ctx.journal.read(w.agent).move).toBeUndefined()
  })

  it('ends when the owner cancels: the source answers again and nothing was committed', async () => {
    const { w, a, b } = await twoMacs()
    await moveTo(a, w, b)
    await pass(a, w.agent)
    expect(await a.runtime.say('quiet')).toBe('refused')

    expect(await a.controller.cancelMove(w.agent, signal())).toEqual({ ok: true })
    await pass(a, w.agent)

    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 1, activeMove: null })
    expect(a.runtime.calls.at(-1)).toBe('resume')
    expect(await a.runtime.say('back')).toBe('sent')
    // The target, which never saw the move complete, changed nothing.
    await pass(b, w.agent)
    expect(read(b, 'memories/MEMORY.md')).toBe('B: an older memory.')
    expect(b.tool.restores.filter(entry => !entry.verifyOnly)).toEqual([])
  })

  it('ends when this Mac has no lease term to sign the hand-over with: it does not sit silent until the platform gives up', async () => {
    const { w, a, b } = await twoMacs()
    // The answering lease is gone (the Mac was not listening): there is nothing to fence a drain with.
    a.runtime.wantsLease = false
    w.stub.releaseLease(w.agent)
    await moveTo(a, w, b)

    await pass(a, w.agent)
    // Nothing was acknowledged, so the platform still has the move as asked for.
    expect(w.stub.moves(w.agent)[0]!.status).toBe('requested')
    expect(a.controller.view(w.agent)?.issue).toBe('lease_term_unavailable')
    // Until the drain is acknowledged the turn in flight may still say its piece; nothing new is admitted.
    expect(a.runtime.admitting).toBe(false)
    await pass(a, w.agent)
    await pass(a, w.agent)

    expect(w.stub.moves(w.agent)[0]).toMatchObject({ status: 'aborted' })
    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 1, activeMove: null, location: { deviceServiceId: w.a.deviceServiceId } })
    expect(a.runtime.calls.at(-1)).toBe('resume')
    // The owner is told why it stayed, and the agent answers again.
    expect(a.controller.view(w.agent)?.issue).toBe('lease_term_unavailable')
    expect(await a.runtime.say('back')).toBe('sent')
  })

  it('waits, without ending the move, while the platform cannot be reached to acknowledge the drain', async () => {
    const { w, a, b } = await twoMacs()
    await moveTo(a, w, b)

    // The acknowledgement cannot get through (the placement read in front of it does).
    w.a.platform.ackDrain = async () => ({ ok: false, kind: 'unavailable', status: 503 })

    for (let i = 0; i < 4; i += 1) {
      await pass(a, w.agent)
    }

    expect(w.stub.moves(w.agent)[0]!.status).toBe('requested')
    expect(a.controller.ctx.journal.read(w.agent).move?.attempts).toBe(0)
  })

  it('ends by itself when the target never comes: the source does not stay silent for ever', async () => {
    const { w, a, b } = await twoMacs()
    await moveTo(a, w, b)
    await pass(a, w.agent)
    expect(await a.runtime.say('quiet')).toBe('refused')

    w.clock.advance(16 * 60_000)
    renew(w)
    await pass(a, w.agent)

    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 1, activeMove: null })
    expect(w.stub.moves(w.agent)[0]).toMatchObject({ status: 'aborted' })
    expect(await a.runtime.say('back')).toBe('sent')
  })

  it('ends when the final checkpoint cannot be taken after the tries it is allowed', async () => {
    const { w, a, b } = await twoMacs()
    w.stub.archivePutFails = true
    await moveTo(a, w, b)

    await pass(a, w.agent)
    expect(w.stub.moves(w.agent)[0]!.status).toBe('draining')
    expect(a.controller.view(w.agent)?.issue).toBe('upload_failed')
    await pass(a, w.agent)
    await pass(a, w.agent)

    expect(w.stub.moves(w.agent)[0]).toMatchObject({ status: 'aborted' })
    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 1, selectedGeneration: 1, activeMove: null })
    expect(await a.runtime.say('back')).toBe('sent')
  })

  it('does not commit a move to a Mac that cannot read the checkpoint, and gives up after the tries it is allowed', async () => {
    const { w, a, b } = await twoMacs()
    await moveTo(a, w, b)
    await pass(a, w.agent)

    // The stored bytes are damaged on their way: they no longer open for this home and generation.
    const key = `${w.stub.placement(w.agent).homeId}:2`
    const damaged = Buffer.from(w.stub.archives.get(key)!)
    damaged[damaged.length - 20]! ^= 0xff
    w.stub.archives.set(key, damaged)

    await pass(b, w.agent)
    await pass(b, w.agent)
    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 1 })
    expect(b.controller.view(w.agent)?.issue).toBe('archive_unreadable')

    await pass(b, w.agent)
    expect(w.stub.moves(w.agent)[0]).toMatchObject({ status: 'aborted' })
    // B was never changed: it only ever read.
    expect(read(b, 'memories/MEMORY.md')).toBe('B: an older memory.')
    expect(b.tool.restores.filter(entry => !entry.verifyOnly)).toEqual([])
    // And the source, whose move ended, answers again.
    await pass(a, w.agent)
    expect(await a.runtime.say('back')).toBe('sent')
  })

  it('does not commit if the move was cancelled between the check and the commit, and changes nothing here', async () => {
    const { w, a, b } = await twoMacs()
    await moveTo(a, w, b)
    await pass(a, w.agent)
    const real = b.tool.restore.bind(b.tool)

    b.tool.restore = async input => {
      const result = await real(input, signal())

      if (input.verifyOnly) {
        await a.controller.cancelMove(w.agent, signal())
      }

      return result
    }

    await pass(b, w.agent)

    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 1, activeMove: null })
    expect(b.tool.restores.filter(entry => !entry.verifyOnly)).toEqual([])
    expect(read(b, 'memories/MEMORY.md')).toBe('B: an older memory.')
  })
})

describe('the old home keeps anything newer to itself', () => {
  it('sets aside a consistent copy of the whole home, history included, when it holds state the checkpoint does not', async () => {
    const { w, a, b } = await twoMacs()
    await moveTo(a, w, b)
    await pass(a, w.agent)
    await pass(b, w.agent)

    // Something reaches A's home after its final checkpoint was taken.
    writeFileSync(path.join(a.home, 'memories', 'late.md'), 'written after the final checkpoint')

    await pass(a, w.agent)

    expect(a.tool.exports).toHaveLength(1)
    const kept = JSON.parse(readFileSync(a.tool.exports[0]!.out, 'utf8')) as { files: Record<string, string> }
    expect(Buffer.from(kept.files['memories/late.md']!, 'base64').toString()).toBe('written after the final checkpoint')
    expect(Buffer.from(kept.files['state.db']!, 'base64').toString()).toBe('A-SESSION-HISTORY')
    expect(a.tool.exports[0]!.out.startsWith(path.join(a.root, 'quarantine', w.agent))).toBe(true)
    // It is never promoted: the new home has no trace of it.
    expect(read(b, 'memories/late.md')).toBeNull()
    expect(w.stub.placement(w.agent)).toMatchObject({ selectedGeneration: 2 })
  })
})

describe('a crash anywhere in a move is recovered', () => {
  const sourceSteps = [
    'source:journaled',
    'source:drained',
    'source:acknowledged',
    'checkpoint:reserved',
    'checkpoint:captured',
    'checkpoint:sealed',
    'checkpoint:uploaded',
    'checkpoint:committing',
    'checkpoint:committed',
    'source:checkpointed'
  ]

  it.each(sourceSteps)('of the source, at %s', async step => {
    const { w, a, b } = await twoMacs()
    await moveTo(a, w, b)
    a.crashAt = step

    await expect(pass(a, w.agent)).rejects.toBeInstanceOf(Crash)
    // Whatever was half done, the old home is not answering and the new one is not yet.
    a.restart()
    await settle(w, [a, b], 6)

    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 2, location: { deviceServiceId: w.b.deviceServiceId }, activeMove: null })
    expect(read(b, 'memories/MEMORY.md')).toBe('A: the code word is lotus.')
    expect(await a.runtime.say('stale')).toBe('refused')
    expect(await b.runtime.say('new home')).toBe('sent')
    // One move, one final checkpoint that counted.
    expect(w.stub.checkpoints(w.agent).filter(checkpoint => checkpoint.state === 'committed')).toHaveLength(1)
    expect(a.controller.ctx.journal.read(w.agent).move).toBeUndefined()
  })

  const targetSteps = ['target:verified', 'target:committing', 'target:committed', 'target:restored', 'target:activated']

  it.each(targetSteps)('of the target, at %s', async step => {
    const { w, a, b } = await twoMacs()
    await moveTo(a, w, b)
    await pass(a, w.agent)
    b.crashAt = step

    await expect(pass(b, w.agent)).rejects.toBeInstanceOf(Crash)
    b.restart()
    await settle(w, [a, b], 6)

    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 2, location: { deviceServiceId: w.b.deviceServiceId }, activeMove: null })
    expect(read(b, 'memories/MEMORY.md')).toBe('A: the code word is lotus.')
    expect(b.runtime.freshSessions).toBeGreaterThanOrEqual(1)
    expect(await a.runtime.say('stale')).toBe('refused')
    expect(await b.runtime.say('new home')).toBe('sent')
    expect(b.controller.ctx.journal.read(w.agent)).toMatchObject({ activatedEpoch: 2 })
    expect(b.controller.ctx.journal.read(w.agent).move).toBeUndefined()
    expect(w.stub.moves(w.agent).filter(move => move.status === 'committed')).toHaveLength(1)
  })

  it('of the source between the drain acknowledgement and the platform seeing the final checkpoint: the target waits, and the move completes', async () => {
    const { w, a, b } = await twoMacs()
    await moveTo(a, w, b)
    a.crashAt = 'source:acknowledged'

    await expect(pass(a, w.agent)).rejects.toBeInstanceOf(Crash)
    // The target looks while the move is draining: it waits, and changes nothing.
    await pass(b, w.agent)
    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 1 })
    expect(read(b, 'memories/MEMORY.md')).toBe('B: an older memory.')

    a.restart()
    await settle(w, [a, b], 6)
    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 2 })
  })
})

describe('a Mac that is not the home', () => {
  it('does not answer, whatever its cache says, once the platform says another Mac is the home', async () => {
    const { w, a } = await twoMacs()
    a.controller.ctx.journal.update(w.agent, entry => {
      entry.managed = true
    })

    expect(await a.runtime.say('first')).toBe('sent')

    // The platform moves the home while A cannot hear it (a partition, a sleep).
    w.stub.hijack(w.agent, { kind: 'mac', deviceServiceId: w.b.deviceServiceId })

    // The verdict A holds is believed for a few seconds, never longer.
    w.clock.advance(6_000)
    expect(await a.runtime.say('after the epoch moved')).toBe('refused')
  })

  it('does not answer, or publish, when the platform cannot be asked and the agent is under the placement model', async () => {
    const { w, a } = await twoMacs()
    a.controller.ctx.journal.update(w.agent, entry => {
      entry.managed = true
    })

    expect(await a.runtime.say('first')).toBe('sent')
    w.clock.advance(6_000)
    w.stub.failNext = { status: 500 }

    expect(await a.runtime.say('while partitioned')).toBe('refused')
    // And it answers again as soon as the platform says it may.
    expect(await a.runtime.say('after')).toBe('sent')
  })

  it('does not sign a checkpoint, a drain or a readiness report with an epoch the platform has moved past', async () => {
    const { w, a } = await twoMacs()
    a.controller.ctx.journal.update(w.agent, entry => {
      entry.managed = true
    })
    w.stub.hijack(w.agent, { kind: 'mac', deviceServiceId: w.b.deviceServiceId })

    expect(await a.controller.checkpoint(w.agent, signal())).toMatchObject({ state: 'failed', reason: 'not_home' })
    expect(await a.controller.report(w.agent, signal())).toMatchObject({ sent: false })
    expect(w.stub.checkpoints(w.agent)).toEqual([])
    expect(w.stub.requests.some(request => request.action === 'ReadinessReport')).toBe(false)
  })
})

describe('asking for a move', () => {
  it('is not done when the platform cannot give the home’s key, and nothing is disturbed', async () => {
    const { w, a, b } = await twoMacs()

    w.stub.sealingConfigured = false

    expect(await a.controller.requestMove(w.agent, b.mac.deviceServiceId, signal())).toEqual({ ok: false, reason: 'unsupported' })
    expect(w.stub.placement(w.agent).activeMove).toBeNull()
    expect(w.stub.moves(w.agent)).toEqual([])
    expect(a.runtime.calls).toEqual([])
  })

  it('looks at the key first when the home asks, and not at all when the owner’s other Mac asks (only the home may read it yet)', async () => {
    const fromHome = await twoMacs()

    await moveTo(fromHome.a, fromHome.w, fromHome.b)
    expect(fromHome.w.stub.requests.filter(request => request.action === 'HomeKeyRead')).toHaveLength(1)

    const fromOther = await twoMacs()

    expect(await fromOther.b.controller.requestMove(fromOther.w.agent, fromOther.b.mac.deviceServiceId, signal())).toMatchObject({ ok: true })
    expect(fromOther.w.stub.requests.filter(request => request.action === 'HomeKeyRead')).toHaveLength(0)
    expect(fromOther.w.stub.placement(fromOther.w.agent).activeMove).toMatchObject({ status: 'requested' })
  })
})

describe('an agent the placement model has not taken over', () => {
  it('is read and left exactly as it is: no write, no state, no stand-down', async () => {
    const { w, a } = await twoMacs()

    await pass(a, w.agent)
    await pass(a, w.agent)

    expect(w.stub.requests.every(request => request.method === 'GET')).toBe(true)
    expect(a.runtime.calls).toEqual([])
    expect(a.controller.ctx.journal.read(w.agent)).toMatchObject({ managed: false })
    expect(await a.runtime.say('as before')).toBe('sent')
  })

  it('is left exactly as it is on a platform that does not have the routes', async () => {
    const { w, a } = await twoMacs()
    w.stub.unsupported = 'absent'

    expect(await pass(a, w.agent)).toBeNull()
    expect(await a.runtime.say('as before')).toBe('sent')
    expect(a.controller.ctx.journal.read(w.agent)).toMatchObject({ managed: false })
  })
})

describe('what the home Mac says about itself', () => {
  it('reports readiness only while it is the settled home, and at its interval', async () => {
    const { w, a, b } = await twoMacs()
    a.controller.ctx.journal.update(w.agent, entry => {
      entry.managed = true
    })

    await pass(a, w.agent)
    expect(w.stub.readiness(w.agent)).toMatchObject({ reachable: true, homeEpoch: 1 })
    const reports = () => w.stub.requests.filter(request => request.action === 'ReadinessReport').length
    expect(reports()).toBe(1)

    // Not again until the interval has passed.
    await pass(a, w.agent)
    expect(reports()).toBe(1)
    w.clock.advance(61_000)
    renew(w)
    await pass(a, w.agent)
    expect(reports()).toBe(2)

    // An agent facts that are not all true are reported as not reachable.
    a.runtime.intake = false
    w.clock.advance(61_000)
    renew(w)
    await pass(a, w.agent)
    expect(w.stub.readiness(w.agent)).toMatchObject({ reachable: false })

    // A Mac that is not the home reports nothing.
    b.controller.ctx.journal.update(w.agent, entry => {
      entry.managed = true
    })
    const before = reports()
    await pass(b, w.agent)
    expect(reports()).toBe(before)
  })
})

describe('a commit that meets a publication being sent', () => {
  it('waits for it, a little longer each time, and commits the moment it has landed', async () => {
    const waits: number[] = []
    const { w, a, b } = await twoMacs()

    // The Mac mini's sleep is the platform's lease ending: the clock moves, and the publication lands at 20 s.
    b.controllerSleep = async ms => {
      waits.push(ms)
      w.clock.advance(ms)
    }

    await moveTo(a, w, b)
    await pass(a, w.agent)
    w.stub.publicationSendingUntil = w.clock.now() + 20_000
    const asked = w.stub.requests.filter(request => request.action === 'commit').length

    const result = await pass(b, w.agent)

    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 2, location: { kind: 'mac', deviceServiceId: w.b.deviceServiceId } })
    expect(result).toMatchObject({ lives: { kind: 'mac', thisMac: true } })
    // 1 + 2 + 4 + 8 = 15 s is not enough, the next 8 makes 23: four waits, a fifth try that lands.
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 8_000])
    expect(w.stub.requests.filter(request => request.action === 'commit').length - asked).toBe(6)
    expect(b.logs.some(line => line.includes('waits for a publication in flight'))).toBe(true)
  })

  it('reads the placement again before every retry, and stops when the move was ended meanwhile', async () => {
    const { w, a, b } = await twoMacs()
    await moveTo(a, w, b)
    await pass(a, w.agent)
    w.stub.publicationSendingUntil = w.clock.now() + 600_000

    // The owner cancels while the Mac mini waits for the publication.
    b.controllerSleep = async ms => {
      w.clock.advance(ms)
      await a.controller.cancelMove(w.agent, signal())
    }

    await pass(b, w.agent)

    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 1, location: { kind: 'mac', deviceServiceId: w.a.deviceServiceId }, activeMove: null })
    // Not committed, not pressed: the next look sees a move that is gone.
    await pass(b, w.agent)
    expect(read(b, 'memories/MEMORY.md')).toBe('B: an older memory.')
  })

  it('gives up for this pass after a minute, changes nothing, and commits on a later pass once it has landed', async () => {
    const waited: number[] = []
    const { w, a, b } = await twoMacs()

    b.controllerSleep = async ms => {
      waited.push(ms)
      w.clock.advance(ms)
    }

    await moveTo(a, w, b)
    await pass(a, w.agent)
    w.stub.publicationSendingUntil = w.clock.now() + 5 * 60_000

    await pass(b, w.agent)

    expect(waited.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(60_000)
    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 1 })
    expect(b.controller.view(w.agent)?.issue).toBe('publication_in_flight')
    // The source is still quiet and waiting; nothing was forced, and nothing was sent around the worker.
    expect(await a.runtime.say('still quiet')).toBe('refused')

    w.clock.advance(5 * 60_000)
    await pass(b, w.agent)

    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 2, location: { kind: 'mac', deviceServiceId: w.b.deviceServiceId } })
  })

  it('does not wait for any other conflict: a stale commit is the next pass’s business', async () => {
    const waited: number[] = []
    const { w, a, b } = await twoMacs()

    b.controllerSleep = async ms => {
      waited.push(ms)
    }

    await moveTo(a, w, b)
    await pass(a, w.agent)
    // The commit itself meets a plain conflict (a stale revision, a busy reservation): not the publication's word.
    const real = b.controller.ctx.platform.commitMove.bind(b.controller.ctx.platform)
    let commits = 0

    b.controller.ctx.platform.commitMove = async (...args) => {
      commits += 1

      return commits === 1 ? { ok: false, kind: 'conflict', status: 409 } : real(...args)
    }

    await pass(b, w.agent)

    expect(waited).toEqual([])
    expect(commits).toBe(1)
  })
})

describe('a pass that could not reach the platform', () => {
  it('stops saying it is not connected once a placement read succeeds again', async () => {
    const { w, a } = await twoMacs()

    await pass(a, w.agent)
    expect(a.controller.view(w.agent)?.issue).toBeNull()

    // The platform cannot be reached: the known view is kept, with the reason.
    w.stub.failNext = { status: 503 }
    await pass(a, w.agent)
    expect(a.controller.view(w.agent)?.issue).toBe('platform_unavailable')

    // The platform answers again. The old read failure is over; a successful pass clears it.
    await pass(a, w.agent)
    expect(a.controller.view(w.agent)?.issue).toBeNull()
  })
})
