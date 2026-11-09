import { matrixDeviceIsolation, type MatrixDeviceIsolation } from '../../shared/matrix-device-isolation'

interface PreferenceStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  failureCode(): string | null
}

/** Per-install preference. The store's atomic replacement precedes any new SDK host.
 * Unreadable storage and failed rebuilds never silently start legacy engines. */
export class MatrixDeviceIsolationPolicy {
  private selected: MatrixDeviceIsolation | undefined
  private rebuilding = false
  private failed = false
  private starting = false

  constructor(private readonly store: PreferenceStore) {}

  value(): MatrixDeviceIsolation {
    if (this.selected === undefined) {
      const stored = this.store.getItem('device-isolation')
      if (this.store.failureCode()) {
        throw new Error('matrix_device_isolation_unavailable')
      }
      this.selected = matrixDeviceIsolation(stored ?? undefined)
    }
    return this.selected
  }

  get changing(): boolean {
    return this.rebuilding
  }

  /** Every host captures this value before constructing its SDK window. */
  forHost(): MatrixDeviceIsolation {
    if (this.failed || (this.rebuilding && !this.starting)) {
      throw new Error('matrix_device_isolation_pending')
    }
    return this.value()
  }

  async change(
    value: MatrixDeviceIsolation,
    lifecycle: {
      current(): boolean
      stop(): Promise<void>
      start(): Promise<void>
      changed(): void
    }
  ): Promise<void> {
    const next = matrixDeviceIsolation(value)
    if (this.rebuilding) {
      throw new Error('matrix_device_isolation_pending')
    }
    if (!lifecycle.current()) {
      throw new Error('matrix_device_isolation_stale')
    }
    if (next === this.value() && !this.failed) {
      return
    }
    this.rebuilding = true
    lifecycle.changed()
    try {
      await lifecycle.stop()
      if (!lifecycle.current()) {
        throw new Error('matrix_device_isolation_stale')
      }
      this.store.setItem('device-isolation', next)
      this.selected = next
      this.failed = false
      this.starting = true
      await lifecycle.start()
      if (!lifecycle.current()) {
        throw new Error('matrix_device_isolation_stale')
      }
    } catch (error) {
      // Withdrawal retires this attempt, not the next sign-in. Genuine failure in
      // the same account stays closed until an explicit retry or app restart.
      this.failed = lifecycle.current()
      this.starting = false
      // Even a partial restart must leave no old or partly initialized engine usable.
      await lifecycle.stop().catch(() => {})
      throw error
    } finally {
      this.starting = false
      this.rebuilding = false
      lifecycle.changed()
    }
  }
}
