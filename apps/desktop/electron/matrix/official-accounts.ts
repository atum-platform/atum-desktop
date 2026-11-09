import { type MatrixOfficialAccounts, parseOfficialAccounts } from '../../shared/matrix-founder'

import type { NativeGrant } from './authorization'
import { readDomainJson } from './domain'

/**
 * The platform's official accounts (atum-platform spec/official-accounts/v1): who the founder
 * is, and which accounts Atum marks. A native, main-only read with the MAS domain token, as
 * `/me` and `/apps` are; the window never sees the token or the URL.
 */

export type MatrixOfficialAccountsErrorCode = 'authentication' | 'limit' | 'unavailable' | 'cancelled'

export class MatrixOfficialAccountsError extends Error {
  constructor(
    readonly code: MatrixOfficialAccountsErrorCode,
    readonly retryAfterSeconds?: number
  ) {
    super(`matrix_official_accounts_${code}`)
  }
}

/** The largest answer read: 64 rows are a few kilobytes. */
const MAX_BODY = 32_768

/** One named resource: no query, no body, no renderer-chosen URL, no token-bearing redirect. */
export async function requestMatrixOfficialAccounts(
  resource: string,
  grant: Pick<NativeGrant, 'accessToken'>,
  signal: AbortSignal
): Promise<MatrixOfficialAccounts> {
  signal.throwIfAborted()

  const response = await fetch(`${resource}/official-accounts`, {
    headers: { Authorization: `Bearer ${grant.accessToken}`, Accept: 'application/json' },
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    signal
  })

  if (response.status !== 200) {
    const raw = response.headers.get('Retry-After')
    const seconds =
      raw !== null && /^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 86_400 ? Number(raw) : undefined
    await response.body?.cancel()

    if (response.status === 401) {
      throw new MatrixOfficialAccountsError('authentication')
    }

    throw new MatrixOfficialAccountsError(
      response.status === 429 ? 'limit' : 'unavailable',
      response.status === 429 ? seconds : undefined
    )
  }

  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new MatrixOfficialAccountsError('unavailable')
  }

  try {
    return parseOfficialAccounts(await readDomainJson(response, MAX_BODY))
  } catch {
    // Another profile, a broken promise or an unreadable body: unavailable, never empty.
    throw new MatrixOfficialAccountsError('unavailable')
  }
}

export interface MatrixOfficialAccountsScope {
  accountKey: string
  generation: number
}

/** How often a good answer is read again, and the spread that keeps clients apart. */
export const OFFICIAL_ACCOUNTS_REFRESH_MS = 6 * 60 * 60_000
const JITTER = 0.1
/** The first retry after a failure; each next one waits twice as long, up to the refresh. */
const FAILURE_RETRY_MS = 5 * 60_000

/**
 * The official accounts for the signed-in account: read when sign-in is ready, every six hours
 * (with jitter) and when the Mac wakes. The last good answer is kept in memory for that account
 * only and nothing is persisted; signing out or switching accounts drops it. A failed read keeps
 * the last good answer; with none, the accounts are unavailable (no marks, no Founder chat).
 */
export class MatrixOfficialAccountsController {
  private owner: MatrixOfficialAccountsScope | null = null
  private value?: MatrixOfficialAccounts
  private pending?: Promise<void>
  private abort?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private failures = 0
  /** No read before this moment: the platform said how long to wait (429 Retry-After). */
  private blockedUntil = 0

  constructor(
    private readonly options: {
      read(signal: AbortSignal): Promise<MatrixOfficialAccounts>
      /** The answer (or its absence) changed for the window. */
      changed(): void
      /** A read finished, good or not: a Founder chat waiting on it may try again. */
      settled?(): void
      now?(): number
      random?(): number
    }
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now()
  }

  activate(owner: MatrixOfficialAccountsScope | null): void {
    if (owner?.accountKey === this.owner?.accountKey && owner?.generation === this.owner?.generation) {
      return
    }

    this.abort?.abort()
    clearTimeout(this.timer)
    this.timer = undefined
    this.pending = undefined
    this.failures = 0
    this.blockedUntil = 0
    // Called while main composes the window's state, which reads snapshot() next: no publish here.
    this.value = undefined
    this.owner = owner

    if (owner) {
      void this.refresh()
    }
  }

  /** The current account's last good answer; undefined while unknown or unavailable. */
  snapshot(): MatrixOfficialAccounts | undefined {
    return this.owner ? this.value : undefined
  }

  /** The Mac woke: read again now (unless the platform asked to wait). */
  resume(): void {
    void this.refresh()
  }

  refresh(): Promise<void> {
    const owner = this.owner

    if (!owner) {
      return Promise.resolve()
    }

    if (this.pending) {
      return this.pending
    }

    const now = this.now()

    if (now < this.blockedUntil) {
      this.schedule(this.blockedUntil - now)

      return Promise.resolve()
    }

    clearTimeout(this.timer)
    this.timer = undefined
    const abort = new AbortController()
    this.abort = abort
    const live = () => this.owner === owner && !abort.signal.aborted

    const pending = Promise.resolve()
      .then(() => this.options.read(AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])))
      .then(value => {
        if (!live()) {
          return
        }

        this.failures = 0
        const changed = JSON.stringify(value) !== JSON.stringify(this.value)
        this.value = value

        if (changed) {
          this.options.changed()
        }

        this.schedule(OFFICIAL_ACCOUNTS_REFRESH_MS)
      })
      .catch(error => {
        if (!live()) {
          return
        }

        // The last good answer stays; a failure is retried sooner, never in a hot loop.
        this.failures += 1
        const wait = Math.min(OFFICIAL_ACCOUNTS_REFRESH_MS, FAILURE_RETRY_MS * 2 ** (this.failures - 1))

        if (error instanceof MatrixOfficialAccountsError && error.code === 'limit') {
          const asked = (error.retryAfterSeconds ?? 60) * 1000
          this.blockedUntil = this.now() + asked
          this.schedule(Math.max(asked, wait))
        } else {
          this.schedule(wait)
        }
      })
      .finally(() => {
        if (this.pending === pending) {
          this.pending = undefined
        }

        if (live()) {
          this.options.settled?.()
        }
      })

    this.pending = pending

    return pending
  }

  private schedule(ms: number) {
    clearTimeout(this.timer)
    const spread = 1 - JITTER + 2 * JITTER * (this.options.random?.() ?? Math.random())
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        void this.refresh()
      },
      Math.max(1000, Math.round(ms * spread))
    )
    this.timer.unref?.()
  }

  stop(): void {
    this.activate(null)
  }
}
