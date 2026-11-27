import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { readJson } from '../work/session/files'
import { workAccountRoot, workSessionPaths } from '../work/session/paths'
import type { WorkUpdateSelection } from '../work/session/update'

import type { Journal } from './state'
import { acquireRecoveryLock, readJournal } from './store'

export function workHomesReadCurrentPin(userData: string, currentPin: string): boolean {
  const accounts = join(userData, 'work-accounts')
  try {
    return readdirSync(accounts, { withFileTypes: true }).every(entry => {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/u.test(entry.name)) {return true}
      const paths = workSessionPaths({ root: join(accounts, entry.name) })
      if (!existsSync(paths.database)) {return true}
      const state = readJson(paths.updateState) as { pin?: string } | undefined
      return state?.pin === currentPin
    })
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(accounts)
  }
}

export function selectedWorkUpdate(userData: string, { work }: Journal): boolean {
  if (!work) {return false}
  const root = workAccountRoot(userData, work.accountKey)
  const state = readJson(workSessionPaths({ root }).updateState) as { pin?: string; committed?: unknown } | undefined

  return state?.pin === work.pin && Array.isArray(state.committed) && state.committed.includes(work.id)
}

/** A single durable Work selection decides both sides of the swap. The backup's
 * recovery path reads that same selection under the lock before restoring either half. */
export function stagedWorkSelection(options: {
  home: string
  root: string
  original: Journal
}): WorkUpdateSelection {
  const { home, root, original } = options
  if (!original.work) {throw new Error('work_update_plan_missing')}
  const id = original.work.id

  return {
    id,
    select(write) {
      const release = acquireRecoveryLock(root, pid => {
        try {
          process.kill(pid, 0)
          return true
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'EPERM'
        }
      }, Date.now, true)
      if (!release) {throw new Error('work_update_recovery_in_progress')}
      try {
        const latest = readJournal(home, root)
        if (latest?.work?.id !== id || latest.target !== original.target || latest.toVersion !== original.toVersion ||
            !existsSync(latest.target) || !existsSync(latest.backup)) {
          throw new Error('work_update_swap_changed')
        }
        write()
      } finally {
        release()
      }
    }
  }
}
