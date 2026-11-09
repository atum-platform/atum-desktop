import { describe, expect, it } from 'vitest'

import { restartPhases } from './update-timing'

describe('restart phase measurements', () => {
  const start = Date.parse('2026-11-07T01:00:00Z')
  it('attributes only the active restart and preserves real time between milestones', () => {
    const log = [
      '2026-11-07T00:00:01Z Beginning installation',
      '2026-11-07T01:00:02Z Beginning installation',
      '2026-11-07T01:00:05Z Moving bundle from old',
      '2026-11-07T01:00:05.004Z Moving bundle from new',
      '2026-11-07T01:00:07Z Installation completed successfully',
      '2026-11-07T01:00:08Z Successfully launched application',
      '2026-11-07T02:00:02Z Beginning installation'
    ].join('\n')

    expect(restartPhases(log, start, start + 9000)).toEqual({
      teardown: 2000, prepare: 3000, swap: 4, cleanup: 1996, relaunch: 1000, window: 1000
    })
  })
  it('does not invent timings for malformed or missing milestones', () => {
    expect(restartPhases('broken timestamp Moving bundle from\n2026-11-07T01:00:02Z Successfully launched application', start, start + 9000)).toEqual({})
  })
})
