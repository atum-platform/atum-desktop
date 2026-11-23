import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { removeDurably } from './files'
import { type AuthResetMarker, AuthResetMarkerStore, type ResetReason } from './marker'
import type { WorkSessionPaths } from './paths'
import { WorkSessionError } from './redact'
import { Serial } from './serial'
import type { PairingGrantLookup, T3AuthCli } from './t3-auth'

/** Counts only. Nothing here names a credential. */
export interface ResetReport {
  signingKeyRemoved: boolean
  sessionsRevoked: number
  pairingLinksRevoked: number
  hiddenGrantsRevoked: number
}

export interface ResetDeps {
  paths: WorkSessionPaths
  cli: T3AuthCli
  grants: PairingGrantLookup
  /** True while a server may still hold the home (its cached signing key would survive a removal). */
  homeRunning(): boolean | Promise<boolean>
}

/** A live server pid recorded by T3 in `userdata/server-runtime.json`. */
export function homeRunningFromRuntimeFile(paths: WorkSessionPaths, pidAlive: (pid: number) => boolean = defaultPidAlive) {
  return (): boolean => {
    const file = join(paths.userdata, 'server-runtime.json')

    if (!existsSync(file)) {
      return false
    }

    try {
      const pid = JSON.parse(readFileSync(file, 'utf8'))?.pid

      return Number.isSafeInteger(pid) && pid > 0 ? pidAlive(pid) : false
    } catch {
      // An unreadable runtime file cannot prove the home is stopped.
      return true
    }
  }
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The full auth reset on a STOPPED home (plan §8.4 steps 2 and 3).
 *
 * 1. Remove the signing key file. T3 caches the key, so this is only meaningful
 *    with no server running (S0-5 §3.3). Every session token fails its
 *    signature whatever the rows say.
 * 2. Revoke every session and every listed pairing link with T3's own commands.
 * 3. Revoke every hidden startup grant (a row neither consumed nor revoked),
 *    which T3's list never shows and which key removal does not cancel: pairing
 *    grants are checked by row only.
 *
 * Every step is idempotent, so a crash at any point is finished by running it
 * again. The postcondition is read back; anything left live fails closed.
 */
export async function resetAuth({ paths, cli, grants, homeRunning }: ResetDeps): Promise<ResetReport> {
  if (await homeRunning()) {
    throw new WorkSessionError('work_reset_home_running')
  }

  const signingKeyRemoved = existsSync(paths.signingKey)
  removeDurably(paths.signingKey)

  let sessionsRevoked = 0
  let pairingLinksRevoked = 0
  let hiddenGrantsRevoked = 0

  for (const id of await cli.sessionIds()) {
    await cli.revokeSession(id)
    sessionsRevoked += 1
  }

  for (const id of await cli.pairingIds()) {
    if (await cli.revokePairing(id)) {
      pairingLinksRevoked += 1
    }
  }

  for (const id of grants.unusedIds()) {
    if (await cli.revokePairing(id)) {
      hiddenGrantsRevoked += 1
    }
  }

  if (
    (await cli.sessionIds()).length > 0 ||
    (await cli.pairingIds()).length > 0 ||
    grants.unusedIds().length > 0
  ) {
    throw new WorkSessionError('work_reset_incomplete')
  }

  return { signingKeyRemoved, sessionsRevoked, pairingLinksRevoked, hiddenGrantsRevoked }
}

/**
 * Owns the marker and the reset for one account's home. Reset-before-serve
 * is enforced here: `reconcile()` is the one door every start goes through.
 */
export class ResetCoordinator {
  readonly markers: AuthResetMarkerStore
  private readonly serial = new Serial()
  private readonly listeners = new Set<(report: ResetReport) => void>()

  constructor(
    private readonly deps: ResetDeps,
    markers?: AuthResetMarkerStore
  ) {
    this.markers = markers ?? new AuthResetMarkerStore(deps.paths.marker)
  }

  pending(): AuthResetMarker | undefined {
    return this.markers.read()
  }

  /** "Reset done, re-issue sessions" (S ↔ R ↔ G). Called after the marker is cleared. */
  onResetDone(listener: (report: ResetReport) => void): () => void {
    this.listeners.add(listener)

    return () => void this.listeners.delete(listener)
  }

  /** Marker, reset, clear. For switch, sign-out, work-off and a failed pairing. */
  reset(reason: ResetReason): Promise<ResetReport> {
    return this.serial.run(async () => {
      this.markers.begin(reason)

      return this.finish()
    })
  }

  /**
   * Finish whatever the marker says before anything starts. With no marker this
   * is a no-op. A marker whose restore is `pending` or `started` means a
   * restore may be half done: that is the update driver's to repeat first, so
   * a plain reset is refused here and the home stays closed.
   */
  reconcile(): Promise<ResetReport | undefined> {
    return this.serial.run(async () => {
      const marker = this.markers.read()

      if (!marker) {
        return undefined
      }

      if (marker.restore === 'pending' || marker.restore === 'started') {
        throw new WorkSessionError('work_restore_unfinished')
      }

      return this.finish()
    })
  }

  /** Reset the stopped home and keep the marker (the update driver clears it at commit). */
  resetHome(): Promise<ResetReport> {
    return resetAuth(this.deps)
  }

  /** Reset the stopped home and clear the marker. Used inside serialised update steps too. */
  async finish(): Promise<ResetReport> {
    const report = await resetAuth(this.deps)
    this.markers.clear()

    for (const listener of this.listeners) {
      try {
        listener(report)
      } catch {
        // A listener cannot undo a completed reset.
      }
    }

    return report
  }

  /** Serialise an update step with every other reset on this home. */
  exclusive<T>(job: () => Promise<T>): Promise<T> {
    return this.serial.run(job)
  }
}
