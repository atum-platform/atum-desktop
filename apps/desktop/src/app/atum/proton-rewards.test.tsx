import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const $atumAccountScopeId = atom<string | null>('account-a')
vi.mock('@/store/atum-messaging', () => ({ $atumAccountScopeId }))
const { ProtonRewardsSection } = await import('./proton-rewards')
const rewards = vi.fn()
const claimConnectionReward = vi.fn()
const wallet = vi.fn()

const offer = (earned = false) => ({ version: 1, state: 'available', total_earned_protons: earned ? 3000 : 0,
  tasks: [{ kind: 'email', amount_protons: 3000, earned_at: earned ? '2026-09-09T00:00:00Z' : null },
    { kind: 'calendar', amount_protons: 3000, earned_at: null }] })

beforeEach(() => {
  $atumAccountScopeId.set(null)
  $atumAccountScopeId.set('account-a')
  rewards.mockReset().mockResolvedValue(offer())
  claimConnectionReward.mockReset().mockResolvedValue({ state: 'earned', amount_protons: 3000 })
  wallet.mockReset().mockResolvedValue({ balance_protons: 13000, funded: false })
  Object.assign(window, { hermesDesktop: { protons: { rewards, claimConnectionReward, wallet } } })
})
afterEach(cleanup)
it('claims only the selected service and refreshes authoritative wallet/history', async () => {
  render(<ProtonRewardsSection />)
  await screen.findByText('Connect Gmail')
  rewards.mockResolvedValue(offer(true))
  fireEvent.click(screen.getAllByRole('button', { name: 'Verify connection' })[0]!)
  await waitFor(() => expect(claimConnectionReward).toHaveBeenCalledWith('email'))
  await screen.findByText(/Earned ·/)
  expect(screen.getAllByRole('button', { name: 'Verify connection' })).toHaveLength(1)
  expect(wallet).toHaveBeenCalledTimes(1)
})
it('clears history on account switch and refuses a late claim response', async () => {
  let finish!: (value: unknown) => void
  claimConnectionReward.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  render(<ProtonRewardsSection />)
  await screen.findByText('Connect Gmail')
  fireEvent.click(screen.getAllByRole('button', { name: 'Verify connection' })[0]!)
  rewards.mockResolvedValue({ ...offer(), state: 'paused' })
  act(() => $atumAccountScopeId.set('account-b'))
  await act(async () => finish({ state: 'earned', amount_protons: 3000 }))
  expect(screen.queryByText(/Earned ·/)).toBeNull()
  expect(wallet).not.toHaveBeenCalled()
})
it('preserves earned history while paused and exposes verification failure without optimistic credit', async () => {
  claimConnectionReward.mockRejectedValue(new Error('reconnect'))
  render(<ProtonRewardsSection />)
  await screen.findByText('Connect Gmail')
  fireEvent.click(screen.getAllByRole('button', { name: 'Verify connection' })[0]!)
  await screen.findByText(/Could not verify/)
  expect(wallet).not.toHaveBeenCalled()
  rewards.mockResolvedValue({ ...offer(true), state: 'paused' })
  act(() => $atumAccountScopeId.set('account-b'))
  await screen.findByText(/Reward claims are temporarily paused/)
  expect((screen.getByRole('button', { name: 'Verify connection' }) as HTMLButtonElement).disabled).toBe(true)
})
