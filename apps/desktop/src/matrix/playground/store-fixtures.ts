import type { MatrixSnapshot } from '../../../shared/matrix'
import type {
  MatrixCheckoutBridge,
  MatrixCheckoutSnapshot,
  MatrixTopUpPack,
  ProtonOrder
} from '../../../shared/matrix-checkout'
import type {
  MatrixStoreBridge,
  MatrixStoreEntitlement,
  MatrixStoreItem,
  MatrixStoreResult,
  MatrixStoreSnapshot
} from '../../../shared/matrix-store'
import type { MatrixWalletBridge, MatrixWalletState } from '../../../shared/matrix-wallet'
import type { MatrixWalletHistoryView } from '../wallet-ui'

/**
 * A store and a wallet for the design playground (dev only): every state a shelf and the
 * Protons pane draw, on plausible data. Nothing here reaches a product build.
 */
let fixtureOffer = 0
export const PLAYGROUND_ASSISTANT = '00000000-0000-4000-8000-11e594f48195'

// Listing summaries (the house dogs') may carry no closing stop; the description
// adds one before its second sentence.
const sentence = (text: string) => (/[.!?…]$/u.test(text) ? text : `${text}.`)

function item(
  kind: MatrixStoreItem['kind'],
  id: string,
  glyph: string,
  accent: string,
  title: [string, string],
  summary: [string, string],
  price: number | null,
  extra: Partial<MatrixStoreItem> = {}
): MatrixStoreItem {
  return {
    kind,
    itemId: `${kind}/${id}`,
    title: { en: title[0], vi: title[1] },
    summary: { en: summary[0], vi: summary[1] },
    description: {
      en: `${sentence(summary[0])} It works in any chat with your assistant.`,
      vi: `${sentence(summary[1])} Dùng được trong mọi cuộc trò chuyện với trợ lý.`
    },
    tryPrompt: { en: `Help me with ${title[0].toLowerCase()}.`, vi: `Giúp mình ${title[1].toLowerCase()}.` },
    needs: kind === 'skill' ? ['internet'] : [],
    glyph,
    accent,
    featured: false,
    sortOrder: 0,
    offer:
      price === null
        ? null
        : {
            id: `00000000-0000-4000-8000-${String(++fixtureOffer).padStart(12, '0')}`,
            version: 1,
            priceMicroProtons: (kind === 'agent' ? 19000 : price) * 1000000,
            scope: kind === 'pet' ? 'account' : 'agent',
            delivery: 'cloud',
            billingInterval: kind === 'agent' ? 'month' : 'one_time',
            ...(kind === 'agent' ? { renewalPriceMicroProtons: 39000 * 1000000 } : {})
          },
    ...extra
  }
}

export const PLAYGROUND_CATALOG: MatrixStoreSnapshot = {
  state: 'ready',
  pending: [],
  purchases: [],
  items: [
    item(
      'skill',
      'trip-planner',
      '🗺️',
      '#3a62c9',
      ['Trip planner', 'Lập kế hoạch chuyến đi'],
      ['Plans a trip around how you like to travel.', 'Lên lịch trình theo cách bạn thích đi.'],
      4000,
      { featured: true, sortOrder: 1 }
    ),
    item(
      'skill',
      'meeting-notes',
      '📝',
      '#b4690e',
      ['Meeting notes', 'Ghi chú cuộc họp'],
      ['Turns a recording into decisions and next steps.', 'Biến bản ghi âm thành quyết định và việc cần làm.'],
      0,
      { featured: true, sortOrder: 2 }
    ),
    item(
      'skill',
      'research-brief',
      '🔎',
      '#2c8078',
      ['Research brief', 'Tóm tắt nghiên cứu'],
      ['Reads widely and writes you one clear page.', 'Đọc nhiều nguồn và viết cho bạn một trang rõ ràng.'],
      12000,
      { sortOrder: 3 }
    ),
    item(
      'skill',
      'budget-coach',
      '💸',
      '#4f8a3a',
      ['Budget coach', 'Huấn luyện chi tiêu'],
      ['A monthly look at where the money went.', 'Mỗi tháng nhìn lại tiền đã đi đâu.'],
      null,
      { sortOrder: 4 }
    ),
    // The house dogs as production lists them (copy from docs/shelf/pets/<slug>/listing.json):
    // the 🐾 glyph and accents are the listing's; the card shows each dog's portrait.
    item(
      'pet',
      'gigi',
      '🐾',
      '#f3c969',
      ['Gigi', 'Gigi'],
      [
        "Atum's own maltese: small, white and never far from you",
        'Cô maltese của Atum: nhỏ xíu, trắng muốt, lúc nào cũng quanh quẩn bên bạn'
      ],
      90000,
      { featured: true, sortOrder: 5 }
    ),
    item(
      'pet',
      'cookie',
      '🐾',
      '#d98c58',
      ['Cookie', 'Cookie'],
      ['The smallest dog in the house, ears up and ready', 'Chú Yorkshire bé nhất nhà, tai vểnh sẵn sàng'],
      90000,
      { sortOrder: 6 }
    ),
    item(
      'pet',
      'mochi',
      '🐾',
      '#d8a4bd',
      ['Mochi', 'Mochi'],
      ['A bichon as round as a cotton ball, and happy about it', 'Bé bichon tròn như cục bông, lúc nào cũng hớn hở'],
      90000,
      { sortOrder: 7 }
    ),
    item(
      'pet',
      'bailey',
      '🐾',
      '#8fc0a9',
      ['Bailey', 'Bailey'],
      ['A big, gentle Bernese who is never in a hurry', 'Chú chó núi Bernese to xác, hiền và chẳng bao giờ vội'],
      90000,
      { sortOrder: 8 }
    ),
    item(
      'pet',
      'hatch',
      '🐾',
      '#8e75d6',
      ['Hatch your own pet', 'Ấp thú cưng của riêng bạn'],
      [
        'Describe a pet and Atum draws it as your own voxel pet',
        'Tả một bé thú cưng, Atum vẽ thành bé voxel của riêng bạn'
      ],
      180000,
      { sortOrder: 9 }
    ),
    // Listed only until the account's first hatch is bought; the Store folds it into the Hatch card.
    item(
      'pet',
      'hatch-first',
      '🐾',
      '#8e75d6',
      ['First pet hatch', 'Ấp thú cưng đầu tiên'],
      ['Create your first voxel pet', 'Tạo thú cưng voxel đầu tiên của bạn'],
      65000,
      { sortOrder: 9 }
    ),
    item(
      'agent',
      'moon-travel',
      '🌙',
      '#3a3f8f',
      ['Moon, travel agent', 'Moon, trợ lý du lịch'],
      ['Books and rebooks trips while you get on with things.', 'Đặt và đổi chuyến đi trong lúc bạn làm việc khác.'],
      99000,
      { sortOrder: 10 }
    )
  ],
  entitlements: [
    {
      id: '00000000-0000-4000-8000-4bcc13e151d8',
      itemId: 'skill/research-brief',
      kind: 'skill',
      state: 'active',
      assistantId: PLAYGROUND_ASSISTANT,
      delivery: 'cloud',
      grantedAt: '2026-09-20T10:00:00Z',
      subscription: null
    },
    {
      id: '00000000-0000-4000-8000-a28c50c0e7e8',
      itemId: 'pet/gigi',
      kind: 'pet',
      state: 'active',
      assistantId: null,
      delivery: 'cloud',
      grantedAt: '2026-09-18T10:00:00Z',
      subscription: null
    }
  ]
}

export const PLAYGROUND_WALLET: MatrixWalletState = {
  state: 'ready',
  wallet: {
    unit: 'micro_proton',
    balances: {
      available: 25_400_500_000,
      paid: 20_000_000_000,
      earned: 0,
      promo: 5_400_500_000,
      held: 120_000_000
    },
    allowance: { kind: 'founding', state: 'granted', amount: 50_000_000_000, grantedAt: '2026-09-28T00:00:00Z' },
    checkoutOpen: true
  }
}

export function playgroundHistory(now: number): MatrixWalletHistoryView {
  const day = 86_400_000

  return {
    entries: [
      {
        id: 'order-3',
        at: new Date(now - day / 4).toISOString(),
        kind: 'topup',
        amount: 210_000_000_000,
        status: 'pending',
        reference: null,
        closedAt: null
      },
      {
        id: 'purchase-2',
        at: new Date(now - 8 * day).toISOString(),
        kind: 'purchase',
        amount: -12_000_000_000,
        status: 'completed',
        reference: 'Research brief',
        closedAt: new Date(now - 8 * day + 10_000).toISOString()
      },
      {
        id: 'order-1',
        at: new Date(now - 10 * day).toISOString(),
        kind: 'topup',
        amount: 50_000_000_000,
        status: 'completed',
        reference: null,
        closedAt: new Date(now - 10 * day + 10_000).toISOString()
      }
    ],
    error: false,
    loading: false,
    next: null
  }
}

const MICRO = 1_000_000

/** Server-shaped top-up packs: a small pack and a bigger one that saves. */
export const PLAYGROUND_PACKS: MatrixTopUpPack[] = [
  {
    id: 'protons-50k',
    amountVnd: 50_000,
    paidMicroProtons: 50_000 * MICRO,
    bonusMicroProtons: 0,
    totalMicroProtons: 50_000 * MICRO
  },
  {
    id: 'protons-220k',
    amountVnd: 200_000,
    paidMicroProtons: 200_000 * MICRO,
    bonusMicroProtons: 20_000 * MICRO,
    totalMicroProtons: 220_000 * MICRO
  }
]

export type PlaygroundOrderState = ProtonOrder['status']

export interface PlaygroundCommerceOptions {
  /** Whole Protons to start with: `?balance=420` shows the low-balance caption, 1200 a short purchase. */
  balance?: number
  /** Start with an order in this state: `?order=pending|paid|expired|creating`. */
  order?: PlaygroundOrderState
  /** The storefront's state: `?store=loading|unavailable|stale`. */
  store?: MatrixStoreSnapshot['state']
}

export function playgroundCommerceOptions(params: URLSearchParams): PlaygroundCommerceOptions {
  const balance = Number(params.get('balance'))
  const order = params.get('order')
  const store = params.get('store')

  return {
    ...(params.has('balance') && Number.isFinite(balance) && balance >= 0 ? { balance } : {}),
    ...(order && ['creating', 'pending', 'paid', 'cancelled', 'expired'].includes(order)
      ? { order: order as PlaygroundOrderState }
      : {}),
    ...(store && ['loading', 'ready', 'stale', 'unavailable'].includes(store)
      ? { store: store as MatrixStoreSnapshot['state'] }
      : {})
  }
}

function playgroundOrder(pack: MatrixTopUpPack, status: PlaygroundOrderState): ProtonOrder {
  return {
    amount_vnd: pack.amountVnd,
    bonus_protons: pack.bonusMicroProtons,
    checkout_url: 'https://pay.payos.vn/web/playground',
    created_at: new Date().toISOString(),
    id: '00000000-0000-4000-8000-87d96e07d1bf',
    order_code: 260_904_123,
    package_id: pack.id,
    paid_protons: pack.paidMicroProtons,
    paid_at: status === 'paid' ? new Date().toISOString() : null,
    // A sample transfer (never a real account): the QR and the five copy rows draw from it.
    payment:
      status === 'pending'
        ? {
            account_name: 'CONG TY ATUM',
            account_number: '0123456789',
            bank_bin: '970436',
            description: 'ATUM 260904123',
            expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
            qr_code: '00020101021238570010A000000727012700069704360113012345678900208QRIBFTTA5303704540620000058'
          }
        : null,
    status,
    total_protons: pack.totalMicroProtons
  }
}

/**
 * The Store, the wallet and the checkout for the playground (dev only), so every buying
 * path can be walked: a purchase spends the fixture balance (or is refused for too few
 * Protons), a pack creates a QR, `pay()` marks it paid and credits the balance. Nothing
 * here calls a provider.
 */
export class PlaygroundCommerce {
  wallet: MatrixWalletState
  store: MatrixStoreSnapshot
  checkout: MatrixCheckoutSnapshot
  private listeners = new Set<() => void>()

  constructor(options: PlaygroundCommerceOptions = {}) {
    const available =
      options.balance === undefined ? PLAYGROUND_WALLET.wallet!.balances.available : options.balance * MICRO

    this.wallet = {
      state: 'ready',
      wallet: { ...PLAYGROUND_WALLET.wallet!, balances: { ...PLAYGROUND_WALLET.wallet!.balances, available } }
    }

    this.store = { ...PLAYGROUND_CATALOG, state: options.store ?? 'ready' }
    this.checkout = {
      state: 'ready',
      packs: PLAYGROUND_PACKS,
      checkoutOpen: true,
      order: options.order ? playgroundOrder(PLAYGROUND_PACKS[1]!, options.order) : null,
      reconciliationPending: false,
      intent: null
    }
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Signed in, the window carries the wallet, the store and the checkout. Agents get the
   * store's assistant ids (the default one is the catalog's owner) so skills can be bought for them.
   */
  decorate(snapshot: MatrixSnapshot): MatrixSnapshot {
    if (!snapshot.identity) {
      return snapshot
    }

    const agents = snapshot.agents?.map((agent, index) => ({
      ...agent,
      assistantId:
        agent.assistantId ??
        (agent.isDefault ? PLAYGROUND_ASSISTANT : `00000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`)
    }))

    return { ...snapshot, agents, wallet: this.wallet, store: this.store, checkout: this.checkout }
  }

  /** The QR was paid: the order turns paid and the Protons land. */
  pay() {
    const order = this.checkout.order

    if (!order || order.status === 'paid') {
      return
    }

    this.credit(order.total_protons)
    this.setCheckout({
      ...this.checkout,
      order: { ...order, status: 'paid', payment: null, paid_at: new Date().toISOString() }
    })
  }

  storeBridge(): MatrixStoreBridge {
    return {
      refresh: async () => {},
      cancel: async id => {
        this.setStore({
          ...this.store,
          entitlements: this.store.entitlements.map(entitlement =>
            entitlement.id === id && entitlement.subscription
              ? { ...entitlement, subscription: { ...entitlement.subscription, state: 'cancelled' } }
              : entitlement
          )
        })
      },
      resume: async () => ({ outcome: 'uncertain' }),
      purchase: async intent => {
        await new Promise(resolve => setTimeout(resolve, 600))
        const item = this.store.items.find(value => value.offer?.id === intent.offerId)

        if (!item?.offer) {
          return { outcome: 'refused', code: 'offer_unavailable' }
        }

        const price = item.offer.priceMicroProtons
        const available = this.wallet.state === 'ready' ? this.wallet.wallet.balances.available : 0

        if (price > available) {
          return { outcome: 'refused', code: 'insufficient_protons' }
        }

        this.credit(-price)

        const entitlement: MatrixStoreEntitlement = {
          id: crypto.randomUUID(),
          itemId: item.itemId,
          kind: item.kind,
          state: 'active',
          assistantId: item.kind === 'pet' ? null : (intent.assistantId ?? PLAYGROUND_ASSISTANT),
          delivery: 'cloud',
          grantedAt: new Date().toISOString(),
          subscription:
            item.offer.billingInterval === 'month'
              ? {
                  state: 'active',
                  renewAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
                  priceMicroProtons: item.offer.renewalPriceMicroProtons ?? price,
                  offerVersion: item.offer.version
                }
              : null
        }

        this.setStore({
          ...this.store,
          // As on the server: the first-hatch offer leaves the catalog once it is bought.
          items:
            item.itemId === 'pet/hatch-first'
              ? this.store.items.filter(value => value.itemId !== item.itemId)
              : this.store.items,
          entitlements: [...this.store.entitlements, entitlement]
        })

        const result: MatrixStoreResult = {
          outcome: 'purchased',
          purchase: {
            id: crypto.randomUUID(),
            state: 'completed',
            itemId: item.itemId,
            offerId: item.offer.id,
            offerVersion: item.offer.version,
            idempotencyKey: crypto.randomUUID(),
            assistantId: entitlement.assistantId,
            amountMicroProtons: price,
            createdAt: entitlement.grantedAt
          },
          entitlement
        }

        return result
      }
    }
  }

  checkoutBridge(): MatrixCheckoutBridge {
    return {
      refresh: async () => {},
      start: async packId => {
        const pack = this.checkout.packs.find(value => value.id === packId)

        if (!pack) {
          throw new Error('matrix_checkout_unavailable')
        }

        this.setCheckout({ ...this.checkout, order: playgroundOrder(pack, 'creating') })
        await new Promise(resolve => setTimeout(resolve, 900))
        this.setCheckout({ ...this.checkout, order: playgroundOrder(pack, 'pending') })
      },
      status: async () => {},
      resume: async () => {},
      openCheckout: async () => {},
      dismissTerminal: async () => {
        this.setCheckout({ ...this.checkout, order: null })
      }
    }
  }

  walletBridge(): MatrixWalletBridge {
    return {
      refresh: async () => {},
      history: async () => {
        const history = playgroundHistory(Date.now())

        return { entries: history.entries, next: null }
      }
    }
  }

  private credit(microProtons: number) {
    if (this.wallet.state !== 'ready') {
      return
    }

    const balances = this.wallet.wallet.balances

    this.wallet = {
      state: 'ready',
      wallet: {
        ...this.wallet.wallet,
        balances: { ...balances, available: Math.max(0, balances.available + microProtons) }
      }
    }
  }

  private setStore(store: MatrixStoreSnapshot) {
    this.store = store
    this.emit()
  }

  private setCheckout(checkout: MatrixCheckoutSnapshot) {
    this.checkout = checkout
    this.emit()
  }

  private emit() {
    this.listeners.forEach(listener => listener())
  }
}
