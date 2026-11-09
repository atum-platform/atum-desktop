import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixAliasBridge, MatrixAliasRequest, MatrixAliasResult } from '../../shared/matrix-aliases'

import { MATRIX_HANDLE_REFRESH_MS, requestMatrixHandles, resetMatrixHandleContactsForTest, setMatrixHandleContactsBridgeForTest } from './person-handle-contacts'
import {
  $matrixHandles,
  bindMatrixHandleOwner,
  bindMatrixHandleOwnerFromSnapshot,
  matrixHandleAccount,
  rememberAgentHandle,
  rememberMatrixHandle,
  resetMatrixHandlesForTest
} from './person-handles'

const OWNER = '@user-00000000000000000000000000000000:atum.chat'
const OTHER_OWNER = '@user-99999999999999999999999999999999:atum.chat'
const POON = '@user-4c65aa0b1c2d3e4f5a6b7c8d9e0f1a2b:atum.chat'
const LAN = '@user-3f2a9c0d1e2b4a5f6c7d8e9f0a1b2c3d:atum.chat'
const HOA = '@user-7b1e0c9d8a7f6e5d4c3b2a1f0e9d8c7b:atum.chat'

type Answer = (users: string[]) => MatrixAliasResult | Promise<MatrixAliasResult>

const handlesOf = (byUser: Record<string, string>): Answer => users => ({
  ok: true,
  value: { kind: 'contacts', contacts: users.map(matrixUser => ({ matrixUser, handle: byUser[matrixUser] ?? null })) }
})

function directory(answer: Answer) {
  const request = vi.fn(async (input: MatrixAliasRequest) => {
    if (input.action !== 'contacts') {
      throw new Error('only contacts expected')
    }

    return answer(input.matrixUsers)
  })

  const bridge: MatrixAliasBridge = { pending: vi.fn(async () => ({ ok: true as const, request: null })), request }
  setMatrixHandleContactsBridgeForTest(bridge)

  return request
}

const asked = (request: ReturnType<typeof directory>) =>
  request.mock.calls.map(([input]) => (input.action === 'contacts' ? input.matrixUsers : []))

beforeEach(() => {
  vi.useFakeTimers()
  bindMatrixHandleOwner(OWNER)
})

afterEach(() => {
  resetMatrixHandleContactsForTest()
  resetMatrixHandlesForTest()
  vi.useRealTimers()
})

describe('handles of people already known', () => {
  it('re-asks capped misses after two hours and learns a new allocation', async () => {
    let revision=1
    let found=false
    const request=directory(users=>({ok:true,value:{kind:'contacts',schemaVersion:2,revision,
      contacts:users.map(matrixUser=>({matrixUser,handle:found?'poon':null,
        status:found?'resolved' as const:'unknown' as const,generation:found?1:null}))}}))
    requestMatrixHandles(OWNER,[POON])
    await vi.advanceTimersByTimeAsync(300)
    expect($matrixHandles.get().byUser[POON]).toBeUndefined()
    revision=2;found=true
    await vi.advanceTimersByTimeAsync(2*60*60*1000)
    requestMatrixHandles(OWNER,[POON])
    await vi.advanceTimersByTimeAsync(300)
    expect(request).toHaveBeenCalledTimes(2)
    expect($matrixHandles.get().byUser[POON]).toBe('poon')
  })

  it('keeps verified handles through a network failure instead of treating it as a miss', async () => {
    rememberMatrixHandle(POON,'poon')
    await vi.advanceTimersByTimeAsync(MATRIX_HANDLE_REFRESH_MS+1)
    directory(()=>({ok:false,error:'unavailable'}))
    requestMatrixHandles(OWNER,[POON])
    await vi.advanceTimersByTimeAsync(300)
    expect($matrixHandles.get().byUser[POON]).toBe('poon')
  })

  it('drops a read begun before a local rename', async () => {
    let answer!: (value:MatrixAliasResult)=>void
    directory(()=>new Promise(resolve=>{answer=resolve}))
    requestMatrixHandles(OWNER,[LAN])
    await vi.advanceTimersByTimeAsync(300)
    rememberAgentHandle(LAN,'lan_new','lan')
    answer({ok:true,value:{kind:'contacts',schemaVersion:2,revision:1,contacts:[{matrixUser:LAN,handle:'lan',status:'resolved',generation:1}]}})
    await vi.advanceTimersByTimeAsync(1)
    expect($matrixHandles.get().byUser[LAN]).toBe('lan_new')
  })

  it('stays below the daily server budget over an hour and eight hours', async () => {
    let count=0
    const request=directory(users=>{count++;return {ok:true,value:{kind:'contacts',schemaVersion:2,revision:1,
      contacts:users.map(matrixUser=>({matrixUser,handle:'poon',status:'resolved' as const,generation:1}))}}})
    for (let minute=0;minute<=480;minute++) {
      requestMatrixHandles(OWNER,[POON])
      await vi.advanceTimersByTimeAsync(60_000)
      if (minute===60) {expect(count).toBeLessThanOrEqual(3)}
    }
    expect(request.mock.calls.length).toBeLessThanOrEqual(17)
    expect(count).toBeLessThan(300)
  })
  it('falls back once to contacts/1 on an old Shell schema refusal', async () => {
    const request=vi.fn(async(input:MatrixAliasRequest):Promise<MatrixAliasResult>=>input.action==='contacts' && input.schemaVersion===2
      ? {ok:false,error:'invalid'} : {ok:true,value:{kind:'contacts',contacts:[{matrixUser:POON,handle:'poon'}]}})
    setMatrixHandleContactsBridgeForTest({request,pending:vi.fn(async()=>({ok:true as const,request:null}))})
    requestMatrixHandles(OWNER,[POON]);await vi.advanceTimersByTimeAsync(300)
    expect(request.mock.calls.map(([input])=>input.action==='contacts'?input.schemaVersion:null)).toEqual([2,undefined])
    expect($matrixHandles.get().byUser[POON]).toBe('poon')
  })
  it('stops queued reads and polling while the domain is off',async()=>{
    const request=directory(handlesOf({[POON]:'poon'}))
    requestMatrixHandles(OWNER,[POON])
    bindMatrixHandleOwnerFromSnapshot({identity:{userId:OWNER,deviceId:'OWNER'},state:'ready',domainEnabled:false})
    await vi.advanceTimersByTimeAsync(8*60*60*1000)
    requestMatrixHandles(OWNER,[POON]);await vi.advanceTimersByTimeAsync(300)
    expect(request).not.toHaveBeenCalled()
  })

  it('pools the asks of many rows into one read, and learns the handles it answers', async () => {
    const request = directory(handlesOf({ [POON]: 'poon' }))

    // Three rows asking separately, one of them twice.
    requestMatrixHandles(OWNER, [POON])
    requestMatrixHandles(OWNER, [LAN, POON])
    requestMatrixHandles(OWNER, [HOA])
    await vi.advanceTimersByTimeAsync(300)

    expect(asked(request)).toEqual([[POON, LAN, HOA]])
    expect($matrixHandles.get().byUser[POON]).toBe('poon')
    expect($matrixHandles.get().byUser[LAN]).toBeUndefined()
  })

  it('never asks for the owner, a known handle, another server or a non-local ID', async () => {
    const request = directory(handlesOf({}))
    rememberMatrixHandle(LAN, 'lan')

    requestMatrixHandles(OWNER, [OWNER, LAN, '@contact-fixture:example.invalid', 'poon', '@Upper:example.invalid', '', undefined, null])
    await vi.advanceTimersByTimeAsync(300)

    expect(request).not.toHaveBeenCalled()
  })

  it('keeps a no-handle answer in memory only for a while, then asks again', async () => {
    const request = directory(handlesOf({}))

    requestMatrixHandles(OWNER, [LAN])
    await vi.advanceTimersByTimeAsync(300)
    requestMatrixHandles(OWNER, [LAN])
    await vi.advanceTimersByTimeAsync(300)
    expect(request).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(121 * 60 * 1000)
    requestMatrixHandles(OWNER, [LAN])
    await vi.advanceTimersByTimeAsync(300)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('splits more than 50 people into reads of 50, one at a time', async () => {
    const people = Array.from({ length: 120 }, (_, index) => `@user-${String(index).padStart(32, '0')}a:atum.chat`)
    let open = 0
    let most = 0

    const request = directory(async users => {
      open += 1
      most = Math.max(most, open)
      await Promise.resolve()
      open -= 1

      return handlesOf({})(users)
    })

    requestMatrixHandles(OWNER, people)
    await vi.advanceTimersByTimeAsync(2000)

    expect(asked(request).map(batch => batch.length)).toEqual([50, 50, 20])
    expect(most).toBe(1)
  })

  it('asks again after a failure, backing off, and never takes a failure as "no handle"', async () => {
    let fail = true
    const request = directory(users => (fail ? { ok: false, error: 'unavailable' } : handlesOf({ [POON]: 'poon' })(users)))

    requestMatrixHandles(OWNER, [POON])
    await vi.advanceTimersByTimeAsync(300)
    expect(request).toHaveBeenCalledTimes(1)

    // Not within the first backoff.
    await vi.advanceTimersByTimeAsync(20 * 1000)
    expect(request).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(15 * 1000)
    expect(request).toHaveBeenCalledTimes(2)

    // The second failure waits twice as long.
    await vi.advanceTimersByTimeAsync(50 * 1000)
    expect(request).toHaveBeenCalledTimes(2)
    fail = false
    await vi.advanceTimersByTimeAsync(15 * 1000)
    expect(request).toHaveBeenCalledTimes(3)
    expect($matrixHandles.get().byUser[POON]).toBe('poon')
  })

  it('waits out a 429 for as long as the route says', async () => {
    let limited = true
    const request = directory(users => (limited ? { ok: false, error: 'limit', retryAfterSeconds: 120 } : handlesOf({})(users)))

    requestMatrixHandles(OWNER, [POON])
    await vi.advanceTimersByTimeAsync(300)
    limited = false
    await vi.advanceTimersByTimeAsync(110 * 1000)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15 * 1000)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('stays within its share of the ten-minute budget however many lists ask', async () => {
    const request = directory(handlesOf({}))

    for (let index = 0; index < 30; index += 1) {
      requestMatrixHandles(OWNER, [`@user-${String(index).padStart(32, '0')}b:atum.chat`])
      await vi.advanceTimersByTimeAsync(300)
    }

    expect(request.mock.calls.length).toBeLessThanOrEqual(12)

    // The rest go out once the window has room again; nothing is dropped.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(asked(request).flat()).toHaveLength(30)
  })

  it('tears everything down on sign-out: a read in flight, the queue, the backoff and the null memory', async () => {
    let release: (value: MatrixAliasResult) => void = () => {}
    let calls = 0

    const request = directory(users => {
      calls += 1

      // First read: answered only after the sign-out. Second: fails, so its IDs wait in backoff.
      if (calls === 1) {
        return new Promise(resolve => (release = resolve))
      }

      return calls === 2 ? { ok: false, error: 'unavailable' } : handlesOf({})(users)
    })

    requestMatrixHandles(OWNER, [POON])
    await vi.advanceTimersByTimeAsync(300)
    expect(request).toHaveBeenCalledTimes(1)

    // Signed out (the root snapshot), then the in-flight read lands: nothing is learned.
    bindMatrixHandleOwnerFromSnapshot({ identity: null, state: 'signed_out' })
    expect(matrixHandleAccount().owner).toBe('')
    release({ ok: true, value: { kind: 'contacts', contacts: [{ matrixUser: POON, handle: 'poon' }] } })
    await vi.advanceTimersByTimeAsync(300)
    expect($matrixHandles.get().byUser[POON]).toBeUndefined()

    // Signed out, nothing can be asked.
    requestMatrixHandles(OWNER, [LAN])
    await vi.advanceTimersByTimeAsync(300)
    expect(request).toHaveBeenCalledTimes(1)

    // Back in as the same person: a new generation, starting from nothing.
    bindMatrixHandleOwnerFromSnapshot({ state: 'ready', identity: { userId: OWNER, deviceId: 'D' } })
    requestMatrixHandles(OWNER, [LAN])
    await vi.advanceTimersByTimeAsync(300)
    expect(asked(request)[1]).toEqual([LAN])

    // LAN's failed read is in backoff; signing out again cancels that retry for good.
    bindMatrixHandleOwnerFromSnapshot({ identity: null, state: 'signed_out' })
    await vi.advanceTimersByTimeAsync(121 * 60 * 1000)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('drops work begun for an earlier generation of the same account', async () => {
    const request = directory(handlesOf({ [POON]: 'poon' }))
    const before = matrixHandleAccount()

    bindMatrixHandleOwner('')
    bindMatrixHandleOwner(OWNER)
    requestMatrixHandles(before.owner, [POON], before.generation)
    // A different account's ask is dropped too, whatever generation it names.
    requestMatrixHandles(OTHER_OWNER, [LAN], matrixHandleAccount().generation)
    await vi.advanceTimersByTimeAsync(300)

    expect(request).not.toHaveBeenCalled()
  })

  it('takes a 400 as a failed read, never as "no handle": it backs off and asks again', async () => {
    let refused = true
    const request = directory(users => (refused ? { ok: false, error: 'invalid' } : handlesOf({ [POON]: 'poon' })(users)))

    requestMatrixHandles(OWNER, [POON])
    await vi.advanceTimersByTimeAsync(300)
    expect(request).toHaveBeenCalledTimes(2)

    // Not asked again within the backoff, and not remembered as handle-less either.
    await vi.advanceTimersByTimeAsync(20 * 1000)
    expect(request).toHaveBeenCalledTimes(2)
    refused = false
    await vi.advanceTimersByTimeAsync(15 * 1000)
    expect(request).toHaveBeenCalledTimes(3)
    expect($matrixHandles.get().byUser[POON]).toBe('poon')
  })

  it('belongs to one account: switching drops the queue and an answer for the old account', async () => {
    let release: (value: MatrixAliasResult) => void = () => {}
    const request = directory(() => new Promise(resolve => (release = resolve)))

    requestMatrixHandles(OWNER, [POON])
    await vi.advanceTimersByTimeAsync(300)
    expect(request).toHaveBeenCalledTimes(1)

    bindMatrixHandleOwner(OTHER_OWNER)
    release({ ok: true, value: { kind: 'contacts', contacts: [{ matrixUser: POON, handle: 'poon' }] } })
    await vi.advanceTimersByTimeAsync(300)

    expect($matrixHandles.get()).toEqual({ owner: OTHER_OWNER, byUser: {} })

    // The new account asks for itself.
    request.mockImplementation(async () => handlesOf({ [POON]: 'poon' })([POON]))
    requestMatrixHandles(OTHER_OWNER, [POON])
    await vi.advanceTimersByTimeAsync(300)
    expect(request).toHaveBeenCalledTimes(2)
    expect($matrixHandles.get().byUser[POON]).toBe('poon')
  })
})
