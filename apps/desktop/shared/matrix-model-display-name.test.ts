import { describe, expect, it } from 'vitest'

import { matrixModelDisplayName } from './matrix-model-display-name'

describe('a model’s readable name', () => {
  it('derives a clean name from an identifier', () => {
    expect(matrixModelDisplayName('gpt-5.6-luna')).toBe('GPT-5.6 Luna')
    expect(matrixModelDisplayName('gpt-6-sol')).toBe('GPT-6 Sol')
    expect(matrixModelDisplayName('kimi-k3')).toBe('Kimi K3')
    expect(matrixModelDisplayName('glm-5.3')).toBe('GLM 5.3')
    expect(matrixModelDisplayName('minimax-m3')).toBe('MiniMax M3')
    expect(matrixModelDisplayName('claude-opus-5-5')).toBe('Claude Opus 5 5')
    expect(matrixModelDisplayName('org/model')).toBe('Org Model')
  })

  it('keeps the catalog’s display name when it has one', () => {
    expect(matrixModelDisplayName('gpt-5.6-luna', 'GPT-5.6 Luna')).toBe('GPT-5.6 Luna')
    expect(matrixModelDisplayName('nguyet-thuc', 'Nguyệt Thực 1.3')).toBe('Nguyệt Thực 1.3')
    // The catalog repeating the id is not a display name.
    expect(matrixModelDisplayName('gpt-5.6-luna', 'gpt-5.6-luna')).toBe('GPT-5.6 Luna')
    expect(matrixModelDisplayName('kimi-k3', '  ')).toBe('Kimi K3')
  })
})
