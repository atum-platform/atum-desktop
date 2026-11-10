import { describe, expect, it } from 'vitest'

import {
  MATRIX_PROTONS_PER_USD,
  matrixShelfModelView,
  matrixShelfProtons,
  matrixShelfProtonsLabel,
  parseMatrixShelfModel
} from './matrix-shelf-models'

const row = (overrides: Partial<Parameters<typeof matrixShelfModelView>[0]> = {}) => ({
  alias: 'opus',
  displayName: 'Anthropic: Claude Opus 5.5',
  providerModel: 'anthropic/claude-opus-5.5',
  inputUsdPerMtok: '4',
  outputUsdPerMtok: '20',
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'high',
  ...overrides
})

describe('the OpenRouter shelf', () => {
  it('prices a USD figure on Atum’s own basis, exactly', () => {
    expect(matrixShelfProtons('1')).toBe(MATRIX_PROTONS_PER_USD)
    expect(matrixShelfProtons('0.0335')).toBe(1356.75)
    expect(matrixShelfProtons('0.006')).toBe(243)
    expect(matrixShelfProtons('2.00')).toBe(81_000)

    // Never a guess from a malformed or missing figure.
    for (const value of [undefined, '', '-1', '1e3', '01', '1.123456789', 1]) {
      expect(matrixShelfProtons(value)).toBeUndefined()
    }
  })

  it('names the model without its maker, keeps the maker apart, and labels one that costs more than Nhật Thực', () => {
    expect(matrixShelfModelView(row())).toEqual({
      alias: 'opus',
      name: 'Claude Opus 5.5',
      maker: { id: 'anthropic', label: 'Anthropic' },
      inputProtonsPerMtok: 162_000,
      outputProtonsPerMtok: 810_000,
      costly: true,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high'
    })

    // Nhật Thực's own price (2 / 10 USD) is not "more".
    expect(matrixShelfModelView(row({ alias: 'sonnet', inputUsdPerMtok: '2', outputUsdPerMtok: '10' }))?.costly).toBe(
      false
    )
    // Either figure above Nhật Thực is enough.
    expect(matrixShelfModelView(row({ alias: 'gemini-pro', inputUsdPerMtok: '2', outputUsdPerMtok: '12' }))?.costly).toBe(
      true
    )
  })

  it('draws nothing for a row missing its name, maker or price, or for an alias outside the shelf', () => {
    expect(matrixShelfModelView(row({ outputUsdPerMtok: undefined }))).toBeUndefined()
    expect(matrixShelfModelView(row({ displayName: '  ' }))).toBeUndefined()
    expect(matrixShelfModelView(row({ providerModel: undefined }))).toBeUndefined()
    expect(matrixShelfModelView(row({ alias: 'nhat-thuc' }))).toBeUndefined()
    expect(parseMatrixShelfModel('nguyet-thuc')).toBeUndefined()
    expect(parseMatrixShelfModel('glm-plus')).toBe('glm-plus')
  })

  it('reads only a retention the platform names, and only the levels a picker knows', () => {
    expect(matrixShelfModelView(row({ retention: 'safety_retention' }))?.retention).toBe('safety_retention')
    expect(matrixShelfModelView(row({ retention: 'forever' }))?.retention).toBeUndefined()
    expect(matrixShelfModelView(row({ efforts: ['low', 'max'], defaultEffort: 'max' }))).toMatchObject({
      efforts: ['low']
    })
    expect(matrixShelfModelView(row({ efforts: ['low', 'max'], defaultEffort: 'max' }))?.defaultEffort).toBeUndefined()
  })

  it('takes the maker’s name from the server’s display name, and from its own list only without one', () => {
    expect(matrixShelfModelView(row({ providerModel: 'x-ai/grok-4.7', displayName: 'SpaceXAI: Grok 4.7' }))?.maker).toEqual({
      id: 'x-ai',
      label: 'SpaceXAI'
    })
    expect(matrixShelfModelView(row({ providerModel: 'x-ai/grok-4.7', displayName: 'Grok 4.7' }))).toMatchObject({
      name: 'Grok 4.7',
      maker: { id: 'x-ai', label: 'xAI' }
    })
    expect(matrixShelfModelView(row({ providerModel: 'z-ai/glm-5.3-flash', displayName: 'Z.ai: GLM 5.3 Flash' }))).toMatchObject({
      name: 'GLM 5.3 Flash',
      maker: { id: 'z-ai', label: 'Z.ai' }
    })
    expect(matrixShelfModelView(row({ providerModel: 'acme/x-1', displayName: 'Acme Labs: X 1' }))?.maker).toEqual({
      id: 'acme',
      label: 'Acme Labs'
    })
  })

  it('groups whole Protons the reader’s way', () => {
    expect(matrixShelfProtonsLabel(810_000, 'en')).toBe('810,000')
    expect(matrixShelfProtonsLabel(1356.75, 'vi')).toBe('1.357')
  })
})
