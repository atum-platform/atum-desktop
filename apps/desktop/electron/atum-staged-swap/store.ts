import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs'
import path from 'node:path'

import { type Journal, parseJournal } from './state'

/** Everything the staged swap keeps on disk outside the bundles themselves. */
export const stageRoot = (home: string, id: string) => path.join(home, 'Library', 'Caches', id, 'staged-swap')

const JOURNAL = 'journal.json'
const STOCK_ONLY = 'stock-only.json'
const NOTICE = 'notice.json'

/** Write a file so a reader sees the old content or the new content, never a torn one. */
export function writeFileAtomicSync(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.tmp`
  const handle = openSync(temporary, 'w', 0o600)

  try {
    writeSync(handle, content)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }

  renameSync(temporary, file)
}

function readJson(file: string): unknown {
  try {return JSON.parse(readFileSync(file, 'utf8')) as unknown} catch {return null}
}

export function writeJournal(root: string, journal: Journal): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileAtomicSync(path.join(root, JOURNAL), JSON.stringify(journal))
}

export function readJournal(home: string, root: string): Journal | null {
  return parseJournal(readJson(path.join(root, JOURNAL)), home, root)
}

export function removeJournal(root: string): void {
  rmSync(path.join(root, JOURNAL), { force: true })
}

export function appendProgress(root: string, line: string): void {
  try {appendFileSync(path.join(root, 'progress.log'), `${line}\n`, { mode: 0o600 })} catch { /* Reassurance only. */ }
}

/** The kill switch. Staging is opt-in: only an explicit `updates.stagedSwap: true` turns it on. */
export function stagedSwapEnabled(updatesFile: string): boolean {
  const value = readJson(updatesFile) as { updates?: { stagedSwap?: unknown } } | null

  return value?.updates?.stagedSwap === true
}

/** A version that must go through stock Squirrel: staging failed for it, so do not try it again. */
export function markStockOnly(root: string, version: string, reason: string): void {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    writeFileAtomicSync(path.join(root, STOCK_ONLY), JSON.stringify({ version, reason, at: Date.now() }))
  } catch { /* Best effort; the next failure marks it again. */ }
}

export function isStockOnly(root: string, version: string): boolean {
  return (readJson(path.join(root, STOCK_ONLY)) as { version?: unknown } | null)?.version === version
}

/** "The update did not finish", shown once. Written by the instance that survived a failed update. */
export function writeFailureNotice(root: string, fromVersion: string, toVersion: string): void {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    writeFileAtomicSync(path.join(root, NOTICE), JSON.stringify({ fromVersion, toVersion, at: Date.now() }))
  } catch { /* The message is secondary to the rollback. */ }
}

/** Read and delete the notice: the person hears about a failure once, then updates carry on. */
export function consumeFailureNotice(root: string, runningVersion: string): boolean {
  const file = path.join(root, NOTICE)
  const notice = readJson(file) as { fromVersion?: unknown } | null

  if (notice === null) {return false}
  rmSync(file, { force: true })

  return notice.fromVersion === runningVersion
}

/** Liveness signal for the waiter: written once the new version owns the instance lock. */
export function markStarted(handoffDirectory: string, pid: number): void {
  try {
    mkdirSync(handoffDirectory, { recursive: true, mode: 0o700 })
    writeFileAtomicSync(path.join(handoffDirectory, 'started'), String(pid))
  } catch { /* Without it the waiter falls back to its shorter no-start deadline. */ }
}

export function markShown(handoffDirectory: string): void {
  try {
    mkdirSync(handoffDirectory, { recursive: true, mode: 0o700 })
    writeFileAtomicSync(path.join(handoffDirectory, 'shown'), String(Date.now()))
  } catch { /* The update handoff also writes this marker when it owns a record. */ }
}

export function readStartedPid(handoffDirectory: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path.join(handoffDirectory, 'started'), 'utf8'), 10)

    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export const markerExists = (handoffDirectory: string, name: 'started' | 'shown') => existsSync(path.join(handoffDirectory, name))

export function clearMarkers(handoffDirectory: string): void {
  for (const name of ['started', 'shown']) {rmSync(path.join(handoffDirectory, name), { force: true })}
}

const RECOVERY_LOCK = 'recovery.lock'
/** A recovery takes seconds (the deep codesign of the backup is the longest part). Older than this is a leftover. */
const RECOVERY_LOCK_STALE_MS = 10 * 60_000

/**
 * Single-flight lock for recovery (re-review F4). The waiter's backup launch and the handoff panel's reopen of the
 * new version can both decide to restore at once; only one may run. Created with O_EXCL, holding the owner's pid,
 * so a crashed owner's lock is recognised as dead and taken over.
 *
 * Returns a release function, or null when another live recovery holds the lock. A lock that cannot be created
 * for any other reason never blocks recovery: the complete signed backup matters more than the lock.
 */
export function acquireRecoveryLock(root: string, alive: (pid: number) => boolean, now: () => number = Date.now): (() => void) | null {
  const file = path.join(root, RECOVERY_LOCK)

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = openSync(file, 'wx', 0o600)

      try {writeSync(handle, String(process.pid))} finally {closeSync(handle)}

      return () => rmSync(file, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {return () => {}}

      try {
        const holder = Number.parseInt(readFileSync(file, 'utf8'), 10)
        const fresh = now() - statSync(file).mtimeMs < RECOVERY_LOCK_STALE_MS

        if (Number.isInteger(holder) && holder > 0 && alive(holder) && fresh) {return null}
      } catch { /* Unreadable or just released: treat as stale and try once more. */ }

      rmSync(file, { force: true })
    }
  }

  return null
}
