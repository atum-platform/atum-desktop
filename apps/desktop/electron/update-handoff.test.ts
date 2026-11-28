import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

import { readUpdateBounds, restoredUpdateBounds, saveUpdateBounds } from './update-handoff'

it('consumes the prior window position once and clamps it to a changed display', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-update-bounds-'))
  const bounds = { x: 1300, y: 100, width: 600, height: 500 }
  try {
    saveUpdateBounds(directory, bounds)
    expect(readUpdateBounds(directory)).toEqual(bounds)
    expect(readUpdateBounds(directory)).toBeNull()
    expect(restoredUpdateBounds(bounds, { x: 0, y: 0, width: 1600, height: 900 }))
      .toEqual({ ...bounds, x: 1000 })
    writeFileSync(path.join(directory, 'handoff.json'), JSON.stringify({ startedAt: Date.now(), bounds }))
    expect(readUpdateBounds(directory)).toEqual(bounds)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})
