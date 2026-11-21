import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { WebContents } from 'electron'
import semver from 'semver'

import type { WorkIncarnation, WorkStartOptions } from '../sidecar/process'

import { readJson, writeFileDurably } from './files'
import type { WorkSessionPaths } from './paths'
import { redactPairingSecrets, WorkSessionError } from './redact'
import type { ResetCoordinator } from './reset'

/**
 * Main-owned update driver: plan §8.4's "G5b".
 *
 * T3's own launcher cannot be adopted for Work. It goes from its restore
 * straight to starting the child with no hook for a reset (S0-5 G2), and it
 * runs a `serve` child that prints the pairing token four times and a QR code
 * into a log main does not control (S0-5 C1). So main implements that same
 * contract and nothing else: stop, snapshot, trial, commit, or restore.
 *
 * Whatever happens, no credential issued before the update is honoured after
 * it: the home is reset BEFORE the snapshot (so the snapshot holds revoked
 * rows and a restore cannot revive an earlier session), and again after any
 * restore, before either version serves.
 */

/** A verified, packaged runtime directory. Its `work-runtime/t3` is the pinned server. */
export interface PinRef {
  version: string
  resources: string
  /** sha256 of `work-runtime/t3`, from the build's manifest. */
  sha256?: string
}

/** T3's trial context (S0-5 §3.6, `T3_SERVICE_LAUNCHER_CONTEXT`, protocol 4). */
export interface TrialContext {
  protocol: 4
  childVersion: string
  update: { id: string; fromVersion: string; targetVersion: string; dbPath: string; status: 'pending' }
}

/** Present when lane S's supervisor relays T3's launcher IPC (`prepared`, then `committed`). */
export interface TrialHandle {
  prepared: Promise<void>
  commit(): Promise<void>
}

export type UpdateIncarnation = WorkIncarnation

/**
 * One pin's host. `WorkHost` satisfies it. Without `trial` on the incarnation the
 * driver runs in "main-gated" mode: the new pin starts like any start, no view
 * is paired and the gate stays closed until main records the commit.
 */
export interface PinHost {
  current(): WorkIncarnation | undefined
  start(options: WorkStartOptions): Promise<UpdateIncarnation>
  stop(): Promise<void>
  bindOwnerView(incarnation: WorkIncarnation, contents: WebContents): () => void
}

export interface UpdateState {
  version: 1
  /** The committed pin: a downgrade below it is refused. */
  pin: string
  committed: string[]
}

export type UpdateOutcome =
  | { outcome: 'committed'; pin: PinRef; host: PinHost; incarnation: UpdateIncarnation }
  | { outcome: 'rolled_back'; reason: string; host: PinHost; incarnation?: UpdateIncarnation }
  | { outcome: 'refused'; reason: 'downgrade' | 'not_newer' | 'insufficient_space' | 'pin_unverified' | 'stops_owed' | 'in_progress' }

export type Refusal = Extract<UpdateOutcome, { outcome: 'refused' }>

export interface UpdateDeps {
  paths: WorkSessionPaths
  coordinator: ResetCoordinator
  /** The pin that is committed and running or last ran. */
  currentPin(): PinRef
  hostFor(pin: PinRef): PinHost
  /** Stop whatever is running now (the live pin's host), awaiting teardown. */
  stopRunning(): Promise<void>
  /** Gate's "stops owed": an update does not start while any is open. */
  stopsOwed(): boolean
  freeBytes?(path: string): number
  verifyPin?(pin: PinRef): Promise<void>
  /** Event codes only. Never a URL, token or output. */
  log?(event: string): void
  /** How long main takes to answer `committed` before T3's child exits (30 s upstream). */
  commitWithinMs?: number
  prepareWithinMs?: number
}

const SQLITE_FILES = ['statev2.sqlite', 'statev2.sqlite-wal', 'statev2.sqlite-shm'] as const
const SPACE_MARGIN = 256 * 1024 * 1024

interface Manifest {
  id: string
  from: string
  to: string
  files: { name: string; sha256: string; size: number }[]
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export async function verifyPinDigest(pin: PinRef): Promise<void> {
  const executable = join(pin.resources, 'work-runtime', 't3')

  if (!pin.sha256 || !existsSync(executable) || sha256File(executable) !== pin.sha256) {
    throw new WorkSessionError('work_pin_unverified')
  }
}

export class UpdateDriver {
  private running = false

  constructor(private readonly deps: UpdateDeps) {}

  readState(): UpdateState | undefined {
    const raw = readJson(this.deps.paths.updateState) as Partial<UpdateState> | undefined

    return raw && raw.version === 1 && typeof raw.pin === 'string' && Array.isArray(raw.committed)
      ? (raw as UpdateState)
      : undefined
  }

  /** Record the pin that is running today, so a later downgrade can be refused. */
  adopt(pin: PinRef): void {
    if (!this.readState()) {
      this.writeState({ version: 1, pin: pin.version, committed: [] })
    }
  }

  /**
   * Every refusal that can be known BEFORE anything stops: an update already running, a downgrade, the same version, a stop
   * owed (read from the durable stop ledger by the caller's `stopsOwed`), a pin that fails its digest, too little disk. Nothing
   * is touched by it, so a caller can answer a refusal without closing a view or restarting the server.
   */
  preflight(target: PinRef): Promise<Refusal | undefined> {
    return this.running ? Promise.resolve({ outcome: 'refused', reason: 'in_progress' }) : this.checks(target)
  }

  private async checks(target: PinRef): Promise<Refusal | undefined> {
    const { deps } = this
    const current = deps.currentPin()
    // The pin running today is the baseline a later downgrade is refused against.
    const committedPin = this.readState()?.pin ?? current.version

    if (semver.lt(target.version, committedPin)) {
      return { outcome: 'refused', reason: 'downgrade' }
    }

    if (!semver.gt(target.version, committedPin)) {
      return { outcome: 'refused', reason: 'not_newer' }
    }

    if (deps.stopsOwed()) {
      return { outcome: 'refused', reason: 'stops_owed' }
    }

    try {
      await (deps.verifyPin ?? verifyPinDigest)(target)
    } catch {
      return { outcome: 'refused', reason: 'pin_unverified' }
    }

    if (!this.enoughSpace()) {
      return { outcome: 'refused', reason: 'insufficient_space' }
    }

    return undefined
  }

  async update(target: PinRef): Promise<UpdateOutcome> {
    const { deps } = this

    // Taken before the first await: a second call during the checks is refused as in progress.
    if (this.running) {
      return { outcome: 'refused', reason: 'in_progress' }
    }

    this.running = true

    try {
      // The pin running today is the baseline a later downgrade is refused against, even when this call is refused.
      this.adopt(deps.currentPin())
      const refusal = await this.checks(target)

      if (refusal) {
        return refusal
      }

      const running = deps.currentPin()
      // The committed runtime and the binary this build ships are different things on an installed upgrade: durable state names
      // the older committed version, `currentPin()` already returns the newly shipped binary. Only when they are the same version
      // is the previous binary available to start again.
      const committed = this.readState()?.pin ?? running.version
      const previous = running.version === committed ? running : undefined

      return await deps.coordinator.exclusive(() => this.run({ fromVersion: committed, previous }, target))
    } finally {
      this.running = false
    }
  }

  /**
   * Finish an update that a crash interrupted, BEFORE any start. After it the
   * marker is at `none` (reset only), or `done` (restore finished): the caller's
   * `coordinator.reconcile()` then runs the reset and clears the marker.
   * Returns what it found.
   */
  recover(): Promise<'clean' | 'reset_only' | 'restored' | 'committed'> {
    return this.deps.coordinator.exclusive(async () => {
      const marker = this.deps.coordinator.markers.read()

      if (!marker) {
        rmSync(this.deps.paths.snapshot, { recursive: true, force: true })

        return 'clean'
      }

      if (marker.restore === 'none' || marker.restore === 'done') {
        // The snapshot was never completed, or the restore already finished.
        rmSync(this.deps.paths.snapshot, { recursive: true, force: true })

        return 'reset_only'
      }

      if (marker.snapshotId && this.readState()?.committed.includes(marker.snapshotId)) {
        // Crashed after the commit was recorded, before the marker was cleared.
        // The reset still runs (one re-pair); nothing is restored.
        this.deps.coordinator.markers.advance('done')
        rmSync(this.deps.paths.snapshot, { recursive: true, force: true })

        return 'committed'
      }

      this.deps.coordinator.markers.advance('started')
      this.restoreSnapshot(marker.snapshotId)
      this.deps.coordinator.markers.advance('done')
      // The restore is complete and recorded: the snapshot holds plain-text rows and is no longer needed.
      rmSync(this.deps.paths.snapshot, { recursive: true, force: true })

      return 'restored'
    })
  }

  private async run(current: { fromVersion: string; previous: PinRef | undefined }, target: PinRef): Promise<UpdateOutcome> {
    const { deps } = this
    const { coordinator, paths } = deps
    const log = (event: string) => deps.log?.(redactPairingSecrets(event))

    // 1. Quiesce, then reset BEFORE the snapshot and before any update exists.
    await deps.stopRunning()
    coordinator.markers.begin('update', 'none')
    await coordinator.resetHome()
    log('update_reset_before_snapshot')

    // 2. Snapshot the stopped home. The manifest is written last; the marker
    //    moves to `pending` only once the snapshot is durable.
    const snapshotId = randomUUID()
    this.takeSnapshot(snapshotId, current.fromVersion, target.version)
    coordinator.markers.advance('pending', snapshotId)
    log('update_snapshot_taken')

    // 3. Trial. Nothing is paired, no view is handed a grant, and the gate stays
    //    closed (the caller holds `updateInProgress`) until commit.
    const host = deps.hostFor(target)
    let incarnation: UpdateIncarnation | undefined

    try {
      incarnation = await host.start({
        continuation: false,
        resources: target.resources,
        trial: {
          protocol: 4,
          childVersion: target.version,
          update: {
            id: snapshotId,
            fromVersion: current.fromVersion,
            targetVersion: target.version,
            dbPath: paths.database,
            status: 'pending'
          }
        }
      })

      if (incarnation.trial) {
        const { trial } = incarnation
        await withDeadline(trial.prepared, deps.prepareWithinMs ?? 20_000)
        log('update_trial_prepared')
        await withDeadline(trial.commit(), deps.commitWithinMs ?? 25_000)
      }
    } catch (error) {
      log('update_trial_failed')

      return this.rollback(host, current.previous, redactPairingSecrets(error instanceof Error ? error.message : 'trial_failed'))
    }

    // 4. Commit. The record that makes a downgrade impossible is written
    //    before the marker is cleared, so a crash between them is a commit.
    const state = this.readState()
    this.writeState({ version: 1, pin: target.version, committed: [...(state?.committed ?? []), snapshotId] })
    coordinator.markers.clear()
    rmSync(paths.snapshot, { recursive: true, force: true })
    log('update_committed')

    return { outcome: 'committed', pin: target, host, incarnation }
  }

  /**
   * Restore, reset, and start the previous pin when this build still has it. The trial server is stopped first (awaited), the
   * snapshot is repeated from the top if this is itself interrupted, and the reset runs on the stopped, restored home.
   *
   * With no previous binary (an installed upgrade replaced it), nothing is started: the restored home stays stopped and the
   * next start tries the update again. Starting the failed new binary here would run the very migration that just failed on the
   * restored database, in the window before the caller could stop it.
   */
  private async rollback(failed: PinHost, previous: PinRef | undefined, reason: string): Promise<UpdateOutcome> {
    const { deps } = this
    const { coordinator } = deps
    const marker = coordinator.markers.read()

    await failed.stop().catch(() => undefined)
    coordinator.markers.advance('started')
    this.restoreSnapshot(marker?.snapshotId)
    coordinator.markers.advance('done')
    rmSync(deps.paths.snapshot, { recursive: true, force: true })
    await coordinator.finish()
    deps.log?.('update_rolled_back')

    if (!previous) {
      return { outcome: 'rolled_back', reason, host: failed }
    }

    const host = deps.hostFor(previous)

    try {
      return { outcome: 'rolled_back', reason, host, incarnation: await host.start({ continuation: false, resources: previous.resources }) }
    } catch {
      return { outcome: 'rolled_back', reason, host }
    }
  }

  private enoughSpace(): boolean {
    const { paths } = this.deps
    mkdirSync(paths.work, { recursive: true, mode: 0o700 })

    const size = SQLITE_FILES.reduce((sum, name) => {
      const file = join(paths.userdata, name)

      return sum + (existsSync(file) ? statSync(file).size : 0)
    }, 0)

    return (this.deps.freeBytes ?? defaultFreeBytes)(paths.work) >= size * 2 + SPACE_MARGIN
  }

  private takeSnapshot(id: string, from: string, to: string): void {
    const { paths } = this.deps
    rmSync(paths.snapshot, { recursive: true, force: true })
    mkdirSync(paths.snapshot, { recursive: true, mode: 0o700 })
    const files: Manifest['files'] = []

    for (const name of SQLITE_FILES) {
      const source = join(paths.userdata, name)

      if (existsSync(source)) {
        const target = join(paths.snapshot, name)
        copyFileSync(source, target)
        files.push({ name, sha256: sha256File(target), size: statSync(target).size })
      }
    }

    const manifest: Manifest = { id, from, to, files }
    writeFileDurably(join(paths.snapshot, 'manifest.json'), JSON.stringify(manifest))
  }

  /** Idempotent: removes the live files first, so a stale WAL never meets a restored main file. */
  private restoreSnapshot(snapshotId: string | undefined): void {
    const { paths } = this.deps
    const manifest = readJson(join(paths.snapshot, 'manifest.json')) as Manifest | undefined

    if (!manifest || manifest.id !== snapshotId) {
      throw new WorkSessionError('work_snapshot_missing')
    }

    for (const entry of manifest.files) {
      if (sha256File(join(paths.snapshot, entry.name)) !== entry.sha256) {
        throw new WorkSessionError('work_snapshot_corrupt')
      }
    }

    for (const name of SQLITE_FILES) {
      rmSync(join(paths.userdata, name), { force: true })
    }

    mkdirSync(paths.userdata, { recursive: true, mode: 0o700 })

    for (const entry of manifest.files) {
      const temporary = join(paths.userdata, `${entry.name}.restore`)
      copyFileSync(join(paths.snapshot, entry.name), temporary)
      renameSync(temporary, join(paths.userdata, entry.name))
    }
  }

  private writeState(state: UpdateState): void {
    writeFileDurably(this.deps.paths.updateState, JSON.stringify(state))
  }
}

function defaultFreeBytes(path: string): number {
  const stats = statfsSync(path)

  return stats.bavail * stats.bsize
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()

  try {
    return await Promise.race([
      promise,
      delay(ms, undefined, { signal: controller.signal, ref: false }).then(() => {
        throw new WorkSessionError('work_trial_deadline')
      })
    ])
  } finally {
    controller.abort()
  }
}
