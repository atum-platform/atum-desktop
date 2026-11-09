import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { MatrixCheckoutIntent, MatrixCheckoutSnapshot, ProtonOrder } from '../../shared/matrix-checkout'

import { storeUuid } from './store-contract'

export type CheckoutResource = 'topups' | `topups/${string}`
export interface CheckoutScope {
  accountKey: string
  generation: number
}
export interface CheckoutJournal {
  read(accountKey: string): MatrixCheckoutIntent | null
  write(accountKey: string, intent: MatrixCheckoutIntent | null): void
}
interface ProtonOrderResult {
  order: ProtonOrder
  reconciliation_pending: boolean
}

/** One account-scoped, atomic intent. It exists before the POST and is the recovery key. */
export class FileCheckoutJournal implements CheckoutJournal {
  constructor(private readonly root: string) {}
  private file(accountKey: string) {
    if (!/^[a-f0-9]{64}$/.test(accountKey)) {
      throw new Error('matrix_checkout_invalid')
    }

    return path.join(this.root, accountKey, 'checkout-intent.json')
  }
  read(accountKey: string): MatrixCheckoutIntent | null {
    const file = this.file(accountKey)

    if (!fs.existsSync(file)) {
      return null
    }
    const raw = fs.readFileSync(file, 'utf8')

    if (Buffer.byteLength(raw) > 4096) {
      throw new Error('matrix_checkout_journal_invalid')
    }
    const value = JSON.parse(raw) as Record<string, unknown>

    if (
      value.version !== 1 ||
      !storeUuid(value.idempotencyKey) ||
      typeof value.packId !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.packId) ||
      !(value.orderId === null || storeUuid(value.orderId)) ||
      Object.keys(value).length !== 4
    ) {
      throw new Error('matrix_checkout_journal_invalid')
    }

    return {
      idempotencyKey: value.idempotencyKey as string,
      packId: value.packId as string,
      orderId: value.orderId as string | null
    }
  }
  write(accountKey: string, intent: MatrixCheckoutIntent | null): void {
    const file = this.file(accountKey)

    if (intent === null) {
      fs.rmSync(file, { force: true })

      return
    }

    if (
      !storeUuid(intent.idempotencyKey) ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(intent.packId) ||
      !(intent.orderId === null || storeUuid(intent.orderId))
    ) {
      throw new Error('matrix_checkout_invalid')
    }

    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${randomUUID()}.tmp`
    let fd: number | undefined

    try {
      fd = fs.openSync(temp, 'wx', 0o600)
      fs.writeFileSync(fd, JSON.stringify({ version: 1, ...intent }))
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = undefined
      fs.renameSync(temp, file)
      const directory = fs.openSync(path.dirname(file), 'r')

      try {
        fs.fsyncSync(directory)
      } finally {
        fs.closeSync(directory)
      }
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd)
      }
      fs.rmSync(temp, { force: true })
    }
  }
}

const empty = (): MatrixCheckoutSnapshot => ({
  state: 'loading',
  packs: [],
  checkoutOpen: false,
  order: null,
  reconciliationPending: false,
  intent: null
})

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)

function catalog(value: unknown): Pick<MatrixCheckoutSnapshot, 'packs' | 'checkoutOpen'> {
  if (
    !object(value) ||
    !Array.isArray(value.packs) ||
    typeof value.checkoutOpen !== 'boolean' ||
    value.packs.length > 16
  ) {
    throw new Error('matrix_checkout_invalid')
  }

  const packs = value.packs.map(pack => {
    if (
      !object(pack) ||
      typeof pack.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(pack.id) ||
      !integer(pack.amountVnd) ||
      pack.amountVnd <= 0 ||
      !integer(pack.paidMicroProtons) ||
      pack.paidMicroProtons <= 0 ||
      !integer(pack.bonusMicroProtons) ||
      pack.bonusMicroProtons < 0 ||
      !integer(pack.totalMicroProtons) ||
      pack.totalMicroProtons !== pack.paidMicroProtons + pack.bonusMicroProtons
    ) {
      throw new Error('matrix_checkout_invalid')
    }

    return {
      id: pack.id,
      amountVnd: pack.amountVnd,
      paidMicroProtons: pack.paidMicroProtons,
      bonusMicroProtons: pack.bonusMicroProtons,
      totalMicroProtons: pack.totalMicroProtons
    }
  })

  return { packs, checkoutOpen: value.checkoutOpen }
}

function checkoutResult(value: unknown): ProtonOrderResult {
  if (!object(value) || typeof value.reconciliation_pending !== 'boolean' || !object(value.order)) {
    throw new Error('matrix_checkout_invalid')
  }

  const order = value.order

  const text = (v: unknown, max: number): v is string =>
    typeof v === 'string' && v.length > 0 && v.length <= max && !Array.from(v).some(c => c.charCodeAt(0) < 32)

  if (
    !text(order.id, 128) ||
    !storeUuid(order.id) ||
    !text(order.package_id, 128) ||
    !integer(order.amount_vnd) ||
    order.amount_vnd < 0 ||
    !integer(order.paid_protons) ||
    order.paid_protons < 0 ||
    !integer(order.bonus_protons) ||
    order.bonus_protons < 0 ||
    !integer(order.total_protons) ||
    order.total_protons !== order.paid_protons + order.bonus_protons ||
    !integer(order.order_code) ||
    order.order_code < 0 ||
    !text(order.created_at, 64) ||
    !Number.isFinite(Date.parse(order.created_at)) ||
    !(order.paid_at === null || (text(order.paid_at, 64) && Number.isFinite(Date.parse(order.paid_at)))) ||
    !(order.checkout_url === null || text(order.checkout_url, 2048)) ||
    !['creating', 'pending', 'paid', 'cancelled', 'expired'].includes(order.status as string)
  ) {
    throw new Error('matrix_checkout_invalid')
  }

  let payment: ProtonOrder['payment'] = null

  if (order.status === 'pending' && object(order.payment)) {
    const p = order.payment

    if (
      text(p.qr_code, 1024) &&
      typeof p.bank_bin === 'string' &&
      /^[0-9]{6}$/.test(p.bank_bin) &&
      typeof p.account_number === 'string' &&
      /^[0-9A-Za-z]{1,32}$/.test(p.account_number) &&
      text(p.account_name, 128) &&
      text(p.description, 64) &&
      text(p.expires_at, 64) &&
      Number.isFinite(Date.parse(p.expires_at))
    ) {
      payment = {
        qr_code: p.qr_code,
        bank_bin: p.bank_bin,
        account_number: p.account_number,
        account_name: p.account_name,
        description: p.description,
        expires_at: p.expires_at
      }
    }
  }

  return {
    reconciliation_pending: value.reconciliation_pending,
    order: {
      id: order.id,
      package_id: order.package_id,
      amount_vnd: order.amount_vnd,
      paid_protons: order.paid_protons,
      bonus_protons: order.bonus_protons,
      total_protons: order.total_protons,
      order_code: order.order_code,
      status: order.status as ProtonOrder['status'],
      checkout_url: order.checkout_url as string | null,
      created_at: order.created_at,
      paid_at: order.paid_at as string | null,
      payment
    }
  }
}

function terminal(order: ProtonOrder) {
  return order.status === 'paid' || order.status === 'cancelled' || order.status === 'expired'
}

export class MatrixCheckoutController {
  private owner: CheckoutScope | null = null
  private state = empty()
  private abort = new AbortController()
  private reading?: Promise<void>
  private writing?: Promise<ProtonOrderResult>
  private journalInvalid = false
  constructor(
    private readonly options: {
      journal: CheckoutJournal
      request(endpoint: CheckoutResource, signal: AbortSignal, input?: unknown): Promise<unknown>
      changed(): void
      walletChanged(): void
      openExternal(url: string): Promise<void>
    }
  ) {}
  activate(owner: CheckoutScope | null): void {
    if (owner?.accountKey === this.owner?.accountKey && owner?.generation === this.owner?.generation) {
      return
    }
    this.abort.abort()
    this.abort = new AbortController()
    this.owner = owner
    this.state = empty()
    this.reading = undefined
    this.writing = undefined
    this.journalInvalid = false

    if (!owner) {
      return
    }

    try {
      this.state.intent = this.options.journal.read(owner.accountKey)
    } catch {
      this.journalInvalid = true
      this.state.state = 'unavailable'
    }

    void this.refresh()
      .then(() => {
        if (this.owner === owner && this.state.intent && !this.state.order) {
          void this.resume().catch(() => {})
        }
      })
      .catch(() => {})
  }
  snapshot(): MatrixCheckoutSnapshot | undefined {
    return this.owner ? this.state : undefined
  }
  private live(owner: CheckoutScope) {
    if (this.owner !== owner || this.abort.signal.aborted) {
      throw new Error('matrix_checkout_cancelled')
    }
  }
  private save(intent: MatrixCheckoutIntent | null) {
    this.options.journal.write(this.owner!.accountKey, intent)
    this.state = { ...this.state, intent }
    this.options.changed()
  }
  refresh(): Promise<void> {
    if (!this.owner || this.journalInvalid) {
      return Promise.resolve()
    }

    if (this.reading) {
      return this.reading
    }
    const owner = this.owner
    this.reading = this.options
      .request('topups', AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)]))
      .then(value => {
        const view = catalog(value)
        this.live(owner)
        this.state = { ...this.state, state: 'ready', ...view }
        this.options.changed()
      })
      .catch(() => {
        if (this.owner === owner) {
          this.state = { ...this.state, state: this.state.state === 'ready' ? 'ready' : 'unavailable' }
          this.options.changed()
        }
      })
      .finally(() => {
        if (this.owner === owner) {
          this.reading = undefined
        }
      })

    return this.reading
  }
  async start(packId: string): Promise<ProtonOrderResult> {
    if (
      !this.owner ||
      this.journalInvalid ||
      !this.state.checkoutOpen ||
      !this.state.packs.some(pack => pack.id === packId)
    ) {
      throw new Error('matrix_checkout_unavailable')
    }

    const current = this.state.intent

    if (current && current.packId !== packId) {
      throw new Error('matrix_checkout_pending')
    }

    if (!current) {
      this.save({ packId, idempotencyKey: randomUUID(), orderId: null })
    }

    return this.resume()
  }
  resume(): Promise<ProtonOrderResult> {
    if (!this.owner || this.journalInvalid || !this.state.intent) {
      return Promise.reject(new Error('matrix_checkout_unavailable'))
    }

    if (this.writing) {
      return this.writing
    }

    const owner = this.owner,
      intent = this.state.intent

    const endpoint: CheckoutResource = intent.orderId ? `topups/${intent.orderId}` : 'topups'
    const input = intent.orderId ? undefined : { packId: intent.packId, idempotencyKey: intent.idempotencyKey }

    const request = this.options
      .request(endpoint, AbortSignal.any([this.abort.signal, AbortSignal.timeout(25_000)]), input)
      .then(value => {
        const result = checkoutResult(value)
        this.live(owner)

        if (
          result.order.package_id !== intent.packId ||
          (intent.orderId !== null && result.order.id !== intent.orderId)
        ) {
          throw new Error('matrix_checkout_invalid')
        }

        const selectedPack = this.state.packs.find(pack => pack.id === intent.packId)

        if (
          selectedPack &&
          (result.order.amount_vnd !== selectedPack.amountVnd ||
            result.order.paid_protons !== selectedPack.paidMicroProtons ||
            result.order.bonus_protons !== selectedPack.bonusMicroProtons ||
            result.order.total_protons !== selectedPack.totalMicroProtons)
        ) {
          throw new Error('matrix_checkout_invalid')
        }

        if (!intent.orderId) {
          this.save({ ...intent, orderId: result.order.id })
        }
        this.state = { ...this.state, order: result.order, reconciliationPending: result.reconciliation_pending }

        if (terminal(result.order)) {
          this.save(null)
        }

        if (result.order.status === 'paid') {
          this.options.walletChanged()
        }
        this.options.changed()

        return result
      })
      .finally(() => {
        if (this.owner === owner) {
          this.writing = undefined
        }
      })

    this.writing = request

    return request
  }
  async dismissTerminal(): Promise<void> {
    if (!this.owner || this.journalInvalid || !this.state.order || !terminal(this.state.order)) {
      throw new Error('matrix_checkout_unavailable')
    }

    // A pending intent is a recovery record. A terminal receipt should never
    // erase one if an unexpected state transition leaves both present.
    if (this.state.intent) {
      throw new Error('matrix_checkout_pending')
    }
    this.state = { ...this.state, order: null, reconciliationPending: false }
    this.options.changed()
  }
  async openCheckout(): Promise<void> {
    const url = this.state.order?.checkout_url

    if (!url) {
      throw new Error('matrix_checkout_unavailable')
    }
    const parsed = new URL(url)

    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'pay.payos.vn' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('matrix_checkout_invalid')
    }

    await this.options.openExternal(url)
  }
}
