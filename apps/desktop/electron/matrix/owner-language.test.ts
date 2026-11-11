import { describe, expect, it } from 'vitest'

import { type OwnerLanguage, OwnerLanguageReports, ownerLanguageToReport } from './owner-language'

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

function fixture(initial: OwnerLanguage | undefined) {
  const store = new MemoryStore()
  const live = { scope: A as typeof A | null, language: initial }
  const reports = new OwnerLanguageReports({ store, scope: () => live.scope, language: () => live.language })

  return { live, reports, store }
}

describe('which language a roster read reports (atum.owner-language/1)', () => {
  it('reports a saved choice as explicit, and the system language only once sync confirmed none is saved', () => {
    expect(ownerLanguageToReport({ value: 'ja', chosen: true }, 'en')).toEqual({ value: 'ja', source: 'explicit' })
    expect(ownerLanguageToReport({ value: 'vi', chosen: false }, 'en')).toEqual({ value: 'en', source: 'reported' })
    // Unknown yet, or a system language Atum does not speak: nothing (never "reported" while a choice may exist).
    expect(ownerLanguageToReport({ value: 'vi' }, 'en')).toBeUndefined()
    expect(ownerLanguageToReport(undefined, 'en')).toBeUndefined()
    expect(ownerLanguageToReport({ value: 'vi', chosen: false }, undefined)).toBeUndefined()
    expect(ownerLanguageToReport({ value: 'zh-CN', chosen: true }, 'en')).toBeUndefined()
  })
})

describe('the owner language report', () => {
  it('sends both headers until the ack echoes the value, then stops', () => {
    const { reports, store } = fixture({ value: 'en', source: 'explicit' })
    const first = reports.begin()

    expect(first?.headers).toEqual({ 'Atum-Language': 'en', 'Atum-Language-Source': 'explicit' })
    // No ack (the report failed or was not accepted): nothing is recorded and the next read retries.
    first?.settle(undefined)
    expect(store.entries.size).toBe(0)

    const second = reports.begin()

    expect(second?.headers).toEqual({ 'Atum-Language': 'en', 'Atum-Language-Source': 'explicit' })
    second?.settle('en')
    expect(reports.begin()).toBeUndefined()
  })

  it('reports a new choice, and the promotion of a reported language to an explicit one', () => {
    const { live, reports } = fixture({ value: 'en', source: 'reported' })

    reports.begin()?.settle('en')
    expect(reports.begin()).toBeUndefined()

    live.language = { value: 'en', source: 'explicit' }
    expect(reports.begin()?.headers).toEqual({ 'Atum-Language': 'en', 'Atum-Language-Source': 'explicit' })

    live.language = { value: 'zh-hant', source: 'explicit' }
    expect(reports.begin()?.headers).toEqual({ 'Atum-Language': 'zh-hant', 'Atum-Language-Source': 'explicit' })
  })

  it('does not record a reported language another source won, and does not repeat it in this sign-in', () => {
    const { live, reports, store } = fixture({ value: 'en', source: 'reported' })

    reports.begin()?.settle('vi')
    expect(store.entries.size).toBe(0)
    expect(reports.begin()).toBeUndefined()

    // A new sign-in generation asks once more.
    live.scope = { ...A, generation: A.generation + 1 }
    expect(reports.begin()?.headers).toEqual({ 'Atum-Language': 'en', 'Atum-Language-Source': 'reported' })
  })

  it('discards an ack that arrives after an account switch or sign-out, and an ack outside the five languages', () => {
    const { live, reports, store } = fixture({ value: 'ja', source: 'explicit' })
    const report = reports.begin()

    live.scope = B
    report?.settle('ja')
    expect(store.entries.size).toBe(0)

    live.scope = A
    reports.begin()?.settle('JA')
    expect(store.entries.size).toBe(0)

    live.scope = null
    expect(reports.begin()).toBeUndefined()
  })

  it('reports afresh after sign-out clears the account', () => {
    const { reports } = fixture({ value: 'vi', source: 'explicit' })

    reports.begin()?.settle('vi')
    expect(reports.begin()).toBeUndefined()
    reports.clear(A.accountKey)
    expect(reports.begin()?.headers).toEqual({ 'Atum-Language': 'vi', 'Atum-Language-Source': 'explicit' })
  })

  it('sends nothing while the language is unknown', () => {
    expect(fixture(undefined).reports.begin()).toBeUndefined()
  })
})
