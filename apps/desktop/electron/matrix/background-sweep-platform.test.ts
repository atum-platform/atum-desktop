import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  parseAgentSweepClaimResponseV2,
  parseAgentSweepDispatchResponseV2,
  parseAgentSweepReleaseResponseV2,
  parseAgentSweepSettlementResponseV2
} from '../../../../packages/device-protocol/agent-sweep-v2'

import { AGENT_SWEEP_PROFILE, AGENT_SWEEP_PROFILE_V2, AGENT_SWEEP_PROFILE_V11 } from './background-sweep'
import {
  parseBackgroundSweepClaim,
  parseBackgroundSweepDispatch,
  parseBackgroundSweepRelease,
  parseBackgroundSweepSettlement,
  ShellBackgroundSweepPlatform
} from './background-sweep-platform'

const ASSISTANT = '00000000-0000-4000-8000-288c0dd127cf'
const OCCURRENCE = '00000000-0000-4000-8000-149a1ef8d82f'
const sweepFixture = (name: string): unknown => JSON.parse(readFileSync(new URL(
  `../../../../packages/device-protocol/fixtures/agent-sweep-v2/fixtures/${name}`,
  import.meta.url
), 'utf8'))
const claimV2 = parseAgentSweepClaimResponseV2(sweepFixture('claim.normal.json'))
const dispatchV2 = parseAgentSweepDispatchResponseV2(sweepFixture('dispatch.normal.native.json'))
const releaseV2 = parseAgentSweepReleaseResponseV2(sweepFixture('release.released.json'))
const settlementV2 = parseAgentSweepSettlementResponseV2(sweepFixture('settlement.normal-silent.json'))
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

const deferred = { profile: AGENT_SWEEP_PROFILE, decision: 'defer', reason: 'not_due', notBefore: 1_793_017_200_000 }
const dispatched = {
  profile: AGENT_SWEEP_PROFILE,
  decision: 'dispatched',
  occurrenceId: OCCURRENCE,
  expiresAt: 1_793_017_320_000,
  settingsRevision: 1,
  authorization: {
    kind: 'native',
    authorizationId: '00000000-0000-4000-8000-463bfa64f08a',
    expiresAt: 1_793_017_320_000,
    destination: { destination: 'mac:raymond', source: 'atum', model: 'nguyet-thuc', effort: 'medium' },
    protection: { kind: 'standard' },
    attribution: { id: '00000000-0000-4000-8000-5bb08005840f', lane: 'atum_managed' },
    limits: {
      activeComputeSeconds: 120,
      calls: 1,
      inputTokens: 8_000,
      outputTokens: 1_000,
      maxModelMicroProtons: 114_210_000
    }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('the signed native background sweep transport', () => {
  it('rejects open or mismatched response shapes', () => {
    expect(parseBackgroundSweepClaim(deferred)).toEqual(deferred)
    expect(parseBackgroundSweepClaim({ ...deferred, owner: 'forged' })).toBeNull()
    expect(parseBackgroundSweepDispatch(dispatched)).toEqual(dispatched)
    expect(parseBackgroundSweepDispatch({ ...dispatched, expiresAt: 1 })).toBeNull()
    expect(
      parseBackgroundSweepSettlement({
        profile: AGENT_SWEEP_PROFILE,
        state: 'settled',
        occurrenceId: OCCURRENCE,
        outcome: 'answered',
        disposition: 'silent',
        receiptId: '00000000-0000-4000-8000-93c455773d35',
        settingsRevision: 1,
        nextDueAt: 1_793_024_400_000,
        publication: { state: 'none' }
      })
    ).not.toBeNull()
  })

  it('posts only the signed envelope on the native executor route', async () => {
    let sent: { url?: string; init?: RequestInit } = {}
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent = { url: String(url), init }
      return json(deferred)
    })
    vi.stubGlobal('fetch', fetch)
    const signClaim = vi.fn(async request => ({ meta: { signed: true }, home: { current: true }, request }))
    const platform = new ShellBackgroundSweepPlatform({
      request: async send => send('secret', 'https://platform.test/api/matrix/v1'),
      signClaim,
      signActive: async () => ({}),
      fetch
    })
    const request = { profile: AGENT_SWEEP_PROFILE, operation: 'claim' }

    await expect(platform.claim(ASSISTANT, request, new AbortController().signal)).resolves.toEqual(deferred)
    expect(sent.url).toBe(`https://platform.test/api/matrix/v1/agents/${ASSISTANT}/background-sweep/executor`)
    expect(sent.init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer secret',
        'Atum-Agent-Home-Wire': '2.1'
      }),
      credentials: 'omit',
      redirect: 'error'
    })
    expect(JSON.parse(String(sent.init?.body))).toEqual({
      meta: { signed: true },
      home: { current: true },
      request
    })
  })

  it('never downgrades a claim after a generic invalid response', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'matrix_400', details: { reason: 'invalid' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }))
    const platform = new ShellBackgroundSweepPlatform({
      request: async send => send('secret', 'https://platform.test'),
      signClaim: async request => ({ request }),
      signActive: async () => ({}),
      fetch
    })

    const request = {
      profile: AGENT_SWEEP_PROFILE_V11, operation: 'claim', requestId: ASSISTANT, leaseToken: OCCURRENCE, activity: {}
    }
    await expect(platform.claim(ASSISTANT, request, new AbortController().signal))
      .rejects.toThrow('matrix_background_sweep_unavailable')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('negotiates /2 only from a successful private source projection', async () => {
    const access = { profile: 'atum.agent-sources/1', snapshotRevision: 1, snapshotDigest: 'a'.repeat(64),
      generatedAt: 1_793_017_200_000, sources: [] }
    const requests: Array<{ url: string; method: string }> = []
    const platform = new ShellBackgroundSweepPlatform({
      request: async send => send('secret', 'https://platform.test/api/matrix/v1'),
      signClaim: async request => ({ request }),
      signActive: async request => ({ request }),
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: String(init?.method) })
        return json(access)
      }
    })

    await expect(platform.sources(ASSISTANT, new AbortController().signal)).resolves.toEqual(access)
    expect(requests).toEqual([{ url: `https://platform.test/api/matrix/v1/agents/${ASSISTANT}/sources`, method: 'GET' }])
  })

  it('uses legacy only for an explicitly absent source route, never timeout, 401 or malformed data', async () => {
    const build = (fetch: typeof globalThis.fetch) => new ShellBackgroundSweepPlatform({
      request: async send => send('secret', 'https://platform.test'),
      signClaim: async request => ({ request }), signActive: async request => ({ request }), fetch
    })
    await expect(build(async () => new Response('missing', { status: 404 }))
      .sources(ASSISTANT, new AbortController().signal)).resolves.toBeNull()
    await expect(build(async () => json({ error: 'denied' }, 401))
      .sources(ASSISTANT, new AbortController().signal)).rejects.toThrow('matrix_background_sweep_denied')
    await expect(build(async () => json({ profile: 'atum.agent-sources/1' }))
      .sources(ASSISTANT, new AbortController().signal)).rejects.toThrow('matrix_background_sweep_unavailable')
    await expect(build(async () => { throw new Error('timeout') })
      .sources(ASSISTANT, new AbortController().signal)).rejects.toThrow('matrix_background_sweep_unavailable')
  })

  it('parses the pinned /2 native lifecycle without translating its profile', () => {
    expect(parseBackgroundSweepClaim(claimV2)).toEqual(claimV2)
    expect(parseBackgroundSweepDispatch(dispatchV2)).toEqual(dispatchV2)
    expect(parseBackgroundSweepSettlement(settlementV2)).toEqual(settlementV2)
    expect(parseBackgroundSweepRelease(releaseV2)).toEqual(releaseV2)
    expect(claimV2.profile).toBe(AGENT_SWEEP_PROFILE_V2)
  })

  it('parses the 1.1 warm-up claim, dispatch and settlement shapes', async () => {
    const warmupClaim = {
      profile: AGENT_SWEEP_PROFILE_V11,
      decision: 'claimed',
      occurrenceId: OCCURRENCE,
      occurrenceAt: 1_793_017_200_000,
      effectiveDueAt: 1_793_017_200_000,
      expiresAt: 1_793_017_320_000,
      settingsRevision: 1,
      ownerTimeZone: 'Asia/Ho_Chi_Minh',
      policy: { version: 2, sourceIntervalMs: 7_200_000, effectiveSourceIntervalMs: 3_600_000,
        normalWindow: { startHour: 8, endHour: 21 }, warmupReleaseLimit: 2, warmupReleaseBackoffMs: 120_000 },
      sourceWatermarks: { googleMail: null, googleCalendar: null, atumChats: null, conversation: null, memory: null },
      occurrenceKind: 'warmup_nudge',
      warmupNudgeIndex: 2
    }
    expect(parseBackgroundSweepClaim(warmupClaim)).toEqual(warmupClaim)
    expect(parseBackgroundSweepClaim({ ...warmupClaim, effectiveDueAt: 1 })).toBeNull()
    expect(parseBackgroundSweepClaim({ ...warmupClaim, warmupNudgeIndex: 5 })).toBeNull()

    const warmupDispatch = {
      ...dispatched,
      profile: AGENT_SWEEP_PROFILE_V11,
      occurrenceKind: 'warmup_nudge',
      warmupNudgeIndex: 2,
      authorization: {
        ...dispatched.authorization,
        limits: { ...dispatched.authorization.limits, activeComputeSeconds: 1_800 }
      }
    }
    expect(parseBackgroundSweepDispatch(warmupDispatch)).toEqual(warmupDispatch)
    expect(parseBackgroundSweepDispatch({ ...warmupDispatch,
      authorization: { ...warmupDispatch.authorization,
        limits: { ...warmupDispatch.authorization.limits, activeComputeSeconds: 120 } } })).toBeNull()

    const settlement = {
      profile: AGENT_SWEEP_PROFILE_V11,
      state: 'settled',
      occurrenceId: OCCURRENCE,
      occurrenceKind: 'warmup_nudge',
      warmupNudgeIndex: 2,
      outcome: 'answered',
      disposition: 'offer',
      receiptId: '00000000-0000-4000-8000-93c455773d35',
      settingsRevision: 1,
      nextDueAt: 1_793_024_400_000,
      publication: { state: 'admitted', outboxId: '00000000-0000-4000-8000-fbd62e9c2632' }
    }
    expect(parseBackgroundSweepSettlement(settlement)).toEqual(settlement)
    const { warmupNudgeIndex: _index, ...withoutIndex } = settlement
    expect(parseBackgroundSweepSettlement(withoutIndex)).toBeNull()

    const released = {
      profile: AGENT_SWEEP_PROFILE_V11,
      decision: 'released',
      occurrenceId: OCCURRENCE,
      occurrenceKind: 'warmup_nudge',
      warmupNudgeIndex: 2,
      releaseCount: 1,
      retryAt: 1_793_017_920_000
    }
    expect(parseBackgroundSweepRelease(released)).toEqual(released)
    expect(parseBackgroundSweepRelease({ ...released, releaseCount: 3 })).toBeNull()
    expect(parseBackgroundSweepRelease({ ...released, decision: 'retired' })).toBeNull()

    const retired = {
      profile: AGENT_SWEEP_PROFILE_V11,
      decision: 'retired',
      occurrenceId: OCCURRENCE,
      occurrenceKind: 'warmup_nudge',
      warmupNudgeIndex: 2,
      releaseCount: 2,
      outcome: 'uncertain',
      disposition: 'none',
      receiptId: '00000000-0000-4000-8000-106e3b7099bf',
      settingsRevision: 1,
      nextDueAt: 1_793_019_600_000,
      publication: { state: 'none' }
    }
    expect(parseBackgroundSweepRelease(retired)).toEqual(retired)
    expect(parseBackgroundSweepRelease({ ...retired, publication: { state: 'admitted' } })).toBeNull()
  })

  it('binds active signatures to the occurrence and parses protected routing', async () => {
    const signActive = vi.fn(async (request, occurrenceId) => ({ occurrenceId, request, signature: 'sealed' }))
    const platform = new ShellBackgroundSweepPlatform({
      request: async send => send('secret', 'https://platform.test'),
      signClaim: async () => ({}),
      signActive,
      fetch: async () =>
        json({
          ...dispatched,
          authorization: {
            ...dispatched.authorization,
            protection: { kind: 'google_protected', googlePolicy: 'limited_use_v1', latchState: 'latched' }
          }
        })
    })

    const result = await platform.dispatch(
      ASSISTANT,
      OCCURRENCE,
      { operation: 'dispatch' },
      new AbortController().signal
    )
    expect(result.decision).toBe('dispatched')
    expect(
      result.decision === 'dispatched' && result.authorization.kind === 'native' && result.authorization.protection.kind
    ).toBe('google_protected')
    expect(signActive).toHaveBeenCalledWith({ operation: 'dispatch' }, OCCURRENCE)
  })

  it('signs a release with the home-lease envelope and never downgrades the profile', async () => {
    const bodies: Array<Record<string, any>> = []
    const signClaim = vi.fn(async () => ({}))
    const signActive = vi.fn(async () => ({}))
    const signRelease = vi.fn(async (request: unknown) => ({ meta: { signed: true }, home: { leaseId: OCCURRENCE }, request }))
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return json({
        profile: AGENT_SWEEP_PROFILE_V11,
        decision: 'released',
        occurrenceId: OCCURRENCE,
        occurrenceKind: 'warmup_nudge',
        warmupNudgeIndex: 2,
        releaseCount: 1,
        retryAt: 1_793_017_920_000
      })
    })
    const platform = new ShellBackgroundSweepPlatform({
      request: async send => send('secret', 'https://platform.test'),
      signClaim,
      signActive,
      signRelease,
      fetch
    })
    const request = { profile: AGENT_SWEEP_PROFILE_V11, operation: 'release', occurrenceId: OCCURRENCE,
      leaseToken: OCCURRENCE, reason: 'invalid_result' }

    await expect(platform.release(ASSISTANT, OCCURRENCE, request, new AbortController().signal))
      .resolves.toMatchObject({ decision: 'released', releaseCount: 1 })

    expect(signRelease).toHaveBeenCalledWith(request)
    expect(signClaim).not.toHaveBeenCalled()
    expect(signActive).not.toHaveBeenCalled()
    expect(bodies).toHaveLength(1)
  })

  it('reports an absent executor route as unsupported', async () => {
    const platform = new ShellBackgroundSweepPlatform({
      request: async send => send('secret', 'https://platform.test'),
      signClaim: async request => ({ request }),
      signActive: async request => ({ request }),
      fetch: async () => new Response('missing', { status: 404, headers: { 'Content-Type': 'text/html' } })
    })

    await expect(platform.claim(ASSISTANT, {}, new AbortController().signal)).rejects.toThrow(
      'matrix_background_sweep_unsupported'
    )
  })
})

describe('the claimed sweep contract', () => {
  it('requires the policy source interval the Mac needs for its context identity', () => {
    const claimed = {
      profile: AGENT_SWEEP_PROFILE,
      decision: 'claimed',
      occurrenceId: OCCURRENCE,
      occurrenceAt: 1_793_017_200_000,
      expiresAt: 1_793_017_320_000,
      settingsRevision: 1,
      ownerTimeZone: 'Asia/Ho_Chi_Minh',
      policy: { sourceIntervalMs: 7_200_000 },
      sourceWatermarks: {
        googleMail: null,
        googleCalendar: null,
        atumChats: null,
        conversation: null,
        memory: null
      }
    }

    expect(parseBackgroundSweepClaim(claimed)).toEqual(claimed)
    expect(parseBackgroundSweepClaim({ ...claimed, policy: { sourceIntervalMs: 0 } })).toBeNull()
    expect(parseBackgroundSweepClaim({ ...claimed, policy: {} })).toBeNull()
  })
})
