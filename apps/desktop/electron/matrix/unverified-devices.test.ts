import { expect, it, vi } from 'vitest'

import {
  MATRIX_UNVERIFIED_DEVICE_RECENT_MS,
  matrixLocalDay,
  matrixUnverifiedOwnDevices
} from '../../shared/matrix-device-trust'
import type { MatrixOwnDevice, MatrixOwnDevices, MatrixSecurity } from '../../shared/matrix-security'

import { MatrixUnverifiedDevices } from './unverified-devices'

const NOW = Date.UTC(2026, 9, 6, 9)

const phone: MatrixOwnDevice = {
  deviceId: 'PHONE',
  name: 'iPhone 16 Pro',
  lastSeenAt: NOW - 60_000,
  signedByOwner: false,
  crossSigningVerified: false
}

const mac: MatrixOwnDevice = {
  deviceId: 'MAC2',
  name: 'Atum · MacBook Pro',
  lastSeenAt: NOW - 5_000,
  signedByOwner: true,
  crossSigningVerified: true
}

it('raises only the person’s own unsigned devices seen recently, newest first, once this Mac trusts them', () => {
  const ipad = { ...phone, deviceId: 'IPAD', name: undefined, lastSeenAt: NOW - 3_600_000 }
  const old = { ...phone, deviceId: 'OLD', lastSeenAt: NOW - MATRIX_UNVERIFIED_DEVICE_RECENT_MS - 1 }
  const unseen = { ...phone, deviceId: 'UNSEEN', lastSeenAt: undefined }
  const byHand = { ...phone, deviceId: 'BYHAND', locallyVerified: true as const }
  const read: MatrixOwnDevices = { identity: 'verified', devices: [ipad, mac, old, phone, unseen, byHand] }

  expect(matrixUnverifiedOwnDevices(read, NOW)).toEqual([
    { deviceId: 'PHONE', name: 'iPhone 16 Pro', lastSeenAt: phone.lastSeenAt },
    { deviceId: 'IPAD', lastSeenAt: ipad.lastSeenAt }
  ])

  // A Mac that doesn't trust the identity yet sees every device as unsigned: it asks to be
  // unlocked instead, so nothing is raised here.
  expect(matrixUnverifiedOwnDevices({ ...read, identity: 'new' }, NOW)).toEqual([])
  expect(matrixUnverifiedOwnDevices({ ...read, identity: 'changed' }, NOW)).toEqual([])
  expect(matrixUnverifiedOwnDevices(null, NOW)).toEqual([])
})

it('names the calendar day on this Mac', () => {
  expect(matrixLocalDay(new Date(2026, 0, 2, 23, 59).getTime())).toBe('2026-01-02')
  expect(matrixLocalDay(new Date(2026, 0, 3, 0, 1).getTime())).toBe('2026-01-03')
})

function harness(devices: MatrixOwnDevice[] = [phone]) {
  const host = { name: 'human' }
  let reply: MatrixOwnDevices = { identity: 'verified', devices }
  const read = vi.fn(async () => structuredClone(reply))
  const changed = vi.fn()
  const verify = vi.fn(async () => {})
  const tracker = new MatrixUnverifiedDevices({ read, changed, verify, now: () => NOW })
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))

  return {
    host,
    read,
    changed,
    verify,
    tracker,
    flush,
    reply: (next: MatrixOwnDevices) => {
      reply = next
    }
  }
}

const security = (extra: Partial<MatrixSecurity> = {}): MatrixSecurity => ({ recovery: 'idle', ...extra })

it('reads once the human host is ready, and again only when its device list or a verification moves', async () => {
  const h = harness()

  h.tracker.observe(h.host, security(), false)
  expect(h.read).not.toHaveBeenCalled()

  h.tracker.observe(h.host, security(), true)
  await h.flush()
  expect(h.read).toHaveBeenCalledOnce()
  expect(h.tracker.view(h.host)).toEqual([{ deviceId: 'PHONE', name: 'iPhone 16 Pro', lastSeenAt: phone.lastSeenAt }])
  expect(h.changed).toHaveBeenCalledOnce()

  // Every other snapshot (a message, typing) reads nothing.
  h.tracker.observe(h.host, security(), true)
  await h.flush()
  expect(h.read).toHaveBeenCalledOnce()

  // The phone was verified here: the comparison finishes, the device list changes, it's gone.
  h.reply({ identity: 'verified', devices: [{ ...phone, signedByOwner: true, crossSigningVerified: true }] })
  h.tracker.observe(
    h.host,
    security({ verification: { id: 'v1', userId: '@owner:test', deviceId: 'PHONE', incoming: false, state: 'done' } }),
    true
  )
  await h.flush()
  expect(h.tracker.view(h.host)).toBeUndefined()

  h.reply({ identity: 'verified', devices: [phone] })
  h.tracker.observe(h.host, security({ ownDevicesChanges: 1 }), true)
  await h.flush()
  expect(h.read).toHaveBeenCalledTimes(3)
  expect(h.tracker.view(h.host)).toHaveLength(1)
})

it('reads again when an assistant refused one of the person’s devices, for that host only', async () => {
  const h = harness([])
  h.tracker.observe(h.host, security(), true)
  await h.flush()
  expect(h.tracker.view(h.host)).toBeUndefined()

  h.tracker.denied({ name: 'an old host' }, 'PHONE')
  await h.flush()
  expect(h.read).toHaveBeenCalledOnce()

  h.reply({ identity: 'verified', devices: [phone] })
  h.tracker.denied(h.host, 'PHONE')
  await h.flush()
  expect(h.read).toHaveBeenCalledTimes(2)
  expect(h.tracker.view(h.host)?.[0]?.deviceId).toBe('PHONE')
  // The same first denial discovers the phone and starts the normal two-device comparison,
  // without requiring another message or a Settings scavenger hunt.
  expect(h.verify).toHaveBeenCalledExactlyOnceWith(h.host, 'PHONE')
  h.tracker.denied(h.host, 'PHONE')
  expect(h.verify).toHaveBeenCalledOnce()
  // Never shown for another host (a new sign-in), and gone when signed out.
  expect(h.tracker.view({ name: 'another host' })).toBeUndefined()
  h.tracker.clear()
  expect(h.tracker.view(h.host)).toBeUndefined()
})

it('reads one at a time, once more for a reason that came during a read, and keeps what it knew on a failure', async () => {
  const h = harness()

  let release: () => void = () => {}

  h.read.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = () => resolve({ identity: 'verified', devices: [phone] })
      })
  )

  h.tracker.observe(h.host, security(), true)
  h.tracker.denied(h.host)
  h.tracker.denied(h.host)
  expect(h.read).toHaveBeenCalledOnce()
  release()
  await h.flush()
  await h.flush()
  expect(h.read).toHaveBeenCalledTimes(2)
  expect(h.tracker.view(h.host)).toHaveLength(1)

  h.read.mockRejectedValueOnce(new Error('offline'))
  h.tracker.denied(h.host)
  await h.flush()
  expect(h.tracker.view(h.host)).toHaveLength(1)
})

it('hands the raw device list to the new sign-in watcher when a signed device appears', async () => {
  const h = harness()

  h.tracker.observe(h.host, security(), true)
  await h.flush()
  expect(h.tracker.ownDevices(h.host)?.devices.map(device => device.deviceId)).toEqual(['PHONE'])
  expect(h.changed).toHaveBeenCalledOnce()

  // A properly signed new login changes no unverified row, but the banner still needs the read.
  h.reply({ identity: 'verified', devices: [phone, mac] })
  h.tracker.observe(h.host, security({ ownDevicesChanges: 1 }), true)
  await h.flush()
  expect(h.tracker.ownDevices(h.host)?.devices.map(device => device.deviceId)).toEqual(['PHONE', 'MAC2'])
  expect(h.changed).toHaveBeenCalledTimes(2)
})
