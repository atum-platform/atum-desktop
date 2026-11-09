import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom reports no platform; the shortcut glyphs in these assertions are macOS's.
beforeEach(() => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
})

import { I18nProvider } from '@/i18n'

import { MarkdownToolbar } from './markdown-toolbar'

const NONE = { emphasis: false, heading: 0 as const, link: false, list: false, strong: false }

describe('MarkdownToolbar', () => {
  it('is a labelled toolbar with a roving tabindex and pressed state', () => {
    const onCommand = vi.fn()
    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <MarkdownToolbar
          active={{
            code: false,
            codeBlock: false,
            emphasis: false,
            heading: 0,
            link: false,
            list: false,
            orderedList: false,
            quote: false,
            strikethrough: false,
            strong: true
          }}
          onCommand={onCommand}
        />
      </I18nProvider>
    )
    const toolbar = screen.getByRole('toolbar', { name: 'Định dạng' })
    const buttons = Array.from(toolbar.querySelectorAll('button'))
    expect(buttons).toHaveLength(11)
    expect(buttons.map(button => button.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1])
    expect(screen.getByRole('button', { name: 'Đậm (⌘B)' }).getAttribute('aria-pressed')).toBe('true')

    buttons[0].focus()
    fireEvent.keyDown(toolbar, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(buttons[1])
    expect(buttons.map(button => button.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1])
    fireEvent.keyDown(toolbar, { key: 'End' })
    expect(document.activeElement).toBe(buttons[10])

    fireEvent.click(screen.getByRole('button', { name: 'Tiêu đề' }))
    expect(onCommand).toHaveBeenCalledTimes(1)
  })
})

it('offers every construct Markdown can hold, with ARIA shortcuts, and nothing it cannot', () => {
  const onCommand = vi.fn()
  render(
    <I18nProvider configClient={null} initialLocale="vi">
      <MarkdownToolbar
        active={{
          code: true,
          codeBlock: false,
          emphasis: false,
          heading: 0,
          link: false,
          list: false,
          orderedList: true,
          quote: true,
          strikethrough: true,
          strong: false
        }}
        onCommand={onCommand}
      />
    </I18nProvider>
  )

  const names = screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))
  expect(names).toEqual([
    'Tiêu đề',
    'Đậm (⌘B)',
    'Nghiêng (⌘I)',
    'Gạch ngang (⌘⇧X)',
    'Mã (⌘E)',
    'Danh sách (⌘⇧8)',
    'Danh sách đánh số (⌘⇧7)',
    'Trích dẫn (⌘⇧9)',
    'Khối mã',
    'Liên kết (⌘K)',
    'Bảng'
  ])
  expect(screen.getByRole('button', { name: 'Gạch ngang (⌘⇧X)' }).getAttribute('aria-keyshortcuts')).toBe(
    'Meta+Shift+X'
  )
  expect(screen.getByRole('button', { name: 'Mã (⌘E)' }).getAttribute('aria-keyshortcuts')).toBe('Meta+E')
  expect(screen.getByRole('button', { name: 'Mã (⌘E)' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'Danh sách đánh số (⌘⇧7)' }).getAttribute('aria-pressed')).toBe('true')
  // Table is an insert action, not a toggle button.
  expect(screen.getByRole('button', { name: 'Bảng' }).hasAttribute('aria-pressed')).toBe(false)
  expect(screen.getAllByRole('button').filter(button => button.hasAttribute('disabled'))).toEqual([])
})

it('spells shortcuts for the real platform, in the tip and in aria-keyshortcuts', () => {
  const platform = vi.spyOn(navigator, 'platform', 'get')
  platform.mockReturnValue('Win32')
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0)')

  const { unmount } = render(
    <I18nProvider configClient={null} initialLocale="vi">
      <MarkdownToolbar
        active={{
          code: false,
          codeBlock: false,
          emphasis: false,
          heading: 0,
          link: false,
          list: false,
          orderedList: false,
          quote: false,
          strikethrough: false,
          strong: false
        }}
        onCommand={vi.fn()}
      />
    </I18nProvider>
  )

  expect(screen.getByRole('button', { name: 'Đậm (Ctrl+B)' }).getAttribute('aria-keyshortcuts')).toBe('Control+B')
  expect(screen.getByRole('button', { name: 'Gạch ngang (Ctrl+Shift+X)' }).getAttribute('aria-keyshortcuts')).toBe(
    'Control+Shift+X'
  )
  unmount()

  platform.mockReturnValue('MacIntel')
  render(
    <I18nProvider configClient={null} initialLocale="vi">
      <MarkdownToolbar
        active={{
          code: false,
          codeBlock: false,
          emphasis: false,
          heading: 0,
          link: false,
          list: false,
          orderedList: false,
          quote: false,
          strikethrough: false,
          strong: false
        }}
        onCommand={vi.fn()}
      />
    </I18nProvider>
  )
  expect(screen.getByRole('button', { name: 'Danh sách (⌘⇧8)' }).getAttribute('aria-keyshortcuts')).toBe('Meta+Shift+8')
  vi.restoreAllMocks()
})
