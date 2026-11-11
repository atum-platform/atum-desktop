import { execFile } from 'node:child_process'
import { type BigIntStats, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import semver from 'semver'

import { cleanStaleStages, retireBackup } from './cleanup'
import {
  ATUM_BUNDLE_ID,
  blockingProcesses,
  ineligible,
  isNotarizedAssessment,
  isPinnedTeam,
  parseProcesses,
  PINNED_REQUIREMENT,
  type ProcessRow,
  safeArchivePaths,
  sameSigningTeam,
  type Snapshot,
  snapshotMatches,
  STAGED_PARENTS,
  type StageState,
  swapSync,
  transition,
  undoSwapSync
} from './state'
import { appendProgress, clearMarkers, isStockOnly, removeJournal, stageRoot, writeJournal } from './store'
import { spawnWaiter, type WaiterOptions } from './waiter'

export { stageRoot } from './store'

const execute = promisify(execFile)

export interface RunResult {
  stdout: string
  stderr: string
}

export type Run = (executable: string, args: string[]) => Promise<RunResult>

/** Everything runs at background priority; the person is still using the Mac. */
export const runAtBackgroundPriority: Run = (executable, args) =>
  execute('/usr/sbin/taskpolicy', ['-b', executable, ...args], { timeout: 15 * 60_000, maxBuffer: 4 * 1024 ** 2 })

/** The system calls the staged swap makes, so tests can run the real code against disposable bundles. */
export interface StageTools {
  run: Run
  processes: () => Promise<ProcessRow[]>
  spawnWaiter: (options: WaiterOptions) => Promise<{ kill(): void }>
  gktoolPresent: () => Promise<boolean>
  macMajor: () => number
  /** The click-time stat-walk of the staged bundle (a test can make it slow). */
  seal: (bundle: string) => Promise<Snapshot>
}

const realTools = (run: Run): StageTools => ({
  run,
  processes: async () => parseProcesses((await run('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,comm='])).stdout),
  spawnWaiter,
  seal: snapshot,
  gktoolPresent: () => fs.access('/usr/bin/gktool').then(() => true, () => false),
  macMajor: () => {
    const darwin = Number(os.release().split('.')[0])

    return darwin >= 20 ? darwin - 9 : 0
  }
})

/** One seal entry per path. lstat never follows links. A regular file with a second hard link is refused:
 * the other name could be written from outside the bundle after the swap. */
function sealEntry(stat: BigIntStats, link: string): string {
  const fields: Array<bigint | string> = [stat.dev, stat.ino, stat.ctimeNs, stat.size, stat.mode, stat.uid, stat.gid]

  if (stat.isFile()) {
    if (stat.nlink > 1n) {throw new Error('Staged hard link')}
    fields.push(stat.nlink)
  }

  return [...fields, link].join(':')
}

const insideBundle = (destination: string, root: string) => destination === root || destination.startsWith(`${root}${path.sep}`)

/** Stat seal of a whole bundle: dev, inode, ctime, size, mode, owner and link target of every entry. */
export async function snapshot(bundle: string): Promise<Snapshot> {
  const entries: Snapshot = Object.create(null)
  const root = await fs.realpath(bundle)

  async function visit(relative: string): Promise<void> {
    const file = path.join(bundle, relative)
    const stat = await fs.lstat(file, { bigint: true })
    let link = ''

    if (stat.isSymbolicLink()) {
      link = await fs.readlink(file)

      if (!insideBundle(await fs.realpath(file), root)) {throw new Error('Staged symlink escapes bundle')}
    }

    entries[relative] = sealEntry(stat, link)

    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) {await visit(path.join(relative, name))}
    }
  }

  await visit('')

  return entries
}

/** The same seal, synchronously: the post-swap check must not yield to the event loop. */
export function snapshotSync(bundle: string): Snapshot {
  const entries: Snapshot = Object.create(null)
  const root = realpathSync(bundle)

  function visit(relative: string): void {
    const file = path.join(bundle, relative)
    const stat = lstatSync(file, { bigint: true })
    let link = ''

    if (stat.isSymbolicLink()) {
      link = readlinkSync(file)

      if (!insideBundle(realpathSync(file), root)) {throw new Error('Staged symlink escapes bundle')}
    }

    entries[relative] = sealEntry(stat, link)

    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) {visit(path.join(relative, name))}
    }
  }

  visit('')

  return entries
}

export interface StagedSwapOptions {
  home: string
  id: string
  target: string
  version: string
  handoffDirectory: string
  /** The default-on `updates.stagedSwap` switch, read at download time and again at Restart. */
  enabled: () => boolean
  log: (line: string) => void
  tools?: Partial<StageTools>
  /** Longest wait for the old bundle's processes. The updater's 10 s exit backstop is the outer limit. */
  processWaitMs?: number
}

export interface InstallMode {
  /** Restart reopens the app; an ordinary Quit swaps and leaves it closed. */
  relaunch: boolean
}

export class StagedSwap {
  /** True once the launcher exists: it will reopen the target (or the backup) whatever happens next. */
  waiterRunning = false
  readonly root: string
  private state: StageState = 'download'
  private bundle: string | null = null
  private seal: Snapshot | null = null
  private stagedVersion = ''
  private recheck: Promise<boolean> | null = null
  private readonly tools: StageTools

  constructor(private readonly options: StagedSwapOptions) {
    this.root = stageRoot(options.home, options.id)
    this.tools = { ...realTools(options.tools?.run ?? runAtBackgroundPriority), ...options.tools }
  }

  get ready(): boolean {
    return this.bundle !== null && this.state === 'ready'
  }

  private move(state: StageState | 'failure') {
    this.state = transition(this.state, state)
    const line = `[updates] stage state=${this.state}`

    this.options.log(line)
    appendProgress(this.root, line)
  }

  private async timed<T>(phase: string, run: () => Promise<T>): Promise<T> {
    const start = performance.now()

    try {return await run()} finally {this.options.log(`[updates] stage phase=${phase} ms=${Math.round(performance.now() - start)}`)}
  }

  private async metadata(bundle: string): Promise<Record<string, unknown>> {
    const plist = path.join(bundle, 'Contents', 'Info.plist')

    return JSON.parse((await this.tools.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])).stdout)
  }

  /** Sweep, then decide whether staging is allowed at all. Throws a reason; the caller falls back to stock. */
  private async assertEligible(zip: string, version: string): Promise<{ uid: number; gid: number }> {
    const target = this.options.target
    const parent = path.dirname(target)

    if (!STAGED_PARENTS(this.options.home).includes(parent)) {throw new Error('Unsupported staged target parent')}

    if (!semver.valid(version) || !semver.gt(version, this.options.version)) {throw new Error('Staged version must increase')}

    const [old, parentStat, cache, archive] = await Promise.all([fs.stat(target), fs.stat(parent), fs.stat(this.root), fs.stat(zip)])
    const disk = await fs.statfs(this.root)
    const size = Number((await this.tools.run('/usr/bin/du', ['-sk', target])).stdout.trim().split(/\s/u)[0]) * 1024

    const reason = ineligible({
      enabled: this.options.enabled() && !isStockOnly(this.root, version),
      macMajor: this.tools.macMajor(),
      gktool: await this.tools.gktoolPresent(),
      translocated: target.includes('/AppTranslocation/') || await fs.realpath(target) !== target,
      writable: await fs.access(parent, fs.constants.W_OK).then(() => true, () => false) &&
        await fs.access(target, fs.constants.W_OK).then(() => true, () => false),
      sameVolume: parentStat.dev === cache.dev,
      freeBytes: Number(disk.bavail) * Number(disk.bsize),
      bundleBytes: size,
      zipBytes: archive.size
    })

    if (reason) {throw new Error(`Staged swap ineligible: ${reason}`)}

    return { uid: old.uid, gid: old.gid }
  }

  async prepare(zip: string, version: string): Promise<void> {
    this.state = 'download'
    this.bundle = null
    this.seal = null
    this.recheck = null
    this.stagedVersion = version
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })

    // First, unconditionally: the 1.5 GB copy is what a low-disk Mac cannot afford to keep.
    await cleanStaleStages({ home: this.options.home, id: this.options.id }).catch(() => [])

    // A rollback copy that proved itself is retired now; a failed delete is retried and never blocks for good.
    await retireBackup({
      home: this.options.home, id: this.options.id, bundle: this.options.target,
      handoffDirectory: this.options.handoffDirectory, log: this.options.log
    }).catch(() => false)

    if (await fs.lstat(path.join(this.root, 'previous.app')).then(() => true, () => false)) {
      throw new Error('Rollback copy still retained')
    }

    const owner = await this.assertEligible(zip, version)
    // Unique extraction directory, never merge an archive into an earlier app tree.
    const directory = await fs.mkdtemp(path.join(this.root, 'update-'))

    try {
      const bundle = await this.unpack(zip, directory)

      this.move('stage')
      await this.timed('normalize', () => this.normalize(bundle, owner))
      // Prewarm first: anything it legitimately touches is part of the baseline, not a difference.
      await this.timed('prewarm', () => this.tools.run('/usr/bin/gktool', ['scan', bundle]))

      // The seal is taken before any verification and must still match after it, so the bytes that were
      // verified are the bytes that get installed.
      const sealed = await this.timed('snapshot', () => snapshot(bundle))

      this.move('verify')
      await this.timed('verify', () => this.verify(bundle, version))

      if (!snapshotMatches(sealed, await snapshot(bundle))) {throw new Error('Staged bundle changed during verification')}
      this.seal = sealed
      this.bundle = bundle
      this.move('ready')
    } catch (error) {
      this.move('failure')
      await fs.rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  private async unpack(zip: string, directory: string): Promise<string> {
    return this.timed('unpack', async () => {
      const listing = await this.tools.run('/usr/bin/unzip', ['-Z', '-1', zip])

      if (!safeArchivePaths(listing.stdout)) {throw new Error('Unsafe archive paths')}
      await this.tools.run('/usr/bin/ditto', ['-x', '-k', zip, directory])
      const apps = (await fs.readdir(directory)).filter(name => name.endsWith('.app'))

      if (apps.length !== 1) {throw new Error('Archive must contain exactly one app')}
      const bundle = path.join(directory, apps[0])

      if ((await fs.lstat(bundle)).isSymbolicLink() || await fs.realpath(bundle) !== bundle) {throw new Error('Invalid staged root')}

      return bundle
    })
  }

  /** Permissions, ownership, time and quarantine, before the seal. The trust checks come after. */
  private async normalize(bundle: string, owner: { uid: number; gid: number }): Promise<void> {
    await fs.chmod(bundle, 0o755)
    const touched = new Date()

    await fs.utimes(bundle, touched, touched)
    await fs.chown(bundle, owner.uid, owner.gid)
    const attrs = await this.tools.run('/usr/bin/xattr', ['-r', bundle])

    if (attrs.stdout.includes('com.apple.quarantine')) {await this.tools.run('/usr/bin/xattr', ['-r', '-d', 'com.apple.quarantine', bundle])}
  }

  private async verify(bundle: string, version: string): Promise<void> {
    const target = this.options.target
    const run = this.tools.run

    const [currentSignature, newSignature, requirement, current, next] = await Promise.all([
      run('/usr/bin/codesign', ['-dv', '--verbose=4', target]),
      run('/usr/bin/codesign', ['-dv', '--verbose=4', bundle]),
      run('/usr/bin/codesign', ['-d', '-r-', target]),
      this.metadata(target),
      this.metadata(bundle)
    ])

    const designated = /^designated => (.+)$/mu.exec(requirement.stdout + requirement.stderr)?.[1]

    const identified = next.CFBundleIdentifier === ATUM_BUNDLE_ID && next.CFBundleIdentifier === current.CFBundleIdentifier &&
      next.CFBundleIdentifier === this.options.id

    const integrity = next.ElectronAsarIntegrity

    if (!designated || !identified || next.CFBundleShortVersionString !== version ||
      !isPinnedTeam(newSignature.stderr) || !sameSigningTeam(currentSignature.stderr, newSignature.stderr) ||
      !integrity || typeof integrity !== 'object' || !Object.keys(integrity).length ||
      !/flags=.*\bruntime\b/u.test(newSignature.stderr)) {
      throw new Error('Staged app identity or hardened runtime mismatch')
    }

    // Both the installed app's own requirement and the pinned team and identifier must hold.
    await run('/usr/bin/codesign', [
      '--verify', '--deep', '--strict', '--all-architectures', `-R=(${designated}) and (${PINNED_REQUIREMENT})`, bundle
    ])

    // Notarization without Xcode or Command Line Tools: spctl reads the stapled ticket offline.
    const assessment = await run('/usr/sbin/spctl', ['-a', '-vv', '-t', 'exec', bundle])

    if (!isNotarizedAssessment(`${assessment.stdout}\n${assessment.stderr}`)) {throw new Error('Staged app is not notarized')}
  }

  /** Remove the prepared copy (a tamper or a switch-off). Never touches a rollback copy. */
  async abandon(): Promise<void> {
    if (!this.bundle) {return}
    const directory = path.dirname(this.bundle)

    this.bundle = null
    this.seal = null

    if (path.dirname(directory) === this.root) {await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)}
  }

  /** Start the stat-walk at the click so it overlaps the teardown instead of following it. */
  beginRestart(): void {
    if (this.bundle && this.seal && !this.recheck) {
      this.recheck = this.timed('recheck', async () => snapshotMatches(this.seal!, await this.tools.seal(this.bundle!))).catch(() => false)
    }
  }

  /** Wait for the old bundle's own runtime children, ignoring Electron's helpers (they die with the main process). */
  async waitForBundleProcesses(): Promise<void> {
    const started = Date.now()
    const limit = this.options.processWaitMs ?? 5000

    while (true) {
      const live = blockingProcesses(await this.tools.processes(), this.options.target, process.pid)

      if (!live.length) {return}

      if (Date.now() - started > limit) {throw new Error(`Old bundle processes still running: ${live.map(row => row.command).join(', ')}`)}
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  /**
   * Main-process authority only; call after teardown. On success the swap is done and the caller exits at once.
   * On a thrown AggregateError the old bundle was not put back and the launcher restores it from the backup.
   * On any other throw the installed bundle is intact.
   */
  async install(mode: InstallMode): Promise<void> {
    // The re-check starts at the click and overlaps the teardown. It is awaited only after the launcher exists.
    this.beginRestart()

    if (!this.bundle || !this.seal || !this.recheck) {throw new Error('Staged tamper snapshot changed')}

    const { target, handoffDirectory, version } = this.options
    const bundle = this.bundle
    const backup = path.join(this.root, 'previous.app')

    // The updater's 10 s exit backstop is already armed. From here on, any exit is safe: stale markers must not
    // satisfy the launcher; then the journal, written atomically; then the launcher itself, before any slow wait,
    // so Restart can never close Atum with nothing left to reopen it (re-review F2).
    try {
      clearMarkers(handoffDirectory)
      writeJournal(this.root, {
        v: 2, target, backup, next: bundle, fromVersion: version, toVersion: this.stagedVersion, relaunch: mode.relaunch
      })
      await this.tools.spawnWaiter({
        parentPid: process.pid, target, backup, relaunch: mode.relaunch,
        startedMarker: path.join(handoffDirectory, 'started'), shownMarker: path.join(handoffDirectory, 'shown')
      })
      this.waiterRunning = true

      // The installed app is still untouched; if this fails the launcher simply reopens it.
      if (!await this.recheck) {throw new Error('Staged tamper snapshot changed')}
      await this.waitForBundleProcesses()
    } catch (error) {
      this.dropJournal()
      throw error
    }

    // Nothing may run between the two renames, nor between them and the exit: no await from here to return.
    this.move('swap')

    try {
      swapSync(target, bundle, backup)
    } catch (error) {
      if (!(error instanceof AggregateError)) {this.dropJournal()}
      throw error
    }

    // The staged tree was only ever checked in a user-writable folder. Now that it sits in the target, where
    // other teams' code cannot write, confirm nothing moved. The root's ctime is the rename itself.
    let intact = false

    try {intact = snapshotMatches(this.seal, snapshotSync(target), [''])} catch {intact = false}

    if (!intact) {
      undoSwapSync(target, bundle, backup)
      this.dropJournal()
      throw new Error('Staged tamper snapshot changed after swap')
    }

    this.move('relaunch')
  }

  private dropJournal(): void {
    try {removeJournal(this.root)} catch { /* A stale journal is harmless: launch recovery drops it. */ }
  }
}
