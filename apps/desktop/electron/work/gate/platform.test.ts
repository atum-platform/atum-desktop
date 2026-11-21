import { describe, expect, it } from 'vitest'

import { createDeviceServicePlatform } from './platform'
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
