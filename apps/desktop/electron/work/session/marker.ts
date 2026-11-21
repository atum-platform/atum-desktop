import { randomUUID } from 'node:crypto'

import { readJson, removeDurably, writeFileDurably } from './files'

/**
 * The durable "auth reset pending" marker (plan §8.4 step 1 and R4-3).
 *
 * While a marker exists the account's Work home must not be started. It also
 * records WHERE a restore stands (S0-5 C3): a restart that finds `started`
 * repeats the restore from the kept snapshot before it resets, and one that
 * finds `none` resets a home that was never restored.
 *
 *   none     no restore is involved (sign-out, switch, failed pairing, pre-rotation)
 *   pending  a restore will follow; it has not begun
 *   started  the restore began; it may be half done (repeat it)
 *   done     the restore finished; only the reset remains
 */
export type ResetReason = 'update' | 'rollback' | 'sign-out' | 'switch' | 'pairing-failed' | 'work-off' | 'corrupt'
export type RestoreStage = 'none' | 'pending' | 'started' | 'done'

export interface AuthResetMarker {
  version: 1
  id: string
  reason: ResetReason
  restore: RestoreStage
  snapshotId?: string
  at: string
}

const REASONS: readonly ResetReason[] = [
  'update', 'rollback', 'sign-out', 'switch', 'pairing-failed', 'work-off', 'corrupt'
]

const STAGES: readonly RestoreStage[] = ['none', 'pending', 'started', 'done']

function parse(value: unknown): AuthResetMarker | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const marker = value as Partial<AuthResetMarker>

  if (
    marker.version === 1 &&
    typeof marker.id === 'string' &&
    REASONS.includes(marker.reason as ResetReason) &&
    STAGES.includes(marker.restore as RestoreStage) &&
    typeof marker.at === 'string'
  ) {
    return marker as AuthResetMarker
  }
}

export class AuthResetMarkerStore {
  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * The marker, or undefined when none exists. A file that exists but cannot
   * be read is NOT "no marker": it is reported as a pending reset of reason
   * `corrupt`, so an unreadable marker can only make the reset run again.
   */
  read(): AuthResetMarker | undefined {
    let raw: unknown

    try {
      raw = readJson(this.path)
    } catch {
      return this.corrupt()
    }

    if (raw === undefined) {
      return undefined
    }

    return parse(raw) ?? this.corrupt()
  }

  /** Writes a new marker, or keeps the existing one's stronger restore stage. */
  begin(reason: ResetReason, restore: RestoreStage = 'none', snapshotId?: string): AuthResetMarker {
    const existing = this.read()

    if (existing && existing.restore !== 'none') {
      // A restore already in flight owns the marker; it is never downgraded.
      return existing
    }

    const marker: AuthResetMarker = {
      version: 1,
      id: existing?.id ?? randomUUID(),
      reason,
      restore,
      ...(snapshotId ? { snapshotId } : {}),
      at: this.now().toISOString()
    }

    writeFileDurably(this.path, JSON.stringify(marker))

    return marker
  }

  advance(restore: RestoreStage, snapshotId?: string): AuthResetMarker {
    const existing = this.read()

    if (!existing) {
      throw new Error('work_marker_missing')
    }

    const marker = {
      ...existing,
      restore,
      ...((snapshotId ?? existing.snapshotId) ? { snapshotId: snapshotId ?? existing.snapshotId } : {}),
      at: this.now().toISOString()
    }

    writeFileDurably(this.path, JSON.stringify(marker))

    return marker
  }

  clear(): void {
    removeDurably(this.path)
  }

  private corrupt(): AuthResetMarker {
    return { version: 1, id: 'corrupt', reason: 'corrupt', restore: 'none', at: this.now().toISOString() }
  }
}
