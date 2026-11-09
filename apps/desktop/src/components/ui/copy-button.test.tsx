import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { CopyButton, writeClipboardText } from './copy-button'

describe('CopyButton i18n', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('uses localized default labels and copied feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })

    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <CopyButton text="hello" />
      </I18nProvider>
    )

    const button = screen.getByRole('button', { name: '复制' })

    expect(button.textContent).toContain('复制')
    fireEvent.click(button)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('hello'))
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy())
    expect(screen.getByRole('button', { name: '已复制' }).textContent).toContain('已复制')
  })
})

describe('writeClipboardText', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'atumMatrix')
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  it("hands the text to the Matrix window's bridge when the web clipboard is refused there", async () => {
    // The Matrix window exposes atumMatrix only (no hermesDesktop), and its session denies the
    // web clipboard permission, so navigator.clipboard.writeText rejects.
    const refused = vi.fn().mockRejectedValue(new DOMException('Write permission denied.', 'NotAllowedError'))
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: refused } })
    Object.defineProperty(window, 'atumMatrix', { configurable: true, value: { clipboard: { writeText } } })

    await writeClipboardText('the answer')

    expect(writeText).toHaveBeenCalledExactlyOnceWith('the answer')
    expect(refused).not.toHaveBeenCalled()
  })

  it('falls back to the web clipboard where no bridge exists, and ignores empty text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    await writeClipboardText('')
    await writeClipboardText('plain')

    expect(writeText).toHaveBeenCalledExactlyOnceWith('plain')
  })
})
