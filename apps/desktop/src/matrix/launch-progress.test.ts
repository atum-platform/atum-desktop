import { describe, expect, it } from 'vitest'

import type { MatrixSnapshot } from '../../shared/matrix'

import { LAUNCH_STEPS, launchPercent, launchStepIndex } from './launch-progress'

const base: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'D' },
  rooms: [],
  roomId: null,
  messages: [],
  error: null
}

describe('the launch bar', () => {
  it('only reaches 100 when every check has passed', () => {
    for (let index = 0; index < LAUNCH_STEPS.length; index += 1) {
      expect(launchPercent(index, 10 * 60_000)).toBeLessThan(100)
    }

    expect(launchPercent(LAUNCH_STEPS.length, 0)).toBe(100)
  })

  it('never runs backwards, within a step or from one step to the next', () => {
    let previous = -1

    for (let index = 0; index < LAUNCH_STEPS.length; index += 1) {
      for (const elapsed of [0, 250, 1_000, 5_000, 30_000, 120_000]) {
        const percent = launchPercent(index, elapsed)
        expect(percent).toBeGreaterThanOrEqual(previous)
        previous = percent
      }
    }
  })

  it('keeps moving through a long step instead of looking stuck', () => {
    const assistant = LAUNCH_STEPS.indexOf('assistant')
    expect(launchPercent(assistant, 50_000)).toBeGreaterThan(launchPercent(assistant, 30_000))
    expect(launchPercent(assistant, 70_000)).toBeGreaterThan(launchPercent(assistant, 50_000))
  })
})

describe('where the launch stands', () => {
  it('follows the readiness gate, holding a blocked step and finishing when ready or degraded', () => {
    for (const [index, step] of LAUNCH_STEPS.entries()) {
      expect(launchStepIndex({ ...base, readiness: { phase: 'starting', step, since: 1 } })).toBe(index)
      expect(launchStepIndex({ ...base, readiness: { phase: 'blocked', step, code: 'offline', since: 1 } })).toBe(index)
    }

    expect(launchStepIndex({ ...base, readiness: { phase: 'ready', since: 1 } })).toBe(LAUNCH_STEPS.length)
    expect(launchStepIndex({ ...base, readiness: { phase: 'degraded', since: 1 } })).toBe(LAUNCH_STEPS.length)
  })

  it('maps the older setup steps when there is no gate', () => {
    expect(launchStepIndex({ ...base, state: 'connecting' })).toBe(0)
    expect(launchStepIndex({ ...base, startup: { step: 'assistant', state: 'working' } })).toBe(
      LAUNCH_STEPS.indexOf('assistant')
    )
    expect(launchStepIndex({ ...base, startup: { step: 'model', state: 'working' } })).toBe(LAUNCH_STEPS.indexOf('ai'))
    expect(launchStepIndex(base)).toBe(LAUNCH_STEPS.length)
  })
})
