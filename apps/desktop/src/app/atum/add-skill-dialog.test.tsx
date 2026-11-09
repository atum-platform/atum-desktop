import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import type { AtumStoreCatalogWire } from '@/lib/atum-store-items'
import { projectSkillEntry } from '@/lib/atum-store-items'

import type { AtumSkillRow } from './skills'

const copy = en.atum.discover

const agents = [
  { id: 'default', title: 'Atum', avatarUrl: null, hostedId: '00000000-0000-4000-8000-7cac378a5787', identityId: '00000000-0000-4000-8000-d3b5d0600970' },
  { id: 'an', title: 'An', avatarUrl: null, hostedId: '00000000-0000-4000-8000-0e1a34944c4b', identityId: '00000000-0000-4000-8000-9c9c92612cf7' },
  { id: 'binh', title: 'Bình', avatarUrl: null, hostedId: '00000000-0000-4000-8000-6c8d0dd0a382', identityId: '00000000-0000-4000-8000-c0cdab9a1d64' }
]

const $atumAgents = atom(agents)

/** A store row, not the deleted constant: free by default; the purchase tests
 *  re-price it. */
const storeItem = (priceProtons = 0, version = 1) => ({
  accent: 'var(--atum-sunk)',
  detail: {
    description: { en: 'Draw diagrams', vi: 'Vẽ sơ đồ' },
    needs: [] as string[],
    try_prompt: { en: 'Draw the water cycle', vi: 'Vẽ vòng tuần hoàn' }
  },
  featured: true,
  glyph: '🔷',
  hashes: [],
  id: 'concept-diagrams',
  kind: 'skill' as const,
  offer: { id: '00000000-0000-4000-8000-11e594f48195', price_protons: priceProtons, version },
  sort_order: 1,
  source: { identifier: 'official/creative/concept-diagrams', type: 'hermes_optional' as const },
  summary: { en: 'Diagrams', vi: 'Sơ đồ' },
  title: { en: 'Concept diagrams', vi: 'Sơ đồ giải thích' }
})

const entry = projectSkillEntry(storeItem(), false)!
const pricedEntry = projectSkillEntry(storeItem(5000, 2), false)!

const CATALOG: AtumStoreCatalogWire = {
  available_protons: 12000,
  entitlements: [],
  items: []
}

const idleAssistants = () => agents.map(agent => ({
  action: 'idle' as const,
  agentId: agent.id,
  installedName: null,
  lastLogLine: null
}))

const $atumSkillRows = atom<AtumSkillRow[]>([{ assistants: idleAssistants(), entry, installedFor: [] }])
const addAtumSkill = vi.fn().mockResolvedValue(undefined)
const tryAtumSkill = vi.fn()
const runStorePurchase = vi.fn()
const recoverStorePurchase = vi.fn()

vi.mock('./agents', () => ({ $atumAgents, ATUM_AGENT_ID: 'default' }))
vi.mock('./skills', () => ({ $atumSkillRows, addAtumSkill, tryAtumSkill }))
vi.mock('@/store/atum-messaging', async () => {
  const { atom: makeAtom } = await import('nanostores')

  return { $atumAccountScopeId: makeAtom<string | null>('account-a') }
})
vi.mock('@/store/atum-store-catalog', async () => {
  const { atom: makeAtom } = await import('nanostores')

  return {
    $atumStoreCatalog: makeAtom({ accountId: 'account-a', catalog: CATALOG, state: 'ready' }),
    refreshAtumStoreCatalog: vi.fn(async () => null)
  }
})
vi.mock('@/store/atum-store-purchase', () => ({ recoverStorePurchase, runStorePurchase }))

const { AddSkillDialog } = await import('./add-skill-dialog')

function LocationProbe() {
  const { pathname, search } = useLocation()

  return <span data-testid="location">{pathname}{search}</span>
}

function renderDialog(entryOverride = entry, preselect?: string) {
  return render(
    <MemoryRouter>
      <AddSkillDialog entry={entryOverride} onOpenChange={vi.fn()} open preselect={preselect} />
      <LocationProbe />
    </MemoryRouter>
  )
}

beforeEach(() => {
  addAtumSkill.mockReset().mockResolvedValue(undefined)
  tryAtumSkill.mockReset()
  runStorePurchase.mockReset().mockResolvedValue({ kind: 'completed' })
  recoverStorePurchase.mockReset().mockResolvedValue({ kind: 'failed' })
  $atumSkillRows.set([{ assistants: idleAssistants(), entry, installedFor: [] }])
})
afterEach(cleanup)

describe('AddSkillDialog', () => {
  it('checks Atum by default and confirms only that selection', async () => {
    renderDialog()
    const checks = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(checks[0]!.checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: copy.add }))
    await waitFor(() => expect(addAtumSkill).toHaveBeenCalledWith(entry, ['default']))
  })

  it('acquires a free item through the purchase path — price 0 writes an entitlement too', async () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: copy.add }))

    await waitFor(() => expect(runStorePurchase).toHaveBeenCalledWith({
      accountId: 'account-a',
      assistantId: agents[0]!.hostedId,
      itemId: 'concept-diagrams',
      kind: 'skill',
      offer: { id: '00000000-0000-4000-8000-11e594f48195', priceProtons: 0, version: 1 }
    }))
    await waitFor(() => expect(addAtumSkill).toHaveBeenCalledWith(entry, ['default']))
  })

  it('keeps an installed assistant checked and disabled, and requires a new selection', () => {
    $atumSkillRows.set([{
      assistants: idleAssistants().map(row => row.agentId === 'default' ? { ...row, installedName: 'concept-diagrams' } : row),
      entry,
      installedFor: ['default']
    }])
    renderDialog()
    const checks = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(checks[0]!.disabled).toBe(true)
    expect(screen.getByText(copy.added)).toBeTruthy()
    expect((screen.getByRole('button', { name: copy.add }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(checks[1]!)
    expect((screen.getByRole('button', { name: copy.add }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('reflects per-assistant progress and failure from the adapter row', () => {
    $atumSkillRows.set([{
      assistants: [
        { action: 'installing', agentId: 'default', installedName: null, lastLogLine: null },
        { action: 'failed', agentId: 'an', installedName: null, lastLogLine: 'offline' },
        idleAssistants()[2]!
      ],
      entry,
      installedFor: []
    }])
    renderDialog()
    expect(screen.getByLabelText(copy.add)).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.installFailedRetry })).toBeTruthy()
  })

  it('shows the completion footer and new-chat contract after an install succeeds', async () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: copy.add }))
    $atumSkillRows.set([{
      assistants: idleAssistants().map(row => row.agentId === 'default' ? { ...row, installedName: 'concept-diagrams' } : row),
      entry,
      installedFor: ['default']
    }])
    expect(await screen.findByText(copy.newChatOnly)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
  })

  it('tries the just-trained employee even when other employees have the skill', async () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: copy.add }))
    $atumSkillRows.set([{
      assistants: idleAssistants().map(row => ({ ...row, installedName: `${row.agentId}-skill` })),
      entry,
      installedFor: ['default', 'an', 'binh']
    }])
    const tryButton = await screen.findByRole('button', { name: 'Try' })
    fireEvent.click(tryButton)
    expect(tryAtumSkill).toHaveBeenCalledWith(entry.tryPrompt.en, 'default', entry)
  })
  it('states what the skill needs at the moment of consent', () => {
    renderDialog()

    // concept-diagrams needs nothing extra; the line must still be there so the
    // consent moment always names the requirement, even when it is "nothing".
    expect(screen.getByText('Nothing extra')).toBeTruthy()
  })

  it('opens try-only mode already in single-choice with the first assistant selected', () => {
    $atumSkillRows.set([{
      assistants: idleAssistants().map(row => ({ ...row, installedName: `${row.agentId}-skill` })),
      entry,
      installedFor: ['default', 'an', 'binh']
    }])
    render(
      <MemoryRouter>
        <AddSkillDialog entry={entry} onOpenChange={vi.fn()} open tryOnly />
      </MemoryRouter>
    )

    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios).toHaveLength(3)
    expect(radios[0]!.checked).toBe(true)
    expect(screen.queryByRole('checkbox')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Try' }))
    expect(tryAtumSkill).toHaveBeenCalledWith(entry.tryPrompt.en, 'default', entry)
  })
})

describe('AddSkillDialog — purchase (W5.4)', () => {
  const renderPriced = () => {
    $atumSkillRows.set([{ assistants: idleAssistants(), entry: pricedEntry, installedFor: [] }])

    return renderDialog(pricedEntry)
  }

  it('shows the authoritative offer, its version and the available balance before charging', () => {
    renderPriced()
    fireEvent.click(screen.getByRole('button', { name: copy.add }))

    const offer = window.document.querySelector('[data-atum-store-offer]')!

    expect(offer.getAttribute('data-atum-offer-version')).toBe('2')
    expect(offer.textContent).toContain('5,000 Protons')
    expect(offer.textContent).toContain('Atum')
    // The version travels with the purchase, never as customer-facing text.
    expect(offer.textContent).not.toMatch(/Offer v\d/u)
    expect(offer.textContent).toContain('You have 12,000 Protons')
    expect(addAtumSkill).not.toHaveBeenCalled()
    expect(runStorePurchase).not.toHaveBeenCalled()
  })

  it('buys at the confirmed offer, then installs', async () => {
    renderPriced()
    fireEvent.click(screen.getByRole('button', { name: copy.add }))
    fireEvent.click(screen.getByRole('button', { name: /Buy/ }))

    await waitFor(() => expect(runStorePurchase).toHaveBeenCalledWith({
      accountId: 'account-a',
      assistantId: agents[0]!.hostedId,
      itemId: 'concept-diagrams',
      kind: 'skill',
      offer: { id: '00000000-0000-4000-8000-11e594f48195', priceProtons: 5000, version: 2 }
    }))
    await waitFor(() => expect(addAtumSkill).toHaveBeenCalledWith(pricedEntry, ['default']))
  })

  it('never charges when it only opens the purchase step — the person confirms first', () => {
    renderPriced()
    fireEvent.click(screen.getByRole('button', { name: copy.add }))

    expect(screen.getByRole('button', { name: /Buy · 5,000 Protons/ })).toBeTruthy()
    expect(runStorePurchase).not.toHaveBeenCalled()
  })

  it('training another employee requires their own purchase and selects only that employee', async () => {
    const trainedEntry = { ...pricedEntry, owned: true, trainedAssistantIds: [agents[0]!.hostedId] }
    renderDialog(trainedEntry)
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios.filter(radio => radio.checked)).toHaveLength(1)
    expect(radios[1]!.checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: copy.add }))
    expect(addAtumSkill).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Buy/ }))
    await waitFor(() => expect(runStorePurchase).toHaveBeenCalledWith(expect.objectContaining({ assistantId: agents[1]!.hostedId })))
    await waitFor(() => expect(addAtumSkill).toHaveBeenCalledWith(trainedEntry, ['an']))
  })

  it('offer_changed re-prompts at the new authoritative price and never charges the old one', async () => {
    runStorePurchase.mockResolvedValueOnce({
      kind: 'offer_changed',
      offer: { id: '00000000-0000-4000-8000-11e594f48195', priceProtons: 9000, version: 3 }
    })
    renderPriced()
    fireEvent.click(screen.getByRole('button', { name: copy.add }))
    fireEvent.click(screen.getByRole('button', { name: /Buy/ }))

    await waitFor(() => expect(screen.getByText(/price changed/)).toBeTruthy())

    const offer = window.document.querySelector('[data-atum-store-offer]')!
    expect(offer.getAttribute('data-atum-offer-version')).toBe('3')
    expect(offer.textContent).toContain('9,000 Protons')
    expect(addAtumSkill).not.toHaveBeenCalled()

    // Confirming again sends the NEW offer — the store module mints a fresh
    // key for it; the old price can never be captured.
    runStorePurchase.mockResolvedValueOnce({ kind: 'completed' })
    fireEvent.click(screen.getByRole('button', { name: /Buy · 9,000 Protons/ }))

    await waitFor(() => expect(runStorePurchase).toHaveBeenLastCalledWith({
      accountId: 'account-a',
      assistantId: agents[0]!.hostedId,
      itemId: 'concept-diagrams',
      kind: 'skill',
      offer: { id: '00000000-0000-4000-8000-11e594f48195', priceProtons: 9000, version: 3 }
    }))
  })

  it('insufficient_protons says so in the offer card and offers no legacy top-up', async () => {
    const wallet = vi.fn(async () => ({ balance_protons: 0, available_protons: 0, held_protons: 0, trial_protons: 0, ai_protons_per_usd: 100000, funded: false, spending_enabled: true }))

    Object.assign(window, { hermesDesktop: { ...window.hermesDesktop, protons: { wallet } } })
    runStorePurchase.mockResolvedValueOnce({ kind: 'insufficient_protons' })
    renderPriced()
    fireEvent.click(screen.getByRole('button', { name: copy.add }))
    fireEvent.click(screen.getByRole('button', { name: /^Buy · / }))

    await waitFor(() => expect(screen.getByText('Not enough Protons for this.')).toBeTruthy())
    const offer = window.document.querySelector('[data-atum-store-offer]') as HTMLElement
    expect(within(offer as HTMLElement).queryByRole('button', { name: 'Buy 100,000 Protons' })).toBeNull()
    expect(offer.querySelector('[data-atum-store-topup], [data-atum-proton-packs]')).toBeNull()
    expect(screen.getByTestId('location').textContent).toBe('/')
    expect(addAtumSkill).not.toHaveBeenCalled()
  })

  it('an ambiguous answer offers status recovery instead of a blind retry', async () => {
    runStorePurchase.mockResolvedValueOnce({ kind: 'uncertain' })
    recoverStorePurchase.mockResolvedValueOnce({ kind: 'completed' })
    renderPriced()
    fireEvent.click(screen.getByRole('button', { name: copy.add }))
    fireEvent.click(screen.getByRole('button', { name: /Buy/ }))

    await waitFor(() => expect(screen.getByText(/don’t know if your Protons were used/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }))

    await waitFor(() => expect(recoverStorePurchase).toHaveBeenCalledWith({
      accountId: 'account-a',
      assistantId: agents[0]!.hostedId,
      itemId: 'concept-diagrams',
      kind: 'skill'
    }))
    await waitFor(() => expect(addAtumSkill).toHaveBeenCalledWith(pricedEntry, ['default']))
  })

  it('installs without a purchase when the selected employee is already trained', async () => {
    const ownedEntry = { ...pricedEntry, owned: true, trainedAssistantIds: [agents[0]!.hostedId] }
    $atumSkillRows.set([{ assistants: idleAssistants(), entry: ownedEntry, installedFor: [] }])
    renderDialog(ownedEntry, 'default')
    fireEvent.click(screen.getByRole('button', { name: copy.add }))

    await waitFor(() => expect(addAtumSkill).toHaveBeenCalledWith(ownedEntry, ['default']))
    expect(runStorePurchase).not.toHaveBeenCalled()
  })

  it('already_owned shows the skill as owned and installs', async () => {
    runStorePurchase.mockResolvedValueOnce({ kind: 'already_owned' })
    renderPriced()
    fireEvent.click(screen.getByRole('button', { name: copy.add }))
    fireEvent.click(screen.getByRole('button', { name: /Buy/ }))

    await waitFor(() => expect(addAtumSkill).toHaveBeenCalledWith(pricedEntry, ['default']))
    // One purchase call: the server said owned, nothing more is attempted.
    expect(runStorePurchase).toHaveBeenCalledTimes(1)
  })

  it('retries activation after purchase without charging a second time', async () => {
    renderPriced()
    fireEvent.click(screen.getByRole('button', { name: copy.add }))
    fireEvent.click(screen.getByRole('button', { name: /Buy/ }))

    await waitFor(() => expect(addAtumSkill).toHaveBeenCalledWith(pricedEntry, ['default']))

    // The install comes back failed for the chosen assistant.
    $atumSkillRows.set([{
      assistants: idleAssistants().map(row => row.agentId === 'default' ? { action: 'failed' as const, agentId: row.agentId, installedName: null, lastLogLine: 'hub offline' } : row),
      entry: pricedEntry,
      installedFor: []
    }])

    const retry = await screen.findByRole('button', { name: copy.installFailedRetry })
    fireEvent.click(retry)

    await waitFor(() => expect(addAtumSkill).toHaveBeenCalledTimes(2))
    expect(addAtumSkill).toHaveBeenLastCalledWith(pricedEntry, ['default'])
    expect(runStorePurchase).toHaveBeenCalledTimes(1)
  })
})
