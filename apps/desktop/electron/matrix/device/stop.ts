/**
 * The Stop fence (S1 build plan §3, §4, WS-4 `device/stop.ts`).
 *
 * Stop, sign-out, account switch and sleep must **prevent the next action immediately** — before any
 * `await` — then clean up asynchronously (Astra follow-up #4). So `fence()` does its refusal work
 * synchronously: it flips the "refuse new Executes" flag, stops every live grant, voids pending
 * approvals and bumps the connection (and, for sign-out/account-switch, the account) epoch. Only then
 * does it kill the owned process groups, close the GUI broker and send `Stop` — all of which may race
 * session lifecycle and so must not gate the refusal.
 *
 * It is called from the Tray's Stop, from `signOut` as its first statement (before
 * `releaseConsumerPartitions`, never refused by `matrix_operation_pending`), from an account switch and
 * from `powerMonitor` `suspend`. Cancellation is not rollback: already-issued effects are reported as
 * possibly completed, never silently retried.
 */
import type { GrantTable } from './service'

export type StopReason = 'local_stop' | 'sign_out' | 'account_switch' | 'sleep'

export interface StopDeps {
  /** The live grant table; `stopAll()` makes every later Execute refuse with `stopped`. */
  readonly grants: GrantTable
  /** Flip the device into the refusing state synchronously. */
  setStopped(stopped: boolean): void
  /** Drop every pending approval so a late Touch ID cannot authorize a now-fenced command. */
  voidApprovals(): void
  /** Bump the connection epoch so queued/in-flight commands are stale on the next frame. */
  bumpConnectionEpoch(): void
  /** Bump the durable account epoch (sign-out / account switch only); synchronous. */
  bumpAccountEpoch(): void
  /** The process groups this device host owns right now, to kill. */
  ownedProcessGroups(): readonly number[]
  /** Kill one process group (and its descendants). Best-effort; never throws into the fence. */
  killProcessGroup(pgid: number): void
  /** Close the GUI broker so no further CuaDriver action runs. */
  closeBroker(): Promise<void> | void
  /** Send the device-signed `Stop` frame to the controller (best-effort when connected). */
  sendStop(reason: StopReason, accountEpoch: number, grantIds: readonly string[]): Promise<void> | void
  /** The account epoch to stamp on the Stop frame, read AFTER any bump. */
  accountEpoch(): number
}

export class DeviceStopFence {
  constructor(private readonly deps: StopDeps) {}

  /**
   * Fence the device. The synchronous half runs to completion before this returns; the returned promise
   * resolves when the async cleanup (process-group kills, broker close, Stop send) has finished.
   */
  fence(reason: StopReason): Promise<void> {
    const grantIds = this.deps.grants.live().map(grant => grant.body.grantId)

    // ---- synchronous fence: nothing below here may be skipped by a racing Execute ----
    this.deps.setStopped(true)
    this.deps.grants.stopAll()
    this.deps.voidApprovals()
    this.deps.bumpConnectionEpoch()

    if (reason === 'sign_out' || reason === 'account_switch') {
      this.deps.bumpAccountEpoch()
    }

    const pgids = [...this.deps.ownedProcessGroups()]

    for (const pgid of pgids) {
      try {
        this.deps.killProcessGroup(pgid)
      } catch {
        // A pgid that is already gone, or that we cannot signal, must never stop the fence.
      }
    }

    const accountEpoch = this.deps.accountEpoch()

    // ---- asynchronous cleanup: the refusal above already holds ----
    return (async () => {
      try {
        await this.deps.closeBroker()
      } catch {
        // Broker already down; the sandbox socket deny holds regardless.
      }

      try {
        await this.deps.sendStop(reason, accountEpoch, grantIds)
      } catch {
        // Offline / disconnected: the controller learns of the stop on the next connection's Status
        // exchange. Local refusal does not depend on the controller hearing it.
      }
    })()
  }
}
