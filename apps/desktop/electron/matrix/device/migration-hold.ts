import { performance } from 'node:perf_hooks'

import { DEVICE_SERVICE_PACK } from '../../../../../packages/device-protocol/contract-packs'

import type { DeviceStateStore } from './epochs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LIMITS = DEVICE_SERVICE_PACK.parameters as { migration_hold_ms: number; skew_ms: number }
const MINIMUM_HOLD = LIMITS.migration_hold_ms + LIMITS.skew_ms

interface Hold {
  migrationId: string
  agentPrincipal: string
  holdUntil: number
  controllerDeadline?: number
}

/** A snapshot must never race a local writer, including after an app restart or clock jump.
 * Stored in the device vault, scoped to the owner. Call begin BEFORE quiescing/exporting;
 * every local writer gate must consult held(). An unreadable vault fails closed.
 *
 * We do not assume the Mac's clock is synchronized. The frozen 1.1 fallback therefore keeps
 * writers stopped for a full monotonic hold from the latest request/send acknowledgement.
 * Restart starts that conservative period again; it can delay a local restart, never shorten
 * the controller's commit window. Explicit refusal/decline/failed/abandoned ends it early.
 */
export class MigrationWriterHolds {
  private readonly key: string
  private readonly records = new Map<string, Hold>()
  private readonly deadlines = new Map<string, number>()

  constructor(
    private readonly options: {
      ownerUserId: string
      store: DeviceStateStore
      wallNow?: () => number
      monotonicNow?: () => number
    }
  ) {
    if (!/^@[^:\s]+:[^\s]+$/.test(options.ownerUserId)) {
      throw Error('matrix_migration_owner_invalid')
    }

    this.key = `device-migration-holds-v1:${options.ownerUserId}`
    const raw = options.store.getItem(this.key)

    if (options.store.failureCode()) {
      throw Error('matrix_migration_hold_store_unavailable')
    }

    if (raw === null) {
      return
    }

    try {
      if (raw.length > 32_768) {
        throw Error()
      }

      const saved: unknown = JSON.parse(raw)

      if (!Array.isArray(saved) || saved.length > 32) {
        throw Error()
      }

      for (const r of saved) {
        if (
          !r ||
          !UUID.test(r.migrationId) ||
          !UUID.test(r.agentPrincipal) ||
          !Number.isSafeInteger(r.holdUntil) ||
          r.holdUntil < 0 ||
          this.records.has(r.migrationId) ||
          [...this.records.values()].some(h => h.agentPrincipal === r.agentPrincipal)
        ) {
          throw Error()
        }

        if (
          r.controllerDeadline !== undefined &&
          (!Number.isSafeInteger(r.controllerDeadline) || r.controllerDeadline < 0)
        ) {
          throw Error()
        }

        this.records.set(r.migrationId, {
          migrationId: r.migrationId,
          agentPrincipal: r.agentPrincipal,
          holdUntil: r.holdUntil,
          ...(r.controllerDeadline === undefined ? {} : { controllerDeadline: r.controllerDeadline })
        })
        this.deadlines.set(r.migrationId, this.mono() + MINIMUM_HOLD)
      }
    } catch {
      throw Error('matrix_migration_hold_store_unavailable')
    }
  }

  private now() {
    return this.options.wallNow?.() ?? Date.now()
  }
  private mono() {
    return this.options.monotonicNow?.() ?? performance.now()
  }

  private save(records: Map<string, Hold>): void {
    const value = JSON.stringify([...records.values()])
    this.options.store.setItem(this.key, value)

    if (this.options.store.failureCode() || this.options.store.getItem(this.key) !== value) {
      throw Error('matrix_migration_hold_store_unavailable')
    }
  }

  begin(migrationId: string, agentPrincipal: string): void {
    if (!UUID.test(migrationId) || !UUID.test(agentPrincipal)) {
      throw Error('matrix_migration_hold_invalid')
    }

    if (this.records.has(migrationId)) {
      throw Error('matrix_migration_already_moving')
    }

    if (this.records.size >= 32 || [...this.records.values()].some(h => h.agentPrincipal === agentPrincipal)) {
      throw Error('matrix_migration_already_moving')
    }

    const record = { migrationId, agentPrincipal, holdUntil: this.now() + LIMITS.migration_hold_ms }
    const next = new Map(this.records).set(migrationId, record)
    this.save(next)
    this.records.set(migrationId, record)
    this.deadlines.set(migrationId, this.mono() + MINIMUM_HOLD)
  }

  /** Return false for a mismatching controller deadline, preserving the later hold anyway. */
  extend(migrationId: string, holdUntil: number): boolean {
    const previous = this.records.get(migrationId)

    if (!previous || !Number.isSafeInteger(holdUntil) || holdUntil < 0) {
      throw Error('matrix_migration_hold_invalid')
    }

    const record = {
      ...previous,
      holdUntil: Math.max(previous.holdUntil, holdUntil),
      controllerDeadline: Math.max(previous.controllerDeadline ?? holdUntil, holdUntil)
    }

    this.records.set(migrationId, record)
    this.deadlines.set(migrationId, this.mono() + MINIMUM_HOLD)
    this.save(this.records)

    return previous.controllerDeadline === undefined || previous.controllerDeadline === holdUntil
  }

  deadline(migrationId: string): number | undefined {
    return this.records.get(migrationId)?.holdUntil
  }

  /** Only a definitive outcome can release early; cancellation sent or disconnect cannot. */
  release(migrationId: string, _reason: 'offer_refused' | 'declined' | 'failed' | 'abandoned'): void {
    if (!this.records.has(migrationId)) {
      return
    }

    const next = new Map(this.records)
    next.delete(migrationId)
    this.save(next)
    this.records.delete(migrationId)
    this.deadlines.delete(migrationId)
  }

  held(agentPrincipal: string): boolean {
    if (this.options.store.failureCode()) {
      return true
    }

    for (const record of this.records.values()) {
      if (record.agentPrincipal !== agentPrincipal) {
        continue
      }

      if (this.now() <= record.holdUntil + LIMITS.skew_ms || this.mono() <= this.deadlines.get(record.migrationId)!) {
        return true
      }

      try {
        this.release(record.migrationId, 'abandoned')
      } catch {
        return true
      }
    }

    return false
  }
}
