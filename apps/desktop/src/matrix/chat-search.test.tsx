import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixMessage } from '../../shared/matrix'

import { MatrixChatSearch } from './chat-search'
import { $matrixHistoryReveal, clearMatrixHistoryReveal } from './history-search'

/** jsdom has no CSS Custom Highlight API: a registry that records what is painted. */
class FakeHighlight extends Set<AbstractRange> {
  priority = 0

  constructor(...ranges: AbstractRange[]) {
    super(ranges)
  }
}

const painted = new Map<string, FakeHighlight>()

beforeEach(() => {
  painted.clear()
  vi.stubGlobal('Highlight', FakeHighlight)
  vi.stubGlobal('CSS', { highlights: painted })
})

afterEach(() => {
  clearMatrixHistoryReveal()
  cleanup()
  vi.unstubAllGlobals()
})

const answer = (text: string) => `<div data-slot="aui_assistant-message-content"><p>${text}</p></div>`

/** A chat panel as the Matrix window lays it out: the header's search above the transcript. */
function setup(
  messages: string[],
  locale: 'en' | 'vi' = 'en',
  history?: { roomId: string; messages: readonly MatrixMessage[] }
) {
  const openRef = { current: null as (() => void) | null }

  const view = render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <section data-atum-chat>
        <header>
          <MatrixChatSearch messages={history?.messages} openRef={openRef} roomId={history?.roomId} />
        </header>
        <div data-slot="aui_thread-viewport" />
        <textarea data-slot="composer-rich-input" />
      </section>
    </I18nProvider>
  )

  const viewport = view.container.querySelector('[data-slot="aui_thread-viewport"]')!
  viewport.innerHTML = messages.map(answer).join('')

  return { openRef, view, viewport }
}

const field = () => screen.getByRole('search').querySelector('input')!
const counter = () => window.document.querySelector('[data-matrix-chat-search-count]')?.textContent
const announced = () => screen.getByRole('status').textContent

describe('MatrixChatSearch', () => {
  it('slides open from its button, finds this chat’s words newest first, and steps through them', async () => {
    setup(['Morning at Tuyền Lâm Lake', 'A quiet lake guesthouse', 'Back from the lake'], 'vi')

    fireEvent.click(screen.getByRole('button', { name: 'Tìm trong cuộc trò chuyện' }))
    expect(screen.getByRole('search')).toBeTruthy()
    await waitFor(() => expect(window.document.activeElement).toBe(field()))
    expect(field().getAttribute('placeholder')).toBe('Tìm trong cuộc trò chuyện')

    fireEvent.change(field(), { target: { value: 'lake' } })
    expect(counter()).toBe('1/3')
    expect(announced()).toBe('Kết quả 1 trên 3')
    // The newest match is the one you are on; every match is painted.
    expect(painted.get('atum-chat-search')?.size).toBe(3)
    expect([...painted.get('atum-chat-search-current')!][0]?.startContainer.textContent).toBe('Back from the lake')

    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(counter()).toBe('2/3')
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(counter()).toBe('3/3')
    expect([...painted.get('atum-chat-search-current')!][0]?.startContainer.textContent).toBe(
      'Morning at Tuyền Lâm Lake'
    )
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true })
    expect(counter()).toBe('2/3')
    fireEvent.click(screen.getByRole('button', { name: 'Kết quả mới hơn' }))
    expect(counter()).toBe('1/3')
    fireEvent.click(screen.getByRole('button', { name: 'Kết quả cũ hơn' }))
    expect(counter()).toBe('2/3')
  })

  it('says plainly when nothing matches, and offers no steps then', () => {
    setup(['Coffee at a hillside café'])

    fireEvent.click(screen.getByRole('button', { name: 'Search this chat' }))
    fireEvent.change(field(), { target: { value: 'zebra' } })

    expect(announced()).toBe('No results')
    expect(counter()).toContain('No results')
    expect(screen.queryByRole('button', { name: 'Older match' })).toBeNull()
    expect(painted.size).toBe(0)
  })

  it('folds back on Escape, clears what it painted and hands focus to its button', async () => {
    setup(['The flower market'])

    fireEvent.click(screen.getByRole('button', { name: 'Search this chat' }))
    fireEvent.change(field(), { target: { value: 'flower' } })
    expect(painted.size).toBe(2)

    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(screen.queryByRole('search')).toBeNull()
    expect(painted.size).toBe(0)
    await waitFor(() =>
      expect(window.document.activeElement).toBe(screen.getByRole('button', { name: 'Search this chat' }))
    )
  })

  it('folds back from × to the message box, and on its own once an empty field loses focus', () => {
    setup(['The flower market'])

    fireEvent.click(screen.getByRole('button', { name: 'Search this chat' }))
    fireEvent.change(field(), { target: { value: 'flower' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }), { detail: 1 })
    expect(screen.queryByRole('search')).toBeNull()
    expect(window.document.activeElement?.getAttribute('data-slot')).toBe('composer-rich-input')

    fireEvent.click(screen.getByRole('button', { name: 'Search this chat' }))
    fireEvent.focusOut(field(), { relatedTarget: window.document.body })
    expect(screen.queryByRole('search')).toBeNull()
  })

  it('opens from ⌘F (its open handle) and keeps the match you are on as new messages arrive', async () => {
    const { openRef, viewport } = setup(['Pines by the lake'])

    act(() => openRef.current?.())
    await waitFor(() => expect(window.document.activeElement).toBe(field()))
    fireEvent.change(field(), { target: { value: 'pines' } })
    expect(counter()).toBe('1/1')

    act(() => viewport.insertAdjacentHTML('beforeend', answer('More pines')))
    // The new match is the newest; the one you were on is now the second.
    await waitFor(() => expect(counter()).toBe('2/2'))
    expect([...painted.get('atum-chat-search-current')!][0]?.startContainer.textContent).toBe('Pines by the lake')
  })

  it('walks older encrypted pages to a hidden result and states the bounded search', async () => {
    const all: MatrixMessage[] = Array.from({ length: 600 }, (_, index) => ({
      id: `$message-${index + 1}`,
      sender: '@person:test',
      body: index === 19 ? 'The hidden orchid' : `Message ${index + 1}`,
      timestamp: index,
      own: false,
      encrypted: true,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false
    }))
    let first = 400
    const loaded = all.slice(first)
    const previous = window.atumMatrix
    const command = vi.fn(async () => {
      const next = Math.max(0, first - 50)
      loaded.unshift(...all.slice(next, first))
      first = next

      return { loaded: 50, visible: loaded.length, hasMore: first > 0, capped: false }
    })
    window.atumMatrix = { ...previous, command }

    try {
      setup(
        loaded.map(message => message.body),
        'en',
        { roomId: '!long:test', messages: loaded }
      )
      fireEvent.click(screen.getByRole('button', { name: 'Search this chat' }))
      fireEvent.change(field(), { target: { value: 'orchid' } })

      await waitFor(() => expect($matrixHistoryReveal.get()).toEqual({ roomId: '!long:test', eventId: '$message-20' }))
      expect(command).toHaveBeenCalledTimes(8)
      expect(counter()).toContain('Searched 600 of 2200')
    } finally {
      window.atumMatrix = previous
    }
  })
})
