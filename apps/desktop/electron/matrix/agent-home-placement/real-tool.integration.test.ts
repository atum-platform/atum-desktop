/**
 * The whole move, with the REAL Python tool (`hermes_cli.atum_home portable-capture | portable-restore`) on real
 * Hermes-shaped homes, a live SQLite writer on the source throughout, and the stub platform. Opt in with the
 * repository's Python: `ATUM_HOME_PYTHON=<repo>/.venv/bin/python` (and, if the checkout is elsewhere,
 * `ATUM_HOME_SOURCE=<repo>`), exactly as `atum-agent-sync.integration.test.ts` opts in with `ATUM_SYNC_PYTHON`.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { expect, test } from 'vitest'

import { MatrixHermesTurnLock } from '../turn-lock'

import { openFile } from './archive-seal'
import { type CheckpointOutcome, takeCheckpoint } from './checkpoint'
import { PythonHomeTool, readArchiveHeader } from './home-tool'
import { checkpointDepsOf } from './move-source'
import { createNode, type Node, pass, shellArchive, storedGeneration } from './node.fixture'
import { createWorld, signal, type World } from './world.fixture'

const python = process.env.ATUM_HOME_PYTHON
const source = process.env.ATUM_HOME_SOURCE ?? fileURLToPath(new URL('../../../../../', import.meta.url))
const run = promisify(execFile)

async function sqlite(home: string, statements: string): Promise<string> {
  const { stdout } = await run(python!, [
    '-c',
    'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute("PRAGMA journal_mode=WAL")\nfor s in sys.argv[2].split(";"):\n    s=s.strip()\n    if s:\n        r=c.execute(s).fetchall()\n        print(r)\nc.commit()\n',
    path.join(home, 'state.db'),
    statements
  ])

  return stdout
}

const read = (node: Node, relative: string): string | null =>
  existsSync(path.join(node.home, relative)) ? readFileSync(path.join(node.home, relative), 'utf8') : null

function populate(node: Node, label: string): void {
  const write = (relative: string, content: string) => {
    mkdirSync(path.dirname(path.join(node.home, relative)), { recursive: true })
    writeFileSync(path.join(node.home, relative), content)
  }

  write('memories/MEMORY.md', `${label}: the code word is lotus.`)
  write('memories/ghi-chú hôm nay.md', `${label} note`)
  write('SOUL.md', `You are ${label}.`)
  write('skills/notes/SKILL.md', `# Notes (${label})`)
  write('skills/notes/node_modules/dep/index.js', 'module.exports = 1')
  write('skills/notes/.venv/bin/python', 'binary')
  write('config.yaml', `model: ${label}-model\n`)
  write('.env', `OPENAI_API_KEY=${label}-own-key`)
  write('auth.json', `{"token":"${label}-token"}`)
  write('sessions/s1.json', `${label} transcript`)
  write('workspace/project/main.py', `${label} WORKSPACE-FILE-BODY`)
  write('cron/jobs.json', JSON.stringify({ jobs: [{ id: 'j1', prompt: 'hello', workdir: `${node.home}/projects` }] }))
}

async function settle(w: World, nodes: Node[], rounds: number): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const node of nodes) {
      if (w.stub.lease(w.agent)) {
        w.stub.renewLease(w.agent)
      }

      await pass(node, w.agent)
    }

    w.clock.advance(1_000)
  }
}

test.skipIf(!python)('a move there and back with the real tool, a live database on the source, and nothing excluded leaking', async () => {
  const w = await createWorld({ at: 'a' })
  const tool = new PythonHomeTool({ python: python!, source })
  const a = createNode(w, w.a, { tool })
  const b = createNode(w, w.b, { tool })
  populate(a, 'A')
  populate(b, 'B')
  await sqlite(a.home, 'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, content TEXT);INSERT INTO messages (content) VALUES ("A-SESSION-HISTORY")')
  await sqlite(b.home, 'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, content TEXT);INSERT INTO messages (content) VALUES ("B-SESSION-HISTORY")')
  a.runtime.wantsLease = true

  // A live writer on A's session database for the whole move: a capture must neither copy nor disturb it.
  const writer = spawn(python!, [
    '-c',
    'import sqlite3,sys,time\nc=sqlite3.connect(sys.argv[1],timeout=10)\nn=0\nwhile True:\n    c.execute("INSERT INTO messages (content) VALUES (?)",("live-%d"%n,))\n    c.commit()\n    n+=1\n    time.sleep(0.005)\n',
    path.join(a.home, 'state.db')
  ])

  try {
    const moved = await a.controller.requestMove(w.agent, w.b.deviceServiceId, signal())
    expect(moved.ok).toBe(true)
    await settle(w, [a, b], 4)

    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 2, location: { deviceServiceId: w.b.deviceServiceId }, selectedGeneration: 2 })

    // The new home has the old home's memory, skills and persona; the routine's folder is now B's own.
    expect(read(b, 'memories/MEMORY.md')).toBe('A: the code word is lotus.')
    expect(read(b, 'memories/ghi-chú hôm nay.md')).toBe('A note')
    expect(read(b, 'SOUL.md')).toBe('You are A.')
    expect(read(b, 'skills/notes/SKILL.md')).toBe('# Notes (A)')
    expect(JSON.parse(read(b, 'cron/jobs.json')!).jobs[0].workdir).toBe(`${await realpath(b.home)}/projects`)
    // What is this Mac's own stays: settings, credentials, history, its installed packages and its workspace.
    expect(read(b, 'config.yaml')).toBe('model: B-model\n')
    expect(read(b, '.env')).toBe('OPENAI_API_KEY=B-own-key')
    expect(read(b, 'auth.json')).toBe('{"token":"B-token"}')
    expect(read(b, 'skills/notes/node_modules/dep/index.js')).toBe('module.exports = 1')
    expect(read(b, 'workspace/project/main.py')).toBe('B WORKSPACE-FILE-BODY')
    expect(await sqlite(b.home, 'SELECT content FROM messages')).toContain('B-SESSION-HISTORY')
    expect(await sqlite(b.home, 'SELECT content FROM messages')).not.toContain('A-SESSION-HISTORY')
    expect(read(b, 'memories/only-on-b.md')).toBeNull()

    // What was stored: ciphertext that, opened as the target does, holds the portable part and none of the rest,
    // and lists what it left out by category, reason and digest only.
    const homeId = w.stub.placement(w.agent).homeId
    const stored = w.stub.archives.get(`${homeId}:2`)!
    // The move made B the home: B is the Mac the platform lets read its key.
    const key = await shellArchive(w, w.b).keys.key({ agent: w.agent, homeId }, signal())

    if (!key.ok) {
      throw new Error('no key')
    }

    const sealedPath = path.join(a.root, 'inspect.sealed')
    const plainPath = path.join(a.root, 'inspect.plain')
    writeFileSync(sealedPath, stored)
    await openFile({ sealed: sealedPath, plain: plainPath, key: key.value, homeId, generation: 2 })
    const header = await readArchiveHeader(plainPath)
    const plain = readFileSync(plainPath)

    for (const forbidden of ['SQLite format 3', 'A-SESSION-HISTORY', 'live-', 'A-own-key', 'A-token', 'A transcript', 'A WORKSPACE-FILE-BODY', 'A-model', 'module.exports', 'binary']) {
      expect(plain.includes(forbidden), forbidden).toBe(false)
    }

    expect(header.manifest.entries.map(entry => entry.path)).toEqual(
      expect.arrayContaining(['config/SOUL.md', 'memory/MEMORY.md', 'routines/jobs.json', 'skills/notes/SKILL.md', 'config/atum-home.json'])
    )
    expect(header.skipped.map(row => `${row.category}/${row.reasonCode}`).sort()).toEqual(
      expect.arrayContaining(['memory/database_or_sidecar', 'memory/outside_category', 'non_secret_config/credential_or_key_material', 'portable_app_data/machine_workspace', 'skills/package_tree'])
    )

    // A skipped row is a category, a reason code, a count and a digest: it carries no name and no path.
    for (const row of header.skipped) {
      expect(Object.keys(row).sort()).toEqual(['category', 'count', 'pathSha256', 'reasonCode'])
      expect(row.pathSha256).toMatch(/^[0-9a-f]{64}$/u)
    }

    // The source's database was never disturbed by the captures that ran beside its writer.
    expect(await sqlite(a.home, 'PRAGMA integrity_check')).toContain('ok')

    // And back, with something learned on the other Mac.
    writeFileSync(path.join(b.home, 'memories', 'learned-on-b.md'), 'learned on B')
    const back = await b.controller.requestMove(w.agent, w.a.deviceServiceId, signal())
    expect(back.ok).toBe(true)
    await settle(w, [a, b], 4)

    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 3, location: { deviceServiceId: w.a.deviceServiceId }, selectedGeneration: 3 })
    expect(read(a, 'memories/learned-on-b.md')).toBe('learned on B')
    expect(read(a, '.env')).toBe('OPENAI_API_KEY=A-own-key')
    expect(await a.runtime.say('back on A')).toBe('sent')
    expect(await b.runtime.say('stale')).toBe('refused')
  } finally {
    writer.kill('SIGKILL')
  }
}, 120_000)

async function realpath(file: string): Promise<string> {
  return (await import('node:fs/promises')).realpath(file)
}

const nfc = (text: string) => text.normalize('NFC')
const nfd = (text: string) => text.normalize('NFD')

test.skipIf(!python)('names a Mac spells in decomposed form travel under their composed spelling, and arrive composed', async () => {
  const w = await createWorld({ at: 'a' })
  const tool = new PythonHomeTool({ python: python!, source })
  const a = createNode(w, w.a, { tool })
  const b = createNode(w, w.b, { tool })
  a.runtime.wantsLease = true

  const write = (node: Node, relative: string, content: string) => {
    mkdirSync(path.dirname(path.join(node.home, relative)), { recursive: true })
    writeFileSync(path.join(node.home, relative), content)
  }

  // The source's files, spelled the way a Finder, a keyboard or a tool may have made them: decomposed.
  write(a, `memories/${nfd('café.md')}`, 'coffee, new')
  write(a, `memories/${nfd('Phở bò hôm nay.md')}`, 'noodles')
  write(a, `skills/${nfd('Thư mục')}/${nfd('Kỹ năng.md')}`, 'a skill')
  write(a, 'SOUL.md', 'You are A.')
  // The target holds an older copy of one of them, spelled the other way, and a file of its own.
  write(b, `memories/${nfd('café.md')}`, 'coffee, old')
  write(b, 'memories/only-on-b.md', 'stale on B')

  const moved = await a.controller.requestMove(w.agent, w.b.deviceServiceId, signal())
  expect(moved.ok).toBe(true)
  await settle(w, [a, b], 4)

  expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 2, location: { deviceServiceId: w.b.deviceServiceId } })

  // Nothing was left behind for its spelling: all three arrived, under their composed names, with the right bytes.
  const memories = readdirSync(path.join(b.home, 'memories')).sort()
  expect(memories).toEqual([nfc('Phở bò hôm nay.md'), nfc('café.md')].sort())
  expect(read(b, `memories/${nfc('café.md')}`)).toBe('coffee, new')
  expect(read(b, `memories/${nfc('Phở bò hôm nay.md')}`)).toBe('noodles')
  expect(read(b, `skills/${nfc('Thư mục')}/${nfc('Kỹ năng.md')}`)).toBe('a skill')
  expect(read(b, 'memories/only-on-b.md')).toBeNull()

  // The manifest the platform holds names them composed: the grammar admits no other spelling.
  const homeId = w.stub.placement(w.agent).homeId
  const key = await shellArchive(w, w.b).keys.key({ agent: w.agent, homeId }, signal())

  if (!key.ok) {
    throw new Error('no key')
  }

  const sealedPath = path.join(a.root, 'inspect-nfc.sealed')
  const plainPath = path.join(a.root, 'inspect-nfc.plain')
  writeFileSync(sealedPath, w.stub.archives.get(`${homeId}:2`)!)
  await openFile({ sealed: sealedPath, plain: plainPath, key: key.value, homeId, generation: 2 })
  const header = await readArchiveHeader(plainPath)
  const paths = header.manifest.entries.map(entry => entry.path)

  expect(paths).toEqual(expect.arrayContaining(['memory/café.md', 'memory/Phở bò hôm nay.md', 'skills/Thư mục/Kỹ năng.md'].map(nfc)))
  expect(paths.every(entry => entry === nfc(entry))).toBe(true)
  expect(header.skipped.some(row => row.reasonCode === 'invalid_relative_path')).toBe(false)
}, 120_000)

// ---------------------------------------------------------------- a checkpoint beside the running agent

/** A stored generation, opened as the home's other Mac would: the manifest, each entry's bytes and how the capture says it was made. */
const stored = (w: World, node: Node, generation: number) => storedGeneration(w, node, generation)

/** One whole version of a file: one letter, repeated, as long as its generation says. A mixture cannot pass for one. */
const version = (generation: number) => Buffer.alloc(4096 + generation, String.fromCharCode(65 + (generation % 26)))
const generationOf = (data: Buffer) => data.length - 4096
const isWhole = (data: Buffer) => generationOf(data) >= 0 && data.equals(version(generationOf(data)))

// The agent's own turn lock is the barrier the checkpoint holds for the moment it takes its snapshot (main.ts agentHomeHandle).
// Here it is the real class, and the real tool: the writers are held by the lock the app's turns take.
const barrierOf = (lock: MatrixHermesTurnLock) => async () => lock.tryAcquire('home', 'checkpoint')

test.skipIf(!python)('a turn caught between two files is not captured midway: the checkpoint waits for it, then takes both from one moment', async () => {
  const w = await createWorld({ at: 'a' })
  const tool = new PythonHomeTool({ python: python!, source })
  const a = createNode(w, w.a, { tool })
  populate(a, 'A')
  a.controller.ctx.journal.update(w.agent, entry => {
    entry.managed = true
  })

  const lock = new MatrixHermesTurnLock()
  const holdWrites = barrierOf(lock)
  const take = (): Promise<CheckpointOutcome> => takeCheckpoint({ ...checkpointDepsOf(a.controller.ctx), holdWrites }, { agent: w.agent, reason: 'idle' }, signal())
  const write = (relative: string, text: string) => writeFileSync(path.join(a.home, relative), text)

  // A turn that changes a memory and the skill that explains it, one after the other, with a long tool call in between.
  // Both versions are the same size, and nothing is written while the checkpoint reads: only the two moments differ.
  write('memories/MEMORY.md', 'memory v1')
  write('skills/notes/SKILL.md', 'skill  v1')
  const turn = await lock.acquire('!room', 'local')
  write('memories/MEMORY.md', 'memory v2')

  expect(await take()).toMatchObject({ state: 'failed', reason: 'home_changed', detail: 'writers_busy', selectedGeneration: 1 })
  expect([...w.stub.archives.keys()].filter(key => key.endsWith(':2'))).toEqual([])
  expect(a.controller.ctx.journal.read(w.agent).checkpoint).toBeUndefined()

  // The turn ends, having written both: the checkpoint that follows is the home as it is then.
  write('skills/notes/SKILL.md', 'skill  v2')
  turn()

  expect(await take()).toMatchObject({ state: 'committed', generation: 2 })
  const { bodies, capture } = await stored(w, a, 2)

  expect(bodies.get('memory/MEMORY.md')!.toString('utf8')).toBe('memory v2')
  expect(bodies.get('skills/notes/SKILL.md')!.toString('utf8')).toBe('skill  v2')
  // And the archive says how it was made, because that is how it was made.
  expect(capture).toMatchObject({
    writers: 'barrier',
    stagedBy: expect.stringMatching(/^snapshot_(apfs_clone|copy)$/u),
    consistency: { writersQuiesced: true, sqliteMethod: 'sqlite_backup', stableFilesStaged: true }
  })
  expect(a.runtime.calls).toEqual([])
}, 120_000)

test.skipIf(!python)('a turn that asks to begin while the snapshot is staged waits for it, and what it writes is the next checkpoint’s, not this one’s', async () => {
  const w = await createWorld({ at: 'a' })
  const tool = new PythonHomeTool({ python: python!, source })
  const a = createNode(w, w.a, { tool })
  populate(a, 'A')
  a.controller.ctx.journal.update(w.agent, entry => {
    entry.managed = true
  })

  const lock = new MatrixHermesTurnLock()
  const write = (relative: string, text: string) => writeFileSync(path.join(a.home, relative), text)
  write('memories/MEMORY.md', 'memory v1')
  write('skills/notes/SKILL.md', 'skill  v1')

  // A turn asks to begin the instant the writers are held: it queues behind the checkpoint's hold, and is let in the moment
  // the tool says the window is over, where it changes both files.
  let turn: Promise<void> | undefined

  const holdWrites = async () => {
    const release = lock.tryAcquire('home', 'checkpoint')

    if (release) {
      turn = lock.acquire('!room', 'local').then(letGo => {
        write('memories/MEMORY.md', 'memory v2')
        write('skills/notes/SKILL.md', 'skill  v2')
        letGo()
      })
    }

    return release
  }

  const take = (hold: typeof holdWrites): Promise<CheckpointOutcome> =>
    takeCheckpoint({ ...checkpointDepsOf(a.controller.ctx), holdWrites: hold }, { agent: w.agent, reason: 'idle' }, signal())

  expect(await take(holdWrites)).toMatchObject({ state: 'committed', generation: 2 })
  await turn

  const first = await stored(w, a, 2)

  // The turn was kept out of the window: this checkpoint is the home as it was when the writers were held, both files.
  expect(first.bodies.get('memory/MEMORY.md')!.toString('utf8')).toBe('memory v1')
  expect(first.bodies.get('skills/notes/SKILL.md')!.toString('utf8')).toBe('skill  v1')
  // And it was not refused, only made to wait: both of its writes are in the home now.
  expect(readFileSync(path.join(a.home, 'memories/MEMORY.md'), 'utf8')).toBe('memory v2')

  expect(await take(barrierOf(lock))).toMatchObject({ state: 'committed', generation: 3 })
  const second = await stored(w, a, 3)

  expect(second.bodies.get('memory/MEMORY.md')!.toString('utf8')).toBe('memory v2')
  expect(second.bodies.get('skills/notes/SKILL.md')!.toString('utf8')).toBe('skill  v2')
  expect(a.runtime.calls).toEqual([])
}, 120_000)

test.skipIf(!python)('a checkpoint beside the running agent, with the real tool: stops nothing, holds the writers for the snapshot only, and walks the home again under the hold when it moved before it', async () => {
  const w = await createWorld({ at: 'a' })
  const tool = new PythonHomeTool({ python: python!, source })
  const a = createNode(w, w.a, { tool })
  populate(a, 'A')
  a.controller.ctx.journal.update(w.agent, entry => {
    entry.managed = true
  })

  const logs: string[] = []

  const take = (overrides: Partial<ReturnType<typeof checkpointDepsOf>> = {}): Promise<CheckpointOutcome> =>
    takeCheckpoint({ ...checkpointDepsOf(a.controller.ctx), log: line => logs.push(line), ...overrides }, { agent: w.agent, reason: 'idle' }, signal())

  // Nobody writes: committed, and the agent's writers were never asked to stop. They were held once, for the snapshot.
  expect(await take()).toMatchObject({ state: 'committed', generation: 2 })
  expect(a.runtime.calls).toEqual([])
  expect(a.runtime.holds).toBe(0)
  expect(a.runtime.barrier).toEqual(['hold', 'release'])
  expect(logs.filter(line => line.includes('writers held'))).toHaveLength(1)
  expect(logs.join('\n')).not.toContain('walked again')

  // A writer finishes its work after the tool has walked the home and before the writers are held (the moment the desktop is
  // taking the lock: a walk that straddles a turn ends like this). The writers are held by then, so the tool walks the home
  // again under the hold and the snapshot is the home as it is when they were held, with that work in it.
  const wrote = async () => {
    writeFileSync(path.join(a.home, 'memories', 'MEMORY.md'), 'A: the code word is now jasmine, said between the walk and the window, at some length.')

    return a.runtime.holdWrites()
  }

  expect(await take({ holdWrites: wrote })).toMatchObject({ state: 'committed', generation: 3 })
  expect(a.runtime.held).toBe(false)
  expect(a.runtime.calls).toEqual([])
  expect(logs.filter(line => line.includes('walked again under the hold'))).toHaveLength(1)

  const { bodies } = await stored(w, a, 3)

  expect(bodies.get('memory/MEMORY.md')!.toString('utf8')).toContain('jasmine')
  expect(a.runtime.calls).toEqual([])
}, 120_000)

/** One whole transaction, as Hermes writes: a temporary, then an atomic replace. */
async function replaceAtomically(home: string, name: string, data: Buffer): Promise<void> {
  const target = path.join(home, 'memories', name)
  const temporary = path.join(home, 'memories', `.mem_${name}.tmp`)
  await writeFile(temporary, data)
  await rename(temporary, target)
}

const STORM_NAMES = Array.from({ length: 8 }, (_unused, index) => `storm-${index}.md`)

test.skipIf(!python)('a writer that updates eight files as one transaction under the agent’s lock is never caught midway: every checkpoint is one generation of all eight, and the writer is only ever made to wait a moment', async () => {
  const w = await createWorld({ at: 'a' })
  const tool = new PythonHomeTool({ python: python!, source })
  const a = createNode(w, w.a, { tool })
  populate(a, 'A')
  a.controller.ctx.journal.update(w.agent, entry => {
    entry.managed = true
  })

  const lock = new MatrixHermesTurnLock()
  let generation = 0
  let running = true
  let longestWaitMs = 0

  for (const name of STORM_NAMES) {
    await replaceAtomically(a.home, name, version(0))
  }

  // A turn: it takes the lock, rewrites the eight files one after another with a pause between each (a slow tool call is
  // exactly where a checkpoint used to land), lets go, and the agent is idle before the next, for at least twice as long as
  // the turn took however slowly this machine runs it: a loaded machine must not make the turn the only thing the agent does.
  const writer = (async () => {
    while (running) {
      const asked = performance.now()
      const release = await lock.acquire('!room', 'local')
      const began = performance.now()
      longestWaitMs = Math.max(longestWaitMs, began - asked)

      try {
        generation += 1

        for (const name of STORM_NAMES) {
          await replaceAtomically(a.home, name, version(generation))
          await sleep(3)
        }
      } finally {
        release()
      }

      await sleep(Math.max(40, 2 * (performance.now() - began)))
    }
  })()

  const take = (): Promise<CheckpointOutcome> =>
    takeCheckpoint({ ...checkpointDepsOf(a.controller.ctx), holdWrites: barrierOf(lock) }, { agent: w.agent, reason: 'cadence_dirty' }, signal())

  const committed: number[] = []
  let refused = 0
  let attempts = 0

  try {
    for (; attempts < 60 && committed.length < 4; attempts += 1) {
      const outcome = await take()

      if (outcome.state === 'committed') {
        committed.push(outcome.generation)
      } else {
        // The only lawful way to not take one: the turn was mid-transaction when the writers were to be held.
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ reason: 'home_changed', detail: 'writers_busy' })
        refused += 1
      }
    }
  } finally {
    running = false
    await writer
  }

  expect(a.runtime.calls).toEqual([])
  expect(committed.length, `${refused} of ${attempts} attempts found the turn mid-transaction`).toBeGreaterThanOrEqual(4)
  // The writer waited for a snapshot window, not for a checkpoint: inside the 30 seconds the window is allowed at the most
  // (what a loaded machine adds to the wait is the machine's, and the bound is loose for it).
  expect(longestWaitMs).toBeLessThan(25_000)

  // Everything that was kept: each file one whole version, and all eight the same generation. The files were never a mixture
  // of two moments of the home, because nothing was written while they were held and no transaction was cut in half.
  for (const gen of committed) {
    const { bodies } = await stored(w, a, gen)
    const seen = STORM_NAMES.map(name => bodies.get(`memory/${name}`))

    expect(seen.every(data => data !== undefined && isWhole(data)), `generation ${gen}`).toBe(true)
    expect(new Set(seen.map(data => generationOf(data!))).size, `generation ${gen}: ${seen.map(data => generationOf(data!)).join(',')}`).toBe(1)
  }
}, 240_000)

test.skipIf(!python)('checkpoints taken while files are rewritten by something the app cannot see are never torn: a snapshot that a write reached is refused, one that is kept is a whole generation', async () => {
  const w = await createWorld({ at: 'a' })
  const tool = new PythonHomeTool({ python: python!, source })
  const a = createNode(w, w.a, { tool })
  populate(a, 'A')
  a.controller.ctx.journal.update(w.agent, entry => {
    entry.managed = true
  })

  let generation = 0
  let storming = true
  let running = true

  for (const name of STORM_NAMES) {
    await replaceAtomically(a.home, name, version(0))
  }

  // Not under the agent's lock: a Hermes cron job, say. In bursts of rewriting as fast as the loop goes, then a long pause. A
  // snapshot that a burst reaches (from the tool's walk until its window ends) is refused by the tool's second look; one in a
  // pause is kept, with the writer alive and about to start again.
  const writer = (async () => {
    while (running) {
      if (storming) {
        const until = performance.now() + 15

        while (performance.now() < until) {
          generation += 1

          for (const name of STORM_NAMES) {
            await replaceAtomically(a.home, name, version(generation))
          }
        }
      }

      await sleep(1_500)
    }
  })()

  const take = (): Promise<CheckpointOutcome> => takeCheckpoint(checkpointDepsOf(a.controller.ctx), { agent: w.agent, reason: 'cadence_dirty' }, signal())
  const committed: number[] = []

  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const outcome = await take()

      if (outcome.state === 'committed') {
        committed.push(outcome.generation)
      } else {
        // Refused because something wrote the home inside the window, or because a file would not hold still for the tool
        // (which fails the snapshot rather than carry it torn). A snapshot that mixed two moments is never kept.
        const lawful = outcome.reason === 'home_changed' || (outcome.reason === 'staging_failed' && outcome.detail === 'home_file_changed')
        expect(lawful, JSON.stringify(outcome)).toBe(true)
      }
    }

    // The storm ends: the very next checkpoint is taken.
    storming = false
    await sleep(50)
    const quiet = await take()
    expect(quiet).toMatchObject({ state: 'committed' })
    committed.push((quiet as { generation: number }).generation)
  } finally {
    running = false
    await writer
  }

  expect(a.runtime.calls).toEqual([])

  // Everything that was kept: each file one whole version, and all eight one generation (the writer only pauses between
  // generations, and a snapshot is kept only if nothing moved from the walk to the end of the window).
  for (const gen of committed) {
    const { bodies } = await stored(w, a, gen)
    const seen = STORM_NAMES.map(name => bodies.get(`memory/${name}`))

    expect(seen.every(data => data !== undefined && isWhole(data)), `generation ${gen}`).toBe(true)
    expect(new Set(seen.map(data => generationOf(data!))).size, `generation ${gen}: ${seen.map(data => generationOf(data!)).join(',')}`).toBe(1)
  }

  expect(committed.length).toBeGreaterThanOrEqual(1)
}, 240_000)

test.skipIf(!python)('answers "has the home changed?" with the real tool: the same after a capture, different after a memory is written', async () => {
  const w = await createWorld({ at: 'a' })
  const tool = new PythonHomeTool({ python: python!, source })
  const a = createNode(w, w.a, { tool })
  populate(a, 'A')

  const before = await tool.fingerprint({ home: a.home }, signal())
  expect(before.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/u)
  expect(before.files).toBeGreaterThan(0)

  const out = path.join(a.root, 'fingerprint.plain')
  const captured = await tool.capture({ home: a.home, out, homeId: w.stub.placement(w.agent).homeId, generation: 2, parentGeneration: 1, homeEpoch: 1 }, signal())

  expect(captured.fingerprintSha256).toBe(before.fingerprintSha256)

  // Never carried: history, credentials, settings. Carried: a memory.
  writeFileSync(path.join(a.home, 'config.yaml'), 'model: other\n')
  writeFileSync(path.join(a.home, '.env'), 'OPENAI_API_KEY=other')
  expect((await tool.fingerprint({ home: a.home }, signal())).fingerprintSha256).toBe(before.fingerprintSha256)

  writeFileSync(path.join(a.home, 'memories', 'MEMORY.md'), 'A: the code word is now jasmine, and longer.')
  expect((await tool.fingerprint({ home: a.home }, signal())).fingerprintSha256).not.toBe(before.fingerprintSha256)
}, 120_000)
