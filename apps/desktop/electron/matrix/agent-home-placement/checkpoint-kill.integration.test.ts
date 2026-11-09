/**
 * A checkpoint in a process that is killed (SIGKILL) at each step, and the next process that finds what it left.
 *
 * The in-process crash tests throw from a hook, and a `finally` then tidies up behind the "crash". Here nothing does: the
 * child (`checkpoint-kill.child.fixture.ts`) is the app's real agent-home model with a real journal file, the real Python
 * tool and real staging folders, talking to the platform and its object store over real sockets; it stands still at the named
 * step and the test kills it there. The second process then starts from the files the first left, exactly as the app does
 * after a crash. Opt in with the repository's Python: `ATUM_HOME_PYTHON=<repo>/.venv/bin/python`.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import { EncryptedStore } from '../../encrypted-store'

import type { CheckpointOutcome } from './checkpoint'
import { journalFile, type KillChildConfig, toySafeStorage } from './checkpoint-kill.child.fixture'
import { type ServedFetch, serveFetch } from './http-fetch.fixture'
import { AgentHomeJournal } from './journal'
import { createWorld, scratchDirectory } from './world.fixture'

const python = process.env.ATUM_HOME_PYTHON
const source = process.env.ATUM_HOME_SOURCE ?? fileURLToPath(new URL('../../../../../', import.meta.url))
const desktop = fileURLToPath(new URL('../../../', import.meta.url))
const childFile = fileURLToPath(new URL('./checkpoint-kill.child.fixture.ts', import.meta.url))
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

const servers: ServedFetch[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

/** The command lines of the processes whose arguments mention a folder: what is still running on a Mac's behalf. */
function processesUsing(folder: string): string[] {
  return execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
    .split('\n')
    .filter(line => line.includes(folder))
}

interface ChildRun {
  /** The step it stood still at, when the test killed it there. */
  killedAt?: string
  outcome?: CheckpointOutcome
  signal: NodeJS.Signals | null
  code: number | null
  stderr: string
}

/** Run the child to the end, or to the step it is to die at, where it is killed with SIGKILL the moment it says it is there. */
function runChild(config: KillChildConfig): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', childFile], {
      cwd: desktop,
      env: { ...process.env, ATUM_KILL_CONFIG: JSON.stringify(config) },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const result: ChildRun = { signal: null, code: null, stderr: '' }
    let said = ''

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the child took too long: ${result.stderr.slice(-2000)}`))
    }, 150_000)

    child.stdout.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => {
      said += chunk

      for (let newline = said.indexOf('\n'); newline >= 0; newline = said.indexOf('\n')) {
        const line = said.slice(0, newline)
        said = said.slice(newline + 1)

        if (line.startsWith('KILLPOINT ')) {
          result.killedAt = line.slice('KILLPOINT '.length)
          child.kill('SIGKILL')
        } else if (line.startsWith('OUTCOME ')) {
          result.outcome = JSON.parse(line.slice('OUTCOME '.length)) as CheckpointOutcome
        }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => void (result.stderr += chunk))

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ ...result, code, signal })
    })
  })
}

async function rig() {
  const w = await createWorld({ at: 'a' })
  const shell = await serveFetch(request => w.stub.fetch(request))
  const storage = await serveFetch(w.stub.storage.handle)
  servers.push(shell, storage)
  w.stub.storageOrigin = storage.origin

  const root = scratchDirectory('atum-kill-')
  const home = path.join(root, 'hermes-home')

  for (const [relative, text] of Object.entries({
    'memories/MEMORY.md': 'The code word is lotus.',
    'memories/ghi-chú hôm nay.md': 'note',
    'SOUL.md': 'You are Test.',
    'skills/notes/SKILL.md': '# Notes',
    'cron/jobs.json': '[]',
    '.env': 'OPENAI_API_KEY=sk-do-not-leak'
  })) {
    mkdirSync(path.dirname(path.join(home, relative)), { recursive: true })
    writeFileSync(path.join(home, relative), text)
  }

  const lease = w.stub.lease(w.agent)!

  const config = (dieAt: string | null): KillChildConfig => ({
    shellOrigin: shell.origin,
    token: w.stub.token,
    python: python!,
    source,
    root,
    home,
    agent: w.agent,
    ownerPrincipal: w.stub.ownerPrincipal,
    device: {
      deviceServiceId: w.a.deviceServiceId,
      enrollmentEpoch: w.a.enrollment.enrollmentEpoch,
      kid: w.a.enrollment.identityKid,
      spki: (w.a.signer.identity.public as { spki: string }).spki,
      privateKeyPem: w.a.signer.identity.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    },
    lease: { leaseId: lease.leaseId, leaseExpiresAtPlatform: lease.expiresAt, executorTerm: lease.term },
    now: w.clock.now(),
    dieAt
  })

  // What the next process will find, read the way it reads it: from the journal file the first one wrote.
  const journal = () => new AgentHomeJournal(new EncryptedStore(journalFile(root), toySafeStorage)).read(w.agent)
  const staged = () => path.join(root, 'work', w.agent)

  const stagedFiles = (): string[] =>
    existsSync(staged()) ? (readdirSync(staged(), { recursive: true }) as string[]).filter(name => /[.](plain|sealed)$|snapshot/u.test(name)) : []

  return { w, root, config, journal, staged, stagedFiles }
}

describe.skipIf(!python)('a checkpoint killed at each step, and the process that starts after it', () => {
  test('a process that finishes: committed, nothing left staged, the archive stored', async () => {
    const h = await rig()
    const run = await runChild(h.config(null))

    expect(run.stderr).not.toContain('CHILD FAILED')
    expect(run.outcome).toMatchObject({ state: 'committed', generation: 2 })
    expect(h.stagedFiles()).toEqual([])
    expect(h.w.stub.checkpoints(h.w.agent).map(checkpoint => checkpoint.state)).toEqual(['committed'])
    expect(h.w.stub.archives.size).toBe(1)
    expect(h.journal().checkpoint).toBeUndefined()
  }, 150_000)

  test.each(['reserved', 'hold', 'captured'] as const)('killed at "%s": the next process starts over under the same reservation and commits it, leaving nothing staged', async step => {
    const h = await rig()
    const first = await runChild(h.config(step))

    expect(first.killedAt).toBe(step)
    expect(first.signal).toBe('SIGKILL')
    expect(first.outcome).toBeUndefined()
    // The platform has the reservation and nothing else; the journal still holds it.
    expect(h.w.stub.checkpoints(h.w.agent).map(checkpoint => checkpoint.state)).toEqual(['reserved'])
    expect(h.w.stub.archives.size).toBe(0)
    expect(h.journal().checkpoint).toBeDefined()

    if (step === 'captured') {
      // The killed process left its plaintext archive behind: this is what stopped an exclusive-create restart.
      expect(h.stagedFiles().some(name => name.endsWith('checkpoint.plain'))).toBe(true)
    }

    if (step === 'hold') {
      // The tool was waiting for the desktop's "go" when the desktop died: it sees the pipe close and goes, taking its
      // half-made snapshot with it. Nothing of this checkpoint is left running.
      await expect.poll(() => processesUsing(h.root), { timeout: 30_000, interval: 250 }).toEqual([])
    }

    const second = await runChild(h.config(null))

    expect(second.stderr).not.toContain('CHILD FAILED')
    expect(second.outcome).toMatchObject({ state: 'committed', generation: 2 })
    expect(h.w.stub.checkpoints(h.w.agent).map(checkpoint => checkpoint.state)).toEqual(['committed'])
    expect(h.w.stub.archives.size).toBe(1)
    expect(h.stagedFiles()).toEqual([])
    expect(h.journal().checkpoint).toBeUndefined()
  }, 300_000)

  test('killed with the sealed archive complete: the next process uploads those very bytes, without capturing or sealing again', async () => {
    const h = await rig()
    const first = await runChild(h.config('sealed'))

    expect(first.killedAt).toBe('sealed')
    expect(first.signal).toBe('SIGKILL')

    const record = h.journal().checkpoint

    expect(record).toMatchObject({ phase: 'sealed' })
    expect(record?.sealed).toBeDefined()
    expect(existsSync(record!.sealed!.path)).toBe(true)

    // The journal's record is of the very file on disk: the length and the digest of the bytes the first process sealed.
    const bytes = readFileSync(record!.sealed!.path)

    expect(bytes.length).toBe(record!.sealed!.bytes)
    expect(sha256(bytes)).toBe(record!.sealed!.sha256)
    expect(h.w.stub.archives.size).toBe(0)

    const second = await runChild(h.config(null))

    expect(second.stderr).not.toContain('CHILD FAILED')
    expect(second.outcome).toMatchObject({ state: 'committed', generation: 2 })

    // Sealing again would have made other bytes (a new nonce): what the platform holds is what the first process sealed.
    const homeId = h.w.stub.placement(h.w.agent).homeId
    const stored = h.w.stub.archives.get(`${homeId}:2`)!

    expect(sha256(stored)).toBe(record!.sealed!.sha256)
    expect(h.w.stub.checkpoints(h.w.agent).map(checkpoint => checkpoint.state)).toEqual(['committed'])
    expect(h.stagedFiles()).toEqual([])
    expect(h.journal().checkpoint).toBeUndefined()
  }, 300_000)

  test('killed after the platform committed and before the journal heard: the next process finds the commit landed, reserves nothing again, and removes the staged archive', async () => {
    const h = await rig()
    const first = await runChild(h.config('after-commit'))

    expect(first.killedAt).toBe('after-commit')
    expect(first.signal).toBe('SIGKILL')
    // The platform has the generation; this Mac's journal still says the commit was being sent, and the archive is staged.
    expect(h.w.stub.checkpoints(h.w.agent).map(checkpoint => checkpoint.state)).toEqual(['committed'])
    expect(h.w.stub.placement(h.w.agent)).toMatchObject({ selectedGeneration: 2 })
    expect(h.journal().checkpoint).toMatchObject({ phase: 'committing' })
    expect(h.stagedFiles().some(name => name.endsWith('checkpoint.sealed'))).toBe(true)

    const second = await runChild(h.config(null))

    expect(second.stderr).not.toContain('CHILD FAILED')
    expect(second.outcome).toMatchObject({ state: 'committed', generation: 2, selectedGeneration: 2 })
    // The same generation, once: no second reservation for the same state, no second archive.
    expect(h.w.stub.checkpoints(h.w.agent).map(checkpoint => checkpoint.generation)).toEqual([2])
    expect(h.w.stub.archives.size).toBe(1)
    expect(h.stagedFiles()).toEqual([])
    expect(h.journal()).toMatchObject({ lastGeneration: 2 })
    expect(h.journal().checkpoint).toBeUndefined()
  }, 300_000)

  test.each(['uploaded', 'committing'] as const)('killed at "%s", the platform holding the archive: the next process commits it, and the staged archive is removed rather than left for ever', async step => {
    const h = await rig()
    const first = await runChild(h.config(step))

    expect(first.killedAt).toBe(step)
    expect(first.signal).toBe('SIGKILL')
    expect(h.journal().checkpoint).toMatchObject({ phase: step })
    expect(h.w.stub.archives.size).toBe(1)
    expect(h.stagedFiles().some(name => name.endsWith('checkpoint.sealed'))).toBe(true)

    const second = await runChild(h.config(null))

    expect(second.stderr).not.toContain('CHILD FAILED')
    expect(second.outcome).toMatchObject({ state: 'committed', generation: 2 })
    expect(h.w.stub.checkpoints(h.w.agent).map(checkpoint => checkpoint.state)).toEqual(['committed'])
    // One archive, the one that was already there: nothing was captured, sealed or uploaded a second time.
    expect(h.w.stub.archives.size).toBe(1)
    expect(h.stagedFiles()).toEqual([])
    expect(h.journal().checkpoint).toBeUndefined()
  }, 300_000)
})
