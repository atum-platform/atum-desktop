import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $notifications } from '@/store/notifications'
import { $connection } from '@/store/session'

import { PreviewPane } from './preview-pane'

describe('PreviewPane console state', () => {
  beforeEach(() => {
    $notifications.set([])
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(Date.now()), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  })

  afterEach(() => {
    cleanup()
    $notifications.set([])
    $connection.set(null)
    vi.unstubAllGlobals()
  })

  it('does not watch backend-only remote filesystem previews locally', async () => {
    const watchPreviewFile = vi.fn(async () => ({ id: 'watch-1', path: '/remote/file.txt' }))
    const onPreviewFileChanged = vi.fn(() => vi.fn())
    $connection.set({ mode: 'remote' } as never)
    vi.stubGlobal('window', {
      ...window,
      hermesDesktop: {
        onPreviewFileChanged,
        watchPreviewFile
      }
    })

    await act(async () => {
      render(
        <PreviewPane
          setTitlebarToolGroup={vi.fn()}
          target={{
            kind: 'file',
            label: 'file.txt',
            path: '/remote/file.txt',
            previewKind: 'text',
            source: '/remote/file.txt',
            url: 'file:///remote/file.txt'
          }}
        />
      )
    })

    expect(watchPreviewFile).not.toHaveBeenCalled()
    expect(onPreviewFileChanged).not.toHaveBeenCalled()
  })

  it('does not rebuild the pane titlebar group for streamed console logs', async () => {
    const setTitlebarToolGroup = vi.fn()

    let rendered!: ReturnType<typeof render>
    await act(async () => {
      rendered = render(
        <PreviewPane
          setTitlebarToolGroup={setTitlebarToolGroup}
          target={{
            kind: 'url',
            label: 'Preview',
            source: 'http://localhost:5174',
            url: 'http://localhost:5174'
          }}
        />
      )
    })

    const initialCalls = setTitlebarToolGroup.mock.calls.length
    const webview = rendered.container.querySelector('webview')

    const configuredTools = setTitlebarToolGroup.mock.calls.findLast(
      call => Array.isArray(call[1]) && call[1].length > 0
    )?.[1] as Array<{ id: string }> | undefined

    expect(webview).toBeInstanceOf(HTMLElement)
    expect(configuredTools?.map(tool => tool.id)).toEqual(['preview-console'])

    act(() => {
      webview?.dispatchEvent(
        Object.assign(new Event('console-message'), {
          level: 0,
          message: 'streamed log line',
          sourceId: 'http://localhost:5174/src/main.tsx'
        })
      )
    })

    expect(setTitlebarToolGroup).toHaveBeenCalledTimes(initialCalls)
  })

  it('surfaces denied preview downloads through the shared browser notice', async () => {
    let onNotice!: (payload: { sourceWebContentsId: number; type: 'download_refused' }) => void
    const stopNotice = vi.fn()

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        consumerBrowser: {
          onNotice: vi.fn(callback => {
            onNotice = callback

            return stopNotice
          })
        }
      }
    })

    let rendered!: ReturnType<typeof render>
    await act(async () => {
      rendered = render(
        <PreviewPane
          target={{
            kind: 'url',
            label: 'Preview',
            source: 'https://example.test',
            url: 'https://example.test'
          }}
        />
      )
    })

    const webview = rendered.container.querySelector('webview') as HTMLElement & { getWebContentsId?: () => number }
    webview.getWebContentsId = () => 7

    act(() => onNotice({ sourceWebContentsId: 7, type: 'download_refused' }))

    expect($notifications.get()[0]).toMatchObject({ kind: 'info', message: 'Preview' })
    cleanup()
    expect(stopNotice).toHaveBeenCalled()
  })

  it('uses an ephemeral partition and exposes no developer controls for a restricted artifact', async () => {
    const setTitlebarToolGroup = vi.fn()
    let rendered!: ReturnType<typeof render>

    await act(async () => {
      rendered = render(
        <PreviewPane
          restricted
          setTitlebarToolGroup={setTitlebarToolGroup}
          target={{
            kind: 'url',
            label: 'Lá số',
            partition: 'atum-artifact-1',
            source: 'https://moon.test/42',
            url: 'https://moon.test/42'
          }}
        />
      )
    })

    expect(rendered.container.querySelector('webview')?.getAttribute('partition')).toBe('atum-artifact-1')
    expect(setTitlebarToolGroup.mock.calls.some(call => Array.isArray(call[1]) && call[1].length > 0)).toBe(false)

    const webview = rendered.container.querySelector('webview')!
    const offOrigin = Object.assign(new Event('will-navigate', { cancelable: true }), { url: 'https://evil.test/' })

    const sameOrigin = Object.assign(new Event('will-navigate', { cancelable: true }), {
      url: 'https://moon.test/next'
    })

    const offOriginRedirect = Object.assign(new Event('will-redirect', { cancelable: true }), {
      url: 'https://evil.test/redirect'
    })

    webview.dispatchEvent(offOrigin)
    webview.dispatchEvent(sameOrigin)
    webview.dispatchEvent(offOriginRedirect)
    expect(offOrigin.defaultPrevented).toBe(true)
    expect(sameOrigin.defaultPrevented).toBe(false)
    expect(offOriginRedirect.defaultPrevented).toBe(true)
  })
})
