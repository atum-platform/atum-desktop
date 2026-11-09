/**
 * Test support only: a whole simulated Mac around the agent-home controller.
 *
 * `FakeHomeTool` writes and reads the same plaintext archive the Python tool does (one JSON header line with the
 * 2.1 manifest, then each entry's bytes), over real temp folders, and the contract's own parsers read what it
 * wrote, so the flows are exercised end to end on real files. Its mapping is the small one the flows need
 * (memories, skills, the persona and the routine definitions); the real Python tool's grammar, skip list and race
 * handling are tested in `tests/hermes_cli/test_atum_home_portable.py`, and `real-tool.integration.test.ts` runs
 * the two together.
 *
 * `FakeRuntime` keeps the promises `HomeRuntimeOps` documents: a drain stops admission and waits for the turn in
 * flight, a stand-down gives up the lease, an activation starts the agent with a fresh session and competes for
 * the lease, and what the agent says goes out through the same publication guard the app installs.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { canonicalJson } from '../device/canonical'

import { ArchiveCustody } from './archive-custody'
import { openFile } from './archive-seal'
import { DirectoryArchiveStore, type HomeArchiveStore, type HomeSealKeySource, ShellArchiveStore, ShellSealKeySource } from './archive-store'
import {
  type CheckpointSkippedPath,
  classifyPortablePath,
  PORTABLE_CONTENT_POLICY,
  PORTABLE_ENCRYPTION,
  type PortableCategory,
  portableManifestDigest
} from './contract'
import { AgentHomeController, type ControllerOptions } from './controller'
import type { LeaseFacts } from './fence'
import {
  type HomeTool,
  HomeToolError,
  type PortableCaptureSummary,
  type PortableRestoreSummary,
  type PortableSnapshotSummary,
  readArchiveHeader
} from './home-tool'
import type { TestMac } from './mac.fixture'
import type { DrainResult, HomeRuntimeOps } from './runtime-ops'
import { guardAgentPublication } from './standing'
import { scratchDirectory, type World } from './world.fixture'

const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

/**
 * The Shell store and key source of a simulated Mac, wired as the app wires them (`app.ts`): every call signed with the
 * Mac's own key for the home it is, or the move it is the target of, against the fake Shell and the fake object store,
 * with the world's clock for time and for waiting (a wait moves the clock on; nobody really waits). With `overHttp` (the
 * origin of a served Shell) the store talks to real sockets with Node's own fetch instead of to the fakes in memory.
 */
export function shellArchive(
  world: World,
  mac: TestMac,
  options: {
    leaseFacts?: () => LeaseFacts | null
    uuid?: () => string
    tus?: { retryDelaysMs?: readonly number[]; requestTimeoutMs?: number }
    overHttp?: string
    /** Who this Mac believes the signed-in owner is (their platform principal); by default the one the fake Shell derives keys for. */
    ownerPrincipal?: (signal: AbortSignal) => Promise<string | null>
  } = {}
) {
  const request = <T>(send: (token: string, resource: string) => Promise<T>) =>
    send(world.stub.token, `${options.overHttp ?? 'https://shell.test'}/api/matrix/v1`)

  const custody = new ArchiveCustody({
    platform: mac.platform,
    auth: mac.auth,
    me: () => mac.deviceServiceId,
    leaseFacts:
      options.leaseFacts ??
      (() => {
        const lease = world.stub.lease(world.agent)

        return lease && lease.executorDevice === mac.deviceServiceId && lease.expiresAt > world.clock.now()
          ? { leaseId: lease.leaseId, leaseExpiresAtPlatform: lease.expiresAt, executorTerm: lease.term }
          : null
      }),
    ...(options.uuid ? { uuid: options.uuid } : {})
  })

  const shell = {
    request,
    signer: custody,
    ...(options.overHttp ? {} : { fetch: world.stub.fetch }),
    ownerPrincipal: options.ownerPrincipal ?? (async () => world.stub.ownerPrincipal),
    now: world.clock.now,
    sleep: async (ms: number) => {
      world.clock.advance(ms)
    },
    ...(options.tus ? { tus: options.tus } : {})
  }

  return { store: new ShellArchiveStore(shell), keys: new ShellSealKeySource(shell), custody, request }
}

// -------------------------------------------------------------------------------------------- the tool

interface Candidate {
  category: PortableCategory
  path: string
  data: Buffer
}

function walk(root: string, prefix: string, category: PortableCategory, out: Candidate[]): void {
  if (!existsSync(root)) {
    return
  }

  for (const name of readdirSync(root).sort()) {
    const full = path.join(root, name)

    if (statSync(full).isDirectory()) {
      walk(full, `${prefix}/${name}`, category, out)
    } else if (!/\.(lock|tmp|pid)$/u.test(name)) {
      out.push({ category, path: `${prefix}/${name}`, data: readFileSync(full) })
    }
  }
}

/**
 * The Python tool's cheap fingerprint, in the same terms: the paths, sizes and modification times of the files a
 * capture would carry (memories, skills, the persona, the routine definitions), with no content read.
 */
function fingerprintOf(home: string): { fingerprintSha256: string; files: number } {
  const rows: Array<[string, number, number]> = []

  const collect = (root: string, prefix: string, category: PortableCategory) => {
    if (!existsSync(root)) {
      return
    }

    for (const name of readdirSync(root).sort()) {
      const full = path.join(root, name)
      const stat = statSync(full)

      if (stat.isDirectory()) {
        collect(full, `${prefix}/${name}`, category)
      } else if (!/\.(lock|tmp|pid)$/u.test(name) && classifyPortablePath(category, `${prefix}/${name}`).outcome === 'included') {
        rows.push([`${prefix}/${name}`, stat.size, stat.mtimeMs])
      }
    }
  }

  collect(path.join(home, 'memories'), 'memory', 'memory')
  collect(path.join(home, 'skills'), 'skills', 'skills')

  for (const [file, category, portable] of [
    ['SOUL.md', 'non_secret_config', 'config/SOUL.md'],
    ['cron/jobs.json', 'routine_definitions', 'routines/jobs.json']
  ] as const) {
    const full = path.join(home, file)

    if (existsSync(full) && classifyPortablePath(category, portable).outcome === 'included') {
      const stat = statSync(full)
      rows.push([portable, stat.size, stat.mtimeMs])
    }
  }

  rows.sort((left, right) => (left[0] < right[0] ? -1 : 1))

  return { fingerprintSha256: sha256(rows.map(row => row.join('\0')).join('\n')), files: rows.length }
}

/** Where a portable path lives in a Hermes home (the inverse of what `capture` reads). */
function homePathFor(portable: string): string | null {
  if (portable === 'config/SOUL.md') {return 'SOUL.md'}

  if (portable === 'routines/jobs.json') {return 'cron/jobs.json'}

  if (portable.startsWith('memory/')) {return `memories/${portable.slice('memory/'.length)}`}

  if (portable.startsWith('skills/')) {return portable}

  return null
}

/** The files a capture of a Hermes home would consider, as the tool's walk finds them (before the grammar decides what is carried). */
function carriedCandidates(home: string): Candidate[] {
  const candidates: Candidate[] = []
  walk(path.join(home, 'memories'), 'memory', 'memory', candidates)
  walk(path.join(home, 'skills'), 'skills', 'skills', candidates)

  for (const [file, category, portable] of [
    ['SOUL.md', 'non_secret_config', 'config/SOUL.md'],
    ['cron/jobs.json', 'routine_definitions', 'routines/jobs.json']
  ] as const) {
    const full = path.join(home, file)

    if (existsSync(full)) {
      candidates.push({ category, path: portable, data: readFileSync(full) })
    }
  }

  return candidates
}

/** What the grammar carries of those candidates, and what it skips (by category and reason, with a digest of the paths, never the names). */
function carriedOf(candidates: Candidate[]): { files: Candidate[]; skipped: CheckpointSkippedPath[] } {
  const files: Candidate[] = []
  const skips = new Map<string, string[]>()

  for (const candidate of candidates) {
    const decision = classifyPortablePath(candidate.category, candidate.path)

    if (decision.outcome === 'included') {
      files.push(candidate)
    } else {
      const key = `${candidate.category}|${decision.reasonCode}`
      skips.set(key, [...(skips.get(key) ?? []), candidate.path])
    }
  }

  const skipped: CheckpointSkippedPath[] = [...skips.entries()].map(([key, paths]) => {
    const [category, reasonCode] = key.split('|') as [PortableCategory, CheckpointSkippedPath['reasonCode']]

    return { category, reasonCode, count: paths.length, pathSha256: sha256([...paths].sort().join('\n')) }
  })

  return { files, skipped }
}

/** What `snapshot` leaves in its folder and `capture` reads back: the carried files as they were while the writers were held. */
interface StagedSnapshot {
  walked: string
  files: Array<{ category: PortableCategory; path: string; data: string }>
  skipped: CheckpointSkippedPath[]
}

export class FakeHomeTool implements HomeTool {
  captures: Array<{ home: string; generation: number; fromSnapshot: boolean }> = []
  snapshots: Array<{ home: string; dest: string }> = []
  restores: Array<{ home: string; verifyOnly: boolean }> = []
  exports: Array<{ home: string; out: string }> = []
  failCapture: string | null = null
  failRestore: string | null = null
  /** The snapshot fails this way before it asks for the writers (a tool that is not there, a runtime that predates it). */
  failSnapshot: string | null = null
  /** The fingerprint question fails this way (a runtime that predates it, or is not there). */
  failFingerprint: string | null = null
  fingerprints: string[] = []
  /** Runs while the capture is reading the home: a test writes to it here. */
  midCapture?: (home: string) => void
  /** Runs inside the window of a snapshot, with the writers held: a test writes here to model a writer the barrier cannot see. */
  midSnapshot?: (home: string) => void

  async fingerprint(input: { home: string }): Promise<{ fingerprintSha256: string; files: number }> {
    if (this.failFingerprint) {
      throw new HomeToolError(this.failFingerprint)
    }

    this.fingerprints.push(input.home)

    return fingerprintOf(input.home)
  }

  /**
   * As the real tool does it: the walk before the writers are held, then the hold, then the files as they are (the clone), then a
   * second look at the home, and the writers are let go the moment the window is over, before the record is written.
   */
  async snapshot(input: Parameters<HomeTool['snapshot']>[0]): Promise<PortableSnapshotSummary> {
    if (this.failSnapshot) {
      throw new HomeToolError(this.failSnapshot)
    }

    this.snapshots.push({ home: input.home, dest: input.dest })
    mkdirSync(input.dest, { mode: 0o700 })

    try {
      const walked = fingerprintOf(input.home).fingerprintSha256
      const release = await input.hold()

      if (!release) {
        throw new HomeToolError('home_writers_busy')
      }

      let staged: StagedSnapshot

      try {
        this.midSnapshot?.(input.home)
        const { files, skipped } = carriedOf(carriedCandidates(input.home))

        if (fingerprintOf(input.home).fingerprintSha256 !== walked) {
          throw new HomeToolError('home_changed_during_snapshot')
        }

        staged = { walked, files: files.map(file => ({ category: file.category, path: file.path, data: file.data.toString('base64') })), skipped }
      } finally {
        release()
      }

      writeFileSync(path.join(input.dest, 'snapshot.json'), JSON.stringify(staged), { mode: 0o600 })

      return {
        fingerprintSha256: walked,
        files: staged.files.length,
        bytes: staged.files.reduce((total, file) => total + Buffer.from(file.data, 'base64').length, 0),
        method: 'apfs_clone',
        sqliteDatabases: 0,
        heldMs: 0,
        attempts: 1
      }
    } catch (error) {
      rmSync(input.dest, { recursive: true, force: true })

      throw error
    }
  }

  async capture(input: Parameters<HomeTool['capture']>[0]): Promise<PortableCaptureSummary> {
    if (this.failCapture) {
      throw new HomeToolError(this.failCapture)
    }

    this.captures.push({ home: input.home, generation: input.generation, fromSnapshot: input.snapshot !== undefined })

    let walked: string
    let carried: { files: Candidate[]; skipped: CheckpointSkippedPath[] }

    if (input.snapshot) {
      // Nothing live is read: the walk, the skipped rows and every byte come from the folder the snapshot staged.
      const staged = JSON.parse(readFileSync(path.join(input.snapshot, 'snapshot.json'), 'utf8')) as StagedSnapshot
      walked = staged.walked
      carried = {
        files: staged.files.map(file => ({ category: file.category, path: file.path, data: Buffer.from(file.data, 'base64') })),
        skipped: staged.skipped
      }
      this.midCapture?.(input.home)
    } else {
      // As the real tool does: the home as the walk finds it, before any file is read.
      walked = fingerprintOf(input.home).fingerprintSha256
      const candidates = carriedCandidates(input.home)
      this.midCapture?.(input.home)
      carried = carriedOf(candidates)
    }

    const { files, skipped } = carried

    files.push({
      category: 'non_secret_config',
      path: 'config/atum-home.json',
      data: Buffer.from(JSON.stringify({ v: 1, profile: 'atum.agent-home/2.1', sourceHomeDirs: [input.home], hermesVersion: 'test' }))
    })
    files.sort((left, right) => (left.path < right.path ? -1 : 1))

    const entries = files.map(file => ({
      category: file.category,
      path: file.path,
      sha256: sha256(file.data),
      bytes: file.data.length,
      stable: true as const,
      fileType: 'regular_file' as const,
      symlinkTraversal: 'none' as const
    }))

    const unsigned = {
      homeId: input.homeId,
      generation: input.generation,
      parentGeneration: input.parentGeneration,
      producingHomeEpoch: input.homeEpoch,
      entries,
      encryption: PORTABLE_ENCRYPTION,
      contentPolicy: PORTABLE_CONTENT_POLICY
    }

    const manifestSha256 = portableManifestDigest(unsigned as never)
    const stagedBy = input.snapshot ? 'snapshot_apfs_clone' : 'stable_read'

    const header = {
      v: 2,
      profile: 'atum.agent-home/2.1',
      manifest: { ...unsigned, manifestSha256 },
      capture: {
        capturedAt: Date.now(),
        includedFiles: entries.length,
        skipped,
        consistency: { writersQuiesced: true, sqliteMethod: 'sqlite_backup', stableFilesStaged: true },
        // How the consistency above was obtained, as the real tool records it.
        writers: input.snapshot ? 'barrier' : 'stopped',
        stagedBy,
        hermesVersion: 'test'
      }
    }

    const archive = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), ...files.map(file => file.data)])
    writeFileSync(input.out, archive, { mode: 0o600, flag: 'wx' })

    return {
      manifestSha256,
      contentSha256: sha256(canonicalJson(entries)),
      fingerprintSha256: walked,
      stagedBy,
      includedFiles: entries.length,
      bytes: files.reduce((total, file) => total + file.data.length, 0),
      archiveSha256: sha256(archive),
      archiveBytes: archive.length,
      skippedRows: skipped.length,
      skippedPaths: skipped.reduce((total, row) => total + row.count, 0)
    }
  }

  async exportAll(input: { home: string; out: string }): Promise<{ files: number; bytes: number }> {
    this.exports.push(input)
    const all: Record<string, string> = {}

    const collect = (dir: string, prefix: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)

        if (statSync(full).isDirectory()) {
          collect(full, `${prefix}${name}/`)
        } else {
          all[`${prefix}${name}`] = readFileSync(full).toString('base64')
        }
      }
    }

    collect(input.home, '')
    writeFileSync(input.out, JSON.stringify({ v: 1, files: all }), { mode: 0o600, flag: 'wx' })

    return { files: Object.keys(all).length, bytes: Object.values(all).reduce((total, text) => total + text.length, 0) }
  }

  async restore(input: Parameters<HomeTool['restore']>[0]): Promise<PortableRestoreSummary> {
    this.restores.push({ home: input.home, verifyOnly: Boolean(input.verifyOnly) })

    if (this.failRestore) {
      throw new HomeToolError(this.failRestore)
    }

    const header = await readArchiveHeader(input.archive)
    const raw = readFileSync(input.archive)
    let offset = raw.indexOf(0x0a) + 1
    const staged: Array<{ path: string; data: Buffer }> = []

    for (const entry of header.manifest.entries) {
      const data = raw.subarray(offset, offset + entry.bytes)
      offset += entry.bytes

      if (data.length !== entry.bytes || sha256(data) !== entry.sha256) {
        throw new HomeToolError('home_file_digest_mismatch')
      }

      staged.push({ path: entry.path, data })
    }

    if (offset !== raw.length) {
      throw new HomeToolError('home_archive_trailing')
    }

    if (
      (input.expectManifestSha256 && header.manifest.manifestSha256 !== input.expectManifestSha256) ||
      (input.expectHomeId && header.manifest.homeId !== input.expectHomeId)
    ) {
      throw new HomeToolError('home_manifest_mismatch')
    }

    const summary: PortableRestoreSummary = {
      homeId: header.manifest.homeId,
      generation: header.manifest.generation,
      manifestSha256: header.manifest.manifestSha256,
      written: 0,
      unchanged: 0,
      removed: 0,
      backedUp: 0,
      rebound: 0
    }

    if (input.verifyOnly) {
      return summary
    }

    const backup = (relative: string, data: Buffer) => {
      const target = path.join(input.backups, String(header.manifest.generation), relative)
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(target, data, { mode: 0o600 })
      summary.backedUp += 1
    }

    const wanted = new Set<string>()

    for (const file of staged) {
      const relative = homePathFor(file.path)

      if (!relative) {
        continue
      }

      wanted.add(relative)
      const target = path.join(input.home, relative)

      if (existsSync(target)) {
        const current = readFileSync(target)

        if (current.equals(file.data)) {
          summary.unchanged += 1

          continue
        }

        backup(relative, current)
      }

      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(target, file.data, { mode: 0o600 })
      summary.written += 1
    }

    const stale: Candidate[] = []
    walk(path.join(input.home, 'memories'), 'memories', 'memory', stale)

    for (const file of stale) {
      if (!wanted.has(file.path)) {
        backup(file.path, file.data)
        rmSync(path.join(input.home, file.path), { force: true })
        summary.removed += 1
      }
    }

    return summary
  }
}

// ------------------------------------------------------------------------------------------ the runtime

class FakeQueue {
  readonly sent: Array<{ kind: string; body?: string }> = []

  command = async (value: unknown): Promise<unknown> => {
    this.sent.push(value as { kind: string; body?: string })

    return { ok: true }
  }
}

export class FakeRuntime implements HomeRuntimeOps {
  readonly calls: string[] = []
  readonly queue = new FakeQueue()
  admitting = true
  running = true
  /** The agent has asked for the answering lease (it is activated, or already the home). */
  wantsLease = false
  /** A turn in flight: resolve it to let a drain finish. */
  turn: { finish(): void; done: Promise<void> } | null = null
  drainTimesOut = false
  holds = 0
  freshSessions = 0
  intake = true
  private guarded: FakeQueue | undefined

  constructor(
    private readonly world: World,
    private readonly mac: TestMac,
    readonly homeDir: string
  ) {}

  async materialize(): Promise<string> {
    this.calls.push('materialize')
    return this.homeDir
  }

  /** Wire the publication guard the app installs on an agent host's queue. */
  guard(standing: AgentHomeController['standing']): void {
    this.guarded = guardAgentPublication(this.queue, { agent: () => this.world.agent, standing }) as FakeQueue
  }

  startTurn(): void {
    let finish!: () => void

    const done = new Promise<void>(resolve => {
      finish = resolve
    })

    this.turn = { finish, done }
  }

  /** What the agent says in a room, through the guard. */
  async say(body: string): Promise<'sent' | 'refused'> {
    try {
      await (this.guarded ?? this.queue).command({ kind: 'publishResult', body })

      return 'sent'
    } catch {
      return 'refused'
    }
  }

  private tryAcquire(): void {
    const lease = this.world.stub.lease(this.world.agent)

    if (this.wantsLease && (!lease || lease.expiresAt <= this.world.clock.now())) {
      this.world.stub.grantLease(this.world.agent, this.mac.deviceServiceId)
    }
  }

  home(): string {
    return this.homeDir
  }

  leaseFacts() {
    this.tryAcquire()
    const lease = this.world.stub.lease(this.world.agent)

    return lease && lease.executorDevice === this.mac.deviceServiceId && lease.expiresAt > this.world.clock.now()
      ? { leaseId: lease.leaseId, leaseExpiresAtPlatform: lease.expiresAt, executorTerm: lease.term }
      : null
  }

  async drain(_agent: string, _budgetMs: number): Promise<DrainResult> {
    this.calls.push('drain')
    this.admitting = false

    if (this.turn) {
      if (this.drainTimesOut) {
        return 'timed_out'
      }

      await this.turn.done
      this.turn = null
    }

    return 'quiesced'
  }

  async quiesce(): Promise<() => Promise<void>> {
    this.calls.push('quiesce')
    this.holds += 1

    return async () => {
      this.holds -= 1
      this.calls.push('release')
    }
  }

  /** The agent is between turns and its review is over. A query: it is not a call the agent's runtime is asked to make. */
  restless = false
  atRestAsked = 0

  async atRest(): Promise<boolean> {
    this.atRestAsked += 1

    return !this.restless
  }

  /** The barrier a snapshot is staged under: what was asked of it, in order (`hold`, `busy`, `release`). */
  readonly barrier: string[] = []
  /** The writers are held right now. */
  held = false
  private waiting: Array<() => void> = []

  /**
   * Hold the writers still, as the app's turn lock does: refused while a turn is in flight or the agent is not at rest, and
   * while held a turn that asks to begin (`admit`) waits for the hold to end instead of beginning. Nothing is stopped.
   */
  async holdWrites(): Promise<(() => void) | null> {
    if (this.held || this.turn || this.restless) {
      this.barrier.push('busy')

      return null
    }

    this.held = true
    this.barrier.push('hold')
    let released = false

    return () => {
      if (released) {
        return
      }

      released = true
      this.held = false
      this.barrier.push('release')

      for (const begin of this.waiting.splice(0)) {
        begin()
      }
    }
  }

  /** A turn asks to begin: at once, or when the writers are let go if they are held right now. */
  admit(begin: () => void): void {
    if (this.held) {
      this.waiting.push(begin)
    } else {
      begin()
    }
  }

  async resume(): Promise<void> {
    this.calls.push('resume')
    this.admitting = true
  }

  async standDown(): Promise<void> {
    this.calls.push('standDown')
    this.admitting = false
    this.running = false
    this.wantsLease = false
    const lease = this.world.stub.lease(this.world.agent)

    if (lease?.executorDevice === this.mac.deviceServiceId) {
      this.world.stub.releaseLease(this.world.agent)
    }
  }

  async activate(): Promise<void> {
    this.calls.push('activate')
    this.running = true
    this.admitting = true
    this.freshSessions += 1
    this.wantsLease = true
    this.tryAcquire()
  }

  readiness() {
    return { homeAccessible: existsSync(this.homeDir), runtimeUsable: this.running, matrixIntakeWorking: this.intake }
  }

  power() {
    return 'awake' as const
  }
}

// ------------------------------------------------------------------------------------------- the node

export class Crash extends Error {
  constructor(readonly at: string) {
    super(`crash at ${at}`)
  }
}

export interface Node {
  name: string
  mac: TestMac
  root: string
  home: string
  runtime: FakeRuntime
  tool: FakeHomeTool
  controller: AgentHomeController
  logs: string[]
  steps: string[]
  /** Throw from the named step (a crash). Cleared when it fires. */
  crashAt: string | null
  /** What a wait does for this node (the clock moves on by default); a test sets it to watch the waits or to act during them. */
  controllerSleep: ((ms: number) => Promise<void>) | null
  /** A new controller on the same journal, folders, tool and runtime: the app was quit and opened again. */
  restart(): void
}

export function createNode(
  world: World,
  mac: TestMac,
  options: {
    files?: Record<string, string>
    store?: 'shell' | 'directory'
    budgets?: ControllerOptions['budgets']
    sharedArchives?: string
    /** The real Python tool instead of the fake one (`node.tool` is then unused). */
    tool?: HomeTool
    /** How a flow waits (a commit that meets a publication in flight): by default the world's clock moves on, nobody really waits. */
    sleep?: ControllerOptions['sleep']
  } = {}
): Node {
  const root = scratchDirectory(`atum-home-${mac.name.replace(/\W+/gu, '-')}-`)
  const home = path.join(root, 'hermes-home')
  mkdirSync(home, { recursive: true })

  for (const [relative, content] of Object.entries(options.files ?? {})) {
    mkdirSync(path.dirname(path.join(home, relative)), { recursive: true })
    writeFileSync(path.join(home, relative), content)
  }

  const runtime = new FakeRuntime(world, mac, home)
  const tool = new FakeHomeTool()
  const logs: string[] = []
  const steps: string[] = []

  const shell = shellArchive(world, mac, { leaseFacts: () => runtime.leaseFacts() })

  const store: HomeArchiveStore =
    options.store === 'directory' ? new DirectoryArchiveStore(options.sharedArchives ?? path.join(root, 'archives')) : shell.store

  const keys: HomeSealKeySource = shell.keys

  const node: Node = {
    name: mac.name,
    mac,
    root,
    home,
    runtime,
    tool,
    logs,
    steps,
    crashAt: null,
    controllerSleep: null,
    controller: undefined as unknown as AgentHomeController,
    restart: () => {
      node.controller = build()
    }
  }

  const build = (): AgentHomeController => {
    const controller = new AgentHomeController({
      platform: mac.platform,
      auth: mac.auth,
      tool: options.tool ?? tool,
      store,
      keys,
      journalStore: mac.store,
      runtime,
      me: () => mac.deviceServiceId,
      dirs: { work: path.join(root, 'work'), backups: path.join(root, 'backups'), quarantine: path.join(root, 'quarantine') },
      budgets: { drainMs: 1_000, targetWaitMs: 15 * 60_000, attempts: 3, ...options.budgets },
      now: world.clock.now,
      sleep:
        options.sleep ??
        (async ms => {
          if (node.controllerSleep) {
            await node.controllerSleep(ms)
          } else {
            world.clock.advance(ms)
          }
        }),
      log: line => logs.push(line),
      step: name => {
        steps.push(name)

        if (node.crashAt === name) {
          node.crashAt = null

          throw new Crash(name)
        }
      }
    })

    runtime.guard(controller.standing)

    return controller
  }

  node.controller = build()

  return node
}

export const pass = (node: Node, agent: string) => node.controller.reconcile(agent, new AbortController().signal)

/**
 * A generation the platform holds, opened as the home's other Mac would open it: the key from the Shell, the home and
 * generation bound in. Returns the archive's header and each entry's bytes by its portable path.
 */
export async function storedGeneration(world: World, node: Node, generation: number) {
  const homeId = world.stub.placement(world.agent).homeId
  const key = await shellArchive(world, world.a).keys.key({ agent: world.agent, homeId }, new AbortController().signal)

  if (!key.ok) {
    throw new Error('no key')
  }

  const sealedPath = path.join(node.root, `stored-${generation}.sealed`)
  const plainPath = path.join(node.root, `stored-${generation}.plain`)
  writeFileSync(sealedPath, world.stub.archives.get(`${homeId}:${generation}`)!)
  await openFile({ sealed: sealedPath, plain: plainPath, key: key.value, homeId, generation })

  const header = await readArchiveHeader(plainPath)
  const raw = readFileSync(plainPath)
  let offset = raw.indexOf(0x0a) + 1
  const bodies = new Map<string, Buffer>()

  for (const entry of header.manifest.entries) {
    bodies.set(entry.path, raw.subarray(offset, offset + entry.bytes))
    offset += entry.bytes
  }

  const first = JSON.parse(raw.subarray(0, raw.indexOf(0x0a)).toString('utf8')) as { capture?: Record<string, unknown> }

  return { header, bodies, capture: first.capture ?? {} }
}
