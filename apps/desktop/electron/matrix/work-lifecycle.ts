import type { RetireResult, WorkMountAccount } from '../work/mount'
import type { MountSurfaceState } from '../work/mount'
import type { WorkSurfaceParts } from '../work/surface'

// How the Matrix composition holds Work for one signed-in account: `MatrixWorkLifecycle` binds Work to the account the
// Matrix window is signed in as (surface on, built once per account) and retires it (never merely hides it) when the
// sign-in ends or the account changes. Nothing here talks to Electron; `main-work.ts` supplies the real ports.

export interface MatrixWorkScope {
  accountKey: string
  generation: number
}

/**
 * What a Matrix sign-in gives Work as "the account": its key and generation (the Matrix account's own scope), the
 * directory this Mac keeps its Work state in, and the owner principal the platform knows it by. Undefined until both
 * the owner principal and this Mac's device enrollment exist: Work has nothing to enroll before then.
 */
export function workAccountFor(input: {
  scope: MatrixWorkScope | null
  ownerPrincipal: string | undefined
  deviceServiceId: string | undefined
  rootFor(accountKey: string): string
}): WorkMountAccount | undefined {
  const { scope, ownerPrincipal, deviceServiceId } = input

  if (!scope || !ownerPrincipal || !deviceServiceId) {
    return undefined
  }

  return { key: scope.accountKey, generation: scope.generation, root: input.rootFor(scope.accountKey), accountId: ownerPrincipal }
}

export interface MatrixWorkLifecyclePorts {
  /** The current account's Work identity, or undefined while signed out or not yet enrolled. Read on every call. */
  account(): WorkMountAccount | undefined
  /** Loopback services (model proxy, broker) every start needs. Rejects: Work stays absent, nothing half-built. */
  prepare(): Promise<void>
  mount: {
    setSurface(surface: MountSurfaceState): Promise<void>
    reconcile(): Promise<void>
    retire(account: WorkMountAccount): Promise<RetireResult>
    quit(): Promise<void>
    state(): { phase: string }
  }
  /** `WorkSurface.attach`. Called with the account's parts, or undefined to detach. */
  attach(parts: WorkSurfaceParts | undefined): void
  /** Everything one account's Work needs, built once per bound account. */
  parts(account: WorkMountAccount): WorkSurfaceParts
  now?(): number
  log?(line: string): void
}

const RETRY_AFTER_MS = 30_000

const sameAccount = (a: WorkMountAccount, b: WorkMountAccount) =>
  a.key === b.key && a.generation === b.generation && a.root === b.root && a.accountId === b.accountId

export class MatrixWorkLifecycle {
  private current: WorkMountAccount | undefined
  private binding: Promise<void> | undefined
  private nextRetryAt = 0
  private closed = false

  constructor(private readonly ports: MatrixWorkLifecyclePorts) {}

  /** The account Work is bound to now. */
  boundAccount(): WorkMountAccount | undefined {
    return this.current
  }

  /**
   * Whenever the window may have become ready, or the account may have changed. Idempotent and cheap: the first
   * call for an account builds its parts and turns the surface on; later calls only notice a different account
   * (retire the old one first) or retry a start that failed, at most every 30 seconds.
   */
  activate(): Promise<void> {
    if (this.closed) {
      return Promise.resolve()
    }

    const next = this.ports.account()
    const bound = this.current

    if (bound && next && sameAccount(bound, next)) {
      this.retryStart()

      return this.binding ?? Promise.resolve()
    }

    if (!bound && !next) {
      return Promise.resolve()
    }

    this.binding = (this.binding ?? Promise.resolve())
      .then(() => this.rebind())
      .catch(error => this.ports.log?.(`[atum-work] bind_failed ${(error as Error)?.message?.slice(0, 80) ?? 'unknown'}`))

    return this.binding
  }

  private async rebind(): Promise<void> {
    const bound = this.current
    const next = this.ports.account()

    if (bound && next && sameAccount(bound, next)) {
      return
    }

    if (bound) {
      await this.retireBound()
    }

    if (this.closed || !next) {
      return
    }

    // Services first: a Work whose model path cannot start is not drawn at all (no entry that fails on click).
    await this.ports.prepare()

    const again = this.ports.account()

    if (this.closed || !again || !sameAccount(again, next)) {
      return
    }

    this.current = next
    this.ports.attach(this.ports.parts(next))
    await this.ports.mount.setSurface('on')
    // That call already tried to start; the next try waits out the interval.
    this.nextRetryAt = (this.ports.now ?? Date.now)() + RETRY_AFTER_MS
  }

  private retryStart(): void {
    const now = (this.ports.now ?? Date.now)()
    const phase = this.ports.mount.state().phase

    if ((phase === 'failed' || phase === 'idle') && now >= this.nextRetryAt) {
      this.nextRetryAt = now + RETRY_AFTER_MS
      void this.ports.mount.reconcile().catch(() => undefined)
    }
  }

  private async retireBound(): Promise<RetireResult | undefined> {
    const account = this.current
    this.current = undefined

    if (!account) {
      return undefined
    }

    // The page leaves first (view closed, no read answered), then the gate's cutoff, the server and the partition.
    this.ports.attach(undefined)

    const result = await this.ports.mount.retire(account)

    if (!result.settled || result.failed.length > 0) {
      this.ports.log?.(`[atum-work] retire settled=${result.settled} failed=${result.failed.join(',')}`)
    }

    return result
  }

  /**
   * The sign-in ended (sign-out, a session the server revoked, an account switch): everything Work holds for this
   * account is torn down, in the mount's order. Safe to call with nothing bound, and to call twice.
   */
  async retire(): Promise<RetireResult | undefined> {
    const pending = this.binding ?? Promise.resolve()
    this.binding = pending.then(() => undefined)
    await pending.catch(() => undefined)

    return this.retireBound()
  }

  /** App quit: not a revocation. The gate closes without a cutoff, then the server stops. */
  async quit(): Promise<void> {
    this.closed = true
    this.current = undefined
    this.ports.attach(undefined)
    await this.ports.mount.quit()
  }
}
