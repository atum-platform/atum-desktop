import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { isUpdateDirectory } from './state'
import { markerExists, markShown, readJournal, removeJournal, stageRoot } from './store'

export type Remove = (...paths: string[]) => Promise<boolean>

/** Large deletes run at background priority so they never compete with the app the person is using. */
export const removeAtBackgroundPriority: Remove = (...paths) => new Promise(resolve => {
  const child = spawn('/usr/sbin/taskpolicy', ['-b', '/bin/rm', '-rf', ...paths], { stdio: 'ignore' })
  child.once('error', () => resolve(false))
  child.once('exit', code => resolve(code === 0))
})

const exists = (file: string) => fs.lstat(file).then(() => true, () => false)

/**
 * Delete staged copies nothing references. Safe to run at any time, whatever the eligibility, the switch
 * or the free space say: the 1.5 GB copy is exactly what a low-disk Mac cannot afford to keep.
 *
 * Kept: the directory the journal references while its rollback copy exists. A rollback copy with no
 * journal can never be restored (recovery needs the journal), so it is deleted too.
 */
export async function cleanStaleStages(options: {
  home: string
  id: string
  remove?: Remove
}): Promise<string[]> {
  const root = stageRoot(options.home, options.id)
  const remove = options.remove ?? removeAtBackgroundPriority
  const journal = readJournal(options.home, root)
  const backup = path.join(root, 'previous.app')
  const backupExists = await exists(backup)
  const keep = journal && backupExists ? path.dirname(journal.next) : null
  const doomed: string[] = []

  for (const name of await fs.readdir(root).catch(() => [] as string[])) {
    const directory = path.join(root, name)

    if (isUpdateDirectory(name) && directory !== keep) {doomed.push(directory)}
  }

  if (backupExists && !journal) {doomed.push(backup)}

  if (doomed.length) {await remove(...doomed)}

  return doomed
}

/** The first healthy window proves the new version, after which the rollback copy has no use. */
export async function retireBackup(options: {
  home: string
  id: string
  /** The running bundle: only the swap's own target may retire its rollback copy. */
  bundle: string
  handoffDirectory: string
  remove?: Remove
  log: (line: string) => void
}): Promise<boolean> {
  const root = stageRoot(options.home, options.id)
  const journal = readJournal(options.home, root)

  if (!journal || journal.target !== options.bundle || !markerExists(options.handoffDirectory, 'shown')) {return false}

  const directory = path.dirname(journal.next)
  const remove = options.remove ?? removeAtBackgroundPriority

  for (const entry of [journal.backup, directory]) {
    const stat = await fs.lstat(entry).catch(() => null)

    // Symlinks or paths that resolve elsewhere are never followed into a delete.
    if (stat && (stat.isSymbolicLink() || await fs.realpath(entry) !== entry)) {return false}
  }

  if (!await remove(journal.backup, directory)) {
    // The journal stays, so the next launch and the next download try again; staging is not disabled by it.
    options.log('[updates] stage backup cleanup failed; will retry')

    return false
  }

  removeJournal(root)
  options.log('[updates] stage backup retired after healthy launch')

  return true
}

/** Retire ten minutes after the window appeared, off the launch path. */
export function scheduleRetireBackup(options: Parameters<typeof retireBackup>[0] & { delayMs?: number }): NodeJS.Timeout {
  const timer = setTimeout(() => {
    void retireBackup(options).catch(() => undefined)
  }, options.delayMs ?? 10 * 60_000)

  timer.unref()

  return timer
}

/**
 * The new version got through start-up and owns the instance lock: it is healthy, whether or not a window was
 * put up. A hidden login launch after an install on Quit never shows one (re-review F3); without this the next
 * launch would roll a healthy update back and the rollback copy would never be retired.
 */
export function confirmHealthyStart(
  options: Parameters<typeof scheduleRetireBackup>[0] & {
    /** A launch that puts no window up. With no staged swap pending it has nothing to confirm and writes nothing. */
    hidden?: boolean
  }
): NodeJS.Timeout | null {
  if (options.hidden && !readJournal(options.home, stageRoot(options.home, options.id))) {return null}
  markShown(options.handoffDirectory)

  return scheduleRetireBackup(options)
}
