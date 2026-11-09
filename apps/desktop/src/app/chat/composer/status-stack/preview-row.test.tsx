import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $activeSessionId } from '@/store/session'
import { $workbenchTabs, clearWorkbenchTabs, previewWorkbenchTabId } from '@/store/workbench-tabs'

const { normalizeOrLocalPreviewTarget } = vi.hoisted(() => ({ normalizeOrLocalPreviewTarget: vi.fn() }))

vi.mock('@/lib/local-preview', () => ({ normalizeOrLocalPreviewTarget }))

import { PreviewStatusRow } from './preview-row'

describe('PreviewStatusRow', () => {
  beforeEach(() => {
    clearWorkbenchTabs()
    $activeSessionId.set('demo-session')
    normalizeOrLocalPreviewTarget.mockReset()
    Object.assign(window, {
      hermesDesktop: {
        ...window.hermesDesktop,
        openPreviewInBrowser: vi.fn(async () => undefined)
      }
    })
  })

  afterEach(() => {
    cleanup()
    clearWorkbenchTabs()
    $activeSessionId.set(null)
  })

  it('keeps the preview tooltip label inline inside the portaled decoration', async () => {
    const view = render(
      <PreviewStatusRow
        item={{ cwd: 'C:\\repo', id: 'preview.html', label: 'preview.html', target: 'preview.html' }}
        onDismiss={() => undefined}
      />
    )

    fireEvent.pointerMove(screen.getByText('preview.html'), { pointerType: 'mouse' })
    await screen.findByRole('tooltip')

    const content = globalThis.document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')
    const label = content?.firstElementChild?.firstElementChild

    expect(content).not.toBeNull()
    expect(view.container.contains(content)).toBe(false)
    expect(label?.classList.contains('inline-flex')).toBe(true)
    expect(label?.classList.contains('flex')).toBe(false)
  })

  it('opens a visible tool result in the typed workbench on an ordinary click', async () => {
    normalizeOrLocalPreviewTarget.mockResolvedValue({
      kind: 'file',
      label: 'preview.html',
      path: '/workspace/preview.html',
      previewKind: 'html',
      source: '/workspace/preview.html',
      url: 'file:///workspace/preview.html'
    })

    render(
      <PreviewStatusRow
        item={{ cwd: '/workspace', id: 'preview.html', label: 'preview.html', target: 'preview.html' }}
        onDismiss={() => undefined}
      />
    )

    fireEvent.click(screen.getByText('preview.html'))

    await waitFor(() => expect($workbenchTabs.get()).toContainEqual(expect.objectContaining({
      id: previewWorkbenchTabId({ kind: 'file', label: 'preview.html', source: '/workspace/preview.html', url: 'file:///workspace/preview.html' }, 'session'),
      surface: expect.objectContaining({ kind: 'preview' })
    })))
    expect(window.hermesDesktop?.openPreviewInBrowser).not.toHaveBeenCalled()
  })

  it('keeps the system browser as a separate explicit action', async () => {
    normalizeOrLocalPreviewTarget.mockResolvedValue({
      kind: 'url', label: 'Example', source: 'https://example.com', url: 'https://example.com'
    })

    render(
      <PreviewStatusRow
        item={{ cwd: '', id: 'https://example.com', label: 'Example', target: 'https://example.com' }}
        onDismiss={() => undefined}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }))

    await waitFor(() => expect(window.hermesDesktop?.openPreviewInBrowser).toHaveBeenCalledWith('https://example.com'))
    expect($workbenchTabs.get()).toEqual([])
  })
})
