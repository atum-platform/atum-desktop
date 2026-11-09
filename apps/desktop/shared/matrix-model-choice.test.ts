import { describe, expect, it } from 'vitest'

import {
  MATRIX_MODEL_CHOICE_PIN,
  parseMatrixModelCapabilities,
  parseMatrixModelChoice,
  readMatrixModelChoice,
  writeMatrixModelChoice
} from './matrix-model-choice'

// Verbatim JSON values from frozen model-choice/1; no sibling checkout needed in app CI.
const fixtures = [
  {
    name: 'fixtures/choice-legacy.json',
    accepted: true,
    input: {
      model: 'binh-minh'
    }
  },
  {
    name: 'fixtures/choice-atum.json',
    accepted: true,
    input: {
      v: 2,
      source: 'atum',
      model: 'nguyet-thuc',
      effort: 'medium'
    }
  },
  {
    name: 'fixtures/choice-default-effort.json',
    accepted: true,
    input: {
      v: 2,
      source: 'atum',
      model: 'nguyet-thuc'
    }
  },
  {
    name: 'fixtures/choice-connection.json',
    accepted: true,
    input: {
      v: 2,
      source: 'connection',
      connectionId: 'openai-key',
      model: 'gpt-6-luna'
    }
  },
  {
    name: 'fixtures/choice-agents.json',
    accepted: true,
    input: {
      v: 2,
      source: 'atum',
      model: 'nguyet-thuc',
      effort: 'medium',
      agents: {
        '00000000-0000-4000-8000-bd7662a5eeb4': {
          v: 2,
          source: 'connection',
          connectionId: 'openai-key',
          model: 'gpt-6-luna',
          effort: 'high'
        }
      }
    }
  },
  {
    name: 'fixtures/choice-put.json',
    accepted: true,
    input: {
      v: 2,
      source: 'atum',
      model: 'nguyet-thuc',
      effort: 'medium'
    }
  },
  {
    name: 'fixtures/choice-effort-unknown.json',
    accepted: false,
    input: {
      v: 2,
      source: 'atum',
      model: 'nguyet-thuc',
      effort: 'xhigh'
    }
  },
  {
    name: 'fixtures/choice-connection-missing-id.json',
    accepted: false,
    input: {
      v: 2,
      source: 'connection',
      model: 'gpt-6-luna'
    }
  },
  {
    name: 'fixtures/choice-atum-with-connection.json',
    accepted: false,
    input: {
      v: 2,
      source: 'atum',
      model: 'nguyet-thuc',
      effort: 'medium',
      connectionId: 'openai-key'
    }
  },
  {
    name: 'fixtures/choice-v2-downgrade.json',
    accepted: false,
    input: {
      source: 'connection',
      model: 'gpt-6-luna',
      connectionId: 'openai-key'
    }
  },
  {
    name: 'fixtures/choice-agents-invalid-value.json',
    accepted: false,
    input: {
      v: 2,
      source: 'atum',
      model: 'nguyet-thuc',
      effort: 'medium',
      agents: {
        '00000000-0000-4000-8000-bd7662a5eeb4': 42
      }
    }
  },
  {
    name: 'fixtures/choice-agents-invalid-key.json',
    accepted: false,
    input: {
      v: 2,
      source: 'atum',
      model: 'nguyet-thuc',
      effort: 'medium',
      agents: {
        wrong: {
          v: 2,
          source: 'atum',
          model: 'nguyet-thuc',
          effort: 'medium'
        }
      }
    }
  },
  {
    name: 'fixtures/choice-endpoint-model.json',
    accepted: false,
    input: {
      v: 2,
      source: 'atum',
      model: 'https://example.test/v1',
      effort: 'medium'
    }
  },
  {
    name: 'fixtures/choice-secret-root.json',
    accepted: false,
    input: {
      v: 2,
      source: 'atum',
      model: 'nguyet-thuc',
      effort: 'medium',
      token: 'synthetic-canary'
    }
  }
]

const principal = '00000000-0000-4000-8000-bd7662a5eeb4'
const other = '00000000-0000-4000-8000-b454f82c5857'
const atum = { v: 2 as const, source: 'atum' as const, model: 'nguyet-thuc', effort: 'medium' as const }
const own = { v: 2 as const, source: 'connection' as const, connectionId: 'personal-key', model: 'openai/gpt-6-luna' }

describe('the pinned private model choice', () => {
  it.each(fixtures)('$name follows the frozen contract', ({ input, accepted }) => {
    expect(parseMatrixModelChoice(input) !== undefined).toBe(accepted)
    expect(MATRIX_MODEL_CHOICE_PIN).toBe('275f382825eb1752d1046aca15dacabd8a22ff324c63c6c6e8aa726f388b1667')
  })

  it('keeps the ordinary effort shipped by 0.18.3 without weakening the canonical contract', () => {
    const old = { model: 'nhat-thuc', effort: 'high' }
    expect(parseMatrixModelChoice(old)).toBeUndefined()
    expect(readMatrixModelChoice(old)).toEqual({ ...old, v: 2, source: 'atum' })
    // The default chip in 0.18.3 wrote effort alone until a model was explicitly picked.
    expect(readMatrixModelChoice({ effort: 'high' })).toEqual({
      v: 2,
      source: 'atum',
      model: 'nguyet-thuc',
      effort: 'high'
    })

    for (const extra of [{ v: 1 }, { connectionId: 'x' }, { source: 'connection' }, { api_key: 'canary' }]) {
      expect(readMatrixModelChoice({ ...old, ...extra })).toBeUndefined()
    }

    expect(readMatrixModelChoice({ model: 'nhat-thuc', effort: 'max' })).toBeUndefined()
  })

  it('writes v2 with an old-readable model and preserves all assistant choices without mutation', () => {
    const existing = { ...atum, agents: { [principal]: own, [other]: atum } }
    const before = structuredClone(existing)
    const written = writeMatrixModelChoice(existing, { ...atum, model: 'nhat-thuc' })
    expect(written.agents).toEqual(existing.agents)
    expect(existing).toEqual(before)
    // The installed 0.18.x reader only reads content.model.
    expect(written.model).toBe('nhat-thuc')
    expect(writeMatrixModelChoice(existing, { ...own, effort: 'low' }, principal)).toEqual({
      ...existing,
      agents: { [principal]: { ...own, effort: 'low' }, [other]: atum }
    })
  })

  it('never erases a malformed record or accepts arbitrary principal/entry fields', () => {
    for (const existing of [null, {}, { ...atum, agents: { owner: own } }, { ...atum, v: 99 }]) {
      expect(() => writeMatrixModelChoice(existing, atum)).toThrow('matrix_model_choice_invalid')
    }

    expect(() => writeMatrixModelChoice(undefined, own, principal)).toThrow('matrix_model_choice_invalid')
    expect(() => writeMatrixModelChoice(atum, own, 'owner')).toThrow('matrix_model_choice_invalid')
    expect(() => writeMatrixModelChoice(atum, { ...own, token: 'canary' })).toThrow('matrix_model_choice_invalid')
    expect(() => writeMatrixModelChoice(atum, { ...atum, agents: {} })).toThrow('matrix_model_choice_invalid')
  })

  it('rejects cyclic/prototype/nonobject and out-of-bound model inputs', () => {
    const cycle: Record<string, unknown> = { ...atum }
    cycle.agents = cycle

    for (const input of [
      cycle,
      Object.create(atum),
      [],
      false,
      { ...atum, model: 'x'.repeat(201) },
      { ...atum, model: 'two words' }
    ]) {
      expect(parseMatrixModelChoice(input)).toBeUndefined()
    }
  })

  it('offers only validated advertised levels, including an empty nonreasoning list', () => {
    expect(
      parseMatrixModelCapabilities({ id: 'gpt-6-luna', displayName: 'A model', efforts: ['high', 'low'] })?.efforts
    ).toEqual(['high', 'low'])
    expect(parseMatrixModelCapabilities({ id: 'm', displayName: 'M', efforts: [] })?.efforts).toEqual([])

    for (const efforts of [undefined, ['xhigh'], ['high', 'high'], 'high']) {
      expect(parseMatrixModelCapabilities({ id: 'm', displayName: 'M', efforts })).toBeUndefined()
    }

    expect(parseMatrixModelCapabilities({ id: 'm', displayName: 'M', efforts: [], endpoint: 'canary' })).toBeUndefined()
    expect(parseMatrixModelCapabilities({ id: 'm', displayName: 'M', efforts: ['low'] })?.efforts).not.toBeUndefined()
  })
})
