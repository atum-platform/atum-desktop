import { describe, expect, it } from 'vitest'

import type { MatrixIdentity } from '../../shared/matrix'
import type { MatrixOwnDevice, MatrixOwnDevices } from '../../shared/matrix-security'

import {
  matrixNewSignInDevice,
  MatrixNewSignInLedger,
  matrixNewSignInSameScope,
  matrixNewSignInScope,
  matrixNewSignInView
} from './new-sign-in-alert'

const IDENTITY: MatrixIdentity = { userId: '@owner:test', deviceId: 'THIS_MAC' }
const NOW = Date.UTC(2026, 9, 19, 9)

const phone: MatrixOwnDevice = {
  deviceId: 'PHONE',
  name: 'iPhone mẫu',
  lastSeenAt: NOW - 60_000,
  signedByOwner: true,
  crossSigningVerified: true
}

const tablet: MatrixOwnDevice = {
  deviceId: 'TABLET',
  name: 'iPad',
  lastSeenAt: NOW - 120_000,
  signedByOwner: true,
  crossSigningVerified: true
}

const laptop: MatrixOwnDevice = {
  deviceId: 'LAPTOP',
  name: 'MacBook Air',
  lastSeenAt: NOW,
  signedByOwner: true,
  crossSigningVerified: true
}

const own: MatrixOwnDevices = { identity: 'verified', devices: [phone, tablet] }

const identityOf = (
  devices: MatrixOwnDevice[],
  trust: MatrixOwnDevices['identity'] = 'verified'
): MatrixOwnDevices => ({
  identity: trust,
  devices
})

function memoryStore() {
  let value: string | null = null

  return {
    get: () => value,
    store: {
      read: () => value,
      write: (next: string) => {
        value = next
      }
    }
  }
}

describe('new sign-in decision', () => {
  it('baselines every device already present and raises nothing', () => {
    expect(matrixNewSignInDevice({ read: own, identity: IDENTITY, acknowledged: null })).toMatchObject({
      alert: null
    })
    expect(matrixNewSignInDevice({ read: own, identity: IDENTITY, acknowledged: null }).baseline).toHaveLength(2)
  })

  it('raises the newest device this Mac has never accounted for', () => {
    const baseline = matrixNewSignInDevice({ read: own, identity: IDENTITY, acknowledged: null }).baseline!
    const read = identityOf([phone, tablet, { ...laptop, lastSeenAt: NOW - 180_000 }])

    expect(matrixNewSignInDevice({ read, identity: IDENTITY, acknowledged: baseline })).toEqual({
      alert: { deviceId: 'LAPTOP', name: 'MacBook Air' }
    })
  })

  it('uses the most recently active device when several are new', () => {
    const baseline = matrixNewSignInDevice({ read: own, identity: IDENTITY, acknowledged: null }).baseline!
    const older: MatrixOwnDevice = { ...laptop, deviceId: 'OLDER', name: 'Old phone', lastSeenAt: NOW - 10_000 }
    const read = identityOf([phone, tablet, older, laptop])

    expect(matrixNewSignInDevice({ read, identity: IDENTITY, acknowledged: baseline })).toEqual({
      alert: { deviceId: 'LAPTOP', name: 'MacBook Air' }
    })
  })

  it('never raises this Mac, an acknowledged device, an Atum participant, or an excluded device', () => {
    const baseline = matrixNewSignInDevice({ read: own, identity: IDENTITY, acknowledged: null }).baseline!
    const companion: MatrixOwnDevice = { ...laptop, deviceId: 'ATUM_COMPANION_01234567-89ab-4cde-8f01-23456789abcd' }
    const agent: MatrixOwnDevice = { ...laptop, deviceId: 'ATUM_AGENT_EXECUTOR' }
    const app: MatrixOwnDevice = { ...laptop, deviceId: 'ATUM_APP_BOT_MOON_1' }
    const enrolled: MatrixOwnDevice = { ...laptop, deviceId: 'MAC_ENROLLED_AGENT' }

    const read = identityOf([
      phone,
      tablet,
      { ...laptop, deviceId: IDENTITY.deviceId, name: 'This Mac' },
      companion,
      agent,
      app
    ])

    expect(matrixNewSignInDevice({ read, identity: IDENTITY, acknowledged: baseline })).toEqual({ alert: null })
    expect(
      matrixNewSignInDevice({
        read: identityOf([...read.devices, enrolled]),
        identity: IDENTITY,
        acknowledged: baseline,
        excluded: new Set([enrolled.deviceId])
      })
    ).toEqual({ alert: null })
  })

  it('shows a generic name (no name field) for an unnamed device and strips control characters', () => {
    const unnamed: MatrixOwnDevice = { ...laptop, name: undefined }
    const noisy: MatrixOwnDevice = { ...laptop, deviceId: 'NOISY', name: `  Mac\u0000Book\nAir  ` }
    const baseline = matrixNewSignInDevice({ read: own, identity: IDENTITY, acknowledged: null }).baseline!

    expect(
      matrixNewSignInDevice({ read: identityOf([phone, unnamed]), identity: IDENTITY, acknowledged: baseline })
    ).toEqual({ alert: { deviceId: 'LAPTOP' } })
    expect(
      matrixNewSignInDevice({ read: identityOf([phone, noisy]), identity: IDENTITY, acknowledged: baseline })
    ).toEqual({ alert: { deviceId: 'NOISY', name: 'Mac Book Air' } })
  })
})

describe('new sign-in ledger', () => {
  it('baselines once, raises a later device, and keeps a dismissal across a restart', () => {
    const memory = memoryStore()
    const first = new MatrixNewSignInLedger(memory.store)

    expect(first.observe(IDENTITY, own)).toBeNull()
    expect(first.observe(IDENTITY, identityOf([phone, tablet, laptop]))).toEqual({
      deviceId: 'LAPTOP',
      name: 'MacBook Air'
    })

    first.acknowledge(IDENTITY, 'LAPTOP')
    expect(new MatrixNewSignInLedger(memory.store).observe(IDENTITY, identityOf([phone, tablet, laptop]))).toBeNull()
  })

  it('keeps each account sign-in apart and remembers a baseline even before the alert is dismissed', () => {
    const memory = memoryStore()
    const ledger = new MatrixNewSignInLedger(memory.store)
    const other: MatrixIdentity = { userId: '@owner:test', deviceId: 'OTHER_MAC' }

    expect(ledger.observe(IDENTITY, own)).toBeNull()
    expect(ledger.observe(other, own)).toBeNull()
    expect(ledger.observe(other, identityOf([phone, tablet, laptop]))).toEqual({
      deviceId: 'LAPTOP',
      name: 'MacBook Air'
    })
    expect(ledger.observe(IDENTITY, identityOf([phone, tablet, laptop]))).toEqual({
      deviceId: 'LAPTOP',
      name: 'MacBook Air'
    })
  })

  it('keeps the dismissal in memory when the encrypted store cannot write', () => {
    const ledger = new MatrixNewSignInLedger({
      read: () => null,
      write: () => {
        throw new Error('disk full')
      }
    })

    ledger.observe(IDENTITY, own)
    expect(ledger.observe(IDENTITY, identityOf([phone, tablet, laptop]))?.deviceId).toBe('LAPTOP')
    ledger.acknowledge(IDENTITY, 'LAPTOP')
    expect(ledger.observe(IDENTITY, identityOf([phone, tablet, laptop]))).toBeNull()
  })

  it('ignores a malformed ledger and starts a fresh baseline', () => {
    const ledger = new MatrixNewSignInLedger({
      read: () => '{"v":1,"accounts":{"not-a-key":{"acknowledged":[42]}}}',
      write: () => {}
    })

    expect(ledger.observe(IDENTITY, identityOf([phone, tablet, laptop]))).toBeNull()
    expect(ledger.observe(IDENTITY, identityOf([phone, tablet, laptop]))).toBeNull()
  })

  it('bounds the baseline it writes to the ledger limit', () => {
    const memory = memoryStore()
    const ledger = new MatrixNewSignInLedger(memory.store)

    const devices = Array.from({ length: 1005 }, (_, index) => ({
      ...phone,
      deviceId: `DEVICE_${index}`,
      lastSeenAt: NOW - index
    }))

    expect(ledger.observe(IDENTITY, identityOf(devices))).toBeNull()

    const stored = JSON.parse(memory.get()!) as { accounts: Record<string, { acknowledged: string[] }> }
    expect(Object.values(stored.accounts)[0]?.acknowledged).toHaveLength(1000)
  })
})

describe('what the banner shows after a read', () => {
  it('shows the next unknown device as soon as the shown one is dismissed', () => {
    const memory = memoryStore()
    const ledger = new MatrixNewSignInLedger(memory.store)

    expect(ledger.observe(IDENTITY, identityOf([phone]))).toBeNull()

    const read = identityOf([phone, tablet, laptop])
    const first = matrixNewSignInView({ identity: IDENTITY, read, shown: undefined, ledger })

    expect(first).toEqual({ deviceId: 'LAPTOP', name: 'MacBook Air' })

    ledger.acknowledge(IDENTITY, 'LAPTOP')

    expect(matrixNewSignInView({ identity: IDENTITY, read, shown: first, ledger, settled: true })).toEqual({
      deviceId: 'TABLET',
      name: 'iPad'
    })
  })

  it('keeps the shown banner through a failed or momentarily empty read', () => {
    const memory = memoryStore()
    const ledger = new MatrixNewSignInLedger(memory.store)
    const shown = { deviceId: 'LAPTOP', name: 'MacBook Air' }

    expect(matrixNewSignInView({ identity: IDENTITY, read: null, shown, ledger })).toEqual(shown)
    expect(matrixNewSignInView({ identity: IDENTITY, read: identityOf([]), shown, ledger })).toEqual(shown)
  })

  it('clears a dismissed banner when the read offers nothing else', () => {
    const memory = memoryStore()
    const ledger = new MatrixNewSignInLedger(memory.store)
    const shown = { deviceId: 'LAPTOP', name: 'MacBook Air' }

    expect(matrixNewSignInView({ identity: IDENTITY, read: null, shown, ledger, settled: true })).toBeUndefined()
    expect(
      matrixNewSignInView({ identity: IDENTITY, read: identityOf([]), shown, ledger, settled: true })
    ).toBeUndefined()
  })

  it('keeps a banner only for the account sign-in it belongs to', () => {
    const scope = matrixNewSignInScope(IDENTITY)

    expect(matrixNewSignInSameScope(scope, IDENTITY)).toBe(true)
    expect(matrixNewSignInSameScope(scope, { userId: '@owner:test', deviceId: 'OTHER_MAC' })).toBe(false)
    expect(matrixNewSignInSameScope(scope, { userId: '@other:test', deviceId: 'THIS_MAC' })).toBe(false)
    expect(matrixNewSignInSameScope(scope, null)).toBe(false)
    expect(matrixNewSignInSameScope(undefined, IDENTITY)).toBe(false)
  })
})
