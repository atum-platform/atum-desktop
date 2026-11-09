/**
 * The launch eclipse's motion: launch facts in, a picture's parameters out. Pure and
 * deterministic for a given sequence of steps, so it is tested without a GPU.
 *
 * Two directions share one engine (prototype: the "Atum Launch Motion" artifact):
 * - `totality` (shipped): the wait is a total eclipse with a living corona. Each passed check
 *   breaks through as a bead of sunlight on the moon's edge (Baily's beads); the one running
 *   shimmers. When all have passed they run together into the diamond ring, and the moon slides
 *   off into the mark's crescent.
 * - `approach`: the moon glides across the sun as the checks pass and the time goes by, and
 *   the last check brings it home.
 *
 * Every move is a damped spring toward a target, so retargeting keeps velocity and nothing
 * starts or stops on a typed curve. The last frame is the brand mark itself.
 */

export type EclipseDirection = 'totality' | 'approach'
export type EclipsePhase = 'checking' | 'blocked' | 'lit' | 'leaving'

/** public/atum-mark.svg (64 units), in sun radii with y up. */
export const MARK = {
  moon: [-2.5 / 28.5, -2.5 / 28.5] as const,
  moonR: 25.5 / 28.5,
  bead: [17.5 / 28.5, 17.5 / 28.5] as const,
  beadR: 4.8 / 28.5,
  /** The round face the mark sits in (the mark's 64-unit tile). */
  face: 32 / 28.5
}

/** Where the five checks' beads break through, around the diamond ring's 45°. */
const BAILY_ANGLES = [16, 30.5, 45, 59.5, 74].map(deg => (deg * Math.PI) / 180)
const TOTAL_MOON_R = 1.032
const LIMB_BEAD = Math.cos(Math.PI / 4) * TOTAL_MOON_R
const APPROACH_START = -1.52

/**
 * The finale's timing, which the launch screen follows: the beats, then the flight. A warm
 * launch (ready before the eclipse has finished forming) gets the short form, so a daily
 * launch never makes anyone wait for the animation.
 */
export const ECLIPSE_TIMING = {
  /** The eclipse is on screen at least this long, so totality forms before the finale. */
  holdMs: 900,
  /** Ready sooner than this after the reveal: the short form. */
  briefBeforeMs: 1_200,
  finaleMs: { full: { totality: 2_150, approach: 1_350 }, brief: { totality: 1_300, approach: 800 } },
  flightMs: { full: 1_450, brief: 1_100 }
} as const

export function eclipseFinaleMs(direction: EclipseDirection, brief: boolean) {
  return ECLIPSE_TIMING.finaleMs[brief ? 'brief' : 'full'][direction]
}

export function eclipseFlightMs(brief: boolean) {
  return ECLIPSE_TIMING.flightMs[brief ? 'brief' : 'full']
}

interface Spring {
  x: number
  v: number
  t: number
  k: number
  c: number
}

function spring(x: number, stiffness: number, ratio: number): Spring {
  return { x, v: 0, t: x, k: stiffness, c: 2 * ratio * Math.sqrt(stiffness) }
}

function tune(s: Spring, stiffness: number, ratio: number) {
  s.k = stiffness
  s.c = 2 * ratio * Math.sqrt(stiffness)
}

function stepSpring(s: Spring, dt: number) {
  s.v += (s.k * (s.t - s.x) - s.c * s.v) * dt
  s.x += s.v * dt
}

function hash1(n: number) {
  const s = Math.sin(n * 127.1) * 43_758.5453

  return s - Math.floor(s)
}

function noise1(x: number) {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)

  return hash1(i) * (1 - u) + hash1(i + 1) * u
}

/** Smooth, never visibly looping shimmer in [0, 1]. */
function shimmer(t: number, seed: number) {
  return 0.6 * noise1(t * 2.3 + seed * 17.1) + 0.4 * noise1(t * 7.9 + seed * 3.7)
}

export interface EclipsePoint {
  x: number
  y: number
  /** The sun's radius in CSS pixels. */
  r: number
}

export interface EclipseInputs {
  phase: EclipsePhase
  /** Checks passed so far (0–5). */
  settled: number
  /** The running (or blocked) check. */
  current: number
  /** Whether the finale takes its short form (the launch screen decides, so both agree). */
  brief: boolean
  reduced: boolean
  /** The eclipse at rest, centred in the launch column. */
  home: EclipsePoint
  /** The mark in the chat header, while leaving; without one the eclipse fades where it is. */
  dest?: EclipsePoint
}

export interface EclipseState {
  direction: EclipseDirection
  t: number
  litAt: number | null
  leftAt: number | null
  flashAt: number | null
  placed: boolean
  /** Set as the flight ends: the eclipse dissolves into the header's own face glyph. */
  landing: boolean
  moonX: Spring
  moonY: Spring
  moonR: Spring
  sun: Spring
  corona: Spring
  cool: Spring
  bead: Spring
  beadX: Spring
  beadY: Spring
  beadDisc: Spring
  face: Spring
  fade: Spring
  cx: Spring
  cy: Spring
  r: Spring
  baily: { s: Spring; a: Spring }[]
}

export function createEclipse(direction: EclipseDirection, reduced = false): EclipseState {
  const total = direction === 'totality'
  const start = (value: number) => (reduced ? value : total ? 0 : APPROACH_START)

  return {
    direction,
    t: 0,
    litAt: null,
    leftAt: null,
    flashAt: null,
    placed: false,
    landing: false,
    moonX: spring(start(MARK.moon[0]), total ? 34 : 26, 1),
    moonY: spring(start(MARK.moon[1]), total ? 34 : 26, 1),
    moonR: spring(reduced ? MARK.moonR : total ? TOTAL_MOON_R : MARK.moonR, 34, 1),
    sun: spring(0, 9, 1),
    corona: spring(0, total ? 2.2 : 3, 1),
    cool: spring(0, 3, 1),
    bead: spring(0, 70, 0.62),
    beadX: spring(total ? LIMB_BEAD : MARK.bead[0], 46, 0.86),
    beadY: spring(total ? LIMB_BEAD : MARK.bead[1], 46, 0.86),
    beadDisc: spring(0, 22, 1),
    face: spring(0, 60, 1),
    fade: spring(1, 9, 1),
    cx: spring(0, 46, 0.8),
    cy: spring(0, 46, 0.8),
    r: spring(1, 46, 0.8),
    baily: BAILY_ANGLES.map(angle => ({ s: spring(0, 46, 0.66), a: spring(angle, 42, 0.84) }))
  }
}

function smooth01(x: number) {
  return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x)
}

/** Advance the picture by `dt` seconds toward what the launch says now. */
export function advanceEclipse(state: EclipseState, dt: number, input: EclipseInputs) {
  state.t += dt
  const t = state.t
  const total = state.direction === 'totality'
  const leaving = input.phase === 'leaving'
  const blocked = input.phase === 'blocked'

  // The finale only follows a launch whose checks all passed (`lit`). A window released
  // without them leaves straight away and never shows the diamond ring.
  if (input.phase === 'lit' && state.litAt === null) {
    state.litAt = t
    state.flashAt = t + (input.brief ? (total ? 0.24 : 0.03) : total ? 0.38 : 0.05)
  }

  if (input.phase === 'checking' || input.phase === 'blocked') {
    state.litAt = null
    state.flashAt = null
  }

  const lit = state.litAt !== null && (input.phase === 'lit' || leaving)
  // Only the finished mark lands in the header; anything else fades where it is.
  const dest = lit ? input.dest : undefined

  if (leaving && state.leftAt === null) {
    state.leftAt = t
  }

  const flashAt = state.flashAt ?? Infinity
  const done = Math.min(5, input.settled)

  state.sun.t = t > 0.12 ? 1 : 0
  tune(state.corona, input.brief ? 9 : total ? 2.2 : 3, 1)
  state.corona.t =
    t < 0.15 ? 0 : leaving ? 0 : lit ? (total ? 0.42 : 0.5) : blocked ? (total ? 0.55 : 0.45) : total ? 1 : approachCorona(done, t)
  state.cool.t = blocked ? 1 : 0

  if (input.reduced) {
    // Nothing travels: the mark is simply there and light changes by fading alone.
    for (const [s, v] of [
      [state.moonX, MARK.moon[0]],
      [state.moonY, MARK.moon[1]],
      [state.moonR, MARK.moonR]
    ] as const) {
      s.x = v
      s.t = v
      s.v = 0
    }

    state.bead.t = 0
    state.beadDisc.t = 1
    state.corona.t = leaving ? 0 : 0.32
    state.baily.forEach(b => (b.s.t = 0))
  } else if (!total) {
    const p = Math.max(Math.pow(done / 5, 0.8), 0.88 * (1 - Math.exp(-Math.max(0, t - 0.6) / 7)))
    const toward = (end: number) => APPROACH_START + (end + 0.1 - APPROACH_START) * p
    state.moonX.t = lit ? MARK.moon[0] : blocked ? state.moonX.x : toward(MARK.moon[0])
    state.moonY.t = lit ? MARK.moon[1] : blocked ? state.moonY.x : toward(MARK.moon[1])
    state.bead.t = lit && t >= flashAt ? 1 : 0
    state.beadDisc.t = lit && t >= flashAt + 0.55 ? 1 : 0
  } else {
    state.baily.forEach((b, i) => {
      const passed = i < done
      const waiting = i === input.current && !lit

      b.s.t = lit ? 0 : passed ? 0.55 : waiting ? (blocked ? 0.05 : 0.08 + 0.22 * shimmer(t, i)) : 0
      b.a.t = lit ? Math.PI / 4 : BAILY_ANGLES[i]
    })

    // The beads run together, the ring flashes while still total, then the moon slides off
    // and the ring becomes the mark's bead on its crescent.
    if (lit && t >= flashAt + (input.brief ? 0.32 : 0.55)) {
      state.moonX.t = MARK.moon[0]
      state.moonY.t = MARK.moon[1]
      state.moonR.t = MARK.moonR
      state.beadX.t = MARK.bead[0]
      state.beadY.t = MARK.bead[1]
    }

    state.bead.t = lit && t >= flashAt - 0.06 ? 1 : 0
    state.beadDisc.t = lit && t >= flashAt + (input.brief ? 0.6 : 0.95) ? 1 : 0
  }

  // Where it is drawn: at home, then (a beat after the night begins to lift) into the header.
  const flying = leaving && !input.reduced && dest && t >= (state.leftAt ?? t) + 0.16
  const at = flying && dest ? dest : input.home

  // The flight settles exactly on the face before the dissolve begins (a hair of overshoot
  // keeps it physical); at home the springs are softer.
  for (const s of [state.cx, state.cy, state.r]) {
    tune(s, leaving ? (input.brief ? 210 : 120) : 46, 0.82)
  }

  state.cx.t = at.x
  state.cy.t = at.y
  state.r.t = at.r

  if (!state.placed) {
    state.placed = true

    for (const [s, v] of [
      [state.cx, at.x],
      [state.cy, at.y],
      [state.r, at.r]
    ] as const) {
      s.x = v
    }
  }

  state.face.t = leaving && dest && !input.reduced ? 1 : 0
  // The last 300 ms of the flight: the eclipse, now the size of the header's face, dissolves
  // into that face's own glyph (a match dissolve). Without a face to land on, or with reduced
  // motion, it fades where it is.
  state.landing = Boolean(leaving && dest && t >= (state.leftAt ?? t) + eclipseFlightMs(input.brief) / 1000 - 0.3)
  state.fade.t = leaving && (!dest || input.reduced || state.landing) ? 0 : 1
  tune(state.fade, state.landing ? 60 : 9, 1)

  for (const s of [
    state.moonX,
    state.moonY,
    state.moonR,
    state.sun,
    state.corona,
    state.cool,
    state.bead,
    state.beadX,
    state.beadY,
    state.beadDisc,
    state.face,
    state.fade,
    state.cx,
    state.cy,
    state.r
  ]) {
    stepSpring(s, dt)
  }

  for (const b of state.baily) {
    stepSpring(b.s, dt)
    stepSpring(b.a, dt)
  }
}

function approachCorona(done: number, t: number) {
  const p = Math.max(done / 5, 0.88 * (1 - Math.exp(-Math.max(0, t - 0.6) / 7)))

  return 0.18 + 0.82 * smooth01((p - 0.25) / 0.7)
}

function flash(state: EclipseState, reduced: boolean) {
  if (state.flashAt === null || reduced || state.t < state.flashAt) {
    return 0
  }

  const k = state.t - state.flashAt

  return k < 0.07 ? k / 0.07 : Math.exp(-(k - 0.07) / 0.42)
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/** What the renderer draws this frame (positions in CSS pixels, y down). */
export interface EclipseFrame {
  center: { x: number; y: number }
  r: number
  time: number
  moon: [number, number]
  moonR: number
  sun: number
  corona: number
  cool: number
  bead: [number, number]
  beadGlow: number
  beadDisc: number
  flash: number
  face: number
  opacity: number
  /** Five beads: x, y (sun radii) and strength. */
  baily: [number, number, number][]
}

export function eclipseFrame(state: EclipseState, input: Pick<EclipseInputs, 'phase' | 'reduced'>): EclipseFrame {
  const total = state.direction === 'totality'
  const night = 1 - clamp01(state.face.x)

  return {
    center: { x: state.cx.x, y: state.cy.x },
    r: state.r.x,
    // The corona drifts; nearly stills while blocked; not at all with reduced motion.
    time: input.reduced ? 7 : 7 + state.t * (input.phase === 'blocked' ? 0.25 : 1),
    moon: [state.moonX.x, state.moonY.x],
    moonR: state.moonR.x,
    sun: clamp01(state.sun.x),
    corona: Math.max(0, state.corona.x) * Math.pow(night, 1.4),
    cool: clamp01(state.cool.x),
    bead: [state.beadX.x, state.beadY.x],
    beadGlow: Math.max(0, state.bead.x) * (1 - smooth01((state.face.x - 0.2) / 0.6)),
    beadDisc: clamp01(state.beadDisc.x),
    flash: flash(state, input.reduced),
    face: clamp01(state.face.x),
    opacity: clamp01(state.fade.x),
    baily: state.baily.map(b => {
      const radius = total ? state.moonR.x - 0.004 : 1

      return [
        Math.cos(b.a.x) * radius + state.moonX.x * 0.6,
        Math.sin(b.a.x) * radius + state.moonY.x * 0.6,
        Math.max(0, b.s.x)
      ]
    })
  }
}
