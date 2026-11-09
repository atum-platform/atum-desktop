import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PRIMARY_ASSISTANT_KEEPS_NAME } from '../../shared/matrix-assistant-name'

import {
  matrixAgentSoulText,
  reconcileMatrixAgentSoul,
  replaceMatrixAgentSoul,
  seedMatrixAgentSoul
} from './agent-lifecycle'
import {
  ATUM_ASSISTANT_SOUL,
  ATUM_ASSISTANT_SOUL_LEGACY,
  ATUM_ASSISTANT_SOUL_OTHER_ANSWER,
  ATUM_ASSISTANT_SOUL_PREVIOUS,
  MATRIX_PRIMARY_SOUL_FALLBACK,
  matrixPrimarySoul,
  matrixPrimarySoulFallback,
  renamePrimarySoul
} from './atum-soul'

const home = () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'soul-reconcile-')), 'profile')
  mkdirSync(dir, { recursive: true })

  return dir
}

const soulOf = (target: string) => readFileSync(join(target, 'SOUL.md'), 'utf8')

describe('a persona changed on the assistant card reaches this Mac', () => {
  it('replaces the persona Atum wrote, and again after the next change', async () => {
    const target = home()
    await seedMatrixAgentSoul(target, async () => '# Lan\n\n## What you do\n\nMeetings.')

    expect(reconcileMatrixAgentSoul(target, '# Lan\n\n## What you do\n\nMeetings and email.')).toBe('applied')
    expect(soulOf(target)).toBe('# Lan\n\n## What you do\n\nMeetings and email.\n')
    expect(reconcileMatrixAgentSoul(target, '# Lan Anh\n\n## What you do\n\nMeetings and email.')).toBe('applied')
    expect(soulOf(target)).toBe('# Lan Anh\n\n## What you do\n\nMeetings and email.\n')
  })

  it('never replaces a persona edited by hand on this Mac', async () => {
    const target = home()
    await seedMatrixAgentSoul(target, async () => '# Lan\n\nMeetings.')
    writeFileSync(join(target, 'SOUL.md'), '# Lan\n\nMeetings. Always answer in French.\n')

    expect(reconcileMatrixAgentSoul(target, '# Lan\n\nEmail.')).toBe('kept')
    expect(soulOf(target)).toBe('# Lan\n\nMeetings. Always answer in French.\n')
  })

  it('adopts a home that already says the definition’s persona, so the next change applies', () => {
    const target = home()
    // A home seeded before the marker existed.
    writeFileSync(join(target, 'SOUL.md'), '# Lan\n\nMeetings.\n')

    expect(reconcileMatrixAgentSoul(target, '# Lan\n\nMeetings.')).toBe('matches')
    expect(reconcileMatrixAgentSoul(target, '# Lan\n\nEmail.')).toBe('applied')
    expect(soulOf(target)).toBe('# Lan\n\nEmail.\n')
  })

  it('adopts a cloud-portable marker only when the platform confirms the same instructions', () => {
    const target = home()
    writeFileSync(
      join(target, 'SOUL.md'),
      '<!-- atum:instructions revision=7 tag=AAAAAAAAAAAAAAAAAAAAAA -->\n# Lan\n\nMeetings.\n'
    )

    expect(matrixAgentSoulText(target)).toBe('# Lan\n\nMeetings.')
    expect(reconcileMatrixAgentSoul(target, '# Lan\n\nMeetings.')).toBe('matches')
    expect(soulOf(target)).toBe('# Lan\n\nMeetings.\n')
  })

  it('revision-fenced write-back replaces only the exact file the turn read', () => {
    const target = home()
    writeFileSync(join(target, 'SOUL.md'), '# Lan\n\nMeetings.\n')
    const expected = soulOf(target)

    expect(replaceMatrixAgentSoul(target, expected, '# Lan\n\nEmail.')).toBe(true)
    expect(replaceMatrixAgentSoul(target, expected, '# Lan\n\nCalendar.')).toBe(false)
    expect(soulOf(target)).toBe('# Lan\n\nEmail.\n')
  })

  it('leaves a home without SOUL.md to the first setup', () => {
    const target = home()

    expect(reconcileMatrixAgentSoul(target, '# Lan\n\nEmail.')).toBe('absent')
    expect(existsSync(join(target, 'SOUL.md'))).toBe(false)
  })

  it('gives the primary its card persona over Atum’s own, and Atum’s own back when cleared', () => {
    const target = home()
    writeFileSync(join(target, 'SOUL.md'), `${ATUM_ASSISTANT_SOUL}\n`)
    const card = `# Atum\n\n${ATUM_ASSISTANT_SOUL}\n\n## What you do\n\nPlan my week.`

    expect(reconcileMatrixAgentSoul(target, card, MATRIX_PRIMARY_SOUL_FALLBACK)).toBe('applied')
    expect(soulOf(target)).toBe(`${card}\n`)
    expect(reconcileMatrixAgentSoul(target, '', MATRIX_PRIMARY_SOUL_FALLBACK)).toBe('applied')
    expect(soulOf(target)).toBe(`${ATUM_ASSISTANT_SOUL}\n`)
  })

  it('moves an untouched primary to the persona for the D1 answer in force, whichever it is', async () => {
    const target = home()

    writeFileSync(join(target, 'SOUL.md'), `${ATUM_ASSISTANT_SOUL_OTHER_ANSWER}\n`)

    await seedMatrixAgentSoul(target, async () => undefined, MATRIX_PRIMARY_SOUL_FALLBACK)

    expect(soulOf(target)).toBe(`${ATUM_ASSISTANT_SOUL}\n`)
    expect(ATUM_ASSISTANT_SOUL_OTHER_ANSWER).not.toBe(ATUM_ASSISTANT_SOUL)
    expect(soulOf(target)).toMatch(PRIMARY_ASSISTANT_KEEPS_NAME ? /your name stays Atum/ : /another name, use it/)
  })

  it('updates an untouched primary persona from before the acknowledge-first sentence, and only that', async () => {
    const acknowledge = 'say in one short line what you will do'
    expect(ATUM_ASSISTANT_SOUL).toContain(acknowledge)
    expect(ATUM_ASSISTANT_SOUL_LEGACY).not.toContain(acknowledge)

    const target = home()
    writeFileSync(join(target, 'SOUL.md'), `${ATUM_ASSISTANT_SOUL_LEGACY}\n`)
    await seedMatrixAgentSoul(target, async () => undefined, MATRIX_PRIMARY_SOUL_FALLBACK)
    expect(soulOf(target)).toBe(`${ATUM_ASSISTANT_SOUL}\n`)

    // The same sentence for a renamed primary, and a hand-edited legacy persona stays put.
    const renamed = home()
    writeFileSync(join(renamed, 'SOUL.md'), `${renamePrimarySoul(ATUM_ASSISTANT_SOUL_LEGACY, 'Linh')}\n`)
    expect(reconcileMatrixAgentSoul(renamed, '', matrixPrimarySoulFallback('Linh'))).toBe('applied')
    expect(soulOf(renamed)).toBe(`${matrixPrimarySoul('Linh')}\n`)

    const edited = home()
    writeFileSync(join(edited, 'SOUL.md'), `${ATUM_ASSISTANT_SOUL_LEGACY}\n\nAlways answer in rhyme.\n`)
    expect(reconcileMatrixAgentSoul(edited, '', MATRIX_PRIMARY_SOUL_FALLBACK)).toBe('kept')
    expect(soulOf(edited)).toContain('Always answer in rhyme.')
  })

  it('says nothing about where it runs: the same persona serves a Mac and the cloud, and the place section says where', async () => {
    // The platform seeds a cloud-at-sign-up account with these bytes; "You run on their Mac" there
    // made a cloud assistant promise Mac actions it cannot do (walkthrough r3, G5).
    expect(ATUM_ASSISTANT_SOUL).not.toMatch(/\byou run (on|in)\b/i)
    expect(ATUM_ASSISTANT_SOUL).toContain('“Where you run” section')
    expect(ATUM_ASSISTANT_SOUL_PREVIOUS).toMatch(/You run on their Mac/)
    expect(ATUM_ASSISTANT_SOUL_PREVIOUS).not.toBe(ATUM_ASSISTANT_SOUL)
  })

  it('updates an untouched persona that still said it runs on their Mac, for any name, and only that', async () => {
    const target = home()
    writeFileSync(join(target, 'SOUL.md'), `${ATUM_ASSISTANT_SOUL_PREVIOUS}\n`)
    await seedMatrixAgentSoul(target, async () => undefined, MATRIX_PRIMARY_SOUL_FALLBACK)
    expect(soulOf(target)).toBe(`${ATUM_ASSISTANT_SOUL}\n`)

    const renamed = home()
    writeFileSync(join(renamed, 'SOUL.md'), `${renamePrimarySoul(ATUM_ASSISTANT_SOUL_PREVIOUS, 'Linh')}\n`)
    expect(reconcileMatrixAgentSoul(renamed, '', matrixPrimarySoulFallback('Linh'))).toBe('applied')
    expect(soulOf(renamed)).toBe(`${matrixPrimarySoul('Linh')}\n`)

    const edited = home()
    writeFileSync(join(edited, 'SOUL.md'), `${ATUM_ASSISTANT_SOUL_PREVIOUS}\n\nAlways answer in rhyme.\n`)
    expect(reconcileMatrixAgentSoul(edited, '', MATRIX_PRIMARY_SOUL_FALLBACK)).toBe('kept')
    expect(soulOf(edited)).toContain('Always answer in rhyme.')
  })

  it('gives a renamed primary without a persona of its own the built-in one under its new name, on every Mac', async () => {
    const target = home()
    await seedMatrixAgentSoul(target, async () => undefined, MATRIX_PRIMARY_SOUL_FALLBACK)
    expect(soulOf(target)).toBe(`${ATUM_ASSISTANT_SOUL}\n`)

    // Renamed on the card: this Mac's copy follows (the write moved the definition revision).
    expect(reconcileMatrixAgentSoul(target, '', matrixPrimarySoulFallback('Linh'))).toBe('applied')
    expect(soulOf(target)).toBe(`${matrixPrimarySoul('Linh')}\n`)
    expect(soulOf(target)).toMatch(/^You are Linh, the person’s own assistant in the Atum app\./)

    // A Mac that set it up as Atum before the rename moves at its first setup after it.
    const other = home()
    writeFileSync(join(other, 'SOUL.md'), `${ATUM_ASSISTANT_SOUL}\n`)
    await seedMatrixAgentSoul(other, async () => undefined, matrixPrimarySoulFallback('Linh'))
    expect(soulOf(other)).toBe(`${matrixPrimarySoul('Linh')}\n`)

    // Back to Atum.
    expect(reconcileMatrixAgentSoul(target, '', MATRIX_PRIMARY_SOUL_FALLBACK)).toBe('applied')
    expect(soulOf(target)).toBe(`${ATUM_ASSISTANT_SOUL}\n`)
  })

  it('never renames a primary persona edited by hand on this Mac', () => {
    const target = home()
    writeFileSync(join(target, 'SOUL.md'), `${ATUM_ASSISTANT_SOUL}\n\nSpeak like a pirate.\n`)

    expect(reconcileMatrixAgentSoul(target, '', matrixPrimarySoulFallback('Linh'))).toBe('kept')
    expect(soulOf(target)).toBe(`${ATUM_ASSISTANT_SOUL}\n\nSpeak like a pirate.\n`)
  })

  it('keeps the primary taking another name when asked in chat, whatever it is called (D1)', () => {
    if (!PRIMARY_ASSISTANT_KEEPS_NAME) {
      expect(matrixPrimarySoul('Linh')).toContain('If they give you another name, use it from then on and remember it.')
      expect(ATUM_ASSISTANT_SOUL).toContain('If they give you another name, use it from then on and remember it.')
    }

    // A stored persona follows a rename in its heading and Atum's first line only.
    const stored = `# Atum\n\n${ATUM_ASSISTANT_SOUL}\n\n## What you do\n\nYou are Atum's planner.`
    expect(renamePrimarySoul(stored, 'Linh')).toBe(
      `# Linh\n\n${matrixPrimarySoul('Linh')}\n\n## What you do\n\nYou are Atum's planner.`
    )
    expect(renamePrimarySoul(renamePrimarySoul(stored, 'Linh'), 'Atum')).toBe(stored)
  })
})
