import { renameSync } from 'node:fs'
import path from 'node:path'

/** Pinned identity. The updater never trusts the identity of a bundle it finds on disk. */
export const ATUM_TEAM_ID = '7D5FC62RXD'
export const ATUM_BUNDLE_ID = 'com.atum.matrix-candidate'

/** codesign `-R` requirement text: our Developer ID team and bundle id, whatever the bundle claims. */
export const PINNED_REQUIREMENT =
  `anchor apple generic and identifier "${ATUM_BUNDLE_ID}" and certificate leaf[subject.OU] = "${ATUM_TEAM_ID}"`

export interface StageEligibility {
  enabled: boolean
  macMajor: number
  translocated: boolean
  writable: boolean
  sameVolume: boolean
  /** /usr/bin/gktool exists. macOS 13 to 14.3 do not ship it; do not unpack 1.5 GB to find out. */
  gktool: boolean
  freeBytes: number
  bundleBytes: number
  zipBytes: number
}

export function ineligible(facts: StageEligibility): string | null {
  if (!facts.enabled) {return 'disabled'}

  if (facts.macMajor < 13) {return 'macos'}

  if (!facts.gktool) {return 'gktool'}

  if (facts.translocated) {return 'translocated'}

  if (!facts.writable) {return 'permissions'}

  if (!facts.sameVolume) {return 'volume'}

  const sizes = [facts.freeBytes, facts.bundleBytes, facts.zipBytes]

  if (!sizes.every(Number.isFinite) || facts.bundleBytes <= 0 || facts.zipBytes < 0) {return 'disk'}

  // Expanded app, rollback copy, the ZIP itself and working room.
  if (facts.freeBytes < 2 * facts.bundleBytes + facts.zipBytes + 512 * 1024 ** 2) {return 'disk'}

  return null
}

export function sameSigningTeam(current: string, staged: string): boolean {
  const team = (text: string) => /^TeamIdentifier=([A-Z0-9]{10})$/mu.exec(text)?.[1]

  return !!team(current) && team(current) === team(staged)
}

/** The staged bundle must be signed by the pinned team, not merely by "the same team as the installed app". */
export function isPinnedTeam(signature: string): boolean {
  return /^TeamIdentifier=([A-Z0-9]{10})$/mu.exec(signature)?.[1] === ATUM_TEAM_ID
}

/** `spctl -a -vv -t exec` prints `source=Notarized Developer ID` only for a notarized (stapled or online) app.
 * It needs no Xcode or Command Line Tools and never shows a developer-tools dialog. */
export function isNotarizedAssessment(output: string): boolean {
  return /^source=Notarized Developer ID$/mu.test(output)
}

export type Snapshot = Record<string, string>

/** Compare two seals. `ignore` names entries that the rename itself changes (the bundle root's ctime). */
export function snapshotMatches(before: Snapshot, after: Snapshot, ignore: readonly string[] = []): boolean {
  const names = Object.keys(before)

  if (names.length !== Object.keys(after).length) {return false}

  return names.every(name => ignore.includes(name) ? name in after : before[name] === after[name])
}

export type StageState = 'download' | 'verify' | 'stage' | 'ready' | 'swap' | 'relaunch' | 'fallback'

export function transition(state: StageState, event: StageState | 'failure'): StageState {
  if (event === 'failure') {return 'fallback'}

  const next: Partial<Record<StageState, StageState>> = {
    download: 'stage', stage: 'verify', verify: 'ready', ready: 'swap', swap: 'relaunch'
  }

  if (next[state] !== event) {throw new Error(`Invalid update transition ${state} -> ${event}`)}

  return event
}

type Rename = (from: string, to: string) => void

/** Two same-volume renames, done back to back and synchronously so nothing runs between them.
 * A failed second rename puts the old bundle back; if that also fails the AggregateError says
 * "the backup is the only complete app" and the waiter restores it. */
export function swapSync(target: string, staged: string, backup: string, rename: Rename = renameSync): void {
  rename(target, backup)

  try {rename(staged, target)} catch (error) {
    try {rename(backup, target)} catch (restoreError) {
      throw new AggregateError([error, restoreError], 'Replacement failed; backup must be recovered before fallback')
    }

    throw error
  }
}

/** Reverse a finished swap whose result failed the post-swap check. The tampered bundle goes back to
 * the staging directory (it is deleted with the next sweep), the original returns to the target. */
export function undoSwapSync(target: string, staged: string, backup: string, rename: Rename = renameSync): void {
  try {
    rename(target, staged)
    rename(backup, target)
  } catch (error) {
    throw new AggregateError([error], 'Could not reverse a rejected replacement')
  }
}

/** Validate central-directory names before ditto sees untrusted archive paths. */
export function safeArchivePaths(listing: string): boolean {
  const names = listing.trimEnd().split('\n')

  return names.length > 0 && names.every(name => name.length > 0 && !/[\\\p{Cc}]/u.test(name) &&
    !name.startsWith('/') && !name.split('/').includes('..'))
}

export const STAGED_PARENTS = (home: string) => ['/Applications', path.join(home, 'Applications')]

export interface Journal {
  v: 2
  target: string
  backup: string
  next: string
  fromVersion: string
  toVersion: string
  /** false for an ordinary Quit: the swap happens, but nothing reopens the app. */
  relaunch: boolean
}

const UPDATE_DIRECTORY = /^update-[a-zA-Z0-9]{6}$/u

export const isUpdateDirectory = (name: string) => UPDATE_DIRECTORY.test(name)

/** A journal is data from a user-writable folder: every path in it must be one we could have written. */
export function parseJournal(raw: unknown, home: string, root: string): Journal | null {
  if (!raw || typeof raw !== 'object') {return null}
  const value = raw as Record<string, unknown>
  const { target, backup, next, fromVersion, toVersion, relaunch } = value

  if (value.v !== 2 || typeof target !== 'string' || typeof backup !== 'string' || typeof next !== 'string' ||
    typeof fromVersion !== 'string' || typeof toVersion !== 'string' || typeof relaunch !== 'boolean') {return null}

  if (!target.endsWith('.app') || !STAGED_PARENTS(home).includes(path.dirname(target))) {return null}

  if (backup !== path.join(root, 'previous.app')) {return null}

  if (!next.endsWith('.app') || path.dirname(path.dirname(next)) !== root || !isUpdateDirectory(path.basename(path.dirname(next)))) {
    return null
  }

  return { v: 2, target, backup, next, fromVersion, toVersion, relaunch }
}

export type LaunchDecision = 'none' | 'restore-missing-target' | 'restore-failed-update' | 'leave-healthy-backup' | 'drop-stale-journal'

export interface LaunchFacts {
  /** This process's bundle: the target, the backup, the staged copy, or something unrelated. */
  self: 'target' | 'backup' | 'next' | 'other'
  targetExists: boolean
  backupExists: boolean
  shown: boolean
  /** The new version's recorded start (its pid) when it began but never showed a window. */
  startedPid: number | null
  startedAlive: boolean
}

/** What a launch should do about an in-flight or finished swap. Keyed on the filesystem and the journal,
 * never on "which copy am I", so recovery works whichever copy the user or macOS starts. */
export function launchDecision(facts: LaunchFacts): LaunchDecision {
  // Crash, power loss or logout between the two renames: the backup is the only complete app.
  if (!facts.targetExists) {return facts.backupExists ? 'restore-missing-target' : 'none'}

  if (!facts.backupExists) {return 'drop-stale-journal'}

  // Swap finished. The new version has proven itself once it showed a window.
  if (facts.shown) {return facts.self === 'backup' ? 'leave-healthy-backup' : 'none'}

  // The backup running while the new version never showed: the waiter's timeout, or a manual launch.
  if (facts.self === 'backup') {return 'restore-failed-update'}

  // The new version running, but an earlier launch of it started and died before its window.
  if (facts.self === 'target' && facts.startedPid !== null && !facts.startedAlive) {return 'restore-failed-update'}

  return 'none'
}

export interface ProcessRow {
  pid: number
  ppid: number
  command: string
}

export function parseProcesses(psOutput: string): ProcessRow[] {
  return psOutput.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/u.exec(line)

    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []
  })
}

/** Chromium's utility and GPU helpers ("<App> Helper.app", "<App> Helper (GPU).app") are direct children of
 * the main process. They live exactly as long as it does, hold the old inodes, and cannot be waited on
 * from inside the main process. Renderers and plugin hosts must be gone, so they are not tolerated. */
const OWN_HELPER = /\/Contents\/Frameworks\/[^/]+ Helper(?: \((?!Renderer\)|Plugin\))[^)/]+\))?\.app\/Contents\/MacOS\/[^/]+$/u

/** Processes that would still run code from the old bundle after the swap and so must exit first. */
export function blockingProcesses(rows: ProcessRow[], bundle: string, mainPid: number): ProcessRow[] {
  return rows.filter(row => {
    if (row.pid === mainPid || !row.command.startsWith(`${bundle}/`)) {return false}

    const relative = row.command.slice(bundle.length)

    return !(row.ppid === mainPid && OWN_HELPER.test(relative))
  })
}
