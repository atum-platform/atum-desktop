import { describe, expect, it } from 'vitest'

import { greetingFor } from './greeting'

describe("the assistant's greeting", () => {
  it('follows the time of day: morning from 5, afternoon from noon, evening from 6 pm', () => {
    expect([4, 5, 11, 12, 17, 18, 23, 0].map(greetingFor)).toEqual([
      'greetEvening',
      'greetMorning',
      'greetMorning',
      'greetAfternoon',
      'greetAfternoon',
      'greetEvening',
      'greetEvening',
      'greetEvening'
    ])
  })
})
