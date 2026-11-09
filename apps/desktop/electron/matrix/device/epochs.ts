/**
 * The device service's epochs (S1 WS-3b, `atum.device-service/1` §3.3).
 *
 * - **Account epoch:** durable and monotonic per Mac, never reset (it survives sign-out, which
 *   clears the account vault, because it lives in the device store). It is bumped synchronously,
 *   before any await, on sign-out and on an account switch, so a grant, an approval or a command
 *   issued under the previous account can never be admitted again (admission step 3).
 * - **Boot ID:** `kern.bootsessionuuid`, so a command captured before a reboot is refused after it.
 * - **Local generation:** this process's sleep and stop counter. Sleep invalidates the connection
 *   epoch: a connection, and every grant on it, made under an older generation is dead.
 */
import { execFileSync } from 'node:child_process'

/** The subset of `EncryptedStore` the device service keeps its records in. */
export interface DeviceStateStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  setItems?(entries: Record<string, string>): void
  removeItem(key: string): void
  failureCode(): string | null
}

export const DEVICE_ACCOUNT_EPOCH_KEY = 'device-account-epoch-v1'

const BOOT_ID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/

/** `kern.bootsessionuuid`: changes on every boot. Null where it cannot be read. */
export function readBootSessionId(
  read: () => string = () =>
    execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 5_000 })
): string | null {
  try {
    const value = read().trim()

    return BOOT_ID.test(value) ? value.toUpperCase() : null
  } catch {
    return null
  }
}

export class DeviceEpochError extends Error {
  constructor(readonly code: 'store_unavailable' | 'boot_unavailable') {
    super(`device_epoch_${code}`)
    this.name = 'DeviceEpochError'
  }
}

export class DeviceEpochs {
  /** The highest account epoch this process has seen or set: the floor if a write fails. */
  private floor = 0
  /** Written to memory but not yet to the store (a failed write): retried on the next read. */
  private unsaved = false
  private generation = 1
  private boot?: string

  constructor(
    private readonly options: {
      store: DeviceStateStore
      bootId?: () => string | null
    }
  ) {}

  private stored(): number {
    const raw = this.options.store.getItem(DEVICE_ACCOUNT_EPOCH_KEY)

    if (this.options.store.failureCode()) {
      throw new DeviceEpochError('store_unavailable')
    }

    const value = raw === null ? 0 : Number(raw)

    // A corrupt value never lowers the floor: it reads as unusable, and the device stays offline.
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DeviceEpochError('store_unavailable')
    }

    return value
  }

  private save(value: number): void {
    try {
      this.options.store.setItem(DEVICE_ACCOUNT_EPOCH_KEY, String(value))
      this.unsaved = false
    } catch {
      this.unsaved = true
    }
  }

  /** The current account epoch, at least 1. Throws when the store cannot be read: the device
   * service then stays offline rather than risk reusing an older epoch. */
  accountEpoch(): number {
    const stored = this.stored()

    if (stored > this.floor) {
      this.floor = stored
    }

    if (this.floor < 1) {
      this.floor = 1
      this.save(1)
    } else if (this.unsaved || stored < this.floor) {
      this.save(this.floor)
    }

    return this.floor
  }

  /**
   * Sign-out or an account switch: the epoch moves on now, synchronously. The new value holds in
   * memory even if the store cannot take it, and is written on the next read.
   */
  bumpAccountEpoch(): number {
    let stored = 0

    try {
      stored = this.stored()
    } catch {
      // Unreadable now: the in-memory floor still moves on, and the write is retried.
    }

    this.floor = Math.max(this.floor, stored, 0) + 1
    this.save(this.floor)

    return this.floor
  }

  /** This boot, as the contract writes it (upper-case UUID). */
  bootId(): string {
    if (!this.boot) {
      const value = (this.options.bootId ?? readBootSessionId)()

      if (!value || !BOOT_ID.test(value)) {
        throw new DeviceEpochError('boot_unavailable')
      }

      this.boot = value.toUpperCase()
    }

    return this.boot
  }

  localGeneration(): number {
    return this.generation
  }

  /** Sleep or stop: every connection made before this call is stale from now on. */
  bumpLocalGeneration(): number {
    this.generation += 1

    return this.generation
  }
}
