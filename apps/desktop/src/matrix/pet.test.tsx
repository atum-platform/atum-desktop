import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as SpriteCanvas from '@/components/pet/pet-sprite-canvas'
import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import {
  MATRIX_PET_DEFAULT_SCALE,
  type MatrixPetBridge,
  type MatrixPetCatalog,
  type MatrixPetDraft,
  type MatrixPetView
} from '../../shared/matrix-pet'
import type { MatrixPetDisplayAction, MatrixPetDisplayBridge } from '../../shared/matrix-pet-display'

import { MatrixAgentPet } from './pet'
import { petCopy } from './pet-copy'
import { matrixPetRoundsResetAt } from './pet-input'
import { $matrixPetHatchRequest } from './pet/hatch-request'

vi.mock('@/components/pet/pet-sprite-canvas', async importOriginal => ({
  ...(await importOriginal<typeof SpriteCanvas>()),
  PetSpriteCanvas: ({ info, paused }: { info: { slug: string }; paused?: boolean }) => (
    <span data-paused={paused ? 'true' : 'false'} data-testid="sprite">
      {info.slug}
    </span>
  )
}))

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@minh:test', deviceId: 'MAC' },
  petScope: 'account:1',
  rooms: [{ id: '!a:test', name: 'Agent', encrypted: true, membership: 'join', agentPrincipal: 'agent-a' }],
  roomId: '!a:test',
  messages: [],
  error: null
}

const initial: MatrixPetView = {
  freshness: 'current',
  selection: {
    owner: 'owner-a',
    agent: 'agent-a',
    revision: 4,
    provenance: 'default',
    pet: { ref: { kind: 'bundled', slug: 'gigi' }, enabled: true, scale: 0.33 },
    access: 'owned',
    visitEndsAt: null,
    serverTime: '2026-10-03T00:00:00.000Z'
  },
  sprite: { enabled: true, slug: 'gigi' }
}

let bridge: MatrixPetBridge

const hatchOffer = {
  id: '00000000-0000-4000-8000-bd7662a5eeb4',
  version: 1,
  priceMicroProtons: 65_000_000_000,
  scope: 'account' as const,
  billingInterval: 'one_time' as const,
  delivery: 'cloud' as const
}

const catalog = (price = hatchOffer.priceMicroProtons): MatrixPetCatalog => ({
  owner: 'owner-a',
  agent: 'agent-a',
  serverTime: '2026-10-03T00:00:00.000Z',
  items: ['gigi', 'cookie', 'bailey', 'mochi'].map(slug => ({
    ref: { kind: 'bundled' as const, slug: slug as 'gigi' | 'cookie' | 'bailey' | 'mochi' },
    slug,
    name: slug[0].toUpperCase() + slug.slice(1),
    access: 'owned' as const,
    offer: null
  })),
  personal: [],
  visit: { state: 'none' as const, startedAt: null, endsAt: null },
  hatch: { offer: { ...hatchOffer, priceMicroProtons: price }, creditEntitlementId: null, roundsLeft: 3 }
})

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  bridge = {
    read: vi.fn(async () => structuredClone(initial)),
    catalog: vi.fn(async () => catalog()),
    beginVisit: vi.fn(async () => {}),
    choosePhoto: vi.fn(async () => null),
    generate: vi.fn(async () => ({ token: 'draft-token', drafts: [] })),
    hatch: vi.fn(async () => structuredClone(initial)),
    adoptPending: vi.fn(async () => structuredClone(initial)),
    recovery: vi.fn(async () => ({ state: 'none' as const, canDiscard: false })),
    retryPending: vi.fn(async () => structuredClone(initial)),
    discardPending: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    onHatchProgress: vi.fn(() => () => {}),
    write: vi.fn<MatrixPetBridge['write']>(async (_target, _revision, pet) => ({
      freshness: 'current',
      selection: { ...initial.selection, revision: 5, provenance: 'explicit', pet },
      ...(pet.enabled && pet.ref?.kind === 'bundled' ? { sprite: { enabled: true, slug: pet.ref.slug } } : {})
    }))
  }
  window.atumMatrix = { pets: bridge } as MatrixUiBridge
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'atumMatrix')
  $matrixPetHatchRequest.set(null)
})

function ui(value = snapshot, locale: Locale = 'en') {
  return (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixAgentPet snapshot={value} />
    </I18nProvider>
  )
}

async function open(locale: Locale = 'en') {
  await screen.findByTestId('sprite')
  expect(screen.queryByRole('button', { name: petCopy.en.title })).toBeNull()
  fireEvent.contextMenu(window.document.querySelector('[data-pet-hit-box]')!, {
    button: 2,
    clientX: 20,
    clientY: 20
  })
  fireEvent.click(await screen.findByRole('menuitem', { name: petCopy[locale].change }))
  await screen.findByText(petCopy[locale].choose)
}

describe('agent companion', () => {
  function focusFixture() {
    render(
      <>
        <input aria-label="Outside input" data-slot="composer-rich-input" />
        <div data-atum-chat>
          <textarea aria-label="Main composer" data-slot="composer-rich-input" />
          {ui()}
        </div>
      </>
    )

    return {
      composer: screen.getByRole('textbox', { name: 'Main composer' }),
      outside: screen.getByRole('textbox', { name: 'Outside input' })
    }
  }

  // The stroll layer covers the title strip; the pet itself must stay grabbable there, and the
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  it('keeps the pet grabbable over the title strip without the stroll layer claiming a region', async () => {
    focusFixture()
    await screen.findByTestId('sprite')

    expect(window.document.querySelector('[data-pet-hit-box]')?.className).toContain('[-webkit-app-region:no-drag]')
    expect(window.document.querySelector('[data-pet-stage-window]')?.className).not.toContain('-webkit-app-region')
  })

  it('returns Escape focus after the picker unmounts to the scoped Matrix composer', async () => {
    const { composer } = focusFixture()
    await open()
    const slider = screen.getByRole('slider', { name: petCopy.en.size })
    slider.focus()
    fireEvent.keyDown(slider, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(window.document.activeElement).toBe(composer))
  })

  it('preserves focus already moved to an outside input when the picker closes', async () => {
    const { outside } = focusFixture()
    await open()
    act(() => outside.focus())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await act(() => new Promise(resolve => setTimeout(resolve, 0)))
    expect(window.document.activeElement).toBe(outside)
  })

  it('returns action-close focus after the picker unmounts', async () => {
    const { composer } = focusFixture()
    await open()
    const wave = screen.getByRole('button', { name: petCopy.en.wave })
    wave.focus()
    fireEvent.click(wave)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(window.document.activeElement).toBe(composer))
  })

  it('changes size with the keyboard and saves only after explicit confirmation', async () => {
    render(ui())
    await open()
    const slider = screen.getByRole('slider', { name: petCopy.en.size })
    slider.focus()
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider.getAttribute('aria-valuetext')).toBe('34%')
    expect(bridge.write).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: petCopy.en.save }))
    await waitFor(() =>
      expect(bridge.write).toHaveBeenCalledExactlyOnceWith({ scope: 'account:1', agent: 'agent-a' }, 4, {
        ref: { kind: 'bundled', slug: 'gigi' },
        enabled: true,
        scale: 0.34
      })
    )
  })

  it('shows real house thumbnails with owned, visiting and available descriptions', async () => {
    const pets = catalog()
    pets.items[1] = { ...pets.items[1], access: 'visiting', visitEndsAt: '2026-10-04T00:00:00Z' }
    pets.items[2] = { ...pets.items[2], access: 'available', offer: hatchOffer }
    vi.mocked(bridge.catalog).mockResolvedValue(pets)
    render(ui())
    await open()

    for (const [name, state] of [
      ['Gigi', 'Owned'],
      ['Cookie', 'Visiting'],
      ['Adopt Bailey', 'Available']
    ]) {
      const choice = screen.getByRole('button', { name })
      expect(choice.querySelector('img')?.getAttribute('src')).toContain('-preview.webp')
      expect(window.document.getElementById(choice.getAttribute('aria-describedby')!)?.textContent).toBe(state)
    }
  })

  it('keeps the exact offered purchase and then binds the confirmed owned pet', async () => {
    const before = catalog()
    before.items[2] = { ...before.items[2], access: 'available', offer: hatchOffer }
    vi.mocked(bridge.catalog).mockResolvedValueOnce(before).mockResolvedValue(catalog())

    const purchase = vi.fn(async () => ({
      outcome: 'purchased' as const,
      purchase: {
        id: 'purchase-bailey',
        state: 'completed' as const,
        itemId: 'pet/bailey',
        offerId: hatchOffer.id,
        offerVersion: hatchOffer.version,
        idempotencyKey: 'purchase-key',
        assistantId: null,
        amountMicroProtons: hatchOffer.priceMicroProtons,
        createdAt: '2026-10-07T00:00:00Z'
      },
      entitlement: null
    }))

    window.atumMatrix = { pets: bridge, store: { purchase } } as unknown as MatrixUiBridge
    render(ui())
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Adopt Bailey' }))
    await waitFor(() =>
      expect(bridge.write).toHaveBeenCalledExactlyOnceWith({ scope: 'account:1', agent: 'agent-a' }, 4, {
        ref: { kind: 'bundled', slug: 'bailey' },
        enabled: true,
        scale: 0.33
      })
    )
    expect(purchase).toHaveBeenCalledExactlyOnceWith({ offerId: hatchOffer.id, offerVersion: hatchOffer.version })
  })

  it('hatches the chosen draft through the same target, token and confirmed quote', async () => {
    const draft: MatrixPetDraft = {
      token: 'draft-token',
      index: 0,
      draftId: 'draft-a',
      kind: 'voxel',
      summary: 'Moon fox',
      dataUri: 'data:image/png;base64,AA=='
    }

    vi.mocked(bridge.generate).mockResolvedValue({ token: 'draft-token', drafts: [draft] })
    render(ui())
    await open()
    fireEvent.change(screen.getByRole('textbox', { name: petCopy.en.describe }), {
      target: { value: 'small moon fox' }
    })
    fireEvent.click(screen.getByRole('button', { name: petCopy.en.generate }))
    const name = await screen.findByRole('textbox', { name: petCopy.en.hatch })
    expect(name.getAttribute('data-slot')).toBe('input')
    expect(screen.getByRole('textbox', { name: petCopy.en.describe }).getAttribute('data-slot')).toBe('input')
    fireEvent.change(name, { target: { value: 'Moon' } })
    fireEvent.click(screen.getByRole('button', { name: petCopy.en.hatch }))
    await waitFor(() =>
      expect(bridge.hatch).toHaveBeenCalledExactlyOnceWith({
        target: { scope: 'account:1', agent: 'agent-a' },
        operationId: expect.any(String),
        token: 'draft-token',
        index: 0,
        displayName: 'Moon',
        description: 'small moon fox',
        quote: {
          kind: 'offer',
          id: hatchOffer.id,
          version: hatchOffer.version,
          priceMicroProtons: hatchOffer.priceMicroProtons
        }
      })
    )
    await waitFor(() => expect(screen.queryByRole('textbox', { name: petCopy.en.hatch })).toBeNull())
  })

  it('discards a previous agent draft response after switching agents', async () => {
    let finish!: (value: { token: string; drafts: MatrixPetDraft[] }) => void
    vi.mocked(bridge.generate).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const result = render(ui())
    await open()
    fireEvent.change(screen.getByRole('textbox', { name: petCopy.en.describe }), {
      target: { value: 'private old draft' }
    })
    fireEvent.click(screen.getByRole('button', { name: petCopy.en.generate }))
    await waitFor(() => expect(finish).toBeDefined())
    result.rerender(ui({ ...snapshot, rooms: [{ ...snapshot.rooms[0], agentPrincipal: 'agent-b' }] }))
    await open()
    await act(async () =>
      finish({
        token: 'old',
        drafts: [
          {
            token: 'old',
            index: 0,
            draftId: 'old',
            kind: 'voxel',
            summary: 'Old private pet',
            dataUri: 'data:image/png;base64,AA=='
          }
        ]
      })
    )
    expect(screen.queryByRole('img', { name: 'Old private pet' })).toBeNull()
    expect((screen.getByRole('textbox', { name: petCopy.en.describe }) as HTMLInputElement).value).toBe('')
    expect(bridge.hatch).not.toHaveBeenCalled()
  })

  it('lets an unpaid parked draft be discarded without offering an unconfirmed purchase retry', async () => {
    vi.mocked(bridge.recovery).mockResolvedValue({ state: 'parked', canDiscard: true })
    render(ui())
    await open()
    fireEvent.click(await screen.findByRole('button', { name: petCopy.en.discardRecovery }))
    await waitFor(() =>
      expect(bridge.discardPending).toHaveBeenCalledExactlyOnceWith({ scope: 'account:1', agent: 'agent-a' })
    )
    expect(bridge.retryPending).not.toHaveBeenCalled()
    expect(bridge.hatch).not.toHaveBeenCalled()
  })

  it('keeps a paid parked recovery and only offers resuming it', async () => {
    vi.mocked(bridge.recovery).mockResolvedValue({ state: 'parked', canDiscard: false })
    render(ui())
    await open()
    expect(screen.queryByRole('button', { name: petCopy.en.discardRecovery })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: petCopy.en.retryRecovery }))
    await waitFor(() =>
      expect(bridge.retryPending).toHaveBeenCalledExactlyOnceWith({ scope: 'account:1', agent: 'agent-a' })
    )
    expect(bridge.discardPending).not.toHaveBeenCalled()
  })

  it('chooses, hides and restores for the named agent using its current CAS revision', async () => {
    render(ui())
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Mochi' }))
    await waitFor(() => expect(screen.getByTestId('sprite').textContent).toBe('mochi'))
    expect(bridge.write).toHaveBeenCalledWith({ scope: 'account:1', agent: 'agent-a' }, 4, {
      ref: { kind: 'bundled', slug: 'mochi' },
      enabled: true,
      scale: 0.33
    })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show companion' }))
    await waitFor(() => expect(screen.queryByTestId('sprite')).toBeNull())
    expect(bridge.write).toHaveBeenLastCalledWith({ scope: 'account:1', agent: 'agent-a' }, 5, {
      ref: { kind: 'bundled', slug: 'mochi' },
      enabled: false,
      scale: 0.33
    })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show companion' }))
    await screen.findByTestId('sprite')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  })

  it('does not seed an imported agent with no selection and only adopts on explicit click', async () => {
    vi.mocked(bridge.read).mockResolvedValue({
      freshness: 'current',
      selection: { ...initial.selection, pet: null, provenance: null }
    })
    const { display, offer } = displayBridge()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixAgentPet display={display} snapshot={snapshot} />
      </I18nProvider>
    )
    expect(window.document.querySelector('[data-matrix-pet="agent-a"]')?.className).toContain('h-0')
    expect(screen.queryByRole('button', { name: petCopy.en.title })).toBeNull()
    await waitFor(() => expect(offer({ target: { scope: 'account:1', agent: 'agent-a' }, action: 'change' })).toBe(true))
    await screen.findByText('Saved for this agent')
    expect(screen.queryByTestId('sprite')).toBeNull()
    expect(bridge.write).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Gigi' }))
    await screen.findByTestId('sprite')
  })

  it('shows restored personal pets and binds the selected private reference with the current CAS revision', async () => {
    const petId = '00000000-0000-4000-8000-b454f82c5857'
    vi.mocked(bridge.catalog).mockResolvedValue({
      ...catalog(),
      personal: [
        {
          pet_id: petId,
          revision: 1,
          display_name: 'Cloud fox',
          description: 'A restored pet',
          content_sha256: 'a'.repeat(64),
          byte_size: 42,
          deleted_at: null,
          updated_at: '2026-10-03T00:00:00.000Z'
        }
      ]
    })
    render(ui())
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Cloud fox' }))
    await waitFor(() =>
      expect(bridge.write).toHaveBeenCalledWith({ scope: 'account:1', agent: 'agent-a' }, 4, {
        ref: { kind: 'personal', pet_id: petId },
        enabled: true,
        scale: 0.33
      })
    )
  })

  it('allows text-only and photo-only drafts without opening a file picker for text', async () => {
    render(ui())
    await open()
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe your pet' }), {
      target: { value: 'small moon fox' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate drafts' }))
    await waitFor(() =>
      expect(bridge.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'small moon fox' }))
    )
    expect(bridge.choosePhoto).not.toHaveBeenCalled()

    cleanup()
    const selected = { dataUrl: 'data:image/png;base64,AA==', mimeType: 'image/png' as const }
    vi.mocked(bridge.choosePhoto).mockResolvedValue(selected)
    render(ui())
    await open()
    fireEvent.click(screen.getByRole('button', { name: petCopy.en.choosePhoto }))
    await waitFor(() => expect(bridge.choosePhoto).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Generate drafts' }))
    await waitFor(() =>
      expect(bridge.generate).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: '', photo: selected }))
    )
  })

  it.each<Locale>(['en', 'vi', 'ja', 'zh', 'zh-hant'])(
    'offers a photo of your own pet beside the description, saying what the photo is used for (%s)',
    async locale => {
      const copy = petCopy[locale]
      render(ui(snapshot, locale))
      await open(locale)
      await screen.findByText(copy.choose)

      const describe = screen.getByRole('textbox', { name: copy.describe })
      const photo = screen.getByRole('button', { name: copy.choosePhoto })
      expect((photo as HTMLButtonElement).disabled).toBe(false)
      // The photo control follows the description it stands in for, before "Generate drafts".
      const generate = screen.getByRole('button', { name: copy.generate })
      expect(describe.compareDocumentPosition(photo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(photo.compareDocumentPosition(generate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

      const hint = window.document.getElementById(photo.getAttribute('aria-describedby') ?? '')
      expect(hint?.textContent).toBe(copy.photoHint)
      expect(screen.getByText(copy.photoHint)).toBeTruthy()

      if (locale !== 'en') {
        expect(copy.choosePhoto).not.toBe(petCopy.en.choosePhoto)
        expect(copy.photoHint).not.toBe(petCopy.en.photoHint)
      }
    }
  )

  it('opens on the hatch panel, its description focused, when the Store asks for a hatch in this chat', async () => {
    $matrixPetHatchRequest.set({ roomId: '!a:test' })
    render(ui())

    const describe = await screen.findByRole('textbox', { name: petCopy.en.describe })
    await waitFor(() => expect(window.document.activeElement).toBe(describe))
    expect(screen.getByRole('button', { name: petCopy.en.choosePhoto })).toBeTruthy()
    // Taken once: closing and reopening from the pet menu is an ordinary open.
    expect($matrixPetHatchRequest.get()).toBeNull()
    fireEvent.keyDown(describe, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: petCopy.en.describe })).toBeNull())
    await open()
    const again = await screen.findByRole('textbox', { name: petCopy.en.describe })
    expect(window.document.activeElement).not.toBe(again)
    // Opening the panel charges nothing: a hatch is quoted, and paid only when a draft is hatched.
    expect(bridge.hatch).not.toHaveBeenCalled()
  })

  it('takes a Store photo request once across rerenders and contains a cancelled picker', async () => {
    vi.mocked(bridge.choosePhoto).mockRejectedValue(new Error('picker closed'))
    const { rerender } = render(ui())
    await screen.findByTestId('sprite')
    await act(async () => {})
    $matrixPetHatchRequest.set({ roomId: '!a:test', choosePhoto: true })

    await waitFor(() => expect(bridge.choosePhoto).toHaveBeenCalledTimes(1))
    rerender(ui({ ...snapshot }))
    await act(async () => {})

    expect(bridge.choosePhoto).toHaveBeenCalledTimes(1)
    expect($matrixPetHatchRequest.get()).toBeNull()
  })

  it('leaves a hatch asked for in another chat to that chat', async () => {
    $matrixPetHatchRequest.set({ roomId: '!other:test' })
    render(ui())
    await screen.findByTestId('sprite')

    expect(screen.queryByRole('textbox', { name: petCopy.en.describe })).toBeNull()
    expect($matrixPetHatchRequest.get()).toEqual({ roomId: '!other:test' })
  })

  it.each([
    [65_000_000_000, '65,000'],
    [180_000_000_000, '180,000']
  ])('renders the confirmed hatch price (%i micro-Protons)', async (price, visible) => {
    vi.mocked(bridge.catalog).mockResolvedValue(catalog(price))
    render(ui())
    await open()
    // The price is drawn with the Proton mark; the phrase stays whole for screen readers.
    const line = await screen.findByText((_content, element) => element?.tagName === 'P' && element.textContent === `Hatch price: ${visible} Protons`)
    expect(line.querySelector('svg[data-proton-mark]')).toBeTruthy()
  })

  it('says how many free designs are left today', async () => {
    vi.mocked(bridge.catalog).mockResolvedValue({ ...catalog(), hatch: { ...catalog().hatch, roundsLeft: 2 } })
    render(ui())
    await open()
    await screen.findByText(petCopy.en.roundsLeft(2))
  })

  it.each<Locale>(['en', 'vi'])(
    'disables drafting with an honest message when no free rounds are left (%s)',
    async locale => {
      vi.mocked(bridge.catalog).mockResolvedValue({ ...catalog(), hatch: { ...catalog().hatch, roundsLeft: 0 } })
      render(ui(snapshot, locale))
      await screen.findByTestId('sprite')
      await open(locale)
      const message = await screen.findByTestId('pet-rounds')
      expect(message.textContent).toBe(petCopy[locale].noRounds(matrixPetRoundsResetAt(catalog().serverTime, locale)))
      fireEvent.change(screen.getByRole('textbox', { name: petCopy[locale].describe }), {
        target: { value: 'small moon fox' }
      })
      const generate = screen.getByRole('button', { name: petCopy[locale].generate }) as HTMLButtonElement
      expect(generate.disabled).toBe(true)
      fireEvent.click(generate)
      expect(bridge.generate).not.toHaveBeenCalled()
      expect(bridge.hatch).not.toHaveBeenCalled()
    }
  )

  it('reports a draft refused by the daily limit as the limit, not as "try again"', async () => {
    vi.mocked(bridge.generate).mockRejectedValueOnce(new Error('matrix_pet_generate_failed'))
    vi.mocked(bridge.catalog)
      .mockResolvedValueOnce(catalog())
      .mockResolvedValue({ ...catalog(), hatch: { ...catalog().hatch, roundsLeft: 0 } })
    render(ui())
    await open()
    await screen.findByText(petCopy.en.roundsLeft(3))
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe your pet' }), {
      target: { value: 'small moon fox' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate drafts' }))
    await waitFor(() => expect(screen.getByTestId('pet-rounds').textContent).toContain('You have not been charged'))
    expect(screen.queryByText(petCopy.en.draftFailed)).toBeNull()
    expect((screen.getByRole('button', { name: 'Generate drafts' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps "try again" for a draft failure while rounds remain', async () => {
    vi.mocked(bridge.generate).mockRejectedValueOnce(new Error('matrix_pet_generate_failed'))
    render(ui())
    await open()
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe your pet' }), {
      target: { value: 'small moon fox' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate drafts' }))
    await screen.findByText(petCopy.en.draftFailed)
  })

  it('does not replay a failed write; conflict requires a deliberate refresh', async () => {
    vi.mocked(bridge.write).mockRejectedValueOnce(new Error('matrix_agent_definition_conflict'))
    render(ui())
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Cookie' }))
    await screen.findByText(petCopy.en.conflict)
    expect((screen.getByRole('button', { name: 'Cookie' }) as HTMLButtonElement).disabled).toBe(true)
    expect(bridge.write).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.queryByText(petCopy.en.conflict)).toBeNull())
    expect(screen.getByTestId('sprite').textContent).toBe('gigi')
  })

  it('discards an old account response and removes the presentation on sign-out', async () => {
    let complete!: (view: MatrixPetView) => void
    vi.mocked(bridge.read).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
    const view = render(ui())
    await waitFor(() => expect(complete).toBeDefined())
    view.rerender(ui({ ...snapshot, petScope: 'new-account:2' }))
    await screen.findByTestId('sprite')
    await act(async () => complete({ ...initial, sprite: { enabled: true, slug: 'stale' } }))
    expect(screen.getByTestId('sprite').textContent).toBe('gigi')
    view.rerender(ui({ ...snapshot, identity: null }))
    expect(screen.queryByTestId('sprite')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Companion' })).toBeNull()
  })

  it('shows a cached offline pet without allowing unconfirmed edits', async () => {
    vi.mocked(bridge.read).mockResolvedValue({ ...initial, freshness: 'offline' })
    render(ui())
    await open()
    await screen.findByText(petCopy.en.offline)
    expect((screen.getByRole('button', { name: 'Mochi' }) as HTMLButtonElement).disabled).toBe(true)
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('strolls clear of the controls and opens settings from the pet menu without a persistent launcher', async () => {
    render(ui())
    const sprite = await screen.findByTestId('sprite')
    const stroll = sprite.closest('[data-matrix-pet-stroll]')!
    expect(stroll.getAttribute('aria-hidden')).toBe('true')
    expect(stroll.className).toContain('pointer-events-none')
    // A plain idle is a still frame between engine beats.
    expect(sprite.getAttribute('data-paused')).toBe('true')
    fireEvent.contextMenu(window.document.querySelector('[data-pet-hit-box]')!, { button: 2, clientX: 20, clientY: 20 })
    fireEvent.click(await screen.findByRole('menuitem', { name: petCopy.en.change }))
    await screen.findByText('Choose for this agent')
  })

  it('stands still on its first frame when the person asks for reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener() {},
      removeEventListener() {}
    }))
    render(ui())
    const sprite = await screen.findByTestId('sprite')
    expect(sprite.getAttribute('data-paused')).toBe('true')
    expect(sprite.closest('[data-walking]')).toBeNull()
  })

  it('shows Gigi on a default agent with nothing chosen yet, and choosing one saves it', async () => {
    vi.mocked(bridge.read).mockResolvedValue({
      freshness: 'current',
      selection: { ...initial.selection, pet: null, provenance: null, access: null },
      sprite: { enabled: true, slug: 'gigi' },
      standIn: true
    })
    render(ui())
    expect((await screen.findByTestId('sprite')).textContent).toBe('gigi')
    expect(bridge.write).not.toHaveBeenCalled()
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Cookie' }))
    // The first choice saves the size she was already shown at, so nothing resizes.
    await waitFor(() =>
      expect(bridge.write).toHaveBeenCalledWith({ scope: 'account:1', agent: 'agent-a' }, 4, {
        ref: { kind: 'bundled', slug: 'cookie' },
        enabled: true,
        scale: MATRIX_PET_DEFAULT_SCALE
      })
    )
    await waitFor(() => expect(screen.getByTestId('sprite').textContent).toBe('cookie'))
  })

  it('uses the catalog the read brought instead of asking again', async () => {
    vi.mocked(bridge.read).mockResolvedValue({ ...structuredClone(initial), catalog: catalog() })
    render(ui())
    await open()
    expect(screen.getByRole('button', { name: 'Mochi' })).toBeTruthy()
    expect(bridge.catalog).not.toHaveBeenCalled()
  })

  // 0.19.0 asked again at once for a catalog its read had just failed to get, and every launch
  // and every focus printed that second failure: the picker now asks when it is opened.
  it('does not ask again for a catalog the read could not get, until the picker opens', async () => {
    vi.mocked(bridge.read).mockResolvedValue({ ...structuredClone(initial), catalogUnavailable: true })
    render(ui())
    await screen.findByTestId('sprite')
    await act(async () => {})
    expect(bridge.catalog).not.toHaveBeenCalled()
    await open()
    expect(await screen.findByRole('button', { name: 'Mochi' })).toBeTruthy()
    expect(bridge.catalog).toHaveBeenCalledExactlyOnceWith({ scope: 'account:1', agent: 'agent-a' })
  })

  it('sends a visiting Gigi home when her visit ends, without waiting for the window to be focused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      // The Mac's clock is a day off; only the server's times count.
      vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
      vi.mocked(bridge.read)
        .mockResolvedValueOnce({
          freshness: 'current',
          selection: {
            ...initial.selection,
            pet: null,
            provenance: null,
            access: null,
            serverTime: '2026-10-09T23:59:00.000Z'
          },
          sprite: { enabled: true, slug: 'gigi' },
          standIn: true,
          visitEndsAt: '2026-10-10T00:00:00.000Z'
        })
        .mockResolvedValue({
          freshness: 'current',
          selection: {
            ...initial.selection,
            pet: null,
            provenance: null,
            access: null,
            serverTime: '2026-10-10T00:00:02.000Z'
          }
        })
      render(ui())
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
      expect(screen.getByTestId('sprite').textContent).toBe('gigi')

      await act(async () => void (await vi.advanceTimersByTimeAsync(59_000)))
      expect(bridge.read).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('sprite')).toBeTruthy()

      await act(async () => void (await vi.advanceTimersByTimeAsync(2_000)))
      expect(bridge.read).toHaveBeenCalledTimes(2)
      expect(screen.queryByTestId('sprite')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each<Locale>(['en', 'vi', 'ja', 'zh', 'zh-hant'])(
    'keeps failure copy localized without substituting Gigi (%s)',
    async locale => {
      vi.mocked(bridge.read).mockRejectedValue(new Error('provider_missing'))
      const { display, offer } = displayBridge()
      render(
        <I18nProvider configClient={null} initialLocale={locale}>
          <MatrixAgentPet display={display} snapshot={snapshot} />
        </I18nProvider>
      )
      await waitFor(() => expect(offer({ target: { scope: 'account:1', agent: 'agent-a' }, action: 'change' })).toBe(true))
      await screen.findByText(petCopy[locale].unavailable)
      expect(screen.queryByTestId('sprite')).toBeNull()
      expect(bridge.write).not.toHaveBeenCalled()
    }
  )
})

function displayBridge() {
  let listener: (value: MatrixPetDisplayAction) => boolean = () => false

  const display: MatrixPetDisplayBridge = {
    popOut: vi.fn(async () => undefined),
    readPreferences: async () => ({ showReplyExcerpt: false }),
    writePreferences: async value => value,
    onAction: callback => {
      listener = callback

      return () => {}
    }
  }

  return { display, offer: (value: MatrixPetDisplayAction) => listener(value) }
}

describe('native overlay entry and targeted menu', () => {
  it('opens the current agent from the native account menu and keeps previews off', async () => {
    const { display } = displayBridge()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixAgentPet display={display} snapshot={snapshot} />
      </I18nProvider>
    )
    await open()
    expect(
      screen.getByRole('checkbox', { name: 'Show replies on the pet outside Atum' }).getAttribute('aria-checked')
    ).toBe('false')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Pop out' })))
    expect(display.popOut).toHaveBeenCalledExactlyOnceWith({ scope: 'account:1', agent: 'agent-a' })
  })
  it('keeps Store and Settings available in the pet menu', async () => {
    const settings = vi.fn()
    const store = vi.fn()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixAgentPet onSettings={settings} onStore={store} snapshot={snapshot} />
      </I18nProvider>
    )
    await screen.findByTestId('sprite')
    fireEvent.contextMenu(window.document.querySelector('[data-pet-hit-box]')!, { button: 2, clientX: 20, clientY: 20 })
    fireEvent.click(await screen.findByRole('menuitem', { name: petCopy.en.settings }))
    expect(settings).toHaveBeenCalledOnce()
    fireEvent.contextMenu(window.document.querySelector('[data-pet-hit-box]')!, { button: 2, clientX: 20, clientY: 20 })
    fireEvent.click(await screen.findByRole('menuitem', { name: petCopy.en.store }))
    expect(store).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: petCopy.en.title })).toBeNull()
  })
  it('consumes only native requests for its exact mounted account and agent', async () => {
    const { display, offer } = displayBridge()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixAgentPet display={display} snapshot={snapshot} />
      </I18nProvider>
    )
    await screen.findByTestId('sprite')
    expect(offer({ target: { scope: 'other:1', agent: 'agent-a' }, action: 'size' })).toBe(false)
    expect(offer({ target: { scope: 'account:1', agent: 'agent-b' }, action: 'size' })).toBe(false)
    act(() => {
      expect(offer({ target: { scope: 'account:1', agent: 'agent-a' }, action: 'size' })).toBe(true)
    })
    await screen.findByRole('slider', { name: petCopy.en.size })
    expect(globalThis.document.activeElement?.getAttribute('role')).toBe('slider')
  })
})
