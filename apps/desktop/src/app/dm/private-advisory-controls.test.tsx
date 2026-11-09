import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type * as MessagingStore from '@/store/atum-messaging'
import { $atumAccountStatus, $atumStatus, loadAtumMessages } from '@/store/atum-messaging'
import { ensureGatewayForProfile } from '@/store/gateway'

import type { GroupRoom } from '../../../shared/atum-group-conversations'

import { $groupOperations, loadGroupDetail, operateGroup } from './group-state'
import { PrivateAdvisoryControls } from './private-advisory-controls'
import { $privateAdvisoryTasks } from './private-advisory-runner'

vi.mock('@/store/atum-messaging', async importOriginal => ({
  ...await importOriginal<typeof MessagingStore>(),
  loadAtumMessages: vi.fn().mockResolvedValue([])
}))

vi.mock('@/store/gateway', () => ({ ensureGatewayForProfile: vi.fn().mockResolvedValue(undefined) }))

vi.mock('./private-advisory-runner', () => ({ $privateAdvisoryTasks: atom({}) }))

vi.mock('./group-state', () => ({
  $groupOperations: atom([]),
  loadGroupDetail: vi.fn().mockResolvedValue(undefined),
  refreshGroupOperations: vi.fn().mockResolvedValue(undefined),
  operateGroup: vi.fn()
}))

const room: GroupRoom = {
  conversationId: 'room-1',
  title: 'Advisors',
  contextMode: 'private_advisory',
  audienceRevision: 1,
  revision: 1,
  retiredAt: null,
  membershipEpoch: 1,
  updatedAt: '',
  members: [],
  latestRound: { id: 'round-1', status: 'running', slots: [] }
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

function content(value = room) {
  return (
    <I18nProvider configClient={null} initialLocale="en">
      <MemoryRouter>
        <PrivateAdvisoryControls room={value} />
        <LocationProbe />
      </MemoryRouter>
    </I18nProvider>
  )
}

beforeEach(() => {
  $atumStatus.set(null)
  $atumAccountStatus.set({
    state: 'signed_in',
    configured: true,
    account: { id: 'account-1', displayName: null, handle: null },
    errorCode: null,
    providers: { google: false, password: true }
  })
  $privateAdvisoryTasks.set({})
  vi.mocked(ensureGatewayForProfile).mockReset().mockResolvedValue(undefined)
  $groupOperations.set([])
  vi.mocked(operateGroup).mockReset()
  vi.mocked(loadAtumMessages).mockClear()
  vi.mocked(loadGroupDetail).mockReset().mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('private advisory round controls', () => {
  it('refreshes published replies with the visible round without restarting an agent', async () => {
    vi.useFakeTimers()
    const view = render(content())
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(loadGroupDetail).toHaveBeenCalledWith('room-1')
    expect(loadAtumMessages).toHaveBeenCalledWith('room-1', { markRead: false })
    expect(operateGroup).not.toHaveBeenCalled()
    view.unmount()
    vi.mocked(loadAtumMessages).mockClear()
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(loadAtumMessages).not.toHaveBeenCalled()
  })

  it('does not refresh an old room after its pending poll loses the account', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    vi.mocked(loadGroupDetail).mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    render(content())
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    await act(async () => {
      $atumAccountStatus.set({ ...$atumAccountStatus.get(), account: null, state: 'signed_out' })
      finish()
    })
    expect(loadAtumMessages).not.toHaveBeenCalled()
  })

  it('sends Stop against the displayed round and waits for its queued operation', async () => {
    vi.mocked(operateGroup).mockImplementation(async input => {
      const result = {
        operationId: input.clientOperationId,
        state: 'queued' as const,
        conversationId: room.conversationId,
        errorCode: null
      }

      $groupOperations.set([result])

      return result
    })
    render(content())
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }))
    await waitFor(() =>
      expect(operateGroup).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'stop_advisory', roundId: 'round-1', conversationId: 'room-1' })
      )
    )
    expect((screen.getByRole('button', { name: /Stop/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }))
    expect(operateGroup).toHaveBeenCalledTimes(1)
  })

  it('never continues automatically when a round completes and fences an explicit Continue', async () => {
    vi.mocked(operateGroup).mockResolvedValue({
      operationId: 'op',
      state: 'sent',
      conversationId: room.conversationId,
      errorCode: null
    })
    const rendered = render(content())
    rendered.rerender(content({ ...room, latestRound: { id: 'round-1', status: 'completed', slots: [] } }))
    expect(operateGroup).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    await waitFor(() =>
      expect(operateGroup).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'continue_advisory', roundId: 'round-1' })
      )
    )
  })

  it('does not offer round mutations after retirement', () => {
    render(content({ ...room, retiredAt: '2026-09-06T00:00:00Z' }))
    expect(screen.queryByRole('button', { name: /Stop|Continue/ })).toBeNull()
  })

  it('offers the real advisor approval activity without navigating automatically and fences account changes', async () => {
    $privateAdvisoryTasks.set({
      job: {
        jobId: 'job',
        accountId: 'account-1',
        conversationId: room.conversationId,
        profile: 'my-advisor',
        runtimeSessionId: 'runtime-id',
        durableSessionId: 'durable-id',
        state: 'needs_input'
      }
    })
    let finish!: () => void
    vi.mocked(ensureGatewayForProfile).mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    render(content())
    expect(screen.getByTestId('location').textContent).toBe('/')
    expect(ensureGatewayForProfile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Open agent activity/i }))
    expect(ensureGatewayForProfile).toHaveBeenCalledWith('my-advisor')
    $atumAccountStatus.set({ ...$atumAccountStatus.get(), account: null, state: 'signed_out' })
    finish()
    await waitFor(() => expect(screen.queryByRole('button', { name: /Open advisor activity/i })).toBeNull())
    expect(screen.getByTestId('location').textContent).toBe('/')
  })

  it('ignores a failed Stop response from an earlier displayed round', async () => {
    let reject!: (error: Error) => void
    vi.mocked(operateGroup).mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    const rendered = render(content())
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }))
    rendered.rerender(content({ ...room, latestRound: { id: 'round-2', status: 'completed', slots: [] } }))
    reject(new Error('stale failure'))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /Continue/ }) as HTMLButtonElement).disabled).toBe(false)
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
