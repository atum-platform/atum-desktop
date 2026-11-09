import type { ExecutionDeviceName } from '../../shared/execution-policy'

/** How long one registry read keeps serving every agent's failover policy. The names are cosmetic
 * (§9.4 "Real names"): a rename can wait minutes, and three agents refreshing every 30 s must not
 * mean three `GET /device-services` per refresh. */
export const MATRIX_EXECUTION_DEVICE_NAMES_REFRESH_MS = 5 * 60_000

/** How soon a failed read is tried again. A registry failure leaves the caller with the ordinals
 * (the policy is never made stale by it), and this keeps every refreshing agent from retrying at
 * once. */
export const MATRIX_EXECUTION_DEVICE_NAMES_RETRY_MS = 30_000

/** A registry read must end on its own: the shared fetch is not tied to any one caller's abort. */
export const MATRIX_EXECUTION_DEVICE_NAMES_TIMEOUT_MS = 10_000

/** The one registry read the names need; the rest of the device record never crosses. */
export interface ExecutionDeviceRecord {
  deviceServiceId: string
  displayName: string
  state: string
  platform: string
  createdAt: number
}

export interface MatrixExecutionDeviceNamesOptions {
  list(signal: AbortSignal): Promise<readonly ExecutionDeviceRecord[]>
  /** This Mac's device-service id while it is enrolled. */
  own(): string | undefined
  /** This Mac's model, read locally (device-name.ts); only this Mac carries one. */
  model(): Promise<string | undefined>
  /** The account (and generation) whose registry the cached names belong to. A switch — another
   * account, or a new generation of the same one — never serves the previous account's names. */
  scope?(): { accountKey: string; generation: number } | null
  now?(): number
  timeoutMs?: number
}

interface CachedNames {
  at: number
  key: string
  superseded: readonly string[]
  value: Record<string, ExecutionDeviceName>
}

interface FailedRead {
  at: number
  error: unknown
  key: string
}

interface InflightRead {
  key: string
  promise: Promise<Record<string, ExecutionDeviceName>>
}

export interface ExecutionDeviceNamesProjection {
  names: Readonly<Record<string, Pick<ExecutionDeviceName, 'displayName' | 'thisMac'>>>
  superseded: readonly string[]
}

/** Placement destinations change when either the visible Macs or hidden duplicate enrollments do. */
export function executionDeviceNamesProjectionChanged(
  previous: ExecutionDeviceNamesProjection | undefined,
  names: ExecutionDeviceNamesProjection['names'],
  superseded: readonly string[]
): boolean {
  return JSON.stringify({ names, superseded }) !== JSON.stringify(previous && {
    names: previous.names,
    superseded: previous.superseded
  })
}

/**
 * The owner's names for the Macs in a failover policy (§9.4 "Real names"), cached across every
 * agent's policy refresh: one shared `list` at most once per interval, refreshed sooner when the
 * registry changed on this Mac's own say (`invalidate`, an enrollment).
 *
 * Names are cosmetic, so nothing here may touch the policy: a failed read never becomes a cached
 * answer (the next read after `MATRIX_EXECUTION_DEVICE_NAMES_RETRY_MS` tries again), a caller with
 * no cached names is refused rather than served an empty record (the controller then keeps the
 * stable ordinal name), and a caller with cached names keeps them through an outage.
 *
 * The cache belongs to one account generation. A cached answer, a failure's retry window, and an
 * in-flight read are all keyed by the scope, so a sign-out or account switch can never paint the
 * previous account's Mac names into the next account's policy.
 */
export class MatrixExecutionDeviceNames {
  private cached?: CachedNames
  private failed?: FailedRead
  private inflight?: InflightRead
  private epoch = 0

  constructor(private readonly options: MatrixExecutionDeviceNamesOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private key(): string {
    const scope = this.options.scope?.()

    return scope ? `${scope.accountKey}\n${scope.generation}` : ''
  }

  async read(): Promise<Record<string, ExecutionDeviceName>> {
    const key = this.key()
    const cached = this.cached?.key === key ? this.cached : undefined

    if (cached && this.now() - cached.at < MATRIX_EXECUTION_DEVICE_NAMES_REFRESH_MS) {
      return cached.value
    }

    if (!this.inflight || this.inflight.key !== key) {
      if (!this.inflight && this.failed?.key === key && this.now() - this.failed.at < MATRIX_EXECUTION_DEVICE_NAMES_RETRY_MS) {
        if (cached) {
          return cached.value
        }

        throw this.failed.error
      }

      const epoch = this.epoch
      const promise = this.load(key, epoch)
      this.inflight = { key, promise }

      void promise
        .finally(() => {
          if (this.inflight?.promise === promise) {
            this.inflight = undefined
          }
        })
        .catch(() => {})
    }

    const inflight = this.inflight
    const epoch = this.epoch

    try {
      const value = await inflight.promise

      if (this.epoch !== epoch || this.key() !== key) {
        // The account (or this Mac's enrollment) changed under the read: never hand these names on.
        return this.read()
      }

      return value
    } catch (error) {
      if (this.epoch !== epoch || this.key() !== key) {
        return this.read()
      }

      if (cached) {
        // The last good names outlive the outage; the caller is never handed an empty record.
        return cached.value
      }

      throw error
    }
  }

  /** Older active rows that this Mac superseded. They remain server records until the owner or
   * coordinator retires them, but must not appear as a second copy of this physical Mac. */
  superseded(): readonly string[] {
    const key = this.key()

    return this.cached?.key === key ? this.cached.superseded : []
  }

  /** The registry changed on this Mac's own say (everything was enrolled here): read again. */
  invalidate(): void {
    this.cached = undefined
    this.failed = undefined
    this.inflight = undefined
    this.epoch += 1
  }

  private async load(key: string, epoch: number): Promise<Record<string, ExecutionDeviceName>> {
    try {
      const records = await this.options.list(
        AbortSignal.timeout(this.options.timeoutMs ?? MATRIX_EXECUTION_DEVICE_NAMES_TIMEOUT_MS)
      )
      const own = this.options.own()
      const model = own ? await this.options.model() : undefined
      const names: Record<string, ExecutionDeviceName> = {}
      const activeMacs = records.filter(record => record.state === 'active' && record.platform === 'macos')
      const current = own ? activeMacs.find(record => record.deviceServiceId === own) : undefined
      const sameName = (left: string, right: string) =>
        left.trim().normalize('NFKC').toLocaleLowerCase('en-US') ===
        right.trim().normalize('NFKC').toLocaleLowerCase('en-US')
      // There is no platform hardware identifier yet. This is deliberately display-only and
      // narrow: only an older exact-name row beside this Mac's newer enrollment is hidden; no
      // registry record is mutated. Distinctly named Macs and every newer row remain visible.
      const superseded = current
        ? activeMacs
            .filter(
              record =>
                record.deviceServiceId !== current.deviceServiceId &&
                record.createdAt < current.createdAt &&
                sameName(record.displayName, current.displayName)
            )
            .map(record => record.deviceServiceId)
        : []
      const hidden = new Set(superseded)

      for (const record of activeMacs) {
        if (hidden.has(record.deviceServiceId)) {
          continue
        }

        names[record.deviceServiceId] = {
          displayName: record.displayName,
          ...(record.deviceServiceId === own && model ? { model } : {}),
          thisMac: record.deviceServiceId === own
        }
      }

      if (this.epoch === epoch && this.key() === key) {
        this.cached = { at: this.now(), key, superseded, value: names }
        this.failed = undefined
      }

      return names
    } catch (error) {
      if (this.epoch === epoch && this.key() === key) {
        this.failed = { at: this.now(), error, key }
      }

      throw error
    }
  }
}
