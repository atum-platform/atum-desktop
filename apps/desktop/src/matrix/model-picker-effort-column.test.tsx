import { describe, expect, it } from 'vitest'

import { pickerEffortChoice } from './model-picker-effort-column'

describe('which thinking levels the picker offers for a model', () => {
  it('offers no column for a model with one level or none: nothing to choose', () => {
    expect(pickerEffortChoice({ efforts: undefined })).toBeUndefined()
    expect(pickerEffortChoice({ efforts: [] })).toBeUndefined()
    expect(pickerEffortChoice({ efforts: ['medium'], value: 'medium' })).toBeUndefined()
  })

  it('lists levels from quicker to more thorough, whatever order the model sends them in', () => {
    expect(pickerEffortChoice({ efforts: ['high', 'low', 'medium'] })?.levels).toEqual(['low', 'medium', 'high'])
  })

  it('leaves out levels no choice can be saved with', () => {
    // `max` is advertised by some models but is not a level a conversation or plan choice takes.
    expect(pickerEffortChoice({ efforts: ['medium', 'max'] })).toBeUndefined()
    expect(pickerEffortChoice({ efforts: ['low', 'high', 'max', 'xhigh'] })?.levels).toEqual(['low', 'high'])
  })

  it('marks the model’s own default, else Balanced when offered', () => {
    expect(pickerEffortChoice({ efforts: ['low', 'medium', 'high'], defaultEffort: 'high' })?.defaultLevel).toBe('high')
    expect(pickerEffortChoice({ efforts: ['low', 'medium', 'high'] })?.defaultLevel).toBe('medium')
    expect(pickerEffortChoice({ efforts: ['low', 'high'] })?.defaultLevel).toBeUndefined()
  })

  it('selects the saved level, and the default when nothing (or an unoffered level) was saved', () => {
    expect(pickerEffortChoice({ efforts: ['low', 'medium', 'high'], value: 'low' })?.selected).toBe('low')
    expect(pickerEffortChoice({ efforts: ['low', 'medium', 'high'] })?.selected).toBe('medium')
    expect(pickerEffortChoice({ efforts: ['low', 'high'], defaultEffort: 'low', value: 'medium' })?.selected).toBe('low')
  })
})
