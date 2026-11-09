import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type {
  MatrixBrowserImportBridge,
  MatrixBrowserImportOutcome,
  MatrixBrowserImportReason,
  MatrixBrowserImportStatus
} from '../../shared/matrix-browser-import'
import { matrixBrowserImportCopy } from '../../shared/matrix-browser-import-copy'

import { MatrixBrowserImportSettings } from './browser-import-settings'
import { scenarioSnapshot } from './playground/fixtures'
import { matrixPrimaryAgentName } from './roster-model'

afterEach(() => {
  cleanup()
})

const snapshot = scenarioSnapshot('chat')
const agentName = matrixPrimaryAgentName(snapshot, 'Atum')
const primary = snapshot.agents!.find(agent => agent.isDefault)!

const last = { siteCount: 7, skippedSiteCount: 4, agentPrincipal: primary.principal, at: 1_800_000_000_000 }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void

  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

function setup(
  options: {
    status?: MatrixBrowserImportStatus
    run?: () => Promise<MatrixBrowserImportOutcome>
    locale?: Locale
    bridge?: false
  } = {}
) {
  let status: MatrixBrowserImportStatus = options.status ?? { state: 'ready' }
  const statusCall = vi.fn(async () => status)
  const run = vi.fn(options.run ?? (async () => ({ outcome: 'declined' }) as MatrixBrowserImportOutcome))
  const bridge: MatrixBrowserImportBridge = { status: statusCall, run }

  const view = render(
    <StrictMode>
      <I18nProvider configClient={null} initialLocale={options.locale ?? 'en'}>
        <MatrixBrowserImportSettings bridge={options.bridge === false ? undefined : bridge} snapshot={snapshot} />
      </I18nProvider>
    </StrictMode>
  )

  return { statusCall, run, view, setStatus: (next: MatrixBrowserImportStatus) => (status = next) }
}

const english = matrixBrowserImportCopy.en

const button = () =>
  screen.getByRole('button', { name: new RegExp(`${english.button}|${english.working}`, 'u') }) as HTMLButtonElement

describe('Settings › Browser logins', () => {
  it.each(Object.keys(matrixBrowserImportCopy) as Locale[])(
    'does not turn silent Mac enrollment into an extra confirmation before the first import (%s)',
    async locale => {
      const first = setup({ status: { state: 'ready', firstImport: true }, locale })
      const words = matrixBrowserImportCopy[locale]

      expect(await screen.findByText(words.rowHelp(agentName))).toBeTruthy()
      expect(first.run).not.toHaveBeenCalled()
      cleanup()

      // A prior import changes only the result row; enrollment is never presented as a step.
      setup({ status: { state: 'ready', last }, locale })
      await screen.findByText(words.imported(agentName, last.siteCount))
    }
  )

  it('shows nothing without the native bridge or when there is nothing to offer', async () => {
    const none = setup({ bridge: false })
    expect(none.view.container.querySelector('[data-matrix-browser-import]')).toBeNull()
    cleanup()

    const unavailable = setup({ status: { state: 'unavailable' } })
    await waitFor(() => expect(unavailable.statusCall).toHaveBeenCalled())
    expect(unavailable.view.container.querySelector('[data-matrix-browser-import]')).toBeNull()
  })

  it('offers one account import action without naming an assistant', async () => {
    setup()

    await waitFor(() => expect(screen.getByText(english.rowTitle)).toBeTruthy())
    expect(screen.getByText(english.title)).toBeTruthy()
    expect(screen.getByText(english.rowHelp(agentName))).toBeTruthy()
    expect(english.rowHelp('Raymond')).not.toContain('Raymond')
    expect(screen.getAllByRole('button').filter(each => each.textContent === english.button)).toHaveLength(1)
    // No browser, profile, site or assistant picker.
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('shows the last import from before, with what was left out', async () => {
    setup({ status: { state: 'ready', last } })

    await waitFor(() => expect(screen.getByText(english.imported(agentName, 7))).toBeTruthy())
    expect(screen.getByText(english.leftOut)).toBeTruthy()
  })

  it('does not say anything was left out when nothing was', async () => {
    setup({ status: { state: 'ready', last: { ...last, skippedSiteCount: 0 } } })

    await waitFor(() => expect(screen.getByText(english.imported(agentName, 7))).toBeTruthy())
    expect(screen.queryByText(english.leftOut)).toBeNull()
  })

  it('starts one import with no argument, holds the button while it waits, and reports the result', async () => {
    const pending = deferred<MatrixBrowserImportOutcome>()
    const f = setup({ run: () => pending.promise })
    await waitFor(() => expect(button().disabled).toBe(false))

    fireEvent.click(button())
    fireEvent.click(button())
    fireEvent.click(button())

    await waitFor(() => expect(button().textContent).toBe(english.working))
    expect(button().disabled).toBe(true)
    expect(f.run).toHaveBeenCalledExactlyOnceWith()

    f.setStatus({ state: 'ready', last })
    await act(async () => pending.resolve({ outcome: 'imported', ...last }))

    await waitFor(() => expect(screen.getByText(english.imported(agentName, 7))).toBeTruthy())
    expect(button().textContent).toBe(english.button)
    expect(button().disabled).toBe(false)
    // The status is read again so the saved record and the screen agree.
    expect(f.statusCall.mock.calls.length).toBeGreaterThan(1)
  })

  it('says nothing was imported when the person declines, in a calm band, and hides the older success line', async () => {
    setup({ status: { state: 'ready', last }, run: async () => ({ outcome: 'declined' }) })
    await waitFor(() => expect(screen.getByText(english.imported(agentName, 7))).toBeTruthy())

    fireEvent.click(button())

    await waitFor(() => expect(screen.getByText(english.declined)).toBeTruthy())
    expect(screen.getByText(english.declined).closest('[data-tone]')?.getAttribute('data-tone')).toBe('notice')
    expect(screen.queryByText(english.imported(agentName, 7))).toBeNull()
  })

  it.each(Object.keys(english.reasons) as MatrixBrowserImportReason[])('explains %s in words', async reason => {
    setup({ run: async () => ({ outcome: 'unavailable', reason }) })
    await waitFor(() => expect(button().disabled).toBe(false))

    fireEvent.click(button())

    await waitFor(() => expect(screen.getByText(english.reasons[reason])).toBeTruthy())

    const calm = ['busy', 'chrome_not_found', 'no_computer', 'nothing_to_import', 'signed_out', 'unsupported']

    expect(screen.getByText(english.reasons[reason]).closest('[data-tone]')?.getAttribute('data-tone')).toBe(
      calm.includes(reason) ? 'notice' : 'failure'
    )
  })

  it('survives a bridge that throws, and lets the person try again', async () => {
    const f = setup({
      run: async () => {
        throw new Error('ipc broke: /home/example/Library/secret')
      }
    })

    await waitFor(() => expect(button().disabled).toBe(false))
    fireEvent.click(button())

    await waitFor(() => expect(screen.getByText(english.reasons.failed)).toBeTruthy())
    // Only the closed words are shown, never the error's own message.
    expect(window.document.body.textContent).not.toContain('/home/example')
    expect(button().disabled).toBe(false)

    fireEvent.click(button())
    await waitFor(() => expect(f.run).toHaveBeenCalledTimes(2))
  })

  it('shows an import already under way (started before Settings opened) and frees the button when it ends', async () => {
    const f = setup({ status: { state: 'running' } })

    await waitFor(() => expect(button().textContent).toBe(english.working))
    expect(button().disabled).toBe(true)

    f.setStatus({ state: 'ready', last })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => expect(button().textContent).toBe(english.button))
    expect(screen.getByText(english.imported(agentName, 7))).toBeTruthy()
  })

  it('speaks Vietnamese by default and the other desktop languages when asked', async () => {
    const vi_ = matrixBrowserImportCopy.vi

    setup({ locale: 'vi' })
    await waitFor(() => expect(screen.getByRole('button', { name: vi_.button })).toBeTruthy())
    expect(screen.getByText(vi_.rowHelp(agentName))).toBeTruthy()
    cleanup()

    setup({ locale: 'ja' })
    await waitFor(() => expect(screen.getByRole('button', { name: matrixBrowserImportCopy.ja.button })).toBeTruthy())
  })

  it('does not set state after it is gone while an import is still waiting', async () => {
    const pending = deferred<MatrixBrowserImportOutcome>()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = setup({ run: () => pending.promise })
    await waitFor(() => expect(button().disabled).toBe(false))

    fireEvent.click(button())
    f.view.unmount()
    await act(async () => pending.resolve({ outcome: 'imported', ...last }))

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})
