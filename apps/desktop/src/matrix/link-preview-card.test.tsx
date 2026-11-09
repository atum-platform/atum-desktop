import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixMessage } from '../../shared/matrix'
import type { MatrixLinkPreview } from '../../shared/matrix-link-preview'

import { MatrixLinkPreviewCard } from './link-preview-card'
import { $matrixHiddenLinkPreviews, $matrixLinkPreviews } from './link-previews'

const PREVIEW: MatrixLinkPreview = {
  url: 'https://example.com/post',
  host: 'example.com',
  siteName: 'Example',
  title: 'A post worth reading',
  description: 'What the page says about itself.'
}

function message(body: string, extra: Partial<MatrixMessage> = {}): MatrixMessage {
  return {
    id: '$event-1',
    sender: '@linh:test',
    body,
    timestamp: Date.UTC(2026, 10, 7, 9),
    own: false,
    encrypted: false,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    ...extra
  }
}

let read: ReturnType<typeof vi.fn>
let openLink: ReturnType<typeof vi.fn>

function draw(value: MatrixMessage, roomEncrypted = false) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixLinkPreviewCard message={value} roomEncrypted={roomEncrypted} roomId="!plain:test" />
    </I18nProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  $matrixLinkPreviews.set({})
  $matrixHiddenLinkPreviews.set([])
  read = vi.fn(async () => PREVIEW)
  openLink = vi.fn(async () => undefined)
  Object.assign(window, { atumMatrix: { linkPreviews: { read }, openLink } })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('MatrixLinkPreviewCard', () => {
  it('asks about the message, not a link, and draws one card for its first link', async () => {
    draw(message('Two links: https://example.com/post and https://example.org/other'))

    expect(await screen.findByText('A post worth reading')).toBeTruthy()
    expect(read).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledWith('!plain:test', '$event-1')
    expect(document.querySelectorAll('[data-matrix-link-preview]')).toHaveLength(1)
    expect(screen.getByText('Example')).toBeTruthy()
    expect(screen.getByText('What the page says about itself.')).toBeTruthy()
  })

  it('opens the link as the message link does', async () => {
    draw(message('https://example.com/post'))
    fireEvent.click(await screen.findByText('A post worth reading'))

    await waitFor(() => expect(openLink).toHaveBeenCalledWith('https://example.com/post'))
  })

  it('asks nothing and draws nothing in an encrypted chat', async () => {
    draw(message('https://example.com/post'), true)
    draw(message('https://example.com/post', { id: '$event-2', encrypted: true }))
    await act(async () => {})

    expect(read).not.toHaveBeenCalled()
    expect(document.querySelector('[data-matrix-link-preview]')).toBeNull()
  })

  it('asks nothing for a file, a message still sending, or text without a link', async () => {
    draw(message('https://example.com/a.pdf', { attachment: true }))
    draw(message('https://example.com/post', { id: 'local-1', pending: true }))
    draw(message('no link here', { id: '$event-3' }))
    await act(async () => {})

    expect(read).not.toHaveBeenCalled()
  })

  it('asks once per link and day, even when the message scrolls away and back', async () => {
    const first = draw(message('https://example.com/post'))

    await screen.findByText('A post worth reading')
    first.unmount()
    draw(message('https://example.com/post'))
    draw(message('same https://example.com/post', { id: '$event-4' }))

    expect(await screen.findAllByText('A post worth reading')).toHaveLength(2)
    expect(read).toHaveBeenCalledOnce()
  })

  it('hides the card for this viewer only, and keeps it hidden', async () => {
    const view = draw(message('https://example.com/post'))

    fireEvent.click(await screen.findByRole('button', { name: 'Hide preview' }))
    expect(document.querySelector('[data-matrix-link-preview]')).toBeNull()
    expect(JSON.parse(localStorage.getItem('io.atum.linkPreviews.hidden') ?? '[]')).toEqual(['$event-1'])

    view.unmount()
    draw(message('https://example.com/post'))
    await act(async () => {})
    expect(document.querySelector('[data-matrix-link-preview]')).toBeNull()
  })

  it('draws nothing when the read fails or there is no preview', async () => {
    read.mockRejectedValueOnce(new Error('offline'))
    draw(message('https://example.com/post'))
    await waitFor(() => expect(read).toHaveBeenCalledOnce())
    await act(async () => {})
    expect(document.querySelector('[data-matrix-link-preview]')).toBeNull()

    read.mockResolvedValueOnce(null)
    draw(message('https://example.org/none', { id: '$event-5' }))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(document.querySelector('[data-matrix-link-preview]')).toBeNull()
  })
})
