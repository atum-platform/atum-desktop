import { afterEach, describe, expect, it, vi } from 'vitest'

import { MatrixChatGptRelay, requestMatrixChatGptRelay } from './chatgpt-relay-client'

const resource = 'https://shell.test/api/matrix/v1'

afterEach(() => vi.unstubAllGlobals())

it.each(['enable', 'disable'] as const)('%s sends the JSON media type admitted by Shell', async action => {
  const body = { profile: 'atum.chatgpt-relay/1', requestId: 'synthetic' }

  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const request = new Request(url, init)
    expect(request.method).toBe('POST')
    expect(request.headers.get('content-type')).toBe('application/json')
    expect(request.headers.has('cookie')).toBe(false)
    expect(await request.json()).toEqual(body)

    return Response.json({ state: 'disabled' })
  })

  vi.stubGlobal('fetch', fetch)

  const answer = await requestMatrixChatGptRelay(resource, 'synthetic', action, AbortSignal.timeout(1000), body)
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][0]).toBe(`${resource}/chatgpt-relay/${action}`)
  expect(answer.status).toBe(200)
})

it('lets the account refresh an expired domain bearer', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 401 }))
  )
  await expect(
    requestMatrixChatGptRelay(resource, 'synthetic', 'enable', AbortSignal.timeout(1000), {})
  ).rejects.toThrow('matrix_s1_authentication')
})


it('accepts cloud custody after restart and refuses local relay enablement', async () => {
  const relay = new MatrixChatGptRelay({ scope: () => ({ accountKey: 'one', generation: 1 }),
    changed: () => {}, call: async () => ({ status: 200, value: {
      profile: 'atum.chatgpt-relay/1', revision: 2, state: 'carried', models: [{ id: 'gpt-6-sol',
        displayName: 'GPT-6 Sol', efforts: ['medium'], defaultEffort: 'medium',
        contextBudget: 128_000, outputBudget: 16_384 }]
    } }) })
  expect((await relay.refresh())?.models.map(model => model.id)).toEqual(['gpt-6-sol'])
  expect(relay.view()?.state).toBe('carried')
  expect(await relay.enable('synthetic-device', [])).toBe(false)
})

it('retains known models at carry completion and replaces them with the cloud list', async () => {
  const descriptor = (id: string) => ({ id, displayName: id, efforts: ['medium'], defaultEffort: 'medium',
    contextBudget: 128_000, outputBudget: 16_384 })
  let state = 'enabled'
  const relay = new MatrixChatGptRelay({ scope: () => ({ accountKey: 'one', generation: 1 }),
    changed: () => {}, call: async () => ({ status: 200, value: {
      profile: 'atum.chatgpt-relay/1', revision: 2, state,
      ...(state === 'enabled' ? { deviceServiceId: '00000000-0000-4000-8000-bd7662a5eeb4', selectedAt: 1 } : {}),
      models: [descriptor(state === 'enabled' ? 'gpt-5.6-luna' : 'gpt-6-sol')]
    } }) })
  await relay.refresh()
  relay.markCarried()
  expect(relay.view()?.models.map(model => model.id)).toEqual(['gpt-5.6-luna'])
  state = 'carried'
  expect((await relay.refresh())?.models.map(model => model.id)).toEqual(['gpt-6-sol'])
})

describe('relay identity across ChatGPT sign-ins', () => {
  const DEVICE = '00000000-0000-4000-8000-bd7662a5eeb4'
  const OTHER = '00000000-0000-4000-8000-0000000000aa'
  const model = { id: 'gpt-6-sol', displayName: 'GPT-6 Sol', efforts: ['medium' as const], defaultEffort: 'medium' as const,
    contextBudget: 128_000, outputBudget: 16_384 }
  const enabled = (revision: number, device = DEVICE) => ({ status: 200, value: {
    profile: 'atum.chatgpt-relay/1', revision, state: 'enabled', deviceServiceId: device, selectedAt: 1, models: [model] } })
  const disabled = (revision: number) => ({ status: 200, value: {
    profile: 'atum.chatgpt-relay/1', revision, state: 'disabled', models: [] } })

  function relayWith(answers: Array<{ status: number; value: unknown }>) {
    const calls: string[] = []
    const relay = new MatrixChatGptRelay({ scope: () => ({ accountKey: 'one', generation: 1 }), changed: () => {},
      call: async action => {
        calls.push(action)
        return answers.shift() ?? { status: 503, value: null }
      } })

    return { calls, relay }
  }

  it('republishes the same device without ending the session (start-up, model refresh)', async () => {
    const { calls, relay } = relayWith([enabled(7), enabled(8)])

    expect(await relay.enable(DEVICE, [model])).toBe(true)
    expect(await relay.enable(DEVICE, [model])).toBe(true)
    expect(calls).toEqual(['enable', 'enable'])
  })

  it('after a new sign-in reads the relay, disables the old session, then enables a new one', async () => {
    const { calls, relay } = relayWith([enabled(7, OTHER), disabled(8), enabled(9)])

    expect(await relay.enable(DEVICE, [model], { fresh: true })).toBe(true)
    expect(calls).toEqual(['status', 'disable', 'enable'])
    expect(relay.view()).toMatchObject({ state: 'enabled', deviceServiceId: DEVICE, revision: 9 })
  })

  it('never publishes a new account under the old session when disable fails or the read fails', async () => {
    const failedDisable = relayWith([enabled(7), { status: 503, value: null }])
    expect(await failedDisable.relay.enable(DEVICE, [model], { fresh: true })).toBe(false)
    expect(failedDisable.calls).toEqual(['status', 'disable'])

    const failedRead = relayWith([{ status: 503, value: null }])
    expect(await failedRead.relay.enable(DEVICE, [model], { fresh: true })).toBe(false)
    expect(failedRead.calls).toEqual(['status'])
  })

  it('a fresh session over an already disabled relay only enables', async () => {
    const { calls, relay } = relayWith([disabled(3), enabled(4)])

    expect(await relay.enable(DEVICE, [model], { fresh: true })).toBe(true)
    expect(calls).toEqual(['status', 'enable'])
  })
})
