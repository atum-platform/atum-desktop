import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, expect, it, vi } from 'vitest'

import { MatrixDrive } from './drive'

// manifestFor (S1 WS-5): the main-only journal facts a Mac's working copy is built from. The
// engine is a scripted stdio peer, as in drive.test.ts; the files are real.

const fixtures: string[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true })
  }
})

function fixture() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'atum-drive-manifest-')))
  fixtures.push(home)
  const root = path.join(home, 'Files')
  mkdirSync(root)
  const owner = { issuer: 'https://auth.test/', subject: 'owner-a', generation: 1 }
  const engine = { binary: '/unused', issuer: owner.issuer, origin: 'https://drive.test' }

  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      child.emit('close', 0)

      return true
    })
  })

  const store = new Map<string, string>()

  const drive = new MatrixDrive({
    owner: () => owner,
    engine,
    userData: home,
    defaultFolder: root,
    store: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) },
    chooseFolder: vi.fn(async () => root),
    openExternal: vi.fn(async () => {}),
    openPath: vi.fn(async () => ''),
    changed: vi.fn(),
    spawn: vi.fn(() => child as unknown as ChildProcessWithoutNullStreams)
  })

  const send = (message: unknown) => child.stdout.write(JSON.stringify(message) + '\n')

  // The engine's binding, as its first enrollment leaves it, written before Connect: Drive never
  // binds a picked folder that holds files unless that folder is already the engine's (drive-folder).
  const enrolled = async (state = 'ready') => {
    writeFileSync(
      path.join(root, '.atum-drive-binding.json'),
      JSON.stringify({ version: 1, canonicalRoot: root, issuer: owner.issuer, subject: owner.subject, origin: engine.origin,
        journal: '.atum-drive-journal.db', space: 'storage$personal' })
    )
    await drive.connect()
    send({ kind: 'hello', protocol: 1, issuer: owner.issuer, origin: engine.origin, taskFiles: true })
    send({ kind: 'state', state })
    await drive.read()
  }

  // The engine's side: answer every file_metadata request with `answer(relativePath)`.
  const requests: Array<Record<string, unknown>> = []
  let buffered = ''

  // `undefined` is an engine that reads the request and never answers it.
  const serve = (answer: (relativePath: string) => Record<string, unknown> | null | undefined, delayMs = (_relativePath: string) => 0) => {
    child.stdin.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()

      while (buffered.includes('\n')) {
        const line = buffered.slice(0, buffered.indexOf('\n'))
        buffered = buffered.slice(buffered.indexOf('\n') + 1)
        const message = JSON.parse(line) as Record<string, unknown>

        if (message.kind !== 'file_metadata') {continue}
        requests.push(message)
        const reply = answer(String(message.relativePath))

        if (reply === undefined) {continue}
        const delay = delayMs(String(message.relativePath))

        const respond = () => send(reply
          ? { kind: 'file_metadata', requestId: message.requestId, state: 'ready', ...reply }
          : { kind: 'file_metadata', requestId: message.requestId, state: 'unavailable' })

        if (delay > 0) {setTimeout(respond, delay)} else {setImmediate(respond)}
      }
    })
  }

  return { drive, root, home, enrolled, serve, requests }
}

const resource = (opaque: string) => ({ storage: 'storage', space: 'personal', opaque })

it('is null until Drive is set up and enrolled on this Mac', async () => {
  const f = fixture()
  expect(await f.drive.manifestFor([])).toBeNull()
})

it('binds a clean file to its server version, and nothing else', async () => {
  const f = fixture()
  mkdirSync(path.join(f.root, 'Agents', 'T', 'notes'), { recursive: true })
  writeFileSync(path.join(f.root, 'Agents', 'T', 'notes', 'a.md'), 'alpha')
  writeFileSync(path.join(f.root, 'Agents', 'T', 'draft.md'), 'local edit')
  writeFileSync(path.join(f.home, 'outside.txt'), 'foreign')
  symlinkSync(path.join(f.home, 'outside.txt'), path.join(f.root, 'Agents', 'T', 'link.md'))
  await f.enrolled()
  f.serve(relative => relative === 'Agents/T/notes/a.md' ? { resource: resource('a-id'), etag: '"e1"', size: 5 } : null)

  const manifest = await f.drive.manifestFor(['Agents/T/notes/a.md', 'Agents/T/draft.md', 'Agents/T/link.md', 'Agents/T/../x', 'Agents/T/missing.md'])
  expect(manifest!.root).toBe(f.root)
  expect([...manifest!.files]).toEqual([
    ['Agents/T/notes/a.md', { resource: resource('a-id'), etag: '"e1"', size: 5 }],
    ['Agents/T/draft.md', null],
    ['Agents/T/link.md', null],
    ['Agents/T/../x', null],
    ['Agents/T/missing.md', null]
  ])
  expect(f.requests.map(request => request.relativePath), 'a symlink, an escape or a missing file never reaches the engine')
    .toEqual(['Agents/T/notes/a.md', 'Agents/T/draft.md'])
  expect(f.requests.every(request => request.mode === 'read')).toBe(true)
})

it('asks nothing of an engine that is not ready, and refuses an answer about a replaced file', async () => {
  const paused = fixture()
  writeFileSync(path.join(paused.root, 'a.md'), 'alpha')
  await paused.enrolled('paused')
  paused.serve(() => ({ resource: resource('a-id'), etag: '"e1"', size: 5 }))
  expect([...(await paused.drive.manifestFor(['a.md']))!.files]).toEqual([['a.md', null]])
  expect(paused.requests).toEqual([])

  const swapped = fixture()
  writeFileSync(path.join(swapped.root, 'a.md'), 'alpha')
  writeFileSync(path.join(swapped.root, 'other.md'), 'other')
  await swapped.enrolled()
  swapped.serve(relative => {
    // The file is replaced while the engine answers: the answer is about a file that is gone.
    renameSync(path.join(swapped.root, 'other.md'), path.join(swapped.root, relative))

    return { resource: resource('a-id'), etag: '"e1"', size: 5 }
  })
  expect([...(await swapped.drive.manifestFor(['a.md']))!.files]).toEqual([['a.md', null]])
})

it('stops asking an engine that has stopped answering, so a device turn is never held for hours', async () => {
  const f = fixture()
  const names = Array.from({ length: 12 }, (_, index) => `f${index}.md`)

  for (const name of names) {writeFileSync(path.join(f.root, name), name)}
  await f.enrolled()
  // The engine answers the first request slowly, then reads every request and answers none, so a
  // request is still in flight when the budget runs out.
  f.serve(relative => relative === 'f0.md' ? null : undefined, relative => relative === 'f0.md' ? 5_000 : 0)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

  try {
    let settled: Awaited<ReturnType<typeof f.drive.manifestFor>> | undefined
    const started = Date.now()
    void f.drive.manifestFor(names).then(result => void (settled = result))

    for (let step = 0; step < 200 && settled === undefined; step += 1) {
      await vi.advanceTimersByTimeAsync(1_000)
    }

    expect(settled, 'the whole list settles').toBeDefined()
    expect(Date.now() - started, 'within the one 60 s budget, the in-flight request included').toBeLessThanOrEqual(61_000)
    expect([...settled!.files.values()].every(facts => facts === null)).toBe(true)
    expect(f.requests.length, 'the files after the budget are never asked').toBeLessThan(names.length)
  } finally {
    vi.useRealTimers()
  }
})
