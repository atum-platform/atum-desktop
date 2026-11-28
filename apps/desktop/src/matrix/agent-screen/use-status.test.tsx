import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mockAgentScreenTransport } from './mock-transport'
import { AgentScreenError, type AgentScreenStatus } from './transport'
import { useAgentScreenStatus } from './use-status'

const notRunning: AgentScreenStatus = { running: false, holder: 'agent', controlRevision: 0, viewerHasControl: false }

afterEach(() => vi.useRealTimers())

describe('cloud screen signal', () => {
  it('polls the authenticated status while busy and opens on running without any tool names', async () => {
    vi.useFakeTimers()
    const transport = mockAgentScreenTransport({ running: false })
    const status = vi.spyOn(transport, 'status')
    const { result, rerender } = renderHook(
      ({ run }: { run?: string }) => useAgentScreenStatus(transport, 'owner-room', '!private:example.test', 'agent', run),
      { initialProps: { run: undefined } as { run?: string } }
    )

    expect(result.current).toEqual({ available: false, running: false })
    await act(async () => {})
    expect(result.current).toEqual({ available: true, running: false })
    await act(async () => vi.advanceTimersByTimeAsync(4_000))
    expect(status).toHaveBeenCalledTimes(1)

    rerender({ run: '$cloud-question' })
    await act(async () => {})
    expect(result.current.running).toBe(false)
    transport.setRunning(true)
    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    expect(result.current).toEqual({ available: true, running: true })
    expect(status).toHaveBeenLastCalledWith({ roomId: '!private:example.test', agentPrincipal: 'agent' })
    await act(async () => vi.advanceTimersByTimeAsync(6_000))
    expect(status).toHaveBeenCalledTimes(3)
  })

  it('keeps the feature hidden when the opt-in route is unavailable', async () => {
    const transport = mockAgentScreenTransport()
    vi.spyOn(transport, 'status').mockRejectedValue(new AgentScreenError('unavailable'))
    const { result } = renderHook(() => useAgentScreenStatus(transport, 'owner-room', '!private:example.test', 'agent', undefined))
    await waitFor(() => expect(transport.status).toHaveBeenCalledOnce())
    expect(result.current).toEqual({ available: false, running: false })
  })

  it('discards a late response after changing owner or room', async () => {
    const transport = mockAgentScreenTransport({ running: false })
    let resolveFirst!: (status: AgentScreenStatus) => void
    vi.spyOn(transport, 'status').mockImplementationOnce(() => new Promise(resolve => {resolveFirst = resolve}))
    const { result, rerender } = renderHook(({ scope }) =>
      useAgentScreenStatus(transport, scope, '!private:example.test', 'agent', 'busy'),
    { initialProps: { scope: 'owner-one' } })

    rerender({ scope: 'owner-two' })
    await act(async () => resolveFirst({ ...notRunning, running: true }))
    expect(result.current).toEqual({ available: true, running: false })
  })
})
