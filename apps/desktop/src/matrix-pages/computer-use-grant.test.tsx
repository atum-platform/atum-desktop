// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixComputerUseGrantClient, MatrixComputerUseGrantStart } from '../../shared/matrix-computer-use-grant'
import {
  MATRIX_COMPUTER_USE_GRANT_POLL_LIMIT,
  MATRIX_COMPUTER_USE_GRANT_POLL_MS
} from '../../shared/matrix-computer-use-grant'

import { MatrixComputerUseGrant } from './computer-use-grant'
import { computerUseGrantCopy } from './computer-use-grant-copy'

const id = '00000000-0000-4000-8000-af16785cab34'

function client(
  start: MatrixComputerUseGrantStart = { status: 'started', operationId: id }
): MatrixComputerUseGrantClient {
  return { start: vi.fn().mockResolvedValue(start), operationStatus: vi.fn().mockResolvedValue({ status: 'running' }) }
}

function content(grantClient: MatrixComputerUseGrantClient, onTerminal = vi.fn(), locale: Locale = 'en') {
  return (
    <I18nProvider initialLocale={locale}>
      <MatrixComputerUseGrant grantClient={grantClient} onTerminal={onTerminal} />
    </I18nProvider>
  )
}

async function request() {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: computerUseGrantCopy.en.request })))
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('explicit CuaDriver permission request', () => {
  it('never requests or polls on mount/focus and requires one explicit click', async () => {
    const f = client()
    render(content(f))
    fireEvent.focus(window)
    expect(f.start).not.toHaveBeenCalled()
    expect(f.operationStatus).not.toHaveBeenCalled()
    await request()
    expect(f.start).toHaveBeenCalledOnce()
    expect(screen.getByText(computerUseGrantCopy.en.waiting)).toBeTruthy()
    expect(screen.getByRole('button', { name: computerUseGrantCopy.en.request })).toHaveProperty('disabled', true)
    expect(screen.getByText(computerUseGrantCopy.en.continued)).toBeTruthy()
    expect(f.operationStatus).not.toHaveBeenCalled()
  })
  it.each(['cancelled', 'unsupported', 'not-installed', 'busy'] as const)(
    'renders %s without claiming changes or polling',
    async state => {
      const f = client(state === 'cancelled' ? { status: state } : { status: 'blocked', reason: state })
      const terminal = vi.fn()
      render(content(f, terminal))
      await request()
      expect(screen.getByText(computerUseGrantCopy.en[state])).toBeTruthy()
      expect(terminal).not.toHaveBeenCalled()
      expect(f.operationStatus).not.toHaveBeenCalled()
    }
  )
  it.each(['completed', 'failed', 'unknown'] as const)(
    'reconciles %s once without treating it as a grant',
    async status => {
      vi.useFakeTimers()
      const f = client()
      const terminal = vi.fn()
      vi.mocked(f.operationStatus).mockResolvedValue({ status })
      render(content(f, terminal))
      await request()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MATRIX_COMPUTER_USE_GRANT_POLL_MS)
      })
      expect(f.operationStatus).toHaveBeenCalledExactlyOnceWith(id)
      expect(terminal).toHaveBeenCalledOnce()
      expect(screen.getByText(computerUseGrantCopy.en[status])).toBeTruthy()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000)
      })
      expect(f.operationStatus).toHaveBeenCalledOnce()
      expect(globalThis.document.body.textContent).not.toMatch(/permissions granted|permission denied/i)
    }
  )
  it('ends automatic polling at the finite budget and manually checks the same issued ID', async () => {
    vi.useFakeTimers()
    const f = client()
    render(content(f))
    await request()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MATRIX_COMPUTER_USE_GRANT_POLL_LIMIT * MATRIX_COMPUTER_USE_GRANT_POLL_MS)
    })
    expect(f.operationStatus).toHaveBeenCalledTimes(MATRIX_COMPUTER_USE_GRANT_POLL_LIMIT)
    expect(screen.getByText(computerUseGrantCopy.en.paused)).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(f.operationStatus).toHaveBeenCalledTimes(MATRIX_COMPUTER_USE_GRANT_POLL_LIMIT)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: computerUseGrantCopy.en.check })))
    expect(f.operationStatus).toHaveBeenLastCalledWith(id)
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.operationStatus).toHaveBeenCalledTimes(MATRIX_COMPUTER_USE_GRANT_POLL_LIMIT + 1)
  })
  it('coalesces pending status and discards its result after client replacement', async () => {
    vi.useFakeTimers()
    const f = client()
    let resolve!: (value: { status: 'completed' }) => void
    vi.mocked(f.operationStatus).mockImplementation(
      () =>
        new Promise(next => {
          resolve = next
        })
    )
    const terminal = vi.fn()
    const view = render(content(f, terminal))
    await request()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(f.operationStatus).toHaveBeenCalledOnce()
    const next = client()
    view.rerender(content(next, terminal))
    await act(async () => resolve({ status: 'completed' }))
    expect(terminal).not.toHaveBeenCalled()
    expect(next.start).not.toHaveBeenCalled()
    expect(next.operationStatus).not.toHaveBeenCalled()
    expect(screen.queryByText(computerUseGrantCopy.en.completed)).toBeNull()
  })
  it('stops polling on unmount without calling a cancellation API', async () => {
    vi.useFakeTimers()
    const f = client()
    const view = render(content(f))
    await request()
    view.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.operationStatus).not.toHaveBeenCalled()
  })
  it('discards a start reply after unmount and never retries a lost POST', async () => {
    const f = client()
    let resolve!: (value: MatrixComputerUseGrantStart) => void
    vi.mocked(f.start).mockImplementation(
      () =>
        new Promise(next => {
          resolve = next
        })
    )
    const terminal = vi.fn()
    const view = render(content(f, terminal))
    await request()
    view.unmount()
    await act(async () => resolve({ status: 'started', operationId: id }))
    expect(f.operationStatus).not.toHaveBeenCalled()
    expect(terminal).not.toHaveBeenCalled()

    const lost = client()
    vi.mocked(lost.start).mockRejectedValue(new Error('private token log'))
    render(content(lost, terminal))
    await request()
    expect(lost.start).toHaveBeenCalledOnce()
    expect(terminal).toHaveBeenCalledOnce()
    expect(screen.getByText(computerUseGrantCopy.en.unknown)).toBeTruthy()
    expect(globalThis.document.body.textContent).not.toContain('private token log')
  })
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as Locale[])('renders explicit localized intent in %s', async locale => {
    const f = client({ status: 'unknown' })
    render(content(f, vi.fn(), locale))
    const c = computerUseGrantCopy[locale]
    expect(screen.getByText(c.title)).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: c.request })))
    expect(screen.getByText(c.unknown)).toBeTruthy()
    expect(f.start).toHaveBeenCalledOnce()
  })
})
