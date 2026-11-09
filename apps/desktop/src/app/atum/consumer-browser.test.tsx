import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { AtumConsumerBrowser, type ConsumerBrowserBridge, consumerBrowserTabTitle, createConsumerBrowserTab } from './consumer-browser'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderBrowser(
  prepare = vi.fn(async ({ url }: { url: string }) => ({ url })),
  onOpenExternal = vi.fn(async () => undefined)
) {
  const onUpdate = vi.fn()
  const tab = createConsumerBrowserTab('https://example.com/path')
  globalThis.window.hermesDesktop = {
    consumerBrowser: {
      onPopup: vi.fn(() => () => undefined),
      onNotice: vi.fn(() => () => undefined),
      prepare,
      release: vi.fn(async () => ({ ok: true }))
    }
  } as never
  render(
    <I18nProvider configClient={null} initialLocale="vi">
      <AtumConsumerBrowser onOpenExternal={onOpenExternal} onOpenTab={vi.fn()} onUpdate={onUpdate} tab={tab} />
    </I18nProvider>
  )

  return { onOpenExternal, onUpdate, prepare, tab }
}

describe('Atum consumer browser chrome', () => {
  it('renders every icon-only control with its Tip contract and the host-forward address', async () => {
    renderBrowser()
    expect(screen.getByRole('button', { name: 'Quay lại' }).hasAttribute('data-icon-only')).toBe(true)
    expect(screen.getByRole('button', { name: 'Tiếp' }).hasAttribute('data-icon-only')).toBe(true)
    expect(screen.getByRole('button', { name: 'Dừng' }).hasAttribute('data-icon-only')).toBe(true)
    expect((screen.getByRole('textbox', { name: 'Địa chỉ hoặc tìm kiếm' }) as HTMLInputElement).value).toBe(
      'example.com'
    )
    expect(screen.getByRole('progressbar', { name: 'Đang tải trang' })).toBeTruthy()
    await waitFor(() => expect(window.document.querySelector('webview')).toBeTruthy())
  })

  it('shows the full URL on focus and routes typed searches through main validation', async () => {
    const { prepare } = renderBrowser()
    const address = screen.getByRole('textbox', { name: 'Địa chỉ hoặc tìm kiếm' })
    fireEvent.focus(address)
    expect((address as HTMLInputElement).value).toBe('https://example.com/path')
    expect((address as HTMLInputElement).selectionStart).toBe(0)
    expect((address as HTMLInputElement).selectionEnd).toBe('https://example.com/path'.length)
    fireEvent.change(address, { target: { value: 'thời tiết Đà Nẵng' } })
    fireEvent.keyDown(address, { key: 'Enter' })
    await waitFor(() => expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ url: 'thời tiết Đà Nẵng' })))
  })

  it('renders the honest blocked state when main refuses a destination', async () => {
    const { onUpdate } = renderBrowser(vi.fn(async () => Promise.reject(new Error('browser_url_blocked'))))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' })))
  })

  it('opens the current page through the injected trusted external opener', async () => {
    const { onOpenExternal } = renderBrowser()

    const webview = await waitFor(() => {
      const node = window.document.querySelector('webview') as HTMLElement & { getURL?: () => string }
      expect(node).toBeTruthy()

      return node
    })

    webview.getURL = () => 'https://example.com/current?view=full'
    fireEvent.click(screen.getByRole('button', { name: 'Mở bằng trình duyệt' }))

    expect(onOpenExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/current?view=full')
  })

  it('uses an injected Matrix bridge without the legacy desktop bridge', async () => {
    let popup!: (payload: { sourceWebContentsId: number; url: string }) => void

    const bridge: ConsumerBrowserBridge = {
      onPopup: vi.fn(callback => {
        popup = callback

        return () => undefined
      }),
      onNotice: vi.fn(() => () => undefined),
      prepare: vi.fn(async ({ url }) => ({ url })),
      release: vi.fn(async () => ({ ok: true }))
    }

    const onUpdate = vi.fn()
    const onOpenTab = vi.fn()
    globalThis.window.hermesDesktop = {} as never

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <AtumConsumerBrowser
          browser={bridge}
          onOpenTab={onOpenTab}
          onUpdate={onUpdate}
          tab={createConsumerBrowserTab('https://example.com')}
        />
      </I18nProvider>
    )

    await waitFor(() =>
      expect(bridge.prepare).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com' }))
    )

    const webview = await waitFor(() => {
      const node = window.document.querySelector('webview') as HTMLElement & { getWebContentsId?: () => number }
      expect(node).toBeTruthy()

      return node
    })

    webview.getWebContentsId = () => 17
    popup({ sourceWebContentsId: 17, url: 'https://example.com/popup' })
    expect(onOpenTab).toHaveBeenCalledWith('https://example.com/popup')
  })

  it('drops late native preparation after unmount instead of projecting stale tab state', async () => {
    let resolve!: (value: { url: string }) => void

    const bridge: ConsumerBrowserBridge = {
      onPopup: vi.fn(() => () => undefined),
      onNotice: vi.fn(() => () => undefined),
      prepare: vi.fn(
        () =>
          new Promise<{ url: string }>(done => {
            resolve = done
          })
      ),
      release: vi.fn(async () => ({ ok: true }))
    }

    const onUpdate = vi.fn()
    const tab = createConsumerBrowserTab('https://example.com')

    const view = render(
      <I18nProvider configClient={null} initialLocale="en">
        <AtumConsumerBrowser browser={bridge} onOpenTab={vi.fn()} onUpdate={onUpdate} tab={tab} />
      </I18nProvider>
    )

    await waitFor(() => expect(bridge.prepare).toHaveBeenCalled())
    view.unmount()
    resolve({ url: 'https://example.com' })
    await Promise.resolve()

    expect(onUpdate).not.toHaveBeenCalled()
    expect(bridge.release).toHaveBeenCalledWith(tab.partition)
  })
})

describe('consumerBrowserTabTitle', () => {
  it('names a tab for its site before the page names itself', () => {
    expect(consumerBrowserTabTitle('https://www.vnexpress.net/the-gioi', 'Trình duyệt')).toBe('vnexpress.net')
    expect(consumerBrowserTabTitle('vnexpress.net', 'Trình duyệt')).toBe('vnexpress.net')
  })

  it('never names a tab for a search phrase or a developer address', () => {
    expect(consumerBrowserTabTitle('cà phê đà lạt', 'Trình duyệt')).toBe('Trình duyệt')
    expect(consumerBrowserTabTitle('hello', 'Browser')).toBe('Browser')
    expect(consumerBrowserTabTitle('http://localhost:5173/booking', 'Trình duyệt')).toBe('Trình duyệt')
    expect(consumerBrowserTabTitle('localhost:5173', 'Browser')).toBe('Browser')
    expect(consumerBrowserTabTitle('http://127.0.0.1:8080/', 'Browser')).toBe('Browser')
  })
})
