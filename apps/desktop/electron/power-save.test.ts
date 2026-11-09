import { describe, expect, it, vi } from 'vitest'

import { createAtumKeepAwake, createKeepAwake, type PowerSaveBlockerLike } from './power-save'

function fakeBlocker() {
  let next = 1
  const started = new Set<number>()

  const blocker: PowerSaveBlockerLike = {
    isStarted: id => started.has(id),
    start: vi.fn(() => {
      const id = next++
      started.add(id)

      return id
    }),
    stop: vi.fn(id => void started.delete(id))
  }

  return { blocker, started }
}

describe('createKeepAwake', () => {
  it('starts once, is idempotent, and stops', () => {
    const { blocker } = fakeBlocker()
    const keepAwake = createKeepAwake(blocker)

    expect(keepAwake.isActive()).toBe(false)
    expect(keepAwake.set(true)).toBe(true)
    keepAwake.set(true) // idempotent — no second blocker
    expect(blocker.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension')

    expect(keepAwake.set(false)).toBe(false)
    keepAwake.set(false)
    expect(blocker.stop).toHaveBeenCalledTimes(1)
  })

  it('re-arms after the OS dropped the blocker', () => {
    const { blocker, started } = fakeBlocker()
    const keepAwake = createKeepAwake(blocker)

    keepAwake.set(true)
    started.clear() // system released it out from under us
    expect(keepAwake.isActive()).toBe(false)

    keepAwake.set(true)
    expect(blocker.start).toHaveBeenCalledTimes(2)
    expect(keepAwake.isActive()).toBe(true)
  })

  it('honors a custom blocker type', () => {
    const { blocker } = fakeBlocker()
    createKeepAwake(blocker, 'prevent-display-sleep').set(true)

    expect(blocker.start).toHaveBeenCalledWith('prevent-display-sleep')
  })
})

describe('createAtumKeepAwake', () => {
  it('shares one blocker across every active reason', () => {
    const { blocker } = fakeBlocker()
    const transitions = vi.fn()
    const keepAwake = createAtumKeepAwake(blocker, { onTransition: transitions })

    keepAwake.setReason('listening', true)
    keepAwake.setReason('cloud_device', true)
    keepAwake.setReason('failover_chain', true)
    expect(blocker.start).toHaveBeenCalledTimes(1)

    keepAwake.setReason('listening', false)
    keepAwake.setReason('cloud_device', false)
    expect(keepAwake.isActive()).toBe(true)
    keepAwake.setReason('failover_chain', false)
    expect(keepAwake.isActive()).toBe(false)
    expect(blocker.stop).toHaveBeenCalledTimes(1)
    expect(transitions).toHaveBeenLastCalledWith(false, 'failover_chain')
  })

  it('the setting releases every reason without erasing it', () => {
    const { blocker } = fakeBlocker()
    const keepAwake = createAtumKeepAwake(blocker)

    keepAwake.setReason('listening', true)
    keepAwake.setReason('cloud_device', true)
    keepAwake.setEnabled(false)
    expect(keepAwake.isActive()).toBe(false)
    expect(keepAwake.isEligible()).toBe(false)

    keepAwake.setEnabled(true)
    expect(keepAwake.isActive()).toBe(true)
    expect(blocker.start).toHaveBeenCalledTimes(2)
  })

  it('a desktop with no battery is always eligible; a MacBook on battery still is, while the row is on (FC D3, loosened 10-20)', () => {
    const { blocker } = fakeBlocker()
    // Electron reports `isOnBatteryPower() === false` for a Mac with no battery, so it never leaves AC.
    const desktop = createAtumKeepAwake(blocker, { onBattery: false })
    expect(desktop.isEligible()).toBe(true)

    const macbook = createAtumKeepAwake(blocker)
    expect(macbook.isEligible()).toBe(true)
    macbook.setOnBattery(true)
    expect(macbook.isEligible()).toBe(true)
    macbook.setOnBattery(false)
    expect(macbook.isEligible()).toBe(true)
    macbook.setEnabled(false)
    expect(macbook.isEligible()).toBe(false)
  })

  it('a MacBook releases on battery and re-arms on AC', () => {
    const { blocker } = fakeBlocker()
    const transitions = vi.fn()
    const keepAwake = createAtumKeepAwake(blocker, { onTransition: transitions })

    keepAwake.setReason('cloud_device', true)
    keepAwake.setOnBattery(true)
    // The sleep blocker is released on battery, but the Mac still answers while it is awake.
    expect(keepAwake.isActive()).toBe(false)
    expect(keepAwake.isEligible()).toBe(true)
    expect(transitions).toHaveBeenLastCalledWith(false, 'battery')

    keepAwake.setOnBattery(false)
    expect(keepAwake.isActive()).toBe(true)
    expect(keepAwake.isEligible()).toBe(true)
    expect(transitions).toHaveBeenLastCalledWith(true, 'cloud_device')
  })
})
