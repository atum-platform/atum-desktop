import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MatrixBackgroundSweepSuggestions } from './background-sweep-suggestions'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {rmSync(directory, { recursive: true, force: true })}
})

const note = { owner: '@owner:atum.test', date: '2026-10-26', at: 1_792_989_000_000,
  text: 'Shall I turn the launch notes into a one-page plan?', admitted: false }

function store(clock = () => note.at) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'atum-sweep-suggestions-'))
  directories.push(directory)

  return { directory, suggestions: new MatrixBackgroundSweepSuggestions(directory, clock) }
}

describe('the Mac background sweep suggestion note', () => {
  it('round-trips one owner note and marks it admitted once', () => {
    const { suggestions } = store()

    suggestions.write(note)
    expect(suggestions.read(note.owner)).toEqual(note)

    suggestions.admit(note.owner, '2026-10-27')
    expect(suggestions.read(note.owner)).toEqual(note)
    suggestions.admit(note.owner, note.date)
    expect(suggestions.read(note.owner)).toEqual({ ...note, admitted: true })
  })

  it('treats another owner, an old note and a corrupt file as absent', () => {
    const { directory, suggestions } = store(() => note.at + 8 * 24 * 60 * 60_000)

    suggestions.write(note)
    expect(suggestions.read('@other:atum.test')).toBeNull()

    const file = path.join(directory, createHash('sha256').update(note.owner).digest('hex').slice(0, 32))
    writeFileSync(file, '{}')
    expect(suggestions.read(note.owner)).toBeNull()
    writeFileSync(file, JSON.stringify(note))
    expect(suggestions.read(note.owner)).toBeNull()
  })

  it('never writes a malformed note', () => {
    const { suggestions } = store()

    // Since the investigate-first rule, a finding plus a recommendation need not end in a question;
    // a multi-line or bulleted note is still malformed.
    suggestions.write({ ...note, text: 'Line one\nline two' })
    expect(suggestions.read(note.owner)).toBeNull()
    suggestions.write({ ...note, text: '- a bullet, not a sentence' })
    expect(suggestions.read(note.owner)).toBeNull()
  })

  it('keeps a one-line finding and recommendation without a question', () => {
    const { suggestions } = store()

    suggestions.write({ ...note, text: 'Vercel spend rose on the Shell project; lower its log drain retention.' })
    expect(suggestions.read(note.owner)?.text).toContain('Vercel spend rose')
  })
})
