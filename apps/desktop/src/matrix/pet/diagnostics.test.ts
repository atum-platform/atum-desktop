import { describe, expect, it } from 'vitest'

import type { MatrixPetDiagnostic } from '../../../shared/matrix-pet-diagnostic'

import {
  createPetDiagnostics,
  PET_START_LINE_MS,
  PET_STATE_LINE_MS,
  type PetDiagnosticLine,
  petLogAgent,
  petSurfaceCode,
  petXBucket
} from './diagnostics'

const base: PetDiagnosticLine = {
  event: 'state',
  agent: 'agent-a',
  work: 'idle',
  pose: 'idle',
  surface: 'floor',
  x: 2,
  window: 'focused'
}

function harness() {
  let now = 0
  const lines: MatrixPetDiagnostic[] = []
  const diagnostics = createPetDiagnostics(line => lines.push(line), () => now)

  return {
    lines,
    diagnostics,
    at(value: number) {
      now = value
    }
  }
}

describe('companion lifecycle lines in the window', () => {
  it('writes a restart at once, folds a burst for the same reason, and counts it on the next line', () => {
    const { lines, diagnostics, at } = harness()
    const start = { ...base, event: 'start' as const, reason: 'remount' as const, restore: 'saved' as const }

    expect(diagnostics.seen('p')).toBe(false)
    diagnostics.start('p', start)
    expect(diagnostics.seen('p')).toBe(true)

    for (let index = 1; index <= 5; index += 1) {
      at(index * 1000)
      diagnostics.start('p', start)
    }

    expect(lines).toEqual([{ ...start, repeats: 0 }])
    at(PET_START_LINE_MS + 1)
    diagnostics.start('p', start)
    expect(lines.at(-1)).toEqual({ ...start, repeats: 5 })
    // Another reason is news of its own.
    diagnostics.start('p', { ...start, reason: 'sprite' })
    expect(lines.at(-1)).toMatchObject({ reason: 'sprite', repeats: 0 })
  })

  it('writes what she does only when it changes, and a stuck work signal at once', () => {
    const { lines, diagnostics, at } = harness()

    diagnostics.state('p', base)
    diagnostics.state('p', { ...base, x: 5 })
    expect(lines).toHaveLength(1)

    diagnostics.state('p', { ...base, pose: 'run' })
    diagnostics.state('p', base)
    diagnostics.state('p', { ...base, pose: 'run' })
    // Back and forth within the window: each combination once.
    expect(lines.map(line => line.pose)).toEqual(['idle', 'run'])

    diagnostics.state('p', { ...base, work: 'failed', pose: 'failed' })
    expect(lines.at(-1)).toMatchObject({ work: 'failed', pose: 'failed', repeats: 0 })

    // The same pose in a window that lost focus is worth a line: it shows she was not frozen.
    diagnostics.state('p', { ...base, pose: 'run', window: 'unfocused' })
    expect(lines.at(-1)).toMatchObject({ pose: 'run', window: 'unfocused' })

    at(PET_STATE_LINE_MS)
    diagnostics.state('p', { ...base, pose: 'run' })
    expect(lines.at(-1)).toMatchObject({ pose: 'run', repeats: 1 })
  })

  it('always writes leaving a failed, hidden or nowhere-to-stand state, however soon it repeats', () => {
    const { lines, diagnostics, at } = harness()
    const failed = { ...base, work: 'failed' as const, pose: 'failed' as const }
    const hidden = { ...base, window: 'hidden' as const }
    const lost = { ...base, surface: 'hidden' as const }
    const sequence = [base, failed, base, failed, base, hidden, base, hidden, base, lost, base, lost, base]

    sequence.forEach((line, index) => {
      at(index * 10_000)
      diagnostics.state('p', line)
    })

    // Every step, all well inside the pose window: the last line is where she really is.
    expect(lines.map(line => `${line.work}|${line.window}|${line.surface}`)).toEqual(
      sequence.map(line => `${line.work}|${line.window}|${line.surface}`)
    )
    expect(lines.at(-1)).toMatchObject({ work: 'idle', window: 'focused', surface: 'floor' })
  })

  it('still says what she does after a folded restart', () => {
    const { lines, diagnostics, at } = harness()
    const start = { ...base, event: 'start' as const, reason: 'remount' as const, restore: 'saved' as const }

    diagnostics.start('p', start)
    at(1000)
    diagnostics.state('p', { ...base, work: 'failed', pose: 'failed' })
    at(2000)
    // Folded into the first restart's line: nothing sent.
    diagnostics.start('p', start)
    diagnostics.state('p', base)

    expect(lines.at(-1)).toMatchObject({ event: 'state', work: 'idle' })
  })

  it('never lets a failing bridge reach the companion', () => {
    const diagnostics = createPetDiagnostics(() => {
      throw new Error('bridge gone')
    })

    expect(() => diagnostics.state('p', base)).not.toThrow()
  })

  it('names where she is, how far across, and which agent, as closed codes', () => {
    expect(petSurfaceCode({ visible: false, perchId: 'composer:0:0' })).toBe('hidden')
    expect(petSurfaceCode({ visible: true })).toBe('floor')
    expect(petSurfaceCode({ visible: true, perchId: 'composer:0:1' })).toBe('composer')
    expect(petSurfaceCode({ visible: true, perchId: 'shelf:2:0' })).toBe('perch')

    const world = { width: 800, floorY: 700, free: [], perches: [] }
    expect(petXBucket(0, world, 89)).toBe(0)
    expect(petXBucket(711, world, 89)).toBe(9)
    expect(petXBucket(355, world, 89)).toBe(4)
    expect(petXBucket(355, undefined, 89)).toBeNull()

    expect(petLogAgent('00000000-0000-4000-8000-efa29b6dcd4a')).toBe('00000000')
    expect(petLogAgent('["scope","agent"]')).toBe('scopeage')
    expect(petLogAgent('')).toBe('none')
  })
})
