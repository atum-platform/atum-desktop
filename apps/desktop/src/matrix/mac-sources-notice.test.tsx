// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixAgentSourcesBridge, MatrixAgentSourcesView } from '../../shared/matrix-agent-sources'

import { MatrixMacSourcesNotice, resetMatrixMacSourcesNotice } from './mac-sources-notice'

const gates: MatrixAgentSourcesView['gates'] = {
  google: true,
  folders: false,
  messages: true,
  browser: true,
  location: true,
  team_spaces: true
}

function sourcesBridge(notice: MatrixAgentSourcesView['notice']) {
  let current: MatrixAgentSourcesView = { gates, sources: [], macs: [], ...(notice ? { notice } : {}) }
  const listeners = new Set<() => void>()
  // Main records presentation and drops `notice`, then announces the change.
  const presented = vi.fn(async () => {
    current = { gates, sources: [], macs: [] }
    listeners.forEach(listener => listener())
  })

  const bridge: MatrixAgentSourcesBridge = {
    read: vi.fn(async () => current),
    set: vi.fn(),
    presented,
    subscribe: listener => {
      listeners.add(listener)

      return () => void listeners.delete(listener)
    }
  }

  return { bridge, presented }
}

function show(bridge: MatrixAgentSourcesBridge, { locale = 'en', onSettings = vi.fn(), scope = 'me:mac' }: { locale?: Locale; onSettings?: () => void; scope?: string } = {}) {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixMacSourcesNotice bridge={bridge} onSettings={onSettings} scope={scope} />
    </I18nProvider>
  )
}

const band = () => window.document.querySelector<HTMLElement>('[data-matrix-mac-sources-notice]')

beforeEach(() => {
  resetMatrixMacSourcesNotice()
  vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('names only the sources that are on, as a status band, never an alert or a dialog', async () => {
  show(sourcesBridge({ sources: ['messages', 'browser', 'location'] }).bridge)

  const shown = await waitFor(() => {
    expect(band()).toBeTruthy()

    return band()!
  })
  expect(shown.getAttribute('role')).toBe('status')
  expect(shown.textContent).toMatch(/Your cloud assistants can now read Messages, Browser,? and Location from this Mac\./)
  expect(shown.textContent).not.toMatch(/Mac folders/)
  expect(window.document.querySelector('[role="dialog"], [role="alert"]')).toBeNull()
})

it('says it in Vietnamese, naming a Mac folders opt-out Settings overrode', async () => {
  show(sourcesBridge({ sources: ['messages', 'folders'] }).bridge, { locale: 'vi' })

  await waitFor(() =>
    expect(band()?.textContent).toContain('Trợ lý trên đám mây giờ đọc được Tin nhắn và Thư mục trên Mac từ máy Mac này.')
  )
})

it('shows nothing when no Mac source is on', async () => {
  const { bridge } = sourcesBridge(undefined)
  show(bridge)
  await waitFor(() => expect(bridge.read).toHaveBeenCalled())

  expect(band()).toBeNull()
})

it('records presented once after a second in a focused window, and keeps its words until hidden', async () => {
  const { bridge, presented } = sourcesBridge({ sources: ['messages'] })
  show(bridge)
  await waitFor(() => expect(band()).toBeTruthy())
  expect(presented).not.toHaveBeenCalled()

  await waitFor(() => expect(presented).toHaveBeenCalledOnce(), { timeout: 2_500 })
  // Main has dropped `notice`; the band does not vanish mid-sentence.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
  })
  expect(band()?.textContent).toContain('Messages')
  expect(presented).toHaveBeenCalledOnce()
})

it('× hides it before a second without recording anything, and it stays hidden in this window', async () => {
  const { bridge, presented } = sourcesBridge({ sources: ['browser'] })
  show(bridge)
  await waitFor(() => expect(band()).toBeTruthy())

  fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
  expect(band()).toBeNull()
  await new Promise(resolve => setTimeout(resolve, 1_300))
  expect(presented).not.toHaveBeenCalled()

  cleanup()
  show(bridge)
  await waitFor(() => expect(bridge.read).toHaveBeenCalled())
  expect(band()).toBeNull()
})

it('never counts as presented while the window is not focused', async () => {
  vi.spyOn(window.document, 'hasFocus').mockReturnValue(false)
  const { bridge, presented } = sourcesBridge({ sources: ['location'] })
  show(bridge)
  await waitFor(() => expect(band()).toBeTruthy())
  await new Promise(resolve => setTimeout(resolve, 1_300))

  expect(presented).not.toHaveBeenCalled()
})

it('Settings opens Connections and hides the band', async () => {
  const onSettings = vi.fn()
  show(sourcesBridge({ sources: ['messages'] }).bridge, { onSettings })
  await waitFor(() => expect(band()).toBeTruthy())

  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  expect(onSettings).toHaveBeenCalledOnce()
  expect(band()).toBeNull()
})

it('a notice shown for one account never answers for another', async () => {
  const first = sourcesBridge({ sources: ['messages'] })
  show(first.bridge, { scope: 'a:mac' })
  await waitFor(() => expect(band()).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
  cleanup()

  show(sourcesBridge({ sources: ['browser'] }).bridge, { scope: 'b:mac' })
  await waitFor(() => expect(band()?.textContent).toContain('Browser'))
})
