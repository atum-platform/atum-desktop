import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { followupSweepSuggestionNote, type FollowupSweepSuggestionNote } from '../../../shared/src/followup-sweep'

/** The one owner-scoped quiet-suggestion note the Mac sweep keeps between ticks and restarts. */
export interface BackgroundSweepSuggestionStore {
  read(owner: string): FollowupSweepSuggestionNote | null
  write(note: FollowupSweepSuggestionNote): void
  admit(owner: string, date: string): void
}

const KEEP_MS = 7 * 24 * 60 * 60_000

/**
 * One small file per owner (hashed name, never the raw user ID). The note only decides whether
 * today's model call is skipped and which text yesterday should not repeat; the platform's
 * owner-wide finding hash remains the publication gate.
 */
export class MatrixBackgroundSweepSuggestions implements BackgroundSweepSuggestionStore {
  constructor(private readonly directory: string, private readonly clock: () => number = Date.now) {}

  private file(owner: string): string {
    return path.join(this.directory, createHash('sha256').update(owner).digest('hex').slice(0, 32))
  }

  read(owner: string): FollowupSweepSuggestionNote | null {
    if (!owner) {return null}
    const file = this.file(owner)

    try {
      if (!existsSync(file)) {return null}
      const note = followupSweepSuggestionNote(JSON.parse(readFileSync(file, 'utf8')))

      if (!note || note.owner !== owner || this.clock() - note.at > KEEP_MS) {
        rmSync(file, { force: true })

        return null
      }

      return note
    } catch {
      return null
    }
  }

  write(note: FollowupSweepSuggestionNote): void {
    const parsed = followupSweepSuggestionNote(note)

    if (!parsed) {return}

    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const file = this.file(parsed.owner)
      const temporary = `${file}.tmp`
      writeFileSync(temporary, JSON.stringify(parsed), { mode: 0o600 })
      renameSync(temporary, file)
    } catch {
      // A write failure only delays the next check; the platform hash still gates publication.
    }
  }

  /** Mark today's note admitted only after the platform settled it as an offer. */
  admit(owner: string, date: string): void {
    const note = this.read(owner)

    if (note && note.date === date && !note.admitted) {this.write({ ...note, admitted: true })}
  }
}
