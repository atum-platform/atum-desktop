import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MatrixCloudModelChoices,
  type MatrixCloudModelResponse,
  matrixCloudModelView,
  matrixCloudModelWrite,
  parseMatrixCloudModelOffer,
  requestMatrixCloudModelChoice
} from './cloud-model-choice'

const PRINCIPAL = '00000000-0000-4000-8000-bd7662a5eeb4'
const DIGEST = '53c77b31c774170dddd8f94561651d786dced5b0d7b743d9fb92d3f68b6d4e03'

function snapshot(overrides: { offered?: readonly string[]; current?: string; revision?: number } = {}) {
  const offered = overrides.offered ?? ['nguyet-thuc', 'nhat-thuc']

  return {
    profile: 'atum.model-choice/1.1',
    agentPrincipal: PRINCIPAL,
    revision: overrides.revision ?? 3,
    source: 'saved',
    policyVersion: '2026-10-17.1',
    policyDigest: DIGEST,
    choice: { v: 2, source: 'atum', model: overrides.current ?? 'nguyet-thuc', effort: 'medium' },
    models: [
      {
        alias: 'nguyet-thuc',
        displayName: 'Nguyệt Thực 1.3',
        providerModel: 'openai/gpt-6-luna',
        contextBudget: 1000000,
        outputBudget: 16384,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        cost: { currency: 'USD', inputPerMtok: '0.20', outputPerMtok: '0.75', maxTurnMicroProtons: 1 },
        eligibility: { state: 'ready' },
        inputModalities: ['text'],
        supportsTools: true
      },
      {
        alias: 'nhat-thuc',
        displayName: 'Nhật Thực 1.1',
        providerModel: 'openai/gpt-6.1-sol',
        contextBudget: 120000,
        outputBudget: 16384,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        cost: { currency: 'USD', inputPerMtok: '2.00', outputPerMtok: '10.00', maxTurnMicroProtons: 1 },
        eligibility: offered.includes('nhat-thuc')
          ? { state: 'ready' }
          : { state: 'unavailable', reason: 'model_not_allowed' },
        inputModalities: ['text'],
        supportsTools: true
      }
    ],
    runtimes: [{ runtime: 'cloud' }],
    grant: { profile: 'atum.model-grant/1', state: 'unavailable', reason: 'model_not_allowed', policyDigest: DIGEST }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('the cloud model-choice offer', () => {
  it('reads the eligible aliases and the choice the server holds, and nothing from a foreign agent', () => {
    const offer = parseMatrixCloudModelOffer(snapshot(), PRINCIPAL)

    expect(offer).toMatchObject({ revision: 3, policyDigest: DIGEST, current: 'nguyet-thuc', effort: 'medium' })
    expect(matrixCloudModelView(offer!)).toEqual({
      offered: ['nguyet-thuc', 'nhat-thuc'],
      current: 'nguyet-thuc'
    })
    expect(parseMatrixCloudModelOffer(snapshot(), '00000000-0000-4000-8000-b454f82c5857')).toBeNull()
  })

  it('leaves an ineligible alias out of the offer, so its row stays "Sắp có"', () => {
    const offer = parseMatrixCloudModelOffer(snapshot({ offered: ['nguyet-thuc'] }), PRINCIPAL)

    expect(matrixCloudModelView(offer!).offered).toEqual(['nguyet-thuc'])
  })

  it('writes a choice fenced by the offer revision and keeps a level the destination serves', () => {
    const offer = parseMatrixCloudModelOffer(snapshot(), PRINCIPAL)!
    const write = matrixCloudModelWrite(offer, 'nhat-thuc', '00000000-0000-4000-8000-303617b97302')

    expect(write).toEqual({
      profile: 'atum.model-choice/1.1',
      requestId: '00000000-0000-4000-8000-303617b97302',
      expectedRevision: 3,
      policyDigest: DIGEST,
      choice: { v: 2, source: 'atum', model: 'nhat-thuc', effort: 'medium' }
    })
    // An alias the offer does not mark eligible is never written from stale UI.
    expect(
      matrixCloudModelWrite({ ...offer, models: offer.models.map(row => ({ ...row, eligible: false })) }, 'nhat-thuc')
    ).toBeNull()
  })})

/** An OpenRouter shelf row exactly as the platform's 1.1 snapshot carries it (0431 catalog values). */
function shelfRow(alias: string, displayName: string, providerModel: string, cost: [string, string], ready: boolean) {
  return {
    alias,
    displayName,
    providerModel,
    contextBudget: 128000,
    outputBudget: 16384,
    efforts: alias === 'glm' ? ['low', 'high'] : ['low', 'medium', 'high'],
    defaultEffort: 'high',
    cost: { currency: 'USD', inputPerMtok: cost[0], outputPerMtok: cost[1], maxTurnMicroProtons: 1 },
    eligibility: ready ? { state: 'ready' } : { state: 'unavailable', reason: 'model_not_allowed' },
    inputModalities: ['text'],
    supportsTools: true
  }
}

function shelfSnapshot(ready: boolean, current?: string) {
  const base = snapshot(current ? { current } : {})

  return {
    ...base,
    models: [
      ...base.models,
      shelfRow('opus', 'Anthropic: Claude Opus 5.5', 'anthropic/claude-opus-5.5', ['4', '20'], ready),
      shelfRow('glm', 'Z.ai: GLM 5.3 Flash', 'z-ai/glm-5.3-flash', ['0.0335', '0.083'], ready)
    ]
  }
}

describe('the OpenRouter shelf in the offer', () => {
  it('lists no shelf model while the platform keeps the rows inactive (prod after 0431)', () => {
    const view = matrixCloudModelView(parseMatrixCloudModelOffer(shelfSnapshot(false), PRINCIPAL)!)

    expect(view).toEqual({ offered: ['nguyet-thuc', 'nhat-thuc'], current: 'nguyet-thuc' })
    expect(view.shelf).toBeUndefined()
  })

  it('lists the active shelf models in the server’s order with their Proton prices, and never Atum’s own', () => {
    const view = matrixCloudModelView(parseMatrixCloudModelOffer(shelfSnapshot(true), PRINCIPAL)!)

    expect(view.offered).toEqual(['nguyet-thuc', 'nhat-thuc', 'opus', 'glm'])
    expect(view.shelf?.map(each => [each.alias, each.name, each.inputProtonsPerMtok, each.outputProtonsPerMtok, each.costly])).toEqual([
      ['opus', 'Claude Opus 5.5', 162_000, 810_000, true],
      ['glm', 'GLM 5.3 Flash', 1356.75, 3361.5, false]
    ])
  })

  it('keeps an active shelf row it cannot price out of the shelf, so no paid model is drawn without a price', () => {
    const raw = shelfSnapshot(true)
    const models = raw.models.map(each =>
      each.alias === 'opus' ? { ...each, cost: { currency: 'USD', maxTurnMicroProtons: 1 } } : each
    )
    const view = matrixCloudModelView(parseMatrixCloudModelOffer({ ...raw, models }, PRINCIPAL)!)

    expect(view.shelf?.map(each => each.alias)).toEqual(['glm'])
  })

  it('writes a shelf pick through the same fenced 1.1 body, with the model’s own level', () => {
    const offer = parseMatrixCloudModelOffer(shelfSnapshot(true), PRINCIPAL)!

    expect(matrixCloudModelWrite({ ...offer, effort: undefined }, 'glm', '00000000-0000-4000-8000-303617b97302')).toEqual({
      profile: 'atum.model-choice/1.1',
      requestId: '00000000-0000-4000-8000-303617b97302',
      expectedRevision: 3,
      policyDigest: DIGEST,
      choice: { v: 2, source: 'atum', model: 'glm', effort: 'high' }
    })
    // An inactive shelf row is never written from a stale card.
    expect(matrixCloudModelWrite(parseMatrixCloudModelOffer(shelfSnapshot(false), PRINCIPAL)!, 'opus')).toBeNull()
  })

  it('reads a saved shelf model as the cloud’s current choice', () => {
    expect(matrixCloudModelView(parseMatrixCloudModelOffer(shelfSnapshot(true, 'opus'), PRINCIPAL)!).current).toBe('opus')
  })
})

describe('the owner routes', () => {
  it('GETs the named agent’s models and PUTs its model-choice with the body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot()), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot({ current: 'nhat-thuc' })), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const read = await requestMatrixCloudModelChoice(
      'https://platform.test/api/matrix/v1',
      'token',
      PRINCIPAL,
      'read',
      AbortSignal.timeout(1000)
    )
    const body = matrixCloudModelWrite(parseMatrixCloudModelOffer(read.value, PRINCIPAL)!, 'nhat-thuc', '00000000-0000-4000-8000-303617b97302')!
    const write = await requestMatrixCloudModelChoice(
      'https://platform.test/api/matrix/v1',
      'token',
      PRINCIPAL,
      'write',
      AbortSignal.timeout(1000),
      body
    )

    expect(read.status).toBe(200)
    expect(write.status).toBe(200)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://platform.test/api/matrix/v1/agents/${PRINCIPAL}/models`)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`https://platform.test/api/matrix/v1/agents/${PRINCIPAL}/model-choice`)
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT' })
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({
      choice: { model: 'nhat-thuc' },
      expectedRevision: 3
    })
  })
})

describe('the cached offer', () => {
  function choices(call: (principal: string, action: string) => Promise<MatrixCloudModelResponse>) {
    const model = new MatrixCloudModelChoices({
      scope: () => ({ accountKey: 'account', generation: 1 }),
      call: (principal, action) => call(principal, action),
      changed: () => {}
    })
    model.activate({ accountKey: 'account', generation: 1 })

    return model
  }

  // `refresh` starts a read it does not return; one task turn lets the stub land.
  async function settled(model: MatrixCloudModelChoices) {
    await new Promise(resolve => setTimeout(resolve, 0))
    return model
  }

  it('offers only what a reachable read returns, and nothing when the route is absent', async () => {
    const reachable = choices(async () => ({ status: 200, value: snapshot({ offered: ['nguyet-thuc'] }) }))
    reachable.refresh(PRINCIPAL)
    await settled(reachable)
    expect(reachable.view(PRINCIPAL)).toEqual({ offered: ['nguyet-thuc'], current: 'nguyet-thuc' })

    const absent = choices(async () => ({ status: 404, value: null }))
    absent.refresh(PRINCIPAL)
    await settled(absent)
    expect(absent.view(PRINCIPAL)).toBeUndefined()
  })

  it('adopts the server’s snapshot after a write, and keeps no offer after a refusal', async () => {
    const write = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, value: snapshot({ current: 'nhat-thuc' }) })
      .mockResolvedValueOnce({ status: 409, value: { error: 'matrix_409', details: { reason: 'model_unavailable' } } })
    const model = choices(async (_principal, action) =>
      action === 'read' ? { status: 200, value: snapshot() } : write()
    )

    model.refresh(PRINCIPAL)
    await settled(model)

    expect(await model.write(PRINCIPAL, 'nhat-thuc')).toBe(true)
    expect(model.view(PRINCIPAL)).toEqual({ offered: ['nguyet-thuc', 'nhat-thuc'], current: 'nhat-thuc' })

    expect(await model.write(PRINCIPAL, 'nguyet-thuc')).toBe(false)
    expect(model.view(PRINCIPAL)).toBeUndefined()
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('falls back when the offer never arrived, without throwing', async () => {
    const model = choices(async () => {
      throw new Error('offline')
    })

    model.refresh(PRINCIPAL)
    await settled(model)
    expect(model.view(PRINCIPAL)).toBeUndefined()
    expect(await model.write(PRINCIPAL, 'nhat-thuc')).toBe(false)
  })
})
