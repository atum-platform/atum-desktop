import { describe, expect, it } from 'vitest'

import { currentIanaTimeZone, isIanaTimeZone, OwnerTimeZoneReports } from './time-zone'

class MemoryStore {
  readonly entries = new Map<string, string>()

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value)
  }

  removeItem(key: string): void {
    this.entries.delete(key)
  }
}

const A = { accountKey: 'a'.repeat(64), generation: 4 }
const B = { accountKey: 'b'.repeat(64), generation: 9 }

function fixture(zone: () => string | undefined, scope: () => typeof A | null = () => A) {
  const store = new MemoryStore()
  const reports = new OwnerTimeZoneReports({ store, scope, zone })

  return { reports, store }
}

describe('the IANA rule shared with the controller and the platform contract', () => {
  it('accepts zones and refuses offsets, lowercase, empty and over-long values', () => {
    expect(isIanaTimeZone('Asia/Ho_Chi_Minh')).toBe(true)
    expect(isIanaTimeZone('UTC')).toBe(true)
    expect(isIanaTimeZone('America/Argentina/ComodRivadavia')).toBe(true)
    expect(isIanaTimeZone('+07:00')).toBe(false)
    expect(isIanaTimeZone('asia/tokyo')).toBe(false)
    expect(isIanaTimeZone('')).toBe(false)
    expect(isIanaTimeZone(`Asia/${'A'.repeat(64)}`)).toBe(false)
    expect(isIanaTimeZone(undefined)).toBe(false)
  })

  it('leaves the tz-database check to the platform, like the phone: a well-formed name ICU does not know is still reportable', () => {
    expect(isIanaTimeZone('Asia/Saigon')).toBe(true)
    expect(isIanaTimeZone('Atlantis/Nowhere')).toBe(true)
  })

  it('reads the Mac zone through Intl as a valid IANA name', () => {
    expect(isIanaTimeZone(currentIanaTimeZone())).toBe(true)
  })
})

describe('the owner time-zone report', () => {
  it('carries the zone on the first read and records it only from the matching ack', () => {
    const { reports, store } = fixture(() => 'Asia/Ho_Chi_Minh')
    const first = reports.begin()

    expect(first?.headers).toEqual({ 'Atum-Time-Zone': 'Asia/Ho_Chi_Minh' })
    first?.settle('Asia/Tokyo')
    expect(store.entries.size).toBe(0)

    first?.settle(undefined)
    expect(store.entries.size).toBe(0)

    first?.settle('Asia/Ho_Chi_Minh')
    expect(store.entries.size).toBe(1)
    expect(reports.begin()).toBeUndefined()
  })

  it('sends again when the Mac zone changed after an ack, then stops again', () => {
    let zone = 'Asia/Ho_Chi_Minh'
    const { reports } = fixture(() => zone)

    reports.begin()?.settle('Asia/Ho_Chi_Minh')
    expect(reports.begin()).toBeUndefined()

    zone = 'Europe/Berlin'
    const changed = reports.begin()
    expect(changed?.headers).toEqual({ 'Atum-Time-Zone': 'Europe/Berlin' })
    changed?.settle('Europe/Berlin')
    expect(reports.begin()).toBeUndefined()
  })

  it('sends no header for an invalid or undefined device zone', () => {
    expect(fixture(() => undefined).reports.begin()).toBeUndefined()
    expect(fixture(() => '+07:00').reports.begin()).toBeUndefined()
    expect(fixture(() => 'asia/tokyo').reports.begin()).toBeUndefined()
  })

  it('keeps one acknowledged value per account across switches', () => {
    let scope = A
    const { reports, store } = fixture(() => 'Asia/Ho_Chi_Minh', () => scope)

    reports.begin()?.settle('Asia/Ho_Chi_Minh')
    scope = B
    const second = reports.begin()
    expect(second?.headers).toEqual({ 'Atum-Time-Zone': 'Asia/Ho_Chi_Minh' })
    second?.settle('Asia/Ho_Chi_Minh')
    expect(store.entries.size).toBe(2)

    scope = A
    expect(reports.begin()).toBeUndefined()
    scope = B
    expect(reports.begin()).toBeUndefined()
  })

  it('discards a delayed ack after the account switched', () => {
    let scope = A
    const { reports, store } = fixture(() => 'Asia/Ho_Chi_Minh', () => scope)
    const delayed = reports.begin()

    scope = B
    delayed?.settle('Asia/Ho_Chi_Minh')

    expect(store.entries.size).toBe(0)
  })

  it('discards a delayed ack after sign-out changed the session generation', () => {
    let scope = A
    const { reports, store } = fixture(() => 'Asia/Ho_Chi_Minh', () => scope)
    const delayed = reports.begin()

    scope = { accountKey: A.accountKey, generation: A.generation + 1 }
    delayed?.settle('Asia/Ho_Chi_Minh')

    expect(store.entries.size).toBe(0)
  })

  it('hands the acknowledged owner zone to a new routine’s default, per account', () => {
    let scope: typeof A | null = A
    const { reports } = fixture(() => 'Asia/Ho_Chi_Minh', () => scope)

    expect(reports.ownerZone()).toBeUndefined()
    reports.begin()?.settle('Asia/Ho_Chi_Minh')
    expect(reports.ownerZone()).toBe('Asia/Ho_Chi_Minh')

    scope = B
    expect(reports.ownerZone()).toBeUndefined()
    scope = null
    expect(reports.ownerZone()).toBeUndefined()
  })

  it('clears only the signing-out account', () => {
    let scope = A
    const { reports, store } = fixture(() => 'Asia/Ho_Chi_Minh', () => scope)

    reports.begin()?.settle('Asia/Ho_Chi_Minh')
    scope = B
    reports.begin()?.settle('Asia/Ho_Chi_Minh')

    reports.clear(A.accountKey)
    expect(store.entries.size).toBe(1)

    const afterSignOut = new OwnerTimeZoneReports({ store, scope: () => A, zone: () => 'Asia/Ho_Chi_Minh' })
    expect(afterSignOut.begin()?.headers).toEqual({ 'Atum-Time-Zone': 'Asia/Ho_Chi_Minh' })
  })
})
