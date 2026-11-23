import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixWorkProjection } from '../../../shared/matrix-work'

import { WorkPlanConnectStep, workPlanConnectStepShown } from './plan-connect'
import { $work, $workActive, resetWorkStoreForTests } from './store'

beforeEach(() => {
  resetWorkStoreForTests()
  window.localStorage.clear()
})
afterEach(cleanup)

const READY: MatrixWorkProjection = { view: 'ready', assistants: 'on', agents: [], protons: 'ok' }

function show(bridge = { openPlanConnect: vi.fn(async () => {}) }) {
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <WorkPlanConnectStep bridge={bridge} />
    </I18nProvider>
  )

  return bridge
}

describe('the first-sign-in Connect step (gate 4a)', () => {
  it('shows only while gate 4a offers it and it was never answered here', () => {
    expect(workPlanConnectStepShown(READY, false)).toBe(false)
    expect(workPlanConnectStepShown({ ...READY, planConnect: 'connected' }, false)).toBe(false)
    expect(workPlanConnectStepShown({ ...READY, planConnect: 'offer' }, true)).toBe(false)
    expect(workPlanConnectStepShown({ ...READY, planConnect: 'offer' }, false)).toBe(true)
    expect(workPlanConnectStepShown(null, false)).toBe(false)
  })

  it('is hidden while the gate is closed', () => {
    $work.set(READY)
    show()
    expect(document.querySelector('[data-atum-work-plan-connect]')).toBeNull()
  })

  it('one line, Connect opens T3\'s own screen in Work, and it never comes back', async () => {
    $work.set({ ...READY, planConnect: 'offer' })
    const bridge = show()

    expect(await screen.findByRole('dialog', { name: 'Use your ChatGPT plan here' })).toBeTruthy()
    expect(screen.getByText('Your assistants can use this plan through this Mac.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(bridge.openPlanConnect).toHaveBeenCalledOnce())
    expect($workActive.get()).toBe(true)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    cleanup()
    show()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Not now is one tap and also final', async () => {
    $work.set({ ...READY, planConnect: 'offer' })
    const bridge = show()

    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(bridge.openPlanConnect).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('atum.work.plan-connect.seen.v1')).toBe('1')
  })
})
