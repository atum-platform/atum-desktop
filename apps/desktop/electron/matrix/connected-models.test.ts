import { describe, expect, it, vi } from 'vitest'

import {
  MATRIX_CONNECTED_MODEL_ERRORS,
  MATRIX_MODEL_ROUTE_LIST_MAX,
  type MatrixConnectedModel,
  matrixModelRouteId,
  parseMatrixModelRouteId
} from '../../shared/matrix-models'

import {
  listMatrixModelCatalog,
  type MatrixConnectedModelsAgent,
  parseMatrixConnectedModelRequest,
  selectMatrixModelRoute
} from './connected-models'
import type { MatrixHermesConnection } from './hermes-runtime'
import { MatrixPagesManagementTransport } from './pages-management-transport'
import { MatrixHermesTurnLock } from './turn-lock'

const CHATGPT: MatrixConnectedModel = { provider: 'openai-codex', model: 'gpt-5.6-luna' }
const CHATGPT_ROUTE = matrixModelRouteId('openai-codex', 'gpt-5.6-luna')
const OPENROUTER_ROUTE = matrixModelRouteId('openrouter', 'other/model')

/** A fake agent Hermes behind the real management transport and the real Connections adapter. */
function agent(
  options: {
    connected?: MatrixConnectedModel
    models?: string[]
    ready?: boolean
    expensive?: string
    busy?: boolean
    current?: string
    failing?: boolean
    providers?: Array<Record<string, unknown>>
  } = {}
) {
  const lock = new MatrixHermesTurnLock()

  const info = {
    provider: 'openai-codex',
    model: options.current ?? 'gpt-5.6-luna',
    api_key: 'secret-never-render',
    capabilities: { supports_reasoning: true }
  }

  const writes: Array<Record<string, unknown>> = []
  let current = true

  const providers = options.providers ?? [
    {
      slug: 'openai-codex',
      name: 'ChatGPT',
      authenticated: options.ready ?? true,
      is_current: true,
      models: options.models ?? ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-6-sol'],
      capabilities: {
        'gpt-6-luna': { efforts: ['low', 'medium', 'high', 'max'] },
        'gpt-5.6-luna': { efforts: ['low', 'medium', 'high'] }
      },
      base_url: 'https://private.example/v1'
    },
    {
      slug: 'openrouter',
      name: 'OpenRouter',
      authenticated: true,
      is_current: false,
      models: ['other/model'],
      capabilities: { 'other/model': { efforts: ['low', 'high'] } }
    }
  ]

  const pages = vi.fn(async (request: { path: string; method: string; body?: unknown }): Promise<unknown> => {
    const path = request.path.split('?')[0]

    if (options.failing) {
      throw new Error('secret-upstream-exception token=abc')
    }

    if (path === '/api/model/options') {
      return { providers }
    }

    if (path === '/api/model/info') {
      return { ...info, capabilities: { supports_reasoning: true } }
    }

    if (path === '/api/env' && request.method === 'GET') {
      return {
        OPENAI_API_KEY: { category: 'provider', provider: 'openai-api', is_password: true, is_set: true },
        OPENROUTER_API_KEY: { category: 'provider', provider: 'openrouter', is_password: true, is_set: true }
      }
    }

    if (path === '/api/providers/oauth') {
      return {
        providers: [
          {
            id: 'openai-codex',
            name: 'ChatGPT',
            flow: 'device_code',
            disconnectable: true,
            status: { logged_in: options.ready ?? true }
          }
        ]
      }
    }

    if (path === '/api/providers/custom-endpoints') {
      return { endpoints: [] }
    }

    if (path === '/api/model/set') {
      const body = request.body as { provider: string; model: string; confirm_expensive_model?: boolean }
      writes.push(body)

      if (body.model === options.expensive && !body.confirm_expensive_model) {
        return {
          ok: false,
          confirm_required: true,
          scope: 'main',
          provider: body.provider,
          model: body.model,
          confirm_message: 'This model bills per token.'
        }
      }

      info.provider = body.provider
      info.model = body.model

      return { ok: true, scope: 'main', provider: body.provider, model: body.model }
    }

    throw new Error(`unexpected ${request.path}`)
  })

  const connection = { pages, signal: new AbortController().signal } as unknown as MatrixHermesConnection

  const transport = new MatrixPagesManagementTransport({
    isCurrent: () => current,
    connection: () => connection,
    connect: async () => undefined,
    busy: () => Boolean(options.busy),
    lock
  })

  const confirmCost = vi.fn(async () => true)
  const selected = vi.fn()

  const target: MatrixConnectedModelsAgent = {
    connected: options.connected ?? CHATGPT,
    agentName: 'Atum',
    forward: request => transport.forward(request),
    isCurrent: () => transport.current(),
    confirmCost,
    selected
  }

  return {
    target,
    pages,
    lock,
    writes,
    confirmCost,
    selected,
    retire: () => {
      current = false
    }
  }
}

describe('the room agent’s unified model catalog', () => {
  it('lists every ready provider route with safe labels, exact levels and the current route', async () => {
    const { target } = agent()
    const catalog = await listMatrixModelCatalog(target)

    expect(catalog.agentName).toBe('Atum')
    expect(catalog.destination).toBe('this_mac')
    expect(catalog.current).toBe(CHATGPT_ROUTE)
    expect(catalog.unavailable).toBe(0)
    expect(catalog.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: CHATGPT_ROUTE,
          model: 'gpt-5.6-luna',
          providerLabel: 'ChatGPT',
          accountLabel: 'ChatGPT Plan',
          connection: 'plan',
          target: 'agent_default',
          destination: 'this_mac',
          efforts: ['low', 'medium', 'high'],
          current: true,
          ready: true
        }),
        expect.objectContaining({
          id: OPENROUTER_ROUTE,
          provider: 'openrouter',
          providerLabel: 'OpenRouter',
          accountLabel: 'API key',
          connection: 'key',
          efforts: ['low', 'high'],
          current: false
        })
      ])
    )
    // Credentials, raw endpoints and private provider responses never reach the window.
    expect(JSON.stringify(catalog)).not.toMatch(/secret|private|OPENAI_API_KEY|base_url|supports_reasoning/)
  })

  it('lists a ready provider that advertises no thinking levels instead of dropping every model', async () => {
    const { target } = agent({
      providers: [
        {
          slug: 'openai-codex',
          name: 'ChatGPT',
          authenticated: true,
          is_current: true,
          models: ['gpt-5.6-luna']
        }
      ]
    })

    const catalog = await listMatrixModelCatalog(target)

    expect(catalog.routes).toEqual([
      expect.objectContaining({
        id: CHATGPT_ROUTE,
        provider: 'openai-codex',
        efforts: ['low', 'medium', 'high']
      })
    ])
  })

  it("offers Atum's managed models to placement without adding them to the room routes", async () => {
    const { target } = agent({
      providers: [
        {
          slug: 'openai-codex',
          name: 'ChatGPT',
          authenticated: false,
          is_current: false,
          models: ['gpt-5.6-luna']
        },
        {
          slug: 'atum-gateway',
          name: 'Atum',
          authenticated: true,
          is_current: true,
          models: ['nguyet-thuc', 'nhat-thuc', 'not-a-lineup-model']
        }
      ]
    })

    const catalog = await listMatrixModelCatalog(target)

    expect(catalog.managed).toEqual(['nguyet-thuc'])
    expect(catalog.routes.some(route => route.provider === 'atum-gateway')).toBe(false)
  })

  it("does not call a ChatGPT profile's Mac an Atum destination just because the endpoint is configured", async () => {
    const { target } = agent({
      providers: [
        {
          slug: 'openai-codex',
          name: 'ChatGPT',
          authenticated: true,
          is_current: true,
          models: ['gpt-5.6-luna']
        },
        {
          slug: 'atum-gateway',
          name: 'Atum',
          authenticated: true,
          is_current: false,
          models: ['nguyet-thuc']
        }
      ]
    })

    expect((await listMatrixModelCatalog(target)).managed).toBeUndefined()
  })

  it('keeps the same model on two providers distinct and selects the intended route', async () => {
    const { target, writes, selected } = agent({
      providers: [
        {
          slug: 'openai-codex',
          name: 'ChatGPT',
          authenticated: true,
          is_current: true,
          models: ['gpt-5.6-luna', 'shared-model'],
          capabilities: { 'shared-model': { efforts: ['low', 'high'] } }
        },
        {
          slug: 'openrouter',
          name: 'OpenRouter',
          authenticated: true,
          is_current: false,
          models: ['shared-model'],
          capabilities: { 'shared-model': { efforts: ['medium'] } }
        }
      ]
    })

    const catalog = await listMatrixModelCatalog(target)
    const rows = catalog.routes.filter(route => route.model === 'shared-model')

    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(route => route.id)).size).toBe(2)
    expect(rows.map(route => route.providerLabel)).toEqual(expect.arrayContaining(['ChatGPT', 'OpenRouter']))
    expect(rows.find(route => route.provider === 'openai-codex')?.efforts).toEqual(['low', 'high'])
    expect(rows.find(route => route.provider === 'openrouter')?.efforts).toEqual(['medium'])

    const openrouter = rows.find(route => route.provider === 'openrouter')!
    expect(await selectMatrixModelRoute(target, openrouter.id)).toEqual({
      status: 'applied',
      current: openrouter.id
    })
    expect(writes).toEqual([{ scope: 'main', provider: 'openrouter', model: 'shared-model' }])
    expect(selected).toHaveBeenCalledWith({
      provider: 'openrouter',
      model: 'shared-model',
      reasoning: true,
      capability: { id: 'shared-model', displayName: 'shared-model', efforts: ['medium'] }
    })
  })

  it('lists a signed-out connection as unavailable and gives it no selectable route', async () => {
    const { target } = agent({ ready: false })
    const catalog = await listMatrixModelCatalog(target)
    const chatgpt = catalog.accounts.find(account => account.id === 'openai-codex')

    expect(chatgpt).toMatchObject({ ready: false, providerLabel: 'ChatGPT', accountLabel: 'ChatGPT Plan' })
    expect(catalog.routes.some(route => route.provider === 'openai-codex')).toBe(false)
    expect(catalog.unavailable).toBeGreaterThanOrEqual(1)
  })

  it('never marks a model the route parser rejects as ready, while keeping the account count', async () => {
    const { target } = agent({ models: ['gpt-5.6-luna', 'two words', '-dash-first', 'gpt-6-luna'] })
    const catalog = await listMatrixModelCatalog(target)
    const chatgpt = catalog.accounts.find(account => account.id === 'openai-codex')

    expect(chatgpt).toMatchObject({ models: 4, truncated: true })
    expect(catalog.routes.filter(route => route.provider === 'openai-codex').map(route => route.model)).toEqual([
      'gpt-5.6-luna',
      'gpt-6-luna'
    ])
    expect(catalog.routes.some(route => route.model === 'two words' || route.model === '-dash-first')).toBe(false)
    expect(catalog.routes.every(route => route.ready)).toBe(true)
    expect(catalog.truncated).toBe(true)
    // The existing route policy still rejects the space and the leading flag; nothing widens it.
    expect(parseMatrixModelRouteId(matrixModelRouteId('openai-codex', 'two words'))).toBeUndefined()
    expect(parseMatrixModelRouteId(matrixModelRouteId('openai-codex', '-dash-first'))).toBeUndefined()
    expect(() =>
      parseMatrixConnectedModelRequest({
        kind: 'selectModelRoute',
        roomId: '!a:test',
        routeId: matrixModelRouteId('openai-codex', 'two words'),
        target: 'agent_default'
      })
    ).toThrow('matrix_command_invalid')
  })

  it('does not show or select Hermes context aliases in the Atum ChatGPT picker', async () => {
    const { target, writes } = agent({ models: ['gpt-6-sol', 'gpt-6-sol-900k'] })
    const catalog = await listMatrixModelCatalog(target)

    expect(catalog.routes.filter(route => route.provider === 'openai-codex').map(route => route.model))
      .toEqual(['gpt-6-sol'])
    expect(catalog.accounts.find(account => account.id === 'openai-codex')?.models).toBe(1)
    await expect(selectMatrixModelRoute(target, matrixModelRouteId('openai-codex', 'gpt-6-sol-900k')))
      .rejects.toThrow(MATRIX_CONNECTED_MODEL_ERRORS.unavailable)
    expect(writes).toEqual([])
  })

  it('keeps an unsupported current model visible as current but not selectable, never marking another current', async () => {
    const { target, writes } = agent({ models: ['gpt-5.6-luna', 'two words'], current: 'two words' })
    const catalog = await listMatrixModelCatalog(target)
    const current = catalog.routes.filter(route => route.current)

    expect(current).toHaveLength(1)
    expect(current[0]).toMatchObject({
      id: matrixModelRouteId('openai-codex', 'two words'),
      model: 'two words',
      current: true,
      ready: false
    })
    expect(catalog.current).toBe(matrixModelRouteId('openai-codex', 'two words'))
    expect(catalog.routes.find(route => route.model === 'gpt-5.6-luna')?.current).toBe(false)
    expect(catalog.accounts.find(account => account.id === 'openai-codex')?.models).toBe(2)

    // The current id is visible, but the route policy refuses it before any native write.
    await expect(selectMatrixModelRoute(target, current[0].id)).rejects.toThrow(
      MATRIX_CONNECTED_MODEL_ERRORS.unavailable
    )
    expect(writes).toEqual([])
  })

  it('bounds a long catalog, reports truncation and still lists the model in use', async () => {
    const models = Array.from({ length: MATRIX_MODEL_ROUTE_LIST_MAX + 40 }, (_, index) => `model-${index}`)
    models.push('current-tail')
    const { target } = agent({ models, current: 'current-tail' })
    const catalog = await listMatrixModelCatalog(target)

    expect(catalog.routes).toHaveLength(MATRIX_MODEL_ROUTE_LIST_MAX)
    expect(catalog.routes.map(route => route.id)).toContain(matrixModelRouteId('openai-codex', 'current-tail'))
    expect(catalog.truncated).toBe(true)
  })

  it('switches through the native select and remembers only what Hermes reads back', async () => {
    const { target, writes, selected } = agent()

    expect(await selectMatrixModelRoute(target, matrixModelRouteId('openai-codex', 'gpt-6-luna'))).toEqual({
      status: 'applied',
      current: matrixModelRouteId('openai-codex', 'gpt-6-luna')
    })
    expect(writes).toEqual([{ scope: 'main', provider: 'openai-codex', model: 'gpt-6-luna' }])
    // The readback's own levels, Max withheld until each model has its cap.
    expect(selected).toHaveBeenCalledWith({
      provider: 'openai-codex',
      model: 'gpt-6-luna',
      reasoning: true,
      capability: { id: 'gpt-6-luna', displayName: 'gpt-6-luna', efforts: ['low', 'medium', 'high'] }
    })
  })

  it("refuses a route the connection's fresh catalog does not list, before any write", async () => {
    const { target, writes, selected } = agent()

    await expect(selectMatrixModelRoute(target, matrixModelRouteId('openai-codex', 'gpt-9-imaginary'))).rejects.toThrow(
      MATRIX_CONNECTED_MODEL_ERRORS.unavailable
    )
    await expect(selectMatrixModelRoute(target, matrixModelRouteId('openrouter', 'not-there'))).rejects.toThrow(
      MATRIX_CONNECTED_MODEL_ERRORS.unavailable
    )
    await expect(selectMatrixModelRoute(target, matrixModelRouteId('unknown-provider', 'gpt-6-luna'))).rejects.toThrow(
      MATRIX_CONNECTED_MODEL_ERRORS.unavailable
    )
    expect(writes).toEqual([])
    expect(selected).not.toHaveBeenCalled()
  })

  it('never switches while a turn holds the agent, and never queues behind it', async () => {
    const turning = agent()
    const release = await turning.lock.acquire('!room:test', 'local')

    await expect(
      selectMatrixModelRoute(turning.target, matrixModelRouteId('openai-codex', 'gpt-6-luna'))
    ).rejects.toThrow(MATRIX_CONNECTED_MODEL_ERRORS.busy)
    expect(turning.writes).toEqual([])
    release()

    const busy = agent({ busy: true })
    await expect(selectMatrixModelRoute(busy.target, matrixModelRouteId('openai-codex', 'gpt-6-luna'))).rejects.toThrow(
      MATRIX_CONNECTED_MODEL_ERRORS.busy
    )
    expect(busy.writes).toEqual([])
    // Reading the catalog is not a change: it works while the agent answers.
    expect((await listMatrixModelCatalog(busy.target)).routes.length).toBeGreaterThan(0)
  })

  it('asks the person before a model Hermes says costs extra, and changes nothing when declined', async () => {
    const declined = agent({ expensive: 'gpt-6-sol' })
    declined.confirmCost.mockResolvedValueOnce(false)

    expect(await selectMatrixModelRoute(declined.target, matrixModelRouteId('openai-codex', 'gpt-6-sol'))).toEqual({
      status: 'cancelled'
    })
    expect(declined.confirmCost).toHaveBeenCalledWith({
      provider: 'openai-codex',
      model: 'gpt-6-sol',
      message: 'This model bills per token.'
    })
    expect(declined.writes).toHaveLength(1)
    expect(declined.selected).not.toHaveBeenCalled()

    const accepted = agent({ expensive: 'gpt-6-sol' })
    expect(await selectMatrixModelRoute(accepted.target, matrixModelRouteId('openai-codex', 'gpt-6-sol'))).toEqual({
      status: 'applied',
      current: matrixModelRouteId('openai-codex', 'gpt-6-sol')
    })
    expect(accepted.writes.at(-1)).toEqual({
      scope: 'main',
      provider: 'openai-codex',
      model: 'gpt-6-sol',
      confirm_expensive_model: true
    })
    expect(accepted.selected).toHaveBeenCalledOnce()
  })

  it("leaves Atum's own model to the conversation picker and asks Hermes nothing", async () => {
    const { target, pages } = agent({ connected: { provider: 'atum-gateway', model: 'nguyet-thuc' } })

    await expect(listMatrixModelCatalog(target)).rejects.toThrow(MATRIX_CONNECTED_MODEL_ERRORS.unavailable)
    await expect(selectMatrixModelRoute(target, matrixModelRouteId('openai-codex', 'gpt-6-luna'))).rejects.toThrow(
      MATRIX_CONNECTED_MODEL_ERRORS.unavailable
    )
    expect(pages).not.toHaveBeenCalled()
  })

  it("closes every other failure without Hermes's words, and writes nothing for a retired agent", async () => {
    const failing = agent({ failing: true })

    const failure = await selectMatrixModelRoute(failing.target, CHATGPT_ROUTE).catch((error: Error) => error)
    expect((failure as Error).message).toBe(MATRIX_CONNECTED_MODEL_ERRORS.failed)

    const listFailure = await listMatrixModelCatalog(failing.target).catch((error: Error) => error)
    expect((listFailure as Error).message).toBe(MATRIX_CONNECTED_MODEL_ERRORS.failed)

    const retired = agent()
    retired.retire()
    await expect(selectMatrixModelRoute(retired.target, CHATGPT_ROUTE)).rejects.toThrow(
      MATRIX_CONNECTED_MODEL_ERRORS.failed
    )
    expect(retired.writes).toEqual([])
  })
})

describe('the window’s model-catalog requests', () => {
  it('take a room, and for a switch one opaque route id plus its target, and nothing else', () => {
    expect(parseMatrixConnectedModelRequest({ kind: 'modelCatalog', roomId: '!a:test' })).toEqual({
      kind: 'modelCatalog',
      roomId: '!a:test'
    })
    expect(
      parseMatrixConnectedModelRequest({
        kind: 'selectModelRoute',
        roomId: '!a:test',
        routeId: CHATGPT_ROUTE,
        target: 'agent_default'
      })
    ).toEqual({
      kind: 'selectModelRoute',
      roomId: '!a:test',
      routeId: CHATGPT_ROUTE,
      target: 'agent_default'
    })

    for (const value of [
      { kind: 'modelCatalog', roomId: '!a:test', provider: 'openrouter' },
      { kind: 'modelCatalog', roomId: '!a:test', models: ['x'] },
      { kind: 'modelCatalog' },
      { kind: 'modelCatalog', roomId: 'a:test' },
      { kind: 'modelCatalog', roomId: '!a test' },
      { kind: 'selectModelRoute', roomId: '!a:test', routeId: CHATGPT_ROUTE },
      { kind: 'selectModelRoute', roomId: '!a:test', routeId: CHATGPT_ROUTE, target: 'conversation_override' },
      { kind: 'selectModelRoute', roomId: '!a:test', routeId: CHATGPT_ROUTE, target: 'agent_default', model: 'x' },
      { kind: 'selectModelRoute', roomId: '!a:test', routeId: 'not a route', target: 'agent_default' },
      { kind: 'selectModelRoute', roomId: '!a:test', routeId: '-provider:model', target: 'agent_default' },
      { kind: 'selectModelRoute', roomId: '!a:test', routeId: 'provider:', target: 'agent_default' },
      {
        kind: 'selectModelRoute',
        roomId: '!a:test',
        routeId: `openai-codex:${'x'.repeat(1025)}`,
        target: 'agent_default'
      },
      { kind: 'connectedModels', roomId: '!a:test' },
      { kind: 'setModel', roomId: '!a:test', model: 'gpt-6-luna' },
      ['modelCatalog', '!a:test'],
      null,
      'modelCatalog'
    ]) {
      expect(() => parseMatrixConnectedModelRequest(value)).toThrow('matrix_command_invalid')
    }
  })

  it('rejects an oversized or control-character route id', () => {
    expect(() =>
      parseMatrixConnectedModelRequest({
        kind: 'selectModelRoute',
        roomId: '!a:test',
        routeId: `openai-codex:${'x'.repeat(4097)}`,
        target: 'agent_default'
      })
    ).toThrow('matrix_command_invalid')
    expect(() =>
      parseMatrixConnectedModelRequest({
        kind: 'selectModelRoute',
        roomId: '!a:test',
        routeId: 'openai-codex:model\nbreak',
        target: 'agent_default'
      })
    ).toThrow('matrix_command_invalid')
  })
})
