import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { DocumentNavigationApi } from './document-editor-controller'
import { DocumentNavigation, documentOutline, documentWordCount } from './document-navigation'

afterEach(cleanup)

function mount(disabled = false, outline = false, composing = false) {
  const api: DocumentNavigationApi = {
    getOutline: vi.fn(() => [{ from: 9, title: 'Details', level: 2 }]),
    navigateToHeading: vi.fn(() => true),
    replaceSearchMatch: vi.fn(() => true),
    search: vi.fn(() => ({ current: 2, total: 3 })),
    setSearchQuery: vi.fn(query => ({ current: 0, total: query === 'target' ? 3 : 0 }))
  }

  const onClose = vi.fn()
  const onFocusEditor = vi.fn()
  render(<I18nProvider configClient={null} initialLocale="en">
    <DocumentNavigation api={api} composing={composing} disabled={disabled} editorKey="rich" focusRequest={0} onClose={onClose} onFocusEditor={onFocusEditor} outline={outline} text="# Details" />
  </I18nProvider>)

  return { api, onClose, onFocusEditor }
}

describe('document navigation', () => {
  it('derives source heading anchors and language-aware word counts', () => {
    expect(documentOutline('# Start\n\n### Detail\n\nConclusion\n==========\n')).toEqual([
      { from: 0, level: 1, title: 'Start' }, { from: 9, level: 3, title: 'Detail' }, { from: 21, level: 1, title: 'Conclusion' }
    ])
    expect(documentWordCount('Xin chào Atum — 2026.')).toBe(4)
  })

  it('navigates headings through the active editor API and restores focus', () => {
    const { api, onFocusEditor } = mount(false, true)
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(api.navigateToHeading).toHaveBeenCalledWith(9)
    expect(onFocusEditor).toHaveBeenCalledTimes(1)
  })

  it('focuses Find, keeps focus for Enter/Shift+Enter, and announces match state', () => {
    const { api, onFocusEditor } = mount()
    const input = screen.getByRole('textbox', { name: 'Find' })
    expect(globalThis.document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'target' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(api.search).toHaveBeenLastCalledWith('target', 1)
    expect(screen.getByRole('status').textContent).toBe('2 of 3')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(api.search).toHaveBeenLastCalledWith('target', -1)
    expect(globalThis.document.activeElement).toBe(input)
    expect(onFocusEditor).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'missing' } })
    expect(screen.getByRole('status').textContent).toBe('No matches')
  })

  it('replaces through the active editor and advances without moving input focus', () => {
    const { api } = mount()
    fireEvent.change(screen.getByRole('textbox', { name: 'Find' }), { target: { value: 'target' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Replace' }), { target: { value: 'replacement' } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection' }))
    expect(api.replaceSearchMatch).toHaveBeenCalledWith('target', 'replacement')
    expect(api.search).toHaveBeenLastCalledWith('target', 1)
    vi.mocked(api.replaceSearchMatch).mockClear()
    const replaceInput = screen.getByRole('textbox', { name: 'Replace' })
    replaceInput.focus()
    fireEvent.keyDown(replaceInput, { key: 'Enter' })
    expect(api.replaceSearchMatch).toHaveBeenCalledWith('target', 'replacement')
    expect(globalThis.document.activeElement).toBe(replaceInput)
  })

  it('closes once on Escape and restores editor focus', () => {
    const { onClose, onFocusEditor } = mount()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Find' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onFocusEditor).toHaveBeenCalledTimes(1)
  })

  it('does not act during input composition or when navigation is disabled', () => {
    const { api, onClose } = mount(true, false, true)
    const input = screen.getByRole('textbox', { name: 'Find' })
    fireEvent.change(input, { target: { value: 'target' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(api.search).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    cleanup()
    const active = mount()
    fireEvent.change(screen.getByRole('textbox', { name: 'Find' }), { target: { value: 'target' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Find' }), { key: 'Enter', isComposing: true })
    expect(active.api.search).not.toHaveBeenCalled()
  })

  it('allows Escape while saving without enabling navigation or replacement', () => {
    const { api, onClose, onFocusEditor } = mount(true)
    const input = screen.getByRole('textbox', { name: 'Find' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(api.search).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    expect(onFocusEditor).toHaveBeenCalledOnce()
  })
})
