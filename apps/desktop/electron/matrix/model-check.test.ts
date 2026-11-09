import { describe, expect, it, vi } from 'vitest'

import { matrixFullHermesKey } from './full-hermes'
import { MATRIX_MODEL_CHECK_WRITES } from './hermes-setup'
import {
  forgetMatrixModelCheck,
  type MatrixModelCheckContext,
  matrixModelCheckCurrent,
  matrixModelCheckKey,
  type MatrixModelCheckStore,
  rememberMatrixModelCheck,
  runMatrixModelCheck
} from './model-check'

const KEY = 'sk-atum-proxy-key-that-must-never-be-stored'

function vault(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))

  return {
    map,
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void map.set(key, value)),
    removeItem: vi.fn((key: string) => void map.delete(key))
  }
}

/** A profile as Hermes writes it: the endpoint, its key and the selected model all in it. */
const profile = (overrides: Partial<{ key: string; provider: string; model: string; baseUrl: string }> = {}) =>
  [
    'model:',
    `  provider: ${overrides.provider ?? 'atum-gateway'}`,
    `  default: ${overrides.model ?? 'atum/default'}`,
    `  api_key: ${overrides.key ?? KEY}`,
    'providers:',
    '  atum-gateway:',
    `    base_url: ${overrides.baseUrl ?? 'http://127.0.0.1:43110/v1'}`
  ].join('\n')

function context(
  store: MatrixModelCheckStore = vault({ [matrixFullHermesKey('executor')]: '1' }),
  file: { value: string } = { value: profile() },
  overrides: Partial<MatrixModelCheckContext> = {}
): MatrixModelCheckContext {
  return {
    store,
    executorId: 'executor',
    build: '0.17.0+64d4840438ab0913e8b4e8eaa806f5dbe41aa4bc',
    writes: MATRIX_MODEL_CHECK_WRITES,
    proxy: { baseUrl: 'http://127.0.0.1:43110/v1', model: 'atum/default', apiKey: KEY },
    readConfig: () => file.value,
    ...overrides
  }
}

/** The check ran and left Atum's model: its stamp is written. */
function checked(value: MatrixModelCheckContext, current = true) {
  rememberMatrixModelCheck({ ...value, current }, vi.fn())
}

describe('skipping the launch-time model check (G1-13)', () => {
  it("skips when the last check left Atum's model and nothing it depends on changed", () => {
    const value = context()
    expect(matrixModelCheckCurrent({ ...value, ownModel: false })).toBe(false)
    checked(value)
    expect(matrixModelCheckCurrent({ ...value, ownModel: false })).toBe(true)
  })

  it('checks again after anything changes the profile: the person, Hermes, the pages or the agent', () => {
    const file = { value: profile() }
    const value = context(undefined, file)
    checked(value)

    for (const changed of [
      profile({ provider: 'openai-codex' }),
      profile({ model: 'gpt-5.5' }),
      profile({ key: 'sk-someone-else' }),
      profile({ baseUrl: 'http://127.0.0.1:43111/v1' }),
      `${profile()}\nauxiliary:\n  title_generation:\n    enabled: true`
    ]) {
      file.value = changed
      expect(matrixModelCheckCurrent({ ...value, ownModel: false })).toBe(false)
    }

    file.value = profile()
    expect(matrixModelCheckCurrent({ ...value, ownModel: false })).toBe(true)
  })

  it('checks again for a new build, new writes, another proxy, model or key, or another executor', () => {
    const store = vault({ [matrixFullHermesKey('executor')]: '1', [matrixFullHermesKey('other')]: '1' })
    const value = context(store)
    checked(value)

    const variations: Array<Partial<MatrixModelCheckContext>> = [
      { build: '0.17.1+0000000000000000000000000000000000000000' },
      { writes: { ...MATRIX_MODEL_CHECK_WRITES, contextLength: 1 } },
      { proxy: { ...value.proxy, baseUrl: 'http://127.0.0.1:43111/v1' } },
      { proxy: { ...value.proxy, model: 'atum/other' } },
      { proxy: { ...value.proxy, apiKey: 'sk-rotated' } },
      { executorId: 'other' }
    ]

    for (const variation of variations) {
      expect(matrixModelCheckCurrent({ ...context(store, undefined, variation), ownModel: false })).toBe(false)
    }

    expect(matrixModelCheckCurrent({ ...value, ownModel: false })).toBe(true)
  })

  it("never skips the person's own model, or a profile without the full Hermes defaults", () => {
    const value = context()
    checked(value)
    expect(matrixModelCheckCurrent({ ...value, ownModel: true })).toBe(false)

    value.store.removeItem(matrixFullHermesKey('executor'))
    expect(matrixModelCheckCurrent({ ...value, ownModel: false })).toBe(false)
  })

  it("stamps only a check that left Atum's model with the full Hermes defaults applied", () => {
    const value = context()
    checked(value, false)
    expect(value.store.getItem(matrixModelCheckKey('executor'))).toBeNull()

    const notApplied = context(vault())
    checked(notApplied)
    expect(notApplied.store.getItem(matrixModelCheckKey('executor'))).toBeNull()
  })

  it('forgets the stamp when a later check does not leave Atum\'s model, fails or is cancelled', () => {
    const value = context()
    checked(value)
    checked(value, false)
    expect(matrixModelCheckCurrent({ ...value, ownModel: false })).toBe(false)

    checked(value)
    forgetMatrixModelCheck(value.store, 'executor')
    expect(matrixModelCheckCurrent({ ...value, ownModel: false })).toBe(false)
  })

  it('keeps the key out of the vault: only digests are stored', () => {
    const value = context()
    checked(value)
    const stamp = value.store.getItem(matrixModelCheckKey('executor'))!
    expect(stamp).not.toContain(KEY)
    expect(stamp).not.toContain('atum-gateway')
    expect(Object.keys(JSON.parse(stamp))).toEqual(['v', 'inputs', 'config'])
  })

  it('checks as before when the vault or the profile cannot be read, and never fails setup', () => {
    const value = context()
    checked(value)

    const unreadableVault = {
      ...value.store,
      getItem: vi.fn(() => {
        throw new Error('vault')
      })
    }

    expect(matrixModelCheckCurrent({ ...value, store: unreadableVault, ownModel: false })).toBe(false)

    const missing = context(value.store, undefined, {
      readConfig: () => {
        throw new Error('ENOENT')
      }
    })

    expect(matrixModelCheckCurrent({ ...missing, ownModel: false })).toBe(false)

    const log = vi.fn()
    rememberMatrixModelCheck({ ...missing, current: true }, log)
    expect(value.store.getItem(matrixModelCheckKey('executor'))).toBeNull()
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).not.toContain('ENOENT')

    const unwritable = context(
      {
        ...vault({ [matrixFullHermesKey('executor')]: '1' }),
        setItem: vi.fn(() => {
          throw new Error('vault')
        })
      },
      undefined
    )

    expect(() => rememberMatrixModelCheck({ ...unwritable, current: true }, vi.fn())).not.toThrow()
    expect(matrixModelCheckCurrent({ ...unwritable, ownModel: false })).toBe(false)
  })
})

describe('one model check, in order (G1-13)', () => {
  function run(value: MatrixModelCheckContext, ownModel = false) {
    const calls: string[] = []
    let settle!: (result: { ready: boolean; atum: boolean }) => void
    let fail!: (error: Error) => void

    const begin = vi.fn(() => {
      calls.push('begin')

      return new Promise<{ ready: boolean; atum: boolean }>((resolve, reject) => {
        settle = resolve
        fail = reject
      })
    })

    const stamped = () => value.store.getItem(matrixModelCheckKey('executor')) !== null

    const pending = runMatrixModelCheck({
      context: value,
      ownModel,
      begin,
      // The slot is released only after the stamp was written or forgotten.
      end: vi.fn(() => void calls.push(`end stamped=${stamped()}`)),
      alive: () => true,
      log: vi.fn()
    })

    return { pending, begin, calls, settle: (r: { ready: boolean; atum: boolean }) => settle(r), fail: (e: Error) => fail(e) }
  }

  it('starts nothing, and so stops nothing, when the profile is as the last pass left it', async () => {
    const value = context()
    checked(value)
    const check = run(value)

    expect(await check.pending).toBe('unchanged')
    expect(check.begin).not.toHaveBeenCalled()
    expect(check.calls).toEqual([])
  })

  it('begins at once when it has to check, stamps a pass, then releases the slot', async () => {
    const value = context()
    const check = run(value)

    // Begun synchronously: main holds the turn slot before anything else can run.
    expect(check.begin).toHaveBeenCalledOnce()
    check.settle({ ready: true, atum: true })

    expect(await check.pending).toBe('checked')
    expect(check.calls).toEqual(['begin', 'end stamped=true'])
    expect(matrixModelCheckCurrent({ ...value, ownModel: false })).toBe(true)
  })

  it('forgets the stamp when the check fails, is cancelled or is not ready, and still releases the slot', async () => {
    for (const ending of ['fails', 'not ready'] as const) {
      const value = context()
      checked(value)
      const check = run(value, true)

      if (ending === 'fails') {
        check.fail(new Error('Hermes backend: exited before port announcement (SIGTERM)'))
        await expect(check.pending).rejects.toThrow('SIGTERM')
      } else {
        check.settle({ ready: false, atum: true })
        await expect(check.pending).rejects.toThrow('matrix_setup_failed')
      }

      expect(check.calls).toEqual(['begin', 'end stamped=false'])
    }
  })

  it("checks the person's own model even with a stamp, and writes no stamp for it", async () => {
    const value = context()
    checked(value)
    const check = run(value, true)

    expect(check.begin).toHaveBeenCalledOnce()
    check.settle({ ready: true, atum: false })
    expect(await check.pending).toBe('checked')
    expect(check.calls).toEqual(['begin', 'end stamped=false'])
  })

  it('writes no stamp for an agent stopped for good while it checked', async () => {
    const value = context()
    const end = vi.fn()

    const pending = runMatrixModelCheck({
      context: value,
      ownModel: false,
      begin: async () => ({ ready: true, atum: true }),
      end,
      alive: () => false,
      log: vi.fn()
    })

    expect(await pending).toBe('checked')
    expect(value.store.getItem(matrixModelCheckKey('executor'))).toBeNull()
    expect(end).toHaveBeenCalledOnce()
  })
})
