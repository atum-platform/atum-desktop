import { expect, it, vi } from 'vitest'

import { GroupRelevanceRouter } from './routing'

const scope = { accountKey: 'owner', generation: 1 }

const input = {
  message: { text: 'Can we afford the launch?', senderId: '@owner:test' },
  agents: [{ userId: '@finance:test', name: 'Finance', role: 'Budget and financial planning' }],
  recent: [{ senderId: '@owner:test', text: 'We plan to launch in November.' }]
}

const answer = (score: number) => new Response(JSON.stringify({ answers: { agent_0: { type: 'noul', noul: score } } }))

function fixture() {
  let owner: typeof scope | null = scope
  const request = vi.fn<typeof fetch>(async () => answer(0.9))
  const bearer = vi.fn(async (_refresh: boolean) => 'domain-bearer')

  const router = new GroupRelevanceRouter({
    gateway: 'https://gateway.test',
    scope: () => owner,
    bearer,
    fetch: request
  })

  const load = vi.fn(async () => input)
  const target = { roomId: '!room:test', eventId: '$one', candidateIds: ['@finance:test'], load }

  return {
    router,
    target,
    request,
    load,
    bearer,
    change: (next: typeof owner) => {
      owner = next
    }
  }
}

it('coalesces one canonical bounded request for concurrent local bots', async () => {
  const f = fixture()
  const [one, two] = await Promise.all([f.router.decide(f.target), f.router.decide(f.target)])
  expect(one).toEqual(['@finance:test'])
  expect(two).toBe(one)
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.request).toHaveBeenCalledTimes(1)
  const [url, options] = f.request.mock.calls[0]
  expect(url).toBe('https://gateway.test/v1/systemone')
  expect(options?.headers).toEqual({ Authorization: 'Bearer domain-bearer', 'Content-Type': 'application/json' })
  expect(JSON.parse(options!.body as string)).toEqual(
    expect.objectContaining({
      roomId: '!room:test',
      eventId: '$one',
      candidateIds: ['@finance:test'],
      version: 1,
      questions: { agent_0: expect.objectContaining({ type: 'noul', instructions: expect.any(String) }) }
    })
  )
  expect(JSON.parse(options!.body as string)).not.toHaveProperty('model')
})

it('returns silence only for a valid negative model decision', async () => {
  const f = fixture()
  f.request.mockResolvedValueOnce(answer(0.2))
  expect(await f.router.decide(f.target)).toEqual([])
})

it('retains an invalid response rather than rerouting the same event', async () => {
  const f = fixture()
  f.request.mockResolvedValueOnce(new Response('{"answers":{}}'))
  await expect(f.router.decide(f.target)).rejects.toThrow('matrix_group_routing_invalid')
  await expect(f.router.decide(f.target)).rejects.toThrow('matrix_group_routing_invalid')
  expect(f.request).toHaveBeenCalledTimes(1)
})

it('lets a later offer recover the canonical result after a lost response', async () => {
  const f = fixture()
  f.request.mockRejectedValueOnce(new Error('connection lost after send'))
  await expect(f.router.decide(f.target)).rejects.toThrow('matrix_group_routing_unavailable')
  expect(await f.router.decide(f.target)).toEqual(['@finance:test'])
  expect(f.request.mock.calls[0][1]?.body).toBe(f.request.mock.calls[1][1]?.body)
})

it('refuses a candidate roster changed while loading context', async () => {
  const f = fixture()
  await expect(f.router.decide({ ...f.target, candidateIds: ['@other:test'] })).rejects.toThrow(
    'matrix_group_routing_changed'
  )
  expect(f.request).not.toHaveBeenCalled()
})

it('does not send data after the account generation changes', async () => {
  const f = fixture()
  f.load.mockImplementationOnce(async () => {
    f.change({ ...scope, generation: 2 })

    return input
  })
  await expect(f.router.decide(f.target)).rejects.toThrow('matrix_group_routing_account_changed')
  expect(f.request).not.toHaveBeenCalled()
})

it('rejects an old-account response and gives a new account its own request', async () => {
  const f = fixture()
  f.request.mockImplementationOnce(async () => {
    f.change({ ...scope, generation: 2 })

    return answer(0.9)
  })
  await expect(f.router.decide(f.target)).rejects.toThrow('matrix_group_routing_account_changed')
  expect(await f.router.decide(f.target)).toEqual(['@finance:test'])
  expect(f.request).toHaveBeenCalledTimes(2)
})

it('refreshes an expired domain bearer once without changing the request', async () => {
  const f = fixture()
  f.request.mockResolvedValueOnce(new Response(null, { status: 401 }))
  expect(await f.router.decide(f.target)).toEqual(['@finance:test'])
  expect(f.bearer.mock.calls).toEqual([[false], [true]])
  expect(f.request.mock.calls[0][1]?.body).toBe(f.request.mock.calls[1][1]?.body)
})

it('surfaces balance and network failures as failures, never silence', async () => {
  const f = fixture()
  f.request.mockResolvedValueOnce(new Response(null, { status: 402 }))
  await expect(f.router.decide(f.target)).rejects.toThrow('matrix_group_routing_out_of_protons')
  f.request.mockRejectedValueOnce(new Error('offline'))
  await expect(f.router.decide({ ...f.target, eventId: '$two' })).rejects.toThrow('matrix_group_routing_unavailable')
  f.load.mockRejectedValueOnce(new Error('matrix_context_timeout'))
  await expect(f.router.decide({ ...f.target, eventId: '$three' })).rejects.toThrow('matrix_group_routing_unavailable')
})

it('preserves an owner correction as cancellation instead of reporting a routing failure', async () => {
  const f = fixture()
  const abort = new AbortController()
  const corrected = new Error('matrix_group_corrected')
  f.load.mockImplementationOnce(async () => {
    abort.abort(corrected)
    throw corrected
  })

  await expect(f.router.decide({ ...f.target, signal: abort.signal })).rejects.toBe(corrected)
})

it('keeps a multibyte request inside the gateway byte limit', async () => {
  const f = fixture()
  f.load.mockResolvedValueOnce({
    ...input,
    message: { ...input.message, text: '🧭'.repeat(20_000) },
    recent: Array.from({ length: 20 }, (_, index) => ({
      senderId: `@bot-${index}:test`,
      text: 'Bối cảnh 📚'.repeat(500)
    }))
  })

  await f.router.decide(f.target)
  const sent = f.request.mock.calls[0][1]?.body as string
  expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(65_536)
  expect(Buffer.byteLength(JSON.stringify(JSON.parse(sent).state))).toBeLessThanOrEqual(48 * 1024)
})
