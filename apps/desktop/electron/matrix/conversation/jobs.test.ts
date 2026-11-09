import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { conversationJobOrigins } from './jobs'
import { conversationRuntimeFence } from './runtime-fence'

const source = path.resolve(process.cwd(), '../..')
const python = path.join(source, '.venv', 'bin', 'python')
const homes: string[] = []
const runtime = { python, source, profiles: tmpdir() }

afterEach(() => {
  for (const home of homes.splice(0)) {rmSync(home, { recursive: true, force: true })}
})

function home() {
  const value = mkdtempSync(path.join(tmpdir(), 'atum-conversation-cron-'))
  homes.push(value)
  mkdirSync(path.join(value, 'cron'), { recursive: true })

  return value
}

function ticker(home: string): ChildProcessWithoutNullStreams {
  const program = `import fcntl, pathlib, sys
p = pathlib.Path(sys.argv[1]) / 'cron'; p.mkdir(parents=True, exist_ok=True)
f = open(p / '.tick.lock', 'a')
fcntl.flock(f, fcntl.LOCK_EX)
print('ready', flush=True)
sys.stdin.read()
f.close()`

  return spawn(python, ['-c', program, home], { cwd: source, stdio: ['pipe', 'pipe', 'ignore'] })
}

async function ready(child: ChildProcessWithoutNullStreams) {
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve())
    child.once('error', reject)
    child.once('exit', () => reject(new Error('ticker_exit')))
  })
}

async function stop(child: ChildProcessWithoutNullStreams) {
  child.stdin.end()
  await once(child, 'exit')
}

function activeExecution(home: string, mode: 'live' | 'unknown') {
  const program = `import os, pathlib, sqlite3, sys
home = pathlib.Path(sys.argv[1]); db = home / 'cron' / 'executions.db'
conn = sqlite3.connect(db)
conn.execute("CREATE TABLE executions (id TEXT PRIMARY KEY, job_id TEXT, source TEXT, process_id TEXT, pid INTEGER, process_started_at INTEGER, status TEXT, claimed_at TEXT)")
if sys.argv[2] == 'live':
    from gateway.status import get_process_start_time
    pid, started = os.getpid(), get_process_start_time(os.getpid())
else:
    pid, started = 1, None
conn.execute("INSERT INTO executions VALUES ('attempt', 'job', 'cron', 'process', ?, ?, 'running', '2026-01-01T00:00:00+00:00')", (pid, started))
conn.commit(); conn.close()
print('ready', flush=True)
sys.stdin.read()`

  return spawn(python, ['-s', '-P', '-B', '-c', program, home, mode], {
    cwd: source, env: { ...process.env, PYTHONPATH: source, HERMES_HOME: home }, stdio: ['pipe', 'pipe', 'ignore']
  })
}

it('refuses a live ticker lock, then holds it until release', async () => {
  const value = home()
  const running = ticker(value)
  await ready(running)
  await expect(conversationRuntimeFence(runtime, value, new AbortController().signal)).rejects.toThrow('matrix_conversation_turn_live')
  await stop(running)

  const fence = await conversationRuntimeFence(runtime, value, new AbortController().signal)
  expect(fence.held()).toBe(true)
  await expect(conversationRuntimeFence(runtime, value, new AbortController().signal)).rejects.toThrow('matrix_conversation_turn_live')
  await fence.release()
  expect(fence.held()).toBe(false)
})

it('fails closed for active and unprovable execution owners, then releases after actual death', async () => {
  const value = home()
  const live = activeExecution(value, 'live')
  await ready(live)
  await expect(conversationRuntimeFence(runtime, value, new AbortController().signal)).rejects.toThrow('matrix_conversation_turn_live')
  await stop(live)
  const released = await conversationRuntimeFence(runtime, value, new AbortController().signal)
  await released.release()

  const unknownHome = home()
  const unknown = activeExecution(unknownHome, 'unknown')
  await ready(unknown)
  await expect(conversationRuntimeFence(runtime, unknownHome, new AbortController().signal)).rejects.toThrow('matrix_conversation_turn_live')
  await stop(unknown)
})

it('releases the persistent tick lock when its operation signal aborts', async () => {
  const value = home()
  const controller = new AbortController()
  const fence = await conversationRuntimeFence(runtime, value, controller.signal)
  controller.abort()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(fence.held()).toBe(false)
  const next = await conversationRuntimeFence(runtime, value, new AbortController().signal)
  await next.release()
})

it('repoints only Matrix origins while preserving each job id, schedule, and unrelated fields', async () => {
  const value = home()

  const first = { id: 'one', name: 'wake', schedule: { kind: 'cron', expression: '0 * * * *' }, enabled: true,
    custom: { retain: true }, origin: { platform: 'matrix', chat_id: '!old:test', label: 'keep' } }

  const second = { id: 'two', name: 'other', schedule: { kind: 'at', at: '2026-10-08T00:00:00Z' }, enabled: false,
    origin: { platform: 'matrix', chat_id: '!main:test' } }

  const third = { id: 'three', name: 'web', schedule: { kind: 'cron', expression: '1 * * * *' }, enabled: true,
    origin: { platform: 'web', chat_id: '!old:test' } }

  writeFileSync(path.join(value, 'cron', 'jobs.json'), JSON.stringify({ jobs: [first, second, third] }))

  await expect(conversationJobOrigins(runtime, value, { action: 'count', rooms: ['!old:test', '!main:test'], main: '!main:test' }, new AbortController().signal)).resolves.toBe(1)
  await expect(conversationJobOrigins(runtime, value, { action: 'repoint', rooms: ['!old:test', '!main:test'], main: '!main:test' }, new AbortController().signal)).resolves.toBe(1)
  const saved = JSON.parse(readFileSync(path.join(value, 'cron', 'jobs.json'), 'utf8')) as { jobs: Array<Record<string, unknown>> }
  expect(saved.jobs[0]).toMatchObject({ ...first, origin: { platform: 'matrix', chat_id: '!main:test', label: 'keep' } })
  expect(saved.jobs.slice(1)).toEqual([second, third])
})
