import type { MatrixIdentity, MatrixSignInMethod, MatrixSnapshot } from '../../shared/matrix'

import type { MatrixAccount } from './account'

export interface MatrixOwnerDeviceRepairPort {
  account: Pick<MatrixAccount, 'identity' | 'repairOwnerDevice' | 'cancelOwnerDeviceRepair'>
  /** Main-owned ledger evidence for THIS human device, never a renderer-supplied flag. */
  damaged(identity: MatrixIdentity): boolean
  /**
   * Replace only the human SDK host after the account commit. Restore using the retained
   * owner key, with no identity creation/reset. Idempotent: an activation failure is retried
   * against the already-saved new session, without another browser trip or a rollback.
   * No stopSdk/endChatSession/signOut, agent host cleanup or executor/lease mutation here.
   */
  resume(replaced: MatrixIdentity): Promise<{ signed: boolean; backup: boolean }>
  changed?(): void
  log(line: string): void
}

export type MatrixOwnerDeviceRepairResult = { state: 'repaired' | 'resume_pending' }

const sameDevice = (a: MatrixIdentity | null, b: MatrixIdentity | undefined) =>
  Boolean(a && b && a.userId === b.userId && a.deviceId === b.deviceId)

/** Explicit human action. Merely observing damage never launches authentication. */
export class MatrixOwnerDeviceRepair {
  private running?: Promise<MatrixOwnerDeviceRepairResult>
  private progress?: MatrixSnapshot['ownerDeviceRepair']
  private owner?: MatrixIdentity
  private pending?: { replaced: MatrixIdentity; current: MatrixIdentity }

  constructor(private readonly port: MatrixOwnerDeviceRepairPort) {}

  run(method: MatrixSignInMethod = 'google'): Promise<MatrixOwnerDeviceRepairResult> {
    if (this.running) {
      return this.running
    }
    const running = this.runOnce(method)
      .catch(error => {
        this.progress =
          error instanceof Error && error.message === 'matrix_login_cancelled'
            ? undefined
            : { state: 'failed', error: matrixOwnerRepairError(error).message }
        throw matrixOwnerRepairError(error)
      })
      .finally(() => {
        this.port.changed?.()
        if (this.running === running) {
          this.running = undefined
        }
      })
    this.running = running

    return running
  }

  snapshot(identity: MatrixIdentity | null): MatrixSnapshot['ownerDeviceRepair'] {
    return this.matches(identity) ? this.progress : undefined
  }

  /** Only a committed, same-account human replacement can hold existing work. */
  replacing(identity: MatrixIdentity | null): boolean {
    return Boolean(this.pending && this.matches(identity))
  }

  private matches(identity: MatrixIdentity | null): boolean {
    return Boolean(identity && (sameDevice(identity, this.owner) || sameDevice(identity, this.pending?.current)))
  }

  cancel(): void {
    // Once saved, the new session stays saved. Cancelling a browser can never undo it.
    this.port.account.cancelOwnerDeviceRepair()
  }

  private async runOnce(method: MatrixSignInMethod): Promise<MatrixOwnerDeviceRepairResult> {
    const { account } = this.port
    const owner = account.identity()

    if (this.pending && !sameDevice(owner, this.pending.current)) {
      this.pending = undefined
      throw new Error('matrix_owner_repair_stale')
    }

    if (!this.pending) {
      if (!owner || !this.port.damaged(owner)) {
        throw new Error('matrix_owner_repair_not_damaged')
      }
      this.owner = owner
      this.progress = { state: 'verifying' }
      this.port.changed?.()
      const result = await account.repairOwnerDevice(owner, method)
      const current = account.identity()

      if (
        !sameDevice(result.replaced, owner) ||
        !current ||
        current.userId !== owner.userId ||
        current.deviceId === owner.deviceId
      ) {
        throw new Error('matrix_owner_repair_stale')
      }
      this.pending = { replaced: owner, current }
    }

    const pending = this.pending
    this.progress = { state: 'verifying' }
    this.port.changed?.()
    try {
      const restored = await this.port.resume(pending.replaced)
      if (!sameDevice(account.identity(), pending.current)) {
        throw new Error('matrix_owner_repair_stale')
      }
      this.port.log(`[Matrix] owner repair signed=${restored.signed === true} backup=${restored.backup === true}`)
      if (restored.signed !== true || restored.backup !== true) {
        this.progress = { state: 'resume_pending' }
        return { state: 'resume_pending' }
      }
      this.pending = undefined
      this.progress = undefined

      return { state: 'repaired' }
    } catch {
      this.progress = { state: 'resume_pending' }
      this.port.log('[Matrix] owner repair state=resume_pending')

      return { state: 'resume_pending' }
    }
  }
}

/** A repair error can never enter the ordinary sign-in catch that publishes signed_out. */
export function matrixOwnerRepairError(error: unknown): Error {
  const allowed = new Set([
    'matrix_login_cancelled',
    'matrix_login_timed_out',
    'matrix_login_failed',
    'matrix_account_mismatch',
    'matrix_password_unavailable',
    'matrix_owner_repair_busy',
    'matrix_owner_repair_not_damaged',
    'matrix_owner_repair_stale',
    'matrix_owner_repair_method_invalid',
    'matrix_operation_pending',
    'matrix_recovery_stale',
    'auth_storage_unavailable',
    'auth_storage_disk_full'
  ])

  return new Error(error instanceof Error && allowed.has(error.message) ? error.message : 'matrix_owner_repair_failed')
}

/** Main's lifecycle still wins for real sign-out, account changes and shutdown. */
export function matrixOwnerRepairPreservesWork(
  repair: MatrixOwnerDeviceRepair | undefined,
  snapshot: Pick<MatrixSnapshot, 'identity' | 'state' | 'error'>,
  closing: boolean
): boolean {
  return (
    !closing &&
    snapshot.state !== 'signed_out' &&
    snapshot.error !== 'matrix_sign_out_pending' &&
    snapshot.error !== 'matrix_signed_out' &&
    Boolean(repair?.replacing(snapshot.identity))
  )
}
