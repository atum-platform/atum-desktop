import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { matrixAgentScreenText } from '../../../shared/matrix-agent-screen-copy'

import { MatrixAgentScreenPane } from './pane'
import { type AgentScreenTransport, mockAgentScreenTransport } from './transport'

const copy = matrixAgentScreenText('en')
const binding = { agentPrincipal: 'agent-luna', roomId: '!luna:test' }

afterEach(() => cleanup())

function show(transport: AgentScreenTransport, onContinue = vi.fn()) {
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixAgentScreenPane active binding={binding} name="Luna" onContinue={onContinue} transport={transport} />
    </I18nProvider>
  )

  return onContinue
}

const chip = () => document.querySelector('[data-agent-screen-chip]')?.textContent

describe('agent screen pane', () => {
  it('watches, takes over, and hands back with one carry-on', async () => {
    const transport = mockAgentScreenTransport()
    const onContinue = show(transport)

    await waitFor(() => expect(chip()).toBe(copy.agentUsing('Luna')))
    expect(screen.getByText(copy.watchLine('Luna'))).toBeTruthy()

    const takeOver = await screen.findByRole('button', { name: copy.takeOver })
    await waitFor(() => expect((takeOver as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(takeOver)

    await waitFor(() => expect(chip()).toBe(copy.youControl))
    expect(document.querySelector('[data-control]')).toBeTruthy()
    expect(transport.lease().holder).toBe('human')

    fireEvent.click(screen.getByRole('button', { name: copy.handBackContinue }))

    await waitFor(() => expect(chip()).toBe(copy.agentUsing('Luna')))
    expect(transport.lease().holder).toBe('agent')
    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(onContinue).toHaveBeenCalledWith(copy.continueMessage)
  })

  it('sends the carry-on only after the server confirms the release', async () => {
    const transport = mockAgentScreenTransport()
    let confirm!: () => void
    const release = transport.release.bind(transport)

    transport.release = (...args) =>
      new Promise(resolve => {
        confirm = () => void release(...args).then(resolve)
      })

    const onContinue = show(transport)
    const takeOver = await screen.findByRole('button', { name: copy.takeOver })
    await waitFor(() => expect((takeOver as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(takeOver)
    await waitFor(() => expect(chip()).toBe(copy.youControl))

    fireEvent.click(screen.getByRole('button', { name: copy.handBackContinue }))
    await waitFor(() => expect(chip()).toBe(copy.handingBack))
    // A second click while the release is out does nothing.
    expect((screen.getByRole('button', { name: copy.handBackContinue }) as HTMLButtonElement).disabled).toBe(true)
    expect(onContinue).not.toHaveBeenCalled()

    await act(async () => confirm())
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1))
  })

  it('never writes a message for a release that changed nothing', async () => {
    const transport = mockAgentScreenTransport()
    const release = transport.release.bind(transport)
    // Another window or device already handed back: the server reports no release by this call.
    transport.release = async (...args) => ({ ...(await release(...args)), released: false })

    const onContinue = show(transport)
    const takeOver = await screen.findByRole('button', { name: copy.takeOver })
    await waitFor(() => expect((takeOver as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(takeOver)
    await waitFor(() => expect(chip()).toBe(copy.youControl))
    fireEvent.click(screen.getByRole('button', { name: copy.handBackContinue }))
    await waitFor(() => expect(chip()).toBe(copy.agentUsing('Luna')))

    expect(onContinue).not.toHaveBeenCalled()
  })

  it('offers a forced hand back for control left open elsewhere, and it never writes', async () => {
    const transport = mockAgentScreenTransport()
    // Another window took control first.
    const other = await transport.observe(binding, {})
    await transport.acquire(binding, { viewerId: other.viewerId, expectedEpoch: 0 })

    const onContinue = show(transport)
    await waitFor(() => expect(chip()).toBe(copy.elsewhere))
    expect(screen.getByText(copy.handBackForceHint)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: copy.handBackForce }))
    await waitFor(() => expect(chip()).toBe(copy.agentUsing('Luna')))

    expect(transport.lease().holder).toBe('agent')
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('shows nothing of the screen to anyone but the owner', async () => {
    show(mockAgentScreenTransport({ owner: false }))

    expect(await screen.findByText(copy.ownerOnly)).toBeTruthy()
    expect(screen.queryByRole('button', { name: copy.takeOver })).toBeNull()
  })

  it('waits quietly until the agent starts using its browser', async () => {
    show(mockAgentScreenTransport({ running: false }))

    expect(await screen.findByText(copy.idle('Luna'))).toBeTruthy()
    expect(screen.queryByRole('button', { name: copy.takeOver })).toBeNull()
  })
})
