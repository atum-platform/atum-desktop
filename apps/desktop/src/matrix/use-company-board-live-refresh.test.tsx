import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  COMPANY_BOARD_POLL_INTERVAL_MS,
  COMPANY_BOARD_POLL_MAX_BACKOFF_MS,
  useCompanyBoardLiveRefresh
} from './use-company-board-live-refresh'

interface Value {
  revision: number
}

function Probe({
  busy = false,
  readRevision,
  refetch
}: {
  busy?: boolean
  readRevision(): Promise<number>
  refetch(): Promise<Value>
}) {
  const apply = vi.fn()

  const { freshness, retry } = useCompanyBoardLiveRefresh({
    active: true,
    apply,
    busy,
    currentRevision: 1,
    identity: 'company-a',
    readRevision,
    refetch,
    revisionOf: value => value.revision
  })

  return (
    <>
      <output data-applied={apply.mock.calls.length} data-freshness={freshness} />
      <button onClick={retry} type="button">
        Retry
      </button>
    </>
  )
}

const freshness = () => window.document.querySelector('[data-freshness]')?.getAttribute('data-freshness')

let focused = true
let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  vi.useFakeTimers()
  focused = true
  visibility = 'visible'
  vi.spyOn(window.document, 'hasFocus').mockImplementation(() => focused)
  vi.spyOn(window.document, 'visibilityState', 'get').mockImplementation(() => visibility)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('company board live refresh', () => {
  it('checks every 15 seconds and refetches the visible page only when revision changes', async () => {
    const readRevision = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    const refetch = vi.fn(async () => ({ revision: 2 }))

    render(<Probe readRevision={readRevision} refetch={refetch} />)

    await act(() => vi.advanceTimersByTimeAsync(COMPANY_BOARD_POLL_INTERVAL_MS))
    expect(readRevision).toHaveBeenCalledTimes(1)
    expect(refetch).not.toHaveBeenCalled()

    await act(() => vi.advanceTimersByTimeAsync(COMPANY_BOARD_POLL_INTERVAL_MS))
    expect(readRevision).toHaveBeenCalledTimes(2)
    expect(refetch).toHaveBeenCalledOnce()
  })

  it('does not poll hidden or unfocused boards and checks immediately when they return', async () => {
    const readRevision = vi.fn(async () => 1)
    const refetch = vi.fn(async () => ({ revision: 1 }))

    render(<Probe readRevision={readRevision} refetch={refetch} />)

    focused = false
    window.dispatchEvent(new Event('blur'))
    await act(() => vi.advanceTimersByTimeAsync(COMPANY_BOARD_POLL_INTERVAL_MS * 3))
    expect(readRevision).not.toHaveBeenCalled()

    focused = true
    window.dispatchEvent(new Event('focus'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(readRevision).toHaveBeenCalledOnce()

    visibility = 'hidden'
    window.document.dispatchEvent(new Event('visibilitychange'))
    await act(() => vi.advanceTimersByTimeAsync(COMPANY_BOARD_POLL_INTERVAL_MS * 3))
    expect(readRevision).toHaveBeenCalledOnce()

    visibility = 'visible'
    window.document.dispatchEvent(new Event('visibilitychange'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(readRevision).toHaveBeenCalledTimes(2)

    window.dispatchEvent(new Event('online'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(readRevision).toHaveBeenCalledTimes(3)
  })

  it('defers a changed board during an edit or drag and applies it after the interaction', async () => {
    const readRevision = vi.fn(async () => 2)
    const refetch = vi.fn(async () => ({ revision: 2 }))
    const view = render(<Probe busy readRevision={readRevision} refetch={refetch} />)

    await act(() => vi.advanceTimersByTimeAsync(COMPANY_BOARD_POLL_INTERVAL_MS))
    expect(readRevision).toHaveBeenCalledOnce()
    expect(refetch).not.toHaveBeenCalled()

    view.rerender(<Probe readRevision={readRevision} refetch={refetch} />)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it('says the board may be behind after a failed check, until a check gets through again', async () => {
    const readRevision = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(1)
    const refetch = vi.fn(async () => ({ revision: 1 }))

    render(<Probe readRevision={readRevision} refetch={refetch} />)
    expect(freshness()).toBe('live')

    await act(() => vi.advanceTimersByTimeAsync(COMPANY_BOARD_POLL_INTERVAL_MS))
    expect(freshness()).toBe('stale')

    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(readRevision).toHaveBeenCalledTimes(2)
    expect(freshness()).toBe('live')
  })

  it('retries at once, whatever the backoff', async () => {
    const readRevision = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(1)
    const refetch = vi.fn(async () => ({ revision: 1 }))

    const view = render(<Probe readRevision={readRevision} refetch={refetch} />)
    await act(() => vi.advanceTimersByTimeAsync(COMPANY_BOARD_POLL_INTERVAL_MS))
    expect(freshness()).toBe('stale')

    view.getByRole('button', { name: 'Retry' }).click()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(readRevision).toHaveBeenCalledTimes(2)
    expect(freshness()).toBe('live')
  })

  it.each(['denied', 'missing', 'authentication'])('stops checking for good once the platform answers %s', async code => {
    const readRevision = vi.fn().mockRejectedValue(new Error(code))
    const refetch = vi.fn(async () => ({ revision: 1 }))

    render(<Probe readRevision={readRevision} refetch={refetch} />)
    await act(() => vi.advanceTimersByTimeAsync(COMPANY_BOARD_POLL_INTERVAL_MS))
    expect(freshness()).toBe('lost')

    window.dispatchEvent(new Event('focus'))
    await act(() => vi.advanceTimersByTimeAsync(COMPANY_BOARD_POLL_MAX_BACKOFF_MS * 3))
    expect(readRevision).toHaveBeenCalledOnce()
  })

  it('backs off quietly after errors and caps retries at two minutes', async () => {
    const readRevision = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(1)

    const refetch = vi.fn(async () => ({ revision: 1 }))

    render(<Probe readRevision={readRevision} refetch={refetch} />)

    await act(() => vi.advanceTimersByTimeAsync(COMPANY_BOARD_POLL_INTERVAL_MS))
    expect(readRevision).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(30_000 - 1))
    expect(readRevision).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(readRevision).toHaveBeenCalledTimes(2)
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(readRevision).toHaveBeenCalledTimes(3)
    await act(() => vi.advanceTimersByTimeAsync(COMPANY_BOARD_POLL_MAX_BACKOFF_MS))
    expect(readRevision).toHaveBeenCalledTimes(4)
    await act(() => vi.advanceTimersByTimeAsync(COMPANY_BOARD_POLL_MAX_BACKOFF_MS))
    expect(readRevision).toHaveBeenCalledTimes(5)
    expect(refetch).not.toHaveBeenCalled()
  })
})
