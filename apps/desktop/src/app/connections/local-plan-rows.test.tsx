import { act, fireEvent, render, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { MatrixWorkProjection } from '../../../shared/matrix-work'
import { WORK_LOCAL_PLANS, type WorkLocalPlan } from '../../../shared/work-local-plans'

import { LocalPlanRows } from './local-plan-rows'

describe('local Work plans', () => {
  it('reads local providers after the first Work startup', async () => {
    let onWorkChange: ((projection: MatrixWorkProjection | null) => void) | undefined
    const readLocalPlans = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({
      'openrouter-free': { state: 'signed_out' }
    })
    const bridge = {
      readLocalPlans,
      localPlanAction: vi.fn(),
      subscribe: (listener: typeof onWorkChange) => {
        onWorkChange = listener

        return () => { onWorkChange = undefined }
      }
    }
    const { container } = render(<LocalPlanRows bridge={bridge} manageLabel="Manage" />)
    const row = container.querySelector<HTMLElement>('[data-atum-connection="openrouter-free"]')!
    expect(within(row).getByRole('button', { name: 'Connect' })).toHaveProperty('disabled', true)

    await act(async () => { onWorkChange?.({ view: 'ready', protons: 'unknown' }) })
    expect(within(row).getByRole('button', { name: 'Connect' })).toHaveProperty('disabled', false)
  })

  it.each(Object.keys(WORK_LOCAL_PLANS) as WorkLocalPlan[])('%s shows native readiness and progress', async plan => {
    let release!: () => void
    const setup = new Promise<void>(resolve => { release = resolve })
    const readLocalPlans = vi.fn()
      .mockResolvedValueOnce({ [plan]: { state: 'not_installed' } })
    readLocalPlans.mockResolvedValueOnce({ [plan]: { state: 'ready' } })
      .mockResolvedValueOnce({ [plan]: { state: 'signed_out' } })
    const localPlanAction = vi.fn().mockReturnValue(setup)
    const { container } = render(<LocalPlanRows bridge={{ readLocalPlans, localPlanAction }} manageLabel="Manage" />)
    const row = container.querySelector<HTMLElement>(`[data-atum-connection="${plan}"]`)!
    const ui = within(row)

    await act(async () => {})
    fireEvent.click(await ui.findByRole('button', { name: plan === 'kiro' ? 'Sign in with Google' : 'Install & sign in' }))
    expect(localPlanAction).toHaveBeenCalledWith(plan, plan === 'kiro' ? 'setup-google' : 'setup')
    expect(row.dataset.atumConnectionState).toBe('installing')
    expect((ui.getByRole('button', { name: 'Setting up…' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => { release() })
    expect(row.dataset.atumConnectionState).toBe('ready')
    fireEvent.click(ui.getByRole('button', { name: 'Manage' }))
    expect(localPlanAction).toHaveBeenCalledWith(plan, 'manage')

    await act(async () => { fireEvent.focus(window) })
    expect(row.dataset.atumConnectionState).toBe('signed_out')
    expect(ui.getByRole('button', { name: plan === 'kiro' ? 'Sign in with GitHub' : plan === 'openrouter-free' ? 'Connect' : 'Sign in' })).toBeTruthy()
  })

  it('shows the specific setup failure beside the Kiro sign-in actions', async () => {
    const localPlanAction = vi.fn().mockResolvedValue('Free up 1.5 GB of disk space to install Kiro.')
    const readLocalPlans = vi.fn().mockResolvedValue({ kiro: { state: 'not_installed' } })
    const ui = render(<LocalPlanRows bridge={{ localPlanAction, readLocalPlans }} manageLabel="Manage" />)

    fireEvent.click(ui.getByRole('button', { name: 'Sign in with GitHub' }))

    expect(localPlanAction).toHaveBeenCalledWith('kiro', 'setup-github')
    expect(await ui.findByText('Free up 1.5 GB of disk space to install Kiro.')).toBeTruthy()
  })

  it('signs out of Copilot and refreshes its local readiness', async () => {
    const localPlanAction = vi.fn().mockResolvedValue(undefined)
    const readLocalPlans = vi.fn()
      .mockResolvedValueOnce({ copilot: { state: 'ready' } })
      .mockResolvedValueOnce({ copilot: { state: 'signed_out' } })
    const { container } = render(<LocalPlanRows bridge={{ localPlanAction, readLocalPlans }} manageLabel="Manage" />)
    const ui = within(container.querySelector<HTMLElement>('[data-atum-connection="copilot"]')!)

    fireEvent.click(await ui.findByRole('button', { name: 'Sign out' }))

    expect(localPlanAction).toHaveBeenCalledWith('copilot', 'logout')
    expect(await ui.findByRole('button', { name: 'Sign in' })).toBeTruthy()
  })
})
