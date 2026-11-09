import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from '@/components/error-boundary'
import { I18nProvider } from '@/i18n'

import { MatrixCrashFallback } from './crash-fallback'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Broken({ broken }: { broken: { current: boolean } }) {
  if (broken.current) {
    throw new Error("Cannot read properties of undefined (reading 'roomId')")
  }

  return <p>Chats</p>
}

describe('MatrixCrashFallback', () => {
  it('says what happened in the window language, never the raw error, and tries again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = { current: true }

    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <ErrorBoundary fallback={({ reset }) => <MatrixCrashFallback reset={reset} />} label="test">
          <Broken broken={broken} />
        </ErrorBoundary>
      </I18nProvider>
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Giao diện gặp lỗi')
    expect(alert.textContent).not.toContain('roomId')
    expect(screen.queryByRole('button', { name: 'Mở nhật ký' })).toBeNull()

    broken.current = false
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
    expect(screen.getByText('Chats')).toBeTruthy()
  })
})
