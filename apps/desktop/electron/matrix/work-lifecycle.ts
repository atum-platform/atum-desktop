import type { WorkSurfaceParts } from '../work/surface'

// How the Matrix composition holds Work for one signed-in account: `MatrixWorkLifecycle` binds Work to the account the
// Matrix window is signed in as (surface on, built once per account) and retires it (never merely hides it) when the
// sign-in ends or the account changes. Nothing here talks to Electron; `main-work.ts` supplies the real ports.

export interface WorkAccount {
  key: string
  generation: number
  root: string
  accountId: string
}

export interface MatrixWorkScope {
  accountKey: string
  generation: number
}

/**
 * What a Matrix sign-in gives Work as "the account": its key and generation (the Matrix account's own scope), the
 * directory this Mac keeps its Work state in, and the owner principal the platform knows it by. Undefined until both
 * the owner principal and this Mac's device enrollment exist: Work needs both identities.
 */
export function workAccountFor(input: {
  scope: MatrixWorkScope | null
  ownerPrincipal: string | undefined
  deviceServiceId: string | undefined
  rootFor(accountKey: string): string
}): WorkAccount | undefined {
  const { scope, ownerPrincipal, deviceServiceId } = input

  if (!scope || !ownerPrincipal || !deviceServiceId) {
    return undefined
  }

  return { key: scope.accountKey, generation: scope.generation, root: input.rootFor(scope.accountKey), accountId: ownerPrincipal }
}

export interface MatrixWorkLifecyclePorts {
  /** The current account's Work identity, or undefined while signed out or not yet enrolled. Read on every call. */
  account(): WorkAccount | undefined
  /** Check the staged runtime and finish pending owner session recovery. */
  prepare(): Promise<void>
  retire(account: WorkAccount, deviceServiceId?: string): Promise<void>
  quit(): Promise<void>
  /** `WorkSurface.attach`. Called with the account's parts, or undefined to detach. */
  attach(parts: WorkSurfaceParts | undefined): void
  /** Everything one account's Work needs, built once per bound account. */
  parts(account: WorkAccount): WorkSurfaceParts
  log?(line: string): void
}

const sameAccount = (a: WorkAccount, b: WorkAccount) =>
  a.key === b.key && a.generation === b.generation && a.root === b.root && a.accountId === b.accountId

export class MatrixWorkLifecycle {
  private current: WorkAccount | undefined
  private binding: Promise<void> | undefined
  private closed = false

  constructor(private readonly ports: MatrixWorkLifecyclePorts) {}

  /** The account Work is bound to now. */
  boundAccount(): WorkAccount | undefined {
    return this.current
  }

  /**
   * Whenever the window may have become ready, or the account may have changed. Idempotent and cheap: the first
   * call for an account builds its parts and turns the surface on; later calls notice a different account and retire the old one first.
   */
  activate(): Promise<void> {
    if (this.closed) {
      return Promise.resolve()
    }

    const next = this.ports.account()
    const bound = this.current

    if (bound && next && sameAccount(bound, next)) {
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
  }

  private async retireBound(deviceServiceId?: string): Promise<boolean> {
    const account = this.current
    this.current = undefined

    if (!account) {
      return false
    }

    this.ports.attach(undefined)
    await this.ports.retire(account, deviceServiceId)

    return true
  }

  /**
   * The sign-in ended (sign-out, a session the server revoked, an account switch): everything Work holds for this
   * account is torn down, alongside its owner view. Safe to call with nothing bound, and to call twice.
   */
  async retire(deviceServiceId?: string): Promise<boolean> {
    const pending = this.binding ?? Promise.resolve()
    this.binding = pending.then(() => undefined)
    await pending.catch(() => undefined)

    return this.retireBound(deviceServiceId)
  }

  /** App quit: not a revocation. Stop the native server after detaching the owner view. */
  async quit(): Promise<void> {
    this.closed = true
    this.current = undefined
    this.ports.attach(undefined)
    await this.ports.quit()
  }
}
