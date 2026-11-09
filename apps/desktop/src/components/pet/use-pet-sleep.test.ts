import { describe, expect, it } from 'vitest'

import { shouldSleep, SLEEP_AFTER_MS, SLEEP_HOLD_MS } from './use-pet-sleep'

describe('sleep trigger', () => {
  it('is a long idle of the person, and only that', () => {
    expect(shouldSleep(SLEEP_AFTER_MS - 1)).toBe(false)
    expect(shouldSleep(SLEEP_AFTER_MS)).toBe(true)
    expect(shouldSleep(0)).toBe(false)
  })

  it('holds long enough that the wander never walks out from under it before the renewal', () => {
    // Renewed every second while idle; the hold only has to outlast the tick comfortably.
    expect(SLEEP_HOLD_MS).toBeGreaterThan(10_000)
    expect(SLEEP_AFTER_MS).toBeGreaterThanOrEqual(60_000)
  })
})
