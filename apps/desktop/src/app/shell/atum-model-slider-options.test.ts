import { describe, expect, it } from 'vitest'

import { atumModelSliderOptions, atumThinkingSliderOptions } from './atum-model-slider-options'

describe('atumModelSliderOptions', () => {
  it('uses only catalogued managed models and their advertised effort depths', () => {
    expect(
      atumModelSliderOptions([
        {
          capabilities: {
            'binh-minh': { efforts: ['low', 'high', 'max'], fast: false, reasoning: true },
            'nguyet-thuc': { efforts: ['max', 'low', 'high'], fast: false, reasoning: true },
            'nhat-thuc': { efforts: ['max', 'high', 'low'], fast: false, reasoning: true }
          },
          models: ['binh-minh', 'nguyet-thuc', 'nhat-thuc', 'unmanaged-preview'],
          name: 'Atum',
          slug: 'atum-managed'
        }
      ])
    ).toEqual([
      { effort: 'low', model: 'binh-minh', provider: 'atum-managed', unavailable: false },
      { effort: 'high', model: 'nguyet-thuc', provider: 'atum-managed', unavailable: false },
      { effort: 'max', model: 'nhat-thuc', provider: 'atum-managed', unavailable: true }
    ])
  })

  it('does not invent an effort when the backend has not advertised one', () => {
    expect(
      atumModelSliderOptions([
        {
          capabilities: { 'binh-minh': { fast: false, reasoning: true } },
          models: ['binh-minh'],
          name: 'Atum',
          slug: 'atum-managed'
        }
      ])
    ).toEqual([{ model: 'binh-minh', provider: 'atum-managed', unavailable: false }])
  })
})

describe('atumThinkingSliderOptions', () => {
  it('orders only supported thinking levels without changing the named model', () => {
    const options = atumThinkingSliderOptions(
      [
        {
          slug: 'atum-managed',
          name: 'Atum',
          models: ['nguyet-thuc'],
          capabilities: { 'nguyet-thuc': { efforts: ['max', 'low', 'high'], reasoning: true, fast: false } }
        }
      ],
      'nguyet-thuc'
    )

    expect(options.map(option => option.effort)).toEqual(['low', 'high', 'max'])
    expect(options.every(option => option.model === 'nguyet-thuc' && option.provider === 'atum-managed')).toBe(true)
  })

  it('does not invent thinking levels for models without advertised reasoning', () => {
    expect(
      atumThinkingSliderOptions([{ slug: 'atum-managed', name: 'Atum', models: ['binh-minh'] }], 'binh-minh')
    ).toEqual([{ model: 'binh-minh', provider: 'atum-managed', unavailable: false }])
    expect(atumThinkingSliderOptions([], 'unknown')).toEqual([])
  })
})
