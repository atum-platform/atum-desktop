/**
 * Pure decision helpers for the floating pet's wander — the "what to do & when"
 * layer, split out from the geometry (`roam-geometry.ts`) and the RAF/DOM loop
 * (`use-pet-roam.ts`) so the *rhythm* of the roam is tunable in one place and
 * unit testable (every function takes an injectable `rng`).
 *
 * The goal is a calm, believable critter rather than a fidgeting one. Two ideas
 * from ambient game-AI carry the weight (see GameAIPro ch.36 "Breathing Life
 * into Your Background Characters" + standard idle/wander state machines):
 *
 *  1. **Loaf, don't pace.** A background character that picks a new walk on
 *     every beat reads as nervous. Most decision beats just keep resting;
 *     movement is the exception, not the default (`REST_CHANCE`).
 *  2. **Memoryless dwell times.** Uniform pauses feel metronomic. An
 *     exponential dwell — the classic model for idle durations — gives mostly
 *     short rests with the occasional long loaf, so the cadence never reads as a
 *     fixed pattern (`dwellMs` / `PAUSE_DWELL`).
 */

/** A portable perch extent; no shell geometry dependency. */
import type { PetState } from '../pet'

export interface Ledge {
  y: number
  left: number
  right: number
}

export type Rng = () => number

/** What the pet does when a rest beat ends. */
export type RoamMove = 'rest' | 'stroll' | 'hop'

export interface DwellRange {
  /** Mean of the exponential draw — the "typical" rest length. */
  meanMs: number
  /** Floor, so a near-zero draw never produces a jittery micro-pause. */
  minMs: number
  /** Ceiling, so a fat-tail draw (or a throttled tab) can't freeze the pet. */
  maxMs: number
}

// Rest length between beats: mostly short loafs, the occasional long one.
export const PAUSE_DWELL: DwellRange = { maxMs: 13000, meanMs: 4200, minMs: 1500 }
// Most beats the pet just keeps loafing — a critter that re-walks every beat
// reads as nervous, not alive.
export const REST_CHANCE = 0.62
// When it *does* move, chance it hops to another ledge vs. strolling this one.
export const HOP_CHANCE = 0.2
// Strolls should cover ground, not shuffle: travel at least this fraction of the
// ledge (or this many px, whichever is larger), up to the room available.
const STROLL_MIN_FRACTION = 0.45
const STROLL_MIN_PX = 110
// Bias toward the roomier side so the pet crosses the app instead of pacing one
// spot; the long tail of the coin still lets it double back now and then.
const STROLL_TOWARD_ROOM = 0.85

/**
 * Exponential (memoryless) dwell time, clamped to `[minMs, maxMs]`. With rng→0
 * this returns `minMs`; with rng→1 it saturates at `maxMs`; in between it's
 * `-ln(u)·meanMs`, so short rests dominate and long loafs are rare but possible.
 */
export function dwellMs({ meanMs, minMs, maxMs }: DwellRange, rng: Rng = Math.random): number {
  const u = 1 - rng() // map [0,1) → (0,1] so the log stays finite

  return Math.min(maxMs, Math.max(minMs, -Math.log(u) * meanMs))
}

/**
 * Decide a beat: rest (the common case), or — when the pet is actually going to
 * move — hop to a reachable ledge if one exists and the dice say so, else stroll
 * the current ledge. `canHop` is false when no neighbouring surface overlaps, so
 * the pet never "hops" in place.
 */
export function chooseMove(
  canHop: boolean,
  rng: Rng = Math.random,
  { restChance = REST_CHANCE, hopChance = HOP_CHANCE }: { restChance?: number; hopChance?: number } = {}
): RoamMove {
  if (rng() < restChance) {
    return 'rest'
  }

  return canHop && rng() < hopChance ? 'hop' : 'stroll'
}

/**
 * A stroll destination (absolute x) on `ledge` that actually goes somewhere:
 * lean toward the side with more room and guarantee a decent minimum travel, so
 * the pet crosses the app rather than shuffling in place.
 */
export function pickStrollTarget(ledge: Ledge, fromX: number, rng: Rng = Math.random): number {
  const span = ledge.right - ledge.left

  if (span <= 4) {
    return ledge.left
  }

  const roomLeft = fromX - ledge.left
  const roomRight = ledge.right - fromX
  // Usually head to the roomier side; the long tail of the coin doubles back.
  const goRight = rng() < STROLL_TOWARD_ROOM === roomRight >= roomLeft
  const room = Math.max(0, goRight ? roomRight : roomLeft)
  const minDist = Math.min(room, Math.max(span * STROLL_MIN_FRACTION, STROLL_MIN_PX))
  const dist = minDist + rng() * Math.max(0, room - minDist)

  return goRight ? fromX + dist : fromX - dist
}

/**
 * An idle flourish: something she does while loafing, not a way of moving.
 * `review` is the head-tilt row used as a glance — the rare idle variant that
 * costs no new art (plan 2026-09-13-pet-plans-rig-and-activities, decision 10).
 */
export type RoamGesture = 'wave' | 'waiting' | 'jump' | 'lounging' | 'review'

// How often a rest beat becomes a gesture instead of plain loafing. Low on
// purpose: the wander already earns its life from *not* doing much, and a pet
// that performs on every pause is a screensaver.
const GESTURE_CHANCE = 0.18

// Weighted toward the quiet ones. Sitting and glancing read as a creature
// occupying itself; waving and hopping read as a creature performing at you,
// so they stay rare.
export const GESTURE_WEIGHTS: ReadonlyArray<readonly [RoamGesture, number]> = [
  ['waiting', 0.5],
  ['review', 0.15],
  ['wave', 0.15],
  ['lounging', 0.1],
  ['jump', 0.1]
]

// On a perch — the top of the composer, the rail — a loaf is mostly a lounge:
// a dog that has climbed onto the furniture settles on it. Lounging on the
// floor still happens, just rarely, so the wander never reads as scripted.
export const PERCH_GESTURE_WEIGHTS: ReadonlyArray<readonly [RoamGesture, number]> = [
  ['lounging', 0.5],
  ['waiting', 0.25],
  ['review', 0.1],
  ['wave', 0.1],
  ['jump', 0.05]
]

/**
 * Pick an idle gesture for this rest beat, or null to just loaf.
 *
 * Shared with the pet tool on purpose: an assistant asking its pet to sit and
 * the pet deciding to sit must produce exactly the same behaviour, or the
 * commanded version reads as a puppet and the spontaneous one as a different
 * animal.
 */
export function chooseGesture(
  rng: Rng = Math.random,
  {
    onPerch = false,
    chance = GESTURE_CHANCE,
    weights = onPerch ? PERCH_GESTURE_WEIGHTS : GESTURE_WEIGHTS
  }: { onPerch?: boolean; chance?: number; weights?: readonly (readonly [RoamGesture, number])[] } = {}
): null | RoamGesture {
  if (rng() >= chance) {
    return null
  }

  let roll = rng()

  for (const [gesture, weight] of weights) {
    if (roll < weight) {
      return gesture
    }

    roll -= weight
  }

  return 'waiting'
}

/**
 * A routine: a few beats in a row that read as an intention rather than a
 * series of coin flips — "she went to the corner, settled, sat up, glanced
 * about, came back". Every step is an existing row or a walk, so routines are
 * range from sequencing and timing, not from new art (plan 2026-09-13,
 * decision 10). A drag or an assistant command abandons the routine.
 */
export type RoutineStep =
  /** Walk along the current ledge: to its nearer end, its farther end, or back to where the routine began. */
  | { kind: 'walk'; to: 'end' | 'far' | 'back' }
  /** Hop to a reachable ledge; skipped when none overlaps. */
  | { kind: 'hop' }
  /** Hold a pose for `ms`. */
  | { kind: 'pose'; pose: RoamGesture; ms: number }

export interface Routine {
  name: string
  steps: readonly RoutineStep[]
}

export const ROUTINES: readonly Routine[] = [
  // Off to the corner, a long settle, then sits up, looks about, and wanders back.
  {
    name: 'settle',
    steps: [
      { kind: 'walk', to: 'end' },
      { kind: 'pose', pose: 'lounging', ms: 7000 },
      { kind: 'pose', pose: 'waiting', ms: 2200 },
      { kind: 'pose', pose: 'review', ms: 1400 },
      { kind: 'walk', to: 'back' }
    ]
  },
  // A lie-down that ends in a spring up and a trot off.
  {
    name: 'stretch',
    steps: [
      { kind: 'pose', pose: 'lounging', ms: 5000 },
      { kind: 'pose', pose: 'jump', ms: 1200 },
      { kind: 'walk', to: 'far' }
    ]
  },
  // Cross to the far side, sit, cross back, sit: a patrol.
  {
    name: 'patrol',
    steps: [
      { kind: 'walk', to: 'far' },
      { kind: 'pose', pose: 'waiting', ms: 2000 },
      { kind: 'walk', to: 'back' },
      { kind: 'pose', pose: 'waiting', ms: 1600 }
    ]
  },
  // Up onto something, sit, glance, and settle there.
  {
    name: 'lookout',
    steps: [
      { kind: 'hop' },
      { kind: 'pose', pose: 'waiting', ms: 2400 },
      { kind: 'pose', pose: 'review', ms: 1400 },
      { kind: 'pose', pose: 'lounging', ms: 6000 }
    ]
  }
]

// How often a rest beat becomes a routine rather than a loaf or a single
// gesture. Rarer than a gesture: a routine is a minute of intention, and two in
// a row would read as a script.
export const ROUTINE_CHANCE = 0.1

/**
 * Pick a routine for this rest beat, or null to loaf. Routines that need a
 * ledge to hop to are only offered when one is reachable, so a routine never
 * stalls on a step it cannot take.
 */
export function chooseRoutine(
  rng: Rng = Math.random,
  {
    canHop = false,
    chance = ROUTINE_CHANCE,
    routines = ROUTINES
  }: { canHop?: boolean; chance?: number; routines?: readonly Routine[] } = {}
): null | Routine {
  if (rng() >= chance) {
    return null
  }

  const feasible = routines.filter(routine => canHop || !routine.steps.some(step => step.kind === 'hop'))

  return feasible[Math.min(feasible.length - 1, Math.floor(rng() * feasible.length))] ?? null
}

/**
 * Playback tempo for a pose: a multiplier on the sprite's loop, redrawn each
 * beat, so consecutive idles never tick like a metronome and a lounge breathes
 * slower than a sit. Locomotion stays at 1: the walk's px/s is paced to the
 * loop, and a faster loop with the same px/s would slide the feet.
 */
const TEMPO_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  idle: [0.9, 1.15],
  lounging: [1.25, 1.5],
  waiting: [1.0, 1.2],
  review: [1.0, 1.1],
  wave: [0.95, 1.05],
  jump: [1.0, 1.0],
  run: [1.0, 1.0]
}

export function tempoFor(pose: null | string, rng: Rng = Math.random): number {
  const [lo, hi] = TEMPO_RANGES[pose ?? 'idle'] ?? [1, 1]

  return lo + rng() * (hi - lo)
}

/** The person has been idle long enough to nap. */
export const SLEEP_AFTER_MS = 3 * 60_000

export function shouldSleep(idleMs: number, afterMs = SLEEP_AFTER_MS): boolean {
  return idleMs >= afterMs
}

const STATE_ALIASES: Record<PetState, readonly string[]> = {
  idle: ['idle'],
  wave: ['wave', 'waving'],
  jump: ['jump', 'jumping'],
  run: ['run', 'running'],
  failed: ['failed'],
  review: ['review'],
  waiting: ['waiting'],
  lounging: ['lounging'],
  sleep: ['sleep'],
  carried: ['carried']
}

const STATE_FALLBACKS: Partial<Record<PetState, PetState>> = {
  sleep: 'lounging',
  lounging: 'waiting',
  carried: 'idle'
}

/** Same row aliases/fallback chain as the canvas, without importing React. */
export function resolvePose(pose: PetState, stateRows: readonly string[]): PetState {
  if (STATE_ALIASES[pose].some(row => stateRows.includes(row))) {return pose}

  const fallback = STATE_FALLBACKS[pose]

  return fallback ? resolvePose(fallback, stateRows) : 'idle'
}
