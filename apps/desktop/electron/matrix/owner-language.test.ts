import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type OwnerLanguage,
  OwnerLanguageReports,
  ownerLanguageToReport,
  refreshMatrixRosterOnLanguageChange
} from './owner-language'
import { MatrixRosterRecovery } from './roster-recovery'

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

describe('a choice made after an earlier ack (review finding 5)', () => {
  it('reports a return to a language acknowledged before, after another device chose another one', () => {
    const { live, reports } = fixture({ value: 'en', source: 'explicit' })

    reports.observe()
    reports.begin()?.settle('en')
    expect(reports.begin()).toBeUndefined()

    // Another device saves Vietnamese; this Mac sees it by sync before any roster read of its own.
    live.language = { value: 'vi', source: 'explicit' }
    reports.observe()
    // The owner chooses English again here: the old `explicit:en` ack must not hide it.
    live.language = { value: 'en', source: 'explicit' }
    expect(reports.observe()).toBe(true)
    expect(reports.begin()?.headers).toEqual({ 'Atum-Language': 'en', 'Atum-Language-Source': 'explicit' })
  })

  it('records nothing from an ack for a report begun before the choice changed', () => {
    const { live, reports, store } = fixture({ value: 'en', source: 'explicit' })

    reports.observe()
    const old = reports.begin()

    live.language = { value: 'vi', source: 'explicit' }
    reports.observe()
    // The English report's ack arrives late, after Vietnamese was chosen.
    old?.settle('en')
    expect(store.entries.size).toBe(0)

    // Back to English before anything settled: English is still reported, its old ack counts for nothing.
    live.language = { value: 'en', source: 'explicit' }
    reports.observe()
    old?.settle('en')
    expect(store.entries.size).toBe(0)
    expect(reports.begin()?.headers).toEqual({ 'Atum-Language': 'en', 'Atum-Language-Source': 'explicit' })
  })

  it('keeps the ack across a launch that only learns the same language again', () => {
    const { live, reports, store } = fixture(undefined)

    live.language = { value: 'ja', source: 'explicit' }
    reports.begin()?.settle('ja')

    // A fresh process: unknown, then the same saved choice. Nothing to report, no read asked for.
    const relaunched = new OwnerLanguageReports({ store, scope: () => live.scope, language: () => live.language })

    live.language = undefined
    expect(relaunched.observe()).toBe(false)
    live.language = { value: 'ja', source: 'explicit' }
    expect(relaunched.observe()).toBe(false)
    expect(relaunched.begin()).toBeUndefined()
  })
})

describe('a language change reaches the roster read at once (review finding 1)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads an already-synced roster again on the preference echo, without the quarter-hour timer', async () => {
    vi.useFakeTimers()

    const { live, reports } = fixture(undefined)
    const roster = new MatrixRosterRecovery<string[]>()
    const sent: Record<string, string>[] = []

    const read = () =>
      roster.sync({
        scope: () => live.scope,
        fetch: async () => {
          const report = reports.begin()

          sent.push(report?.headers ?? {})
          report?.settle(report.headers['Atum-Language'])

          return []
        }
      })

    const publish = async () => {
      let started: Promise<unknown> | undefined

      refreshMatrixRosterOnLanguageChange(() => reports.observe(), roster, () => {
        started = read()
      })
      await started
    }

    // The first roster read runs before sync knows whether a language was saved: no header.
    expect((await read()).state).toBe('synced')
    expect(sent).toEqual([{}])
    // Once read, ordinary watch ticks are no-ops.
    expect((await read()).state).toBe('idle')

    // Initial sync confirms a saved Vietnamese choice: reported now.
    live.language = { value: 'vi', source: 'explicit' }
    await publish()
    expect(sent.at(-1)).toEqual({ 'Atum-Language': 'vi', 'Atum-Language-Source': 'explicit' })

    // The owner saves English; the sync echo publishes it: read again and reported, timer untouched.
    live.language = { value: 'en', source: 'explicit' }
    await publish()
    expect(sent.at(-1)).toEqual({ 'Atum-Language': 'en', 'Atum-Language-Source': 'explicit' })
    expect(sent).toHaveLength(3)

    // An unrelated publish with the same language asks for nothing.
    await publish()
    expect(sent).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
  })
})
