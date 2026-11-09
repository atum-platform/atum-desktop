import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { type CheckoutResource, FileCheckoutJournal, MatrixCheckoutController } from './checkout'

const owner = { accountKey: 'a'.repeat(64), generation: 1 }

const order = {
  id: '00000000-0000-4000-8000-303617b97302',
  package_id: 'protons-100k',
  amount_vnd: 95000,
  paid_protons: 95_000_000_000,
  bonus_protons: 5_000_000_000,
  total_protons: 100_000_000_000,
  order_code: 9000000000,
  status: 'pending',
  checkout_url: 'https://pay.payos.vn/web/native-payos',
  created_at: '2026-10-03T00:00:00Z',
  paid_at: null,
  payment: {
    qr_code: 'payload',
    bank_bin: '970422',
    account_number: '123',
    account_name: 'Atum',
    description: 'ATUM',
    expires_at: '2026-10-03T01:00:00Z'
  }
}

const catalog = {
  packs: [
    {
      id: 'protons-100k',
      amountVnd: 95000,
      paidMicroProtons: 95_000_000_000,
      bonusMicroProtons: 5_000_000_000,
      totalMicroProtons: 100_000_000_000
    }
  ],
  checkoutOpen: true
}

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

function journal() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-checkout-test-'))
  roots.push(root)

  return new FileCheckoutJournal(root)
}

function controller(
  j: FileCheckoutJournal,
  request: (endpoint: CheckoutResource, input?: unknown) => Promise<unknown>
) {
  const changed = vi.fn(),
    walletChanged = vi.fn(),
    openExternal = vi.fn()

  const checkout = new MatrixCheckoutController({
    journal: j,
    changed,
    walletChanged,
    openExternal,
    request: (endpoint, _signal, input) => request(endpoint, input)
  })

  checkout.activate(owner)

  return { checkout, changed, walletChanged, openExternal }
}

describe('durable Matrix top-up checkout', () => {
  it('writes a private intent before POST, coalesces double clicks, and reuses its exact key after a lost response', async () => {
    const j = journal()
    const seen: unknown[] = []
    let failCreate!: () => void

    const first = controller(j, async (endpoint, input) => {
      if (endpoint === 'topups' && input === undefined) {
        return catalog
      }
      seen.push(input)
      expect(j.read(owner.accountKey)?.orderId).toBeNull()

      return new Promise((_resolve, reject) => {
        failCreate = () => reject(new Error('lost'))
      })
    })

    await first.checkout.refresh()
    const firstStart = first.checkout.start('protons-100k')
    const secondStart = first.checkout.start('protons-100k')
    expect(seen).toHaveLength(1)
    failCreate()
    await expect(firstStart).rejects.toThrow('lost')
    await expect(secondStart).rejects.toThrow('lost')
    const saved = j.read(owner.accountKey)!
    first.checkout.activate(null)

    const resumed = controller(j, async (endpoint, input) => {
      if (endpoint === 'topups' && input === undefined) {
        return catalog
      }
      expect(endpoint).toBe('topups')
      seen.push(input)

      return { order, reconciliation_pending: false }
    })

    await resumed.checkout.refresh()
    await resumed.checkout.resume()
    expect((seen[0] as any).idempotencyKey).toBe((seen[1] as any).idempotencyKey)
    expect(resumed.checkout.snapshot()?.order?.id).toBe(order.id)
  })
  it('uses GET for every known order, refreshes the wallet only after paid, and ignores late prior-account replies', async () => {
    const j = journal()
    let finish!: (value: unknown) => void

    const { checkout, walletChanged } = controller(j, async (endpoint, input) => {
      if (endpoint === 'topups' && input === undefined) {
        return catalog
      }

      if (endpoint === 'topups' && input) {
        return { order, reconciliation_pending: false }
      }

      return new Promise(resolve => {
        finish = resolve
      })
    })

    await checkout.refresh()
    await checkout.start('protons-100k')
    const intent = j.read(owner.accountKey)!
    const check = checkout.resume()
    checkout.activate({ accountKey: 'b'.repeat(64), generation: 2 })
    finish({
      order: { ...order, status: 'paid', payment: null, paid_at: '2026-10-03T00:01:00Z' },
      reconciliation_pending: false
    })
    await expect(check).rejects.toThrow('matrix_checkout_cancelled')
    expect(j.read(owner.accountKey)).toEqual(intent)
    expect(walletChanged).not.toHaveBeenCalled()
  })
  it('acknowledges a paid receipt before creating a second pack order with a fresh key', async () => {
    const j = journal()
    const seen: CheckoutResource[] = []
    const keys: string[] = []

    const { checkout, walletChanged } = controller(j, async (endpoint, input) => {
      seen.push(endpoint)

      if (endpoint === 'topups' && input === undefined) {
        return catalog
      }

      if (endpoint === 'topups') {
        keys.push((input as { idempotencyKey: string }).idempotencyKey)

        return {
          order: keys.length === 1 ? order : { ...order, id: '00000000-0000-4000-8000-00f765af1c54' },
          reconciliation_pending: false
        }
      }

      return {
        order: { ...order, payment: null, paid_at: '2026-10-03T00:01:00Z', status: 'paid' },
        reconciliation_pending: false
      }
    })

    await checkout.refresh()
    await checkout.start('protons-100k')
    await checkout.resume()
    expect(seen).toEqual(['topups', 'topups', `topups/${order.id}`])
    expect(walletChanged).toHaveBeenCalledOnce()
    expect(j.read(owner.accountKey)).toBeNull()
    await checkout.dismissTerminal()
    expect(checkout.snapshot()?.order).toBeNull()
    await checkout.start('protons-100k')
    expect(keys).toHaveLength(2)
    expect(keys[1]).not.toBe(keys[0])
  })
  it('keeps a pending intent and uses its known order GET without changing the recovery key', async () => {
    const j = journal()
    const seen: Array<{ endpoint: CheckoutResource; input: unknown }> = []

    const { checkout } = controller(j, async (endpoint, input) => {
      seen.push({ endpoint, input })

      if (endpoint === 'topups' && input === undefined) {
        return catalog
      }

      return { order, reconciliation_pending: false }
    })

    await checkout.refresh()
    await checkout.start('protons-100k')
    const saved = j.read(owner.accountKey)!
    await checkout.resume()
    expect(seen.at(-1)).toEqual({ endpoint: `topups/${order.id}`, input: undefined })
    expect(j.read(owner.accountKey)).toEqual(saved)
  })
  it('rejects an order that does not correlate to the saved pack, values, and order id', async () => {
    const j = journal()

    const { checkout } = controller(j, async (endpoint, input) => {
      if (endpoint === 'topups' && input === undefined) {
        return catalog
      }

      if (endpoint === 'topups') {
        return { order, reconciliation_pending: false }
      }

      return { order: { ...order, amount_vnd: 96_000 }, reconciliation_pending: false }
    })

    await checkout.refresh()
    await checkout.start('protons-100k')
    await expect(checkout.resume()).rejects.toThrow('matrix_checkout_invalid')
  })
  it('creates no intent for inactive checkout and keeps journals 0600', async () => {
    const j = journal()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-checkout-mode-'))
    roots.push(root)
    const privateJournal = new FileCheckoutJournal(root)
    const { checkout } = controller(j, async () => ({ ...catalog, checkoutOpen: false }))
    await checkout.refresh()
    await expect(checkout.start('protons-100k')).rejects.toThrow('matrix_checkout_unavailable')
    privateJournal.write(owner.accountKey, { packId: 'protons-100k', idempotencyKey: order.id, orderId: null })
    expect(fs.statSync(path.join(root, owner.accountKey, 'checkout-intent.json')).mode & 0o777).toBe(0o600)
  })
})
