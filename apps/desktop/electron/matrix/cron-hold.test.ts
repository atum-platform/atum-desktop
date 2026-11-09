import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MatrixCronHolds, reconcileMatrixJobsHold } from './cron-hold'

const roots: string[] = []

function holds(): { directory: string; holds: MatrixCronHolds } {
  const root = mkdtempSync(path.join(tmpdir(), 'atum-cron-hold-'))
  roots.push(root)
  const directory = path.join(root, 'device', 'cron-holds')

  return { directory, holds: new MatrixCronHolds(directory) }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    for (const folder of [root, path.join(root, 'locked'), path.join(root, 'device', 'cron-holds')]) {
      try {
        chmodSync(folder, 0o700)
      } catch {
        // Not every test makes every folder.
      }
    }

    rmSync(root, { recursive: true, force: true })
  }
})

describe('the host hold on an agent cron ticker', () => {
  it('holds and lifts one agent without touching another, under an absolute hash path', () => {
    const { directory, holds: marker } = holds()

    expect(marker.held('agent:a')).toBe(false)
    expect(marker.hold('agent:a')).toBe(true)
    expect(marker.held('agent:a')).toBe(true)
    expect(marker.held('agent:b')).toBe(false)
    expect(path.isAbsolute(marker.path('agent:a'))).toBe(true)
    expect(path.dirname(marker.path('agent:a'))).toBe(directory)
    expect(path.basename(marker.path('agent:a'))).toMatch(/^[0-9a-f]{32}$/)
    expect(marker.path('agent:a')).not.toBe(marker.path('agent:b'))
    expect(statSync(directory).mode & 0o077).toBe(0)

    expect(marker.lift('agent:a')).toBe(true)
    expect(marker.held('agent:a')).toBe(false)
    expect(existsSync(marker.path('agent:a'))).toBe(false)
  })

  it('is idempotent both ways', () => {
    const { holds: marker } = holds()

    expect(marker.lift('agent:a')).toBe(true)
    expect(marker.hold('agent:a')).toBe(true)
    expect(marker.hold('agent:a')).toBe(true)
    expect(marker.lift('agent:a')).toBe(true)
    expect(marker.lift('agent:a')).toBe(true)
  })

  it('fails closed: a hold that cannot be written is reported, a marker that cannot be removed stays held', () => {
    const { directory, holds: marker } = holds()
    const root = path.dirname(path.dirname(directory))

    // Nothing can be written under an unwritable folder: no marker is made, and the caller learns that.
    mkdirSync(path.join(root, 'locked'), { mode: 0o500 })
    const blocked = new MatrixCronHolds(path.join(root, 'locked', 'cron-holds'))
    expect(blocked.hold('agent:a')).toBe(false)
    expect(blocked.held('agent:a')).toBe(false)

    // A marker that cannot be removed stays a hold.
    expect(marker.hold('agent:a')).toBe(true)
    chmodSync(directory, 0o500)
    expect(marker.lift('agent:a')).toBe(false)
    expect(marker.held('agent:a')).toBe(true)
  })
})

describe('reconciling a ticker that is already running', () => {
  const hold = { holdUntilAnswering: true }
  const run = { holdUntilAnswering: false }

  /** Holds whose folder can never be made (a file sits where it should be), so a hold fails. */
  function unwritable(): MatrixCronHolds {
    const root = mkdtempSync(path.join(tmpdir(), 'atum-cron-hold-'))
    roots.push(root)
    writeFileSync(path.join(root, 'not-a-folder'), '')

    return new MatrixCronHolds(path.join(root, 'not-a-folder', 'cron-holds'))
  }

  it('reports a running ticker un-held when the hold it needs cannot be written, so the backend is restarted without it', () => {
    expect(reconcileMatrixJobsHold(unwritable(), 'agent:a', hold, true)).toEqual({ unheld: true })
  })

  it('has nothing to stop on a backend launched without a ticker', () => {
    expect(reconcileMatrixJobsHold(unwritable(), 'agent:a', hold, false)).toEqual({ unheld: false })
  })

  it('leaves a held ticker running, writes the marker once and keeps it', () => {
    const { holds: marker } = holds()

    expect(reconcileMatrixJobsHold(marker, 'agent:a', hold, true)).toEqual({ unheld: false })
    expect(marker.held('agent:a')).toBe(true)
    expect(reconcileMatrixJobsHold(marker, 'agent:a', hold, true)).toEqual({ unheld: false })
    expect(marker.held('agent:a')).toBe(true)
  })

  it('lifts the hold for the Mac that answers, and a lift that fails is still a hold, never an un-held ticker', () => {
    const { directory, holds: marker } = holds()

    expect(marker.hold('agent:a')).toBe(true)
    chmodSync(directory, 0o500)
    expect(reconcileMatrixJobsHold(marker, 'agent:a', run, true)).toEqual({ unheld: false })
    expect(marker.held('agent:a')).toBe(true)

    chmodSync(directory, 0o700)
    expect(reconcileMatrixJobsHold(marker, 'agent:a', run, true)).toEqual({ unheld: false })
    expect(marker.held('agent:a')).toBe(false)
  })

  it('stops reporting once the hold can be written again', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'atum-cron-hold-'))
    roots.push(root)
    // A file where the markers' folder should be: nothing can be written until it is gone.
    writeFileSync(path.join(root, 'device'), '')
    const marker = new MatrixCronHolds(path.join(root, 'device', 'cron-holds'))

    expect(reconcileMatrixJobsHold(marker, 'agent:a', hold, true)).toEqual({ unheld: true })

    rmSync(path.join(root, 'device'))
    expect(reconcileMatrixJobsHold(marker, 'agent:a', hold, true)).toEqual({ unheld: false })
    expect(marker.held('agent:a')).toBe(true)
  })
})

it('persists managed inventory separately from the whole-profile hold', async () => {
  const { readFileSync } = await import('node:fs')
  const fixture = holds()
  fixture.holds.managed('agent', ['managed', 'managed'])
  expect(fixture.holds.held('agent')).toBe(false)
  const restarted = new MatrixCronHolds(fixture.directory)
  expect(JSON.parse(readFileSync(`${restarted.path('agent')}.managed`, 'utf8')).jobIds).toEqual(['managed'])
  restarted.hold('agent')
  restarted.clearManaged('agent')
  expect(restarted.held('agent')).toBe(true)
})
