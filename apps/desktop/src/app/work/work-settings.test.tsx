import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixWorkAssistants, MatrixWorkProjection, MatrixWorkViewState } from '../../../shared/matrix-work'

import { $work, resetWorkStoreForTests } from './store'
import { MatrixWorkSettings } from './work-settings'

beforeEach(resetWorkStoreForTests)
afterEach(cleanup)

const projection = (view: MatrixWorkViewState, assistants: MatrixWorkAssistants = 'on'): MatrixWorkProjection => ({
  view,
  assistants,
  agents: [],
  protons: 'ok'
})

function bridge() {
  return { setWork: vi.fn(async (_on: boolean) => {}), setAssistants: vi.fn(async (_on: boolean) => {}) }
}

function show(port = bridge(), locale: 'en' | 'vi' = 'en') {
  render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixWorkSettings bridge={port} />
    </I18nProvider>
  )

  return port
}

describe('MatrixWorkSettings', () => {
  it('draws nothing while main reports no Work for this account, or has not said yet', () => {
    $work.set(null)
    show()
    expect(document.querySelector('[data-matrix-work-settings]')).toBeNull()

    cleanup()
    $work.set(undefined)
    show()
    expect(document.querySelector('[data-matrix-work-settings]')).toBeNull()
  })

  it('one switch turns Work off, and the assistants\' switch goes with it', async () => {
    $work.set(projection('ready'))
    const port = show()

    const work = screen.getByRole('switch', { name: 'Work on this Mac' })
    expect(work.getAttribute('data-state')).toBe('checked')
    expect(screen.getByRole('switch', { name: 'Assistants can start work here' }).getAttribute('data-state')).toBe('checked')

    fireEvent.click(work)
    await waitFor(() => expect(port.setWork).toHaveBeenCalledWith(false))

    $work.set(projection('off'))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Work on this Mac' }).getAttribute('data-state')).toBe('unchecked'))
    expect(screen.queryByRole('switch', { name: 'Assistants can start work here' })).toBeNull()
  })

  it('turns Work back on from its own row', async () => {
    $work.set(projection('off'))
    const port = show()

    fireEvent.click(screen.getByRole('switch', { name: 'Work on this Mac' }))
    await waitFor(() => expect(port.setWork).toHaveBeenCalledWith(true))
  })

  it('the assistants\' switch follows the gate, and only where it means something', async () => {
    $work.set(projection('ready', 'off'))
    const port = show()

    const assistants = screen.getByRole('switch', { name: 'Assistants can start work here' })
    expect(assistants.getAttribute('data-state')).toBe('unchecked')
    fireEvent.click(assistants)
    await waitFor(() => expect(port.setAssistants).toHaveBeenCalledWith(true))

    for (const state of ['not_enrolled', 'needs_grant'] as const) {
      cleanup()
      $work.set(projection('ready', state))
      show()
      expect(screen.queryByRole('switch', { name: 'Assistants can start work here' })).toBeNull()
      expect(screen.getByRole('switch', { name: 'Work on this Mac' })).toBeTruthy()
    }
  })

  it('says so, once, when a change did not go through, and keeps the switch usable', async () => {
    $work.set(projection('ready'))
    const port = bridge()
    port.setWork.mockRejectedValueOnce(new Error('work_off_failed'))
    show(port)

    fireEvent.click(screen.getByRole('switch', { name: 'Work on this Mac' }))
    expect(await screen.findByText('Could not change Work just now.')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Work on this Mac' }).hasAttribute('disabled')).toBe(false))
  })

  it('reads in Vietnamese', () => {
    $work.set(projection('ready'))
    show(bridge(), 'vi')

    expect(screen.getByRole('switch', { name: 'Work trên máy Mac này' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Trợ lý có thể bắt đầu việc tại đây' })).toBeTruthy()
  })
})
