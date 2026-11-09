import { describe, expect, it } from 'vitest'

import {
  isAtumModelName,
  MATRIX_ATUM_PROVIDER,
  MATRIX_CONNECTED_MODEL_ERRORS,
  MATRIX_DEFAULT_EFFORT,
  MATRIX_DEFAULT_MODEL,
  MATRIX_EFFORTS,
  MATRIX_MODEL_EFFORTS,
  MATRIX_MODEL_LINEUP,
  MATRIX_MODELS,
  matrixConnectedModelEfforts,
  matrixConnectedModelLabel,
  matrixConnectedModelProblem,
  matrixManagedModelLabel,
  matrixModelChoiceContent,
  matrixModelName,
  matrixRequestEffort,
  matrixRequestModel,
  matrixSessionModelSwitch,
  matrixTurnEffort,
  matrixTurnModel,
  parseMatrixConnectedModel,
  parseMatrixEffort,
  parseMatrixModel
} from './matrix-models'

describe("Atum's model lineup", () => {
  it('offers every served model exactly once, starting with the default, and announces the rest', () => {
    const selectable = MATRIX_MODEL_LINEUP.flatMap(row => (row.id ? [row.id] : []))
    expect([...selectable].sort()).toEqual([...MATRIX_MODELS].sort())
    expect(MATRIX_MODEL_LINEUP[0].id).toBe(MATRIX_DEFAULT_MODEL)
    expect(new Set(MATRIX_MODEL_LINEUP.map(row => row.name)).size).toBe(MATRIX_MODEL_LINEUP.length)
  })

  it('gives every managed model a label the frozen catalog grammar accepts', () => {
    for (const model of MATRIX_MODELS) {
      const label = matrixManagedModelLabel(model)

      expect(label, model).toMatch(/^[A-Za-z0-9][A-Za-z0-9 ._+/-]{0,119}$/u)
      expect(label, model).toContain('Thuc')
    }
  })

  it('announces its flagship with no id, and never accepts it as a choice', () => {
    const announced = MATRIX_MODEL_LINEUP.find(row => row.tagline === 'flagship')

    expect(announced).toMatchObject({ id: null, name: 'Thái Cực' })
    expect(announced?.version).toBeUndefined()

    for (const value of ['thai-cuc', announced?.name]) {
      expect(parseMatrixModel(value)).toBeUndefined()
    }

    for (const row of MATRIX_MODEL_LINEUP) {
      if (row.id) {
        expect(MATRIX_MODELS).toContain(row.id)
        expect(matrixModelName(row.id)).toBe(`${row.name} ${row.version}`)
      }
    }
  })

  it('accepts only a served model as a choice', () => {
    for (const model of MATRIX_MODELS) {
      expect(parseMatrixModel(model)).toBe(model)
    }

    for (const value of ['binh-minh', 'thai-cuc', 'NGUYET-THUC', '', null, 1, { model: 'nhat-thuc' }]) {
      expect(parseMatrixModel(value)).toBeUndefined()
    }
  })

  it('answers a turn with the model recorded at send, else the room, else the cheaper default', () => {
    const rooms = [{ id: '!hard:test', model: 'nhat-thuc' as const }, { id: '!plain:test' }]
    expect(matrixTurnModel(rooms, '!plain:test', 'nhat-thuc')).toBe('nhat-thuc')
    expect(matrixTurnModel(rooms, '!hard:test', 'nguyet-thuc')).toBe('nguyet-thuc')
    expect(matrixTurnModel(rooms, '!hard:test')).toBe('nhat-thuc')
    // A record from before the lineup, or a name that is not served, falls back to the room.
    expect(matrixTurnModel(rooms, '!hard:test', 'binh-minh')).toBe('nhat-thuc')
    expect(matrixTurnModel(rooms, '!plain:test')).toBe(MATRIX_DEFAULT_MODEL)
    // Outside any turn, or a room this Mac does not know: the default, never an upgrade.
    expect(matrixTurnModel(rooms, undefined)).toBe(MATRIX_DEFAULT_MODEL)
    expect(matrixTurnModel(rooms, '!gone:test')).toBe(MATRIX_DEFAULT_MODEL)
  })

  it("sends any name of Atum's model, retired ones included, to the chosen model and nothing else", () => {
    for (const requested of [...MATRIX_MODELS, 'binh-minh']) {
      expect(isAtumModelName(requested)).toBe(true)
      expect(matrixRequestModel(requested, 'nhat-thuc')).toBe('nhat-thuc')
    }

    for (const requested of ['gpt-4o', 'openai/gpt-6-sol', '', undefined, 7]) {
      expect(isAtumModelName(requested)).toBe(false)
      expect(matrixRequestModel(requested, 'nhat-thuc')).toBe(requested)
    }
  })
})

describe('thinking level', () => {
  it('reads only the three levels, from the turn first, then the conversation', () => {
    expect(MATRIX_EFFORTS.map(parseMatrixEffort)).toEqual(['low', 'medium', 'high'])
    expect(parseMatrixEffort('max')).toBeUndefined()
    expect(parseMatrixEffort('xhigh')).toBeUndefined()
    const rooms = [{ id: '!a', effort: 'high' as const }, { id: '!b' }]
    expect(matrixTurnEffort(rooms, '!a', 'low')).toBe('low')
    expect(matrixTurnEffort(rooms, '!a', 'max')).toBe('high')
    // Nothing chosen: nothing is sent.
    expect(matrixTurnEffort(rooms, '!b')).toBeUndefined()
  })

  it('keeps the model when the level changes and the level when the model changes', () => {
    expect(matrixModelChoiceContent({ model: 'nhat-thuc' }, { effort: 'low' })).toEqual({
      v: 2,
      source: 'atum',
      model: 'nhat-thuc',
      effort: 'low'
    })
    expect(matrixModelChoiceContent({ model: 'nhat-thuc', effort: 'low' }, { model: 'nguyet-thuc' })).toEqual({
      v: 2,
      source: 'atum',
      model: 'nguyet-thuc',
      effort: 'low'
    })
    // Unknown fields and values never survive a write.
    expect(() => matrixModelChoiceContent({ model: 'gpt-x', effort: 'max', other: 1 }, { effort: 'high' })).toThrow(
      'matrix_model_choice_invalid'
    )
  })

  it('offers Atum levels and preserves the legacy own-profile dial until explicit advertisement', () => {
    for (const model of MATRIX_MODELS) {
      expect(MATRIX_MODEL_EFFORTS[model].length).toBeGreaterThan(0)
      expect(MATRIX_MODEL_EFFORTS[model].every(effort => parseMatrixEffort(effort))).toBe(true)
      // The proxy replaces a stale stored level with this one, so every model must offer it.
      expect(MATRIX_MODEL_EFFORTS[model]).toContain(MATRIX_DEFAULT_EFFORT)
    }

    expect(matrixConnectedModelEfforts({ provider: 'openai-codex', model: 'gpt-5.5', reasoning: true })).toEqual(
      MATRIX_EFFORTS
    )
    expect(
      matrixConnectedModelEfforts({
        provider: 'openai-codex',
        model: 'gpt-5.5',
        capability: { id: 'gpt-5.5', displayName: 'ChatGPT', efforts: ['low', 'high', 'max'] }
      })
    ).toEqual(['low', 'high'])
    expect(matrixConnectedModelEfforts({ provider: 'openai-codex', model: 'gpt-5.5', reasoning: false })).toEqual([])
    expect(matrixRequestEffort({ model: 'm' }, undefined)).toEqual({ model: 'm' })
    expect(matrixRequestEffort({ model: 'm' }, 'high')).toEqual({ model: 'm', reasoning_effort: 'high' })
  })
})

describe('connected model', () => {
  it("reads main's closed reason out of an IPC failure, and calls anything else a plain failure", () => {
    const ipc = (code: string) => new Error(`Error invoking remote method 'matrix:ui': Error: ${code}`)

    expect(matrixConnectedModelProblem(ipc(MATRIX_CONNECTED_MODEL_ERRORS.busy))).toBe('busy')
    expect(matrixConnectedModelProblem(ipc(MATRIX_CONNECTED_MODEL_ERRORS.unavailable))).toBe('unavailable')
    expect(matrixConnectedModelProblem(ipc(MATRIX_CONNECTED_MODEL_ERRORS.failed))).toBe('failed')
    expect(matrixConnectedModelProblem(ipc('matrix_not_ready'))).toBe('failed')
    expect(matrixConnectedModelProblem(undefined)).toBe('failed')
  })

  it('names a known service with its readable model, and anything else by the model alone', () => {
    expect(matrixConnectedModelLabel({ provider: 'openai-codex', model: 'gpt-5.5' })).toBe('ChatGPT · GPT-5.5')
    expect(matrixConnectedModelLabel({ provider: 'atum-provider-1', model: 'llama3.2' })).toBe('Llama3.2')
    expect(matrixConnectedModelLabel({ provider: 'constructor', model: 'm' })).toBe('M')
  })

  it('parses only plain names', () => {
    expect(parseMatrixConnectedModel({ provider: 'openai-codex', model: 'gpt-5.5', reasoning: true })).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.5',
      reasoning: true
    })
    expect(parseMatrixConnectedModel({ provider: 'openai-codex', model: 'gpt 5' })).toBeUndefined()
    expect(parseMatrixConnectedModel({ provider: '', model: 'gpt-5.5' })).toBeUndefined()
    // It becomes part of a /model command: never a flag.
    expect(parseMatrixConnectedModel({ provider: 'openai-codex', model: '--global' })).toBeUndefined()
    expect(parseMatrixConnectedModel({ provider: '--provider', model: 'gpt-5.5' })).toBeUndefined()
    expect(parseMatrixConnectedModel(null)).toBeUndefined()
  })

  it('switches a resumed session only when it runs on something else', () => {
    const chatgpt = { provider: 'openai-codex', model: 'gpt-5.5' }
    const atum = { provider: MATRIX_ATUM_PROVIDER, model: 'nguyet-thuc' }
    expect(matrixSessionModelSwitch({ model: 'gpt-5.5', provider: 'openai-codex' }, chatgpt)).toBeUndefined()
    expect(matrixSessionModelSwitch({ model: 'nhat-thuc', provider: 'custom:atum' }, chatgpt)).toBe(
      'gpt-5.5 --provider openai-codex --session'
    )
    // Same model name through another service is another model.
    expect(matrixSessionModelSwitch({ model: 'gpt-5.5', provider: 'openai-api' }, chatgpt)).toBe(
      'gpt-5.5 --provider openai-codex --session'
    )
    // Any of Atum's names is Atum's model: the proxy chooses among them per request.
    expect(matrixSessionModelSwitch({ model: 'binh-minh', provider: 'custom' }, atum)).toBeUndefined()
    expect(matrixSessionModelSwitch({ model: 'gpt-5.5', provider: 'openai-codex' }, atum)).toBe(
      'nguyet-thuc --provider atum-gateway --session'
    )
    // A named endpoint reports itself as custom: its model name decides.
    expect(
      matrixSessionModelSwitch(
        { model: 'llama3.2', provider: 'custom:ollama' },
        { provider: 'atum-provider-1', model: 'llama3.2' }
      )
    ).toBeUndefined()
    // Not built yet: it will be built on the profile's model.
    expect(matrixSessionModelSwitch({}, chatgpt)).toBeUndefined()
    expect(matrixSessionModelSwitch(undefined, chatgpt)).toBeUndefined()
  })
})
