import { describe, expect, it } from 'vitest'

import type { MatrixPetDiagnostic } from '../../shared/matrix-pet-diagnostic'

import { MATRIX_PET_LOG_BUDGET, MATRIX_PET_LOG_BUDGET_MS, MatrixPetDiagnosticLog } from './pet-diagnostic-log'

function line(
  x: number,
  pose: MatrixPetDiagnostic['pose'] = 'run',
  work: MatrixPetDiagnostic['work'] = 'idle'
): MatrixPetDiagnostic {
  return { event: 'state', agent: 'agent-a', work, pose, surface: 'floor', x, window: 'focused', repeats: 0 }
}

describe('main.log companion lines', () => {
  it('writes a valid line as one tagged line and ignores anything else', () => {
    const written: string[] = []
    const log = new MatrixPetDiagnosticLog(value => written.push(value), () => 0)

    log.observe(line(2))
    log.observe({ ...line(2), body: 'hello' })
    log.observe('[Matrix] pet anything')

    expect(written).toEqual(['[Matrix] pet agent=agent-a event=state work=idle pose=run surface=floor x=2 window=focused'])
  })

  it('folds the same line repeated within seconds into one, counted on its next write', () => {
    let now = 0
    const written: string[] = []
    const log = new MatrixPetDiagnosticLog(value => written.push(value), () => now)

    log.observe(line(2))
    log.observe(line(2))
    now = 11_000
    log.observe(line(2))

    expect(written).toEqual([
      '[Matrix] pet agent=agent-a event=state work=idle pose=run surface=floor x=2 window=focused',
      '[Matrix] pet agent=agent-a event=state work=idle pose=run surface=floor x=2 window=focused count=2'
    ])
  })

  it('writes a line that comes back after another, however soon', () => {
    const written: string[] = []
    const log = new MatrixPetDiagnosticLog(value => written.push(value), () => 0)

    log.observe(line(2, 'idle'))
    log.observe(line(2, 'failed', 'failed'))
    log.observe(line(2, 'idle'))

    expect(written).toHaveLength(3)
    expect(written.at(-1)).toContain('work=idle pose=idle')
  })

  it('bounds a flood within its budget and says how many it dropped', () => {
    let now = 0
    const written: string[] = []
    const log = new MatrixPetDiagnosticLog(value => written.push(value), () => now)
    const poses = ['idle', 'run', 'jump', 'waiting', 'lounging', 'review', 'wave', 'sleep', 'carried', 'failed'] as const
    const work = ['idle', 'working', 'waiting', 'failed'] as const

    // Every line distinct, as a renderer gone wrong might send them.
    for (let index = 0; index < 3 * MATRIX_PET_LOG_BUDGET; index += 1) {
      log.observe(line(index % 10, poses[Math.floor(index / 10) % 10], work[Math.floor(index / 100) % 4]))
    }

    expect(written).toHaveLength(MATRIX_PET_LOG_BUDGET)

    now = MATRIX_PET_LOG_BUDGET_MS
    log.observe(line(9, 'idle'))
    expect(written).toHaveLength(MATRIX_PET_LOG_BUDGET + 1)
    expect(written.at(-1)).toMatch(/ dropped=\d+$/)
  })
})
