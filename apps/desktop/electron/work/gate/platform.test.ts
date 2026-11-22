import { describe, expect, it } from 'vitest'

import { createDeviceServicePlatform, createWorkConsentClient } from './platform'
import { ACCOUNT, DEVICE, LUNA, NOVA, REQ_1 } from './test-support'

// The device-services HTTP client: the settlement operation's wire shape, and what counts as an acknowledgement.

const report = {
  agentPrincipal: LUNA,
  requestId: REQ_1,
  routeEpochAtAdmit: 3,
  agentGenerationAtAdmit: 2,
  scope: 'agent' as const,
  outcome: 'stopped' as const,
  revocationId: 7,
  settledAt: 1_795_000_000_000
}

const input = { deviceServiceId: DEVICE, accountId: ACCOUNT, routeEpoch: 4, reports: [report] }
const two = { ...input, reports: [report, { ...report, requestId: 'AAAAAAAAAAAAAAAAAAAAA2' }] }

function client(answer: (body: Record<string, unknown>) => { status: number; body: unknown }) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []

  const fetcher = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>

    calls.push({ url, headers: init.headers as Record<string, string>, body })
    const reply = answer(body)

    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }) as unknown as typeof fetch

  const platform = createDeviceServicePlatform({ endpoint: 'https://api.test/api/matrix/v1/device-services', bearer: async () => 'owner-bearer', fetch: fetcher })

  return { calls, platform }
}

describe('reportSettlements', () => {
  it('posts work_mac_settlements to the device-services endpoint as the owner, with the Mac, account, epoch and reports', async () => {
    const c = client(() => ({ status: 200, body: { deviceServiceId: DEVICE, accepted: 1, ignored: 0 } }))

    await expect(c.platform.reportSettlements?.(input)).resolves.toBeUndefined()
    expect(c.calls).toHaveLength(1)
    expect(c.calls[0]?.url).toBe('https://api.test/api/matrix/v1/device-services')
    expect(c.calls[0]?.headers.authorization).toBe('Bearer owner-bearer')
    expect(c.calls[0]?.body).toEqual({ operation: 'work_mac_settlements', ...input })
  })

  it('an ignored count is still an acknowledgement (the platform never named that agent to this Mac)', async () => {
    const c = client(() => ({ status: 200, body: { deviceServiceId: DEVICE, accepted: 0, ignored: 1 } }))

    await expect(c.platform.reportSettlements?.(input)).resolves.toBeUndefined()
  })

  it('a batch of two is acknowledged only when accepted plus ignored is two', async () => {
    const whole = client(() => ({ status: 200, body: { deviceServiceId: DEVICE, accepted: 1, ignored: 1 } }))
    await expect(whole.platform.reportSettlements?.(two)).resolves.toBeUndefined()

    const partial = client(() => ({ status: 200, body: { deviceServiceId: DEVICE, accepted: 1, ignored: 0 } }))
    await expect(partial.platform.reportSettlements?.(two)).rejects.toThrow()
  })

  it.each([
    ['a reply about another Mac', { deviceServiceId: NOVA, accepted: 1, ignored: 0 }],
    ['a reply that counts more than was sent', { deviceServiceId: DEVICE, accepted: 1, ignored: 1 }],
    ['a reply that does not account for every report (fewer counted than sent)', { deviceServiceId: DEVICE, accepted: 0, ignored: 0 }],
    ['an empty object', {}],
    ['an HTML page a proxy answered 200 with', '<html>sign in</html>'],
    ['a reply with an extra field', { deviceServiceId: DEVICE, accepted: 1, ignored: 0, note: 'x' }]
  ])('%s is not an acknowledgement: the queue must be kept', async (_name, body) => {
    const c = client(() => ({ status: 200, body }))

    await expect(c.platform.reportSettlements?.(input)).rejects.toThrow()
  })

  it.each([400, 403, 404, 409, 429, 500, 503])('a %s is an error that carries its status and nothing else', async status => {
    const c = client(() => ({ status, body: { state: 'secret-looking-detail' } }))
    const error = await c.platform.reportSettlements?.(input).catch((caught: unknown) => caught)

    expect((error as { status?: number }).status).toBe(status)
    expect(String((error as Error).message)).toBe(`device_services_${status}`)
  })
})

describe('the owner\'s consent client (gate 4b-2)', () => {
  const record = { provider: 'codex', state: 'on', agents: [LUNA], devices: [DEVICE], alsoWhenScheduled: false, revision: 2, grantedAt: 1_795_000_000_000 }

  function consentClient(reply: unknown, status = 200) {
    const calls: Record<string, unknown>[] = []
    const fetcher = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>)

      return new Response(JSON.stringify(reply), { status })
    }) as unknown as typeof fetch

    return { calls, consent: createWorkConsentClient({ endpoint: 'https://api.test/api/matrix/v1/device-services', bearer: async () => 'owner-bearer', fetch: fetcher }) }
  }

  it('sends work_consent_set with exactly what the owner named, and returns the platform\'s record', async () => {
    const { calls, consent } = consentClient(record)

    expect(await consent.set({ agents: [LUNA, NOVA], devices: [DEVICE], alsoWhenScheduled: true })).toEqual(record)
    expect(calls).toEqual([{ operation: 'work_consent_set', provider: 'codex', agents: [LUNA, NOVA], devices: [DEVICE], alsoWhenScheduled: true }])
  })

  it('revokes with the provider only, and reads the state', async () => {
    const off = { ...record, state: 'off', agents: [], devices: [], revision: 3, revokedAt: 1_795_000_000_500 }
    const revoke = consentClient(off)
    expect(await revoke.consent.revoke()).toEqual(off)
    expect(revoke.calls).toEqual([{ operation: 'work_consent_revoke', provider: 'codex' }])

    const read = consentClient({ issuedAt: 1, consent: off, facts: [{ deviceServiceId: DEVICE, provider: 'codex', status: 'stale' }] })
    expect((await read.consent.read()).facts).toHaveLength(1)
    expect(read.calls).toEqual([{ operation: 'work_subscription_read' }])
  })

  it('never takes a reply that is not the contract\'s record (a login field, another provider, a refusal)', async () => {
    await expect(consentClient({ ...record, email: 'x' }).consent.set({ agents: [LUNA], devices: [DEVICE], alsoWhenScheduled: false })).rejects.toThrow(
      'device_services_bad_reply'
    )
    await expect(consentClient({ ...record, provider: 'claude' }).consent.revoke()).rejects.toThrow('device_services_bad_reply')
    await expect(consentClient({ code: 'not_eligible' }, 403).consent.revoke()).rejects.toThrow('device_services_403')
  })
})
