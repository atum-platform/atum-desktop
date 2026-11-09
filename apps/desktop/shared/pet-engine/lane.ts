/**
 * The Matrix companion's stroll: pure geometry and rhythm, no DOM. The host
 * supplies safe spans for the window floor and any reachable ledges. Every
 * choice takes an injectable `rng` so the rhythm is testable. The rest rhythm
 * is the floating pet's (`roam-behavior.ts`).
 */

import { dwellMs, type Rng } from './behaviour'

export type { Rng }

/** A range of positions for the pet's LEFT edge, in lane pixels (inclusive). */
export interface RoamSpan {
  left: number
  right: number
}

/** A box on screen, in viewport pixels (a DOMRect fits). */
export interface RoamRect {
  left: number
  right: number
  top: number
  bottom: number
}

export type RoamStep = { kind: 'rest'; ms: number } | { kind: 'walk'; to: number }

/** A house dog (a 208 px frame) at the default size (1) strolls this tall. */
export const ROAM_DEFAULT_HEIGHT_PX = 96
/** The tallest the strolling pet is ever drawn: it shares the screen with the
 * conversation, so it stays a companion, not a wall. The slider's whole range for
 * the house dogs (0.1–3 × their own size) stays under it. */
export const ROAM_MAX_HEIGHT_PX = 180
const ROAM_REFERENCE_PX = 208
// Height grows with the chosen size by this power, so every doubling of the size
// adds the same proportion (about a third) and the whole slider stays meaningful
// instead of flattening against a cap.
const ROAM_SIZE_EXPONENT = 0.4
/** Daylight kept between the pet and any control it might otherwise touch. */
export const ROAM_CONTROL_GAP_PX = 8
// Advance this many body widths per sprite loop, so the walk reads as steps.
const STRIDE_PER_LOOP = 0.8
// Most beats keep loafing; a pet that re-walks every beat reads as nervous.
const REST_CHANCE = 0.55
const REST_DWELL = { minMs: 2_500, meanMs: 5_000, maxMs: 14_000 }
// A stroll worth taking covers ground.
const MIN_STROLL_PX = 48

/**
 * The controls the pet could cover: every box that meets the current surface's
 * band, expressed as a [left, right] extent in stage pixels. Empty boxes
 * (hidden or collapsed controls) take no room.
 */
export function roamControlSpans(
  lane: Pick<RoamRect, 'left' | 'bottom'>,
  petH: number,
  boxes: readonly RoamRect[]
): RoamSpan[] {
  const top = lane.bottom - petH

  return boxes
    .filter(box => box.right > box.left && box.bottom > box.top && box.bottom > top && box.top < lane.bottom)
    .map(box => ({ left: box.left - lane.left, right: box.right - lane.left }))
}

/**
 * Whole-pixel size the pet is drawn at: a gentle power of its natural height (frame ×
 * the person's size × the pet's own size), so the drawn height always grows with the
 * chosen size, about 0.1 → 39 px, 1 → 96 px, 3 → 150 px for a house dog, and never
 * passes `ROAM_MAX_HEIGHT_PX`.
 */
export function roamSize(
  frame: { w: number; h: number },
  drawScale: number
): { width: number; height: number; zoom: number } {
  const natural = frame.h * drawScale

  if (!(natural > 0)) {
    return { width: 0, height: 0, zoom: 1 }
  }

  const height = Math.min(
    ROAM_MAX_HEIGHT_PX,
    ROAM_DEFAULT_HEIGHT_PX * (natural / ROAM_REFERENCE_PX) ** ROAM_SIZE_EXPONENT
  )

  const zoom = height / natural

  return {
    width: Math.round(frame.w * drawScale * zoom),
    height: Math.round(frame.h * drawScale * zoom),
    zoom
  }
}

/**
 * Where the pet's left edge may stand in a lane `width` wide without the pet
 * (`petW` wide) overlapping any `controls` — each given as its own [left, right]
 * extent in lane pixels — with `gap` px of daylight around them.
 */
export function roamFreeSpans(
  width: number,
  petW: number,
  controls: readonly RoamSpan[],
  gap = ROAM_CONTROL_GAP_PX
): RoamSpan[] {
  const max = width - petW

  if (!(max >= 0)) {
    return []
  }

  // A control at [l, r] forbids left edges in (l - gap - petW, r + gap).
  const blocked = controls
    .map(control => ({ left: control.left - gap - petW, right: control.right + gap }))
    .filter(span => span.right > 0 && span.left < max)
    .sort((a, b) => a.left - b.left)

  const free: RoamSpan[] = []
  let cursor = 0

  for (const span of blocked) {
    if (span.left > cursor) {
      free.push({ left: cursor, right: Math.min(span.left, max) })
    }

    cursor = Math.max(cursor, span.right)

    if (cursor > max) {
      break
    }
  }

  if (cursor <= max) {
    free.push({ left: cursor, right: max })
  }

  return free.filter(span => span.right >= span.left)
}

/** The free position nearest `x`, or undefined when the lane has no room. */
export function roamNearestFree(x: number, spans: readonly RoamSpan[]): number | undefined {
  let best: number | undefined

  for (const span of spans) {
    const candidate = Math.min(Math.max(x, span.left), span.right)

    if (best === undefined || Math.abs(candidate - x) < Math.abs(best - x)) {
      best = candidate
    }
  }

  return best
}

/** True when `x` is a free position (the pet covers no control there). */
export function roamIsFree(x: number, spans: readonly RoamSpan[]): boolean {
  return spans.some(span => x >= span.left && x <= span.right)
}

/** Exponential rest, clamped: mostly short loafs, the occasional long one. */
export function roamRestMs(rng: Rng = Math.random): number {
  return dwellMs(REST_DWELL, rng)
}

/**
 * What the pet does when a rest ends: keep resting, or stroll to a point in the
 * span it stands in. It never walks across a control: a stroll stays inside the
 * current free span, and a pet standing on a control first walks off it.
 */
export function roamNextStep(x: number, spans: readonly RoamSpan[], rng: Rng = Math.random): RoamStep {
  const nearest = roamNearestFree(x, spans)

  if (nearest === undefined) {
    return { kind: 'rest', ms: roamRestMs(rng) }
  }

  if (Math.abs(nearest - x) > 0.5) {
    return { kind: 'walk', to: nearest }
  }

  // `x` is within half a pixel of a free position; the span is the one holding it.
  const here = nearest
  const span = spans.find(each => here >= each.left && here <= each.right)!

  if (rng() < REST_CHANCE || span.right - span.left < MIN_STROLL_PX) {
    return { kind: 'rest', ms: roamRestMs(rng) }
  }

  // Head for the roomier side most of the time, so the pet crosses the strip.
  const roomLeft = here - span.left
  const roomRight = span.right - here
  const goRight = roomRight >= MIN_STROLL_PX && (roomLeft < MIN_STROLL_PX || rng() < roomRight / (roomLeft + roomRight))
  const room = goRight ? roomRight : roomLeft
  const distance = Math.max(MIN_STROLL_PX, room * (0.4 + 0.6 * rng()))

  return { kind: 'walk', to: goRight ? Math.min(span.right, here + distance) : Math.max(span.left, here - distance) }
}

/** Walking speed in px/s, paced to the sprite's leg cadence. */
export function roamSpeed(petW: number, loopMs: number): number {
  return (petW * STRIDE_PER_LOOP) / (Math.max(200, loopMs) / 1000)
}
