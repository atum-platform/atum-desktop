import { describe, expect, it, vi } from 'vitest'

import { ensureMatrixFullHermes, matrixFullHermesKey } from './full-hermes'

function store(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))

  return {
    map,
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void map.set(key, value))
  }
}

const run = (input: Partial<Parameters<typeof ensureMatrixFullHermes>[0]> = {}) =>
  ensureMatrixFullHermes({
    store: store(),
    executorId: 'executor',
    apply: vi.fn(async () => {}),
    signal: new AbortController().signal,
    log: vi.fn(),
    ...input
  })

describe('the one-time full Hermes profile', () => {
  it('applies once per executor, then leaves the profile to the person', async () => {
    const vault = store()
    const apply = vi.fn(async () => {})
    expect(await run({ store: vault, apply })).toBe('applied')
    expect(vault.map.get(matrixFullHermesKey('executor'))).toBe('1')
    expect(await run({ store: vault, apply })).toBe('already')
    expect(apply).toHaveBeenCalledOnce()
    // Another executor on the same Mac has its own profile.
    expect(await run({ store: vault, apply, executorId: 'other' })).toBe('applied')
  })

  it('never fails setup: a failed write is logged and tried again next launch', async () => {
    const vault = store()
    const log = vi.fn()

    const apply = vi.fn(async () => {
      throw new Error('private details')
    })

    expect(await run({ store: vault, apply, log })).toBe('failed')
    expect(vault.map.has(matrixFullHermesKey('executor'))).toBe(false)
    expect(log.mock.calls[0]![0]).not.toContain('private details')
    expect(await run({ store: vault })).toBe('applied')
  })

  it('applies again when the marker cannot be read, and keeps going when it cannot be saved', async () => {
    const unreadable = { ...store(), getItem: vi.fn(() => { throw new Error('vault') }) }
    expect(await run({ store: unreadable })).toBe('applied')
    const unwritable = { ...store(), setItem: vi.fn(() => { throw new Error('vault') }) }
    const log = vi.fn()
    expect(await run({ store: unwritable, log })).toBe('applied')
    expect(log).toHaveBeenCalledOnce()
  })

  it('stops when setup is cancelled, rather than reporting a failure', async () => {
    const abort = new AbortController()

    const apply = vi.fn(async () => {
      abort.abort()
      throw new Error('cancelled')
    })

    await expect(run({ apply, signal: abort.signal })).rejects.toThrow()
  })
})
