import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../../shared/matrix-assistant-room'
import type {
  MatrixStoreEntitlement,
  MatrixStoreItem,
  MatrixStoreOffer,
  MatrixStoreResult
} from '../../../shared/matrix-store'
import type { MatrixWalletState } from '../../../shared/matrix-wallet'
import { MatrixApps } from '../apps'
import { $matrixPetHatchRequest } from '../pet/hatch-request'

import { matrixStoreCopy, type StoreLocale } from './store-copy'
import { $matrixStoreHubRequest, $matrixStoreShelfRequest } from './top-up'

const FIRST_OFFER = '00000000-0000-4000-8000-f96179903d54'
const REGULAR_OFFER = '00000000-0000-4000-8000-737d79e212a5'
const ENTITLEMENT = '00000000-0000-4000-8000-2aac79e9b91b'
const MICRO = 1_000_000

/** What the eye reads: the text without the screen-reader-only words, spaces collapsed as CSS does. */
function visibleText(element: Element) {
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll('.sr-only').forEach(node => node.remove())

  return (copy.textContent ?? '').replace(/\s+/gu, ' ').trim()
}

function offer(id: string, protons: number): MatrixStoreOffer {
  return {
    id,
    version: 1,
    priceMicroProtons: protons * MICRO,
    scope: 'account',
    billingInterval: 'one_time',
    delivery: 'bundled'
  }
}

function hatch(itemId: 'pet/hatch' | 'pet/hatch-first', extra: Partial<MatrixStoreItem> = {}): MatrixStoreItem {
  const firstHatch = itemId === 'pet/hatch-first'

  return {
    itemId,
    kind: 'pet',
    title: firstHatch ? { en: 'First pet hatch', vi: 'Ấp thú cưng đầu tiên' } : { en: 'Pet hatch', vi: 'Ấp thú cưng' },
    summary: firstHatch
      ? { en: 'Create your first voxel pet', vi: 'Tạo thú cưng voxel đầu tiên của bạn' }
      : { en: 'Create a new voxel pet', vi: 'Tạo một thú cưng voxel mới' },
    description: { vi: 'Ấp một thú cưng.' },
    tryPrompt: { vi: 'Ấp' },
    needs: [],
    glyph: '🐾',
    accent: '#8e75d6',
    featured: false,
    sortOrder: firstHatch ? 8 : 9,
    offer: firstHatch ? offer(FIRST_OFFER, 65_000) : offer(REGULAR_OFFER, 180_000),
    ownership: { state: 'available', source: null, assistantIds: [], until: null },
    ...extra
  }
}

function credit(itemId: string): MatrixStoreEntitlement {
  return {
    id: ENTITLEMENT,
    itemId,
    kind: 'pet',
    state: 'active',
    assistantId: null,
    delivery: 'bundled',
    grantedAt: '2026-10-08T00:00:00Z',
    subscription: null
  }
}

function purchased(offerId: string, itemId: string, protons: number): MatrixStoreResult {
  return {
    outcome: 'purchased',
    purchase: {
      id: ENTITLEMENT,
      state: 'completed',
      itemId,
      offerId,
      offerVersion: 1,
      idempotencyKey: ENTITLEMENT,
      assistantId: null,
      amountMicroProtons: protons * MICRO,
      createdAt: '2026-10-08T00:00:00Z'
    },
    entitlement: credit(itemId)
  }
}

/** The default assistant's chat, where the Store's Hatch opens the companion's hatch panel. */
const ATUM_ROOM = '!atum:test'

const atumRoom: MatrixRoom = {
  id: ATUM_ROOM,
  name: 'Atum',
  membership: 'join',
  encrypted: true,
  roomType: MATRIX_ASSISTANT_ROOM_TYPE,
  agentPrincipal: 'agent-atum',
  lastActiveAt: 1,
  participants: [
    { userId: '@owner:test', membership: 'join' },
    { userId: '@atum:test', membership: 'join' }
  ]
}

interface StoreScene {
  /** A companion can show in the default assistant's chat: it has one, and the window has pets. */
  companion?: boolean
  wallet?: MatrixWalletState
}

function snapshot(
  items: MatrixStoreItem[],
  entitlements: MatrixStoreEntitlement[] = [],
  scene: StoreScene = {}
): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: '@owner:test', deviceId: 'OWNER' },
    rooms: scene.companion ? [atumRoom] : [],
    roomId: null,
    messages: [],
    error: null,
    destination: { kind: 'discover' },
    apps: { state: 'ready', apps: [], connections: {} },
    store: { state: 'ready', items, entitlements, purchases: [], pending: [] },
    ...(scene.companion
      ? {
          petScope: 'account:1',
          assistant: { userId: '@atum:test', deviceId: 'ATUM' },
          agents: [
            {
              principal: 'agent-atum',
              userId: '@atum:test',
              assistantId: '00000000-0000-4000-8000-8bf0ba5bdf79',
              isDefault: true,
              ready: true,
              hermes: 'ready' as const,
              atumModel: true
            }
          ]
        }
      : {}),
    ...(scene.wallet ? { wallet: scene.wallet } : {})
  }
}

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

function renderStore(
  items: MatrixStoreItem[],
  locale: StoreLocale = 'en',
  result?: MatrixStoreResult,
  scene: StoreScene = {},
  entitlements: MatrixStoreEntitlement[] = []
) {
  const store = {
    refresh: vi.fn(async () => {}),
    purchase: vi.fn(async () => result ?? purchased(FIRST_OFFER, 'pet/hatch-first', 65_000)),
    resume: vi.fn(async () => ({ outcome: 'uncertain' as const })),
    cancel: vi.fn(async () => {})
  }

  const command = vi.fn(async () => null)
  const openTopUp = vi.fn(async () => {})

  window.atumMatrix = {
    apps: { onReturn: vi.fn(() => vi.fn()), refresh: vi.fn(async () => {}), connection: vi.fn(async () => {}) },
    command,
    openTopUp,
    store,
    // Only its presence matters here: the Store never calls the pet bridge.
    ...(scene.companion ? { pets: {} } : {})
  } as unknown as MatrixUiBridge

  const view = (next: MatrixSnapshot) => (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixApps fail={() => {}} obstructed={false} snapshot={next} />
    </I18nProvider>
  )

  const rendered = render(view(snapshot(items, entitlements, scene)))
  fireEvent.click(screen.getByRole('button', { name: matrixStoreCopy(locale).pets }))

  return { store, command, openTopUp, rerender: (next: MatrixSnapshot) => rendered.rerender(view(next)) }
}

function hatchCards() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-store-item^="pet/hatch"]'))
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  $matrixStoreShelfRequest.set(null)
  $matrixStoreHubRequest.set(null)
  $matrixPetHatchRequest.set(null)
})

describe('the Store Hatch card', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
    'shows one Hatch card at the first-hatch price, the regular price struck through, in %s',
    locale => {
      const copy = matrixStoreCopy(locale)
      renderStore([hatch('pet/hatch-first'), hatch('pet/hatch')], locale)

      const cards = hatchCards()
      expect(cards).toHaveLength(1)
      const card = cards[0]
      expect(card.dataset.storeItem).toBe('pet/hatch')
      const rowAction = within(card).getByRole('button')
      expect(rowAction.textContent).toMatch(/65/)
      expect(rowAction.querySelector('svg[data-proton-mark]')).toBeTruthy()
      expect(visibleText(rowAction)).not.toContain(copy.protons)
      expect(card.querySelector('[data-store-first-hatch]')).toBeNull()
      fireEvent.click(card)
      const dialog = screen.getByRole('dialog')
      expect(within(dialog).getByRole('button', { name: new RegExp(`^${copy.get}.*65`, 'u') })).toBeTruthy()
      const disclosure = dialog.querySelector('[data-store-first-hatch-note]') as HTMLElement
      expect(disclosure.textContent).toContain(copy.regularPrice)
      expect(disclosure.textContent).toMatch(/180/)
      expect(copy.firstHatch).not.toBe('')
      expect(copy.firstHatchNote).not.toBe('')

      // The card says a pet can be made from a photo of a real pet, not only from words.
      expect(card.querySelector('[data-store-hatch-hint]')?.textContent).toBe(copy.hatchFromPhoto)

      if (locale !== 'en') {
        expect(copy.hatchFromPhoto).not.toBe(matrixStoreCopy('en').hatchFromPhoto)
      }
    }
  )

  it('buys the first-hatch offer from the Hatch card while the catalog offers it', async () => {
    const { store } = renderStore([hatch('pet/hatch-first'), hatch('pet/hatch')])
    fireEvent.click(hatchCards()[0])
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('[data-store-first-hatch-note]')?.textContent).toContain(
      matrixStoreCopy('en').firstHatchNote
    )

    fireEvent.click(dialog.querySelector('[data-store-acquire]') as HTMLButtonElement)

    await waitFor(() => expect(store.purchase).toHaveBeenCalledTimes(1))
    expect(store.purchase).toHaveBeenCalledWith({ offerId: FIRST_OFFER, offerVersion: 1 })
  })

  it('shows and buys the regular hatch when the account is past its first hatch', async () => {
    const { store } = renderStore([hatch('pet/hatch')], 'en', purchased(REGULAR_OFFER, 'pet/hatch', 180_000))

    const [card] = hatchCards()
    expect(hatchCards()).toHaveLength(1)
    expect(card.querySelector('[data-store-first-hatch]')).toBeNull()
    expect(card.querySelector('[data-store-regular-price]')).toBeNull()
    expect(within(card).getByRole('button').textContent).toMatch(/180/)
    expect(visibleText(within(card).getByRole('button'))).not.toContain(matrixStoreCopy('en').protons)

    fireEvent.click(card)
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('[data-store-first-hatch-note]')).toBeNull()
    fireEvent.click(dialog.querySelector('[data-store-acquire]') as HTMLButtonElement)

    await waitFor(() => expect(store.purchase).toHaveBeenCalledWith({ offerId: REGULAR_OFFER, offerVersion: 1 }))
  })

  it('reads as owned after the first hatch is bought, not as the regular price it gave way to', async () => {
    const { rerender } = renderStore([hatch('pet/hatch-first'), hatch('pet/hatch')])
    fireEvent.click(hatchCards()[0])
    fireEvent.click(screen.getByRole('dialog').querySelector('[data-store-acquire]') as HTMLButtonElement)
    await screen.findByText(matrixStoreCopy('en').purchaseCompleted)

    // The server's refreshed catalog no longer lists the first hatch.
    rerender(snapshot([hatch('pet/hatch')], [credit('pet/hatch-first')]))

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('data-owned')).toBe('true')
    expect(dialog.querySelector('[data-kind="protons"]')).toBeNull()

    // Purchased names the credit by the Hatch card it came from.
    fireEvent.click(dialog.querySelector('[data-store-close]') as HTMLButtonElement)
    fireEvent.click(screen.getByRole('button', { name: matrixStoreCopy('en').purchased }))
    const row = document.querySelector(`[data-store-entitlement="${ENTITLEMENT}"]`) as HTMLElement
    expect(within(row).getByText('Pet hatch')).toBeTruthy()
  })

  it('shows a held hatch credit as owned rather than selling the first hatch over it', () => {
    renderStore([
      hatch('pet/hatch-first'),
      hatch('pet/hatch', { ownership: { state: 'owned', source: 'purchase', assistantIds: [], until: null } })
    ])

    const [card] = hatchCards()
    expect(hatchCards()).toHaveLength(1)
    expect(within(card).getByRole('button').textContent).toBe(matrixStoreCopy('en').open)
    expect(card.querySelector('[data-store-first-hatch]')).toBeNull()
  })
})

describe('Hatch from the Store', () => {
  const hatchPanelRequest = { roomId: ATUM_ROOM }

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
    'says in %s that a pet can be made from a photo, and when the hatch is charged',
    locale => {
      const copy = matrixStoreCopy(locale)
      renderStore([hatch('pet/hatch-first'), hatch('pet/hatch')], locale, undefined, { companion: true })
      fireEvent.click(hatchCards()[0])
      const dialog = screen.getByRole('dialog')

      expect(dialog.querySelector('[data-store-hatch-how]')).toBeNull()
      expect(dialog.querySelector('[data-store-hatch-charge]')?.textContent).toBe(copy.hatchChargedOnHatch)
      expect(within(dialog).getByRole('button', { name: copy.hatchChoosePhoto })).toBeTruthy()
      expect(within(dialog).getByRole('button', { name: copy.hatchDescribe })).toBeTruthy()
      expect(dialog.querySelector('[data-store-acquire]')).toBeNull()

      if (locale !== 'en') {
        for (const key of ['hatchChoosePhoto', 'hatchDescribe', 'hatchChargedOnHatch', 'hatchCreditReady'] as const) {
          expect(copy[key]).not.toBe(matrixStoreCopy('en')[key])
        }
      }
    }
  )

  it('opens the companion’s hatch panel in the default assistant’s chat and buys nothing', async () => {
    const copy = matrixStoreCopy('en')

    const { store, command } = renderStore([hatch('pet/hatch-first'), hatch('pet/hatch')], 'en', undefined, {
      companion: true
    })

    fireEvent.click(hatchCards()[0])
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: copy.hatchDescribe }))

    expect($matrixPetHatchRequest.get()).toEqual(hatchPanelRequest)
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: ATUM_ROOM }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The hatch panel quotes and charges the hatch itself, only when a draft is hatched.
    expect(store.purchase).not.toHaveBeenCalled()
  })

  it('opens the native photo picker path directly instead of explaining it in prose', async () => {
    const copy = matrixStoreCopy('en')
    const { command } = renderStore([hatch('pet/hatch-first'), hatch('pet/hatch')], 'en', undefined, {
      companion: true
    })

    fireEvent.click(hatchCards()[0])
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: copy.hatchChoosePhoto }))

    expect($matrixPetHatchRequest.get()).toEqual({ ...hatchPanelRequest, choosePhoto: true })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: ATUM_ROOM }))
  })

  it('opens the panel for a hatch credit already held, which hatching uses with no new charge', async () => {
    const copy = matrixStoreCopy('en')

    const { store, command } = renderStore(
      [
        hatch('pet/hatch-first'),
        hatch('pet/hatch', { ownership: { state: 'owned', source: 'purchase', assistantIds: [], until: null } })
      ],
      'en',
      undefined,
      { companion: true },
      [credit('pet/hatch')]
    )

    fireEvent.click(hatchCards()[0])
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('[data-owned]')).toBeTruthy()
    expect(dialog.querySelector('[data-store-hatch-charge]')?.textContent).toBe(copy.hatchCreditReady)

    fireEvent.click(within(dialog).getByRole('button', { name: copy.hatchDescribe }))

    expect($matrixPetHatchRequest.get()).toEqual(hatchPanelRequest)
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: ATUM_ROOM }))
    expect(store.purchase).not.toHaveBeenCalled()
  })

  it('says a held first-hatch credit is used, even while the regular hatch row reads available', () => {
    renderStore([hatch('pet/hatch')], 'en', undefined, { companion: true, wallet: wallet(10_000) }, [
      credit('pet/hatch-first')
    ])

    fireEvent.click(hatchCards()[0])
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('[data-store-hatch-charge]')?.textContent).toBe(matrixStoreCopy('en').hatchCreditReady)
    // No charge is coming, so a short balance asks for no top-up.
    expect(dialog.querySelector('[data-store-hatch-topup]')).toBeNull()
  })

  it('does not infer Hatch coverage from the displayed balance', () => {
    const { openTopUp } = renderStore([hatch('pet/hatch-first'), hatch('pet/hatch')], 'en', undefined, {
      companion: true,
      wallet: wallet(10_000)
    })

    fireEvent.click(hatchCards()[0])
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: matrixStoreCopy('en').hatchChoosePhoto })).toBeTruthy()
    expect(dialog.querySelector('[data-store-hatch-topup]')).toBeNull()
    expect(openTopUp).not.toHaveBeenCalled()
  })

  it('offers no top-up when the balance covers the hatch price', () => {
    renderStore([hatch('pet/hatch-first'), hatch('pet/hatch')], 'en', undefined, {
      companion: true,
      wallet: wallet(100_000)
    })

    fireEvent.click(hatchCards()[0])
    expect(screen.getByRole('dialog').querySelector('[data-store-hatch-topup]')).toBeNull()
  })

  it('keeps selling the hatch credit when no chat can show a companion', async () => {
    const { store } = renderStore([hatch('pet/hatch-first'), hatch('pet/hatch')])
    fireEvent.click(hatchCards()[0])
    const dialog = screen.getByRole('dialog')

    expect(within(dialog).queryByRole('button', { name: matrixStoreCopy('en').hatchChoosePhoto })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: matrixStoreCopy('en').hatchDescribe })).toBeNull()
    expect(dialog.querySelector('[data-store-hatch-how]')?.textContent).toContain(matrixStoreCopy('en').hatchHow)
    expect(dialog.querySelector('[data-store-hatch-charge]')).toBeNull()
    fireEvent.click(dialog.querySelector('[data-store-acquire]') as HTMLButtonElement)

    await waitFor(() => expect(store.purchase).toHaveBeenCalledTimes(1))
    expect($matrixPetHatchRequest.get()).toBeNull()
  })
})
