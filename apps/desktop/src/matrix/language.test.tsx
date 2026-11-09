import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider, useI18n } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { matrixLanguageConfig, MatrixLanguageProvider, MatrixLanguageSettings } from './language'

const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()

  if (scrollDescriptor) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', scrollDescriptor)
  } else {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  }

  Reflect.deleteProperty(window, 'atumMatrix')
})

function Probe() {
  const { locale, setLocale, isLoadingConfig, saveError } = useI18n()

  return (
    <>
      <span>{isLoadingConfig ? 'loading' : locale}</span>
      <button onClick={() => void setLocale('ja').catch(() => {})}>Japanese fixture</button>
      {saveError && <span>save failed</span>}
    </>
  )
}

it('uses the existing provider to save language across full remounts, without account or Hermes data', async () => {
  const client = matrixLanguageConfig(localStorage, [])

  const view = render(
    <I18nProvider configClient={client}>
      <Probe />
    </I18nProvider>
  )

  await screen.findByText('vi')
  await act(async () => screen.getByText('Japanese fixture').click())
  await screen.findByText('ja')
  view.unmount()
  render(
    <I18nProvider configClient={matrixLanguageConfig(localStorage)}>
      <Probe />
    </I18nProvider>
  )
  await screen.findByText('ja')
  expect(localStorage.getItem('io.atum.desktop.language')).toBe('ja')
})

it.each([
  [['en-GB', 'vi-VN'], 'en'],
  [['fr-FR', 'vi-VN'], 'vi'],
  [['zh-Hant-TW'], 'zh-hant'],
  [['zh-TW'], 'zh-hant'],
  [['zh-CN'], 'zh'],
  [['ja-JP'], 'ja'],
  [['fr-FR', 'de-DE'], 'vi'],
  [[], 'vi']
])('greets a first launch on %j in %s until someone picks a language', async (languages, expected) => {
  render(
    <I18nProvider configClient={matrixLanguageConfig(localStorage, languages)}>
      <Probe />
    </I18nProvider>
  )

  await screen.findByText(expected)
})

it('keeps the language someone picked over the system’s', async () => {
  localStorage.setItem('io.atum.desktop.language', 'vi')
  render(
    <I18nProvider configClient={matrixLanguageConfig(localStorage, ['en-US'])}>
      <Probe />
    </I18nProvider>
  )

  await screen.findByText('vi')
})

it('rolls back a denied write and makes the failure visible without needing a toast host', async () => {
  const client = matrixLanguageConfig({
    getItem: () => 'en',
    setItem: () => {
      throw new Error('QuotaExceeded')
    }
  })

  render(
    <I18nProvider configClient={client}>
      <Probe />
      <MatrixLanguageSettings />
    </I18nProvider>
  )
  await screen.findByText('en')
  await act(async () => screen.getByText('Japanese fixture').click())
  await screen.findByText('save failed')
  expect(screen.getByRole('status').textContent).toBe('Language update failed')
  expect(screen.getByRole('status').textContent).not.toContain('QuotaExceeded')
  expect(screen.getByText('en')).toBeTruthy()
})

it('defaults safely for unsupported values and rejects writes outside the locale catalog', async () => {
  localStorage.setItem('io.atum.desktop.language', 'invalid')
  const client = matrixLanguageConfig(localStorage)
  render(
    <I18nProvider configClient={client}>
      <Probe />
    </I18nProvider>
  )
  await screen.findByText('vi')
  await expect(client.saveConfig({ display: { language: 'invalid' } })).rejects.toThrow('matrix_language_invalid')
})

it('exposes an unavailable read as recoverable language settings, not a startup failure', async () => {
  const client = matrixLanguageConfig({
    getItem: () => {
      throw new Error('denied')
    },
    setItem() {}
  })

  render(
    <I18nProvider configClient={client}>
      <Probe />
      <MatrixLanguageSettings />
    </I18nProvider>
  )
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Không thể tải ngôn ngữ'))
  expect(screen.getByText('vi')).toBeTruthy()
  expect(screen.getAllByRole('button').length).toBeGreaterThan(1)
})

const identity = { userId: '@alice:test', deviceId: 'ONE' }

const account = (overrides: Partial<MatrixSnapshot> = {}): MatrixSnapshot => ({
  state: 'ready',
  identity,
  rooms: [],
  roomId: null,
  messages: [],
  error: null,
  displayPreferences: {
    appearance: { value: 'system', writable: true },
    textSize: { value: 100, writable: true },
    language: { value: 'en', writable: true }
  },
  ...overrides
})

function VisibleLanguage() {
  const { locale } = useI18n()

  return <span data-testid="current-language">{locale}</span>
}

function languageFixture(initial = account()) {
  const command = vi.fn(async () => null)
  window.atumMatrix = { command } as unknown as MatrixUiBridge

  const tree = (snapshot: MatrixSnapshot) => (
    <StrictMode>
      <MatrixLanguageProvider snapshot={snapshot}>
        <VisibleLanguage />
        <MatrixLanguageSettings snapshot={snapshot} />
      </MatrixLanguageProvider>
    </StrictMode>
  )

  const view = render(tree(initial))

  return { command, rerender: (snapshot: MatrixSnapshot) => view.rerender(tree(snapshot)), unmount: view.unmount }
}

const languageIs = (expected: string) =>
  waitFor(() => expect(screen.getByTestId('current-language').textContent).toBe(expected))

async function chooseJapanese() {
  await languageIs('en')
  fireEvent.click(screen.getByRole('button', { name: 'Switch language' }))
  fireEvent.click(screen.getByRole('option', { name: /日本語/ }))
}

it('projects the current human language and remote changes, never importing or updating the machine-global choice', async () => {
  localStorage.setItem('io.atum.desktop.language', 'zh')
  const f = languageFixture()
  await languageIs('en')
  f.rerender(
    account({ displayPreferences: { ...account().displayPreferences!, language: { value: 'ja', writable: true } } })
  )
  await languageIs('ja')
  expect(f.command).not.toHaveBeenCalled()
  expect(localStorage.getItem('io.atum.desktop.language')).toBe('zh')
  f.unmount()
  languageFixture(account({ identity: { userId: '@bob:test', deviceId: 'TWO' }, displayPreferences: undefined }))
  await languageIs('vi')
})

it('uses the real picker and rendered human/device; acknowledgement alone never changes the confirmed language', async () => {
  localStorage.setItem('io.atum.desktop.language', 'zh')
  const f = languageFixture()
  await chooseJapanese()
  await waitFor(() =>
    expect(f.command).toHaveBeenCalledWith({ kind: 'displayPreference', identity, field: 'language', value: 'ja' })
  )
  await languageIs('en')
  expect((screen.getByRole('button', { name: 'Switch language' }) as HTMLButtonElement).disabled).toBe(true)
  f.rerender(
    account({ displayPreferences: { ...account().displayPreferences!, language: { value: 'ja', writable: true } } })
  )
  await languageIs('ja')
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '言語を切り替え' }) as HTMLButtonElement).disabled).toBe(false)
  )
  expect(localStorage.getItem('io.atum.desktop.language')).toBe('zh')
})

it('keeps a failed save visible and retryable without an optimistic locale rollback or leaking raw errors', async () => {
  const f = languageFixture()
  f.command.mockRejectedValueOnce(new Error('private token details'))
  await chooseJapanese()
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Could not save this setting. Try again.'))
  await languageIs('en')
  expect((screen.getByRole('button', { name: 'Switch language' }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.queryByText('private token details')).toBeNull()
})

it('fences late failure after changing human/device and restores only the signed-out local presentation on sign-out', async () => {
  localStorage.setItem('io.atum.desktop.language', 'ja')
  const f = languageFixture()
  let reject!: (error: Error) => void
  f.command.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      })
  )
  await chooseJapanese()
  await waitFor(() => expect(f.command).toHaveBeenCalledOnce())
  f.rerender(account({ identity: { userId: '@bob:test', deviceId: 'TWO' }, displayPreferences: undefined }))
  await languageIs('vi')
  await act(async () => reject(new Error('late old-account error')))
  expect(screen.queryByRole('status')).toBeNull()
  await languageIs('vi')
  f.rerender(account({ state: 'signed_out', identity: null, displayPreferences: undefined }))
  await languageIs('ja')
  expect(f.command).toHaveBeenCalledOnce()
})

it('keeps offline and future-format choices readable but cannot save them', async () => {
  const f = languageFixture(
    account({
      state: 'offline',
      displayPreferences: { ...account().displayPreferences!, language: { value: 'en', writable: false } }
    })
  )
  await languageIs('en')
  expect((screen.getByRole('button', { name: 'Switch language' }) as HTMLButtonElement).disabled).toBe(true)
  f.rerender(
    account({ displayPreferences: { ...account().displayPreferences!, language: { value: 'en', writable: false } } })
  )
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('This setting needs a newer Atum version.'))
  expect(f.command).not.toHaveBeenCalled()
})
