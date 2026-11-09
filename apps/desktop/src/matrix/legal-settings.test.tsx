import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import { ATUM_MAILBOXES } from '../../shared/atum-company'
import type { MatrixSnapshot } from '../../shared/matrix'

import { ATUM_LINKS } from './atum-links'
import { matrixLegalCopy } from './legal-copy'
import { MatrixDeleteAccount, MatrixLegalSettings } from './legal-settings'
import { scenarioSnapshot } from './playground/fixtures'
import { type MatrixSettingsPane, MatrixSettingsSheet } from './settings-sheet'

const LOCALES = ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:example.test', deviceId: 'DEVICE' },
  rooms: [],
  roomId: null,
  messages: [],
  error: null
}

function bridge(
  openLink = vi.fn(async (_url: string) => {}),
  openSourceNotices = vi.fn(async (_title: string) => {})
) {
  Object.defineProperty(window, 'atumMatrix', { configurable: true, value: { openLink, openSourceNotices } })

  return openLink
}

function view(node: React.ReactNode, locale: Locale = 'en') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      {node}
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('the legal words', () => {
  it.each(LOCALES.filter(locale => locale !== 'en'))('are written in %s, not left in English', locale => {
    const english = matrixLegalCopy('en')
    const words = matrixLegalCopy(locale)

    for (const key of Object.keys(english) as (keyof typeof english)[]) {
      expect(words[key], key).not.toBe(english[key])
    }
  })
})

describe('Settings › General › Legal', () => {
  it.each(LOCALES)(
    'opens the Terms of Service, the Privacy Policy and the Atum Drive source in the browser in %s',
    locale => {
      const openLink = bridge()
      const legal = matrixLegalCopy(locale)

      view(<MatrixLegalSettings />, locale)

      expect(screen.getByRole('heading', { name: legal.legal })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: legal.terms }))
      fireEvent.click(screen.getByRole('button', { name: legal.privacy }))
      fireEvent.click(screen.getByRole('button', { name: legal.driveEngineSource }))
      expect(openLink.mock.calls).toEqual([[ATUM_LINKS.terms], [ATUM_LINKS.privacy], [ATUM_LINKS.driveEngineSource]])
    }
  )

  it.each(LOCALES)('opens the open-source licences in a window of the app, titled in %s', locale => {
    const openSourceNotices = vi.fn(async (_title: string) => {})
    const openLink = bridge(undefined, openSourceNotices)
    const legal = matrixLegalCopy(locale)

    view(<MatrixLegalSettings />, locale)
    fireEvent.click(screen.getByRole('button', { name: legal.openSourceLicences }))

    expect(openSourceNotices.mock.calls).toEqual([[legal.openSourceLicences]])
    expect(openLink).not.toHaveBeenCalled()
  })

  it('keeps Settings usable when the notice cannot open', async () => {
    const openSourceNotices = vi.fn(async (_title: string) => Promise.reject(new Error('matrix_notices_unavailable')))
    bridge(undefined, openSourceNotices)

    view(<MatrixLegalSettings />)
    fireEvent.click(screen.getByRole('button', { name: matrixLegalCopy('en').openSourceLicences }))

    await waitFor(() => expect(openSourceNotices).toHaveBeenCalledOnce())
    expect(screen.getByRole('heading', { name: matrixLegalCopy('en').legal })).toBeTruthy()
  })

  it('links the Atum Drive source to a public https page', () => {
    const source = new URL(ATUM_LINKS.driveEngineSource)

    expect(source.protocol).toBe('https:')
    expect(source.username + source.password + source.search + source.hash).toBe('')
  })
})

describe('Settings › Account › Delete my account', () => {
  it.each(LOCALES)(
    'confirms in a dialog before starting the deletion request in %s',
    locale => {
      const openLink = bridge()
      const legal = matrixLegalCopy(locale)

      view(<MatrixDeleteAccount snapshot={snapshot} />, locale)

      expect(screen.queryByText(legal.deleteAccountHelp)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: legal.deleteAccountAction }))
      expect(screen.getByRole('dialog', { name: legal.deleteAccountDialogTitle })).toBeTruthy()
      expect(screen.getByText(legal.deleteAccountDialogBody)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: legal.deleteAccountConfirm }))

      expect(openLink).toHaveBeenCalledOnce()
      const email = new URL(openLink.mock.calls[0]![0])
      expect(email.protocol).toBe('mailto:')
      expect(email.pathname).toBe(ATUM_MAILBOXES.privacy)
      expect([...email.searchParams.keys()]).toEqual(['subject', 'body'])
      expect(email.searchParams.get('subject')).toBe(legal.deleteAccountSubject)
      expect(email.searchParams.get('body')).toContain(legal.deleteAccountBody)
      expect(email.searchParams.get('body')).toContain('@owner:example.test')
    }
  )

  it('says where to write when no mail app opens, and tries again cleanly', async () => {
    const openLink = bridge(vi.fn(async () => Promise.reject(new Error('no mail app'))))
    const legal = matrixLegalCopy('vi')

    view(<MatrixDeleteAccount snapshot={snapshot} />, 'vi')
    fireEvent.click(screen.getByRole('button', { name: legal.deleteAccountAction }))
    fireEvent.click(screen.getByRole('button', { name: legal.deleteAccountConfirm }))

    const notice = await screen.findByRole('status')
    expect(notice.textContent).toBe(legal.deleteAccountFailed)
    expect(notice.textContent).toContain(ATUM_MAILBOXES.privacy)

    openLink.mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByRole('button', { name: legal.deleteAccountConfirm }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('still writes the request without an Atum ID while the account is unknown', () => {
    const openLink = bridge()
    const legal = matrixLegalCopy('en')

    view(<MatrixDeleteAccount snapshot={{ ...snapshot, identity: null }} />)
    fireEvent.click(screen.getByRole('button', { name: legal.deleteAccountAction }))
    fireEvent.click(screen.getByRole('button', { name: legal.deleteAccountConfirm }))

    expect(new URL(openLink.mock.calls[0]![0]).searchParams.get('body')).toBe(legal.deleteAccountBody)
  })
})

describe('the Settings sheet', () => {
  function sheet(pane: MatrixSettingsPane) {
    bridge()
    view(
      <MatrixSettingsSheet
        fail={() => {}}
        onClose={() => {}}
        onPaneChange={() => {}}
        open
        pane={pane}
        snapshot={{ ...scenarioSnapshot('chat'), identity: null }}
      />
    )
  }

  it('ends the Account pane with Delete my account, after Sign out', () => {
    sheet('account')
    const signOut = window.document.querySelector('[data-matrix-settings-sign-out]')!
    const remove = window.document.querySelector('[data-matrix-delete-account]')!

    expect(remove).toBeTruthy()
    expect(signOut.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-legal-settings]')).toBeNull()
  })

  it('ends the Help pane with Legal', () => {
    sheet('help')

    expect(window.document.querySelector('[data-matrix-legal-settings]')).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-delete-account]')).toBeNull()
  })
})
