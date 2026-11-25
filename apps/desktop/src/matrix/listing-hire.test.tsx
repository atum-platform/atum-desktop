import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $betaFeatures } from '@/store/beta-features'

import type { MatrixAgentView, MatrixOpenAgentListing, MatrixUiBridge } from '../../shared/matrix'

import { NewAssistantButton, NewAssistantDialog } from './agent-roster'
import { listingAssistantName, listingText } from './listing-hire'

// Hiring is what a beta account sees; `without beta features` below covers everyone else.
beforeEach(() => $betaFeatures.set({ profile: 'hire-test', granted: true }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  $betaFeatures.set({ profile: null, granted: false })
  Reflect.deleteProperty(window, 'atumMatrix')
})

const RESEARCHER: MatrixOpenAgentListing = {
  listingId: 'open/agents/researcher',
  displayName: 'Researcher',
  title: { vi: 'Nhà nghiên cứu', en: 'Researcher' },
  summary: { vi: 'Nghiên cứu với nguồn rõ ràng', en: 'Research with clear sources' },
  glyph: '🔎',
  skills: ['atum-weekly-digest', 'trend-researcher'],
  seatPriceProtons: 60_000,
  hireRequired: false
}

type HireResult = Awaited<ReturnType<NonNullable<MatrixUiBridge['hireAgent']>>>

function setup({
  listings = [RESEARCHER],
  hireAgent = vi.fn(async (): Promise<HireResult> => ({ principal: 'res', assistantId: undefined })),
  agents
}: {
  listings?: MatrixOpenAgentListing[]
  hireAgent?: NonNullable<MatrixUiBridge['hireAgent']>
  agents?: MatrixAgentView[]
} = {}) {
  const createAgent = vi.fn<MatrixUiBridge['createAgent']>()
  const openTopUp = vi.fn<MatrixUiBridge['openTopUp']>().mockResolvedValue()
  const openAgents = vi.fn(async () => listings)
  window.atumMatrix = { createAgent, hireAgent, openAgents, openTopUp } as unknown as MatrixUiBridge
  const onCreated = vi.fn()

  function Roster() {
    const [open, setOpen] = useState(false)

    return (
      <>
        <NewAssistantButton onClick={() => setOpen(true)} />
        <NewAssistantDialog agents={agents} onCreated={onCreated} onOpenChange={setOpen} open={open} ready />
      </>
    )
  }

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <Roster />
    </I18nProvider>
  )

  fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))

  return { createAgent, hireAgent: vi.mocked(hireAgent), onCreated, openAgents, openTopUp }
}

const hireButton = () => screen.findByRole('button', { name: 'Hire Researcher' })

describe('the listing shelf in the new-assistant sheet', () => {
  it('without beta features shows the listings as "Coming soon" and still makes your own', async () => {
    $betaFeatures.set({ profile: 'hire-test', granted: false })
    const { hireAgent } = setup()

    expect(await screen.findByText('Ready to hire')).toBeTruthy()
    expect(screen.getByText('Research with clear sources')).toBeTruthy()
    const soon = (await screen.findByRole('button', { name: 'Coming soon Researcher' })) as HTMLButtonElement
    expect(soon.textContent).toBe('Coming soon')
    expect(soon.disabled).toBe(true)
    fireEvent.click(soon)
    expect(hireAgent).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Hire Researcher' })).toBeNull()
    // Making your own assistant never waits for beta.
    expect(screen.getByText('Make your own')).toBeTruthy()
    expect((screen.getByLabelText('Display name') as HTMLInputElement).disabled).toBe(false)
  })

  it('shows nothing extra when the platform has no listings', async () => {
    const { openAgents } = setup({ listings: [] })

    await waitFor(() => expect(openAgents).toHaveBeenCalled())
    expect(screen.queryByText('Ready to hire')).toBeNull()
    expect(screen.queryByText('Make your own')).toBeNull()
    expect(screen.getByLabelText('Display name')).toBeTruthy()
  })

  it('hires a free listing in one press, without a persona, and says where it went', async () => {
    const { createAgent, hireAgent, onCreated } = setup()

    expect(await screen.findByText('Ready to hire')).toBeTruthy()
    expect(screen.getByText('Research with clear sources')).toBeTruthy()
    fireEvent.click(await hireButton())

    await screen.findByText('Researcher is in your chats.')
    expect(hireAgent).toHaveBeenCalledWith('Researcher', 'open/agents/researcher')
    expect(createAgent).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledOnce()
    // No price shows for a free seat.
    expect(screen.queryByText(/Protons/)).toBeNull()
  })

  it('shows the price once for a third assistant, then hires on confirm', async () => {
    const { hireAgent } = setup({ listings: [{ ...RESEARCHER, hireRequired: true }] })

    fireEvent.click(await hireButton())
    expect(screen.getAllByText('60,000 Protons/month')).toHaveLength(1)
    expect(hireAgent).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Hire' }))
    await screen.findByText('Researcher is in your chats.')
    expect(hireAgent).toHaveBeenCalledWith('Researcher', 'open/agents/researcher', true)
  })

  it('turns a hire the platform asks for into the price step', async () => {
    const hireAgent = vi
      .fn<NonNullable<MatrixUiBridge['hireAgent']>>()
      .mockResolvedValueOnce({ refused: { hire: 60_000 } })
      .mockResolvedValueOnce({ principal: 'res' })

    setup({ hireAgent })
    fireEvent.click(await hireButton())
    expect(await screen.findByText('60,000 Protons/month')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Hire' }))
    await screen.findByText('Researcher is in your chats.')
    expect(hireAgent).toHaveBeenLastCalledWith('Researcher', 'open/agents/researcher', true)
  })

  it('offers a top-up when the wallet is short, and comes back to the price', async () => {
    const hireAgent = vi.fn<NonNullable<MatrixUiBridge['hireAgent']>>().mockResolvedValue({ refused: 'short' })
    const { openTopUp } = setup({ hireAgent, listings: [{ ...RESEARCHER, hireRequired: true }] })

    fireEvent.click(await hireButton())
    fireEvent.click(screen.getByRole('button', { name: 'Hire' }))
    expect(await screen.findByText('Not enough Protons. Top up to continue.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Top up Protons' }))
    expect(openTopUp).toHaveBeenCalledOnce()
    expect(screen.getByText('60,000 Protons/month')).toBeTruthy()
  })

  it('retries a failed hire with the same confirmation, and Back returns to the sheet', async () => {
    const hireAgent = vi
      .fn<NonNullable<MatrixUiBridge['hireAgent']>>()
      .mockRejectedValueOnce(new Error('matrix_agent_unavailable'))
      .mockResolvedValueOnce({ principal: 'res' })

    setup({ hireAgent })
    fireEvent.click(await hireButton())
    expect(await screen.findByText("Couldn't hire Researcher. Try again.")).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Researcher is in your chats.')
    expect(hireAgent).toHaveBeenCalledTimes(2)
    expect(hireAgent.mock.calls[1]).toEqual(['Researcher', 'open/agents/researcher'])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    })
    expect(screen.queryByText('Researcher is in your chats.')).toBeNull()
  })

  it('goes back to the sheet from the price step', async () => {
    setup({ listings: [{ ...RESEARCHER, hireRequired: true }] })

    fireEvent.click(await hireButton())
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByLabelText('Display name')).toBeTruthy()
    expect(screen.getByText('Make your own')).toBeTruthy()
  })
})

describe('listing names', () => {
  it('reads the locale, then English, then the catalog name', () => {
    expect(listingText(RESEARCHER.title, 'vi')).toBe('Nhà nghiên cứu')
    expect(listingText(RESEARCHER.title, 'zh-hant')).toBe('Researcher')
    expect(listingText(undefined, 'en', 'Researcher')).toBe('Researcher')
  })

  it('numbers the name when the owner already has an assistant called that', () => {
    const agents = [{ principal: 'p1', name: 'Researcher' }] as MatrixAgentView[]

    expect(listingAssistantName(RESEARCHER, 'en')).toBe('Researcher')
    expect(listingAssistantName(RESEARCHER, 'en', agents)).toBe('Researcher 2')
    expect(listingAssistantName(RESEARCHER, 'vi', agents)).toBe('Nhà nghiên cứu')
  })
})
