import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { openFile } from './archive-seal'
import { type CheckpointDeps, isBackgroundCheckpoint, takeCheckpoint } from './checkpoint'
import type { CheckpointReason } from './contract'
import { checkpointDepsOf } from './move-source'
import { Crash, createNode, type Node, shellArchive, storedGeneration } from './node.fixture'
import { createWorld, fenceOf, signal, type World } from './world.fixture'

async function managedHome(options: { at?: 'a' | 'b' } = {}) {
  const w = await createWorld({ at: options.at ?? 'a' })

  const node = createNode(w, options.at === 'b' ? w.b : w.a, {
    files: {
      'memories/MEMORY.md': 'The demo code word is lotus.',
      'memories/ghi-chú hôm nay.md': 'note',
      'SOUL.md': 'You are Test.',
      'skills/notes/SKILL.md': '# Notes',
      'skills/notes/node_modules/dep/index.js': 'module.exports = 1',
      'state.db': 'SQLITE-SESSION-HISTORY',
      '.env': 'OPENAI_API_KEY=sk-do-not-leak',
      'auth.json': '{"token":"tok-do-not-leak"}',
      'cron/jobs.json': '[]'
    }
  })

  // The agent is under the placement model (a move was requested before, or an epoch was committed).
  node.controller.ctx.journal.update(w.agent, entry => {
    entry.managed = true
  })

  return { w, node }
}

const deps = (node: Node, overrides: Partial<CheckpointDeps> = {}): CheckpointDeps => ({ ...checkpointDepsOf(node.controller.ctx), ...overrides })

const run = (node: Node, w: World, overrides: Partial<CheckpointDeps> = {}, reason: CheckpointReason = 'manual') =>
  takeCheckpoint(deps(node, overrides), { agent: w.agent, reason }, signal())

const stagingOf = (node: Node): string[] => {
  try {
    return readdirSync(path.join(node.root, 'work'), { recursive: true }).map(String)
  } catch {
    return []
  }
}

describe('a checkpoint of the home this Mac holds', () => {
  it('reserves, captures with the writers held, seals, uploads, verifies and commits', async () => {
    const { w, node } = await managedHome()
    let heldDuringCapture = -1

    node.tool.midCapture = () => {
      heldDuringCapture = node.runtime.holds
    }

    const outcome = await run(node, w)

    expect(outcome).toMatchObject({ state: 'committed', generation: 2, selectedGeneration: 2, placementRevision: 2 })
    expect(w.stub.placement(w.agent)).toMatchObject({ selectedGeneration: 2, placementRevision: 2, homeEpoch: 1 })
    expect(w.stub.checkpoints(w.agent).map(checkpoint => checkpoint.state)).toEqual(['committed'])
    // The writers were held exactly while the capture read the home, and let go before the upload.
    expect(heldDuringCapture).toBe(1)
    expect(node.runtime.holds).toBe(0)
    expect(node.runtime.calls).toEqual(['quiesce', 'release'])
    // The plaintext archive and the sealed copy are gone from the staging folder.
    expect(stagingOf(node).filter(name => name.includes('checkpoint.'))).toEqual([])
    // The journal knows what was committed.
    const journal = node.controller.ctx.journal.read(w.agent)
    expect(journal).toMatchObject({ lastGeneration: 2 })
    expect(journal.checkpoint).toBeUndefined()
    expect(journal.lastContentSha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('stores ciphertext that opens only for this home and this generation, and holds nothing the policy excludes', async () => {
    const { w, node } = await managedHome()
    await run(node, w)

    const homeId = w.stub.placement(w.agent).homeId
    const stored = w.stub.archives.get(`${homeId}:2`)!

    expect(stored.subarray(0, 10).toString('utf8')).toBe('ATUM-AHS1\n')

    for (const secret of ['lotus', 'SQLITE-SESSION-HISTORY', 'sk-do-not-leak', 'tok-do-not-leak', 'module.exports']) {
      expect(stored.includes(secret)).toBe(false)
    }

    // Open it as the home's other Mac would: the key from the platform, the home and generation bound in.
    const key = await shellArchive(w, w.a).keys.key({ agent: w.agent, homeId }, signal())

    if (!key.ok) {
      throw new Error('no key')
    }

    const sealedPath = path.join(node.root, 'opened.sealed')
    const plainPath = path.join(node.root, 'opened.plain')
    await (await import('node:fs/promises')).writeFile(sealedPath, stored)
    await openFile({ sealed: sealedPath, plain: plainPath, key: key.value, homeId, generation: 2 })

    const plain = (await (await import('node:fs/promises')).readFile(plainPath)).toString('utf8')
    expect(plain).toContain('The demo code word is lotus.')
    expect(plain).not.toContain('SQLITE-SESSION-HISTORY')
    expect(plain).not.toContain('sk-do-not-leak')
    expect(plain).not.toContain('module.exports')

    // Another generation, another home, or a changed byte, and it does not open.
    await expect(openFile({ sealed: sealedPath, plain: `${plainPath}.2`, key: key.value, homeId, generation: 3 })).rejects.toMatchObject({ code: 'seal_open_failed' })
    await expect(
      openFile({ sealed: sealedPath, plain: `${plainPath}.3`, key: key.value, homeId: '00000000-0000-4000-8000-bd7662a5eeb4', generation: 2 })
    ).rejects.toMatchObject({ code: 'seal_open_failed' })
  })

  it('numbers the next generation from the one the platform selected', async () => {
    const { w, node } = await managedHome()

    expect(await run(node, w)).toMatchObject({ state: 'committed', generation: 2 })
    expect(await run(node, w)).toMatchObject({ state: 'committed', generation: 3, selectedGeneration: 3, placementRevision: 3 })
    expect(w.stub.checkpoints(w.agent).map(checkpoint => checkpoint.generation)).toEqual([2, 3])
  })

  it('refuses to checkpoint when this Mac is not the home, without reserving anything', async () => {
    const { w } = await managedHome()
    const other = createNode(w, w.b, { files: { 'memories/MEMORY.md': 'b' } })
    other.controller.ctx.journal.update(w.agent, entry => {
      entry.managed = true
    })

    expect(await run(other, w)).toMatchObject({ state: 'failed', reason: 'not_home' })
    expect(w.stub.checkpoints(w.agent)).toEqual([])
  })

  it('does not checkpoint an agent the placement model has not taken over', async () => {
    const w = await createWorld()
    const node = createNode(w, w.a, { files: { 'memories/MEMORY.md': 'a' } })

    expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'not_home', detail: 'not_home_legacy' })
  })

  it('says it has no authority when it holds no lease term, and reserves nothing', async () => {
    const { w, node } = await managedHome()
    w.stub.releaseLease(w.agent)

    expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'no_authority' })
    expect(w.stub.checkpoints(w.agent)).toEqual([])
  })

  it('says unsupported when the platform has no routes yet, and changes nothing', async () => {
    const { w, node } = await managedHome()
    w.stub.unsupported = 'absent'

    // A managed agent on a platform that stopped answering is held, not treated as a legacy one.
    expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'not_home' })
    expect(w.stub.checkpoints(w.agent)).toEqual([])
  })
})

describe('a checkpoint taken beside the running agent (the cadence\'s)', () => {
  const failedStates = (w: World) => w.stub.checkpoints(w.agent).map(checkpoint => checkpoint.state)
  const leftovers = (node: Node) => stagingOf(node).filter(name => name.includes('checkpoint.') || name.includes('snapshot'))

  it('is the cadence\'s two reasons and no others', () => {
    expect(['cadence_dirty', 'idle', 'manual', 'move_drain'].filter(reason => isBackgroundCheckpoint(reason as CheckpointReason))).toEqual(['cadence_dirty', 'idle'])
  })

  it.each(['cadence_dirty', 'idle'] as const)('stops nothing for a "%s" checkpoint: the writers are held only while a snapshot is staged, and it captures from the snapshot', async reason => {
    const { w, node } = await managedHome()
    let heldDuringCapture: boolean | undefined

    node.tool.midCapture = () => {
      heldDuringCapture = node.runtime.held
    }

    // Stopping the writers at all would be the cold start this exists to avoid.
    const forbidden = async () => {
      throw new Error('a checkpoint beside the running agent must not stop its writers')
    }

    const outcome = await run(node, w, { quiesce: forbidden }, reason)

    expect(outcome).toMatchObject({ state: 'committed', generation: 2, selectedGeneration: 2 })
    expect(node.runtime.calls).toEqual([])
    expect(node.runtime.holds).toBe(0)
    // Held once, for the snapshot, and let go before the capture read it: the capture, the seal and the upload hold nothing up.
    expect(node.runtime.barrier).toEqual(['hold', 'release'])
    expect(heldDuringCapture).toBe(false)
    expect(node.tool.snapshots).toHaveLength(1)
    expect(node.tool.captures).toEqual([{ home: node.home, generation: 2, fromSnapshot: true }])
    // The live home is not asked about again: the snapshot is one moment of it, and there is nothing left to prove.
    expect(node.tool.fingerprints).toEqual([])
    expect(failedStates(w)).toEqual(['committed'])
    expect(leftovers(node)).toEqual([])

    const journal = node.controller.ctx.journal.read(w.agent)
    const fingerprint = await node.tool.fingerprint({ home: node.home })

    expect(journal.lastFingerprint).toBe(fingerprint.fingerprintSha256)
    expect(journal.checkpoint).toBeUndefined()

    // And the archive says how it was made, because that is how it was made.
    const { capture } = await storedGeneration(w, node, 2)

    expect(capture).toMatchObject({
      writers: 'barrier',
      stagedBy: 'snapshot_apfs_clone',
      consistency: { writersQuiesced: true, sqliteMethod: 'sqlite_backup', stableFilesStaged: true }
    })
  })

  it('stops the writers for the owner\'s own checkpoint and a move\'s, as before, and the archive says they were stopped', async () => {
    const { w, node } = await managedHome()

    expect(await run(node, w, {}, 'manual')).toMatchObject({ state: 'committed' })
    expect(node.runtime.calls).toEqual(['quiesce', 'release'])
    expect(node.runtime.barrier).toEqual([])
    expect(node.tool.snapshots).toEqual([])
    expect(node.tool.captures).toEqual([{ home: node.home, generation: 2, fromSnapshot: false }])

    const { capture } = await storedGeneration(w, node, 2)

    expect(capture).toMatchObject({ writers: 'stopped', stagedBy: 'stable_read' })
  })

  it('refuses a snapshot in whose window a file it carries was written by something the barrier cannot see: nothing captured, uploaded or committed', async () => {
    const { w, node } = await managedHome()

    node.tool.midSnapshot = home => {
      writeFileSync(path.join(home, 'memories/MEMORY.md'), 'The demo code word is now jasmine, said while the writers were held, and longer.')
    }

    const outcome = await run(node, w, {}, 'idle')

    expect(outcome).toMatchObject({ state: 'failed', reason: 'home_changed', detail: 'changed', selectedGeneration: 1 })
    expect(failedStates(w)).toEqual(['failed'])
    expect(w.stub.placement(w.agent)).toMatchObject({ selectedGeneration: 1, placementRevision: 1 })
    expect(w.stub.archives.size).toBe(0)
    expect(node.tool.captures).toEqual([])
    expect(leftovers(node)).toEqual([])
    expect(node.controller.ctx.journal.read(w.agent).checkpoint).toBeUndefined()
    expect(node.runtime.calls).toEqual([])
    // The writers were let go: the attempt does not leave the agent held.
    expect(node.runtime.held).toBe(false)

    // The next attempt, with the home still, reserves the same generation again and commits it.
    node.tool.midSnapshot = undefined
    expect(await run(node, w, {}, 'idle')).toMatchObject({ state: 'committed', generation: 2 })
  })

  it('does not mind a file it does not carry changing meanwhile: history, settings, credentials', async () => {
    const { w, node } = await managedHome()

    node.tool.midSnapshot = home => {
      writeFileSync(path.join(home, 'state.db'), 'SQLITE-SESSION-HISTORY, one more message')
      writeFileSync(path.join(home, '.env'), 'OPENAI_API_KEY=sk-another')
      writeFileSync(path.join(home, 'config.yaml'), 'model: another\n')
    }

    expect(await run(node, w, {}, 'cadence_dirty')).toMatchObject({ state: 'committed', generation: 2 })
  })

  it('captures the snapshot and nothing else: a write to the live home while the capture reads it does not reach the archive', async () => {
    const { w, node } = await managedHome()

    node.tool.midCapture = home => {
      writeFileSync(path.join(home, 'memories/MEMORY.md'), 'written after the snapshot, while the capture was reading it')
    }

    expect(await run(node, w, {}, 'idle')).toMatchObject({ state: 'committed', generation: 2 })

    const { bodies } = await storedGeneration(w, node, 2)

    // The archive is the home as it was while the writers were held, not as it is by the time the capture reads.
    expect(bodies.get('memory/MEMORY.md')!.toString('utf8')).toBe('The demo code word is lotus.')
  })

  it('needs no second look at the live home afterwards: a fingerprint that cannot be taken does not stop it', async () => {
    const { w, node } = await managedHome()
    node.tool.failFingerprint = 'home_tool_failed'

    expect(await run(node, w, {}, 'idle')).toMatchObject({ state: 'committed', generation: 2 })
  })

  it('does not commit a capture that is not of the snapshot it was staged from', async () => {
    const { w, node } = await managedHome()
    const capture = node.tool.capture.bind(node.tool)

    node.tool.capture = async input => ({ ...(await capture(input)), fingerprintSha256: 'f'.repeat(64) })

    expect(await run(node, w, {}, 'idle')).toMatchObject({ state: 'failed', reason: 'staging_failed', detail: 'capture_does_not_match_snapshot' })
    expect(w.stub.archives.size).toBe(0)
    expect(failedStates(w)).toEqual(['failed'])
    expect(leftovers(node)).toEqual([])
  })

  it.each([
    ['a turn is in flight', (node: Node) => node.runtime.startTurn()],
    ['Hermes has not finished its review of the last answer', (node: Node) => void (node.runtime.restless = true)]
  ])('is not taken when the writers cannot be held, because %s: the reservation is failed at once, nothing is staged, and the next quiet moment takes it', async (_label, busy) => {
    const { w, node } = await managedHome()
    busy(node)

    expect(await run(node, w, {}, 'cadence_dirty')).toMatchObject({ state: 'failed', reason: 'home_changed', detail: 'writers_busy', selectedGeneration: 1 })
    expect(failedStates(w)).toEqual(['failed'])
    expect(w.stub.archives.size).toBe(0)
    expect(node.runtime.barrier).toEqual(['busy'])
    expect(node.tool.captures).toEqual([])
    expect(leftovers(node)).toEqual([])
    expect(node.controller.ctx.journal.read(w.agent).checkpoint).toBeUndefined()
    expect(node.runtime.calls).toEqual([])

    node.runtime.turn = null
    node.runtime.restless = false
    expect(await run(node, w, {}, 'cadence_dirty')).toMatchObject({ state: 'committed', generation: 2 })
  })

  it('names the tool’s own reason when the snapshot fails for any other, and holds nothing', async () => {
    const { w, node } = await managedHome()
    node.tool.failSnapshot = 'home_database_invalid'

    expect(await run(node, w, {}, 'idle')).toMatchObject({ state: 'failed', reason: 'staging_failed', detail: 'home_database_invalid' })
    expect(failedStates(w)).toEqual(['failed'])
    expect(node.runtime.held).toBe(false)
    expect(leftovers(node)).toEqual([])
  })

  it('lets the writers go before the capture reads, so a capture that fails does not leave the agent held', async () => {
    const { w, node } = await managedHome()
    node.tool.failCapture = 'home_file_changed'

    expect(await run(node, w, {}, 'idle')).toMatchObject({ state: 'failed', reason: 'staging_failed' })
    expect(node.runtime.barrier).toEqual(['hold', 'release'])
    expect(node.runtime.held).toBe(false)
    expect(leftovers(node)).toEqual([])
  })
})

describe('a checkpoint taken beside the running agent is one moment of the home, never a writer caught midway', () => {
  const at = (node: Node, file: string) => path.join(node.home, file)

  /** Two files a turn changes together: a memory, and the skill that explains how to read it. */
  const both = (node: Node, version: string) => {
    writeFileSync(at(node, 'memories/MEMORY.md'), `memory ${version}`)
    writeFileSync(at(node, 'skills/notes/SKILL.md'), `skill ${version}`)
  }

  it('a turn that begins after the quiet moment and has changed one of the two files is waited for: nothing is captured, nothing uploaded', async () => {
    const { w, node } = await managedHome()
    both(node, 'v1')

    const outcome = await run(
      node,
      w,
      {
        // The cadence found the agent at rest. Before the capture a turn begins, and has written the memory, not yet the skill:
        // the files are the same size and no longer the same moment, and nothing changes while the capture reads them.
        phase: name => {
          if (name === 'reserved') {
            node.runtime.startTurn()
            writeFileSync(at(node, 'memories/MEMORY.md'), 'memory v2')
          }
        }
      },
      'idle'
    )

    expect(outcome).toMatchObject({ state: 'failed', reason: 'home_changed', detail: 'writers_busy', selectedGeneration: 1 })
    expect(w.stub.archives.size).toBe(0)
    expect(w.stub.placement(w.agent)).toMatchObject({ selectedGeneration: 1, placementRevision: 1 })
    expect(node.controller.ctx.journal.read(w.agent).checkpoint).toBeUndefined()

    // The turn ends having written both. The next checkpoint is the home as it is then: both, from the same moment.
    writeFileSync(at(node, 'skills/notes/SKILL.md'), 'skill v2')
    node.runtime.turn!.finish()
    node.runtime.turn = null

    expect(await run(node, w, {}, 'idle')).toMatchObject({ state: 'committed', generation: 2 })

    const { bodies } = await storedGeneration(w, node, 2)

    expect(bodies.get('memory/MEMORY.md')!.toString('utf8')).toBe('memory v2')
    expect(bodies.get('skills/notes/SKILL.md')!.toString('utf8')).toBe('skill v2')
  })
})

describe('a checkpoint that cannot be completed leaves the previous generation selected', () => {
  const failed = (w: World) => w.stub.checkpoints(w.agent).map(checkpoint => checkpoint.state)

  it('when the capture fails: the reservation is failed at once, the writers are let go, nothing is left staged', async () => {
    const { w, node } = await managedHome()
    node.tool.failCapture = 'home_file_changed'

    expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'staging_failed', selectedGeneration: 1 })
    expect(failed(w)).toEqual(['failed'])
    expect(w.stub.placement(w.agent)).toMatchObject({ selectedGeneration: 1, placementRevision: 1 })
    expect(node.runtime.holds).toBe(0)
    expect(node.controller.ctx.journal.read(w.agent).checkpoint).toBeUndefined()

    // The next attempt reserves the same generation again.
    node.tool.failCapture = null
    expect(await run(node, w)).toMatchObject({ state: 'committed', generation: 2 })
  })

  it('when the writers cannot be held', async () => {
    const { w, node } = await managedHome()

    node.runtime.quiesce = async () => {
      throw new Error('cannot_hold')
    }

    expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'quiesce_failed' })
    expect(failed(w)).toEqual(['failed'])
    expect(node.tool.captures).toHaveLength(0)
  })

  it('when the upload fails', async () => {
    const { w, node } = await managedHome()
    w.stub.archivePutFails = true

    expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'upload_failed' })
    expect(failed(w)).toEqual(['failed'])
    expect(w.stub.placement(w.agent)).toMatchObject({ selectedGeneration: 1 })
    expect(stagingOf(node).filter(name => name.includes('checkpoint.'))).toEqual([])
  })

  it('when the object store refuses the archive’s size: the reason is named, nothing is committed, and the next try can', async () => {
    const { w, node } = await managedHome()
    w.stub.storage.maxObjectBytes = 10

    expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'upload_failed', detail: 'too_large' })
    expect(failed(w)).toEqual(['failed'])
    expect(w.stub.placement(w.agent)).toMatchObject({ selectedGeneration: 1 })
    expect(w.stub.storage.objects.size).toBe(0)
    expect(stagingOf(node).filter(name => name.includes('checkpoint.'))).toEqual([])

    // The limit is lifted (the deployment's setting changed): the same generation is taken, from a fresh reservation.
    w.stub.storage.maxObjectBytes = 2_147_483_648
    expect(await run(node, w)).toMatchObject({ state: 'committed', generation: 2 })
    expect(w.stub.storage.objects.size).toBe(1)
  })

  it('when the store holds different bytes than were sent: not verified, not committed', async () => {
    const { w, node } = await managedHome()
    const store = node.controller.ctx.store
    const put = store.put.bind(store)

    store.put = async (input, abort) => {
      const result = await put(input, abort)

      return result.ok ? { ok: true, value: { ...result.value, sha256: 'f'.repeat(64) } } : result
    }

    expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'verification_failed', detail: 'store_digest_differs' })
    expect(failed(w)).toEqual(['failed'])
    expect(w.stub.placement(w.agent)).toMatchObject({ selectedGeneration: 1, placementRevision: 1 })
  })

  it('when the platform has no archive route: unsupported, and the reservation is released', async () => {
    const { w, node } = await managedHome()
    const store = node.controller.ctx.store
    store.put = async () => ({ ok: false, kind: 'unsupported' })

    expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'unsupported' })
    expect(failed(w)).toEqual(['failed'])
  })

  it('when the data key is not available', async () => {
    const { w, node } = await managedHome()
    node.controller.ctx.keys.key = async () => ({ ok: false, kind: 'unavailable' })

    expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'key_unavailable' })
    expect(failed(w)).toEqual(['failed'])
  })

  it('when the platform names the data key for someone else: nothing is sealed with it, and nothing is uploaded', async () => {
    const { w, node } = await managedHome()

    // A well-formed name that is not the one derived from this owner, agent and home.
    w.stub.alterAnswer = { action: 'HomeKeyRead', change: body => ({ ...body, keyId: 'A'.repeat(43) }) }

    expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'key_unavailable' })
    expect(failed(w)).toEqual(['failed'])
    expect(w.stub.storage.objects.size).toBe(0)
    expect(w.stub.placement(w.agent)).toMatchObject({ selectedGeneration: 1 })
    expect(stagingOf(node).filter(name => name.includes('checkpoint.'))).toEqual([])
  })

  it('when the home stopped being this Mac\'s while the bytes were going up: it does not commit', async () => {
    const { w, node } = await managedHome()

    const hook = (phase: string) => {
      if (phase === 'uploaded') {
        w.stub.hijack(w.agent, { kind: 'mac', deviceServiceId: w.b.deviceServiceId })
        node.controller.standing.invalidate(w.agent)
      }
    }

    const outcome = await run(node, w, { phase: hook as CheckpointDeps['phase'] })

    expect(outcome).toMatchObject({ state: 'failed', reason: 'not_home' })
    // The platform failed the reservation when it changed the home, and no generation was selected.
    expect(w.stub.checkpoints(w.agent).map(checkpoint => checkpoint.state)).toEqual(['failed'])
    expect(w.stub.placement(w.agent)).toMatchObject({ selectedGeneration: 1, homeEpoch: 2 })
  })
})

describe('a checkpoint interrupted by a crash', () => {
  it.each(['reserved', 'captured', 'sealed', 'uploaded', 'committing'] as const)('is finished by the next attempt after a crash at %s', async phase => {
    const { w, node } = await managedHome()

    const crash = (name: string) => {
      if (name === phase) {
        throw new Crash(name)
      }
    }

    await expect(run(node, w, { phase: crash as CheckpointDeps['phase'] })).rejects.toBeInstanceOf(Crash)
    expect(node.controller.ctx.journal.read(w.agent).checkpoint).toMatchObject({ phase: expect.any(String) })

    // The app is opened again and a checkpoint is taken: the reservation is continued, not duplicated.
    const again = await run(node, w)

    expect(again).toMatchObject({ state: 'committed', generation: 2 })
    expect(w.stub.checkpoints(w.agent).filter(checkpoint => checkpoint.state === 'committed')).toHaveLength(1)
    expect(w.stub.checkpoints(w.agent).filter(checkpoint => checkpoint.state === 'reserved')).toHaveLength(0)
    expect(w.stub.placement(w.agent)).toMatchObject({ selectedGeneration: 2, placementRevision: 2 })
    expect(node.controller.ctx.journal.read(w.agent).checkpoint).toBeUndefined()
  })

  it('recognises a commit that landed before the crash, and does not reserve a second generation for the same state', async () => {
    const { w, node } = await managedHome()
    const first = await run(node, w)

    expect(first).toMatchObject({ state: 'committed', generation: 2 })
    const done = node.controller.ctx.journal.read(w.agent)

    // The process died after the platform applied the commit and before the journal was cleared.
    node.controller.ctx.journal.update(w.agent, entry => {
      entry.checkpoint = {
        checkpointId: w.stub.checkpoints(w.agent)[0]!.checkpointId,
        reason: 'manual',
        phase: 'committing',
        startedAt: 1,
        generation: 2,
        parentGeneration: 1,
        homeEpoch: 1,
        manifestSha256: first.state === 'committed' ? first.manifestSha256 : undefined,
        contentSha256: done.lastContentSha256
      }
      entry.lastGeneration = undefined
    })

    const again = await run(node, w)

    expect(again).toMatchObject({ state: 'committed', generation: 2, selectedGeneration: 2 })
    expect(w.stub.checkpoints(w.agent)).toHaveLength(1)
    expect(node.controller.ctx.journal.read(w.agent)).toMatchObject({ lastGeneration: 2 })
    expect(node.controller.ctx.journal.read(w.agent).checkpoint).toBeUndefined()
  })

  it('treats a commit whose answer was lost as committed once the placement shows it', async () => {
    const { w, node } = await managedHome()
    w.stub.loseNextAnswer = 'CheckpointCommit'

    expect(await run(node, w)).toMatchObject({ state: 'committed', generation: 2, selectedGeneration: 2 })
    expect(w.stub.checkpoints(w.agent).map(checkpoint => checkpoint.state)).toEqual(['committed'])
  })

  it('does not wait on a reservation it lost track of: the next attempt finds it busy, then expired', async () => {
    const { w, node } = await managedHome()

    await expect(run(node, w, { phase: ((name: string) => {
      if (name === 'reserved') {throw new Crash(name)}
    }) as CheckpointDeps['phase'] })).rejects.toBeInstanceOf(Crash)
    // The journal is lost with it (a reinstall): the id of the live reservation is unknown.
    node.controller.ctx.journal.clear(w.agent)
    node.controller.ctx.journal.update(w.agent, entry => {
      entry.managed = true
    })

    expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'busy' })

    // Platform time passes: the reservation expires on its own and the generation is free.
    w.clock.advance(15 * 60_000)
    w.stub.renewLease(w.agent, 600_000)
    expect(await run(node, w)).toMatchObject({ state: 'committed', generation: 2 })
  })
})

describe('a checkpoint interrupted by a process that was killed (no cleanup runs)', () => {
  /**
   * The first process stops dead at a point: its promise never settles and its `finally` never runs, so what it had staged
   * is on disk exactly as a SIGKILL leaves it. (The tests above throw from a hook, which runs `finally` and hides a
   * leftover.) The second run is the app opened again over the same journal, staging folder and platform.
   */
  const never = () => new Promise<never>(() => undefined)
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const leftovers = (node: Node, w: World) => stagingOf(node).filter(name => name !== w.agent)
  const committedCount = (w: World) => w.stub.checkpoints(w.agent).filter(checkpoint => checkpoint.state === 'committed').length
  const reservedCount = (w: World) => w.stub.checkpoints(w.agent).filter(checkpoint => checkpoint.state === 'reserved').length

  type Point = 'after capture' | 'before upload' | 'after upload' | 'at commit'

  /** Runs a checkpoint that is killed at `point`; resolves once it has stopped, with the sealed bytes it had by then. */
  async function killedAt(node: Node, w: World, point: Point, reason: CheckpointReason = 'manual') {
    const ctx = node.controller.ctx
    const seen: { sealed?: Buffer } = {}
    let reached!: () => void

    const stopped = new Promise<void>(resolve => {
      reached = resolve
    })

    const stop = () => {
      reached()

      return never()
    }

    const recording = (after: boolean): CheckpointDeps['store'] => ({
      get: (input, abort) => ctx.store.get(input, abort),
      put: async (input, abort) => {
        seen.sealed = readFileSync(input.file)

        if (!after) {
          return stop()
        }

        const done = await ctx.store.put(input, abort)

        if (point === 'after upload') {
          return stop()
        }

        return done
      }
    })

    const stalledCommit = new Proxy(ctx.platform, {
      get: (target, name) =>
        name === 'commitCheckpoint'
          ? () => stop()
          : typeof Reflect.get(target, name) === 'function'
            ? (Reflect.get(target, name) as (...args: unknown[]) => unknown).bind(target)
            : Reflect.get(target, name)
    })

    const overrides: Partial<CheckpointDeps> =
      point === 'after capture'
        ? { keys: { key: () => stop() } }
        : point === 'before upload'
          ? { store: recording(false) }
          : point === 'after upload'
            ? { store: recording(true) }
            : { store: recording(true), platform: stalledCommit }

    void run(node, w, overrides, reason)
    await stopped

    return seen
  }

  it('after the capture: the plain archive it left behind does not stop the next start, which captures again under the same reservation', async () => {
    const { w, node } = await managedHome()

    await killedAt(node, w, 'after capture')
    expect(leftovers(node, w).some(name => name.endsWith('checkpoint.plain'))).toBe(true)

    expect(await run(node, w)).toMatchObject({ state: 'committed', generation: 2 })
    expect(committedCount(w)).toBe(1)
    expect(reservedCount(w)).toBe(0)
    expect(leftovers(node, w)).toEqual([])
    expect(node.controller.ctx.journal.read(w.agent).checkpoint).toBeUndefined()
  })

  it('with the sealed archive complete: the next start uploads exactly those bytes, without capturing or sealing again', async () => {
    const { w, node } = await managedHome()
    const seen = await killedAt(node, w, 'before upload')

    // Journaled before any byte could leave: where it is, how long it is, and its digest.
    const journaled = node.controller.ctx.journal.read(w.agent).checkpoint

    expect(journaled).toMatchObject({ phase: 'sealed', sealed: { bytes: seen.sealed!.length, sha256: sha(seen.sealed!) } })
    expect(journaled?.sealed?.path.endsWith('checkpoint.sealed')).toBe(true)
    expect(existsSync(journaled!.sealed!.path)).toBe(true)

    expect(await run(node, w)).toMatchObject({ state: 'committed', generation: 2 })
    expect(node.tool.captures).toHaveLength(1)
    expect(w.stub.archives.get(`${w.stub.placement(w.agent).homeId}:2`)!.equals(seen.sealed!)).toBe(true)
    expect(committedCount(w)).toBe(1)
    expect(leftovers(node, w)).toEqual([])
    expect(node.controller.ctx.journal.read(w.agent).checkpoint).toBeUndefined()
  })

  it('after the upload landed but before it was journaled: the same bytes are offered again and the platform recognises them', async () => {
    const { w, node } = await managedHome()
    const seen = await killedAt(node, w, 'after upload')

    expect(w.stub.storage.objects.size).toBe(1)
    expect(await run(node, w)).toMatchObject({ state: 'committed', generation: 2 })

    // One object in the store, the one the first process sent: nothing was sealed afresh and uploaded as another.
    expect(w.stub.storage.objects.size).toBe(1)
    expect(w.stub.archives.get(`${w.stub.placement(w.agent).homeId}:2`)!.equals(seen.sealed!)).toBe(true)
    expect(node.tool.captures).toHaveLength(1)
    expect(committedCount(w)).toBe(1)
    expect(leftovers(node, w)).toEqual([])
  })

  it('at the commit: the commit is finished and the staged archive is removed, not left for ever', async () => {
    const { w, node } = await managedHome()
    const seen = await killedAt(node, w, 'at commit')

    expect(node.controller.ctx.journal.read(w.agent).checkpoint).toMatchObject({ phase: expect.stringMatching(/^(uploaded|committing)$/u) })
    expect(leftovers(node, w).some(name => name.endsWith('checkpoint.sealed'))).toBe(true)

    expect(await run(node, w)).toMatchObject({ state: 'committed', generation: 2 })
    expect(committedCount(w)).toBe(1)
    expect(w.stub.archives.get(`${w.stub.placement(w.agent).homeId}:2`)!.equals(seen.sealed!)).toBe(true)
    expect(node.tool.captures).toHaveLength(1)
    expect(leftovers(node, w)).toEqual([])
    expect(node.controller.ctx.journal.read(w.agent).checkpoint).toBeUndefined()
  })

  it('whose commit had already landed: the staged archive is removed as well', async () => {
    const { w, node } = await managedHome()
    await killedAt(node, w, 'at commit')

    // The platform did apply the commit; only the answer, and the journal's clearing, were lost with the process.
    const checkpointId = w.stub.checkpoints(w.agent)[0]!.checkpointId
    const journaled = node.controller.ctx.journal.read(w.agent).checkpoint!
    const sealedPath = journaled.sealed?.path ?? path.join(node.root, 'work', w.agent, checkpointId, 'checkpoint.sealed')

    const body = await w.a.auth.sign('CheckpointCommit', meta => ({
      operation: 'commit' as const,
      meta,
      checkpointId,
      generation: 2,
      parentGeneration: 1,
      expectedHomeEpoch: 1,
      expectedPlacementRevision: w.stub.placement(w.agent).placementRevision,
      manifestSha256: journaled.manifestSha256!,
      uploadVerified: true,
      fence: fenceOf(w)
    }))

    expect(await w.a.platform.commitCheckpoint(w.agent, body as never, signal())).toMatchObject({ ok: true, value: { outcome: 'committed' } })
    expect(existsSync(sealedPath)).toBe(true)

    expect(await run(node, w)).toMatchObject({ state: 'committed', generation: 2, selectedGeneration: 2 })
    expect(committedCount(w)).toBe(1)
    expect(leftovers(node, w)).toEqual([])
  })

  describe('when the staged archive cannot be trusted any more', () => {
    const killedWithSealed = async () => {
      const home = await managedHome()
      const seen = await killedAt(home.node, home.w, 'before upload')
      const sealedPath = home.node.controller.ctx.journal.read(home.w.agent).checkpoint!.sealed!.path

      return { ...home, seen, sealedPath }
    }

    it.each([
      ['it is gone', (file: string) => rmSync(file)],
      ['it is shorter', (file: string) => truncateSync(file, 100)],
      ['one of its bytes is different', (file: string) => {
        const bytes = readFileSync(file)
        bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 0xff
        writeFileSync(file, bytes)
      }]
    ])('%s: the reservation is failed, nothing is uploaded, and the next checkpoint starts afresh', async (_name, damage) => {
      const { w, node, sealedPath, seen } = await killedWithSealed()

      damage(sealedPath)

      expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'staging_failed', detail: 'sealed_archive_unusable' })
      expect(w.stub.storage.objects.size).toBe(0)
      expect(w.stub.checkpoints(w.agent).map(checkpoint => checkpoint.state)).toEqual(['failed'])
      expect(leftovers(node, w)).toEqual([])
      expect(node.controller.ctx.journal.read(w.agent).checkpoint).toBeUndefined()

      // A new reservation, a new capture and a new seal: not the bytes of the dead one.
      expect(await run(node, w)).toMatchObject({ state: 'committed', generation: 2 })
      expect(node.tool.captures).toHaveLength(2)
      expect(w.stub.archives.get(`${w.stub.placement(w.agent).homeId}:2`)!.equals(seen.sealed!)).toBe(false)
    })

    it('the journal names a file that is not this checkpoint’s own staged archive: it is not read, let alone uploaded', async () => {
      const { w, node } = await killedWithSealed()
      const elsewhere = path.join(node.root, 'somewhere-else.sealed')

      writeFileSync(elsewhere, 'not an archive of this checkpoint')

      node.controller.ctx.journal.update(w.agent, entry => {
        entry.checkpoint = {
          ...entry.checkpoint!,
          sealed: { path: elsewhere, bytes: 33, sha256: sha(Buffer.from('not an archive of this checkpoint')) }
        }
      })

      expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'staging_failed', detail: 'sealed_archive_unusable' })
      expect(w.stub.storage.objects.size).toBe(0)
      expect(readFileSync(elsewhere, 'utf8')).toBe('not an archive of this checkpoint')
    })

    it('the journal names another place for the very bytes that are staged: the record is not this checkpoint’s own, and nothing is uploaded', async () => {
      const { w, node } = await killedWithSealed()

      // Same length, same digest, a path that is not where this checkpoint's archive is staged (a work folder that moved, say).
      node.controller.ctx.journal.update(w.agent, entry => {
        entry.checkpoint = { ...entry.checkpoint!, sealed: { ...entry.checkpoint!.sealed!, path: path.join(node.root, 'moved-work', 'checkpoint.sealed') } }
      })

      expect(await run(node, w)).toMatchObject({ state: 'failed', reason: 'staging_failed', detail: 'sealed_archive_unusable' })
      expect(w.stub.storage.objects.size).toBe(0)
    })
  })

  it('staging that no live checkpoint owns is removed once the reservation is held: orphans of dead runs, and strays', async () => {
    const { w, node } = await managedHome()
    const orphan = path.join(node.root, 'work', w.agent, randomUUID())
    const stray = path.join(node.root, 'work', w.agent, 'stray.sealed')
    mkdirSync(orphan, { recursive: true })
    writeFileSync(path.join(orphan, 'checkpoint.sealed'), 'bytes of a run that died')
    writeFileSync(path.join(orphan, 'checkpoint.plain'), 'plaintext of a run that died')
    writeFileSync(stray, 'a stray')

    expect(await run(node, w)).toMatchObject({ state: 'committed', generation: 2 })
    expect(leftovers(node, w)).toEqual([])
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(stray)).toBe(false)
  })

  it('another agent’s staging is not touched', async () => {
    const { w, node } = await managedHome()
    const other = path.join(node.root, 'work', randomUUID(), randomUUID())
    mkdirSync(other, { recursive: true })
    writeFileSync(path.join(other, 'checkpoint.sealed'), 'someone else’s')

    expect(await run(node, w)).toMatchObject({ state: 'committed', generation: 2 })
    expect(existsSync(path.join(other, 'checkpoint.sealed'))).toBe(true)
  })
})
