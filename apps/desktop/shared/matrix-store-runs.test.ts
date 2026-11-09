import { describe, expect, it } from 'vitest'

import {
  claimMatrixStoreRun,
  emptyMatrixStoreRunLedger,
  MATRIX_STORE_RUN_REBIND_MS,
  type MatrixStoreRunLedger,
  matrixStoreRunOccurrence,
  matrixStoreRunsAssistant,
  matrixStoreRunsEvent,
  parseMatrixStoreRunLedger
} from './matrix-store-runs'
import { MATRIX_STORE_SCHEDULES } from './matrix-store-schedules'

const researcher = MATRIX_STORE_SCHEDULES['agent/researcher']!
const shop = MATRIX_STORE_SCHEDULES['agent/shop-assistant']!
/** A wall-clock time on this Mac: October 2026, whose 5th is a Monday. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()

describe('a run’s occurrence', () => {
  it('is the latest fire of its specs at or before now, as a wall-clock slot', () => {
    expect(matrixStoreRunOccurrence(researcher, at(5, 8))).toBe('2026-10-05T08:00')
    expect(matrixStoreRunOccurrence(researcher, at(5, 15))).toBe('2026-10-05T08:00')
    expect(matrixStoreRunOccurrence(researcher, at(5, 7, 59))).toBe('2026-09-28T08:00')

    // The shop assistant's daily 8:30 sales summary and Monday 10:00 price check.
    expect(matrixStoreRunOccurrence(shop, at(5, 9))).toBe('2026-10-05T08:30')
    expect(matrixStoreRunOccurrence(shop, at(5, 10, 5))).toBe('2026-10-05T10:00')
    expect(matrixStoreRunOccurrence(shop, at(6, 8, 29))).toBe('2026-10-05T10:00')
    expect(matrixStoreRunOccurrence(shop, at(6, 8, 30))).toBe('2026-10-06T08:30')
  })

  it('is the same slot on Macs in different time zones', () => {
    // 8:00 in Hanoi (UTC+7) and 8:00 in London in winter (UTC) are hours apart, one slot.
    expect(matrixStoreRunOccurrence(researcher, Date.UTC(2026, 9, 5, 1, 0), -420)).toBe('2026-10-05T08:00')
    expect(matrixStoreRunOccurrence(researcher, Date.UTC(2026, 9, 5, 8, 0), 0)).toBe('2026-10-05T08:00')
    expect(matrixStoreRunOccurrence(researcher, Date.UTC(2026, 9, 5, 7, 59), 0)).toBe('2026-09-28T08:00')
  })

  it('reads the cron forms Hermes takes, and none it cannot', () => {
    const spec = (cron: string) => [{ id: 'x', cron, prompt: 'x' }]

    expect(matrixStoreRunOccurrence(spec('*/15 9-17 * * 1-5'), at(5, 12, 7))).toBe('2026-10-05T12:00')
    expect(matrixStoreRunOccurrence(spec('0 9 1 * *'), at(5, 12))).toBe('2026-10-01T09:00')
    // Both day fields set: either matches (cron's rule). The 3rd is a Saturday; Sunday is 0 or 7.
    expect(matrixStoreRunOccurrence(spec('0 9 3 * 1'), at(4, 12))).toBe('2026-10-03T09:00')
    expect(matrixStoreRunOccurrence(spec('0 9 * * 7'), at(5, 12))).toBe('2026-10-04T09:00')
    expect(matrixStoreRunOccurrence(spec('every 2h'), at(5, 12))).toBeNull()
    expect(matrixStoreRunOccurrence(spec('0 25 * * *'), at(5, 12))).toBeNull()
    expect(matrixStoreRunOccurrence([], at(5, 12))).toBeNull()
  })
})

describe('claiming an occurrence', () => {
  const DIGEST = 'agent/researcher/weekly-digest'
  const SALES = 'agent/shop-assistant/daily-sales'
  const PRICES = 'agent/shop-assistant/price-check'

  const claimed = (runs: Record<string, [string, string, number]>): MatrixStoreRunLedger => ({
    version: 2,
    runs: Object.fromEntries(
      Object.entries(runs).map(([key, [occurrence, executorId, claimedAt]]) => [
        key,
        { occurrence, executorId, claimedAt }
      ])
    )
  })

  it('is taken by the first Mac, and refused to every other Mac for that slot or an earlier one', () => {
    const first = claimMatrixStoreRun(emptyMatrixStoreRunLedger(), DIGEST, '2026-10-05T08:00', 'mac-a', at(5, 8))
    expect(first).toEqual(claimed({ [DIGEST]: ['2026-10-05T08:00', 'mac-a', at(5, 8)] }))

    expect(claimMatrixStoreRun(first!, DIGEST, '2026-10-05T08:00', 'mac-b', at(5, 15))).toBeNull()
    expect(claimMatrixStoreRun(first!, DIGEST, '2026-09-28T08:00', 'mac-b', at(5, 15))).toBeNull()
    expect(claimMatrixStoreRun(first!, DIGEST, '2026-10-12T08:00', 'mac-b', at(12, 8))).toEqual(
      claimed({ [DIGEST]: ['2026-10-12T08:00', 'mac-b', at(12, 8)] })
    )
  })

  it('is per job: one job’s claim neither blocks nor lets through another job of the assistant', () => {
    // Mac A ran Monday's 8:30 sales summary; Mac B wakes at 10:30 and catches up both jobs.
    const ledger = claimed({ [SALES]: ['2026-10-05T08:30', 'mac-a', at(5, 8, 30)] })

    expect(claimMatrixStoreRun(ledger, SALES, '2026-10-05T08:30', 'mac-b', at(5, 10, 30))).toBeNull()
    expect(claimMatrixStoreRun(ledger, PRICES, '2026-10-05T10:00', 'mac-b', at(5, 10, 30))).toEqual(
      claimed({
        [SALES]: ['2026-10-05T08:30', 'mac-a', at(5, 8, 30)],
        [PRICES]: ['2026-10-05T10:00', 'mac-b', at(5, 10, 30)]
      })
    )
  })

  it('lets the claiming Mac bind it again only while its run can still be going', () => {
    const first = claimed({ [DIGEST]: ['2026-10-05T08:00', 'mac-a', at(5, 8)] })

    expect(claimMatrixStoreRun(first, DIGEST, '2026-10-05T08:00', 'mac-a', at(5, 8) + MATRIX_STORE_RUN_REBIND_MS)).toBe(
      first
    )
    expect(
      claimMatrixStoreRun(first, DIGEST, '2026-10-05T08:00', 'mac-a', at(5, 8) + MATRIX_STORE_RUN_REBIND_MS + 1)
    ).toBeNull()
    // A later slot of the same job the same Mac already claimed: this one is over.
    expect(
      claimMatrixStoreRun(
        claimed({ [SALES]: ['2026-10-06T08:30', 'mac-a', at(6, 8, 30)] }),
        SALES,
        '2026-10-05T08:30',
        'mac-a',
        at(6, 8, 30)
      )
    ).toBeNull()
  })

  it('stays bounded: the claims longest unused go first', () => {
    let ledger = emptyMatrixStoreRunLedger()

    for (let n = 0; n < 40; n++) {
      ledger = claimMatrixStoreRun(ledger, `agent/a/job-${n}`, '2026-10-05T08:00', 'mac-a', n)!
    }

    expect(Object.keys(ledger.runs)).toHaveLength(32)
    expect(ledger.runs['agent/a/job-39']).toBeDefined()
    expect(ledger.runs['agent/a/job-0']).toBeUndefined()
    expect(parseMatrixStoreRunLedger(ledger)).toEqual(ledger)
  })
})

describe('the Store-run ledger in account data', () => {
  it('is one event per assistant, named only for a Store assistant ID', () => {
    const id = '00000000-0000-4000-8000-20101becbd5c'

    expect(matrixStoreRunsEvent(id)).toBe(`io.atum.store_runs.${id}`)
    expect(matrixStoreRunsAssistant(id)).toBe(true)

    for (const bad of ['', 'x', `${id}/../io.atum.check_ins`, 42, null]) {
      expect(matrixStoreRunsAssistant(bad)).toBe(false)
    }
  })

  it('reads none as empty, round-trips claims, and refuses a newer schema or a claim it cannot read', () => {
    const claim = { occurrence: '2026-10-05T08:00', executorId: 'mac-a', claimedAt: 1 }
    const ledger = { version: 2, runs: { 'agent/researcher/weekly-digest': claim } } as const

    expect(parseMatrixStoreRunLedger(undefined)).toEqual(emptyMatrixStoreRunLedger())
    expect(parseMatrixStoreRunLedger({ version: 2 })).toEqual(emptyMatrixStoreRunLedger())
    expect(parseMatrixStoreRunLedger(ledger)).toEqual(ledger)
    // The pre-release per-assistant shape names no job: nothing in it is a job's claim.
    expect(parseMatrixStoreRunLedger({ version: 1, last: claim })).toEqual(emptyMatrixStoreRunLedger())

    for (const bad of [
      {},
      { version: 3, runs: ledger.runs },
      { version: 2, runs: [] },
      { version: 2, runs: { 'weekly-digest': claim } },
      { version: 2, runs: { 'agent/researcher/../x': claim } },
      { version: 2, runs: { 'agent/researcher/weekly-digest': { ...claim, occurrence: 'Monday' } } },
      { version: 2, runs: { 'agent/researcher/weekly-digest': { ...claim, executorId: '' } } },
      { version: 2, runs: { 'agent/researcher/weekly-digest': { ...claim, claimedAt: '1' } } },
      { version: 2, runs: { 'agent/researcher/weekly-digest': 'mac-a' } },
      { version: 2, runs: Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`agent/a/j${n}`, claim])) },
      []
    ]) {
      expect(parseMatrixStoreRunLedger(bad)).toBeNull()
    }
  })
})
