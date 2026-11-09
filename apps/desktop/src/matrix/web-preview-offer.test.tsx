import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import { MatrixWebPreviewOfferCard, webPreviewPlace } from './web-preview-offer'

const command = vi.fn()
const offer = { id: 'offer', label: 'A page', hostname: 'example.test', expiresAt: Date.now() + 300000 }
beforeEach(() => {
  command.mockReset()
  Object.assign(window, { atumMatrix: { command } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'atumMatrix')
})

function frame(
  onOpened = vi.fn(),
  scope = 'own',
  value: typeof offer | null = offer,
  locale: Locale = 'en',
  full = false
) {
  return (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixWebPreviewOfferCard
        full={full}
        offer={value ?? undefined}
        onOpened={onOpened}
        roomId="!one:test"
        scope={scope}
      />
    </I18nProvider>
  )
}

it('retains focus and sends no command until the user opens the current offer', async () => {
  const opened = vi.fn(),
    view = render(frame(opened))

  expect(command).not.toHaveBeenCalled()
  const button = screen.getByRole('button', { name: 'View page · A page' })
  button.focus()
  view.rerender(frame(opened))
  expect(view.baseElement.ownerDocument.activeElement).toBe(button)
  command.mockResolvedValue({ id: offer.id, url: 'https://example.test/page' })
  fireEvent.click(button)
  await waitFor(() =>
    expect(opened).toHaveBeenCalledWith({ id: offer.id, url: 'https://example.test/page', scope: 'own' })
  )
  expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'openWebPreview', roomId: '!one:test', id: offer.id })
})

it('accepts the successful receipt after native consumption removes the offer', async () => {
  let complete!: (value: unknown) => void
  command.mockImplementation(
    () =>
      new Promise(resolve => {
        complete = resolve
      })
  )

  const opened = vi.fn(),
    view = render(frame(opened))

  fireEvent.click(screen.getByRole('button', { name: 'View page · A page' }))
  view.rerender(frame(opened, 'own', null))
  expect(screen.queryByRole('button', { name: 'View page · A page' })).toBeNull()
  await act(async () => complete({ id: offer.id, url: 'https://example.test/page' }))
  expect(opened).toHaveBeenCalledTimes(1)
})

it('retires a late receipt across room changes without opening any tab', async () => {
  let complete!: (value: unknown) => void
  command.mockImplementation(
    () =>
      new Promise(resolve => {
        complete = resolve
      })
  )

  const opened = vi.fn(),
    view = render(frame(opened))

  fireEvent.click(screen.getByRole('button', { name: 'View page · A page' }))
  view.rerender(frame(opened, 'foreign'))
  await act(async () => complete({ id: offer.id, url: 'https://example.test/page' }))
  expect(opened).not.toHaveBeenCalled()
})

it('reports a lost outcome without retrying or opening a tab', async () => {
  command.mockRejectedValue(new Error('private-details'))
  const opened = vi.fn()
  render(frame(opened))
  fireEvent.click(screen.getByRole('button', { name: 'View page · A page' }))
  await screen.findByText(/no longer available/)
  expect(command).toHaveBeenCalledTimes(1)
  expect(opened).not.toHaveBeenCalled()
  expect(screen.queryByText(/private-details/)).toBeNull()
})

it('retires a late receipt even after returning to the original room', async () => {
  let complete!: (value: unknown) => void
  command.mockImplementation(
    () =>
      new Promise(resolve => {
        complete = resolve
      })
  )

  const opened = vi.fn(),
    view = render(frame(opened))

  fireEvent.click(screen.getByRole('button', { name: 'View page · A page' }))
  view.rerender(frame(opened, 'foreign', null))
  view.rerender(frame(opened, 'own', null))
  await act(async () => complete({ id: offer.id, url: 'https://example.test/page' }))
  expect(opened).not.toHaveBeenCalled()
})

it('keeps a full workspace offer available to dismiss without consuming the open action', async () => {
  render(frame(vi.fn(), 'own', offer, 'en', true))
  fireEvent.click(screen.getByRole('button', { name: 'View page · A page' }))
  expect(command).not.toHaveBeenCalled()
  expect(screen.getByText('Close a side panel tab to open this page.')).toBeTruthy()
  command.mockResolvedValue(undefined)
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  await waitFor(() =>
    expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'dismissWebPreview', roomId: '!one:test', id: offer.id })
  )
})

it.each(['en', 'vi', 'zh', 'zh-hant', 'ja'] as Locale[])(
  'renders an actionable offer in %s without opening it',
  locale => {
    render(frame(vi.fn(), 'own', offer, locale))
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(command).not.toHaveBeenCalled()
  }
)

it('names a public site but never shows a developer\'s localhost', () => {
  const view = render(frame(vi.fn(), 'own', { ...offer, label: 'Booking page', hostname: 'localhost:5173' }))
  expect(screen.getByText('Booking page')).toBeTruthy()
  expect(screen.queryByText(/localhost/)).toBeNull()
  expect(screen.getByText('A page your assistant made')).toBeTruthy()
  view.unmount()
  render(frame(vi.fn(), 'own', { ...offer, label: 'Booking page', hostname: 'booking.example.com' }))
  expect(screen.getByText('booking.example.com')).toBeTruthy()
})

it('treats every local address as local', () => {
  for (const hostname of ['localhost', 'localhost:3000', '127.0.0.1:8080', '[::1]:5173', '0.0.0.0:4000']) {
    expect(webPreviewPlace(hostname)).toBeNull()
  }

  expect(webPreviewPlace('preview.atum.chat')).toBe('preview.atum.chat')
})
