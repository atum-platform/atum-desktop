import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $atumShellEnabled } from '@/store/atum-shell'

vi.mock('./config-settings', () => ({ ConfigSettings: () => <div>Advanced settings content</div> }))

import { SettingsView } from './index'

afterEach(() => {
  cleanup()
  $atumShellEnabled.set(true)
})

function renderSettings(path = '/settings') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <SettingsView onClose={() => undefined} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('SettingsView — Atum information architecture', () => {
  it('opens on consumer settings and exposes legacy controls through the Advanced page', () => {
    $atumShellEnabled.set(true)
    renderSettings()

    expect(screen.getAllByRole('button', { name: 'General' }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Advanced' })).toBeTruthy()
    expect(screen.getByText('Personalize how Atum looks and reads on this computer.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Model' })).toBeNull()
    expect(screen.queryByText('Uninstall Atum')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))

    expect(screen.getByRole('heading', { name: 'Advanced' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Models & providers' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    expect(screen.getByText('Advanced settings content')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Model' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Providers' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Danger Zone' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))

    expect(screen.getByRole('heading', { name: 'Advanced' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Model' })).toBeNull()
  })

  it.each(['/settings?tab=atum:protons', '/settings?tab=atum:usage'])('opens the same read-only Protons destination from %s', path => {
    renderSettings(path)
    expect(screen.getByRole('heading', { name: 'Protons' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Protons' }).every(button => button.querySelector('svg[data-proton-mark]'))).toBe(true)
    expect(window.document.querySelector('[data-atum-proton-wallet]')).toBeTruthy()
    // The legacy desktop checkout was retired 2026-10-05: nothing to buy here.
    expect(screen.queryByRole('link', { name: 'Proton purchase terms' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Your account' })).toBeNull()
  })

  it('does not unfold Advanced when a consumer opens their own Notifications', () => {
    // `notifications` is in BOTH the consumer and the legacy lists, so the
    // advanced-deep-link rule matched the consumer's own nav item: clicking it
    // exposed the entire Hermes tree, and pressing Advanced to fold it away
    // Preserve the recovery and user-visible behavior covered by this path.
    $atumShellEnabled.set(true)
    renderSettings('/settings?tab=notifications')

    expect(screen.queryByRole('button', { name: 'Model' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Providers' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-current')).not.toBe('page')
  })

  it('still unfolds Advanced for a link only Advanced can show', () => {
    $atumShellEnabled.set(true)
    renderSettings('/settings?tab=keybinds')

    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getAllByRole('button', { name: 'Model' }).length).toBeGreaterThan(0)
  })

  it('keeps account controls separate from purchases and opens a small profile editor', () => {
    renderSettings('/settings?tab=atum:account')
    expect(screen.getByRole('heading', { name: 'Account' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }))
    expect(screen.getByRole('dialog', { name: 'Your account' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Proton purchase terms' })).toBeNull()
  })

  it('leaves the legacy Hermes settings navigation unchanged when Atum shell is off', () => {
    $atumShellEnabled.set(false)
    renderSettings()

    expect(screen.getAllByRole('button', { name: 'Model' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'General' })).toBeNull()
  })
})
