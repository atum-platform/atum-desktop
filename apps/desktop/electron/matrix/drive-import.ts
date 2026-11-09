import { randomUUID } from 'node:crypto'

import type { MatrixDriveImportPlan, MatrixDriveImportResult, MatrixDriveImportSkip } from '../../shared/matrix-drive'

import { matrixDriveImportPatterns } from './drive-exclusions'
import { executeNativeDriveImport } from './drive-import-native'
import type { NativeDriveImportInput, NativeDriveImportReply, NativeDriveImportTarget } from './drive-import-native'

export const DRIVE_QUOTA_DEFAULT_BYTES = 1_073_741_824
export const ASSISTANT_OUTPUT_BUDGET_BYTES = 67_108_864
const planLifetime = 10 * 60_000
const skipKeys: MatrixDriveImportSkip[] = ['private', 'code', 'excluded', 'shortcuts', 'special', 'unreadable']

export interface MatrixDriveImportQuota {
  total: number
  used: number
  remaining: number
}

export interface MatrixDriveImportOptions {
  home: string
  python: string
  target(): NativeDriveImportTarget | undefined
  choose(): Promise<readonly string[] | undefined>
  protectedRoots(): readonly string[]
  /** Absent only for the old engine; malformed negotiated facts never fall back. */
  quota?(): MatrixDriveImportQuota | undefined
  /** Whole negotiated list, otherwise the complete pinned0.18 snapshot. */
  exclusions?(): readonly string[] | undefined
  now?: () => number
}

interface PrivateImportPlan {
  input: NativeDriveImportInput
  target: NativeDriveImportTarget
  expiresAt: number
  bytes: number
  state: 'ready' | 'warning' | 'blocked'
}

function targetEqual(a: NativeDriveImportTarget | undefined, b: NativeDriveImportTarget): boolean {
  return Boolean(a && a.root === b.root && a.dev === b.dev && a.ino === b.ino && a.ownerKey === b.ownerKey)
}

function quotaFact(value: MatrixDriveImportQuota | undefined): MatrixDriveImportQuota | undefined {
  if (!value) {
    return undefined
  }

  if (
    ![value.total, value.used, value.remaining].every(n => Number.isSafeInteger(n) && n >= 0) ||
    value.remaining !== Math.max(0, value.total - value.used)
  ) {
    throw new Error('matrix_drive_import_quota_unknown')
  }

  return value
}

/** One native import intent per window/account. Paths stay in this main-only object. */
export class MatrixDriveImport {
  private plan: PrivateImportPlan | undefined
  private preparing = false
  private active: { id: string; abort: AbortController; promise: Promise<MatrixDriveImportResult> } | undefined
  private disposed = false

  constructor(private readonly options: MatrixDriveImportOptions) {}

  async cleanup(): Promise<void> {
    await executeNativeDriveImport(this.options.python, { mode: 'cleanup', home: this.options.home })
  }

  async importPlan(): Promise<MatrixDriveImportPlan> {
    if (this.preparing || this.active) {
      return { state: 'refused', reason: 'busy' }
    }

    this.plan = undefined
    this.preparing = true

    try {
      const target = this.options.target()

      if (this.disposed || !target) {
        return { state: 'refused', reason: 'unavailable' }
      }

      const sources = await this.options.choose()

      if (!sources?.length) {
        return { state: 'cancelled' }
      }

      if (this.disposed || !targetEqual(this.options.target(), target)) {
        return { state: 'refused', reason: 'unavailable' }
      }

      const quota = quotaFact(this.options.quota?.())

      const input: NativeDriveImportInput = {
        mode: 'plan',
        home: this.options.home,
        target,
        sources: [...new Set(sources)],
        protectedRoots: this.options.protectedRoots(),
        patterns: matrixDriveImportPatterns(this.options.exclusions?.()),
        total: quota?.total ?? DRIVE_QUOTA_DEFAULT_BYTES,
        remaining: quota?.remaining
      }

      if (JSON.stringify(input).length > 16 * 1024 * 1024 || sources.length > 50_000) {
        return { state: 'refused', reason: 'too_many' }
      }

      const native = await executeNativeDriveImport(this.options.python, input)

      if (native.state !== 'planned') {
        return { state: 'refused', reason: native.reason ?? 'unavailable' }
      }

      if (
        this.disposed ||
        !targetEqual(this.options.target(), target) ||
        ![native.files, native.folders, native.bytes, native.used].every(n => Number.isSafeInteger(n) && n! >= 0) ||
        !native.skipped ||
        Object.keys(native.skipped).sort().join(',') !== [...skipKeys].sort().join(',') ||
        !skipKeys.every(key => Number.isSafeInteger(native.skipped![key]) && native.skipped![key] >= 0) ||
        !/^[a-f0-9]{64}$/u.test(native.fingerprint ?? '')
      ) {
        return { state: 'refused', reason: 'unavailable' }
      }

      const used = quota?.used ?? native.used!
      const total = quota?.total ?? DRIVE_QUOTA_DEFAULT_BYTES
      const remainingAfter = Math.max(0, total - used) - native.bytes!

      const state =
        remainingAfter < 0 ? 'blocked' : remainingAfter < ASSISTANT_OUTPUT_BUDGET_BYTES ? 'warning' : 'ready'

      const planId = randomUUID()
      const expiresAt = (this.options.now?.() ?? Date.now()) + planLifetime
      this.plan = {
        input: { ...input, mode: 'run', planId, fingerprint: native.fingerprint },
        target,
        bytes: native.bytes!,
        expiresAt,
        state
      }

      return {
        state,
        planId,
        expiresAt,
        files: native.files!,
        folders: native.folders!,
        bytes: native.bytes!,
        skipped: native.skipped!,
        space: { total, used, remainingAfter, estimated: !quota }
      }
    } catch {
      return { state: 'refused', reason: 'unavailable' }
    } finally {
      this.preparing = false
    }
  }

  async importRun(planId: string): Promise<MatrixDriveImportResult> {
    const plan = this.plan

    if (
      this.disposed ||
      this.preparing ||
      this.active ||
      !plan ||
      plan.input.planId !== planId ||
      plan.expiresAt <= (this.options.now?.() ?? Date.now())
    ) {
      return { state: 'expired', added: 0 }
    }

    this.plan = undefined

    try {
      if (!targetEqual(this.options.target(), plan.target)) {
        return { state: 'changed', added: 0 }
      }

      if (plan.state === 'blocked') {
        return { state: 'no_room', added: 0 }
      }

      const patterns = matrixDriveImportPatterns(this.options.exclusions?.())
      const patternSignature = JSON.stringify(patterns)

      if (patternSignature !== JSON.stringify(plan.input.patterns)) {
        return { state: 'changed', added: 0 }
      }

      const quota = quotaFact(this.options.quota?.())

      if (quota && plan.bytes > quota.remaining) {
        return { state: 'no_room', added: 0 }
      }

      const abort = new AbortController()
      const protectedRoots = [...this.options.protectedRoots()]

      const protectionUnchanged = () => {
        const current = this.options.protectedRoots()

        return (
          current.length === protectedRoots.length &&
          current.every(root => protectedRoots.includes(root)) &&
          JSON.stringify(matrixDriveImportPatterns(this.options.exclusions?.())) === patternSignature
        )
      }

      const promise = executeNativeDriveImport(
        this.options.python,
        {
          ...plan.input,
          protectedRoots,
          total: quota?.total ?? DRIVE_QUOTA_DEFAULT_BYTES,
          remaining: quota?.remaining
        },
        abort.signal,
        () => !this.disposed && targetEqual(this.options.target(), plan.target) && protectionUnchanged()
      ).then(reply => this.runResult(reply))

      this.active = { id: planId, abort, promise }

      try {
        return await promise
      } finally {
        this.active = undefined
      }
    } catch {
      return { state: 'unavailable', added: 0 }
    }
  }

  async importCancel(planId: string): Promise<MatrixDriveImportResult> {
    if (this.active?.id === planId) {
      this.active.abort.abort()

      return this.active.promise
    }

    if (this.plan?.input.planId === planId) {
      this.plan = undefined
    }

    return { state: 'cancelled', added: 0 }
  }

  dispose(): void {
    this.disposed = true
    this.plan = undefined
    this.active?.abort.abort()
  }

  private runResult(reply: NativeDriveImportReply): MatrixDriveImportResult {
    const added = Number.isSafeInteger(reply.added) && reply.added >= 0 ? reply.added : 0

    return {
      state: ['completed', 'cancelled', 'changed', 'no_room'].includes(reply.state)
        ? (reply.state as MatrixDriveImportResult['state'])
        : 'unavailable',
      added
    }
  }
}
