import { describe, expect, it } from 'vitest'

import { MatrixDeviceLedger } from './device-ledger'

function ledger() {
  let saved: string | null = null

  return {
    ledger: new MatrixDeviceLedger({
      read: () => saved,
      write: value => {
        saved = value
      }
    }),
    saved: () => saved
  }
}

const MINI = { userId: '@fixture-owner:atumplatform.com', deviceId: 'ATUM_a732c84e25b549e2c5be1f60' }

describe('the keys this Mac’s own devices had when they were last ready', () => {
  it('records a device’s key once and recognises it afterwards, with no one in the clear', () => {
    const { ledger: devices, saved } = ledger()

    expect(devices.observe(MINI, 'ed25519-one')).toBe('first')
    expect(devices.observe(MINI, 'ed25519-one')).toBe('same')
    expect(saved()).not.toContain('@fixture-owner')
    expect(saved()).not.toContain('ATUM_a732')
  })

  it('says the device was replaced when its key changed under the same ID, and keeps the old key', () => {
    const { ledger: devices } = ledger()
    devices.observe(MINI, 'ed25519-one')

    expect(devices.observe(MINI, 'ed25519-two')).toBe('replaced')
    // Still replaced on the next look: the new key is never taken as the device's own.
    expect(devices.observe(MINI, 'ed25519-two')).toBe('replaced')
    // Another device of the account is its own entry.
    expect(devices.observe({ ...MINI, deviceId: 'ATUM_new' }, 'ed25519-two')).toBe('first')
  })

  it('forgets a device that is gone, and ignores keys it cannot use', () => {
    const { ledger: devices } = ledger()
    devices.observe(MINI, 'ed25519-one')
    devices.forget(MINI)
    expect(devices.observe(MINI, 'ed25519-two')).toBe('first')
    expect(devices.observe(MINI, '')).toBe('same')
  })

  it('survives an unreadable or unwritable store', () => {
    const broken = new MatrixDeviceLedger({
      read: () => 'not json',
      write: () => {
        throw new Error('disk full')
      }
    })

    expect(broken.observe(MINI, 'ed25519-one')).toBe('first')
    expect(() => broken.forget(MINI)).not.toThrow()
  })
})
