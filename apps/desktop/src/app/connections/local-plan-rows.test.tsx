import { act, fireEvent, render, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { WORK_LOCAL_PLANS, type WorkLocalPlan } from '../../../shared/work-local-plans'
import { LocalPlanRows } from './local-plan-rows'

describe('local Work plans', () => {
  it.each(Object.keys(WORK_LOCAL_PLANS) as WorkLocalPlan[])('%s shows native readiness and progress', async plan => {
    let release!: () => void
    const setup = new Promise<void>(resolve => { release = resolve })
    const readLocalPlans = vi.fn()
      .mockResolvedValueOnce({ [plan]: 'not_installed' })
      .mockResolvedValueOnce({ [plan]: 'ready' })
      .mockResolvedValueOnce({ [plan]: 'signed_out' })
    const localPlanAction = vi.fn().mockReturnValue(setup)
    const { container } = render(<LocalPlanRows bridge={{ readLocalPlans, localPlanAction }} manageLabel="Manage" />)
    const row = container.querySelector<HTMLElement>(`[data-atum-connection="${plan}"]`)!
    const ui = within(row)

    fireEvent.click(await ui.findByRole('button', { name: 'Install & sign in' }))
    expect(localPlanAction).toHaveBeenCalledWith(plan, 'setup')
    expect(row.dataset.atumConnectionState).toBe('installing')
    expect((ui.getByRole('button', { name: 'Setting up…' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => { release() })
    expect(row.dataset.atumConnectionState).toBe('ready')
    fireEvent.click(ui.getByRole('button', { name: 'Manage' }))
    expect(localPlanAction).toHaveBeenCalledWith(plan, 'manage')

    await act(async () => { fireEvent.focus(window) })
    expect(row.dataset.atumConnectionState).toBe('signed_out')
    expect(ui.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })
})
