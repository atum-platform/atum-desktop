import type { EclipseFacts } from './eclipse-canvas'

/**
 * The first-launch story as a script for the launch eclipse (once per install, before
 * sign-in): out of the night one spark, then the corona blooms around the unseen moon; five
 * beads of sunlight break through one by one (the launch's own beads); they run together into
 * the diamond ring, the first word, and the line "Speak, and it becomes." appears; the moon
 * slides off into the mark's crescent; the night lifts onto the sign-in screen and the mark
 * lands on its mark. Seconds from the start; the words' CSS reads the same times.
 */
export const STORY = {
  spark: 0.45,
  beads: [2.7, 3.15, 3.6, 4.05, 4.5],
  lit: 4.9,
  /** The diamond ring flashes 0.38 s after `lit` (engine.ts): the voice and the line follow it. */
  wave: 5.2,
  line: 5.5,
  linePhrase: 0.32,
  sub: 6.9,
  wordsOut: 8,
  leave: 8.3,
  /** The overlay fades once the mark has landed (the flight is 1.45 s). */
  out: 9.8,
  done: 10.3
} as const

/** With Reduce Motion: the mark is there, the words fade in, then everything fades. */
export const REDUCED_STORY = { line: 0.9, sub: 1.5, leave: 3.4, done: 4.1 } as const

/** What the eclipse shows `t` seconds into the story. */
export function storyFacts(t: number, reduced: boolean): EclipseFacts {
  if (reduced) {
    return { brief: false, current: -1, phase: t >= REDUCED_STORY.leave ? 'leaving' : 'checking', reduced, settled: 0 }
  }

  const settled = STORY.beads.filter(at => t >= at).length

  if (t >= STORY.lit) {
    return { brief: false, current: 5, phase: t >= STORY.leave ? 'leaving' : 'lit', reduced, settled: 5 }
  }

  // The spark is the third bead's place shimmering alone; then the beads break through in turn.
  const current = settled > 0 ? settled : t >= STORY.spark ? 2 : -1

  return { brief: false, current, phase: 'checking', reduced, settled }
}
