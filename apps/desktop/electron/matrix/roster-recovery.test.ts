import { expect, it, vi } from 'vitest'

import { MatrixRosterRecovery, refreshMatrixRosterOnWake } from './roster-recovery'

const scope = { accountKey: 'owner', generation: 1 }

it('does not fetch without an authenticated scope and retains the pending read', async () => {
  const recovery = new MatrixRosterRecovery<string[]>()
  const fetch = vi.fn(async () => ['current'])
  expect(await recovery.sync({ scope: () => null, fetch })).toEqual({ state: 'cancelled' })
  expect(fetch).not.toHaveBeenCalled()
  expect((await recovery.sync({ scope: () => scope, fetch })).state).toBe('synced')
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('retries a transport failure, then stops fetching after an authoritative roster succeeds', async () => {
  const recovery = new MatrixRosterRecovery<string[]>()

  const fetch = vi.fn(async () => {
    if (fetch.mock.calls.length === 1) {
      throw new Error('transient')
    }

    return ['default', 'imported']
  })

  expect((await recovery.sync({ scope: () => scope, fetch })).state).toBe('failed')
  expect(await recovery.sync({ scope: () => scope, fetch })).toMatchObject({
    state: 'synced',
    roster: ['default', 'imported']
  })
  expect((await recovery.sync({ scope: () => scope, fetch })).state).toBe('idle')
  expect(fetch).toHaveBeenCalledTimes(2)

  recovery.request()
  expect((await recovery.sync({ scope: () => scope, fetch })).state).toBe('synced')
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('deduplicates reads and never converts a transport failure into a roster', async () => {
  const recovery = new MatrixRosterRecovery<string[]>()
  let reject!: (error: Error) => void

  const fetch = vi.fn(
    () =>
      new Promise<string[]>((_, nextReject) => {
        reject = nextReject
      })
  )

  const first = recovery.sync({ scope: () => scope, fetch })
  const second = recovery.sync({ scope: () => scope, fetch })
  expect(first).toBe(second)
  reject(new Error('transport'))
  expect(await first).toEqual({ state: 'failed' })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('fences an already successful roster when the account scope changes', async () => {
  const recovery = new MatrixRosterRecovery<string[]>()
  let current = scope
  const result = await recovery.sync({ scope: () => current, fetch: async () => ['current'] })

  expect(result.state).toBe('synced')

  if (result.state !== 'synced') {
    throw new Error('expected roster')
  }

  current = { accountKey: 'owner', generation: 2 }
  expect(recovery.isCurrent(result, current)).toBe(false)
})

it('cancels and fences a stale response when the account changes', async () => {
  const recovery = new MatrixRosterRecovery<string[]>()
  let current = scope
  let resolve!: (roster: string[]) => void
  let signal!: AbortSignal

  const fetch = vi.fn(nextSignal =>
    fetch.mock.calls.length === 1
      ? new Promise<string[]>(nextResolve => {
          signal = nextSignal
          resolve = nextResolve
        })
      : Promise.resolve(['new-account'])
  )

  const pending = recovery.sync({ scope: () => current, fetch })
  current = { accountKey: 'other', generation: 2 }
  recovery.invalidate()
  expect(signal.aborted).toBe(true)
  resolve(['must-not-apply'])

  expect(await pending).toEqual({ state: 'cancelled' })
  expect((await recovery.sync({ scope: () => current, fetch })).state).toBe('synced')
})

it('keeps an explicit refresh pending when it arrives during a roster read', async () => {
  const recovery = new MatrixRosterRecovery<string[]>()
  let resolve!: (roster: string[]) => void

  const fetch = vi.fn(() =>
    fetch.mock.calls.length === 1
      ? new Promise<string[]>(nextResolve => {
          resolve = nextResolve
        })
      : Promise.resolve(['refreshed'])
  )

  const first = recovery.sync({ scope: () => scope, fetch })
  recovery.request()
  expect(fetch).toHaveBeenCalledTimes(1)
  resolve(['initial'])
  expect((await first).state).toBe('synced')
  expect((await recovery.sync({ scope: () => scope, fetch })).state).toBe('synced')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('asks for one fresh read on wake and lets the existing watch path carry it', () => {
  const handlers = new Map<string, () => void>()

  const source = {
    on: (event: 'resume' | 'unlock-screen', listener: () => void) => {
      handlers.set(event, listener)
    }
  }

  const roster = { request: vi.fn() }
  const sync = vi.fn()

  refreshMatrixRosterOnWake(source, roster, sync)

  handlers.get('resume')?.()
  expect(roster.request).toHaveBeenCalledTimes(1)
  expect(sync).toHaveBeenCalledTimes(1)

  handlers.get('unlock-screen')?.()
  expect(roster.request).toHaveBeenCalledTimes(2)
  expect(sync).toHaveBeenCalledTimes(2)
})
