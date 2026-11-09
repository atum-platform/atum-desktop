import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi as mock } from 'vitest'

import { I18nProvider } from '@/i18n'
import { vi } from '@/i18n/vi'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import { matrixAgentAccessBandCopy } from '../../shared/matrix-agent-access-band-copy'
import { matrixAgentStatusCopy } from '../../shared/matrix-agent-status-copy'
import { matrixAliasCopy } from '../../shared/matrix-alias-copy'
import type { MatrixAliasBridge } from '../../shared/matrix-aliases'

import { NewAssistantButton, NewAssistantDialog } from './agent-roster'
import { matrixAppCopy } from './app-copy'
import { mobileChatCopy, mobilePhoneCopy, mobileScreensCopy } from './mobile-copy'
import { petCopy } from './pet-copy'
import { scenarioSnapshot } from './playground/fixtures'
import { rosterCreateCopy } from './roster-create-copy'
import { MatrixSettingsSheet } from './settings-sheet'
import { matrixStoreCopy } from './store/store-copy'
import { matrixWalletCopy } from './wallet-copy'

/**
 * Vietnamese is the first language, so the screens are checked in Vietnamese, rendered, not
 * by reading their source. The deny-list is the one in  words
 * that once put two names on one thing, English in a Vietnamese screen, or a typo.
 */
const DENIED: ReadonlyArray<{ term: RegExp; use: string }> = [
  { term: /Khám phá/i, use: 'Cửa hàng' },
  { term: /nhân viên/i, use: 'trợ lý' },
  { term: /đào tạo/i, use: 'Thêm (kỹ năng)' },
  { term: /tín dụng/i, use: 'Proton' },
  { term: /\bProtons\b/, use: 'Proton' },
  { term: /\bApps\b/, use: 'Ứng dụng' },
  { term: /~\/Atum/, use: 'say what the screen is for, not a folder path' },
  { term: /name_bot/, use: 'a handle made from the assistant’s name' },
  { term: /trả lại/i, use: 'thử lại' }
]

afterEach(() => {
  cleanup()
  mock.restoreAllMocks()
  Reflect.deleteProperty(window, 'atumMatrix')
})

function denied(text: string): string[] {
  return DENIED.filter(({ term }) => term.test(text)).map(({ term, use }) => `${term} → ${use}`)
}

/** Every string a copy object can produce: its values, and what its functions say for samples. */
function strings(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') {
    return [[path, value]]
  }

  if (typeof value === 'function') {
    try {
      const said = (value as (...args: unknown[]) => unknown)('Lan', 2, 'Mai')

      return typeof said === 'string' ? [[`${path}()`, said]] : []
    } catch {
      return []
    }
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, each]) => strings(each, path ? `${path}.${key}` : key))
  }

  return []
}

function renderCreateSheet() {
  const aliases: MatrixAliasBridge = { pending: mock.fn(), request: mock.fn() }
  const profiles = { open: mock.fn(), read: mock.fn(), change: mock.fn(), close: mock.fn() }
  window.atumMatrix = {
    createAgent: mock.fn(),
    importAgent: mock.fn(),
    command: mock.fn(),
    aliases,
    profiles
  } as unknown as MatrixUiBridge

  function Roster() {
    const [open, setOpen] = useState(false)

    return (
      <>
        <NewAssistantButton onClick={() => setOpen(true)} />
        <NewAssistantDialog onOpenChange={setOpen} open={open} ready />
      </>
    )
  }

  render(
    <I18nProvider configClient={null} initialLocale="vi">
      <Roster />
    </I18nProvider>
  )

  fireEvent.click(screen.getByRole('button', { name: vi.matrixShell.newAgent }))
  const dialog = screen.getByRole('dialog', { name: vi.matrixShell.newAgent })
  // Everything the sheet can show at once, the folded Advanced part included.
  fireEvent.click(within(dialog).getByRole('button', { name: rosterCreateCopy('vi').advanced }))

  return dialog
}

describe('the "Trợ lý mới" sheet in Vietnamese', () => {
  it('never gives two fields the same label', () => {
    const dialog = renderCreateSheet()
    const labels = [...dialog.querySelectorAll('label')].map(each => each.textContent?.trim() ?? '')

    const named = within(dialog)
      .queryAllByRole('textbox')
      .map(each => each.getAttribute('aria-label') ?? '')
      .filter(Boolean)

    const all = [...labels, ...named].filter(Boolean)

    expect(all.length).toBeGreaterThan(1)
    expect(all.filter((label, index) => all.indexOf(label) !== index)).toEqual([])
  })

  it('tells the two names apart: "Tên hiển thị" and "Tên bot", each with one line on what it is for', () => {
    const dialog = renderCreateSheet()
    const display = within(dialog).getByRole('textbox', { name: 'Tên hiển thị' })
    const handle = within(dialog).getByRole('textbox', { name: 'Tên bot' })

    const said = (field: HTMLElement) =>
      (field.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map(id => dialog.ownerDocument.getElementById(id)?.textContent ?? '')
        .join(' ')

    expect(said(display)).toContain('Tên mọi người thấy trong cuộc trò chuyện.')
    expect(said(handle)).toContain('Người khác gõ @tên này để tìm và nhắc đến trợ lý.')
    // A bare "Tên" was the old trouble: two fields with one label.
    expect(within(dialog).queryByRole('textbox', { name: 'Tên' })).toBeNull()
    expect(denied(dialog.textContent ?? '')).toEqual([])
  })
})

describe('the Vietnamese words', () => {
  it('keep to the glossary across the copy that names the Store, assistants and Proton', () => {
    const sources: Record<string, unknown> = {
      i18n: vi,
      rosterCreate: rosterCreateCopy('vi'),
      store: matrixStoreCopy('vi'),
      wallet: matrixWalletCopy('vi'),
      apps: matrixAppCopy.vi,
      pets: petCopy.vi,
      handles: matrixAliasCopy('vi'),
      status: matrixAgentStatusCopy.vi,
      accessBand: matrixAgentAccessBandCopy.vi,
      phone: mobilePhoneCopy.vi,
      phoneChat: mobileChatCopy.vi,
      phoneScreens: mobileScreensCopy.vi
    }

    const found = Object.entries(sources).flatMap(([source, copy]) =>
      strings(copy, source).flatMap(([path, text]) => denied(text).map(rule => `${path}: ${rule}`))
    )

    expect(found).toEqual([])
  })

  it('shows Settings in Vietnamese, with the apps section as "Ứng dụng" and no repeated nav label', () => {
    Object.defineProperty(window, 'atumMatrix', { configurable: true, value: { openLink: mock.fn() } })

    const snapshot = {
      ...scenarioSnapshot('chat'),
      identity: null,
      apps: { state: 'ready', apps: [{ app_id: 'moon', bot: { user_id: '@app-moon:test' } }], connections: {} }
    } as unknown as MatrixSnapshot

    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <MatrixSettingsSheet fail={() => {}} onClose={() => {}} onPaneChange={() => {}} open pane="connections" snapshot={snapshot} />
      </I18nProvider>
    )

    const nav = screen.getByRole('navigation')

    // The old Apps destination is now a section inside the account Connections page. None of the
    // stable nav rows may repeat another label.
    const labels = [...nav.querySelectorAll('.atum-settings-nav-row')].map(
      each => each.textContent?.trim() ?? ''
    )

    expect(within(nav).getByRole('button', { name: 'Kết nối' })).toBeTruthy()
    expect(within(nav).queryByRole('button', { name: 'Ứng dụng' })).toBeNull()
    expect(within(screen.getByRole('dialog')).getByText('Ứng dụng')).toBeTruthy()
    expect(labels.filter((label, index) => labels.indexOf(label) !== index)).toEqual([])
    expect(denied(nav.textContent ?? '')).toEqual([])
  })
})
