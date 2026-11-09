import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $railDestination, resetAtumShellState } from '@/store/atum-shell'

import { AtumNavSwitch } from './nav-switch'

function renderSwitch(locale: 'en' | 'vi' = 'en') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <AtumNavSwitch />
    </I18nProvider>
  )
}

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

beforeEach(() => {
  resetAtumShellState()
})

afterEach(() => {
  cleanup()
})

describe('AtumNavSwitch', () => {
  it('is one navigation with Home current, the Store, a divider and a disabled Workplace', () => {
    renderSwitch()

    const nav = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(nav.querySelector('.atum-nav-divider')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Store' }).getAttribute('aria-current')).toBeNull()

    const workplace = screen.getByRole('button', { name: 'Workplace · Coming soon' })
    expect(workplace.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(workplace)
    expect($railDestination.get()).toBe('chat')
  })

  it('switches the destination and moves the current mark', () => {
    renderSwitch()

    fireEvent.click(screen.getByRole('button', { name: 'Store' }))
    expect($railDestination.get()).toBe('discover')
    expect(screen.getByRole('button', { name: 'Store' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    expect($railDestination.get()).toBe('chat')
  })

  it('speaks Vietnamese first', () => {
    renderSwitch('vi')

    expect(screen.getByRole('navigation', { name: 'Điều hướng chính' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Trang chính' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cửa hàng' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Nơi làm việc · Sắp có' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Nơi làm việc · Sắp có' }))
    expect(screen.getByRole('dialog').textContent).toContain('Chỗ này chưa sẵn sàng.')
  })
})
