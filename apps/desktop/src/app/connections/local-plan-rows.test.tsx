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
    if (plan === 'openrouter-free') {readLocalPlans.mockResolvedValueOnce({ [plan]: { state: 'signed_out' } })}
    readLocalPlans.mockResolvedValueOnce({ [plan]: { state: 'ready' } })
      .mockResolvedValueOnce({ [plan]: { state: 'signed_out' } })
    const localPlanAction = vi.fn().mockReturnValue(setup)
    const { container } = render(<LocalPlanRows bridge={{ readLocalPlans, localPlanAction }} manageLabel="Manage" />)
    const row = container.querySelector<HTMLElement>(`[data-atum-connection="${plan}"]`)!
    const ui = within(row)

    if (plan === 'openrouter-free') {
      const connect = await ui.findByRole('button', { name: 'Connect' })
      expect(connect).toHaveProperty('disabled', true)
      await act(async () => { fireEvent.focus(window) })
      fireEvent.click(connect)
    } else {
      fireEvent.click(await ui.findByRole('button', { name: 'Install & sign in' }))
    }
    expect(localPlanAction).toHaveBeenCalledWith(plan, 'setup')
    expect(row.dataset.atumConnectionState).toBe('installing')
    expect((ui.getByRole('button', { name: 'Setting up…' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => { release() })
    expect(row.dataset.atumConnectionState).toBe('ready')
    fireEvent.click(ui.getByRole('button', { name: 'Manage' }))
    expect(localPlanAction).toHaveBeenCalledWith(plan, 'manage')

    await act(async () => { fireEvent.focus(window) })
    expect(row.dataset.atumConnectionState).toBe('signed_out')
    expect(ui.getByRole('button', { name: plan === 'openrouter-free' ? 'Connect' : 'Sign in' })).toBeTruthy()
  })
})
