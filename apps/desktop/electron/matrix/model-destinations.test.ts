import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExecutionDeviceName } from '../../shared/execution-policy'

import {
  MATRIX_MODEL_DESTINATIONS_PROFILE,
  MATRIX_MODEL_DESTINATIONS_PROFILE_14,
  matrixModelDailyCapWrite,
  matrixModelDestinationHere,
  MatrixModelDestinations,
  type MatrixModelDestinationsAction,
  type MatrixModelDestinationSnapshot,
  type MatrixModelDestinationsResponse,
  matrixModelDestinationsView,
  matrixModelDestinationWrite,
  matrixSubscriptionDestinationWrite,
  parseMatrixDailyProtons,
  parseMatrixDestinationChoice,
  parseMatrixModelDailyCapWrite,
  parseMatrixModelDestinationSnapshot,
  parseMatrixModelDestinationsWrite,
  requestMatrixModelDestinations,
  writeMatrixCloudAtumChoice
} from './model-destinations'

const PRINCIPAL = '00000000-0000-4000-8000-bd7662a5eeb4'
const OTHER = '00000000-0000-4000-8000-b454f82c5857'
const REQUEST = '00000000-0000-4000-8000-303617b97302'

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/device-protocol/fixtures/model-choice/fixtures'
)

const fixtures14 = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/device-protocol/fixtures/model-choice-v1.4/fixtures'
)

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8'))
}

function fixture14(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures14, name), 'utf8'))
}

const NAMES: Record<string, ExecutionDeviceName> = {
  'mini-b': { displayName: "Owner's Mac mini", thisMac: false },
  'mini-a': { displayName: 'MacBook Air mẫu', thisMac: false },
  'book-a': { displayName: "Owner's MacBook Air", model: 'MacBook Air', thisMac: true }
}

function snapshot(): MatrixModelDestinationSnapshot {
  return parseMatrixModelDestinationSnapshot(fixture('destination.snapshot.json'), PRINCIPAL)!
}

afterEach(() => vi.unstubAllGlobals())

describe('the destination snapshot', () => {
  it('reads the frozen v1.3 fixture: the recommendation, every choice and today’s spend', () => {
    const parsed = parseMatrixModelDestinationSnapshot(fixture('destination.snapshot.json'), PRINCIPAL)

    expect(parsed).toMatchObject({
      profile: MATRIX_MODEL_DESTINATIONS_PROFILE,
      agentPrincipal: PRINCIPAL,
      revision: 3,
      policyDigest: '489e82bcce6008fd0cae824623b3e323bf7a8820a18e34bf8bab815f7999d7a0',
      recommended: { source: 'atum', model: 'nguyet-thuc', effort: 'medium' },
      dailyCap: { dailyProtons: 200000, timeZone: 'Asia/Ho_Chi_Minh', warningPercent: 80, counts: 'atum_billed_only' },
      spend: { day: '2026-10-18', usedProtons: 42000, state: 'normal', notice: 'none' }
    })
    expect(parsed!.choices.map(choice => choice.destination)).toEqual(['cloud', 'mac:mini-b', 'mac:mini-a', 'mac:book-a'])
    expect(parseMatrixModelDestinationSnapshot({ ...(fixture('destination.snapshot.json') as object), choices: [] }, PRINCIPAL)?.choices).toEqual([])
    expect(parsed!.choices[3]).toEqual({
      destination: 'mac:book-a',
      source: 'own_key:openrouter',
      model: 'openai/gpt-6.1-sol',
      effort: 'high'
    })
  })

  it('never reads a snapshot for another agent', () => {
    expect(parseMatrixModelDestinationSnapshot(fixture('destination.snapshot.json'), OTHER)).toBeUndefined()
  })

  it('refuses malformed snapshots the platform itself refuses', () => {
    for (const name of [
      'destination-duplicate.snapshot.json',
      'destination-spend-mismatch.snapshot.json',
      'destination-exhausted-below-cap.snapshot.json',
      'destination-secret.request.json',
      'destination-cloud-chatgpt.request.json',
      'destination-mac-atum-max.request.json'
    ]) {
      expect(parseMatrixModelDestinationSnapshot(fixture(name), PRINCIPAL)).toBeUndefined()
    }

    const value = fixture('destination.snapshot.json') as Record<string, unknown>

    expect(parseMatrixModelDestinationSnapshot({ ...value, unexpected: true }, PRINCIPAL)).toBeUndefined()
  })

  it('accepts the warning and uncapped snapshots and keeps the cap’s own state', () => {
    expect(
      parseMatrixModelDestinationSnapshot(fixture('destination-warning.snapshot.json'), PRINCIPAL)?.spend
    ).toMatchObject({ state: 'warning', notice: 'eighty_percent' })
    expect(
      parseMatrixModelDestinationSnapshot(fixture('destination-uncapped.snapshot.json'), PRINCIPAL)?.dailyCap
    ).toMatchObject({ dailyProtons: 0 })
  })
})

describe('the daily cap on the card', () => {
  it('carries the cap, the server’s spend and the revision a write is fenced by', () => {
    const view = matrixModelDestinationsView(snapshot())

    expect(view.dailyCap).toEqual({
      dailyProtons: 200000,
      revision: 3,
      spend: { day: '2026-10-18', usedProtons: 42000, state: 'normal', notice: 'none' }
    })
  })

  it('passes the server’s warning and exhausted state through untouched', () => {
    const warning = parseMatrixModelDestinationSnapshot(fixture('destination-warning.snapshot.json'), PRINCIPAL)!

    const exhausted = parseMatrixModelDestinationSnapshot(
      fixture('destination-exhausted.snapshot.json'),
      PRINCIPAL
    )!

    expect(matrixModelDestinationsView(warning).dailyCap?.spend).toMatchObject({
      state: 'warning',
      notice: 'eighty_percent'
    })
    expect(matrixModelDestinationsView(exhausted).dailyCap?.spend).toMatchObject({
      state: 'exhausted',
      notice: 'exhausted'
    })
  })
})

describe('the daily cap write', () => {
  it('names the count and the snapshot revision, and accepts no limit', () => {
    expect(matrixModelDailyCapWrite(snapshot(), 250000, REQUEST)).toEqual({
      profile: MATRIX_MODEL_DESTINATIONS_PROFILE,
      requestId: REQUEST,
      expectedRevision: 3,
      dailyProtons: 250000
    })
    expect(matrixModelDailyCapWrite(snapshot(), 0, REQUEST)).toMatchObject({
      expectedRevision: 3,
      dailyProtons: 0
    })
  })

  it('accepts only whole safe Proton counts from the window', () => {
    expect(parseMatrixDailyProtons(0)).toBe(0)
    expect(parseMatrixDailyProtons(200000)).toBe(200000)

    for (const value of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      '200000',
      null,
      undefined
    ]) {
      expect(parseMatrixDailyProtons(value)).toBeUndefined()
    }
  })

  it('checks its own body before it leaves main', () => {
    const body = matrixModelDailyCapWrite(snapshot(), 100000, REQUEST)!

    expect(parseMatrixModelDailyCapWrite(body)).toEqual(body)

    for (const bad of [
      { ...body, unexpected: true },
      { ...body, requestId: 'not-a-uuid' },
      { ...body, dailyProtons: -1 },
      { ...body, dailyProtons: 1.5 },
      { ...body, profile: 'atum.model-choice/1.2' }
    ]) {
      expect(parseMatrixModelDailyCapWrite(bad)).toBeUndefined()
    }
  })
})

describe('the destination write', () => {
  it('names the destination, the model and the standard effort, fenced by the snapshot', () => {
    expect(matrixModelDestinationWrite(snapshot(), 'cloud', 'nhat-thuc', REQUEST)).toEqual({
      profile: MATRIX_MODEL_DESTINATIONS_PROFILE,
      requestId: REQUEST,
      expectedRevision: 3,
      policyDigest: '489e82bcce6008fd0cae824623b3e323bf7a8820a18e34bf8bab815f7999d7a0',
      choice: { destination: 'cloud', source: 'atum', model: 'nhat-thuc', effort: 'medium' }
    })
  })

  it('keeps a destination’s own effort when its model does not change', () => {
    const value = fixture('destination.snapshot.json') as Record<string, unknown>
    value.choices = [
      {
        destination: 'mac:mini-b',
        source: 'atum',
        model: 'nhat-thuc',
        effort: 'low'
      }
    ]

    const parsed = parseMatrixModelDestinationSnapshot(value, PRINCIPAL)!

    expect(matrixModelDestinationWrite(parsed, 'mac:mini-b', 'nhat-thuc', REQUEST)?.choice).toEqual({
      destination: 'mac:mini-b',
      source: 'atum',
      model: 'nhat-thuc',
      effort: 'low'
    })
    expect(matrixModelDestinationWrite(parsed, 'mac:mini-b', 'nguyet-thuc', REQUEST)?.choice.effort).toBe('medium')
  })

  it('never writes an announced model or a destination outside the contract', () => {
    expect(matrixModelDestinationWrite(snapshot(), 'cloud', 'thai-cuc' as never, REQUEST)).toBeUndefined()
    expect(matrixModelDestinationWrite(snapshot(), 'mac:not a destination' as never, 'nguyet-thuc', REQUEST)).toBeUndefined()
    expect(parseMatrixDestinationChoice({ destination: 'cloud', source: 'chatgpt_plan', model: 'x', effort: 'medium' }))
      .toEqual({ destination: 'cloud', source: 'chatgpt_plan', model: 'x', effort: 'medium' })
    expect(parseMatrixDestinationChoice({ destination: 'cloud', source: 'atum', model: 'nguyet-thuc' })).toBeUndefined()
  })

  it('checks its own body before it leaves main', () => {
    const body = matrixModelDestinationWrite(snapshot(), 'cloud', 'nhat-thuc', REQUEST)!

    expect(parseMatrixModelDestinationsWrite(body)).toEqual(body)
    expect(parseMatrixModelDestinationsWrite({ ...body, unexpected: true })).toBeUndefined()
    expect(parseMatrixModelDestinationsWrite({ ...body, requestId: 'not-a-uuid' })).toBeUndefined()
    expect(
      parseMatrixModelDestinationsWrite({ ...body, choice: { ...body.choice, destination: 'cloud', source: 'chatgpt_plan' } })
    ).toBeUndefined()
  })

  it('GETs and PUTs the one owner route with the bearer, never a credential in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fixture('destination.snapshot.json')), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )

    vi.stubGlobal('fetch', fetchMock)

    await requestMatrixModelDestinations(
      'https://platform.test/api/matrix/v1',
      'token',
      PRINCIPAL,
      'read',
      AbortSignal.timeout(1000)
    )
    expect(fetchMock).toHaveBeenLastCalledWith(
      `https://platform.test/api/matrix/v1/agents/${PRINCIPAL}/model-destinations`,
      expect.objectContaining({ method: 'GET', credentials: 'omit' })
    )

    const body = matrixModelDestinationWrite(snapshot(), 'cloud', 'nhat-thuc', REQUEST)!
    await requestMatrixModelDestinations(
      'https://platform.test/api/matrix/v1',
      'token',
      PRINCIPAL,
      'write',
      AbortSignal.timeout(1000),
      body
    )
    const [, init] = fetchMock.mock.calls.at(-1)!
    expect(init).toMatchObject({ method: 'PUT', body: JSON.stringify(body) })
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(init.body)).not.toHaveProperty('token')

    const cap = matrixModelDailyCapWrite(snapshot(), 100000, REQUEST)!
    await requestMatrixModelDestinations(
      'https://platform.test/api/matrix/v1',
      'token',
      PRINCIPAL,
      'cap',
      AbortSignal.timeout(1000),
      cap
    )
    expect(fetchMock).toHaveBeenLastCalledWith(
      `https://platform.test/api/matrix/v1/agents/${PRINCIPAL}/model-daily-cap`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify(cap),
        headers: expect.objectContaining({ 'Content-Type': 'application/json' })
      })
    )
  })

  it('refuses a cap body under the choice action and a choice body under the cap action', async () => {
    const cap = matrixModelDailyCapWrite(snapshot(), 100000, REQUEST)!
    const choice = matrixModelDestinationWrite(snapshot(), 'cloud', 'nhat-thuc', REQUEST)!

    await expect(
      requestMatrixModelDestinations(
        'https://platform.test/api/matrix/v1',
        'token',
        PRINCIPAL,
        'write',
        AbortSignal.timeout(1000),
        cap
      )
    ).rejects.toThrow('matrix_model_destinations_invalid')
    await expect(
      requestMatrixModelDestinations(
        'https://platform.test/api/matrix/v1',
        'token',
        PRINCIPAL,
        'cap',
        AbortSignal.timeout(1000),
        choice
      )
    ).rejects.toThrow('matrix_model_destinations_invalid')
  })
})

describe('the card’s rows', () => {
  it('lists the cloud and each Mac by name, with the reference model and the recommendation', () => {
    const view = matrixModelDestinationsView(snapshot(), { deviceNames: NAMES, thisDevice: 'book-a' })

    expect(view.recommended).toBe('nguyet-thuc')
    expect(view.choices.map(choice => [choice.id, choice.current, choice.recommended])).toEqual([
      ['cloud', 'nguyet-thuc', true],
      ['mac:mini-b', 'nhat-thuc', false],
      ['mac:mini-a', 'nguyet-thuc', true],
      ['mac:book-a', 'nguyet-thuc', true]
    ])
    expect(view.choices[3]).toMatchObject({
      deviceName: "Owner's MacBook Air",
      deviceModel: 'MacBook Air',
      thisMac: true,
      macOrdinal: 3,
      external: {
        source: 'own_key:openrouter',
        providerLabel: 'API connection',
        model: 'openai/gpt-6.1-sol',
        modelLabel: 'Openai GPT 6.1 Sol',
        effort: 'high'
      }
    })
    expect(matrixModelDestinationHere(view, 'cloud')).toBe('nguyet-thuc')
    expect(matrixModelDestinationHere(view, 'mac', 'mini-b')).toBe('nhat-thuc')
    expect(matrixModelDestinationHere(view, 'mac', 'unknown')).toBe('nguyet-thuc')
  })

  it('adds a Mac the server has no choice for, and keeps Macs on the whole line-up', () => {
    const view = matrixModelDestinationsView(snapshot(), {
      deviceNames: { 'mini-b': NAMES['mini-b'], fresh: { displayName: 'Mac Studio', thisMac: false } }
    })

    expect(view.choices.map(choice => choice.id)).toEqual(['cloud', 'mac:mini-b', 'mac:mini-a', 'mac:book-a', 'mac:fresh'])
    expect(view.choices.at(-1)).toMatchObject({ current: 'nguyet-thuc', models: ['nguyet-thuc', 'nhat-thuc'] })
    expect(view.choices[0]).toMatchObject({
      models: ['nguyet-thuc'],
      unavailable: ['nhat-thuc']
    })
  })

  it('omits a superseded device row while always retaining this Mac', () => {
    const view = matrixModelDestinationsView(snapshot(), {
      deviceNames: NAMES,
      thisDevice: 'book-a',
      supersededDeviceIds: ['mini-a', 'book-a']
    })

    expect(view.choices.map(choice => choice.id)).toEqual(['cloud', 'mac:mini-b', 'mac:book-a'])
    expect(view.choices.at(-1)).toMatchObject({ thisMac: true, deviceName: "Owner's MacBook Air" })
  })

  it('follows the composer’s offer for the cloud row only', () => {
    const offered = matrixModelDestinationsView(snapshot(), {
      deviceNames: NAMES,
      offer: { offered: ['nguyet-thuc', 'nhat-thuc'] }
    })

    expect(offered.choices[0]).toMatchObject({ models: ['nguyet-thuc', 'nhat-thuc'], unavailable: [] })
    expect(offered.choices[1]).toMatchObject({ models: ['nguyet-thuc', 'nhat-thuc'] })
  })
})

describe('the destination controller', () => {
  const scope = { accountKey: 'account', generation: 1 }

  function controller(
    response: (action: MatrixModelDestinationsAction) => MatrixModelDestinationsResponse,
    options: { offer?: { offered: readonly string[] } } = {}
  ) {
    const call = vi.fn(async (_principal: string, action: MatrixModelDestinationsAction) => response(action))
    const changed = vi.fn()

    const subject = new MatrixModelDestinations({
      scope: () => scope,
      call,
      deviceNames: async () => NAMES,
      offer: () => options.offer,
      here: () => 'mac',
      thisDevice: () => 'book-a',
      changed
    })

    subject.activate(scope)

    return { subject, call, changed }
  }

  it('reads once per interval, publishes the display rows and hides when the route is absent', async () => {
    const value = fixture('destination.snapshot.json')
    const { subject, call, changed } = controller(() => ({ status: 200, value }))

    const parsed = parseMatrixModelDestinationSnapshot(value, PRINCIPAL)
    expect(parsed).toBeDefined()
    expect(matrixModelDestinationsView(parsed!)).toMatchObject({ recommended: 'nguyet-thuc' })
    const view = await subject.read(PRINCIPAL)

    expect(call).toHaveBeenCalledWith(PRINCIPAL, 'read', expect.any(AbortSignal))
    expect(view).toMatchObject({ recommended: 'nguyet-thuc' })
    expect(subject.view(PRINCIPAL)?.choices).toHaveLength(4)
    expect(subject.view(PRINCIPAL)?.here).toBe('nguyet-thuc')
    // The same object across publishes unless a live fact changes.
    expect(subject.view(PRINCIPAL)).toBe(subject.view(PRINCIPAL))
    expect(changed).toHaveBeenCalled()

    const missing = controller(() => ({ status: 404, value: null }))
    expect(await missing.subject.read(PRINCIPAL)).toBeUndefined()
    expect(missing.subject.view(PRINCIPAL)).toBeUndefined()
  })

  it('adopts the server’s answer after a write', async () => {
    const value = fixture('destination.snapshot.json') as Record<string, unknown>

    const next = {
      ...value,
      revision: 4,
      choices: (value.choices as Array<Record<string, unknown>>).map(choice =>
        choice.destination === 'cloud' ? { ...choice, model: 'nhat-thuc' } : choice
      )
    }

    const { subject } = controller(action => ({ status: 200, value: action === 'write' ? next : value }))

    await subject.read(PRINCIPAL)
    expect(await subject.write(PRINCIPAL, 'cloud', 'nhat-thuc')).toBe(true)
    expect(subject.view(PRINCIPAL)?.choices[0]).toMatchObject({ current: 'nhat-thuc', recommended: false })
    expect(subject.snapshot(PRINCIPAL)?.revision).toBe(4)
  })

  it('reverts quietly: a refusal leaves the last server snapshot untouched', async () => {
    const value = fixture('destination.snapshot.json')

    const { subject, changed } = controller(action =>
      action === 'write' ? { status: 409, value: { error: 'matrix_409' } } : { status: 200, value }
    )

    await subject.read(PRINCIPAL)
    changed.mockClear()
    expect(await subject.write(PRINCIPAL, 'cloud', 'nhat-thuc')).toBe(false)
    expect(subject.view(PRINCIPAL)?.choices[0]).toMatchObject({ current: 'nguyet-thuc', recommended: true })
    expect(changed).not.toHaveBeenCalled()
  })

  it('adopts the server’s answer after a cap write, fenced by the snapshot revision', async () => {
    const value = fixture('destination.snapshot.json') as Record<string, unknown>

    const next = {
      ...value,
      revision: 4,
      dailyCap: { ...(value.dailyCap as object), dailyProtons: 100000 }
    }

    const { subject, call } = controller(action => ({ status: 200, value: action === 'cap' ? next : value }))

    await subject.read(PRINCIPAL)
    expect(await subject.cap(PRINCIPAL, 100000)).toBe(true)
    expect(call).toHaveBeenLastCalledWith(
      PRINCIPAL,
      'cap',
      expect.any(AbortSignal),
      expect.objectContaining({ dailyProtons: 100000, expectedRevision: 3 })
    )
    expect(subject.view(PRINCIPAL)?.dailyCap).toMatchObject({ dailyProtons: 100000, revision: 4 })
    expect(subject.snapshot(PRINCIPAL)?.revision).toBe(4)
  })

  it('keeps the last cap when the server refuses or the write never lands', async () => {
    const value = fixture('destination.snapshot.json')

    const refused = controller(action =>
      action === 'cap' ? { status: 409, value: { error: 'matrix_409' } } : { status: 200, value }
    )

    await refused.subject.read(PRINCIPAL)
    expect(await refused.subject.cap(PRINCIPAL, 0)).toBe(false)
    expect(refused.subject.view(PRINCIPAL)?.dailyCap?.dailyProtons).toBe(200000)

    const offline = vi.fn(async (_principal: string, action: MatrixModelDestinationsAction) => {
      if (action === 'cap') {
        throw new Error('matrix_s1_unavailable')
      }

      return { status: 200, value }
    })

    const subject = new MatrixModelDestinations({
      scope: () => scope,
      call: offline,
      deviceNames: async () => NAMES,
      offer: () => undefined,
      here: () => 'mac',
      thisDevice: () => 'book-a',
      changed: vi.fn()
    })

    subject.activate(scope)
    await subject.read(PRINCIPAL)
    expect(await subject.cap(PRINCIPAL, 0)).toBe(false)
    // One retryable write that did not reach the server must not blank the rows.
    expect(subject.view(PRINCIPAL)?.dailyCap?.dailyProtons).toBe(200000)
    expect(subject.snapshot(PRINCIPAL)?.revision).toBe(3)
  })

  it('takes the cloud row’s eligibility from the current offer without a new read', async () => {
    const value = fixture('destination.snapshot.json')
    let offered: readonly string[] = ['nguyet-thuc']

    const subject = new MatrixModelDestinations({
      scope: () => scope,
      call: async () => ({ status: 200, value }),
      deviceNames: async () => NAMES,
      offer: () => ({ offered }),
      here: () => 'mac',
      thisDevice: () => 'book-a',
      changed: vi.fn()
    })

    subject.activate(scope)
    await subject.read(PRINCIPAL)
    expect(subject.view(PRINCIPAL)?.choices[0]).toMatchObject({ unavailable: ['nhat-thuc'] })

    const before = subject.view(PRINCIPAL)
    offered = ['nguyet-thuc', 'nhat-thuc']
    expect(subject.view(PRINCIPAL)?.choices[0]).toMatchObject({ unavailable: [] })
    expect(subject.view(PRINCIPAL)).not.toBe(before)
  })
})


describe('the account-wide subscription destination (atum.model-choice/1.4)', () => {
  it('reads the 1.4 snapshot and its cloud OpenCode Go choice', () => {
    const parsed = parseMatrixModelDestinationSnapshot(fixture14('destination-subscription.snapshot.json'), PRINCIPAL)

    expect(parsed).toMatchObject({
      profile: MATRIX_MODEL_DESTINATIONS_PROFILE_14,
      revision: 3
    })
    expect(parsed!.choices[0]).toEqual({
      destination: 'cloud',
      source: 'opencode_go',
      model: 'glm-5.2',
      effort: 'high'
    })
  })

  it('accepts 1.3 beside 1.4 but refuses a profile that disagrees with its choice', () => {
    expect(parseMatrixModelDestinationSnapshot(fixture('destination.snapshot.json'), PRINCIPAL)?.profile)
      .toBe(MATRIX_MODEL_DESTINATIONS_PROFILE)

    const base = fixture14('destination-subscription.snapshot.json') as Record<string, unknown>
    const choice = (base.choices as Array<Record<string, unknown>>)[0]!
    expect(parseMatrixModelDestinationSnapshot({
      ...base,
      profile: MATRIX_MODEL_DESTINATIONS_PROFILE,
      choices: [choice]
    }, PRINCIPAL)).toBeUndefined()
    expect(parseMatrixModelDestinationSnapshot({
      ...base,
      choices: [{ ...choice, source: 'atum', model: 'nguyet-thuc', effort: 'medium' }]
    }, PRINCIPAL)).toBeUndefined()
    expect(parseMatrixModelDestinationSnapshot(fixture14('destination-subscription-bad-model.snapshot.json'), PRINCIPAL))
      .toBeUndefined()
  })

  it('writes exactly the 1.4 request the contract states', () => {
    const parsed = parseMatrixModelDestinationSnapshot(fixture14('destination-subscription.snapshot.json'), PRINCIPAL)!
    const body = matrixSubscriptionDestinationWrite(parsed, 'opencode_go', 'glm-5.2', 'high', REQUEST)

    expect(body).toEqual(fixture14('destination-cloud-opencode-go.request.json'))
    expect(parseMatrixModelDestinationsWrite(body)).toEqual(body)
    expect(parseMatrixModelDestinationsWrite({ ...body, profile: MATRIX_MODEL_DESTINATIONS_PROFILE }))
      .toBeUndefined()
  })

  it('draws the cloud row as OpenCode Go without losing its Atum fallback', () => {
    const parsed = parseMatrixModelDestinationSnapshot(fixture14('destination-subscription.snapshot.json'), PRINCIPAL)!
    const view = matrixModelDestinationsView(parsed, { deviceNames: NAMES, thisDevice: 'book-a' })

    expect(view.choices[0]).toMatchObject({
      id: 'cloud',
      current: 'nguyet-thuc',
      recommended: true,
      external: {
        source: 'opencode_go',
        providerLabel: 'OpenCode Go',
        model: 'glm-5.2',
        modelLabel: 'Glm 5.2',
        effort: 'high'
      }
    })
  })

  it('sends one 1.4 write and adopts the server’s own snapshot', async () => {
    const scope = { accountKey: 'account', generation: 1 }
    const before = fixture('destination.snapshot.json')
    const after = fixture14('destination-subscription.snapshot.json')
    const calls: Array<{ action: MatrixModelDestinationsAction; body?: unknown }> = []

    const subject = new MatrixModelDestinations({
      scope: () => scope,
      call: async (_principal, action, _signal, body) => {
        calls.push({ action, ...(body ? { body } : {}) })

        return { status: 200, value: action === 'write' ? after : before }
      },
      deviceNames: async () => NAMES,
      offer: () => undefined,
      here: () => 'cloud',
      thisDevice: () => 'book-a',
      changed: vi.fn()
    })

    subject.activate(scope)

    await subject.read(PRINCIPAL)
    expect(subject.cloudChoice(PRINCIPAL)).toMatchObject({ source: 'atum', model: 'nguyet-thuc' })
    expect(await subject.writeSubscription(PRINCIPAL, 'opencode_go', 'glm-5.2', 'high')).toBe(true)
    expect(calls.at(-1)).toMatchObject({
      action: 'write',
      body: {
        profile: MATRIX_MODEL_DESTINATIONS_PROFILE_14,
        choice: { destination: 'cloud', source: 'opencode_go', model: 'glm-5.2', effort: 'high' }
      }
    })
    expect(subject.cloudChoice(PRINCIPAL)).toMatchObject({ source: 'opencode_go', model: 'glm-5.2' })
    expect(subject.view(PRINCIPAL)?.choices[0]?.external?.source).toBe('opencode_go')
  })
})

describe('a cloud agent’s Atum pick (owner 2026-11-08: “can’t even go back to nguyet thuc”)', () => {
  const view = { recommended: 'nguyet-thuc', choices: [] } as never

  it('writes the cloud destination record, reading it first when unread, and re-reads the 1.1 row', async () => {
    let read = false
    const destinations = {
      view: vi.fn(() => (read ? view : undefined)),
      read: vi.fn(async () => {
        read = true

        return view
      }),
      write: vi.fn(async () => true)
    }
    const legacy = { write: vi.fn(async () => false), reload: vi.fn(async () => undefined) }

    await expect(writeMatrixCloudAtumChoice('agent', 'nguyet-thuc', { destinations, legacy })).resolves.toBe(true)
    expect(destinations.read).toHaveBeenCalledWith('agent')
    expect(destinations.write).toHaveBeenCalledWith('agent', 'cloud', 'nguyet-thuc')
    // Never the 1.1 offer write, which refuses without an offer and cannot clear a plan choice.
    expect(legacy.write).not.toHaveBeenCalled()
    expect(legacy.reload).toHaveBeenCalledWith('agent')
  })

  it('reports a refusal without touching the 1.1 row', async () => {
    const destinations = { view: vi.fn(() => view), read: vi.fn(), write: vi.fn(async () => false) }
    const legacy = { write: vi.fn(async () => true), reload: vi.fn(async () => undefined) }

    await expect(writeMatrixCloudAtumChoice('agent', 'nhat-thuc', { destinations, legacy })).resolves.toBe(false)
    expect(destinations.read).not.toHaveBeenCalled()
    expect(legacy.write).not.toHaveBeenCalled()
    expect(legacy.reload).not.toHaveBeenCalled()
  })

  it('uses the 1.1 offer path only on a build without the destination service', async () => {
    const legacy = { write: vi.fn(async () => true), reload: vi.fn(async () => undefined) }

    await expect(writeMatrixCloudAtumChoice('agent', 'nhat-thuc', { legacy })).resolves.toBe(true)
    expect(legacy.write).toHaveBeenCalledWith('agent', 'nhat-thuc')
    await expect(writeMatrixCloudAtumChoice('agent', 'nhat-thuc', {})).resolves.toBe(false)
  })
})
