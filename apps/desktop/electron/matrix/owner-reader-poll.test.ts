import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createOwnerReaderTrustPoller, prepareOwnerReaderControls } from './owner-reader-poll'

const DAY_MS = 24 * 60 * 60 * 1000

/** Lets the in-flight check settle and re-arm without advancing fake time. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

/** Advances fake time step by step so each check settles before its successor fires. */
async function advance(ms: number, step = 1_000) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed))
  }
}

describe('owner-reader trust poll', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('backs off to at least five minutes when the account has no pending reader enrollment', async () => {
    const check = vi.fn(async () => false)
    const poller = createOwnerReaderTrustPoller({ active: () => true, check })

    poller.run()
    await settle()
    expect(check).toHaveBeenCalledTimes(1)

    // The first idle wait is already well past the 10 s handoff cadence.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(check).toHaveBeenCalledTimes(1)

    const gaps: number[] = []
    let last = Date.now()

    check.mockImplementation(async () => {
      gaps.push(Date.now() - last)
      last = Date.now()

      return false
    })

    await advance(DAY_MS, 10_000)

    expect(gaps.length).toBeGreaterThan(3)
    // Each idle gap is at least as long as the previous one and settles at >= 5 minutes.
    gaps.forEach((gap, index) => index > 0 && expect(gap).toBeGreaterThanOrEqual(gaps[index - 1]!))
    expect(gaps.at(-1)).toBeGreaterThanOrEqual(5 * 60_000)
    // A whole idle day is a few hundred requests at most, not ~8,640 checks (17,000 requests).
    expect(check.mock.calls.length).toBeLessThan(300)
    poller.stop()
  })

  it('treats a refused or failed check (cloud off, 503, offline) as idle and backs off', async () => {
    const check = vi.fn(async (): Promise<boolean> => {
      throw new Error('matrix_owner_reader_unavailable')
    })

    const poller = createOwnerReaderTrustPoller({ active: () => true, check })

    poller.run()
    await advance(DAY_MS, 10_000)

    expect(check.mock.calls.length).toBeLessThan(300)
    poller.stop()
  })

  it('checks every 10 s while an enrollment is provisioning or awaiting trust, then backs off when it is gone', async () => {
    let pending = true
    const check = vi.fn(async () => pending)
    const poller = createOwnerReaderTrustPoller({ active: () => true, check })

    poller.run()
    await settle()
    await advance(60_000)
    // t=0 plus one check every 10 s for a minute.
    expect(check).toHaveBeenCalledTimes(7)

    pending = false
    await advance(10_000)
    expect(check).toHaveBeenCalledTimes(8)

    // Idle again: no check for the next 10 s ticks.
    await advance(30_000)
    expect(check).toHaveBeenCalledTimes(8)

    // A new pending enrollment found by a later check returns to the 10 s cadence.
    pending = true
    await advance(10 * 60_000)
    const found = check.mock.calls.length
    await advance(10_000)
    expect(check.mock.calls.length).toBe(found + 1)
    poller.stop()
  })

  it('restarts from the fast cadence after stop and never re-arms while inactive', async () => {
    let active = true
    const check = vi.fn(async () => false)
    const poller = createOwnerReaderTrustPoller({ active: () => active, check })

    poller.run()
    await advance(60 * 60_000, 10_000)
    const idle = check.mock.calls.length

    poller.stop()
    await advance(60 * 60_000, 10_000)
    expect(check.mock.calls.length).toBe(idle)

    active = false
    poller.run()
    await advance(60 * 60_000, 10_000)
    expect(check.mock.calls.length).toBe(idle)

    // A new session that becomes ready checks immediately; the backoff starts over.
    active = true
    check.mockResolvedValue(true)
    poller.run()
    await settle()
    await advance(10_000)
    expect(check.mock.calls.length).toBe(idle + 2)
    poller.stop()
  })

  it('runs one check at a time when the session becomes ready again mid-check', async () => {
    let finish!: (value: boolean) => void
    const check = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const poller = createOwnerReaderTrustPoller({ active: () => true, check })

    poller.run()
    poller.run()
    expect(check).toHaveBeenCalledTimes(1)
    finish(false)
    await settle()
    poller.stop()
  })
})

describe('the reader controls room without the trust hand-off (0.20)', () => {
  function ports(reader: string) {
    const lines: string[] = []
    const prepare = vi.fn(async () => '!controls:test')

    return {
      lines,
      prepare,
      input: { reader: async () => reader, prepare, current: () => true, log: (line: string) => void lines.push(line) }
    }
  }

  it.each(['ready', 'provisioning', 'awaiting_trust', 'needs_attention'])(
    'prepares the controls room for a %s reader',
    async reader => {
      const f = ports(reader)
      expect(await prepareOwnerReaderControls(f.input)).toBe(true)
      expect(f.prepare).toHaveBeenCalledOnce()
      expect(f.lines).toEqual(['[Matrix] owner reader controls outcome=prepared'])
    }
  )

  it('prepares nothing without a reader, or once the account changed', async () => {
    const none = ports('none')
    expect(await prepareOwnerReaderControls(none.input)).toBe(false)
    expect(none.prepare).not.toHaveBeenCalled()
    const stale = ports('ready')
    expect(await prepareOwnerReaderControls({ ...stale.input, current: () => false })).toBe(false)
    expect(stale.prepare).not.toHaveBeenCalled()
  })

  it('reports a failure with a closed code and asks again next time', async () => {
    const f = ports('ready')
    f.prepare.mockRejectedValueOnce(new Error('matrix_sdk_unavailable'))
    expect(await prepareOwnerReaderControls(f.input)).toBe(false)
    f.prepare.mockRejectedValueOnce(new Error('raw @owner:test text'))
    expect(await prepareOwnerReaderControls(f.input)).toBe(false)
    expect(f.lines).toEqual([
      '[Matrix] owner reader controls outcome=failed code=matrix_sdk_unavailable',
      '[Matrix] owner reader controls outcome=failed code=unexpected'
    ])
  })
})
