/** Preserve user-visible identity, state and recovery behavior across connection changes. */
import type { MatrixContinuityRead } from './matrix-continuity'

const NAME_MAX = 48

/** The name as it goes into one line of the note: the person's own, with nothing that could end it. */
function noteName(name: string): string {
  return name
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}[\]“”"]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
}

/** What only the assistant sees with the person's first words (one use per account). */
export function matrixFirstRunNamingNote(name: string): string {
  const shown = noteName(name) || 'Atum'

  return [
    `[Atum note: Atum’s welcome, which the person saw as your first message, said you are “${shown}” and invited them to keep that or give you a name they like.`,
    `If their message names you, even with one bare word, set it: read your profile with atum_agents, then make one atum_agents update that carries only display_name and both revisions you read, and confirm in one short sentence, in the language they write in, using the new name.`,
    `If they say to keep “${shown}”, say so in one short sentence.`,
    `If Atum refuses the name, tell them why in plain words and ask for another; do not try the same name again.`,
    `If their message is about something else, just help and do not mention this note.]`
  ].join(' ')
}

/**
 * Whether a bounded read of a chat up to (not including) the person's message found nothing before
 * it: no dialogue, nothing unreadable, nothing missed. Only then is the message the first one. A
 * read that is partial, or that could not read an assistant answer, proves nothing and is not first.
 */
export function matrixFirstRunNoEarlierDialogue(
  read: Pick<MatrixContinuityRead, 'entries' | 'reachedStop' | 'gaps' | 'uncertainAgent'>
): boolean {
  return read.entries.length === 0 && read.reachedStop && read.gaps === 0 && !read.uncertainAgent
}
