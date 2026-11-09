import { execFile } from 'node:child_process'
import { renameSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  type Journal,
  launchDecision,
  type LaunchDecision,
  type LaunchFacts,
  parseProcesses,
  PINNED_REQUIREMENT,
  swapSync
} from './state'
import {
  acquireRecoveryLock,
  markerExists,
  markStockOnly,
  readJournal,
  readStartedPid,
  removeJournal,
  stageRoot,
  writeFailureNotice
} from './store'

const execute = promisify(execFile)

export interface RecoveryOptions {
  home: string
  id: string
  /** This process's own bundle. Recovery works whichever copy is running. */
  bundle: string
  handoffDirectory: string
  exit: () => void
  log: (line: string) => void
  open?: (bundle: string) => Promise<void>
  /** Throws unless the bundle is our pinned team and identifier, and its seal holds. */
  verify?: (bundle: string) => Promise<void>
  /** Stop every process whose executable lives inside the bundle. */
  terminate?: (bundle: string) => Promise<void>
  alive?: (pid: number) => boolean
  now?: () => number
}

const defaultOpen = async (bundle: string) => {
  await execute('/usr/bin/open', ['-n', bundle], { timeout: 5000 })
}

const defaultVerify = async (bundle: string) => {
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${PINNED_REQUIREMENT}`, bundle], { timeout: 180_000 })
}

const defaultAlive = (pid: number) => {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A launch that never showed a window may still own the instance lock. Retire only executables inside the
 * exact failed bundle, never this process, before the bundle is replaced. */
export async function terminateBundleProcesses(bundle: string): Promise<void> {
  const inside = async () => parseProcesses((await execute('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,comm='], { timeout: 5000 })).stdout)
    .filter(row => row.pid !== process.pid && row.command.startsWith(`${bundle}/`))
    .map(row => row.pid)

  for (const pid of await inside()) {try {process.kill(pid, 'SIGTERM')} catch { /* exited */ }}
  await sleep(2000)

  for (const pid of await inside()) {try {process.kill(pid, 'SIGKILL')} catch { /* exited */ }}

  for (let attempt = 0; (await inside()).length; attempt++) {
    if (attempt > 30) {throw new Error('Failed replacement processes have not exited')}
    await sleep(100)
  }
}

const exists = (file: string) => fs.lstat(file).then(() => true, () => false)

function which(self: string, journal: Journal): LaunchFacts['self'] {
  if (self === journal.target) {return 'target'}

  if (self === journal.backup) {return 'backup'}

  return self.startsWith(`${path.dirname(journal.next)}${path.sep}`) ? 'next' : 'other'
}

/**
 * Called before the single-instance lock and before any service starts.
 *
 * Keyed on the journal and the filesystem, so it works whichever copy launches: the signed backup (the
 * waiter's timeout, or a Dock bookmark that followed the first rename), the staged copy in Caches (Spotlight),
 * or the new version itself on a later launch. Returns true when it took over and called `exit`.
 *
 * Single-flight (re-review F4): when a launch finds work to do it takes `recovery.lock`. A second recovery that
 * finds the lock held leaves quietly (`exit`, return true, no throw): the first one restores the old app and
 * reopens it. The decision is taken again under the lock, because the first recovery may already have finished.
 */
export async function recoverStagedSwap(options: RecoveryOptions): Promise<boolean> {
  const root = stageRoot(options.home, options.id)

  if (!readJournal(options.home, root)) {return false}

  const alive = options.alive ?? defaultAlive

  const decide = async () => {
    const journal = readJournal(options.home, root)

    if (!journal) {return null}
    const self = await fs.realpath(options.bundle).catch(() => options.bundle)
    const startedPid = readStartedPid(options.handoffDirectory)

    const decision = launchDecision({
      self: which(self, journal),
      targetExists: await exists(journal.target),
      backupExists: await exists(journal.backup),
      shown: markerExists(options.handoffDirectory, 'shown'),
      startedPid,
      startedAlive: startedPid !== null && alive(startedPid)
    })

    return { journal, self, decision }
  }

  // Nothing to do (a healthy new version, the usual case for a while after an update) takes no lock.
  const first = await decide()

  if (!first || first.decision === 'none') {return false}

  const release = acquireRecoveryLock(root, alive, options.now)

  if (!release) {
    options.log('[updates] stage recovery already running; leaving it to finish')
    options.exit()

    return true
  }

  try {
    const current = await decide()

    if (!current || current.decision === 'none') {return false}

    return await recoverUnderLock(options, root, current)
  } finally {
    release()
  }
}

async function recoverUnderLock(
  options: RecoveryOptions,
  root: string,
  { journal, self, decision }: { journal: Journal; self: string; decision: LaunchDecision }
): Promise<boolean> {
  const opener = options.open ?? defaultOpen
  // Reopening is best effort: with the bundle back in place the person can always open the app themselves.
  const open = (bundle: string) => opener(bundle).catch(() => options.log('[updates] stage could not reopen the app'))
  const now = options.now ?? Date.now

  if (decision === 'drop-stale-journal') {
    removeJournal(root)

    return false
  }

  if (decision === 'leave-healthy-backup') {
    // The new version already ran fine; this copy in Caches has no business running.
    await open(journal.target)
    options.exit()

    return true
  }

  // Both remaining decisions put the signed backup back at the target.
  await (options.verify ?? defaultVerify)(journal.backup)

  if (decision === 'restore-missing-target') {
    renameSync(journal.backup, journal.target)
  } else {
    // Do not terminate ourselves: when the new version is the one running, exit() ends it.
    if (which(self, journal) !== 'target') {await (options.terminate ?? terminateBundleProcesses)(journal.target)}
    swapSync(journal.target, journal.backup, `${journal.next}.failed-${now()}`)
  }

  markStockOnly(root, journal.toVersion, decision)
  writeFailureNotice(root, journal.fromVersion, journal.toVersion)
  removeJournal(root)
  await open(journal.target)
  options.log(`[updates] stage restored previous bundle (${decision})`)
  options.exit()

  return true
}

export type StartupRecovery = 'continue' | 'exiting' | 'failed'

/**
 * What start-up does with recovery (re-review F5). 'exiting': recovery took over and called `exit`, so the caller
 * must not go on to take the instance lock or start anything. 'failed': a filesystem or permission failure; the
 * complete signed backup stays usable but updates pause. 'continue': nothing to recover.
 */
export async function recoverAtStartup(options: RecoveryOptions): Promise<StartupRecovery> {
  try {
    return await recoverStagedSwap(options) ? 'exiting' : 'continue'
  } catch {
    options.log('[updates] stage restore failed; running signed backup with updates paused')

    return 'failed'
  }
}
