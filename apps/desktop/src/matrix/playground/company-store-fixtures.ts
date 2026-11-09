import type {
  MatrixCompanyStoreActionResult,
  MatrixCompanyStoreAgent,
  MatrixCompanyStoreBridge,
  MatrixCompanyStoreIntent,
  MatrixCompanyStorePending,
  MatrixCompanyStoreSnapshot
} from '../../../shared/matrix-company-store'
import type { MatrixStoreEntitlement, MatrixStoreItem, MatrixStorePurchase } from '../../../shared/matrix-store'

/**
 * The company Store as `window.atumMatrix.companyStore` serves it, on fixture data, for the
 * playground and the Marketplace tests. No network, no ledger: a purchase spends the fixture
 * wallet's number only to pick its answer.
 *
 * Modes: `owner` (default), `member` (browse only), `short` (every priced purchase is refused
 * as insufficient, with the shortfall), `pending` (an unconfirmed hire is waiting), `uncertain`
 * (purchases come back unconfirmed until checked again).
 */
export type PlaygroundCompanyStoreMode = 'owner' | 'member' | 'short' | 'pending' | 'uncertain'

const MICRO = 1_000_000
export const PLAYGROUND_CHIEF_PRINCIPAL = '00000000-0000-4000-8000-9896148e0625'
const RESEARCHER_OFFER = '00000000-0000-4000-8000-61b0206ddea9'
const WRITER_OFFER = '00000000-0000-4000-8000-0e9205f48dc5'
const MARKETER_OFFER = '00000000-0000-4000-8000-e4b838e987a5'
const BOOKKEEPER_OFFER = '00000000-0000-4000-8000-2f5656bb7927'
const BRIEF_OFFER = '00000000-0000-4000-8000-e0dcc2846945'
const SHEETS_OFFER = '00000000-0000-4000-8000-137b71f77a47'
const TRAVEL_OFFER = '00000000-0000-4000-8000-3634b058d370'
export const PLAYGROUND_MARKETER_AGENT = '00000000-0000-4000-8000-3fff02fcbe73'
export const PLAYGROUND_BOOKKEEPER_AGENT = '00000000-0000-4000-8000-320ce5ad961c'
const MARKETER_ENTITLEMENT = '00000000-0000-4000-8000-42eb2dd5dae7'
const BOOKKEEPER_ENTITLEMENT = '00000000-0000-4000-8000-bd674f59504c'
const PENDING_KEY = '00000000-0000-4000-8000-7d04a28569a0'

function listing(
  kind: 'agent' | 'skill',
  id: string,
  glyph: string,
  title: [string, string],
  summary: [string, string],
  offer: { id: string; first: number; renewal?: number },
  extra: Partial<MatrixStoreItem> = {}
): MatrixStoreItem {
  return {
    kind,
    itemId: `${kind}/${id}`,
    title: { en: title[0], vi: title[1] },
    summary: { en: summary[0], vi: summary[1] },
    description: {
      en: `${summary[0]} Works in the company’s channels, DMs and Board.`,
      vi: `${summary[1]} Làm việc trong kênh, tin nhắn riêng và Bảng của công ty.`
    },
    tryPrompt: {
      en: kind === 'agent' ? `@${title[0]} what should we look at this week?` : `Brief me on ${title[0].toLowerCase()}.`,
      vi: kind === 'agent' ? `@${title[1]} tuần này mình nên xem gì?` : `Tóm tắt giúp mình ${title[1].toLowerCase()}.`
    },
    needs: kind === 'skill' ? ['internet'] : [],
    glyph,
    accent: '#5b7cfa',
    featured: false,
    sortOrder: 0,
    offer: {
      id: offer.id,
      version: 1,
      priceMicroProtons: offer.first * MICRO,
      scope: 'agent',
      delivery: 'cloud',
      billingInterval: offer.renewal === undefined ? 'one_time' : 'month',
      ...(offer.renewal === undefined ? {} : { renewalPriceMicroProtons: offer.renewal * MICRO })
    },
    deliverable: true,
    ownership: { state: 'available', source: null, assistantIds: [], until: null },
    ...extra
  }
}

function catalog(): MatrixStoreItem[] {
  return [
    listing('agent', 'researcher', '🔎', ['Researcher', 'Nhà nghiên cứu'], ['Finds, reads and sums up what matters.', 'Tìm, đọc và tóm tắt điều quan trọng.'], { id: RESEARCHER_OFFER, first: 8_000, renewal: 39_000 }),
    listing('agent', 'writer-editor', '✍', ['Writer & Editor', 'Biên tập viên'], ['Drafts posts, emails and docs in your voice.', 'Soạn bài, email và tài liệu theo giọng của bạn.'], { id: WRITER_OFFER, first: 39_000, renewal: 39_000 }),
    listing('agent', 'marketer', '📣', ['Marketer', 'Tiếp thị'], ['Plans campaigns and reports what worked.', 'Lên kế hoạch chiến dịch và báo cáo hiệu quả.'], { id: MARKETER_OFFER, first: 39_000, renewal: 39_000 }, {
      ownership: { state: 'owned', source: 'purchase', assistantIds: [PLAYGROUND_MARKETER_AGENT], until: null }
    }),
    listing('agent', 'bookkeeper', '🧾', ['Bookkeeper', 'Kế toán'], ['Keeps receipts, invoices and the month’s numbers straight.', 'Giữ hóa đơn, chứng từ và số liệu tháng gọn gàng.'], { id: BOOKKEEPER_OFFER, first: 29_000, renewal: 29_000 }, {
      ownership: { state: 'owned', source: 'purchase', assistantIds: [PLAYGROUND_BOOKKEEPER_AGENT], until: null }
    }),
    listing('skill', 'research-brief', '📑', ['Research brief', 'Bản tóm tắt nghiên cứu'], ['A sourced one-page brief on any topic.', 'Bản tóm tắt một trang có nguồn cho mọi chủ đề.'], { id: BRIEF_OFFER, first: 12_000 }),
    listing('skill', 'sheets-cleanup', '📊', ['Spreadsheet cleanup', 'Dọn bảng tính'], ['Fixes columns, dates and duplicates in shared sheets.', 'Sửa cột, ngày và dòng trùng trong bảng tính chung.'], { id: SHEETS_OFFER, first: 6_000 }),
    // A listing the company could not use yet: native would never list it, and the page must not either.
    listing('agent', 'travel-planner', '🧭', ['Travel planner', 'Lên lịch du lịch'], ['Plans trips.', 'Lên kế hoạch chuyến đi.'], { id: TRAVEL_OFFER, first: 19_000, renewal: 39_000 }, { deliverable: false })
  ]
}

function entitlement(id: string, itemId: string, agentId: string, state: 'active' | 'lapsed', renewAt: string): MatrixStoreEntitlement {
  return {
    id,
    itemId,
    kind: 'agent',
    state: 'active',
    assistantId: agentId,
    delivery: 'cloud',
    grantedAt: '2026-10-07T03:00:00.000Z',
    subscription: { state, renewAt, priceMicroProtons: 39_000 * MICRO, offerVersion: 1 },
    source: 'purchase'
  }
}

function purchase(intent: MatrixCompanyStoreIntent, key: string, agentId: string, item: MatrixStoreItem): MatrixStorePurchase {
  return {
    id: globalThis.crypto.randomUUID(),
    state: 'completed',
    itemId: item.itemId,
    offerId: intent.offerId,
    offerVersion: intent.offerVersion,
    idempotencyKey: key,
    assistantId: agentId,
    amountMicroProtons: item.offer!.priceMicroProtons
  } as MatrixStorePurchase
}

export interface PlaygroundCompanyStore extends MatrixCompanyStoreBridge {
  /** Calls by action, for tests. */
  calls: { action: string; companyId: string; input?: unknown }[]
}

export function playgroundCompanyStore(mode: PlaygroundCompanyStoreMode = 'owner'): PlaygroundCompanyStore {
  let items = catalog()
  let balance = 485_000 * MICRO
  let unconfirmed = mode === 'uncertain'

  let agents: MatrixCompanyStoreAgent[] = [
    { agentId: PLAYGROUND_MARKETER_AGENT, matrixUserId: '@marketer:atum.example', name: 'Marketer', avatar: null, itemId: 'agent/marketer', state: 'ready', renewAt: '2026-12-07T03:00:00.000Z' },
    { agentId: PLAYGROUND_BOOKKEEPER_AGENT, matrixUserId: '@bookkeeper:atum.example', name: 'Bookkeeper', avatar: null, itemId: 'agent/bookkeeper', state: 'paused', renewAt: null }
  ]

  let entitlements: MatrixStoreEntitlement[] = [
    entitlement(MARKETER_ENTITLEMENT, 'agent/marketer', PLAYGROUND_MARKETER_AGENT, 'active', '2026-12-07T03:00:00.000Z'),
    entitlement(BOOKKEEPER_ENTITLEMENT, 'agent/bookkeeper', PLAYGROUND_BOOKKEEPER_AGENT, 'lapsed', '2026-11-05T03:00:00.000Z')
  ]

  let pending: MatrixCompanyStorePending[] = mode === 'pending'
    ? [{ idempotencyKey: PENDING_KEY, offerId: WRITER_OFFER, offerVersion: 1, target: { hire: {} }, consentRenewal: true, purchaseId: null }]
    : []

  const calls: PlaygroundCompanyStore['calls'] = []

  const snapshot = (companyId: string): MatrixCompanyStoreSnapshot => ({
    companyId,
    state: 'ready',
    capability: 'supported',
    marketplaceAvailable: items.some(item => item.deliverable !== false),
    viewer: { canAct: mode !== 'member' },
    items: structuredClone(items),
    entitlements: structuredClone(entitlements),
    agents: structuredClone(agents),
    pending: structuredClone(pending)
  })

  const settle = (intent: MatrixCompanyStoreIntent, key: string): MatrixCompanyStoreActionResult => {
    const item = items.find(entry => entry.offer?.id === intent.offerId)

    if (!item?.offer) {
      return { outcome: 'refused', code: 'offer_unavailable' }
    }

    const price = item.offer.priceMicroProtons

    if (mode === 'short' || price > balance) {
      return { outcome: 'refused', code: 'insufficient_protons', shortfallMicroProtons: mode === 'short' ? price - 2_500 * MICRO : price - balance }
    }

    balance -= price
    pending = pending.filter(row => row.idempotencyKey !== key)
    const renewAt = '2026-12-07T03:00:00.000Z'

    if ('agentId' in intent.target) {
      const agentId = intent.target.agentId

      if (item.kind === 'agent') {
        agents = agents.map(agent => (agent.agentId === agentId ? { ...agent, state: 'ready', renewAt } : agent))
        entitlements = entitlements.map(row =>
          row.assistantId === agentId && row.subscription ? { ...row, subscription: { ...row.subscription, state: 'active', renewAt } } : row
        )
      } else {
        items = items.map(entry =>
          entry.itemId === item.itemId
            ? { ...entry, ownership: { state: 'owned', source: 'purchase', assistantIds: [...(entry.ownership?.assistantIds ?? []), agentId], until: null } }
            : entry
        )
      }

      return { outcome: 'purchased', purchase: purchase(intent, key, agentId, item), entitlement: null, agentId }
    }

    const agentId = globalThis.crypto.randomUUID()
    const name = item.title.en ?? item.itemId
    agents = [...agents, { agentId, matrixUserId: null, name, avatar: null, itemId: item.itemId, state: 'preparing', renewAt }]
    const row = entitlement(globalThis.crypto.randomUUID(), item.itemId, agentId, 'active', renewAt)
    entitlements = [...entitlements, row]
    items = items.map(entry =>
      entry.itemId === item.itemId ? { ...entry, ownership: { state: 'owned', source: 'purchase', assistantIds: [agentId], until: null } } : entry
    )

    return { outcome: 'purchased', purchase: purchase(intent, key, agentId, item), entitlement: row, agentId }
  }

  return {
    calls,
    async refresh(companyId) {
      calls.push({ action: 'refresh', companyId })

      return snapshot(companyId)
    },
    async purchase(companyId, input) {
      calls.push({ action: 'purchase', companyId, input })
      const key = globalThis.crypto.randomUUID()

      if (mode === 'member') {
        return { outcome: 'refused', code: 'denied' }
      }

      if (unconfirmed) {
        pending = [...pending, { ...input, idempotencyKey: key, purchaseId: null }]

        return { outcome: 'uncertain' }
      }

      return settle(input, key)
    },
    async resume(companyId, idempotencyKey) {
      calls.push({ action: 'resume', companyId, input: idempotencyKey })
      const row = pending.find(entry => entry.idempotencyKey === idempotencyKey)

      if (!row) {
        return { outcome: 'uncertain' }
      }

      unconfirmed = false
      const { idempotencyKey: key, purchaseId: _purchaseId, ...intent } = row

      return settle(intent, key)
    },
    async cancel(companyId, entitlementId) {
      calls.push({ action: 'cancel', companyId, input: entitlementId })
      entitlements = entitlements.map(row =>
        row.id === entitlementId && row.subscription ? { ...row, subscription: { ...row.subscription, state: 'cancelled' } } : row
      )
      agents = agents.map(agent =>
        entitlements.some(row => row.id === entitlementId && row.assistantId === agent.agentId) ? { ...agent, state: 'ending' } : agent
      )
    }
  }
}
