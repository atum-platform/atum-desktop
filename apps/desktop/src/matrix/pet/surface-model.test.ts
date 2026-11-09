import { describe, expect, it } from 'vitest'

import { createEngineState, decide } from '../../../shared/pet-engine/decide'
import { ROAM_CONTROL_GAP_PX, type RoamRect } from '../../../shared/pet-engine/lane'
import { integrate } from '../../../shared/pet-engine/motion'
import { profileFor } from '../../../shared/pet-engine/profile'
import type { PetEngineState, PetWorld } from '../../../shared/pet-engine/types'

import { settlePet } from './rest'
import {
  type PetStageGeometry,
  petTopForSurface,
  type PetWalkSurfaceGeometry,
  petWorldFromGeometry
} from './surface-model'

const body = { width: 89, height: 96, footY: 90 }
const stage = (width: number, height = 760): PetStageGeometry => ({ left: 0, right: width, top: 0, bottom: height })

const surface = (id: string, left: number, right: number, top: number, bottom = 760): PetWalkSurfaceGeometry => ({
  id,
  rect: { left, right, top, bottom }
})

const layouts = [
  {
    name: 'composer only',
    stage: stage(900),
    // Floating glass: its foot stops 20 px above the window bottom, which no pet fits under.
    surfaces: [surface('composer:0', 145, 755, 620, 740)]
  },
  {
    name: 'composer and side-panel browser',
    stage: stage(1200),
    surfaces: [surface('composer:0', 160, 730, 620), surface('browser:0', 790, 1186, 92)]
  },
  {
    name: 'narrow split window',
    stage: stage(680),
    surfaces: [surface('composer:0', 24, 316, 620), surface('browser:0', 348, 666, 92)]
  },
  {
    name: 'grown composer',
    stage: stage(900),
    surfaces: [surface('composer:0', 145, 755, 500, 740)]
  },
  {
    name: 'composer with an open menu over its rim and a notice above it',
    stage: stage(1000),
    surfaces: [surface('composer:0', 120, 880, 620, 740)],
    // The menu paints over her layer; the notice is the dock's, beneath it.
    obstacles: [{ left: 130, right: 330, top: 380, bottom: 610 }],
    furniture: [{ left: 500, right: 860, top: 560, bottom: 612 }]
  },
  {
    name: 'composer with a menu open down to the floor',
    stage: stage(1000),
    surfaces: [surface('composer:0', 120, 880, 620, 740)],
    obstacles: [{ left: 300, right: 520, top: 400, bottom: 760 }]
  },
  {
    name: 'kit glass-capsule composer',
    stage: stage(1100),
    surfaces: [surface('composer:0', 96, 704, 606, 744), surface('browser:0', 744, 1086, 92)]
  }
] as const

function obstaclesOf(layout: (typeof layouts)[number]): readonly RoamRect[] {
  return 'obstacles' in layout ? layout.obstacles : []
}

function furnitureOf(layout: (typeof layouts)[number]): readonly RoamRect[] {
  return 'furniture' in layout ? layout.furniture : []
}

function worldFor(layout: (typeof layouts)[number]): PetWorld {
  return petWorldFromGeometry({
    body,
    stage: layout.stage,
    surfaces: layout.surfaces,
    obstacles: obstaclesOf(layout),
    furniture: furnitureOf(layout)
  })
}

/** Every place she can stand on a line: both ends of each span and points between. */
function standPoints(world: PetWorld, which: 'all' | 'perches' = 'all'): { x: number; y: number }[] {
  const lines = [...(which === 'all' ? world.free.map(span => ({ ...span, y: world.floorY })) : []), ...world.perches]

  return lines.flatMap(line =>
    [0, 0.25, 0.5, 0.75, 1].map(t => ({ x: line.left + (line.right - line.left) * t, y: line.y }))
  )
}

/** Her opaque body at a stand point (left edge `x`, foot line `y`), in stage pixels. */
function bodyAt(point: { x: number; y: number }): RoamRect {
  return { left: point.x, right: point.x + body.width, top: point.y - body.footY, bottom: point.y }
}

function overlaps(a: RoamRect, b: RoamRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function surfacePrefix(id: string): string {
  return id.slice(0, id.lastIndexOf(':'))
}

describe('pet surface invariants', () => {
  for (const layout of layouts) {
    it(`${layout.name}: every walk step keeps the opaque foot baseline on its named edge`, () => {
      const world = worldFor(layout)

      expect(new Set(world.perches.map(perch => surfacePrefix(perch.id)))).toEqual(
        new Set(layout.surfaces.map(surface => surface.id))
      )

      for (const perch of world.perches) {
        const profile = profileFor('walk')

        const initial = {
          ...createEngineState({ now: 0, x: perch.left, y: perch.y, profile }),
          perchId: perch.id
        }

        let state = decide(
          initial,
          world,
          { away: false, idleMs: 0, reducedMotion: false, work: 'idle' },
          [{ action: 'go', place: 'right' }],
          () => 0.5
        ).state

        expect(state.motion).toBeDefined()

        for (let elapsed = 0; elapsed < (state.motion?.durationMs ?? 0); elapsed += 16) {
          const next = integrate(state, state.intent, 16)
          state = { ...state, ...next, now: state.now + 16 }
          expect(state.y).toBe(perch.y)
          expect(petTopForSurface(state.y, body.footY) + body.footY).toBe(perch.y)
        }
      }
    })

    it(`${layout.name}: a drop on every surface stays on that surface`, () => {
      const world = worldFor(layout)

      for (const perch of world.perches) {
        const x = (perch.left + perch.right) / 2
        const landing = settlePet(world, body.width, { x, y: perch.y })

        expect(landing).toEqual({ perchId: perch.id, x, y: perch.y })
      }
    })

    it(`${layout.name}: nothing that paints over her layer covers any stand point`, () => {
      const world = worldFor(layout)
      const points = standPoints(world)

      expect(points.length).toBeGreaterThan(0)

      for (const point of points) {
        for (const box of obstaclesOf(layout)) {
          expect(overlaps(bodyAt(point), box), JSON.stringify({ point, box })).toBe(false)
        }
      }
    })

    it(`${layout.name}: the floor runs in front of every surface, cut only where something covers her`, () => {
      const world = worldFor(layout)
      const near = (box: RoamRect): RoamRect => ({ ...box, left: box.left - ROAM_CONTROL_GAP_PX, right: box.right + ROAM_CONTROL_GAP_PX })

      for (let x = 0; x <= world.width - body.width; x += 4) {
        // Her whole band on the floor line, as the model measures it.
        const band = { left: x, right: x + body.width, top: world.floorY - body.height, bottom: world.floorY }
        const standable = world.free.some(span => x >= span.left && x <= span.right)

        if (!obstaclesOf(layout).some(box => overlaps(band, near(box)))) {
          expect(standable, `x ${x} is open ground`).toBe(true)
        }

        if (obstaclesOf(layout).some(box => overlaps(band, box))) {
          expect(standable, `x ${x} is covered`).toBe(false)
        }
      }
    })

    it(`${layout.name}: on a rim she never sinks into another surface or the dock's furniture`, () => {
      const world = worldFor(layout)

      for (const point of standPoints(world, 'perches')) {
        const own = world.perches.find(perch => perch.y === point.y && point.x >= perch.left && point.x <= perch.right)!
        const others = layout.surfaces.filter(surface => !own.id.startsWith(`${surface.id}:`)).map(surface => surface.rect)

        for (const box of [...others, ...furnitureOf(layout)]) {
          expect(overlaps(bodyAt(point), box), JSON.stringify({ point, box })).toBe(false)
        }
      }
    })

  }

  it('walks the floor straight across in front of the floating composer', () => {
    const world = worldFor(layouts[0])
    const composer = world.perches.find(perch => perch.id.startsWith('composer:'))!
    const profile = { ...profileFor('walk'), gestureChance: 0, hopChance: 0, restChance: 0, routineChance: 0 }
    const signals = { away: false, idleMs: 0, reducedMotion: false, work: 'idle' } as const

    expect(world.free).toEqual([{ left: 0, right: world.width - body.width }])

    const state = createEngineState({ now: 0, x: 0, y: world.floorY, profile })
    const walk = decide(state, world, signals, [{ action: 'go', place: 'right' }], () => 0.5)
    const steps = walk.state.motion ? Math.ceil(walk.state.motion.durationMs / 16) : 0
    let moving = walk.state
    let inFront = 0

    for (let step = 0; step <= steps; step++) {
      const next = integrate(moving, moving.intent, 16)
      moving = { ...moving, ...next, now: moving.now + 16 }
      expect(moving.y).toBe(world.floorY)
      inFront += moving.x > composer.left && moving.x < composer.right ? 1 : 0
    }

    expect(moving.x).toBe(world.width - body.width)
    expect(inFront).toBeGreaterThan(0)
  })

  it('hops from the ground in front of the composer onto its rim and back down, landing only on named surfaces', () => {
    const world = worldFor(layouts[0])
    const composer = world.perches.find(perch => perch.id.startsWith('composer:'))!
    const profile = { ...profileFor('walk'), gestureChance: 0, hopChance: 1, restChance: 0, routineChance: 0 }
    const signals = { away: false, idleMs: 0, reducedMotion: false, work: 'idle' } as const
    let state: PetEngineState = createEngineState({ now: 0, x: 0, y: world.floorY, profile })

    const finishMotion = (moving: PetEngineState) => {
      const arrived = integrate(moving, moving.intent, moving.motion!.durationMs)

      return { ...moving, ...arrived, now: moving.now + moving.motion!.durationMs }
    }

    // The run-up ends on the ground in front of the card, then the hop carries her straight up onto it.
    const climbRunUp = decide(state, world, signals, [], () => 0.5).state
    expect(climbRunUp.hop?.id).toBe(composer.id)
    expect(climbRunUp.motion?.toX).toBeGreaterThanOrEqual(composer.left)
    expect(climbRunUp.motion?.toX).toBeLessThanOrEqual(composer.right)
    const climb = decide(finishMotion(climbRunUp), world, signals, [], () => 0.5).state
    expect(climb.motion).toMatchObject({ fromY: world.floorY, kind: 'leap', toY: composer.y })
    expect(climb.motion!.toX).toBeGreaterThanOrEqual(composer.left)
    expect(climb.motion!.toX).toBeLessThanOrEqual(composer.right)

    const arrivedOnRim = decide(finishMotion(climb), world, signals, [], () => 0.5).state
    const onRim = decide(arrivedOnRim, world, { ...signals, reducedMotion: true }, [], () => 0.5).state
    expect(onRim).toMatchObject({ perchId: composer.id, y: composer.y })
    expect(onRim.motion).toBeUndefined()

    state = { ...onRim, now: onRim.now + 1 }
    const descendRunUp = decide(state, world, signals, [], () => 0.5).state
    expect(descendRunUp.hop?.id).toMatch(/^floor:/)
    const descend = decide(finishMotion(descendRunUp), world, signals, [], () => 0.5).state
    expect(descend.motion).toMatchObject({ fromY: composer.y, kind: 'leap', toY: world.floorY })

    const arrivedOnFloor = decide(finishMotion(descend), world, signals, [], () => 0.5).state
    const onFloor = decide(arrivedOnFloor, world, { ...signals, reducedMotion: true }, [], () => 0.5).state
    expect(onFloor).toMatchObject({ y: world.floorY })
    expect(onFloor.perchId).toBeUndefined()
    expect(onFloor.motion).toBeUndefined()

    for (const rest of [onRim, onFloor]) {
      const surface = rest.perchId
        ? world.perches.find(perch => perch.id === rest.perchId)
        : world.free.find(span => rest.x >= span.left && rest.x <= span.right)

      expect(surface).toBeDefined()
    }

    // On the rim she stands on the glass, not in it.
    expect(overlaps(bodyAt(onRim), layouts[0].surfaces[0].rect)).toBe(false)
  })

  it('treats a leap as one move: a beat mid-air never strands her in the air', () => {
    const world = worldFor(layouts[0])
    const composer = world.perches.find(perch => perch.id.startsWith('composer:'))!
    const profile = { ...profileFor('walk'), gestureChance: 0, hopChance: 1, restChance: 0, routineChance: 0 }
    const signals = { away: false, idleMs: 0, reducedMotion: false, work: 'idle' } as const
    const start = createEngineState({ now: 0, x: 0, y: world.floorY, profile })
    const runUp = decide(start, world, signals, [], () => 0.5).state
    const arrived = integrate(runUp, runUp.intent, runUp.motion!.durationMs)
    const takeoff = { ...runUp, ...arrived, now: runUp.now + runUp.motion!.durationMs }
    const leaping = decide(takeoff, world, signals, [], () => 0.5).state

    expect(leaping.motion?.kind).toBe('leap')

    // Halfway: she is in the air, on no line.
    const mid = integrate(leaping, leaping.intent, leaping.motion!.durationMs / 2)
    const midAir = { ...leaping, ...mid, now: leaping.now + leaping.motion!.durationMs / 2 }

    expect(midAir.y).not.toBe(world.floorY)
    expect(midAir.y).not.toBe(composer.y)

    // A world re-read (a streamed message, a scroll) lets the leap fly on from where it is drawn.
    const reread = decide(midAir, world, signals, [], () => 0.5).state
    expect(reread.motion).toBe(leaping.motion)
    expect(reread.x).toBe(midAir.x)

    // Anything that ends the leap early lands her where it was going, on the rim.
    const working = decide(midAir, world, { ...signals, work: 'working' }, [], () => 0.5).state
    expect(working.motion).toBeUndefined()
    expect(working).toMatchObject({ perchId: composer.id, x: leaping.motion!.toX, y: composer.y })
  })

  it('keeps the browser top walkable and never snaps its drop to a composer side', () => {
    const world = worldFor(layouts[1])
    const browser = world.perches.find(perch => perch.id.startsWith('browser:'))!
    const composer = world.perches.find(perch => perch.id.startsWith('composer:'))!
    const x = (browser.left + browser.right) / 2
    const landing = settlePet(world, body.width, { x, y: browser.y })

    expect(surfacePrefix(landing.perchId!)).toBe('browser:0')
    expect(landing.x).toBe(x)
    expect(landing.x).toBeGreaterThan(composer.right)
  })

  it('reprojects a resting or walking pet onto the same surface when the composer grows', () => {
    const before = worldFor(layouts[0])
    const after = worldFor(layouts[3])
    const oldComposer = before.perches.find(perch => perch.id.startsWith('composer:'))!
    const newComposer = after.perches.find(perch => perch.id === oldComposer.id)!
    const profile = profileFor('walk')

    const standing = {
      ...createEngineState({ now: 100, x: 300, y: oldComposer.y, profile }),
      perchId: oldComposer.id
    }

    const moved = decide(
      standing,
      after,
      { away: false, idleMs: 0, reducedMotion: false, work: 'idle' },
      [],
      () => 0
    ).state

    expect(moved.perchId).toBe(oldComposer.id)
    expect(moved.y).toBe(newComposer.y)
    expect(petTopForSurface(moved.y, body.footY) + body.footY).toBe(newComposer.y)

    const walking = decide(
      standing,
      before,
      { away: false, idleMs: 0, reducedMotion: false, work: 'idle' },
      [{ action: 'go', place: 'right' }],
      () => 0.5
    ).state

    const reprojected = decide(
      { ...walking, now: walking.now + 16 },
      after,
      { away: false, idleMs: 0, reducedMotion: false, work: 'idle' },
      [],
      () => 0.5
    ).state

    expect(reprojected.perchId).toBe(oldComposer.id)
    expect(reprojected.y).toBe(newComposer.y)
    expect(reprojected.motion).toMatchObject({ fromY: newComposer.y, toY: newComposer.y })
  })
})
