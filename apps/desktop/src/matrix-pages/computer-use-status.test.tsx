// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixComputerUseClient, MatrixComputerUseSnapshot } from '../../shared/matrix-computer-use'

import { MatrixComputerUseStatus } from './computer-use-status'
import { computerUseStatusCopy } from './computer-use-status-copy'

const readyMac: MatrixComputerUseSnapshot = {
  platform: 'darwin',
  installed: true,
  ready: true,
  accessibility: true,
  screenRecording: true,
  screenRecordingCapturable: true
}

function deferred<T>() {
  let reject!: (error: Error) => void
  let resolve!: (value: T) => void

  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, reject, resolve }
}

function client(status = vi.fn().mockResolvedValue(readyMac)): MatrixComputerUseClient {
  return { status }
}

function content(value: MatrixComputerUseClient, locale: Locale = 'en', agentName = 'Ada') {
  return (
    <I18nProvider initialLocale={locale}>
      <MatrixComputerUseStatus agentName={agentName} client={value} />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('selected local-agent Computer Use status', () => {
  it('loads only passive status, labels the selected Mac scope, and coalesces overlapping refreshes', async () => {
    const request = deferred<MatrixComputerUseSnapshot>()
    const value = client(vi.fn().mockReturnValue(request.promise))
    render(content(value))

    expect(value.status).toHaveBeenCalledOnce()
    expect(screen.getByText(computerUseStatusCopy.en.checking)).toBeTruthy()
    expect(screen.getByText(/This Mac · Ada/)).toBeTruthy()

    fireEvent.focus(window)
    fireEvent.focus(window)
    expect(value.status).toHaveBeenCalledOnce()

    await act(async () => request.resolve(readyMac))
    expect(screen.getByText(computerUseStatusCopy.en.macDriverOnly)).toBeTruthy()
    expect(screen.getByText(computerUseStatusCopy.en.macPermissions)).toBeTruthy()
    expect(screen.getAllByText(computerUseStatusCopy.en.granted)).toHaveLength(2)
    expect(screen.getByText(computerUseStatusCopy.en.captureAvailable)).toBeTruthy()
  })

  it('retires an earlier client read when the client or selected agent changes', async () => {
    const first = deferred<MatrixComputerUseSnapshot>()
    const second = deferred<MatrixComputerUseSnapshot>()
    const firstClient = client(vi.fn().mockReturnValue(first.promise))
    const secondClient = client(vi.fn().mockReturnValue(second.promise))
    const view = render(content(firstClient, 'en', 'Ada'))

    view.rerender(content(secondClient, 'en', 'Bea'))
    await waitFor(() => expect(secondClient.status).toHaveBeenCalledOnce())
    await act(async () => second.resolve({ ...readyMac, installed: false, ready: false }))
    expect(screen.getByText(computerUseStatusCopy.en.notInstalled)).toBeTruthy()
    expect(screen.getByText(/This Mac · Bea/)).toBeTruthy()

    await act(async () => first.reject(new Error('late old-client failure')))
    expect(screen.getByText(computerUseStatusCopy.en.notInstalled)).toBeTruthy()
    expect(screen.queryByText(computerUseStatusCopy.en.ready)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retires a late error after unmount instead of repainting the page', async () => {
    const request = deferred<MatrixComputerUseSnapshot>()
    const value = client(vi.fn().mockReturnValue(request.promise))
    const view = render(content(value))

    view.unmount()
    await act(async () => request.reject(new Error('private native failure')))
    expect(globalThis.document.body.textContent).not.toContain('private native failure')
  })

  it('keeps unknown permission state distinct from a known missing grant', async () => {
    const value = client(
      vi.fn().mockResolvedValue({
        ...readyMac,
        ready: false,
        accessibility: null,
        screenRecording: false,
        screenRecordingCapturable: null
      })
    )

    render(content(value))

    await waitFor(() => expect(screen.getByText(computerUseStatusCopy.en.notReady)).toBeTruthy())
    expect(screen.getAllByText(computerUseStatusCopy.en.unknown)).toHaveLength(2)
    expect(screen.getByText(computerUseStatusCopy.en.notGranted)).toBeTruthy()
    expect(screen.queryByText(/denied/i)).toBeNull()
  })

  it('reports a known capture limitation with reopen-driver guidance without calling it a permission denial', async () => {
    const value = client(vi.fn().mockResolvedValue({ ...readyMac, screenRecordingCapturable: false }))
    render(content(value))

    await waitFor(() => expect(screen.getByText(computerUseStatusCopy.en.captureUnavailable)).toBeTruthy())
    expect(screen.getByText(computerUseStatusCopy.en.reopenDriver)).toBeTruthy()
    expect(screen.getAllByText(computerUseStatusCopy.en.granted)).toHaveLength(2)
    expect(screen.queryByText(computerUseStatusCopy.en.captureAvailable)).toBeNull()
  })

  it('uses driver health only outside macOS and does not render macOS permission rows', async () => {
    const value = client(
      vi.fn().mockResolvedValue({
        platform: 'win32',
        installed: true,
        ready: true,
        accessibility: null,
        screenRecording: null,
        screenRecordingCapturable: null
      })
    )

    render(content(value))

    await waitFor(() => expect(screen.getByText(computerUseStatusCopy.en.nonMac)).toBeTruthy())
    expect(screen.queryByText(computerUseStatusCopy.en.accessibility)).toBeNull()
    expect(screen.queryByText(computerUseStatusCopy.en.macDriverOnly)).toBeNull()
  })

  it('recovers through a manual retry without exposing the native error', async () => {
    const status = vi.fn().mockRejectedValueOnce(new Error('private endpoint')).mockResolvedValueOnce(readyMac)
    const value = client(status)
    render(content(value))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(computerUseStatusCopy.en.statusError))
    expect(globalThis.document.body.textContent).not.toContain('private endpoint')
    fireEvent.click(screen.getByRole('button', { name: computerUseStatusCopy.en.retry }))
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    expect(screen.getByText(computerUseStatusCopy.en.ready)).toBeTruthy()
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as Locale[])('uses complete local copy in %s', async locale => {
    const value = client()
    render(content(value, locale))
    const copy = computerUseStatusCopy[locale]

    await waitFor(() => expect(screen.getByText(copy.ready)).toBeTruthy())
    expect(screen.getByText(copy.title)).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.refresh })).toBeTruthy()
    expect(screen.getByText(copy.macPermissions)).toBeTruthy()
    expect(screen.getByText(copy.captureAvailable)).toBeTruthy()
    expect(screen.getByText(copy.macDriverOnly)).toBeTruthy()
  })
})
