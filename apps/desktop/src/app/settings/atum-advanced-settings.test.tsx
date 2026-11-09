import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { AtumAdvancedSettings } from './atum-advanced-settings'

afterEach(cleanup)

describe('Advanced models and providers', () => {
  it('groups model and provider links under one section using the existing settings routes', () => {
    const onOpen = vi.fn()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <AtumAdvancedSettings onOpen={onOpen} />
      </I18nProvider>
    )

    const models = within(screen.getByRole('region', { name: 'Models & providers' }))
    fireEvent.click(models.getByRole('button', { name: 'Choose' }))
    expect(onOpen).toHaveBeenLastCalledWith('config:model')
    fireEvent.click(models.getByRole('button', { name: 'Manage' }))
    expect(onOpen).toHaveBeenLastCalledWith('providers')
    fireEvent.click(within(screen.getByRole('region', { name: 'System configuration' })).getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenLastCalledWith('config:advanced')
    // Subscriptions live in the Matrix Settings sheet's Connections pane, not here: Advanced
    // offers only the two existing routes and never a second Connect/Manage subscription row.
    expect(models.getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByRole('region', { name: 'Subscriptions' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
  })
})
