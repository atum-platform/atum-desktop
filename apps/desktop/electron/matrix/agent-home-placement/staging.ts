/**
 * What a checkpoint leaves on this Mac's disk, and the sweeping of what a process that was killed left behind.
 *
 * A checkpoint stages in `<work>/<agent>/<checkpoint id>/`: a snapshot of the home's portable part, the plaintext archive
 * made from it, and the sealed archive that is uploaded (`checkpoint.ts`). A restore stages beside it, in
 * `restore-<generation>-<id>/`, and a stand-down measures in `measure-<id>/` (`move-target.ts`, `move-source.ts`). Each cleans
 * up after itself, but a process that is killed cleans up nothing, and plaintext of an agent's memories, skills and persona
 * would stay on the disk. Two sweeps remove it:
 *
 *   - when a checkpoint holds its reservation (`removeOtherStaging`): the platform lets one reservation be live per home, so
 *     any other folder of that agent's is of a run that is not coming back;
 *   - when the app starts (`sweepStagingAtStart`), before anything can be checkpointing or restoring: whatever the journal does
 *     not name as a live checkpoint's own folder, for every agent, goes. The folder it names stays, because it may hold the
 *     sealed archive that is the only way to finish that reservation (it is sealed once, and the platform may hold it already).
 */
import { readdirSync, rmSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'

import { isUuid } from './contract'

/** Remove everything staged for one agent except one folder (a checkpoint's own). Best effort: a folder that will not go is left. */
export async function removeOtherStaging(root: string, keep: string): Promise<void> {
  let names: string[]

  try {
    names = await readdir(root)
  } catch {
    return
  }

  await Promise.all(names.filter(name => name !== keep).map(name => rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined)))
}

/**
 * At start: remove every staged folder or file of every agent that the journal does not name as a live checkpoint's own
 * (`live(agent)` is that checkpoint's id, if any). Synchronous, so that it is over before anything can stage again. Only
 * `<work>/<agent id>/...` is touched; a link is removed, never followed. Returns how many entries were removed.
 */
export function sweepStagingAtStart(work: string, live: (agent: string) => string | undefined, log?: (line: string) => void): number {
  let removed = 0

  try {
    for (const agent of readdirSync(work)) {
      if (!isUuid(agent)) {
        continue
      }

      const keep = live(agent)
      const folder = path.join(work, agent)

      for (const name of readdirSync(folder)) {
        if (name === keep) {
          continue
        }

        try {
          rmSync(path.join(folder, name), { recursive: true, force: true })
          removed += 1
        } catch {
          // Left where it is; the next start (or the agent's next reservation) tries again.
        }
      }
    }
  } catch {
    // No work folder yet, or one that cannot be read: nothing to sweep.
  }

  if (removed > 0) {
    log?.(`[Home] removed ${removed} leftover staging ${removed === 1 ? 'entry' : 'entries'} of a checkpoint or restore that did not finish`)
  }

  return removed
}
