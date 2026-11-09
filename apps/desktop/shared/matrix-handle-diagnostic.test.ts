import { describe, expect, it } from 'vitest'

import {
  formatMatrixHandleDiagnostic,
  formatMatrixHandleSheetDiagnostic,
  parseMatrixHandleBackfillDiagnostic,
  parseMatrixHandleSheetDiagnostic
} from './matrix-handle-diagnostic'

describe('the create sheet’s handle line', () => {
  it('writes only closed values, one line per settled handle', () => {
    const line = parseMatrixHandleSheetDiagnostic({ source: 'typed', check: 'taken', outcome: 'claimed_other' })

    expect(line && formatMatrixHandleSheetDiagnostic(line)).toBe(
      '[Matrix] handle sheet=create source=typed check=taken outcome=claimed_other'
    )
  })

  it('refuses anything else the window might send: no handle, name or free text reaches main.log', () => {
    for (const value of [
      null,
      'source=typed',
      [],
      { source: 'typed', check: 'taken' },
      { source: 'typed', check: 'taken', outcome: 'claimed', handle: 'tiep_thi_bot' },
      { source: 'tiep_thi_bot', check: 'taken', outcome: 'claimed' },
      { source: 'typed', check: 'taken', outcome: 'claimed and more' },
      { source: 'typed', check: 1, outcome: 'claimed' }
    ]) {
      expect(parseMatrixHandleSheetDiagnostic(value)).toBeUndefined()
    }
  })
})

describe('the launch walk’s handle line', () => {
  it('writes one closed line per assistant: its principal’s first eight characters, never a handle', () => {
    expect(formatMatrixHandleDiagnostic({ backfill: 'claimed', agent: '1a2b3c4d', code: 'none', attempt: 1 })).toBe(
      '[Matrix] handle backfill agent=1a2b3c4d outcome=claimed code=none attempt=1'
    )
    expect(
      formatMatrixHandleDiagnostic({ backfill: 'failed', agent: '1a2b3c4d', code: 'unavailable', attempt: 2 })
    ).toBe('[Matrix] handle backfill agent=1a2b3c4d outcome=failed code=unavailable attempt=2')
    // The sheet's line still reads as before through the same channel.
    expect(formatMatrixHandleDiagnostic({ source: 'derived', check: 'available', outcome: 'claimed' })).toBe(
      '[Matrix] handle sheet=create source=derived check=available outcome=claimed'
    )
  })

  it('refuses a handle, a long ID, free text or an extra field', () => {
    for (const value of [
      { backfill: 'claimed', agent: 'tiep_thi_bot', code: 'none', attempt: 1 },
      { backfill: 'claimed', agent: '1a2b3c4d-0000', code: 'none', attempt: 1 },
      { backfill: 'claimed', agent: '1a2b3c4d', code: 'tiep_thi_bot', attempt: 1 },
      { backfill: 'claimed', agent: '1a2b3c4d', code: 'none', attempt: 3 },
      { backfill: 'claimed', agent: '1a2b3c4d', code: 'none', attempt: 1, handle: 'tiep_thi_bot' },
      { backfill: 'claimed and more', agent: '1a2b3c4d', code: 'none', attempt: 1 },
      { backfill: 'claimed', agent: '1a2b3c4d', code: 'none' }
    ]) {
      expect(parseMatrixHandleBackfillDiagnostic(value)).toBeUndefined()
      expect(formatMatrixHandleDiagnostic(value)).toBeUndefined()
    }
  })
})
