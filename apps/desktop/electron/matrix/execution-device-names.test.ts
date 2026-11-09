import { describe, expect, it, vi } from 'vitest'

import type { ExecutionDeviceName } from '../../shared/execution-policy'

import {
  executionDeviceNamesProjectionChanged,
  type ExecutionDeviceRecord,
  MATRIX_EXECUTION_DEVICE_NAMES_REFRESH_MS,
  MATRIX_EXECUTION_DEVICE_NAMES_RETRY_MS,
  MatrixExecutionDeviceNames
} from './execution-device-names'

const OWN = '00000000-0000-4000-8000-bd7662a5eeb4'
const OTHER = '00000000-0000-4000-8000-b454f82c5857'

function record(overrides: Partial<ExecutionDeviceRecord> = {}): ExecutionDeviceRecord {
  return {
    deviceServiceId: OWN,
    displayName: 'Owner’s MacBook Air',
    state: 'active',
    platform: 'macos',
    createdAt: 1,
    ...overrides
  }
}

interface FixtureScope {
  accountKey: string
  generation: number
}

function fixture(
  options: {
    records?: ExecutionDeviceRecord[]
    own?: string | undefined
    scope?: () => FixtureScope | null
  } = {}
) {
  let now = 1_000

  const list = vi.fn(async (_signal: AbortSignal) => options.records ?? [record()])
  const model = vi.fn(async () => 'MacBook Air')

  const names = new MatrixExecutionDeviceNames({
    list,
    own: () => ('own' in options ? options.own : OWN),
    model,
    now: () => now,
    ...(options.scope ? { scope: options.scope } : {})
  })

  return { list, model, names, advance: (ms: number) => (now += ms) }
}

describe('the failover policy’s device names (one shared registry read)', () => {
  it('republishes placement destinations when a duplicate enrollment appears or disappears', () => {
    const names = { [OWN]: { displayName: 'Owner’s MacBook Air', thisMac: true } }
    const visible = { names, superseded: [] }
    const hiddenDuplicate = { names, superseded: [OTHER] }

    expect(executionDeviceNamesProjectionChanged(visible, names, [])).toBe(false)
    expect(executionDeviceNamesProjectionChanged(visible, names, [OTHER])).toBe(true)
    expect(executionDeviceNamesProjectionChanged(hiddenDuplicate, names, [])).toBe(true)
  })

  it('projects only the active Macs’ names, this Mac’s model, and nothing else from the record', async () => {
    const f = fixture({
      records: [
        record(),
        record({ deviceServiceId: OTHER, displayName: 'Mac mini' }),
        record({ deviceServiceId: '00000000-0000-4000-8000-f6222a1106ee', state: 'revoked' }),
        record({ deviceServiceId: '00000000-0000-4000-8000-f1d11edf5c5c', platform: 'windows' })
      ]
    })

    const value: Record<string, ExecutionDeviceName> = await f.names.read()

    expect(value).toEqual({
      [OWN]: { displayName: 'Owner’s MacBook Air', model: 'MacBook Air', thisMac: true },
      [OTHER]: { displayName: 'Mac mini', thisMac: false }
    })
    // Only this Mac asks for a model, and only once.
    expect(f.model).toHaveBeenCalledTimes(1)
  })

  it('does not read the model, or mark this Mac, when this Mac is not enrolled', async () => {
    const f = fixture({ own: undefined, records: [record({ deviceServiceId: OTHER, displayName: 'Mac mini' })] })

    expect(await f.names.read()).toEqual({ [OTHER]: { displayName: 'Mac mini', thisMac: false } })
    expect(f.model).not.toHaveBeenCalled()
  })

  it('hides an older exact-name enrollment superseded by this Mac without mutating distinct Macs', async () => {
    const old = '00000000-0000-4000-8000-f6222a1106ee'
    const f = fixture({
      records: [
        record({ deviceServiceId: old, createdAt: 10 }),
        record({ deviceServiceId: OWN, createdAt: 30 }),
        record({ deviceServiceId: OTHER, displayName: 'Mac mini', createdAt: 5 })
      ]
    })

    await expect(f.names.read()).resolves.toEqual({
      [OWN]: { displayName: 'Owner’s MacBook Air', model: 'MacBook Air', thisMac: true },
      [OTHER]: { displayName: 'Mac mini', thisMac: false }
    })
    expect(f.names.superseded()).toEqual([old])
  })

  it('serves every agent’s refresh from one read, refreshing only after the interval', async () => {
    const f = fixture()

    await f.names.read()
    await f.names.read()
    await f.names.read()
    expect(f.list).toHaveBeenCalledTimes(1)

    f.advance(MATRIX_EXECUTION_DEVICE_NAMES_REFRESH_MS - 1)
    await f.names.read()
    expect(f.list).toHaveBeenCalledTimes(1)

    f.advance(1)
    await f.names.read()
    expect(f.list).toHaveBeenCalledTimes(2)
  })

  it('joins a read already in flight instead of starting another', async () => {
    let finish!: (records: ExecutionDeviceRecord[]) => void

    const f = fixture()

    f.list.mockImplementationOnce(async () => new Promise<ExecutionDeviceRecord[]>(resolve => (finish = resolve)))

    const first = f.names.read()
    const second = f.names.read()

    finish([record()])
    await Promise.all([first, second])
    expect(f.list).toHaveBeenCalledTimes(1)
  })

  it('reads again at once when this Mac enrolls (invalidate)', async () => {
    const f = fixture()

    await f.names.read()
    f.names.invalidate()
    await f.names.read()
    expect(f.list).toHaveBeenCalledTimes(2)
  })

  it('never caches a failure: a caller with no names is refused, and the retry waits its window', async () => {
    const f = fixture()

    f.list.mockRejectedValueOnce(new Error('registry refused'))
    await expect(f.names.read()).rejects.toThrow('registry refused')

    // Every agent refreshing now is refused without a new list call.
    await expect(f.names.read()).rejects.toThrow('registry refused')
    expect(f.list).toHaveBeenCalledTimes(1)

    f.advance(MATRIX_EXECUTION_DEVICE_NAMES_RETRY_MS)
    await expect(f.names.read()).resolves.toEqual({ [OWN]: { displayName: 'Owner’s MacBook Air', model: 'MacBook Air', thisMac: true } })
    expect(f.list).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good names through an outage, and a later read recovers them', async () => {
    const f = fixture()

    await f.names.read()
    f.advance(MATRIX_EXECUTION_DEVICE_NAMES_REFRESH_MS)
    f.list.mockRejectedValueOnce(new Error('registry refused'))
    await expect(f.names.read()).resolves.toEqual({
      [OWN]: { displayName: 'Owner’s MacBook Air', model: 'MacBook Air', thisMac: true }
    })

    // Within the retry window the cached names serve without touching the registry…
    f.advance(MATRIX_EXECUTION_DEVICE_NAMES_RETRY_MS - 1)
    await f.names.read()
    expect(f.list).toHaveBeenCalledTimes(2)

    // …and after it the registry is asked again, so a rename cannot stay hidden forever.
    f.advance(2)
    f.list.mockResolvedValueOnce([record({ displayName: 'MacBook Air' })])
    await expect(f.names.read()).resolves.toEqual({
      [OWN]: { displayName: 'MacBook Air', model: 'MacBook Air', thisMac: true }
    })
    expect(f.list).toHaveBeenCalledTimes(3)
  })

  it('keys the cache by account, so a switch never serves the previous account’s names', async () => {
    let scope: FixtureScope | null = { accountKey: 'alice', generation: 1 }
    const f = fixture({ scope: () => scope })

    await expect(f.names.read()).resolves.toEqual({
      [OWN]: { displayName: 'Owner’s MacBook Air', model: 'MacBook Air', thisMac: true }
    })
    expect(f.list).toHaveBeenCalledTimes(1)

    scope = { accountKey: 'bob', generation: 2 }
    f.list.mockResolvedValueOnce([record({ displayName: 'Bob’s Mac mini' })])

    await expect(f.names.read()).resolves.toEqual({
      [OWN]: { displayName: 'Bob’s Mac mini', model: 'MacBook Air', thisMac: true }
    })
    expect(f.list).toHaveBeenCalledTimes(2)

    // A new generation of the same account (sign-out/sign-in) is a new scope too.
    scope = { accountKey: 'bob', generation: 3 }
    f.list.mockResolvedValueOnce([record({ displayName: 'MacBook Pro' })])
    await expect(f.names.read()).resolves.toEqual({
      [OWN]: { displayName: 'MacBook Pro', model: 'MacBook Air', thisMac: true }
    })
    expect(f.list).toHaveBeenCalledTimes(3)
  })

  it('never hands a read started for one account to the next', async () => {
    let scope: FixtureScope | null = { accountKey: 'alice', generation: 1 }
    let finishAlice!: (records: ExecutionDeviceRecord[]) => void
    const f = fixture({ scope: () => scope })

    f.list.mockImplementationOnce(async () => new Promise<ExecutionDeviceRecord[]>(resolve => (finishAlice = resolve)))

    const alice = f.names.read()
    scope = { accountKey: 'bob', generation: 2 }
    f.list.mockResolvedValueOnce([record({ displayName: 'Bob’s MacBook Pro' })])

    await expect(f.names.read()).resolves.toEqual({
      [OWN]: { displayName: 'Bob’s MacBook Pro', model: 'MacBook Air', thisMac: true }
    })

    // The abandoned read retries for the new account rather than leaking Alice's names.
    finishAlice([record({ displayName: 'Alice’s Mac mini' })])
    await expect(alice).resolves.toEqual({
      [OWN]: { displayName: 'Bob’s MacBook Pro', model: 'MacBook Air', thisMac: true }
    })
    expect(f.list).toHaveBeenCalledTimes(2)
  })

  it('does not carry one account’s failed-read retry window into the next', async () => {
    let scope: FixtureScope | null = { accountKey: 'alice', generation: 1 }
    const f = fixture({ scope: () => scope })

    f.list.mockRejectedValueOnce(new Error('registry refused'))
    await expect(f.names.read()).rejects.toThrow('registry refused')

    scope = { accountKey: 'bob', generation: 2 }
    await expect(f.names.read()).resolves.toEqual({
      [OWN]: { displayName: 'Owner’s MacBook Air', model: 'MacBook Air', thisMac: true }
    })
    expect(f.list).toHaveBeenCalledTimes(2)
  })

  it('refuses a read for a signed-out account when it has no cached names', async () => {
    let scope: FixtureScope | null = { accountKey: 'alice', generation: 1 }
    const f = fixture({ scope: () => scope })

    await f.names.read()
    scope = null
    f.list.mockRejectedValueOnce(new Error('not signed in'))

    await expect(f.names.read()).rejects.toThrow('not signed in')
    expect(f.list).toHaveBeenCalledTimes(2)
  })

  it('gives the registry read its own timeout, not a caller’s signal', async () => {
    const f = fixture()

    await f.names.read()
    const signal = f.list.mock.calls[0]![0]

    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
  })
})
