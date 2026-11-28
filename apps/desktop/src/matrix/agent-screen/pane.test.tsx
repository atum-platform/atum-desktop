import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { matrixAgentScreenText } from '../../../shared/matrix-agent-screen-copy'

import { mockAgentScreenTransport } from './mock-transport'
import { MatrixAgentScreenPane } from './pane'
import { AgentScreenError, type AgentScreenTransport } from './transport'

const copy = matrixAgentScreenText('en')
const binding = { agentPrincipal: 'agent-luna', roomId: '!luna:test' }

afterEach(() => cleanup())

function show(transport: AgentScreenTransport, askEventId?: string) {
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixAgentScreenPane active askEventId={askEventId} binding={binding} name="Luna" transport={transport} />
    </I18nProvider>
  )
}

const chip = () => document.querySelector('[data-agent-screen-chip]')?.textContent

async function takeControl() {
  const takeOver = await screen.findByRole('button', { name: copy.takeOver })
  await waitFor(() => expect((takeOver as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(takeOver)
  await waitFor(() => expect(document.querySelector('[data-control]')).toBeTruthy())
}

describe('agent screen pane', () => {
  it('uses the watch session and confirmed epoch through takeover and handback', async () => {
    const transport = mockAgentScreenTransport()
    const observe = vi.spyOn(transport, 'observe')
    const acquire = vi.spyOn(transport, 'acquire')
    const handback = vi.spyOn(transport, 'handback')
    show(transport, '$login-ask')
    await takeControl()
    const { viewer } = await observe.mock.results[0]!.value
    expect(acquire).toHaveBeenCalledWith(binding, { sessionId: viewer.sessionId, expectedControlRevision: 0 })

    fireEvent.click(screen.getByRole('button', { name: copy.handBackContinue }))
    await waitFor(() => expect(chip()).toBe(copy.agentUsing('Luna')))
    expect(handback).toHaveBeenCalledExactlyOnceWith(binding, {
      sessionId: viewer.sessionId, expectedControlRevision: 1, askEventId: '$login-ask'
    })
  })

  it('disables input and the handback button until the controller confirms', async () => {
    const transport = mockAgentScreenTransport()
    let confirm!: () => void
    const handback = transport.handback.bind(transport)
    transport.handback = (...args) => new Promise(resolve => {
      confirm = () => void handback(...args).then(resolve)
    })
    show(transport, '$login-ask')
    await takeControl()

    fireEvent.click(screen.getByRole('button', { name: copy.handBackContinue }))
    await waitFor(() => expect(chip()).toBe(copy.handingBack))
    expect((screen.getByRole('button', { name: copy.handBackContinue }) as HTMLButtonElement).disabled).toBe(true)
    expect(document.querySelector('[data-control]')).toBeNull()

    await act(async () => confirm())
    await waitFor(() => expect(chip()).toBe(copy.agentUsing('Luna')))
  })

  it('reuses the same handback input after a lost reply even after control was released', async () => {
    const transport = mockAgentScreenTransport()
    const original = transport.handback
    let receipt: Awaited<ReturnType<typeof original>>
    const handback = vi.spyOn(transport, 'handback')
      .mockImplementationOnce(async (...args) => {
        receipt = await original(...args)
        throw new AgentScreenError('unavailable')
      })
      .mockImplementationOnce(async () => receipt)

    show(transport, '$login-ask')
    await takeControl()
    fireEvent.click(screen.getByRole('button', { name: copy.handBackContinue }))
    await screen.findByText(copy.streamLost)
    fireEvent.click(screen.getByRole('button', { name: copy.handBackContinue }))
    await waitFor(() => expect(handback).toHaveBeenCalledTimes(2))
    expect(handback.mock.calls[1]).toEqual(handback.mock.calls[0])
  })

  it('offers ordinary release when the current ask is unavailable', async () => {
    const transport = mockAgentScreenTransport()
    const release = vi.spyOn(transport, 'release')
    const handback = vi.spyOn(transport, 'handback')
    show(transport)
    await takeControl()
    fireEvent.click(screen.getByRole('button', { name: copy.handBack }))
    await waitFor(() => expect(chip()).toBe(copy.agentUsing('Luna')))
    expect(release).toHaveBeenCalledTimes(1)
    expect(handback).not.toHaveBeenCalled()
  })

  it('offers force release when another session holds control', async () => {
    const transport = mockAgentScreenTransport()
    const { viewer } = await transport.observe(binding)
    await transport.acquire(binding, { sessionId: viewer.sessionId, expectedControlRevision: 0 })
    const forceRelease = vi.spyOn(transport, 'forceRelease')
    const handback = vi.spyOn(transport, 'handback')

    show(transport, '$login-ask')
    await waitFor(() => expect(chip()).toBe(copy.elsewhere))
    fireEvent.click(screen.getByRole('button', { name: copy.handBackForce }))
    await waitFor(() => expect(chip()).toBe(copy.agentUsing('Luna')))
    expect(forceRelease).toHaveBeenCalledExactlyOnceWith(binding, 1)
    expect(handback).not.toHaveBeenCalled()
  })

  it('shows a refusal to non-owners', async () => {
    show(mockAgentScreenTransport({ owner: false }))
    expect(await screen.findByText(copy.ownerOnly)).toBeTruthy()
  })

  it('waits for the agent to start using its screen', async () => {
    show(mockAgentScreenTransport({ running: false }))
    expect(await screen.findByText(copy.idle('Luna'))).toBeTruthy()
  })
})
