import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { vi as viLocale } from '@/i18n/vi'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'

import agentListings from '../../../electron/matrix/__fixtures__/store-agent-listings.json'
import hubListings from '../../../electron/matrix/__fixtures__/store-hub-listings.json'
import { storeCatalog } from '../../../electron/matrix/store-contract'
import type { AppDescriptor } from '../../../shared/app-catalog'
import type { MatrixAgentView } from '../../../shared/matrix'
import type { MatrixCheckoutSnapshot } from '../../../shared/matrix-checkout'
import type { MatrixStoreItem, MatrixStoreSnapshot } from '../../../shared/matrix-store'
import type { MatrixWalletState } from '../../../shared/matrix-wallet'

import type { DiscoverCheckout } from './checkout'
import { type DiscoverStore, MatrixDiscoverView, ownedForItem } from './discover-view'
import { localizedStoreText, StorePrice, storePriceText } from './store-card'
import { matrixStoreCopy, storeRequirements } from './store-copy'
import type { StoreAcquireOutcome, StoreReadSkills, StoreTryItem } from './store-detail'
import { MatrixStoreSidebar, useMatrixStoreNavigation } from './store-sidebar'
import { $matrixStoreHubRequest, $matrixStoreListingRequest, $matrixStoreShelfRequest } from './top-up'

afterEach(() => {
  cleanup()
  $matrixStoreShelfRequest.set(null)
  $matrixStoreHubRequest.set(null)
  $matrixStoreListingRequest.set(null)
})

const AGENT_A = '00000000-0000-4000-8000-8bf0ba5bdf79'
const AGENT_B = '00000000-0000-4000-8000-141ebcee2e7f'
const OFFER = '00000000-0000-4000-8000-9c5ecbf49b93'
const ENTITLEMENT = '00000000-0000-4000-8000-4e214e0bd003'
const MICRO = 1_000_000

it('reads the Store-compatible zh-TW card copy for the zh-hant desktop locale', () => {
  expect(localizedStoreText({ vi: 'Phân tích dữ liệu', en: 'Data analyst', 'zh-TW': '資料分析師' }, 'zh-hant')).toBe(
    '資料分析師'
  )
})

const moon: AppDescriptor = {
  app: 'moon',
  app_id: '00000000-0000-4000-8000-85d027de6061',
  app_version_id: '00000000-0000-4000-8000-dd7df1164681',
  name: { en: 'Moon' },
  subtitle: { en: 'A starter assistant' },
  description: null,
  icon: null,
  accent: '#8e75d6',
  affiliation: 'first_party',
  verified: true,
  verification: 'official',
  availability: 'available',
  roster_default: true,
  roster_order: 1,
  supported_modes: ['direct'],
  matrix_room_context: 'addressed_only',
  has_surface: false,
  link: { mode: 'none', state: 'never_linked' },
  bot: {
    v: 1,
    user_id: '@app-moon:atumplatform.com',
    handle: 'moon_bot',
    display_name: 'Moon',
    avatar: { url: 'https://cdn.atumplatform.com/moon.png', sha256: 'a'.repeat(64) },
    device_generation: 1,
    device: null,
    state: 'active',
    groups: true,
    consent: 'accepted',
    disclosure_version: 1,
    open_route_id: 'open',
    open_shared_memory: false,
    purchase_route_id: 'purchase'
  }
}

/** What the eye reads: the text without the screen-reader-only words, spaces collapsed as CSS does. */
function visibleText(element: Element) {
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll('.sr-only').forEach(node => node.remove())

  return (copy.textContent ?? '').replace(/\s+/gu, ' ').trim()
}

function item(kind: MatrixStoreItem['kind'], extra: Partial<MatrixStoreItem> = {}): MatrixStoreItem {
  return {
    itemId: `${kind}/focus`,
    kind,
    title: { en: 'Focus skill', vi: 'Kỹ năng tập trung' },
    summary: { en: 'Keep work on track', vi: 'Giữ công việc đúng hướng' },
    description: { en: 'A real provider catalog item.', vi: 'Mục danh mục từ nhà cung cấp.' },
    tryPrompt: { en: 'Plan my day', vi: 'Lập kế hoạch ngày của tôi' },
    needs: ['internet'],
    glyph: '✦',
    accent: '#3a62c9',
    featured: true,
    sortOrder: 1,
    offer: {
      id: OFFER,
      version: 2,
      priceMicroProtons: 4_001,
      ...(kind === 'agent' ? { renewalPriceMicroProtons: 5_002 } : {}),
      scope: kind === 'skill' ? 'agent' : 'account',
      billingInterval: kind === 'agent' ? 'month' : 'one_time',
      delivery: 'cloud'
    },
    ...extra
  }
}

const agents = [
  {
    principal: 'principal-a',
    userId: '@a:test',
    assistantId: AGENT_A,
    name: 'Ada',
    isDefault: false,
    ready: true,
    hermes: 'ready',
    atumModel: true
  },
  {
    principal: 'principal-b',
    userId: '@b:test',
    assistantId: AGENT_B,
    name: 'Ben',
    isDefault: false,
    ready: true,
    hermes: 'ready',
    atumModel: true
  }
] as MatrixAgentView[]

function wallet(protons: number): MatrixWalletState {
  return {
    state: 'ready',
    wallet: {
      unit: 'micro_proton',
      balances: { available: protons * MICRO, paid: protons * MICRO, earned: 0, promo: 0, held: 0 },
      allowance: null,
      checkoutOpen: true
    }
  }
}

function snapshot(items: MatrixStoreItem[], patch: Partial<MatrixStoreSnapshot> = {}): MatrixStoreSnapshot {
  return { state: 'ready', items, entitlements: [], purchases: [], pending: [], ...patch }
}

function checkoutFor(patch: Partial<MatrixCheckoutSnapshot> = {}): DiscoverCheckout {
  return {
    snapshot: {
      state: 'ready',
      packs: [
        {
          id: 'protons-50k',
          amountVnd: 50_000,
          paidMicroProtons: 50_000 * MICRO,
          bonusMicroProtons: 0,
          totalMicroProtons: 50_000 * MICRO
        }
      ],
      checkoutOpen: true,
      order: null,
      reconciliationPending: false,
      intent: null,
      ...patch
    },
    onRefresh: vi.fn(),
    onStart: vi.fn(async () => {}),
    onStatus: vi.fn(async () => {}),
    onResume: vi.fn(async () => {}),
    onOpenCheckout: vi.fn(async () => {}),
    onDismissTerminal: vi.fn(async () => {})
  }
}

interface RenderOptions {
  store?: Partial<DiscoverStore>
  checkout?: DiscoverCheckout
  wallet?: MatrixWalletState
  onTopUpPage?: () => void
  tryItem?: StoreTryItem
  apps?: React.ComponentProps<typeof MatrixDiscoverView>['apps']
  locale?: 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant'
  agents?: MatrixAgentView[]
  readSkills?: StoreReadSkills
}

function renderStore(options: RenderOptions = {}) {
  const store: DiscoverStore = {
    snapshot: snapshot([item('skill'), item('agent', { itemId: 'agent/mentor', title: { en: 'Mentor' } })]),
    onAcquire: vi.fn(
      async (): Promise<StoreAcquireOutcome> => ({
        outcome: 'purchased',
        purchase: {
          id: ENTITLEMENT,
          state: 'delivery_pending',
          itemId: 'skill/focus',
          offerId: OFFER,
          offerVersion: 2,
          idempotencyKey: ENTITLEMENT,
          assistantId: AGENT_A,
          amountMicroProtons: 4_001,
          createdAt: '2026-10-01T00:00:00Z'
        },
        entitlement: null
      })
    ),
    onCancel: vi.fn(async () => {}),
    onResume: vi.fn(async (): Promise<StoreAcquireOutcome> => ({ outcome: 'uncertain' })),
    onRetry: vi.fn(),
    ...options.store
  }

  const apps = options.apps ?? { state: 'ready' as const, items: [] }

  function StoreHarness({ next, nextWallet }: { next: DiscoverStore; nextWallet?: MatrixWalletState }) {
    const navigation = useMatrixStoreNavigation({
      active: true,
      appsAvailable: apps.state === 'ready' && apps.items.length > 0,
      checkoutAvailable: Boolean(options.checkout),
      storeUnavailable: next.snapshot.state === 'unavailable'
    })

    return (
      <I18nProvider configClient={null} initialLocale={options.locale ?? 'en'}>
        <MatrixStoreSidebar {...navigation} />
        <MatrixDiscoverView
          agents={options.agents ?? agents}
          apps={apps}
          checkout={options.checkout}
          onTopUpPage={options.onTopUpPage}
          readSkills={options.readSkills}
          {...navigation}
          store={next}
          tryItem={options.tryItem}
          wallet={nextWallet}
        />
      </I18nProvider>
    )
  }

  const view = (next: DiscoverStore, nextWallet = options.wallet) => (
    <StoreHarness next={next} nextWallet={nextWallet} />
  )

  const rendered = render(view(store))

  return {
    store,
    rerender: (next: DiscoverStore, nextWallet?: MatrixWalletState) => rendered.rerender(view(next, nextWallet))
  }
}

describe('Matrix Store', () => {
  // Moon and Andy are apps with a bot. The Assistants shelf holds only hireable assistants
  // from the Store catalog, and says "coming soon" while none is on sale (0.19.3 diagnosis 2.6A).
  const andy: AppDescriptor = {
    ...moon,
    app: 'andy',
    app_id: '00000000-0000-4000-8000-4bcc13e151d8',
    app_version_id: '00000000-0000-4000-8000-a28c50c0e7e8',
    name: { en: 'Andy' },
    bot: { ...moon.bot!, user_id: '@app-andy:atumplatform.com', handle: 'andy_bot', display_name: 'Andy' }
  }

  const launchAssistants = storeCatalog(agentListings)

  it('shows current catalog description, data use and prompt in one sheet with one Get action', () => {
    renderStore({ store: { snapshot: snapshot([item('skill')]) } })
    fireEvent.click(screen.getByText('Focus skill'))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('A real provider catalog item.')).toBeTruthy()
    expect(within(dialog).getByText('Needs internet')).toBeTruthy()
    expect(dialog.querySelector('[data-store-try-prompt]')?.textContent).toContain('Plan my day')
    expect(within(dialog).getByRole('button', { name: 'Get · 0.004001 Protons' })).toBeTruthy()
    expect(dialog.querySelectorAll('[data-store-acquire]')).toHaveLength(1)
  })

  it('puts Store search and categories in the roster and omits recommendations without store v2 data', () => {
    const copy = matrixStoreCopy('en')
    renderStore({ store: { snapshot: snapshot([item('skill')]) } })

    const sidebar = window.document.querySelector('[data-matrix-store-sidebar]') as HTMLElement
    expect(within(sidebar).getByRole('searchbox', { name: copy.search })).toBeTruthy()
    expect(within(sidebar).getByRole('button', { name: copy.discover }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByText('Picked for you')).toBeNull()

    fireEvent.click(within(sidebar).getByRole('button', { name: copy.skills }))
    fireEvent.change(within(sidebar).getByRole('searchbox', { name: copy.search }), {
      target: { value: 'missing' }
    })
    expect(screen.getByText(copy.searchEmpty)).toBeTruthy()
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
    'never puts app bots on the Assistants shelf, and says coming soon while none is on sale (%s)',
    locale => {
      const copy = matrixStoreCopy(locale)

      renderStore({
        locale,
        store: { snapshot: snapshot([item('skill')]) },
        apps: { state: 'ready', items: [moon, andy] }
      })

      fireEvent.click(screen.getByRole('button', { name: copy.agents }))
      expect(window.document.querySelector('[data-store-app]')).toBeNull()
      expect(screen.queryByText('Moon')).toBeNull()
      expect(screen.queryByText('Andy')).toBeNull()
      const soon = window.document.querySelector('[data-store-agents-soon]') as HTMLElement
      expect(soon.textContent).toBe(copy.agentsSoon + copy.agentsSoonNote)
    }
  )

  it('shows the Store outage on the Assistants shelf, not the app bots, when the catalog cannot load', () => {
    const retry = vi.fn()
    const copy = matrixStoreCopy('vi')

    renderStore({
      locale: 'vi',
      store: { snapshot: snapshot([], { state: 'unavailable' }), onRetry: retry },
      apps: { state: 'ready', items: [moon, andy] }
    })

    fireEvent.click(screen.getByRole('button', { name: copy.agents }))
    expect(screen.getByText(copy.storeUnavailable)).toBeTruthy()
    expect(window.document.querySelector('[data-store-app]')).toBeNull()
    expect(window.document.querySelector('[data-store-agents-soon]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: copy.retry }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('shows loading on the Assistants shelf before the catalog arrives, not coming soon', () => {
    renderStore({
      locale: 'vi',
      store: { snapshot: snapshot([], { state: 'loading' }) },
      apps: { state: 'ready', items: [moon] }
    })

    fireEvent.click(screen.getByRole('button', { name: matrixStoreCopy('vi').agents }))
    expect(window.document.querySelector('[aria-busy]')).not.toBeNull()
    expect(window.document.querySelector('[data-store-agents-soon]')).toBeNull()
    expect(window.document.querySelector('[data-store-app]')).toBeNull()
  })

  it('lists the published launch assistants on the Assistants shelf and hires one with the existing flow', () => {
    const copy = matrixStoreCopy('vi')
    const researcher = launchAssistants.find(entry => entry.itemId === 'agent/researcher')!

    const { store } = renderStore({
      locale: 'vi',
      store: { snapshot: snapshot([item('skill'), ...launchAssistants]) },
      apps: { state: 'ready', items: [moon, andy] }
    })

    fireEvent.click(screen.getByRole('button', { name: copy.agents }))

    for (const title of ['Nhà nghiên cứu', 'Gia sư tiếng Anh', 'Chuyên viên marketing', 'Trợ lý bán hàng online']) {
      expect(screen.getByText(title)).toBeTruthy()
    }

    expect(screen.queryByText('Kỹ năng tập trung')).toBeNull()
    expect(window.document.querySelector('[data-store-app]')).toBeNull()
    expect(window.document.querySelector('[data-store-agents-soon]')).toBeNull()

    fireEvent.click(screen.getByText('Nhà nghiên cứu'))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(dialog.querySelector('[data-store-acquire]')!)
    expect(store.onAcquire).toHaveBeenCalledWith(researcher, undefined, true)
  })

  it('says nothing matched, not coming soon, when a search hides every assistant', () => {
    const copy = matrixStoreCopy('vi')

    renderStore({ locale: 'vi', store: { snapshot: snapshot(launchAssistants) } })

    fireEvent.click(screen.getByRole('button', { name: copy.agents }))
    fireEvent.change(screen.getByRole('searchbox', { name: copy.search }), { target: { value: 'không có gì' } })
    expect(screen.getByText(copy.searchEmpty)).toBeTruthy()
    expect(window.document.querySelector('[data-store-agents-soon]')).toBeNull()
  })

  it('lists each app once, on Apps only, beside a full catalog', () => {
    renderStore({
      locale: 'vi',
      store: { snapshot: snapshot([item('skill'), ...launchAssistants]) },
      apps: { state: 'ready', items: [moon, andy] }
    })

    const copy = matrixStoreCopy('vi')

    for (const shelf of [copy.discover, copy.agents, copy.skills, copy.pets, copy.purchased]) {
      fireEvent.click(screen.getByRole('button', { name: shelf }))
      expect(window.document.querySelector('[data-store-app]')).toBeNull()
    }

    fireEvent.click(screen.getByRole('button', { name: copy.apps }))

    const shown = Array.from(window.document.querySelectorAll('[data-store-app]')).map(node =>
      node.getAttribute('data-store-app')
    )

    expect(shown).toEqual([moon.app_id, andy.app_id])
    expect(screen.queryByText('Nhà nghiên cứu')).toBeNull()
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
    'labels an owned gift and separates Gifts from Purchased in %s',
    locale => {
      const copy = matrixStoreCopy(locale)
      const gift = item('pet', {
        itemId: 'pet/gigi',
        title: { en: 'Gigi', vi: 'Gigi' },
        ownership: { state: 'owned', source: 'gift', assistantIds: [], until: null }
      })
      const bought = item('pet', { itemId: 'pet/luna', title: { en: 'Luna', vi: 'Luna' } })
      const grant = {
        id: ENTITLEMENT,
        itemId: gift.itemId,
        kind: 'pet' as const,
        state: 'active' as const,
        assistantId: null,
        delivery: 'bundled' as const,
        grantedAt: '2026-10-01T00:00:00Z',
        subscription: null
      }
      renderStore({
        locale,
        store: {
          snapshot: snapshot([gift, bought], {
            entitlements: [
              { ...grant, source: 'gift' },
              { ...grant, id: OFFER, itemId: bought.itemId }
            ]
          })
        }
      })
      const card = document.querySelector('[data-store-item="pet/gigi"]') as HTMLElement
      expect(within(card).getByRole('button', { name: copy.itemAction(copy.open, 'Gigi') })).toBeTruthy()
      expect(within(card).queryByText(copy.gift)).toBeNull()
      expect(card.querySelector('[data-kind="protons"]')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: copy.purchased }))
      const gifts = document.querySelector('[data-store-gifts]') as HTMLElement
      expect(within(gifts).getByRole('heading', { name: copy.gifts })).toBeTruthy()
      expect(within(gifts).getByText('Gigi')).toBeTruthy()
      expect(within(gifts).queryByText('Luna')).toBeNull()
      expect(screen.getByText('Luna')).toBeTruthy()
    }
  )

  it('uses server ownership without an entitlement cache: Gigi has no price or Buy action', () => {
    const gift = item('pet', {
      itemId: 'pet/gigi',
      title: { en: 'Gigi' },
      ownership: { state: 'owned', source: 'gift', assistantIds: [], until: null }
    })
    renderStore({ store: { snapshot: snapshot([gift]) } })
    fireEvent.click(screen.getByText('Gigi'))
    const dialog = screen.getByRole('dialog')
    expect((within(dialog).getByRole('button', { name: 'Gift' }) as HTMLButtonElement).disabled).toBe(true)
    expect(dialog.querySelector('[data-store-acquire]')).toBeNull()
    expect(dialog.querySelector('[data-kind="protons"]')).toBeNull()
  })

  it.each(['available', 'visiting'] as const)('a server %s pet remains purchasable despite a cached grant', state => {
    const pet = item('pet', {
      title: { en: 'Gigi' },
      ownership:
        state === 'available'
          ? { state, source: null, assistantIds: [], until: null }
          : { state, source: 'visit', assistantIds: [], until: '2026-10-13T00:00:00Z' }
    })
    const { store } = renderStore({
      store: {
        snapshot: snapshot([pet], {
          entitlements: [
            {
              id: ENTITLEMENT,
              itemId: pet.itemId,
              kind: 'pet',
              state: 'active',
              assistantId: null,
              delivery: 'bundled',
              grantedAt: '2026-10-01T00:00:00Z',
              subscription: null
            }
          ]
        })
      }
    })
    fireEvent.click(screen.getByText('Gigi'))
    const dialog = screen.getByRole('dialog')
    if (state === 'visiting') {
      expect(within(dialog).getByText(matrixStoreCopy('en').visiting)).toBeTruthy()
    }
    const acquire = dialog.querySelector('[data-store-acquire]') as HTMLButtonElement
    expect(acquire.disabled).toBe(false)
    fireEvent.click(acquire)
    expect(store.onAcquire).toHaveBeenCalledWith(pet, undefined)
  })

  it('a server-owned skill for A can be bought for B', () => {
    const skill = item('skill', {
      ownership: { state: 'owned', source: 'purchase', assistantIds: [AGENT_A], until: null }
    })
    const { store } = renderStore({ store: { snapshot: snapshot([skill]) } })
    fireEvent.click(screen.getByText('Focus skill'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Adds to Ben.')).toBeTruthy()
    fireEvent.click(dialog.querySelector('[data-store-acquire]')!)
    expect(store.onAcquire).toHaveBeenCalledWith(skill, AGENT_B)
  })

  it.each([
    ['en', 'Store', en],
    ['vi', 'Cửa hàng', viLocale],
    ['ja', 'ストア', ja],
    ['zh', '商店', zh],
    ['zh-hant', '商店', zhHant]
  ] as const)('calls the place one name, on the rail and on the page, in %s', (locale, title, strings) => {
    const copy = matrixStoreCopy(locale)
    expect(copy.title).toBe(title)
    expect(strings.matrixShell.discover).toBe(copy.title)
    expect(copy.purchaseUncertain).not.toBe('')
    expect(copy.cancelMonthly).not.toBe('')
    expect(copy.itemByAtum(copy.kind.skill)).not.toBe('')
    expect(copy.whatItUses).not.toBe('')
    expect(copy.trySaying).not.toBe('')
    expect(copy.addsTo('Atum')).not.toBe('')
    expect(copy.getFor(`4,000 ${copy.protons}`)).not.toBe('')
    // Every locale reads both requirement tokens the catalog uses in words.
    expect(storeRequirements(['internet', 'runs-scripts'], copy)).toHaveLength(2)
  })

  it('says requirements in words and leaves out a token this build does not know', () => {
    const copy = matrixStoreCopy('en')
    expect(storeRequirements(['internet', 'teleport', 'runs-scripts'], copy)).toEqual([
      copy.requirements.internet,
      copy.requirements['runs-scripts']
    ])
  })

  it('keeps an exact micro-Proton offer exact and never calls a missing offer free', () => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <>
          <span data-testid="priced">
            <StorePrice copy={matrixStoreCopy('en')} item={item('skill')} locale="en" owned={false} />
          </span>
          <span data-testid="missing">
            <StorePrice copy={matrixStoreCopy('en')} item={item('skill', { offer: null })} locale="en" owned={false} />
          </span>
        </>
      </I18nProvider>
    )
    expect(screen.getByTestId('priced').textContent).toContain('0.004001 Protons')
    expect(screen.getByTestId('missing').textContent).toBe('Unavailable')
  })

  it('draws every Protons price with the Proton mark and leaves free and unavailable as words', () => {
    const copy = matrixStoreCopy('en')
    const hire = item('agent').offer!

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <>
          <span data-testid="priced">
            <StorePrice copy={copy} item={item('skill')} locale="en" owned={false} />
          </span>
          <span data-testid="monthly">
            <StorePrice
              copy={copy}
              item={item('agent', { offer: { ...hire, priceMicroProtons: 19_000 * MICRO, renewalPriceMicroProtons: 39_000 * MICRO } })}
              locale="en"
              owned={false}
            />
          </span>
          <span data-testid="free">
            <StorePrice copy={copy} item={item('skill', { offer: { ...item('skill').offer!, priceMicroProtons: 0 } })} locale="en" owned={false} />
          </span>
          <span data-testid="missing">
            <StorePrice copy={copy} item={item('skill', { offer: null })} locale="en" owned={false} />
          </span>
        </>
      </I18nProvider>
    )

    const priced = screen.getByTestId('priced')
    expect(priced.querySelectorAll('svg[data-proton-mark]')).toHaveLength(1)
    expect(priced.querySelector('svg[data-proton-mark]')?.getAttribute('aria-hidden')).toBe('true')
    expect(visibleText(priced)).toBe('0.004001')
    // A monthly hire marks both amounts; the words still read in full.
    const monthly = screen.getByTestId('monthly')
    expect(monthly.querySelectorAll('svg[data-proton-mark]')).toHaveLength(2)
    const words = storePriceText({ ...hire, priceMicroProtons: 19_000 * MICRO, renewalPriceMicroProtons: 39_000 * MICRO }, copy, 'en')
    // The separator keeps its no-break space; compare the words, not the spacing.
    const spaced = (text: string) => text.replace(/\s+/gu, ' ')
    expect(spaced(monthly.textContent ?? '')).toBe(spaced(words))
    expect(visibleText(monthly)).toBe(spaced(words.replace(` ${copy.protons}`, '')))
    expect(visibleText(monthly)).not.toContain(copy.protons)
    expect(screen.getByTestId('free').textContent).toBe('Free')
    expect(screen.getByTestId('free').querySelector('svg')).toBeNull()
    expect(screen.getByTestId('missing').querySelector('svg')).toBeNull()
  })

  it('marks a priced row and the Get button, and leaves a free Get without the mark', () => {
    const free = item('skill', { itemId: 'skill/free', title: { en: 'Free skill' }, offer: { ...item('skill').offer!, priceMicroProtons: 0 } })
    renderStore({ store: { snapshot: snapshot([item('skill'), free]) } })

    const paidRow = screen.getByRole('button', { name: '0.004001 Protons: Focus skill' })
    expect(paidRow.querySelector('svg[data-proton-mark]')).toBeTruthy()
    expect(visibleText(paidRow)).toBe('0.004001')
    const freeRow = window.document.querySelector('[data-store-item="skill/free"] button')!
    expect(freeRow.textContent).toBe('Get')
    expect(freeRow.querySelector('svg')).toBeNull()

    fireEvent.click(screen.getByText('Focus skill'))
    const get = within(screen.getByRole('dialog')).getByRole('button', { name: 'Get · 0.004001 Protons' })
    expect(get.querySelector('svg[data-proton-mark]')).toBeTruthy()
    expect(visibleText(get)).toBe('Get · 0.004001')
  })

  it('never lets a monthly hire headline understate what the person keeps paying', () => {
    const copy = matrixStoreCopy('en')
    const hire = item('agent').offer!

    const intro = storePriceText(
      { ...hire, priceMicroProtons: 19_000 * MICRO, renewalPriceMicroProtons: 39_000 * MICRO },
      copy,
      'en'
    )

    expect(intro).toContain('19,000')
    expect(intro).toContain('39,000')
    expect(intro.indexOf('19,000')).toBeLessThan(intro.indexOf('39,000'))

    const freeTrial = storePriceText(
      { ...hire, priceMicroProtons: 0, renewalPriceMicroProtons: 39_000 * MICRO },
      copy,
      'en'
    )

    expect(freeTrial).not.toBe(copy.free)
    expect(freeTrial).toContain('39,000')

    const flat = storePriceText(
      { ...hire, priceMicroProtons: 39_000 * MICRO, renewalPriceMicroProtons: 39_000 * MICRO },
      copy,
      'en'
    )

    expect(flat.match(/39,000/g)).toHaveLength(1)
    expect(flat).toContain(copy.monthly)

    // The pill reads the same words whether it sits on one line or two.
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <span data-testid="stacked">
          <StorePrice
            copy={copy}
            item={item('agent', {
              offer: { ...hire, priceMicroProtons: 19_000 * MICRO, renewalPriceMicroProtons: 39_000 * MICRO }
            })}
            locale="en"
            owned={false}
            stacked
          />
        </span>
      </I18nProvider>
    )
    expect(screen.getByTestId('stacked').textContent).toBe(intro)
  })

  it('marks a skill owned on the grid when any assistant has it, says who, and buys for one that does not', async () => {
    const skill = item('skill')

    const { store } = renderStore({
      store: {
        snapshot: snapshot([skill], {
          entitlements: [
            {
              id: ENTITLEMENT,
              itemId: skill.itemId,
              kind: 'skill',
              state: 'active',
              assistantId: AGENT_B,
              delivery: 'cloud',
              grantedAt: '2026-10-01T00:00:00Z',
              subscription: null
            }
          ]
        })
      }
    })

    expect(ownedForItem(skill, store.snapshot.entitlements, AGENT_A)).toBe(false)
    expect(ownedForItem(skill, store.snapshot.entitlements, AGENT_B)).toBe(true)
    expect(screen.getByRole('button', { name: 'Open: Focus skill' })).toBeTruthy()
    expect(screen.queryByText('Owned · Ben')).toBeNull()
    fireEvent.click(screen.getByText('Focus skill'))
    const dialog = screen.getByRole('dialog')
    // The dialog opens on the assistant that does not have it yet.
    expect(within(dialog).getByText('Adds to Ada.')).toBeTruthy()
    fireEvent.click(dialog.querySelector('[data-store-acquire]')!)
    expect(store.onAcquire).toHaveBeenCalledWith(skill, AGENT_A)
    expect(await screen.findByText(matrixStoreCopy('en').purchasePending)).toBeTruthy()
  })

  it('teaches a paid skill only to assistants on Atum’s AI, and says why one on its own model is missing', () => {
    const skill = item('skill')
    const ownModelB = agents.map(agent => (agent.assistantId === AGENT_B ? { ...agent, atumModel: false } : agent))
    const { store } = renderStore({ store: { snapshot: snapshot([skill]) }, agents: ownModelB })
    fireEvent.click(screen.getByText('Focus skill'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Adds to Ada.')).toBeTruthy()
    expect(within(dialog).queryByRole('combobox', { name: 'Add to assistant' })).toBeNull()
    expect(within(dialog).getByText(matrixStoreCopy('en').needsAtumAi)).toBeTruthy()
    fireEvent.click(dialog.querySelector('[data-store-acquire]')!)
    expect(store.onAcquire).toHaveBeenCalledWith(skill, AGENT_A)
  })

  it('offers no assistant to teach when every one answers with its own model', () => {
    const skill = item('skill')
    const { store } = renderStore({
      store: { snapshot: snapshot([skill]) },
      agents: agents.map(agent => ({ ...agent, atumModel: false }))
    })
    fireEvent.click(screen.getByText('Focus skill'))
    const dialog = screen.getByRole('dialog')

    expect(within(dialog).queryByRole('combobox', { name: 'Add to assistant' })).toBeNull()
    expect(within(dialog).getByText(matrixStoreCopy('en').needsAtumAi)).toBeTruthy()
    const get = dialog.querySelector('[data-store-acquire]') as HTMLButtonElement
    expect(get.disabled).toBe(true)
    fireEvent.click(get)
    expect(store.onAcquire).not.toHaveBeenCalled()
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)('says why an own-model assistant is missing in %s', locale => {
    expect(matrixStoreCopy(locale).needsAtumAi).not.toBe('')
    expect(matrixStoreCopy(locale).needsAtumAi).not.toBe(matrixStoreCopy(locale).noTargetAgent)
  })

  it('calls the existing purchase controller from Get instead of inferring affordability from wallet data', async () => {
    const skill = item('skill', { offer: { ...item('skill').offer!, priceMicroProtons: 4_000 * MICRO } })
    const { store } = renderStore({
      checkout: checkoutFor(),
      store: { snapshot: snapshot([skill]) },
      wallet: wallet(1_200)
    })

    fireEvent.click(screen.getByText('Focus skill'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('You have 1,200 Protons')).toBeTruthy()
    expect(dialog.querySelector('[data-store-shortfall]')).toBeNull()
    fireEvent.click(dialog.querySelector('[data-store-acquire]')!)
    await waitFor(() => expect(store.onAcquire).toHaveBeenCalledWith(skill, AGENT_A))
  })

  it('swaps to Top up after a refusal over Protons the sheet could not see, and offers the purchase once topped up', async () => {
    const skill = item('skill', { offer: { ...item('skill').offer!, priceMicroProtons: 4_000 * MICRO } })

    const { store } = renderStore({
      checkout: checkoutFor(),
      store: {
        snapshot: snapshot([skill]),
        onAcquire: vi.fn(
          async (): Promise<StoreAcquireOutcome> => ({ outcome: 'refused', code: 'insufficient_protons' })
        )
      },
      // The wallet has not been read yet: the Store is asked, and refuses.
      wallet: { state: 'loading', wallet: null }
    })

    fireEvent.click(screen.getByText('Focus skill'))
    fireEvent.click(screen.getByRole('dialog').querySelector('[data-store-acquire]')!)
    await within(screen.getByRole('dialog')).findByRole('button', { name: 'Top up' })
    expect(within(screen.getByRole('dialog')).getByText(matrixStoreCopy('en').refusedShort('skill'))).toBeTruthy()

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Top up' }))
    expect(screen.getByRole('dialog').querySelector('[data-matrix-topup-pack="protons-50k"]')).toBeTruthy()
    expect(store.onAcquire).toHaveBeenCalledOnce()
  })

  it('opens Atum’s payments page for a short balance when this build has no in-app checkout', async () => {
    const onTopUpPage = vi.fn()

    renderStore({
      onTopUpPage,
      store: {
        snapshot: snapshot([item('pet', { itemId: 'pet/miu', title: { en: 'Miu' } })]),
        onAcquire: vi.fn(
          async (): Promise<StoreAcquireOutcome> => ({ outcome: 'refused', code: 'insufficient_protons' })
        )
      },
      wallet: wallet(10)
    })

    fireEvent.click(screen.getByText('Miu'))
    fireEvent.click(screen.getByRole('dialog').querySelector('[data-store-acquire]')!)
    fireEvent.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'Top up' }))
    expect(onTopUpPage).toHaveBeenCalledOnce()
  })

  it('offers Try it now once a purchase is ready, in the chosen assistant’s chat', async () => {
    const open = vi.fn()
    const tryItem = vi.fn<StoreTryItem>(() => open)
    const skill = item('skill')

    renderStore({
      store: {
        snapshot: snapshot([skill]),
        onAcquire: vi.fn(
          async (): Promise<StoreAcquireOutcome> => ({
            outcome: 'purchased',
            purchase: {
              id: ENTITLEMENT,
              state: 'completed',
              itemId: skill.itemId,
              offerId: OFFER,
              offerVersion: 2,
              idempotencyKey: ENTITLEMENT,
              assistantId: AGENT_A,
              amountMicroProtons: 4_001,
              createdAt: '2026-10-01T00:00:00Z'
            },
            entitlement: null
          })
        )
      },
      tryItem
    })

    fireEvent.click(screen.getByText('Focus skill'))
    fireEvent.click(screen.getByRole('dialog').querySelector('[data-store-acquire]')!)
    fireEvent.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'Try it now' }))
    expect(tryItem).toHaveBeenCalledWith(skill, AGENT_A)
    expect(open).toHaveBeenCalledOnce()
  })

  it('closes from its own x', () => {
    renderStore()
    fireEvent.click(screen.getByText('Focus skill'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a refreshed price in an open dialog', () => {
    const skill = item('skill')
    const { store, rerender } = renderStore({ store: { snapshot: snapshot([skill]) } })
    fireEvent.click(screen.getByText('Focus skill'))
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Get · 0.004001 Protons' })).toBeTruthy()
    rerender({
      ...store,
      snapshot: snapshot([{ ...skill, offer: { ...skill.offer!, version: 3, priceMicroProtons: 5 * MICRO } }])
    })
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Get · 5 Protons' })).toBeTruthy()
  })

  it('finds localized catalog content, and Purchased names a purchase in progress instead of printing its id', () => {
    const resume = vi.fn(async () => ({ outcome: 'uncertain' as const }))

    renderStore({
      store: {
        snapshot: snapshot([item('skill')], {
          pending: [
            { offerId: OFFER, offerVersion: 2, assistantId: AGENT_A, idempotencyKey: ENTITLEMENT, purchaseId: null },
            {
              offerId: '00000000-0000-4000-8000-cf8b5512d1b8',
              offerVersion: 1,
              idempotencyKey: '00000000-0000-4000-8000-c1f2bc0a3f70',
              purchaseId: null
            }
          ]
        }),
        onResume: resume
      }
    })

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the store' }), { target: { value: 'focus' } })
    expect(screen.getByText('Focus skill')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Purchased' }))
    const pending = window.document.querySelector('[data-store-pending]')!
    expect(pending.textContent).toContain('Focus skill')
    expect(pending.textContent).toContain(matrixStoreCopy('en').purchaseInProgress)
    expect(pending.textContent).not.toContain(OFFER)
    expect(pending.textContent).not.toContain('0000000000ee')
    fireEvent.click(within(pending as HTMLElement).getAllByRole('button', { name: 'Check' })[0]!)
    expect(resume).toHaveBeenCalledWith(ENTITLEMENT)
  })

  it('opens an owned skill from Purchased in its assistant’s chat', () => {
    const open = vi.fn()
    const tryItem = vi.fn<StoreTryItem>(() => open)
    const skill = item('skill')

    renderStore({
      store: {
        snapshot: snapshot([skill], {
          entitlements: [
            {
              id: ENTITLEMENT,
              itemId: skill.itemId,
              kind: 'skill',
              state: 'active',
              assistantId: AGENT_B,
              delivery: 'cloud',
              grantedAt: '2026-10-01T00:00:00Z',
              subscription: null
            }
          ]
        })
      },
      tryItem
    })

    fireEvent.click(screen.getByRole('button', { name: 'Purchased' }))
    const row = window.document.querySelector(`[data-store-entitlement="${ENTITLEMENT}"]`) as HTMLElement
    expect(row.textContent).toContain('Owned · Ben')
    fireEvent.click(within(row).getByRole('button', { name: 'Open' }))
    expect(tryItem).toHaveBeenCalledWith(skill, AGENT_B)
    expect(open).toHaveBeenCalledOnce()
  })

  it('asks for the monthly renewal box only once Get is pressed without it, and hires with consent', () => {
    const hire = item('agent', { itemId: 'agent/mentor', title: { en: 'Mentor', vi: 'Cố vấn' } })
    const { store } = renderStore({ store: { snapshot: snapshot([hire]) } })
    const copy = matrixStoreCopy('en')

    fireEvent.click(screen.getByText('Mentor'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByText(copy.hireConsentRequired)).toBeNull()
    expect(dialog.textContent).toContain('0.004001 Protons first month')
    expect(dialog.textContent).toContain('then 0.005002/mo')
    expect(within(dialog).queryByText(/^Today:/)).toBeNull()
    expect(within(dialog).queryByText(/^Then:/)).toBeNull()
    fireEvent.click(dialog.querySelector('[data-store-acquire]')!)
    expect(store.onAcquire).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('alert').textContent).toBe(copy.hireConsentRequired)
    expect(window.document.activeElement).toBe(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('checkbox'))
    expect(within(dialog).queryByText(copy.hireConsentRequired)).toBeNull()
    fireEvent.click(dialog.querySelector('[data-store-acquire]')!)
    expect(store.onAcquire).toHaveBeenCalledWith(hire, undefined, true)
  })

  it('lets a person cancel an active monthly entitlement from Purchased', () => {
    const cancel = vi.fn(async () => {})
    const hire = item('agent', { itemId: 'agent/mentor', title: { en: 'Mentor' } })

    renderStore({
      store: {
        snapshot: snapshot([hire], {
          entitlements: [
            {
              id: ENTITLEMENT,
              itemId: hire.itemId,
              kind: 'agent',
              state: 'active',
              assistantId: AGENT_A,
              delivery: 'cloud',
              grantedAt: '2026-10-01T00:00:00Z',
              subscription: {
                state: 'active',
                renewAt: '2026-11-01T00:00:00Z',
                priceMicroProtons: 1_000_001,
                offerVersion: 2
              }
            }
          ]
        }),
        onCancel: cancel
      }
    })

    fireEvent.click(screen.getByRole('button', { name: 'Purchased' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel monthly hire' }))
    expect(cancel).toHaveBeenCalledWith(ENTITLEMENT)
  })

  it('says the storefront cannot load once, calmly, with a retry — and starts on apps that still work', () => {
    const retry = vi.fn()
    const copy = matrixStoreCopy('en')

    renderStore({ store: { snapshot: snapshot([], { state: 'unavailable' }), onRetry: retry } })
    expect(screen.getByText(copy.storeUnavailable)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(copy.refused())).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: copy.retry }))
    expect(retry).toHaveBeenCalledOnce()
    cleanup()

    const appRetry = vi.fn()
    renderStore({ apps: { state: 'unavailable', items: [], onRetry: appRetry } })
    fireEvent.click(screen.getByRole('button', { name: 'Apps' }))
    expect(screen.getByText(copy.appsUnavailable)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: copy.retry }))
    expect(appRetry).toHaveBeenCalledOnce()
  })

  it('puts the kind at the start of each Discover summary without an uppercase overline', () => {
    renderStore()

    const copy = matrixStoreCopy('en')
    expect(window.document.querySelector('.atum-store-eyebrow')).toBeNull()
    expect(screen.getByText(copy.discoverLine(copy.kind.agent, 'Keep work on track'))).toBeTruthy()
    expect(screen.getByText(copy.discoverLine(copy.kind.skill, 'Keep work on track'))).toBeTruthy()
  })

  it('shows a house dog as its voxel portrait, on the card and in the detail, and keeps the glyph otherwise', () => {
    renderStore({
      store: {
        snapshot: snapshot([
          item('pet', { itemId: 'pet/gigi', title: { en: 'Gigi' }, glyph: '🐾', sortOrder: 1 }),
          item('pet', { itemId: 'pet/hatch', title: { en: 'Pet hatch' }, glyph: '🥚', sortOrder: 2 })
        ])
      } as DiscoverStore
    })

    const gigi = window.document.querySelector('[data-store-item="pet/gigi"] .atum-store-art')!
    const portrait = gigi.querySelector('img')!
    expect(gigi.getAttribute('data-art')).toBe('pet')
    expect(portrait.getAttribute('src')).toMatch(/gigi-preview/)
    expect(gigi.textContent).not.toContain('🐾')

    // A hatch credit is not a dog: it uses the neutral pet glyph, never catalog emoji.
    const hatch = window.document.querySelector('[data-store-item="pet/hatch"] .atum-store-art')!
    expect(hatch.querySelector('img')).toBeNull()
    expect(hatch.querySelector('svg')).toBeTruthy()
    expect(hatch.textContent).not.toContain('🥚')

    fireEvent.click(window.document.querySelector('[data-store-item="pet/gigi"]')!)
    const panel = window.document.querySelector('[data-store-detail="pet/gigi"] .atum-store-art[data-size="panel"]')!
    expect(panel.querySelector('img')?.getAttribute('src')).toMatch(/gigi-preview/)

    // A portrait that cannot load falls back to the neutral pet glyph.
    fireEvent.error(portrait)
    expect(gigi.querySelector('img')).toBeNull()
    expect(gigi.querySelector('svg')).toBeTruthy()
    expect(gigi.textContent).not.toContain('🐾')
  })

  it('shows the balance in its header and opens the top-up from it', () => {
    const checkout = checkoutFor()
    renderStore({ checkout, wallet: wallet(25_400) })

    expect(window.document.querySelector('[data-store-balance]')?.textContent).toContain('25,400')
    const balance = screen.getByRole('button', { name: 'You have 25,400 Protons' })
    // The mark stands for the word: "[mark] 25,400", the sentence kept as the button's name.
    expect(balance.querySelector('svg[data-proton-mark]')).toBeTruthy()
    expect(visibleText(balance)).toBe('25,400')
    expect(balance.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Top up' })).toBeNull()
    fireEvent.click(balance)
    expect(window.document.querySelector('[data-matrix-topup-pack="protons-50k"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'You have 25,400 Protons' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('arrives on the top-up when another surface asked for it, and takes the request once', async () => {
    act(() => $matrixStoreShelfRequest.set('topups'))
    renderStore({ checkout: checkoutFor(), wallet: wallet(10) })

    expect(window.document.querySelector('[data-store-topups]')).toBeTruthy()
    await waitFor(() => expect($matrixStoreShelfRequest.get()).toBeNull())
    cleanup()

    renderStore({ checkout: checkoutFor(), wallet: wallet(10) })
    expect(window.document.querySelector('[data-store-topups]')).toBeNull()
  })

  it('asks for the top-up while already open, and ignores it without a checkout', async () => {
    renderStore({ checkout: checkoutFor(), wallet: wallet(10) })
    expect(window.document.querySelector('[data-store-topups]')).toBeNull()
    act(() => $matrixStoreShelfRequest.set('topups'))
    await waitFor(() => expect(window.document.querySelector('[data-store-topups]')).toBeTruthy())
    cleanup()

    renderStore({ wallet: wallet(10) })
    act(() => $matrixStoreShelfRequest.set('topups'))
    await waitFor(() => expect($matrixStoreShelfRequest.get()).toBeNull())
    expect(window.document.querySelector('[data-store-topups]')).toBeNull()
  })
})

it('opens the exact recommended listing through the existing detail and consent flow', async () => {
  act(() => $matrixStoreListingRequest.set('skill/focus'))
  renderStore({ store: { snapshot: snapshot([item('skill')]) } as DiscoverStore })
  await waitFor(() => expect(window.document.querySelector('[data-store-detail="skill/focus"]')).toBeTruthy())
  expect($matrixStoreListingRequest.get()).toBeNull()
})

it('a removed recommendation reports unavailable instead of opening a different listing', async () => {
  act(() => $matrixStoreListingRequest.set('skill/removed'))
  renderStore({ store: { snapshot: snapshot([item('skill')]) } as DiscoverStore })
  await screen.findByText('The recommended listing is no longer in the current catalog.')
  expect(window.document.querySelector('[data-store-detail]')).toBeNull()
})

describe('the Store sheet with a short balance, and what a purchase outcome says', () => {
  // The owner's 0.19.4 report: "Nhà nghiên cứu" at 8.000 Proton today, 6.950 Proton held.
  const researcher = storeCatalog(agentListings).find(entry => entry.itemId === 'agent/researcher')!
  const RESEARCHER_OFFER = researcher.offer!.id

  function openResearcher(options: RenderOptions = {}) {
    const rendered = renderStore({
      locale: 'vi',
      checkout: checkoutFor(),
      ...options,
      store: { snapshot: snapshot([researcher]), ...options.store }
    })

    fireEvent.click(screen.getByText('Nhà nghiên cứu'))

    return { ...rendered, dialog: screen.getByRole('dialog') }
  }

  it('keeps Get available at a low displayed balance and lets the purchase controller decide', () => {
    const { dialog } = openResearcher({ wallet: wallet(6_950) })

    expect(within(dialog).getByText('Bạn có 6.950 Proton')).toBeTruthy()
    expect(dialog.querySelector('[data-store-shortfall]')).toBeNull()
    expect(dialog.querySelector('[data-store-acquire]')).toBeTruthy()
    expect(within(dialog).getByRole('checkbox')).toBeTruthy()
  })

  it('opens the real checkout after the purchase controller reports a shortfall', async () => {
    const checkout = checkoutFor()
    const onAcquire = vi.fn(
      async (): Promise<StoreAcquireOutcome> => ({ outcome: 'refused', code: 'insufficient_protons' })
    )
    const { dialog } = openResearcher({ checkout, store: { onAcquire }, wallet: wallet(6_950) })

    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(dialog.querySelector('[data-store-acquire]')!)
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Nạp Proton' }))

    expect(dialog.querySelector('[data-matrix-topup-pack="protons-50k"]')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mua' }))
    expect(checkout.onStart).toHaveBeenCalledWith('protons-50k')
  })

  async function hire(result: StoreAcquireOutcome | Error) {
    const onAcquire = vi.fn(async (): Promise<StoreAcquireOutcome> => {
      if (result instanceof Error) {
        throw result
      }

      return result
    })

    const { dialog } = openResearcher({ wallet: wallet(100_000), store: { onAcquire } })
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(dialog.querySelector('[data-store-acquire]')!)
    await waitFor(() => expect(dialog.querySelector('[role="status"]')).not.toBeNull())
    expect(onAcquire).toHaveBeenCalledOnce()

    return dialog
  }

  it.each([
    'invalid_request',
    'offer_unavailable',
    'feature_unavailable',
    'forbidden',
    'pet_credit_reserved',
    'rate_limited',
    'unauthenticated'
  ] as const)('says a refused hire (%s) did not happen and nothing was charged, and to try later', async code => {
    const copy = matrixStoreCopy('vi')
    const dialog = await hire({ outcome: 'refused', code })

    expect(dialog.querySelector('[role="status"]')?.textContent).toBe(
      'Chưa thuê được. Bạn không bị trừ Proton nào. Hãy thử lại sau.'
    )
    expect(within(dialog).queryByText(copy.purchaseUncertain)).toBeNull()
    expect(dialog.querySelector('[data-store-acquire]')).toBeTruthy()
  })

  it('says a hire refused for too few Proton charged nothing, and offers Nạp Proton', async () => {
    const dialog = await hire({ outcome: 'refused', code: 'insufficient_protons' })

    expect(dialog.querySelector('[role="status"]')?.textContent).toBe(
      'Chưa thuê được vì chưa đủ Proton. Bạn không bị trừ Proton nào. Hãy nạp thêm rồi thử lại.'
    )
    expect(within(dialog).getByRole('button', { name: 'Nạp Proton' })).toBeTruthy()
    expect(dialog.querySelector('[data-store-acquire]')).toBeNull()
  })

  it.each([
    ['an uncertain outcome', { outcome: 'uncertain' } as const],
    ['a failed request to this app’s own process', new Error('matrix_store_unavailable')]
  ])('keeps "check Purchased" for %s, which can still complete', async (_label, result) => {
    const dialog = await hire(result)

    expect(dialog.querySelector('[role="status"]')?.textContent).toBe(matrixStoreCopy('vi').purchaseUncertain)
  })

  it('names what did not happen in each locale, and that nothing was charged', () => {
    for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const) {
      const copy = matrixStoreCopy(locale)

      for (const kind of ['agent', 'skill', 'pet', undefined] as const) {
        expect(copy.refused(kind)).not.toBe(copy.purchaseUncertain)
        expect(copy.refusedShort(kind)).not.toBe(copy.refused(kind))
      }

      // Each kind says its own thing; a purchase checked without one says "purchase".
      expect(new Set(['agent', 'skill', 'pet', undefined].map(kind => copy.refused(kind as never))).size).toBe(4)
    }

    expect(matrixStoreCopy('en').refused('agent')).toBe(
      'The hire didn’t go through. You weren’t charged. Try again later.'
    )
    expect(matrixStoreCopy('en').shortfall('1,050')).toBe('You need 1,050 more Protons')
  })

  it('says a purchase checked again from Purchased was refused, by its kind', async () => {
    const resume = vi.fn(async (): Promise<StoreAcquireOutcome> => ({ outcome: 'refused', code: 'invalid_request' }))

    renderStore({
      locale: 'vi',
      store: {
        snapshot: snapshot([researcher], {
          pending: [
            {
              offerId: RESEARCHER_OFFER,
              offerVersion: 1,
              consentRenewal: true,
              idempotencyKey: ENTITLEMENT,
              purchaseId: null
            }
          ]
        }),
        onResume: resume
      }
    })

    fireEvent.click(screen.getByRole('button', { name: 'Đã mua' }))
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra' }))
    expect(await screen.findByText('Chưa thuê được. Bạn không bị trừ Proton nào. Hãy thử lại sau.')).toBeTruthy()
    expect(resume).toHaveBeenCalledWith(ENTITLEMENT)
  })
})

describe('free official Hub skills in the Store', () => {
  // The published listings (atum-platform catalog/store/hub-*.yaml) as the Shell sends them.
  // Through `unknown`: a JSON import types the empty `assistantIds` as `never[]`, not `[]`.
  const listings = hubListings.items as unknown as MatrixStoreItem[]
  const PIXEL_ART = 'skill/official/creative/pixel-art'

  const hubStore = (items: MatrixStoreItem[] = [item('skill'), ...listings]) => ({ snapshot: snapshot(items) })

  const openListing = (itemId: string) => {
    fireEvent.click(window.document.querySelector('[data-store-shelf="skills"]')!)
    fireEvent.click(window.document.querySelector(`[data-store-item="${itemId}"]`)!)

    return screen.getByRole('dialog')
  }

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
    'lists every Hub skill on the Skills shelf as free, from the Skills Hub, in %s',
    locale => {
      const copy = matrixStoreCopy(locale)
      renderStore({ locale, store: hubStore() })

      fireEvent.click(window.document.querySelector('[data-store-shelf="skills"]')!)

      for (const listing of listings) {
        const card = window.document.querySelector(`[data-store-item="${listing.itemId}"]`)!
        expect(within(card as HTMLElement).getByRole('button').textContent).toBe(copy.get)
        expect(card.querySelector('[data-store-hub-hint]')?.textContent).toBe(copy.installFromHub)
      }

      // A paid skill beside them keeps only the numeric price and has no Hub hint.
      const paid = window.document.querySelector('[data-store-item="skill/focus"]')!
      expect(paid.querySelector('[data-store-hub-hint]')).toBeNull()
      // The number is drawn with the Proton mark; the word is there only for screen readers.
      const paidAction = within(paid as HTMLElement).getByRole('button')
      expect(paidAction.querySelector('svg[data-proton-mark]')).toBeTruthy()
      expect(visibleText(paidAction)).toMatch(/^\d/u)
      expect(visibleText(paidAction)).not.toContain(copy.protons)
      expect(paidAction.getAttribute('aria-label')).toContain(copy.protons)
    }
  )

  it('features the Hub skills the catalog features', () => {
    renderStore({ store: hubStore(listings) })

    const featured = Array.from(window.document.querySelectorAll('[data-store-item]')).map(node =>
      node.getAttribute('data-store-item')
    )

    expect(featured).toEqual(listings.filter(listing => listing.featured).map(listing => listing.itemId))
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
    'hands the chosen assistant to its Skills Hub and buys nothing, in %s',
    locale => {
      const copy = matrixStoreCopy(locale)
      const { store } = renderStore({ locale, store: hubStore() })
      const dialog = openListing(PIXEL_ART)

      fireEvent.click(dialog.querySelector('[data-store-target-agent] button')!)
      fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: AGENT_B } })
      fireEvent.click(within(dialog).getByRole('button', { name: copy.get }))

      expect($matrixStoreHubRequest.get()).toEqual({
        page: 'skills',
        agentPrincipal: 'principal-b',
        hub: 'official/creative/pixel-art'
      })
      expect(store.onAcquire).not.toHaveBeenCalled()
      expect(within(dialog).queryByRole('button', { name: copy.add })).toBeNull()
    }
  )

  it("says Installed for an assistant whose skill list has it, and offers the Hub to one that doesn't", async () => {
    const readSkills = vi.fn(async (principal: string) =>
      principal === 'principal-a' ? ['creative/pixel-art', 'stocks'] : ['stocks']
    )

    renderStore({ readSkills, store: hubStore() })
    const dialog = openListing(PIXEL_ART)

    const installed = await within(dialog).findByRole('button', { name: 'Installed' })
    expect((installed as HTMLButtonElement).disabled).toBe(true)
    expect(within(dialog).queryByRole('button', { name: 'Install from Skills Hub' })).toBeNull()
    expect(readSkills).toHaveBeenCalledWith('principal-a')

    fireEvent.click(dialog.querySelector('[data-store-target-agent] button')!)
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: AGENT_B } })

    expect(await within(dialog).findByRole('button', { name: 'Get' })).toBeTruthy()
    expect(readSkills).toHaveBeenCalledWith('principal-b')
    expect($matrixStoreHubRequest.get()).toBeNull()
  })

  it('keeps the Hub offered when the skill list cannot be read', async () => {
    const readSkills = vi.fn(async () => {
      throw new Error('offline')
    })

    renderStore({ readSkills, store: hubStore() })
    const dialog = openListing(PIXEL_ART)

    await waitFor(() => expect(readSkills).toHaveBeenCalledWith('principal-a'))
    expect(within(dialog).getByRole('button', { name: 'Get' })).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Installed' })).toBeNull()
  })

  it('still keeps an unpriced row that is not a Hub skill out of the shop', () => {
    renderStore({ store: hubStore([item('skill', { itemId: 'skill/retired', offer: null }), ...listings]) })

    fireEvent.click(window.document.querySelector('[data-store-shelf="skills"]')!)

    expect(window.document.querySelector('[data-store-item="skill/retired"]')).toBeNull()
    expect(window.document.querySelectorAll('[data-store-hub-hint]')).toHaveLength(listings.length)
  })
})
