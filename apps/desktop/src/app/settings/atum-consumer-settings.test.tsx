import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $zoomPercent } from '@/store/zoom'

const setPercent = vi.fn()

beforeEach(() => {
  setPercent.mockClear()
  $zoomPercent.set(100)
  window.hermesDesktop = { ...window.hermesDesktop, zoom: { get: vi.fn(), onChanged: vi.fn(), setPercent } }
})

afterEach(cleanup)

const { AtumConsumerSettings } = await import('./atum-consumer-settings')
const { PET_SETTINGS_SECTION_ID } = await import('./pet-settings')

// PetSettings reads the router (the deep-link anchor + the storefront opener),
// so the view renders inside a MemoryRouter.
function renderView(initialEntries?: string[]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AtumConsumerSettings />
    </MemoryRouter>
  )
}

describe('AtumConsumerSettings', () => {
  it('shows only the everyday language, appearance and text-size controls', () => {
    renderView()

    expect(screen.getByText('Language')).toBeTruthy()
    expect(screen.getByText('Appearance')).toBeTruthy()
    expect(screen.getByText('Text size')).toBeTruthy()
    expect(screen.queryByText('Gateway')).toBeNull()
    expect(screen.queryByText('API keys')).toBeNull()
  })

  it('updates the persistent native zoom bridge from the text-size slider', () => {
    renderView()

    fireEvent.change(screen.getByRole('slider', { name: 'Text size' }), { target: { value: '110' } })

    expect(setPercent).toHaveBeenCalledWith(110)
    expect(screen.getByText('110%')).toBeTruthy()
  })

  it('shows the bounded consumer size when Advanced previously set a larger zoom', () => {
    $zoomPercent.set(150)

    renderView()

    expect((screen.getByRole('slider', { name: 'Text size' }) as HTMLInputElement).value).toBe('110')
    expect(screen.getByText('110%')).toBeTruthy()
    expect(screen.queryByText('150%')).toBeNull()
  })

  // Pets are a consumer feature, so their settings live here in the open —
  // not behind Advanced — and the account menu's "Pet settings…" deep link
  // anchors this section (atum/settings-tab-links.test.tsx guards the link).
  it('mounts the pet section in the open, carrying the deep-link anchor and its storefront link', () => {
    renderView()

    const section = document.getElementById(PET_SETTINGS_SECTION_ID)

    expect(section).toBeTruthy()
    expect(section?.getAttribute('data-atum-pet-settings-section')).not.toBeNull()
    expect(section?.querySelector('[data-atum-browse-pets]')).toBeTruthy()
  })

  it('scrolls the pet section into view when the deep-link anchor arrives in the route hash', () => {
    const scrollIntoView = vi.fn()
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView

    renderView([`/settings?tab=atum:general#${PET_SETTINGS_SECTION_ID}`])

    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('does not treat a plain visit as a deep link — no anchor, no scroll', () => {
    const scrollIntoView = vi.fn()
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView

    renderView()

    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})
