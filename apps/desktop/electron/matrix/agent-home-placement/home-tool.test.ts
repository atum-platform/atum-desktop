/**
 * The desktop's half of a snapshot: the conversation with `portable-snapshot --hold` over the process's pipes, driven by a
 * scripted child. What it must keep: the agent's writers are held exactly from the tool's `ready` to its `staged`, and are let
 * go on every other way out too, so a process that dies, hangs or is aborted never leaves them held.
 */
import type { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { HomeToolError, PythonHomeTool, type SnapshotTiming } from './home-tool'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const sha = 'a'.repeat(64)

/** A child process the test plays: it says what the tool says, and records what the desktop says to it. */
class ScriptedChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly written: string[] = []
  stdinEnded = false
  killedWith: string | null = null

  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      this.written.push(chunk.toString('utf8'))
      done()
    },
    final: done => {
      this.stdinEnded = true
      done()
    }
  })

  kill(signal: string): boolean {
    this.killedWith = signal
    setImmediate(() => this.exit(null))

    return true
  }

  say(value: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(value)}\n`)
  }

  complain(text: string): void {
    this.stderr.write(text)
  }

  /** The process ends: its pipes close, and then it is gone. */
  async exit(code: number | null): Promise<void> {
    await tick()
    this.stdout.end()
    this.stderr.end()
    this.emit('close', code, null)
  }
}

const SUMMARY = { ok: true, fingerprintSha256: sha, files: 3, bytes: 120, method: 'apfs_clone', sqliteDatabases: 1, heldMs: 310, attempts: 1 }
const RUNTIME = { python: '/venv/bin/python', source: '/repo' }
const QUICK: SnapshotTiming = { readyMs: 200, holdMs: 200, windowMs: 200, finishMs: 200 }

function rig(options: { timing?: SnapshotTiming } = {}) {
  const child = new ScriptedChild()
  const started: Array<{ command: string; args: string[] }> = []

  const start = ((command: string, args: string[]) => {
    started.push({ command, args })

    return child
  }) as unknown as typeof spawn

  const tool = new PythonHomeTool(RUNTIME, undefined, start, options.timing ?? QUICK)
  const signal = new AbortController()

  /** What the desktop did with the writers, in order. */
  const events: string[] = []
  let hold: () => Promise<(() => void) | null> = async () => () => void events.push('let go')

  const input = {
    home: '/home/agent',
    dest: '/work/snapshot',
    hold: async () => {
      events.push('hold asked')

      return hold()
    }
  }

  return {
    child,
    started,
    events,
    signal,
    hold: (fn: typeof hold) => {
      hold = async () => {
        const release = await fn()

        return release ? () => void (events.push('let go'), release()) : null
      }
    },
    snapshot: () => tool.snapshot(input, signal.signal)
  }
}

describe('a snapshot with the real tool’s conversation', () => {
  it('starts the tool in hold mode, holds the writers when it is ready, and lets them go the moment it says the window is over', async () => {
    const r = rig()
    const result = r.snapshot()

    expect(r.started).toEqual([
      {
        command: '/venv/bin/python',
        args: ['-s', '-P', '-B', '-m', 'hermes_cli.atum_home', 'portable-snapshot', '--home', '/home/agent', '--dest', '/work/snapshot', '--hold']
      }
    ])

    // Not asked while the tool is still walking the home: the writers are held for the window only.
    await tick()
    expect(r.events).toEqual([])

    r.child.say({ ok: true, phase: 'ready' })
    await tick()
    await tick()
    expect(r.events).toEqual(['hold asked'])
    expect(r.child.written).toEqual(['go\n'])

    r.child.say({ ok: true, phase: 'staged' })
    await tick()
    // Let go at "staged", before the tool has written its record and exited.
    expect(r.events).toEqual(['hold asked', 'let go'])

    r.child.say(SUMMARY)
    await r.child.exit(0)

    await expect(result).resolves.toEqual({ fingerprintSha256: sha, files: 3, bytes: 120, method: 'apfs_clone', sqliteDatabases: 1, heldMs: 310, attempts: 1 })
    expect(r.events).toEqual(['hold asked', 'let go'])
    expect(r.child.killedWith).toBeNull()
  })

  it('is told the writers are busy when they cannot be held: the tool is told to stop, and nothing is held or let go', async () => {
    const r = rig()
    r.hold(async () => null)
    const result = r.snapshot()
    const settled = result.catch((error: unknown) => error)

    r.child.say({ ok: true, phase: 'ready' })
    await tick()
    await tick()

    // Anything but "go" cancels it; it removes what it made and exits.
    expect(r.child.written).toEqual(['stop\n'])
    expect(r.child.stdinEnded).toBe(true)
    r.child.complain('{"error": "home_snapshot_cancelled"}\n')
    await r.child.exit(2)

    expect(await settled).toMatchObject({ code: 'home_writers_busy' })
    expect(r.events).toEqual(['hold asked'])
  })

  it('reports the tool’s own closed reason when it fails inside the window, and the writers are let go', async () => {
    const r = rig()
    const result = r.snapshot()
    const settled = result.catch((error: unknown) => error)

    r.child.say({ ok: true, phase: 'ready' })
    await tick()
    await tick()
    r.child.complain('{"error": "home_changed_during_snapshot"}\n')
    await r.child.exit(2)

    expect(await settled).toMatchObject({ code: 'home_changed_during_snapshot' })
    expect(r.events).toEqual(['hold asked', 'let go'])
  })

  it('lets the writers go and kills the tool when the caller aborts inside the window', async () => {
    const r = rig()
    const settled = r.snapshot().catch((error: unknown) => error)

    r.child.say({ ok: true, phase: 'ready' })
    await tick()
    await tick()
    r.signal.abort(new Error('a move began'))

    expect(await settled).toMatchObject({ message: 'a move began' })
    expect(r.child.killedWith).toBe('SIGKILL')
    expect(r.events).toEqual(['hold asked', 'let go'])
  })

  it('does not start at all for a signal that is already aborted', async () => {
    const r = rig()
    r.signal.abort(new Error('already'))

    await expect(r.snapshot()).rejects.toThrow('already')
    expect(r.started).toEqual([])
  })

  it('kills the tool and lets the writers go when the window takes longer than it may', async () => {
    const r = rig()
    const settled = r.snapshot().catch((error: unknown) => error)

    r.child.say({ ok: true, phase: 'ready' })
    await tick()
    await tick()

    // The tool never says "staged": a hung clone must not hold the agent's turns for ever.
    expect(await settled).toMatchObject({ code: 'home_tool_timeout' })
    expect(r.child.killedWith).toBe('SIGKILL')
    expect(r.events).toEqual(['hold asked', 'let go'])
  })

  it('kills a tool that never says ready, without ever asking for the writers', async () => {
    const r = rig()

    await expect(r.snapshot()).rejects.toMatchObject({ code: 'home_tool_timeout' })
    expect(r.child.killedWith).toBe('SIGKILL')
    expect(r.events).toEqual([])
  })

  it('lets go of writers that were granted after the tool was already gone: a hold is never leaked', async () => {
    const r = rig()
    let grant!: (release: () => void) => void

    r.hold(
      () =>
        new Promise<(() => void) | null>(resolve => {
          grant = resolve
        })
    )

    const settled = r.snapshot().catch((error: unknown) => error)

    r.child.say({ ok: true, phase: 'ready' })
    await tick()
    await tick()
    // The tool is killed while the desktop is still asking for the writers.
    r.signal.abort(new Error('stood down'))
    expect(await settled).toMatchObject({ message: 'stood down' })

    grant(() => void r.events.push('released late'))
    await tick()

    // Granted after the tool was gone, and let go at once (the rig notes the release, then the lock's own function runs).
    expect(r.events).toEqual(['hold asked', 'let go', 'released late'])
    expect(r.child.written).toEqual([])
  })

  it('treats a failure to ask for the writers as a failed snapshot, and stops the tool', async () => {
    const r = rig()

    r.hold(async () => {
      throw new Error('lock_broken')
    })

    const settled = r.snapshot().catch((error: unknown) => error)

    r.child.say({ ok: true, phase: 'ready' })
    await tick()
    await tick()

    expect(await settled).toMatchObject({ code: 'home_hold_failed' })
    expect(r.child.killedWith).toBe('SIGKILL')
    expect(r.child.written).toEqual([])
  })

  it.each([
    ['output that is not JSON', 'not json at all'],
    ['a line that is not ok', JSON.stringify({ ok: false })],
    ['a phase out of order', JSON.stringify({ ok: true, phase: 'staged' })]
  ])('refuses %s', async (_label, line) => {
    const r = rig()
    const settled = r.snapshot().catch((error: unknown) => error)

    r.child.stdout.write(`${line}\n`)

    expect(await settled).toMatchObject({ code: 'home_tool_invalid' })
    expect(r.child.killedWith).toBe('SIGKILL')
    expect(r.events).toEqual([])
  })

  it.each([
    ['a fingerprint that is not a digest', { fingerprintSha256: 'nope' }],
    ['a count that is not a count', { files: -1 }],
    ['a method it does not know', { method: 'rsync' }],
    ['no hold time', { heldMs: undefined }],
    ['no count of walks', { attempts: undefined }],
    ['no walk at all', { attempts: 0 }]
  ])('refuses a summary with %s', async (_label, change) => {
    const r = rig()
    const settled = r.snapshot().catch((error: unknown) => error)

    r.child.say({ ok: true, phase: 'ready' })
    await tick()
    await tick()
    r.child.say({ ok: true, phase: 'staged' })
    r.child.say({ ...SUMMARY, ...change })
    await r.child.exit(0)

    expect(await settled).toMatchObject({ code: 'home_tool_invalid' })
    // The window had ended when the summary came, and the writers had been let go.
    expect(r.events).toEqual(['hold asked', 'let go'])
  })

  it('fails when the tool exits cleanly without a summary, and when it cannot be started', async () => {
    const early = rig()
    const settled = early.snapshot().catch((error: unknown) => error)

    early.child.say({ ok: true, phase: 'ready' })
    await tick()
    await tick()
    early.child.say({ ok: true, phase: 'staged' })
    await early.child.exit(0)
    expect(await settled).toMatchObject({ code: 'home_tool_failed' })

    const missing = rig()
    const gone = missing.snapshot().catch((error: unknown) => error)
    missing.child.emit('error', new Error('spawn ENOENT'))
    expect(await gone).toBeInstanceOf(HomeToolError)
    expect(await gone).toMatchObject({ code: 'home_tool_failed' })
  })

  it('reads a line that arrives in pieces', async () => {
    const r = rig()
    const settled = r.snapshot()

    r.child.stdout.write('{"ok": true, "ph')
    await tick()
    expect(r.events).toEqual([])
    r.child.stdout.write('ase": "ready"}\n')
    await tick()
    await tick()
    expect(r.events).toEqual(['hold asked'])

    r.child.say({ ok: true, phase: 'staged' })
    r.child.say(SUMMARY)
    await r.child.exit(0)

    await expect(settled).resolves.toMatchObject({ files: 3 })
  })
})

describe('a capture from a snapshot', () => {
  const answer = {
    ok: true,
    manifestSha256: sha,
    contentSha256: sha,
    fingerprintSha256: sha,
    stagedBy: 'snapshot_apfs_clone',
    includedFiles: 2,
    bytes: 9,
    archiveSha256: sha,
    archiveBytes: 99,
    skippedRows: 0,
    skippedPaths: 0
  }

  function run(reply: Record<string, unknown>) {
    const calls: string[][] = []

    const fake = ((_file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      calls.push(args)
      callback(null, `${JSON.stringify(reply)}\n`, '')

      return {}
    }) as unknown as typeof execFile

    return { calls, tool: new PythonHomeTool(RUNTIME, fake) }
  }

  const input = { home: '/h', out: '/o', homeId: '00000000-0000-4000-8000-bd7662a5eeb4', generation: 2, parentGeneration: 1, homeEpoch: 1 }

  it('passes the snapshot folder to the tool, and none when there is none', async () => {
    const withSnapshot = run(answer)
    await withSnapshot.tool.capture({ ...input, snapshot: '/work/snapshot' }, new AbortController().signal)
    expect(withSnapshot.calls[0]).toEqual(expect.arrayContaining(['portable-capture', '--snapshot', '/work/snapshot']))

    const without = run({ ...answer, stagedBy: 'stable_read' })
    const summary = await without.tool.capture(input, new AbortController().signal)
    expect(without.calls[0]).not.toContain('--snapshot')
    expect(summary.stagedBy).toBe('stable_read')
  })

  it('refuses a way of staging the tool should not name', async () => {
    const odd = run({ ...answer, stagedBy: 'live_read' })

    await expect(odd.tool.capture(input, new AbortController().signal)).rejects.toMatchObject({ code: 'home_tool_invalid' })
  })
})
