import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixAliasBridge, MatrixAliasResult } from '../../shared/matrix-aliases'

import { lookupPerson } from './people'
import {
  $matrixHandles,
  applyMatrixHandleContacts,
  bindMatrixHandleOwner,
  loadOwnMatrixHandle,
  rememberMatrixHandle,
  rememberOwnMatrixHandle,
  resetMatrixHandlesForTest
} from './person-handles'

const OWNER = '@synthetic-user-0013:example.invalid'
const LAN = '@synthetic-user-0019:example.invalid'
const HOA = '@synthetic-user-0022:example.invalid'

function bridge(answer: (input: Parameters<MatrixAliasBridge['request']>[0]) => MatrixAliasResult): MatrixAliasBridge {
  return {
    pending: vi.fn(async () => ({ ok: true as const, request: null })),
    request: vi.fn(async input => answer(input))
  }
}

afterEach(() => resetMatrixHandlesForTest())

describe('handles the directory vouched for', () => {
  it('updates contacts with lower spelling generations after rename and clears contacts-sourced misses', () => {
    bindMatrixHandleOwner(OWNER)
    applyMatrixHandleContacts([{matrixUser:LAN,handle:'lan',status:'resolved',generation:2}])
    expect($matrixHandles.get().byUser[LAN]).toBe('lan')
    applyMatrixHandleContacts([{matrixUser:LAN,handle:'lan_new',status:'resolved',generation:1}])
    expect($matrixHandles.get().byUser[LAN]).toBe('lan_new')
    applyMatrixHandleContacts([{matrixUser:LAN,handle:null,status:'not_visible',generation:null}])
    expect($matrixHandles.get().byUser[LAN]).toBeUndefined()
  })

  it('a contacts miss never forgets a handle learned from exact lookup, including persisted entries',()=>{
    bindMatrixHandleOwner(OWNER)
    rememberMatrixHandle(LAN,'lan_exact')
    applyMatrixHandleContacts([{matrixUser:LAN,handle:null,status:'unknown',generation:null}])
    expect($matrixHandles.get().byUser[LAN]).toBe('lan_exact')
    bindMatrixHandleOwner(HOA);bindMatrixHandleOwner(OWNER)
    applyMatrixHandleContacts([{matrixUser:LAN,handle:null,status:'unknown',generation:null}])
    expect($matrixHandles.get().byUser[LAN]).toBe('lan_exact')
  })

  it('learns the signed-in person\'s own handle once per account, and asks again after a failure', async () => {
    let fail = true

    const aliases = bridge(() =>
      fail
        ? { ok: false, error: 'unavailable' }
        : { ok: true, value: { kind: 'current', alias: { handle: 'minh', generation: 1 } } }
    )

    await loadOwnMatrixHandle(OWNER, aliases)
    expect($matrixHandles.get().byUser[OWNER]).toBeUndefined()

    fail = false
    await loadOwnMatrixHandle(OWNER, aliases)
    await loadOwnMatrixHandle(OWNER, aliases)
    expect($matrixHandles.get().byUser[OWNER]).toBe('minh')
    expect(aliases.request).toHaveBeenCalledTimes(2)
  })

  it('learns someone\'s handle from a lookup that names their Matrix ID, and moves it when it changes hands', async () => {
    bindMatrixHandleOwner(OWNER)
    let holder = LAN

    const aliases = bridge(() => ({
      ok: true,
      value: { kind: 'lookup', handle: 'lan', state: 'assigned', principalKind: 'human', matrixUser: holder }
    }))

    await lookupPerson(aliases, 'lan')
    expect($matrixHandles.get().byUser).toEqual({ [LAN]: 'lan' })

    holder = HOA
    await lookupPerson(aliases, 'lan')
    expect($matrixHandles.get().byUser).toEqual({ [HOA]: 'lan' })
  })

  it('forgets a handle the directory says is free again', async () => {
    bindMatrixHandleOwner(OWNER)
    await lookupPerson(
      bridge(() => ({ ok: true, value: { kind: 'lookup', handle: 'lan', state: 'assigned', principalKind: 'human', matrixUser: LAN } })),
      'lan'
    )
    await lookupPerson(bridge(() => ({ ok: true, value: { kind: 'lookup', handle: 'lan', state: 'available' } })), 'lan')

    expect($matrixHandles.get().byUser).toEqual({})
  })

  it('keeps what Settings just claimed, and starts empty for another account', () => {
    bindMatrixHandleOwner(OWNER)
    rememberOwnMatrixHandle('minh')
    expect($matrixHandles.get().byUser[OWNER]).toBe('minh')

    bindMatrixHandleOwner(LAN)
    expect($matrixHandles.get().byUser).toEqual({})
  })
})

/** A new window: nothing in memory, whatever this Mac remembered still on disk. */
function newWindow() {
  $matrixHandles.set({ owner: '', byUser: {} })
}

describe('handles remembered between launches', () => {
  afterEach(() => vi.useRealTimers())

  it('keeps a vouched-for handle for the same account after the window reopens, and not for another account', () => {
    bindMatrixHandleOwner(OWNER)
    rememberMatrixHandle(LAN, 'lan')

    newWindow()
    bindMatrixHandleOwner(LAN)
    expect($matrixHandles.get().byUser).toEqual({})

    newWindow()
    bindMatrixHandleOwner(OWNER)
    expect($matrixHandles.get().byUser).toEqual({ [LAN]: 'lan' })
  })

  it('lets a remembered handle lapse after a week, well inside the 30 days a renamed handle stays held', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-05T00:00:00Z'))
    bindMatrixHandleOwner(OWNER)
    rememberMatrixHandle(LAN, 'lan')

    vi.setSystemTime(new Date('2026-11-11T23:00:00Z'))
    newWindow()
    bindMatrixHandleOwner(OWNER)
    expect($matrixHandles.get().byUser[LAN]).toBe('lan')

    vi.setSystemTime(new Date('2026-11-12T01:00:00Z'))
    newWindow()
    bindMatrixHandleOwner(OWNER)
    expect($matrixHandles.get().byUser).toEqual({})
  })

  it('remembers the move when a handle changes hands, and what the directory released stays forgotten', async () => {
    bindMatrixHandleOwner(OWNER)
    rememberMatrixHandle(LAN, 'lan')
    rememberMatrixHandle(HOA, 'lan')
    newWindow()
    bindMatrixHandleOwner(OWNER)
    expect($matrixHandles.get().byUser).toEqual({ [HOA]: 'lan' })

    await lookupPerson(bridge(() => ({ ok: true, value: { kind: 'lookup', handle: 'lan', state: 'available' } })), 'lan')
    newWindow()
    bindMatrixHandleOwner(OWNER)
    expect($matrixHandles.get().byUser).toEqual({})
  })

  it('never restores anything that is not a handle for a Matrix ID', () => {
    window.localStorage.setItem(
      `atum.matrix.verified-handles.v1:${OWNER}`,
      JSON.stringify({
        v: 1,
        byUser: {
          [LAN]: { h: 'user-3f2a9c0d1e2b4a5f6c7d8e9f0a1b2c3d:atum.chat', at: Date.now() },
          'not-a-user': { h: 'lan', at: Date.now() },
          [HOA]: { h: 'hoa', at: Date.now() }
        }
      })
    )
    bindMatrixHandleOwner(OWNER)
    expect($matrixHandles.get().byUser).toEqual({ [HOA]: 'hoa' })
  })
})
