/**
 * The sweeping of what a killed checkpoint or restore left on the disk (`staging.ts`).
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { removeOtherStaging, sweepStagingAtStart } from './staging'
import { scratchDirectory } from './world.fixture'

/** A staged folder with a plaintext archive and a sealed one in it, the way a killed checkpoint leaves it. */
function stage(work: string, agent: string, name: string): string {
  const folder = path.join(work, agent, name)
  mkdirSync(path.join(folder, 'snapshot', 'files'), { recursive: true })
  writeFileSync(path.join(folder, 'checkpoint.plain'), 'plaintext of the portable part')
  writeFileSync(path.join(folder, 'checkpoint.sealed'), 'sealed')

  return folder
}

describe('what a killed process left, swept when the app starts', () => {
  it('removes every staged folder and stray file of every agent, except the folder the journal names as a live checkpoint’s own', () => {
    const work = scratchDirectory('atum-staging-')
    const [a, b] = [randomUUID(), randomUUID()]
    const live = randomUUID()
    const kept = stage(work, a, live)
    const orphan = stage(work, a, randomUUID())
    const restore = stage(work, a, `restore-3-${randomUUID()}`)
    const measure = stage(work, a, `measure-${randomUUID()}`)
    const otherAgents = stage(work, b, randomUUID())
    writeFileSync(path.join(work, a, 'stray.sealed'), 'stray')

    const log: string[] = []
    const removed = sweepStagingAtStart(work, agent => (agent === a ? live : undefined), line => log.push(line))

    expect(removed).toBe(5)
    expect(existsSync(path.join(kept, 'checkpoint.sealed'))).toBe(true)

    for (const gone of [orphan, restore, measure, otherAgents, path.join(work, a, 'stray.sealed')]) {
      expect(existsSync(gone), gone).toBe(false)
    }

    expect(readdirSync(path.join(work, a))).toEqual([live])
    expect(log).toEqual(['[Home] removed 5 leftover staging entries of a checkpoint or restore that did not finish'])
  })

  it('keeps nothing of an agent whose journal names no live checkpoint, and says nothing when there was nothing to remove', () => {
    const work = scratchDirectory('atum-staging-')
    const agent = randomUUID()
    stage(work, agent, randomUUID())

    expect(sweepStagingAtStart(work, () => undefined)).toBe(1)
    expect(readdirSync(path.join(work, agent))).toEqual([])

    const log: string[] = []

    expect(sweepStagingAtStart(work, () => undefined, line => log.push(line))).toBe(0)
    expect(log).toEqual([])
  })

  it('touches only folders named for an agent, never follows a link, and survives a work folder that is not there', () => {
    const work = scratchDirectory('atum-staging-')
    const outside = scratchDirectory('atum-outside-')
    const agent = randomUUID()
    writeFileSync(path.join(outside, 'precious.txt'), 'not staging')
    mkdirSync(path.join(work, 'notes-from-someone'), { recursive: true })
    writeFileSync(path.join(work, 'notes-from-someone', 'keep.txt'), 'not an agent’s folder')
    mkdirSync(path.join(work, agent), { recursive: true })
    symlinkSync(outside, path.join(work, agent, 'a-link'))

    expect(sweepStagingAtStart(work, () => undefined)).toBe(1)

    // The link went; what it pointed at did not.
    expect(readdirSync(path.join(work, agent))).toEqual([])
    expect(readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('not staging')
    expect(readFileSync(path.join(work, 'notes-from-someone', 'keep.txt'), 'utf8')).toBe('not an agent’s folder')
    expect(sweepStagingAtStart(path.join(work, 'does-not-exist'), () => undefined)).toBe(0)
  })
})

describe('what another run left, swept when a checkpoint holds its reservation', () => {
  it('removes everything of that agent’s except the one folder, and nothing of another agent’s', async () => {
    const work = scratchDirectory('atum-staging-')
    const [a, b] = [randomUUID(), randomUUID()]
    const own = randomUUID()
    stage(work, a, own)
    stage(work, a, randomUUID())
    stage(work, a, `restore-2-${randomUUID()}`)
    writeFileSync(path.join(work, a, 'stray.plain'), 'stray')
    const theirs = stage(work, b, randomUUID())

    await removeOtherStaging(path.join(work, a), own)

    expect(readdirSync(path.join(work, a))).toEqual([own])
    expect(existsSync(path.join(theirs, 'checkpoint.sealed'))).toBe(true)
  })

  it('has nothing to do for an agent that has staged nothing', async () => {
    const work = scratchDirectory('atum-staging-')

    await expect(removeOtherStaging(path.join(work, randomUUID()), randomUUID())).resolves.toBeUndefined()
  })
})
