import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixAgentProposalCard, MatrixAgentProposalsBridge } from '../../shared/matrix-agent-proposals'

import { MatrixAgentProposalCards } from './agent-proposal-card'
import { matrixAgentProposalCopy } from './agent-proposal-copy'
import { $agentProposals } from './agent-proposals-store'

const copy = matrixAgentProposalCopy.en
const ROOM = '!assistant:atum.test'
const EVENT = '$answer-one'

function card(change: Partial<MatrixAgentProposalCard> = {}): MatrixAgentProposalCard {
  return {
    id: 'c0ffee00-0000-4000-8000-ccccccccccc3',
    roomId: ROOM,
    eventId: EVENT,
    operation: 'create',
    agentName: 'Researcher',
    protons: 60_000,
    state: 'pending',
    expiresAt: Date.now() + 3_600_000,
    ...change
  }
}

function fakeBridge(cards: MatrixAgentProposalCard[]) {
  let listener: ((roomId: string) => void) | undefined
  let current = cards

  const bridge = {
    read: vi.fn(async (roomId: string) => current.filter(item => item.roomId === roomId)),
    confirm: vi.fn(async (id: string) => ({ ...current.find(item => item.id === id)!, state: 'confirmed' as const })),
    decline: vi.fn(async (id: string) => ({ ...current.find(item => item.id === id)!, state: 'declined' as const })),
    subscribe: vi.fn((next: (roomId: string) => void) => {
      listener = next

      return () => void (listener = undefined)
    })
  } satisfies MatrixAgentProposalsBridge

  return {
    bridge,
    replace: (next: MatrixAgentProposalCard[]) => {
      current = next
      listener?.(ROOM)
    }
  }
}

function show(bridge: MatrixAgentProposalsBridge, eventId = EVENT) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixAgentProposalCards bridge={bridge} eventId={eventId} roomId={ROOM} />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  $agentProposals.set({})
})

describe('the agent proposal card', () => {
  it('renders nothing until a proposal arrives, then appears under its message', async () => {
    const { bridge, replace } = fakeBridge([])
    const view = show(bridge)

    await waitFor(() => expect(bridge.read).toHaveBeenCalledWith(ROOM))
    expect(view.container.querySelector('[data-matrix-agent-proposals]')).toBeNull()

    act(() => replace([card()]))

    expect(await screen.findByRole('group', { name: copy.label })).toBeTruthy()
    expect(screen.getByText('Create Researcher?')).toBeTruthy()
  })

  it('never shows a card under another message', async () => {
    const { bridge } = fakeBridge([card()])
    const view = show(bridge, '$another')

    await waitFor(() => expect(bridge.read).toHaveBeenCalled())
    expect(view.container.querySelector('[data-matrix-agent-proposals]')).toBeNull()
  })

  it('pending: one question, the monthly price, Confirm and Not now', async () => {
    const { bridge } = fakeBridge([card()])
    show(bridge)

    const group = await screen.findByRole('group', { name: copy.label })
    expect(group.getAttribute('data-matrix-agent-proposal')).toBe('pending')
    expect(screen.getByText('60,000 Protons/month')).toBeTruthy()
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([copy.confirm, copy.notNow])
  })

  it('shows no price when the change is free', async () => {
    const { bridge } = fakeBridge([card({ operation: 'retire', agentName: 'Lan', protons: undefined })])
    show(bridge)

    expect(await screen.findByText('Delete Lan?')).toBeTruthy()
    expect(screen.queryByText(/Protons/)).toBeNull()
  })

  it('confirmed: sends only the proposal ID and settles into one quiet line', async () => {
    const { bridge } = fakeBridge([card()])
    show(bridge)

    fireEvent.click(await screen.findByRole('button', { name: copy.confirm }))

    const line = await screen.findByRole('status')
    expect(bridge.confirm).toHaveBeenCalledWith('c0ffee00-0000-4000-8000-ccccccccccc3')
    expect(line.getAttribute('data-matrix-agent-proposal')).toBe('confirmed')
    expect(line.textContent).toBe('Researcher is on its way')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('declined: Not now settles the card without confirming', async () => {
    const { bridge } = fakeBridge([card()])
    show(bridge)

    fireEvent.click(await screen.findByRole('button', { name: copy.notNow }))

    const line = await screen.findByRole('status')
    expect(line.getAttribute('data-matrix-agent-proposal')).toBe('declined')
    expect(line.textContent).toBe('Not created')
    expect(bridge.confirm).not.toHaveBeenCalled()
  })

  it('expired: the quiet expired line, nothing to tap', async () => {
    const { bridge } = fakeBridge([card({ state: 'expired' })])
    show(bridge)

    const line = await screen.findByRole('status')
    expect(line.getAttribute('data-matrix-agent-proposal')).toBe('expired')
    expect(line.textContent).toBe(copy.expired)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('failed: says why and offers Try again', async () => {
    const { bridge } = fakeBridge([card({ state: 'failed', failure: 'funds' })])
    show(bridge)

    const group = await screen.findByRole('group', { name: copy.label })
    expect(group.getAttribute('data-matrix-agent-proposal')).toBe('failed')
    expect(screen.getByRole('status').textContent).toBe(copy.short)

    fireEvent.click(screen.getByRole('button', { name: copy.tryAgain }))
    expect(await screen.findByText('Researcher is on its way')).toBeTruthy()
    expect(bridge.confirm).toHaveBeenCalledTimes(1)
  })

  it('a confirmation that does not go through keeps the card and offers Try again', async () => {
    const { bridge } = fakeBridge([card()])
    bridge.confirm.mockRejectedValueOnce(new Error('matrix_agent_proposal_unavailable'))
    show(bridge)

    fireEvent.click(await screen.findByRole('button', { name: copy.confirm }))

    expect((await screen.findByRole('status')).textContent).toBe(copy.failed)
    expect(screen.getByRole('button', { name: copy.tryAgain })).toBeTruthy()
  })

  it('follows main when the card changes elsewhere', async () => {
    const { bridge, replace } = fakeBridge([card()])
    show(bridge)

    await screen.findByRole('group', { name: copy.label })
    act(() => replace([card({ state: 'expired' })]))

    expect((await screen.findByRole('status')).textContent).toBe(copy.expired)
  })

  it('reads a room once however many messages are open', async () => {
    const { bridge } = fakeBridge([card()])
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixAgentProposalCards bridge={bridge} eventId={EVENT} roomId={ROOM} />
        <MatrixAgentProposalCards bridge={bridge} eventId="$two" roomId={ROOM} />
        <MatrixAgentProposalCards bridge={bridge} eventId="$three" roomId={ROOM} />
      </I18nProvider>
    )

    await screen.findByRole('group', { name: copy.label })
    expect(bridge.read).toHaveBeenCalledTimes(1)
    expect(bridge.subscribe).toHaveBeenCalledTimes(1)
  })
})
