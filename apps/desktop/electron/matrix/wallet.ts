import type { MatrixWalletHistory, MatrixWalletState, MatrixWalletView } from '../../shared/matrix-wallet'

import type { NativeGrant } from './authorization'
import { readDomainJson } from './domain'

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
const count = (value: unknown): value is number => integer(value) && value >= 0

const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/.test(value)

const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)

const label = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value)

function invalid(): never { throw new Error('matrix_wallet_invalid') }

export function matrixWalletView(value: unknown): MatrixWalletView {
  if (!object(value) || value.unit !== 'micro_proton' || !object(value.balances) || typeof value.checkoutOpen !== 'boolean') {
    invalid()
  }

  const { available, paid, earned, promo, held } = value.balances

  if (![available, paid, earned, promo, held].every(count) || available !== (paid as number) + (earned as number) + (promo as number)) {
    invalid()
  }

  let allowance: MatrixWalletView['allowance'] = null

  if (value.allowance !== null) {
    const entry = value.allowance

    if (!object(entry) || (entry.kind !== 'founding' && entry.kind !== 'standard') ||
      (entry.state !== 'granted' && entry.state !== 'deferred') || !count(entry.amount) || entry.amount === 0 ||
      (entry.state === 'granted' ? !timestamp(entry.grantedAt) : entry.grantedAt !== null)) { invalid() }

    allowance = { kind: entry.kind, state: entry.state, amount: entry.amount, grantedAt: entry.grantedAt as string | null }
  }

  return {
    unit: 'micro_proton',
    balances: { available: available as number, paid: paid as number, earned: earned as number, promo: promo as number, held: held as number },
    allowance,
    checkoutOpen: value.checkoutOpen
  }
}

export function matrixWalletCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value)
}

export function matrixWalletHistory(value: unknown): MatrixWalletHistory {
  if (!object(value) || !Array.isArray(value.entries) || value.entries.length > 50 ||
    !(value.next === null || matrixWalletCursor(value.next))) { invalid() }

  const ids = new Set<string>()

  const entries = value.entries.map(entry => {
    if (!object(entry) || !uuid(entry.id) || ids.has(entry.id) || !timestamp(entry.at) ||
      !label(entry.kind) || !label(entry.status) || !integer(entry.amount) ||
      !(entry.reference === null || (typeof entry.reference === 'string' && entry.reference.length <= 200)) ||
      !(entry.closedAt === null || timestamp(entry.closedAt))) { invalid() }

    ids.add(entry.id)

    return { id: entry.id, at: entry.at, kind: entry.kind, status: entry.status, amount: entry.amount,
      reference: entry.reference as string | null, closedAt: entry.closedAt as string | null }
  })

  if (entries.length === 0 && value.next !== null) { invalid() }

  return { entries, next: value.next as string | null }
}

/** Fixed ledger resources, never a client-named principal or an arbitrary URL. */
export async function readMatrixWallet(
  resource: string, grant: NativeGrant, kind: 'wallet' | 'history', signal: AbortSignal, before?: string
): Promise<MatrixWalletView | MatrixWalletHistory> {
  if (before !== undefined && (kind !== 'history' || !matrixWalletCursor(before))) { invalid() }
  const query = kind === 'history' ? `?${new URLSearchParams({ limit: '50', ...(before ? { before } : {}) })}` : ''

  const response = await fetch(`${resource}/wallet${kind === 'history' ? '/history' : ''}${query}`, {
    headers: { Authorization: `Bearer ${grant.accessToken}`, Accept: 'application/json' },
    redirect: 'error', signal
  })

  if (response.status === 401) {
    await response.body?.cancel()
    throw new Error('matrix_wallet_authentication')
  }

  if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new Error('matrix_wallet_unavailable')
  }

  const value = await readDomainJson(response, kind === 'history' ? 128 * 1024 : 16_384)
  signal.throwIfAborted()

  return kind === 'wallet' ? matrixWalletView(value) : matrixWalletHistory(value)
}

export interface MatrixWalletScope { accountKey: string; generation: number }
export type MatrixWalletRefresh = 'initial' | 'manual' | 'focus' | 'turn' | 'out_of_protons'

/** Event-driven cache; idle time never starts a read. Old accounts cannot publish. */
export class MatrixWalletController {
  private owner: MatrixWalletScope | null = null
  private state: MatrixWalletState = { state: 'loading', wallet: null }
  private abort?: AbortController
  private pending?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private again = false
  private lastRead = -Infinity
  private lastFocus = -Infinity

  constructor(private readonly options: {
    read(signal: AbortSignal): Promise<MatrixWalletView>
    changed(): void
    now?(): number
  }) {}

  activate(owner: MatrixWalletScope | null): void {
    if (owner?.accountKey === this.owner?.accountKey && owner?.generation === this.owner?.generation) { return }
    this.abort?.abort()
    clearTimeout(this.timer)
    this.timer = undefined
    this.pending = undefined
    this.again = false
    this.owner = owner
    this.state = { state: 'loading', wallet: null }
    this.lastRead = this.lastFocus = -Infinity

    if (owner) { void this.refresh('initial') }
  }

  snapshot(): MatrixWalletState | undefined { return this.owner ? this.state : undefined }

  refresh(reason: MatrixWalletRefresh): Promise<void> {
    if (!this.owner) { return Promise.resolve() }
    const now = this.options.now?.() ?? Date.now()

    if (reason === 'focus') {
      if (now - this.lastFocus < 60_000) { return this.pending ?? Promise.resolve() }
      this.lastFocus = now
    }

    if (this.pending) {
      this.again = true

      return this.pending
    }

    if (reason === 'turn' && now - this.lastRead < 15_000) {
      this.timer ??= setTimeout(() => {
        this.timer = undefined
        void this.refresh('turn')
      }, 15_000 - (now - this.lastRead))

      return Promise.resolve()
    }

    clearTimeout(this.timer)
    this.timer = undefined
    const owner = this.owner
    const abort = new AbortController()
    this.abort = abort
    this.lastRead = now
    const live = () => this.owner === owner && !abort.signal.aborted

    const pending = Promise.resolve().then(() => this.options.read(AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])))
      .then(wallet => { if (live()) { this.state = { state: 'ready', wallet }; this.options.changed() } })
      .catch(() => { if (live()) { this.state = { state: 'unavailable', wallet: null }; this.options.changed() } })
      .finally(() => {
        if (this.pending !== pending) { return }
        this.pending = undefined

        if (this.again && live()) {
          this.again = false
          void this.refresh('turn')
        }
      })

    this.pending = pending

    return pending
  }
}
