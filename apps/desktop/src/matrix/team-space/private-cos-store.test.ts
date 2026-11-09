import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixRoom, MatrixSnapshot } from '../../../shared/matrix'
import { isTeamSpaceRoom } from '../../../shared/matrix-company-channel-room'
import {
  isCompanyPrivateCosClaim,
  MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE,
  MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE,
  MATRIX_COMPANY_PRIVATE_COS_LOCALE_PROFILE,
  MATRIX_COMPANY_PRIVATE_COS_PROTECTED_STATE,
  MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
  MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT,
  type MatrixCompanyPrivateCosCapabilityV12,
  type MatrixCompanyPrivateCosCapabilityV13,
  type MatrixCompanyPrivateCosOwnerReceipt,
  matrixCompanyPrivateCosRoomBinding,
  type MatrixCompanyPrivateCosView
} from '../../../shared/matrix-company-private-cos'
import { matrixCompanyPrivateCosCopy } from '../../../shared/matrix-company-private-cos-copy'
import type { CompanyPrivateCosDesktopAdapter } from '../company-desktop-adapter'
import { projectMatrixRoster } from '../roster-model'

import { teamSpaceKey } from './keys'
import {
  $companyPrivateCos,
  $companyPrivateCosDiscovery,
  admitCompanyPrivateCosVisit,
  clearCompanyPrivateCos,
  COMPANY_PRIVATE_COS_RECHECK_MAX_MS,
  COMPANY_PRIVATE_COS_RECHECK_MIN_MS,
  companyPrivateCosRoom,
  companyPrivateCosRowStatus,
  ensureCompanyPrivateCos,
  loadCompanyPrivateCos,
  readCompanyPrivateCosReceipt,
  recheckCompanyPrivateCos,
  stopCompanyPrivateCos
} from './private-cos-store'

const ACCOUNT = 'account'
const COMPANY = '00000000-0000-4000-8000-fa2b298ca938'
const MEMBER = '00000000-0000-4000-8000-1399762cf502'
const INCARNATION = '00000000-0000-4000-8000-ef0a78a27144'
const ROOM = '!private-cos:atum.example'
const RUN = '00000000-0000-4000-8000-8e46c3a61153'
const OWNER_USER = '@owner:atum.example'
const MANAGER_USER = '@manager:atum.example'

const pair = { companyPrincipal: COMPANY, memberPrincipal: MEMBER, membershipIncarnation: INCARNATION }

const binding = {
  scope: { pair, authorityEpoch: 7, contextEpoch: 1, homeGeneration: 1 },
  agentPrincipal: '00000000-0000-4000-8000-c539893904f0',
  agentUserId: '@private_cos_a:atum.example',
  executorId: '00000000-0000-4000-8000-261fdbcb7dc1',
  homeId: '00000000-0000-4000-8000-eec8ec5cf84c',
  roomId: ROOM,
  storeGeneration: 1,
  profileDigest: 'a'.repeat(64)
}

const uncreated: MatrixCompanyPrivateCosView = { schemaVersion: 1, state: 'uncreated', pair, greetingState: 'pending' }
const accepted: MatrixCompanyPrivateCosView = {
  schemaVersion: 2,
  profile: MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE,
  state: 'preparing',
  pair,
  greetingState: 'pending',
  operationId: '00000000-0000-4000-8000-7d4ef186dc5c'
}
const ready: MatrixCompanyPrivateCosView = { schemaVersion: 1, state: 'ready', pair, greetingState: 'published', binding }
const powerLevels = {
  users: { [MANAGER_USER]: 100, [OWNER_USER]: 0, [binding.agentUserId]: 0 },
  users_default: 0,
  events_default: 0,
  state_default: 100,
  invite: 100,
  kick: 100,
  ban: 100,
  redact: 100,
  events: Object.fromEntries(MATRIX_COMPANY_PRIVATE_COS_PROTECTED_STATE.map(type => [type, 100]))
}
const capability: MatrixCompanyPrivateCosCapabilityV12 = {
  schemaVersion: 3 as const,
  profile: MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE,
  capability: 'company.private-cos' as const,
  supportedProfiles: [
    'atum.company-private-cos/1',
    MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE,
    MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE
  ],
  wire: { header: 'Atum-Company-Wire' as const, value: '1.2' as const },
  displayName: 'Chief of Staff' as const,
  teamDmPosition: 2 as const,
  lazyCreation: true as const,
  fundingKind: 'company_wallet' as const,
  separatePrice: false as const,
  purgeAfterDays: 30 as const,
  userExport: false as const,
  roomType: 'io.atum.assistant' as const,
  roomName: 'Chief of Staff' as const,
  roomEncrypted: false as const,
  greetingVersion: 2 as const
}
const v1Capability = {
  schemaVersion: 1 as const,
  profile: 'atum.company-private-cos/1' as const,
  capability: 'company.private-cos' as const,
  displayName: 'Chief of Staff' as const,
  teamDmPosition: 2 as const,
  lazyCreation: true as const,
  fundingKind: 'company_wallet' as const,
  separatePrice: false as const,
  purgeAfterDays: 30 as const,
  userExport: false as const
}
const v13Capability: MatrixCompanyPrivateCosCapabilityV13 = {
  ...capability,
  schemaVersion: 4,
  profile: MATRIX_COMPANY_PRIVATE_COS_LOCALE_PROFILE,
  supportedProfiles: [
    'atum.company-private-cos/1',
    MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE,
    MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE,
    MATRIX_COMPANY_PRIVATE_COS_LOCALE_PROFILE
  ],
  wire: { header: 'Atum-Company-Wire', value: '1.3' },
  ensureLocale: true
}

function adapter(over: Partial<CompanyPrivateCosDesktopAdapter> = {}): CompanyPrivateCosDesktopAdapter {
  return {
    readPrivateCosCapability: vi.fn(async () => capability),
    readPrivateCos: vi.fn(async () => accepted),
    ensurePrivateCos: vi.fn(async () => accepted),
    readPrivateCosReceipt: vi.fn(),
    stopPrivateCos: vi.fn(),
    ...over
  }
}

const load = (source: CompanyPrivateCosDesktopAdapter | undefined, advertised: unknown = capability) =>
  loadCompanyPrivateCos(source, ACCOUNT, COMPANY, advertised)

beforeEach(() => {
  clearCompanyPrivateCos(ACCOUNT)
})

describe('capability and availability projection', () => {
  it('has a non-empty label for every state in all five desktop locales', () => {
    for (const locale of ['vi', 'en', 'ja', 'zh', 'zh-hant'] as const) {
      expect(Object.values(matrixCompanyPrivateCosCopy[locale]).every(value => value.length > 0)).toBe(true)
    }
  })

  it('draws no state until a strict view proves the platform serves it', async () => {
    await expect(load(undefined)).resolves.toBeUndefined()
    await expect(load(adapter({
      readPrivateCos: vi.fn(async () => {throw new Error('unavailable')})
    }))).resolves.toBeUndefined()
    await expect(load(adapter({
      readPrivateCos: vi.fn(async () => uncreated)
    }), v1Capability)).resolves.toBeUndefined()
    expect($companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]).toBeUndefined()
  })

  it('ensures the new member on first admitted company visit and shows Preparing', async () => {
    const source = adapter({
      readPrivateCos: vi.fn(async () => uncreated),
      ensurePrivateCos: vi.fn(async () => accepted)
    })

    await expect(admitCompanyPrivateCosVisit(source, ACCOUNT, COMPANY, capability))
      .resolves.toMatchObject({ availability: 'preparing', view: accepted })
    expect(source.ensurePrivateCos).toHaveBeenCalledExactlyOnceWith(COMPANY, {
      schemaVersion: 1,
      requestId: expect.any(String),
      action: 'ensure',
      trigger: 'first_company_visit'
    })
  })

  it('sends the current UI locale only when 1.3 is explicitly advertised', async () => {
    const source = adapter({
      readPrivateCos: vi.fn(async () => uncreated),
      ensurePrivateCos: vi.fn(async () => accepted)
    })

    await expect(admitCompanyPrivateCosVisit(source, ACCOUNT, COMPANY, v13Capability, 'vi'))
      .resolves.toMatchObject({ profile: MATRIX_COMPANY_PRIVATE_COS_LOCALE_PROFILE })
    expect(source.ensurePrivateCos).toHaveBeenCalledExactlyOnceWith(COMPANY, {
      schemaVersion: 1,
      requestId: expect.any(String),
      action: 'ensure',
      trigger: 'first_company_visit',
      locale: 'vi'
    })
  })

  it('keeps the negotiated 1.3 locale on a later dm_open ensure', async () => {
    const source = adapter({
      readPrivateCos: vi.fn(async () => uncreated),
      ensurePrivateCos: vi.fn(async () => accepted)
    })

    await loadCompanyPrivateCos(source, ACCOUNT, COMPANY, v13Capability)
    await ensureCompanyPrivateCos(source, ACCOUNT, COMPANY, 'dm_open', 'vi')
    expect(source.ensurePrivateCos).toHaveBeenCalledExactlyOnceWith(COMPANY, {
      schemaVersion: 1,
      requestId: expect.any(String),
      action: 'ensure',
      trigger: 'dm_open',
      locale: 'vi'
    })
  })

  it('restores a ready pair after app relaunch without ensuring it again', async () => {
    const source = adapter({ readPrivateCos: vi.fn(async () => ready) })

    await expect(admitCompanyPrivateCosVisit(source, ACCOUNT, COMPANY, capability))
      .resolves.toMatchObject({ availability: 'ready', view: ready })
    expect(source.ensurePrivateCos).not.toHaveBeenCalled()
  })

  it('projects the four UI states without widening the three frozen wire states', async () => {
    const source = adapter()
    await load(source)
    expect($companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]?.availability).toBe('preparing')

    source.readPrivateCos = vi.fn(async () => ready)
    await load(source)
    expect($companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]?.availability).toBe('ready')

    source.readPrivateCos = vi.fn(async () => {throw new Error('budget_exhausted')})
    await load(source)
    expect($companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]?.availability).toBe('paused')

    source.readPrivateCos = vi.fn(async () => {throw new Error('unavailable')})
    await load(source)
    expect($companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]?.availability).toBe('unavailable')
  })

  it('retains the first stable 1.1 operation when a conflicting preparing response arrives', async () => {
    const source = adapter()
    await load(source)
    source.readPrivateCos = vi.fn(async () => ({
      ...accepted,
      operationId: '00000000-0000-4000-8000-7c5cdf063b7a'
    }))

    await load(source)
    const state = $companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]

    expect(state?.availability).toBe('unavailable')
    expect(state?.view).toEqual(accepted)
  })

  it('removes a previously negotiated row when the platform requires an unsupported wire', async () => {
    const source = adapter()
    await load(source)
    source.readPrivateCos = vi.fn(async () => {throw new Error('update_required')})

    await expect(load(source)).resolves.toBeUndefined()
    expect($companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]).toBeUndefined()
  })

  it('removes the pair immediately on membership denial and discards a late company-switch answer', async () => {
    const source = adapter()
    await load(source)

    source.readPrivateCos = vi.fn(async () => {throw new Error('denied')})
    await load(source)
    expect($companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]).toBeUndefined()

    let resolveLate!: (view: MatrixCompanyPrivateCosView) => void
    source.readPrivateCos = vi.fn(() => new Promise<MatrixCompanyPrivateCosView>(resolve => {resolveLate = resolve}))
    const pending = load(source)
    clearCompanyPrivateCos(ACCOUNT, COMPANY)
    resolveLate(ready)
    await pending
    expect($companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]).toBeUndefined()
  })

  it.each(['success', 'failure'] as const)(
    'never resurrects a cleared pair from a late ensure %s',
    async outcome => {
      let resolveLate!: (view: MatrixCompanyPrivateCosView) => void
      let rejectLate!: (error: Error) => void
      const source = adapter({
        ensurePrivateCos: vi.fn(() => new Promise<MatrixCompanyPrivateCosView>((resolve, reject) => {
          resolveLate = resolve
          rejectLate = reject
        }))
      })

      await load(source)
      const pending = ensureCompanyPrivateCos(source, ACCOUNT, COMPANY)
      clearCompanyPrivateCos(ACCOUNT, COMPANY)

      if (outcome === 'success') {
        resolveLate(ready)
      } else {
        rejectLate(new Error('unavailable'))
      }

      await expect(pending).rejects.toThrow()
      expect($companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]).toBeUndefined()
    }
  )

  it('does not let an old ensure failure overwrite a newly loaded membership incarnation', async () => {
    let rejectLate!: (error: Error) => void
    const source = adapter({
      ensurePrivateCos: vi.fn(() => new Promise<MatrixCompanyPrivateCosView>((_resolve, reject) => {
        rejectLate = reject
      }))
    })

    await load(source)
    const pending = ensureCompanyPrivateCos(source, ACCOUNT, COMPANY)
    clearCompanyPrivateCos(ACCOUNT, COMPANY)

    const nextPair = { ...pair, membershipIncarnation: '00000000-0000-4000-8000-2049a72dcc1f' }
    const nextReady: MatrixCompanyPrivateCosView = {
      ...ready,
      pair: nextPair,
      binding: {
        ...binding,
        scope: { ...binding.scope, pair: nextPair }
      }
    }
    source.readPrivateCos = vi.fn(async () => nextReady)
    await load(source)
    rejectLate(new Error('unavailable'))

    await expect(pending).rejects.toThrow('unavailable')
    expect($companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]?.view).toEqual(nextReady)
    expect($companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]?.availability).toBe('ready')
  })

  it('keeps a newer incarnation when the first-visit ensure caller rejects late', async () => {
    let rejectLate!: (error: Error) => void
    const source = adapter({
      readPrivateCos: vi.fn(async () => uncreated),
      ensurePrivateCos: vi.fn(() => new Promise<MatrixCompanyPrivateCosView>((_resolve, reject) => {
        rejectLate = reject
      }))
    })
    const pending = admitCompanyPrivateCosVisit(source, ACCOUNT, COMPANY, capability)

    await vi.waitFor(() => expect(source.ensurePrivateCos).toHaveBeenCalledOnce())
    clearCompanyPrivateCos(ACCOUNT, COMPANY)

    const nextPair = { ...pair, membershipIncarnation: '00000000-0000-4000-8000-a5557edf62b3' }
    const nextReady: MatrixCompanyPrivateCosView = {
      ...ready,
      pair: nextPair,
      binding: { ...binding, scope: { ...binding.scope, pair: nextPair } }
    }
    source.readPrivateCos = vi.fn(async () => nextReady)
    await load(source)
    rejectLate(new Error('unavailable'))

    await expect(pending).rejects.toThrow('unavailable')
    expect($companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]?.view).toEqual(nextReady)
    expect($companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]?.availability).toBe('ready')
  })

  it('never adopts a different owner or incarnation over a live pair', async () => {
    const source = adapter()
    await load(source)
    source.readPrivateCos = vi.fn(async () => ({
      ...ready,
      pair: { ...pair, memberPrincipal: '00000000-0000-4000-8000-cdd8c3d071fc' },
      binding: {
        ...binding,
        scope: {
          ...binding.scope,
          pair: { ...pair, memberPrincipal: '00000000-0000-4000-8000-cdd8c3d071fc' }
        }
      }
    }))

    await expect(load(source)).resolves.toBeUndefined()
    expect($companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]).toBeUndefined()
  })
})

describe('classification and owner controls', () => {
  const stateEvent = {
    type: MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT,
    stateKey: '',
    content: {
      v: 1 as const,
      classification: 'company_private_cos' as const,
      companyId: COMPANY,
      membershipIncarnation: INCARNATION,
      executorId: binding.executorId
    }
  }
  const classified: MatrixRoom = {
    id: ROOM,
    name: 'Chief of Staff',
    membership: 'join',
    encrypted: false,
    roomType: MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
    roomVersion: '11',
    companyPrivateCos: stateEvent.content,
    joinRule: 'invite',
    historyVisibility: 'joined',
    participants: [
      { userId: OWNER_USER, membership: 'join' },
      { userId: binding.agentUserId, membership: 'join' }
    ],
    powerLevels
  }

  it('recognizes only the exact round-5 private-CoS state event', () => {
    expect(matrixCompanyPrivateCosRoomBinding(
      MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
      stateEvent.type,
      stateEvent.stateKey,
      stateEvent.content
    )).toEqual(stateEvent.content)
    expect(matrixCompanyPrivateCosRoomBinding(
      MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
      stateEvent.type,
      'another-key',
      stateEvent.content
    )).toBeUndefined()
    expect(matrixCompanyPrivateCosRoomBinding(
      'io.atum.company_private_cos.v1',
      stateEvent.type,
      stateEvent.stateKey,
      stateEvent.content
    )).toBeUndefined()
  })

  it('keeps an ordinary typed assistant invite in Personal while quarantining marked or platform-bound rooms', () => {
    const ordinary = {
      roomType: MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
      membership: 'invite'
    }

    expect(isCompanyPrivateCosClaim(ordinary)).toBe(false)
    expect(isTeamSpaceRoom(ordinary)).toBe(false)
    expect(isCompanyPrivateCosClaim({ ...ordinary, companyPrivateCosClaim: true })).toBe(true)
    expect(isCompanyPrivateCosClaim({ ...ordinary, companyPrivateCosBound: true })).toBe(true)
  })

  it('never projects the classified room as Personal while leaving an unmarked typed invite alone', () => {
    const roster = projectMatrixRoster({
      rooms: [
        classified,
        {
          id: '!unmarked-lookalike:test',
          name: 'Chief of Staff',
          membership: 'invite',
          encrypted: false,
          roomType: MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE
        },
        { id: '!person:test', name: 'Lan', membership: 'join', encrypted: true }
      ]
    } as MatrixSnapshot)

    expect(roster.rest.map(room => room.id)).toEqual(['!person:test', '!unmarked-lookalike:test'])
    expect(roster.groups.flatMap(group => group.rooms)).toEqual([])
    expect(classified.companyConversation).toBeUndefined()
    expect(classified.companyChannel).toBeUndefined()
  })

  it('opens only the platform-bound owner room and rejects another pair marker', async () => {
    const source = adapter()
    await load(source)
    source.readPrivateCos = vi.fn(async () => ready)
    await load(source)
    const state = $companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]

    expect(companyPrivateCosRoom(state, [classified])?.id).toBe(ROOM)
    expect(companyPrivateCosRoom({ ...state!, availability: 'unavailable' }, [classified])).toBeUndefined()
    expect(companyPrivateCosRoom(state, [{
      ...classified,
      companyPrivateCos: {
        ...classified.companyPrivateCos!,
        membershipIncarnation: '00000000-0000-4000-8000-2049a72dcc1f'
      }
    }])).toBeUndefined()
  })

  it('keeps receipt and Stop owner-derived and rejects a cross-pair response', async () => {
    const negotiated = adapter()
    await load(negotiated)
    negotiated.readPrivateCos = vi.fn(async () => ready)
    await load(negotiated)
    const state = $companyPrivateCos.get()[teamSpaceKey(ACCOUNT, COMPANY)]!

    const receipt = {
      schemaVersion: 1,
      runId: RUN,
      taskId: '00000000-0000-4000-8000-2c4034493252',
      pair,
      executorId: binding.executorId,
      contextEpoch: 1,
      homeGeneration: 1,
      authorityEpoch: 7,
      reservationId: '00000000-0000-4000-8000-e2f979a67a70',
      reservedMicroProtons: 250_000,
      settledMicroProtons: 200_000,
      state: 'stopped',
      verifiedEventId: '$owner-question:atum.example',
      homeCommitId: null,
      outboxTransactionId: null,
      publishedEventId: null,
      sourceLinks: []
    } satisfies MatrixCompanyPrivateCosOwnerReceipt

    const source = adapter({
      readPrivateCosReceipt: vi.fn(async () => receipt),
      stopPrivateCos: vi.fn(async () => receipt)
    })

    await expect(readCompanyPrivateCosReceipt(source, state, RUN)).resolves.toBe(receipt)
    await expect(stopCompanyPrivateCos(source, state, RUN, '00000000-0000-4000-8000-5f2da9800d4b'))
      .resolves.toBe(receipt)
    expect(source.stopPrivateCos).toHaveBeenCalledWith(COMPANY, RUN, {
      schemaVersion: 1,
      requestId: '00000000-0000-4000-8000-5f2da9800d4b'
    })

    source.readPrivateCosReceipt = vi.fn(async () => ({
      ...receipt,
      pair: { ...pair, memberPrincipal: '00000000-0000-4000-8000-cdd8c3d071fc' }
    }))
    await expect(readCompanyPrivateCosReceipt(source, state, RUN))
      .rejects.toThrow('matrix_company_private_cos_pair_mismatch')
  })
})

describe('re-running the first-visit admission when it can now succeed', () => {
  const KEY = teamSpaceKey(ACCOUNT, COMPANY)

  /** The capability is off (the route answers 404, the bridge says missing) until `turnOn()`. */
  function lateCapability() {
    let on = false
    let ensured = false
    const source = adapter({
      readPrivateCosCapability: vi.fn(async () => {
        if (!on) {throw new Error('missing')}

        return capability
      }),
      readPrivateCos: vi.fn(async () => (ensured ? accepted : uncreated)),
      ensurePrivateCos: vi.fn(async () => {
        ensured = true

        return accepted
      })
    })

    return { source, turnOn: () => {on = true} }
  }

  it('ensures once the capability switches on under a running window', async () => {
    const { source, turnOn } = lateCapability()

    await expect(recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { force: true, now: 0 }))
      .resolves.toBeUndefined()
    expect($companyPrivateCosDiscovery.get()[KEY]).toBe('not_available')
    expect(source.ensurePrivateCos).not.toHaveBeenCalled()

    turnOn()
    await expect(recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { now: COMPANY_PRIVATE_COS_RECHECK_MIN_MS }))
      .resolves.toMatchObject({ availability: 'preparing', view: accepted })
    expect(source.ensurePrivateCos).toHaveBeenCalledExactlyOnceWith(COMPANY, {
      schemaVersion: 1,
      requestId: expect.any(String),
      action: 'ensure',
      trigger: 'first_company_visit'
    })
    expect($companyPrivateCosDiscovery.get()[KEY]).toBeUndefined()

    // Ensured: later refreshes read, they never ensure again.
    await recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { force: true })
    expect(source.ensurePrivateCos).toHaveBeenCalledOnce()
  })

  it('waits out a doubling backoff on automatic re-checks; Retry and focus skip it', async () => {
    const { source } = lateCapability()

    await recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { now: 0 })
    expect(source.readPrivateCosCapability).toHaveBeenCalledTimes(1)

    await recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { now: COMPANY_PRIVATE_COS_RECHECK_MIN_MS - 1 })
    expect(source.readPrivateCosCapability).toHaveBeenCalledTimes(1)

    await recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { now: COMPANY_PRIVATE_COS_RECHECK_MIN_MS })
    expect(source.readPrivateCosCapability).toHaveBeenCalledTimes(2)

    // Second miss: the wait doubles.
    const second = COMPANY_PRIVATE_COS_RECHECK_MIN_MS
    await recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { now: second + 2 * second - 1 })
    expect(source.readPrivateCosCapability).toHaveBeenCalledTimes(2)

    await recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { force: true, now: second + 1 })
    expect(source.readPrivateCosCapability).toHaveBeenCalledTimes(3)

    // Never longer than the cap, however many misses.
    for (let miss = 0; miss < 12; miss += 1) {
      await recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { force: true, now: 0 })
    }

    const calls = vi.mocked(source.readPrivateCosCapability).mock.calls.length
    await recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { now: COMPANY_PRIVATE_COS_RECHECK_MAX_MS })
    expect(source.readPrivateCosCapability).toHaveBeenCalledTimes(calls + 1)
  })

  it('shares one admission and one ensure between concurrent callers', async () => {
    let finish!: (view: MatrixCompanyPrivateCosView) => void
    const source = adapter({
      readPrivateCos: vi.fn(async () => uncreated),
      ensurePrivateCos: vi.fn(() => new Promise<MatrixCompanyPrivateCosView>(resolve => {finish = resolve}))
    })

    const first = recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { force: true })
    const second = recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { force: true })
    await vi.waitFor(() => expect(source.ensurePrivateCos).toHaveBeenCalledOnce())

    // The member row's Open lands on the same in-flight ensure instead of fencing it.
    const opened = ensureCompanyPrivateCos(source, ACCOUNT, COMPANY, 'dm_open')
    const third = recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { force: true })
    expect(source.readPrivateCos).toHaveBeenCalledOnce()

    finish(accepted)
    await expect(Promise.all([first, second, opened, third])).resolves.toEqual([
      expect.objectContaining({ view: accepted }),
      expect.objectContaining({ view: accepted }),
      expect.objectContaining({ view: accepted }),
      expect.objectContaining({ view: accepted })
    ])
    expect(source.ensurePrivateCos).toHaveBeenCalledOnce()
  })

  it('retries a failed ensure with the same request id', async () => {
    const source = adapter({
      readPrivateCos: vi.fn(async () => uncreated),
      ensurePrivateCos: vi.fn()
        .mockRejectedValueOnce(new Error('unavailable'))
        .mockResolvedValueOnce(accepted)
    })

    await expect(recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { force: true }))
      .resolves.toMatchObject({ availability: 'unavailable' })
    expect(companyPrivateCosRowStatus($companyPrivateCos.get()[KEY], undefined)).toBe('not_available')

    await expect(recheckCompanyPrivateCos(source, ACCOUNT, COMPANY, undefined, { force: true }))
      .resolves.toMatchObject({ availability: 'preparing' })

    const ids = vi.mocked(source.ensurePrivateCos).mock.calls.map(([, request]) => request.requestId)
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
  })

  it('never replays a request id with another trigger or locale (the platform would refuse it)', async () => {
    const source = adapter({
      readPrivateCos: vi.fn(async () => uncreated),
      ensurePrivateCos: vi.fn()
        .mockRejectedValueOnce(new Error('unavailable'))
        .mockResolvedValueOnce(accepted)
    })

    await load(source, v13Capability)
    await expect(ensureCompanyPrivateCos(source, ACCOUNT, COMPANY, 'first_company_visit', 'vi')).rejects.toThrow()
    await ensureCompanyPrivateCos(source, ACCOUNT, COMPANY, 'first_company_visit', 'en')

    const ids = vi.mocked(source.ensurePrivateCos).mock.calls.map(([, request]) => request.requestId)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('without a desktop adapter says not available, and an account clear forgets it', async () => {
    await recheckCompanyPrivateCos(undefined, ACCOUNT, COMPANY)
    expect($companyPrivateCosDiscovery.get()[KEY]).toBe('not_available')

    clearCompanyPrivateCos(ACCOUNT)
    expect($companyPrivateCosDiscovery.get()[KEY]).toBeUndefined()
  })

  it('maps every state to one honest row status', () => {
    const served = (over: Partial<NonNullable<ReturnType<typeof $companyPrivateCos.get>[string]>>) => ({
      served: true as const,
      profile: capability.profile,
      capability,
      availability: 'preparing' as const,
      view: accepted,
      loading: false,
      ...over
    })

    expect(companyPrivateCosRowStatus(undefined, undefined)).toBe('setting_up')
    expect(companyPrivateCosRowStatus(undefined, 'checking')).toBe('setting_up')
    expect(companyPrivateCosRowStatus(undefined, 'not_available')).toBe('not_available')
    expect(companyPrivateCosRowStatus(served({}), undefined)).toBe('setting_up')
    expect(companyPrivateCosRowStatus(served({ loading: true, availability: 'ready', view: ready }), undefined))
      .toBe('setting_up')
    expect(companyPrivateCosRowStatus(served({ availability: 'ready', view: ready }), undefined)).toBe('ready')
    expect(companyPrivateCosRowStatus(served({ availability: 'paused' }), undefined)).toBe('paused')
    expect(companyPrivateCosRowStatus(served({ availability: 'unavailable' }), undefined)).toBe('not_available')
  })
})
