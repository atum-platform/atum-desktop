import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { MatrixPetDisplayBridge } from '../../../shared/matrix-pet-display'

import { PetOverlayPreferences } from './overlay-preferences'

vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }))

function setup() {
  const bridge: MatrixPetDisplayBridge = {
    popOut: vi.fn(async () => undefined),
    onAction: () => () => undefined,
    readPreferences: vi.fn(async () => ({ showReplyExcerpt: false })),
    writePreferences: vi.fn(async value => value)
  }

  return bridge
}

describe('local overlay preview choice', () => {
  it('starts off and saves only an explicit checkbox change through native main', async () => {
    const bridge = setup()
    await act(async () => {
      render(<PetOverlayPreferences bridge={bridge} />)
    })
    const control = screen.getByRole('checkbox', { name: 'Show replies on the pet outside Atum' })
    expect(control.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('Visible replies appear in screen shares.')).toBeTruthy()
    expect(bridge.writePreferences).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(control))
    expect(bridge.writePreferences).toHaveBeenCalledExactlyOnceWith({ showReplyExcerpt: true })
    expect(control.getAttribute('aria-checked')).toBe('true')
  })

  it('does not claim a new choice when main refuses persistence', async () => {
    const bridge = setup()
    vi.mocked(bridge.writePreferences).mockRejectedValue(new Error('private storage path'))
    await act(async () => {
      render(<PetOverlayPreferences bridge={bridge} />)
    })
    const control = screen.getByRole('checkbox')
    await act(async () => fireEvent.click(control))
    expect(control.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('status').textContent).toMatch(/could not be saved/i)
    expect(globalThis.document.body.textContent).not.toContain('private storage path')
  })
})
