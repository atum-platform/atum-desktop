import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type CloudHomeAction,
  cloudHomeMemoryNote,
  cloudHomePathAllowed,
  cloudHomePathHidden,
  cloudHomeReadApplies,
  type CloudHomeResponse,
  MatrixCloudHomeReader,
  type MatrixCloudHomeReaderOptions,
  parseCloudHomeManifest,
  requestCloudHome
} from './cloud-home-read'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const roots: string[] = []
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function home(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'atum-cloud-home-'))
  roots.push(root)

  return root
}

/** The backups folder of a reader, a fresh one per reader unless the test names it. */
function backupsFolder(): string {
  return path.join(home(), 'device', 'cloud-home-backups')
}

function readerFor(options: Omit<MatrixCloudHomeReaderOptions, 'backups'> & { backups?: string }) {
  return new MatrixCloudHomeReader({ backups: backupsFolder(), ...options })
}

afterEach(() => {
  vi.unstubAllGlobals()

  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** A committed cloud home: path -> text. */
function cloud(files: Record<string, string>, generation = 7) {
  const manifest = {
    profile: 'atum.cloud-home-read/1',
    agentPrincipal: AGENT,
    generation,
    committedAt: 1_791_877_000_000,
    files: Object.entries(files).map(([file, text]) => ({
      path: file,
      size: Buffer.byteLength(text),
      sha256: sha(text)
    }))
  }

  const request = vi.fn(async (_agent: string, action: CloudHomeAction): Promise<CloudHomeResponse> => {
    if (action.kind === 'manifest') {
      return { status: 200, value: manifest }
    }

    const text = files[action.path]!

    return {
      status: 200,
      value: {
        generation: action.generation,
        path: action.path,
        sha256: sha(text),
        content: Buffer.from(text).toString('base64')
      }
    }
  })

  return { manifest, request }
}

const sync = (reader: MatrixCloudHomeReader, dir: string, signal = new AbortController().signal) =>
  reader.sync({ agentPrincipal: AGENT, home: dir, signal })

describe('which cloud-home paths a takeover may read', () => {
  it('allows memories, USER.md and skills, nothing else', () => {
    for (const allowed of [
      'memories/MEMORY.md',
      'memories/USER.md',
      'USER.md',
      'skills/notes/SKILL.md',
      'skills/a/scripts/run.py'
    ]) {
      expect(cloudHomePathAllowed(allowed), allowed).toBe(true)
    }

    for (const refused of [
      'SOUL.md',
      'config.yaml',
      '.env',
      'auth.json',
      'state.db',
      'plugins/x/__init__.py',
      'cron/jobs.json',
      'memories',
      'memories/',
      '../memories/MEMORY.md',
      'memories/../config.yaml',
      '/memories/MEMORY.md',
      'memories//MEMORY.md',
      'memories/.hidden',
      'skills/.hub/x',
      'memories\\MEMORY.md',
      'memories/a\0b',
      `skills/${'x'.repeat(600)}`,
      '',
      42
    ]) {
      expect(cloudHomePathAllowed(refused), String(refused)).toBe(false)
    }
  })
})

describe('Hermes bookkeeping inside the allowed trees', () => {
  it('is recognised by a dot-prefixed segment, and only inside memories, skills and USER.md', () => {
    for (const hidden of [
      'skills/.usage.json',
      'skills/.bundled_manifest',
      'skills/.hub/lock.json',
      'skills/notes/.cache/x',
      'memories/.hidden'
    ]) {
      expect(cloudHomePathHidden(hidden), hidden).toBe(true)
      // Still never a path a takeover reads or writes.
      expect(cloudHomePathAllowed(hidden), hidden).toBe(false)
    }

    for (const other of [
      'skills/notes/SKILL.md',
      'memories/MEMORY.md',
      'USER.md',
      // Outside the trees, or an escape: still a refusal, not bookkeeping.
      '.env',
      '.hermes/skills/x',
      'config.yaml',
      'skills/.',
      'skills/..',
      'skills/../config.yaml',
      'memories/../.env',
      'skills//.usage.json',
      '/skills/.usage.json',
      'skills\\.usage.json',
      'skills',
      'skills/',
      '',
      42
    ]) {
      expect(cloudHomePathHidden(other), String(other)).toBe(false)
    }
  })
})

describe('when a takeover reads the cloud home at all', () => {
  const MAC = 'mac:00000000-0000-4000-8000-b454f82c5857'

  const view = (order: string[], disabled: string[], source: 'saved' | 'default' = 'saved') =>
    ({
      policy: {
        profile: 'atum.execution-policy/1',
        agentPrincipal: AGENT,
        revision: source === 'saved' ? 2 : 0,
        source,
        order,
        disabled
      },
      stale: false
    }) as unknown as Parameters<typeof cloudHomeReadApplies>[0]

  it('only for a saved policy that has the cloud on: the cloud is then the writer of the memory', () => {
    expect(cloudHomeReadApplies(view(['cloud', MAC], []))).toBe(true)
    expect(cloudHomeReadApplies(view([MAC, 'cloud'], [MAC]))).toBe(true)
    // Local/cloud placement follows the saved execution policy and current lease.
    expect(cloudHomeReadApplies(view([MAC, 'cloud'], ['cloud']))).toBe(false)
    expect(cloudHomeReadApplies(view(['cloud'], [], 'default'))).toBe(false)
    expect(cloudHomeReadApplies(undefined)).toBe(false)
  })
})

describe('the committed cloud home manifest', () => {
  const { manifest } = cloud({ 'memories/MEMORY.md': 'a' })

  it('is accepted only exactly as the contract states it', () => {
    expect(parseCloudHomeManifest(manifest, AGENT)?.generation).toBe(7)
    expect(parseCloudHomeManifest(manifest, '00000000-0000-4000-8000-b454f82c5857')).toBeNull()
    expect(parseCloudHomeManifest({ ...manifest, extra: 1 }, AGENT)).toBeNull()
    expect(parseCloudHomeManifest({ ...manifest, profile: 'other/1' }, AGENT)).toBeNull()
    expect(parseCloudHomeManifest({ ...manifest, generation: 0 }, AGENT)).toBeNull()
    expect(
      parseCloudHomeManifest({ ...manifest, files: [{ path: 'config.yaml', size: 1, sha256: 'a'.repeat(64) }] }, AGENT)
    ).toBeNull()
    expect(
      parseCloudHomeManifest({ ...manifest, files: [{ path: 'memories/x', size: 1, sha256: 'nope' }] }, AGENT)
    ).toBeNull()
    expect(parseCloudHomeManifest({ ...manifest, files: [manifest.files[0], manifest.files[0]] }, AGENT)).toBeNull()
    expect(
      parseCloudHomeManifest(
        { ...manifest, files: [{ path: 'memories/big', size: 9 * 1024 * 1024, sha256: 'a'.repeat(64) }] },
        AGENT
      )
    ).toBeNull()
  })
})

describe('a manifest that lists Hermes bookkeeping', () => {
  const entry = (file: string, text = 'x') => ({ path: file, size: Buffer.byteLength(text), sha256: sha(text) })
  const { manifest } = cloud({ 'memories/MEMORY.md': 'a' })

  it('is still usable: dot-prefixed entries are skipped and counted, never part of what is taken', () => {
    const parsed = parseCloudHomeManifest(
      {
        ...manifest,
        files: [
          entry('memories/MEMORY.md', 'a'),
          entry('skills/.usage.json'),
          entry('skills/.bundled_manifest'),
          entry('skills/notes/SKILL.md'),
          entry('skills/.hub/lock.json')
        ]
      },
      AGENT
    )

    expect(parsed?.files.map(file => file.path)).toEqual(['memories/MEMORY.md', 'skills/notes/SKILL.md'])
    expect(parsed?.skipped).toBe(3)
    expect(parseCloudHomeManifest(manifest, AGENT)?.skipped).toBe(0)
  })

  it('does not count a skipped file against what this Mac takes, but is not trusted for its shape', () => {
    const big = { path: 'skills/.usage.json', size: 100 * 1024 * 1024, sha256: 'a'.repeat(64) }

    expect(
      parseCloudHomeManifest({ ...manifest, files: [entry('memories/MEMORY.md', 'a'), big] }, AGENT)?.skipped
    ).toBe(1)
    expect(
      parseCloudHomeManifest({ ...manifest, files: [{ path: 'skills/.usage.json', size: 1, sha256: 'nope' }] }, AGENT)
    ).toBeNull()
    expect(
      parseCloudHomeManifest({ ...manifest, files: [entry('skills/.usage.json'), entry('skills/.usage.json')] }, AGENT)
    ).toBeNull()
    expect(
      parseCloudHomeManifest({ ...manifest, files: [{ ...entry('skills/.usage.json'), extra: 1 }] }, AGENT)
    ).toBeNull()
  })

  it('still refuses a manifest that names anything outside the allowlist or tries to leave it', () => {
    for (const refused of [
      '.env',
      'config.yaml',
      'skills/../config.yaml',
      'memories/../.env',
      'skills/..',
      '.hermes/x'
    ]) {
      expect(
        parseCloudHomeManifest({ ...manifest, files: [entry('skills/.usage.json'), entry(refused)] }, AGENT),
        refused
      ).toBeNull()
    }
  })
})

describe('reading the latest committed cloud home onto a Mac that takes over', () => {
  it('replaces the stale local memory and adds new skills, and keeps what the cloud does not mention', async () => {
    const dir = home()
    mkdirSync(path.join(dir, 'memories'), { recursive: true })
    mkdirSync(path.join(dir, 'skills', 'local-only'), { recursive: true })
    writeFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'from 10-01')
    writeFileSync(path.join(dir, 'skills', 'local-only', 'SKILL.md'), 'mine')
    writeFileSync(path.join(dir, 'config.yaml'), 'model: x')

    const { request } = cloud({
      'memories/MEMORY.md': 'from today',
      'memories/USER.md': 'Raymond likes short answers',
      'skills/notes/SKILL.md': 'take notes'
    })

    const result = await sync(readerFor({ request }), dir)

    expect(result).toEqual({
      state: 'fresh',
      generation: 7,
      committedAt: 1_791_877_000_000,
      files: 3,
      changed: 3,
      skipped: 0,
      kept: ['memories/MEMORY.md']
    })
    expect(readFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'utf8')).toBe('from today')
    expect(readFileSync(path.join(dir, 'memories', 'USER.md'), 'utf8')).toBe('Raymond likes short answers')
    expect(readFileSync(path.join(dir, 'skills', 'notes', 'SKILL.md'), 'utf8')).toBe('take notes')
    // Read-only means one way: nothing the cloud does not name is deleted or touched.
    expect(readFileSync(path.join(dir, 'skills', 'local-only', 'SKILL.md'), 'utf8')).toBe('mine')
    expect(readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toBe('model: x')
    expect(readdirSync(path.join(dir, 'memories')).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('skips Hermes bookkeeping in a real skills tree: never asked for, never written, never touched, counted', async () => {
    const dir = home()
    mkdirSync(path.join(dir, 'skills', '.hub'), { recursive: true })
    writeFileSync(path.join(dir, 'skills', '.usage.json'), '{"mine":true}')
    writeFileSync(path.join(dir, 'skills', '.hub', 'lock.json'), 'mine')

    const { request } = cloud({
      'memories/MEMORY.md': 'from today',
      'skills/.usage.json': '{"cloud":true}',
      'skills/.bundled_manifest': 'notes:abc',
      'skills/.hub/lock.json': 'cloud',
      'skills/notes/SKILL.md': 'take notes'
    })

    expect(await sync(readerFor({ request }), dir)).toEqual({
      state: 'fresh',
      generation: 7,
      committedAt: 1_791_877_000_000,
      files: 2,
      changed: 2,
      skipped: 3,
      kept: []
    })
    expect(
      request.mock.calls
        .filter(([, action]) => action.kind === 'file')
        .map(([, action]) => (action as { path: string }).path)
        .sort()
    ).toEqual(['memories/MEMORY.md', 'skills/notes/SKILL.md'])
    expect(readFileSync(path.join(dir, 'skills', 'notes', 'SKILL.md'), 'utf8')).toBe('take notes')
    // This Mac's own bookkeeping is exactly as it was, and none of the cloud's arrived.
    expect(readFileSync(path.join(dir, 'skills', '.usage.json'), 'utf8')).toBe('{"mine":true}')
    expect(readFileSync(path.join(dir, 'skills', '.hub', 'lock.json'), 'utf8')).toBe('mine')
    expect(existsSync(path.join(dir, 'skills', '.bundled_manifest'))).toBe(false)
  })

  it('downloads only what differs, and a second read of the same generation changes nothing', async () => {
    const dir = home()
    const { request } = cloud({ 'memories/MEMORY.md': 'same', 'memories/USER.md': 'new' })
    mkdirSync(path.join(dir, 'memories'))
    writeFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'same')
    const reader = readerFor({ request })

    expect(await sync(reader, dir)).toMatchObject({ state: 'fresh', files: 2, changed: 1 })
    expect(
      request.mock.calls
        .filter(([, action]) => action.kind === 'file')
        .map(([, action]) => (action as { path: string }).path)
    ).toEqual(['memories/USER.md'])
    expect(await sync(reader, dir)).toMatchObject({ state: 'fresh', files: 2, changed: 0 })
  })

  describe('a Mac that learned something while it answered', () => {
    const modes = (target: string) => statSync(target).mode & 0o777

    /** Every folder and file under a root, relative, sorted. */
    function tree(root: string, current = root): string[] {
      return readdirSync(current, { withFileTypes: true })
        .flatMap(entry => {
          const full = path.join(current, entry.name)

          return entry.isDirectory() ? [full, ...tree(root, full)] : [full]
        })
        .sort()
    }

    function failedOverMac(local = 'the cloud knew this\nand the Mac learned that for hours') {
      const dir = home()
      mkdirSync(path.join(dir, 'memories'), { recursive: true })
      writeFileSync(path.join(dir, 'memories', 'MEMORY.md'), local)
      writeFileSync(path.join(dir, 'memories', 'USER.md'), 'same on both')

      return dir
    }

    it('saves its own differing memory before the cloud copy replaces it, and keeps the cloud copy authoritative', async () => {
      const dir = failedOverMac()
      const backups = backupsFolder()
      const { request } = cloud({ 'memories/MEMORY.md': 'the cloud knew this', 'memories/USER.md': 'same on both' })

      const result = await sync(readerFor({ request, backups }), dir)

      // No merge: the cloud copy wins on disk ...
      expect(readFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'utf8')).toBe('the cloud knew this')
      // ... but what the Mac learned is kept, under the agent and the generation it was replaced for.
      const kept = path.join(backups, AGENT, '7', 'memories', 'MEMORY.md')
      expect(readFileSync(kept, 'utf8')).toBe('the cloud knew this\nand the Mac learned that for hours')
      expect(result).toMatchObject({ state: 'fresh', changed: 1, kept: ['memories/MEMORY.md'] })
      // A file that already matched the cloud is neither replaced nor copied.
      expect(existsSync(path.join(backups, AGENT, '7', 'memories', 'USER.md'))).toBe(false)
    })

    it('keeps the copies private: owner-only folders and files', async () => {
      const dir = failedOverMac()
      const backups = backupsFolder()
      const { request } = cloud({ 'memories/MEMORY.md': 'the cloud knew this', 'memories/USER.md': 'same on both' })
      const previous = process.umask(0o022)

      try {
        await sync(readerFor({ request, backups }), dir)
      } finally {
        process.umask(previous)
      }

      const entries = tree(backups)
      expect(entries.length).toBeGreaterThanOrEqual(4)

      for (const entry of entries) {
        expect(modes(entry) & 0o077, entry).toBe(0)
      }

      expect(modes(path.join(backups, AGENT, '7', 'memories', 'MEMORY.md'))).toBe(0o600)
    })

    it('copies nothing for a file the Mac does not have or already matches', async () => {
      const dir = home()
      mkdirSync(path.join(dir, 'memories'))
      writeFileSync(path.join(dir, 'memories', 'USER.md'), 'same')
      const backups = backupsFolder()
      const { request } = cloud({ 'memories/MEMORY.md': 'new to this Mac', 'memories/USER.md': 'same' })

      expect(await sync(readerFor({ request, backups }), dir)).toMatchObject({ state: 'fresh', changed: 1, kept: [] })
      expect(existsSync(backups)).toBe(false)
    })

    it('replaces nothing it could not save first', async () => {
      const dir = failedOverMac()
      const root = home()
      // A file where the backups folder should be: nothing can be saved under it.
      writeFileSync(path.join(root, 'blocked'), '')
      const { request } = cloud({ 'memories/MEMORY.md': 'the cloud knew this', 'memories/USER.md': 'same on both' })

      const result = await sync(readerFor({ request, backups: path.join(root, 'blocked', 'cloud-home-backups') }), dir)

      expect(result).toEqual({ state: 'unavailable' })
      expect(readFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'utf8')).toBe(
        'the cloud knew this\nand the Mac learned that for hours'
      )
    })

    it('keeps every version of a file it had to save twice for one generation, and never overwrites a copy', async () => {
      const dir = failedOverMac('first version')
      const backups = backupsFolder()
      const { request } = cloud({ 'memories/MEMORY.md': 'the cloud knew this', 'memories/USER.md': 'same on both' })

      await sync(readerFor({ request, backups }), dir)
      // The Mac wrote more before the same generation was read again (a retry, or a second takeover).
      writeFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'second version')
      await sync(readerFor({ request, backups }), dir)
      // The same content again is not copied a third time.
      writeFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'second version')
      await sync(readerFor({ request, backups }), dir)

      const folder = path.join(backups, AGENT, '7', 'memories')

      const contents = readdirSync(folder)
        .map(name => readFileSync(path.join(folder, name), 'utf8'))
        .sort()

      expect(contents).toEqual(['first version', 'second version'])
      expect(readFileSync(path.join(folder, 'MEMORY.md'), 'utf8')).toBe('first version')
    })

    it("stages the files it writes as owner-only, like the rest of the agent's home", async () => {
      const dir = home()
      const { request } = cloud({ 'memories/MEMORY.md': 'from today', 'skills/notes/SKILL.md': 'take notes' })
      const previous = process.umask(0o022)

      try {
        await sync(readerFor({ request }), dir)
      } finally {
        process.umask(previous)
      }

      for (const file of ['memories/MEMORY.md', 'skills/notes/SKILL.md']) {
        expect(modes(path.join(dir, ...file.split('/'))) & 0o077, file).toBe(0)
      }
    })

    it('says so in the window only when a local file was actually replaced, and never confuses it with missing memory', () => {
      const fresh = { state: 'fresh', generation: 7, committedAt: 1, files: 2, changed: 1, skipped: 0 } as const

      expect(cloudHomeMemoryNote({ ...fresh, kept: ['memories/MEMORY.md'] })).toBe('local_saved')
      expect(cloudHomeMemoryNote({ ...fresh, kept: [] })).toBeUndefined()
      expect(cloudHomeMemoryNote({ state: 'none' })).toBeUndefined()
      expect(cloudHomeMemoryNote(undefined)).toBeUndefined()
      expect(cloudHomeMemoryNote({ state: 'unsupported' })).toBe('without_recent')
      expect(cloudHomeMemoryNote({ state: 'unavailable' })).toBe('without_recent')
    })

    it('needs an absolute backups folder', () => {
      expect(() => readerFor({ request: cloud({}).request, backups: 'relative/backups' })).toThrow(
        'matrix_cloud_home_invalid'
      )
    })
  })

  it('says unsupported, once and cheaply, while the platform has no owner route for the cloud home', async () => {
    const request = vi.fn(async (): Promise<CloudHomeResponse> => ({ status: 404, value: null }))
    let now = 1_000
    const reader = readerFor({ request, now: () => now, unsupportedForMs: 60_000 })
    const dir = home()

    expect(await sync(reader, dir)).toEqual({ state: 'unsupported' })
    expect(await sync(reader, dir)).toEqual({ state: 'unsupported' })
    expect(request).toHaveBeenCalledTimes(1)

    // The platform ships the route: the next takeover after the window finds it, with no restart.
    now += 61_000
    request.mockImplementation(async () => ({ status: 204, value: null }))
    expect(await sync(reader, dir)).toEqual({ state: 'none' })
    expect(request).toHaveBeenCalledTimes(2)

    for (const status of [405, 501]) {
      now += 61_000
      request.mockImplementation(async () => ({ status, value: null }))
      expect(await sync(reader, dir)).toEqual({ state: 'unsupported' })
    }
  })

  it('changes nothing when any file is wrong, missing, too large or fails to arrive', async () => {
    const dir = home()
    mkdirSync(path.join(dir, 'memories'))
    writeFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'old')
    const files = { 'memories/MEMORY.md': 'new', 'memories/USER.md': 'user' }

    const corrupt = cloud(files)
    corrupt.request.mockImplementation(async (_agent, action) => {
      if (action.kind === 'manifest') {
        return { status: 200, value: corrupt.manifest }
      }

      const text = action.path === 'memories/USER.md' ? 'tampered' : files[action.path as keyof typeof files]

      return {
        status: 200,
        value: {
          generation: action.generation,
          path: action.path,
          sha256: sha(files[action.path as keyof typeof files]),
          content: Buffer.from(text).toString('base64')
        }
      }
    })
    expect(await sync(readerFor({ request: corrupt.request }), dir)).toEqual({ state: 'unavailable' })

    const gone = cloud(files)
    gone.request.mockImplementation(async (_agent, action) =>
      action.kind === 'manifest'
        ? { status: 200, value: gone.manifest }
        : { status: 503, value: { error: 'matrix_503' } }
    )
    expect(await sync(readerFor({ request: gone.request }), dir)).toEqual({ state: 'unavailable' })

    const throws = cloud(files)
    throws.request.mockImplementation(async (_agent, action) => {
      if (action.kind === 'manifest') {
        return { status: 200, value: throws.manifest }
      }

      throw new Error('network')
    })
    expect(await sync(readerFor({ request: throws.request }), dir)).toEqual({ state: 'unavailable' })

    const malformed = cloud(files)
    malformed.request.mockImplementation(async () => ({ status: 200, value: { ...malformed.manifest, files: 'x' } }))
    expect(await sync(readerFor({ request: malformed.request }), dir)).toEqual({ state: 'unavailable' })

    // The stale file the failed reads would have replaced is exactly as it was.
    expect(readFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'utf8')).toBe('old')
    expect(existsSync(path.join(dir, 'memories', 'USER.md'))).toBe(false)
  })

  it('stops at the deadline without writing anything', async () => {
    const dir = home()
    const abort = new AbortController()
    const files = { 'memories/MEMORY.md': 'new' }
    const { manifest } = cloud(files)

    const request = vi.fn(async (_agent: string, action: CloudHomeAction): Promise<CloudHomeResponse> => {
      if (action.kind === 'manifest') {
        return { status: 200, value: manifest }
      }

      abort.abort()

      return {
        status: 200,
        value: { generation: 7, path: action.path, sha256: sha('new'), content: Buffer.from('new').toString('base64') }
      }
    })

    expect(await sync(readerFor({ request }), dir, abort.signal)).toEqual({ state: 'unavailable' })
    expect(existsSync(path.join(dir, 'memories', 'MEMORY.md'))).toBe(false)
  })

  it('never writes through a symlink that leaves the home', async () => {
    const dir = home()
    const outside = home()
    symlinkSync(outside, path.join(dir, 'memories'))
    const { request } = cloud({ 'memories/MEMORY.md': 'x' })

    expect(await sync(readerFor({ request }), dir)).toEqual({ state: 'unavailable' })
    expect(readdirSync(outside)).toEqual([])
  })

  it('lets an authentication refusal reach the account refresh path', async () => {
    const request = vi.fn(async () => {
      throw new Error('matrix_s1_authentication')
    })

    await expect(sync(readerFor({ request }), home())).rejects.toThrow('matrix_s1_authentication')
  })
})

describe('the cloud home transport', () => {
  it('uses only the fixed owner routes and the main-owned bearer, and keeps the path out of the URL', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: 2 }), { status: 200, headers: { 'content-type': 'application/json' } })
      )

    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    const resource = 'https://shell.test/api/matrix/v1'

    await requestCloudHome(resource, 'owner-token', AGENT, { kind: 'manifest' }, signal)
    await requestCloudHome(
      resource,
      'owner-token',
      AGENT,
      { kind: 'file', generation: 7, path: 'memories/MEMORY.md' },
      signal
    )

    expect(fetchMock.mock.calls[0]![0]).toBe(`${resource}/agents/${AGENT}/cloud-home`)
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error'
    })
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer owner-token')
    expect(fetchMock.mock.calls[1]![0]).toBe(`${resource}/agents/${AGENT}/cloud-home/file`)
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ generation: 7, path: 'memories/MEMORY.md' })
    })
    await expect(requestCloudHome(resource, 'owner-token', 'not-a-uuid', { kind: 'manifest' }, signal)).rejects.toThrow(
      'matrix_cloud_home_invalid'
    )
  })

  it('reads a missing route (a framework page, not JSON) as the capability check failing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } })
        )
    )

    await expect(
      requestCloudHome(
        'https://shell.test/api/matrix/v1',
        't',
        AGENT,
        { kind: 'manifest' },
        new AbortController().signal
      )
    ).resolves.toEqual({ status: 404, value: null })
  })

  it('surfaces only an explicit 401 for the account refresh path', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })))

    await expect(
      requestCloudHome(
        'https://shell.test/api/matrix/v1',
        't',
        AGENT,
        { kind: 'manifest' },
        new AbortController().signal
      )
    ).rejects.toThrow('matrix_s1_authentication')
  })
})
