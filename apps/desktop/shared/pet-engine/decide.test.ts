import { describe, expect, it } from 'vitest'

import { SLEEP_AFTER_MS } from './behaviour'
import { createEngineState, decide, PET_RUN_UP_MIN_PX } from './decide'
import { FLOOR, HOP, IDLE, LOAF, PERCHED, seeded, SPLIT, STROLL } from './fixtures/worlds'
import { roamIsFree } from './lane'
import { integrate } from './motion'
import { profileFor } from './profile'
import type { PetCommand, PetEngineState, PetSignals, PetWorld } from './types'

const rest = () => createEngineState({ now: 1000, x: 100, y: FLOOR.floorY, profile: LOAF })

const beat = (state: PetEngineState, world = FLOOR, signals = IDLE, commands: readonly PetCommand[] = []) =>
  decide(state, world, signals, commands, () => 0.5)

function advance(state: PetEngineState): PetEngineState {
  const dt = Math.max(0, (state.wakeAt ?? state.now) - state.now)
  const next = integrate(state, state.intent, dt)

  return { ...state, now: state.now + dt, x: next.x, y: next.y, facing: next.facing }
}

const LEDGE_WORLD = {
  width: 600,
  floorY: 500,
  free: [{ left: 0, right: 500 }],
  perches: [{ id: 'composer:0', left: 100, right: 300, y: 350 }]
}

/** The leap's frames, sampled across its whole duration. */
function leapFrames(decision: ReturnType<typeof beat>) {
  const motion = decision.state.motion!

  return Array.from({ length: 21 }, (_, step) => integrate(decision.state, decision.intent, (motion.durationMs * step) / 20))
}

it('climbs down from a real perch with a run-up, then a short arc, leaving no synthetic stand', () => {
  const perched = { ...rest(), profile: HOP, x: 180, y: 350, perchId: 'composer:0' }
  const runUp = beat(perched, LEDGE_WORLD)

  // First the steps: a walk along the perch to a takeoff point over clear floor.
  expect(runUp.intent.pose).toBe('run')
  expect(runUp.state.motion).toMatchObject({ fromY: 350, toY: 350 })
  expect(runUp.state.motion!.toX).toBeGreaterThanOrEqual(100)
  expect(runUp.state.motion!.toX).toBeLessThanOrEqual(300)
  expect(Math.abs(runUp.state.motion!.toX - perched.x)).toBeGreaterThanOrEqual(PET_RUN_UP_MIN_PX)

  // Then the spring off the edge: a jump, not a walk-speed descent.
  const leap = beat(advance(runUp.state), LEDGE_WORLD)
  expect(leap.intent.pose).toBe('jump')
  expect(leap.intent.hopToPerch).toBeUndefined()
  expect(leap.state.motion).toMatchObject({ fromY: 350, toY: 500 })
  expect(leap.state.motion!.durationMs).toBeLessThan((150 / HOP.speedPxPerSecond) * 1000)
  // She springs up a little before dropping, and never leaves the clear overlap.
  expect(Math.min(...leapFrames(leap).map(frame => frame.y))).toBeLessThan(350)
  expect(leapFrames(leap).every(frame => frame.x >= 100 && frame.x <= 300)).toBe(true)

  const arrived = beat(advance(leap.state), LEDGE_WORLD)
  expect(arrived.state.perchId).toBeUndefined()
  expect(arrived.state.y).toBe(500)
})

it('abandons a run-up when the floor it leads to becomes blocked', () => {
  const runUp = beat({ ...rest(), profile: HOP, x: 180, y: 350, perchId: 'composer:0' }, LEDGE_WORLD)
  const blocked = beat({ ...runUp.state, now: runUp.state.now + 100 }, { ...LEDGE_WORLD, free: [{ left: 400, right: 500 }] })
  expect(blocked.state.motion).toBeUndefined()
  expect(blocked.state.hop).toBeUndefined()
  expect(blocked.state.y).toBe(350)
  expect(blocked.state.perchId).toBe('composer:0')
})

it('leaps up in the same short time whatever the height, topping out above the ledge and landing on it', () => {
  const durations = new Set<number>()

  for (const y of [250, 150, 60]) {
    const world = { ...FLOOR, perches: [{ id: 'composer', left: 0, right: 500, y }] }
    const runUp = beat({ ...rest(), profile: HOP }, world)
    expect(runUp.state.hop).toEqual({ id: 'composer', y })
    const leap = beat(advance(runUp.state), world)
    const motion = leap.state.motion!
    durations.add(motion.durationMs)

    expect(leap.intent).toMatchObject({ pose: 'jump', hopToPerch: 'composer' })
    // Far quicker than climbing at walking pace, which read as a slow lift in place.
    expect(motion.durationMs).toBeLessThan(((FLOOR.floorY - y) / HOP.speedPxPerSecond) * 1000)
    expect(Math.min(...leapFrames(leap).map(frame => frame.y))).toBeLessThan(y)
    expect(integrate(leap.state, leap.intent, motion.durationMs)).toMatchObject({ y, arrived: true })
    expect(beat(advance(leap.state), world).state).toMatchObject({ perchId: 'composer', y })
  }

  expect(durations.size).toBe(1)
})

it('drops a planned leap when work or a command interrupts the run-up', () => {
  const world = { ...PERCHED, free: [{ left: 0, right: 500 }] }
  const runUp = beat({ ...rest(), profile: HOP }, world)
  expect(runUp.state.hop).toBeDefined()

  const working = beat(runUp.state, world, { ...IDLE, work: 'working' })
  expect(working.state.hop).toBeUndefined()
  expect(working.state.motion).toBeUndefined()

  const commanded = beat(runUp.state, world, IDLE, [{ action: 'wave' }])
  expect(commanded.intent.pose).toBe('wave')
  expect(commanded.state.hop).toBeUndefined()
  expect(commanded.state.motion).toBeUndefined()
})

it('moves continuously through a seeded run of walks and hops: no frame ever jumps', () => {
  const world: PetWorld = {
    width: 600,
    floorY: 300,
    free: [{ left: 0, right: 500 }],
    perches: [{ id: 'composer:0:0', left: 60, right: 440, y: 200 }]
  }

  const rng = seeded(11)
  let state = createEngineState({ now: 1000, x: 250, y: world.floorY, profile: { ...profileFor(), hopChance: 0.6 } })
  let last = { x: state.x, y: state.y }
  const surfaces = new Set<string>()

  for (let index = 0; index < 400; index += 1) {
    const next = decide(state, world, IDLE, [], rng)

    // A decision never moves her by itself; only frames of a motion do.
    expect(next.state.x).toBeCloseTo(last.x, 6)
    expect(next.state.y).toBeCloseTo(last.y, 6)

    if (next.state.motion) {
      for (let at = 0; at <= next.state.motion.durationMs + 16; at += 16) {
        const frame = integrate(next.state, next.intent, at)
        expect(Math.abs(frame.x - last.x)).toBeLessThanOrEqual(4)
        expect(Math.abs(frame.y - last.y)).toBeLessThanOrEqual(24)
        last = { x: frame.x, y: frame.y }
      }
    }

    surfaces.add(next.state.perchId ?? 'floor')
    state = advance(next.state)
    last = { x: state.x, y: state.y }
  }

  // The run really used the ledge and came back down.
  expect([...surfaces].sort()).toEqual(['composer:0:0', 'floor'])
})

describe('a floor that moves under her', () => {
  const FLOOR_HIGHER: PetWorld = { ...FLOOR, floorY: 240 }

  function walking() {
    const walk = beat({ ...rest(), profile: STROLL }, FLOOR)
    expect(walk.state.motion).toMatchObject({ fromY: FLOOR.floorY, toY: FLOOR.floorY })

    return walk.state
  }

  it('carries a walk in flight along the new floor instead of finishing on the old one', () => {
    const walk = walking()
    const midway = { ...walk, now: walk.now + walk.motion!.durationMs / 3 }
    const moved = beat(midway, FLOOR_HIGHER)

    expect(moved.state.y).toBe(FLOOR_HIGHER.floorY)
    expect(moved.state.motion).toMatchObject({ fromY: 240, toY: 240, toX: walk.motion!.toX })
    // Every frame from here to arrival is on the new line, and she arrives on it.
    for (const fraction of [0, 0.25, 0.5, 0.99, 1]) {
      expect(integrate(moved.state, moved.intent, moved.state.motion!.durationMs * fraction).y).toBe(240)
    }

    const arrived = beat(advance(moved.state), FLOOR_HIGHER)
    expect(arrived.state.y).toBe(240)
    expect(arrived.state.motion?.fromY ?? 240).toBe(240)
  })

  it('does the same when the floor drops back, and leaves a walk that is already on the floor alone', () => {
    const walk = walking()
    expect(beat({ ...walk, now: walk.now + 50 }, FLOOR).state.motion).toEqual(walk.motion)
    expect(beat({ ...walk, now: walk.now + 50 }, { ...FLOOR, floorY: 340 }).state.motion).toMatchObject({
      fromY: 340,
      toY: 340
    })
  })

  it('does not rewrite a leap, or a walk along a perch', () => {
    const runUp = beat({ ...rest(), profile: HOP }, PERCHED)
    const leap = beat(advance(runUp.state), PERCHED)
    expect(leap.state.motion).toMatchObject({ kind: 'leap' })
    const afterMove = beat({ ...leap.state, now: leap.state.now + 10 }, { ...PERCHED, floorY: 260 })
    // Whatever the engine decides about a leap whose floor moved, it never flattens it onto the new floor.
    expect(afterMove.state.motion).not.toMatchObject({ fromY: 260, toY: 260 })

    const perched = { ...rest(), profile: HOP, x: 180, y: 350, perchId: 'composer:0' }
    const onPerch = beat(perched, LEDGE_WORLD)
    expect(onPerch.state.motion).toMatchObject({ fromY: 350, toY: 350 })
    expect(beat({ ...onPerch.state, now: onPerch.state.now + 10 }, { ...LEDGE_WORLD, floorY: 460 }).state.motion).toMatchObject({
      fromY: 350,
      toY: 350
    })
  })
})

describe('engine scheduling and activity', () => {
  it('holds a beat until its absolute deadline without using randomness or moving', () => {
    const first = beat(rest())
    expect(first.wakeAt).toBeGreaterThan(first.state.now)
    expect(first.state.motion).toBeUndefined()

    const next = decide({ ...first.state, now: first.state.now + 100 }, FLOOR, IDLE, [], () => {
      throw new Error('early draw')
    })

    expect(next.intent).toBe(first.intent)
    expect(next.wakeAt).toBe(first.wakeAt)
    expect(next.state.x).toBe(first.state.x)
    expect(beat(advance(first.state)).wakeAt).toBeGreaterThan(first.wakeAt!)
  })

  it.each(['working', 'waiting', 'failed'] as const)('stands with the %s pose and no wake or motion', work => {
    const moving = beat({ ...rest(), profile: STROLL }).state
    const next = beat(moving, FLOOR, { ...IDLE, work })
    expect(next.intent.pose).toBe({ working: 'run', waiting: 'waiting', failed: 'failed' }[work])
    expect(next.intent.bubble).toBe({ working: undefined, waiting: 'yourTurn', failed: 'failed' }[work])
    expect(next.state.x).toBe(moving.x)
    expect(next.state.motion).toBeUndefined()
    expect(next.intent.targetX).toBeUndefined()
    expect(next.wakeAt).toBeNull()
  })

  it.each(['away', 'reducedMotion'] as const)('stops immediately under %s, including unsafe world changes', signal => {
    const moving = beat({ ...rest(), profile: STROLL }).state
    const commands: PetCommand[] = [{ action: 'go', place: 'right' }]
    const next = beat(moving, { ...FLOOR, free: [] }, { ...IDLE, [signal]: true }, commands)
    expect(next.state.x).toBe(moving.x)
    expect(next.state.y).toBe(moving.y)
    expect(next.state.motion).toBeUndefined()
    expect(next.state.visible).toBe(false)
    expect(next.wakeAt).toBeNull()
    // Input received while inactive is consumed; returning does not replay it.
    const resumed = beat({ ...next.state, profile: LOAF }, FLOOR, IDLE, commands)
    expect(resumed.intent.targetX).toBeUndefined()
  })

  it.each([
    [['idle', 'sleep'], 'sleep'],
    [['idle', 'lounging'], 'lounging'],
    [['idle', 'waiting'], 'waiting'],
    [['idle'], 'idle']
  ] as const)('sleeps immediately through the row fallback chain %j', (rows, expected) => {
    const moving = beat({ ...rest(), profile: STROLL, stateRows: rows }).state
    const next = beat(moving, FLOOR, { ...IDLE, idleMs: SLEEP_AFTER_MS })
    expect(next.intent.pose).toBe(expected)
    expect(next.wakeAt).toBeNull()
    expect(next.state.motion).toBeUndefined()
    expect(beat(next.state).wakeAt).toBeGreaterThan(next.state.now)
  })
})

describe('one-shot commands', () => {
  it.each([
    ['wave', 'wave'],
    ['jump', 'jump'],
    ['sit', 'waiting'],
    ['lounge', 'lounging'],
    ['sleep', 'lounging']
  ] as const)('%s preempts a walk once, then returns to loafing', (action, pose) => {
    const moving = beat({ ...rest(), profile: STROLL }).state
    const commands: PetCommand[] = [{ action }]
    const next = beat({ ...moving, profile: LOAF }, FLOOR, IDLE, commands)
    expect(next.intent.pose).toBe(pose)
    expect(next.state.motion).toBeUndefined()
    expect(next.wakeAt).toBeGreaterThanOrEqual(moving.wakeAt!)
    expect(beat(next.state, FLOOR, IDLE, commands).intent.pose).toBe(pose)
    const done = beat(advance(next.state), FLOOR, IDLE, commands)
    expect(done.intent.pose).toBe('idle')
    expect(done.state.pendingCommands).toHaveLength(0)
  })

  it('sleep uses the real sleep row when the sheet declares one', () => {
    const moving = beat({ ...rest(), profile: STROLL, stateRows: ['idle', 'sleep', 'lounging'] }).state
    const next = beat(moving, FLOOR, IDLE, [{ action: 'sleep' }])
    expect(next.intent.pose).toBe('sleep')
  })

  it('go walks to a reachable edge, avoiding a blocked gap and stopping without overshoot', () => {
    const commands: PetCommand[] = [{ action: 'go', place: 'right' }]
    const next = beat(rest(), SPLIT, IDLE, commands)
    expect(next.intent.pose).toBe('run')
    expect(next.intent.targetX).toBe(SPLIT.free[0]!.right)
    expect(integrate(next.state, { ...next.intent }, 1e6)).toMatchObject({
      x: SPLIT.free[0]!.right,
      y: FLOOR.floorY,
      arrived: true
    })
    expect(beat(advance(next.state), SPLIT, IDLE, commands).intent.targetX).toBeUndefined()
  })

  it('plays an ordered batch and allows the same action in a new batch', () => {
    const commands: PetCommand[] = [{ action: 'wave' }, { action: 'sit' }, { action: 'lounge' }]
    let state = rest()

    for (const pose of ['wave', 'waiting', 'lounging']) {
      const next = beat(state, FLOOR, IDLE, commands)
      expect(next.intent.pose).toBe(pose)
      state = advance(next.state)
    }

    expect(beat(state, FLOOR, IDLE, commands).intent.pose).toBe('idle')
    expect(beat(state, FLOOR, IDLE, [{ action: 'wave' }]).intent.pose).toBe('wave')
  })

  it('consumes commands under work, and skips RAF when already at a go destination', () => {
    const commands: PetCommand[] = [{ action: 'go', place: 'left' }]
    const busy = beat(rest(), FLOOR, { ...IDLE, work: 'working' }, commands)
    expect(beat(busy.state, FLOOR, IDLE, commands).intent.targetX).toBeUndefined()
    expect(beat({ ...rest(), x: 0 }, FLOOR, IDLE, [{ action: 'go', place: 'left' }]).state.motion).toBeUndefined()
  })
})

describe('safe geometry and portable locomotion', () => {
  it('re-homes a blocked position, hides if there is no room, and stops a changed path', () => {
    const blocked = beat({ ...rest(), x: 180 }, SPLIT)
    expect(roamIsFree(blocked.state.x, SPLIT.free)).toBe(true)
    const hidden = beat(rest(), { ...FLOOR, free: [] })
    expect(hidden.state.visible).toBe(false)
    expect(hidden.wakeAt).toBeNull()
    const moving = beat({ ...rest(), profile: STROLL }).state
    const stopped = beat(moving, SPLIT)
    expect(stopped.state.motion).toBeUndefined()
    expect(stopped.intent.targetX).toBeUndefined()
  })

  it('only hops to overlapping real perches and stops if the target disappears', () => {
    const world = { ...PERCHED, free: SPLIT.free }
    const runUp = beat({ ...rest(), profile: HOP }, world)
    // The run-up ends where the composer and her floor span meet, never toward the far rail.
    expect(runUp.state.hop?.id).toBe('composer')
    expect(runUp.state.motion!.toX).toBeGreaterThanOrEqual(PERCHED.perches[0]!.left)
    expect(runUp.state.motion!.toX).toBeLessThanOrEqual(SPLIT.free[0]!.right)
    const lost = beat({ ...runUp.state, now: runUp.state.now + 50 }, { ...world, perches: [] })
    expect(lost.state.motion).toBeUndefined()
    expect(lost.state.hop).toBeUndefined()
    const next = beat(advance(runUp.state), world)
    expect(next.intent.hopToPerch).toBe('composer')
    expect(next.state.motion!.toY).toBe(PERCHED.perches[0]!.y)
    expect(next.state.motion!.toX).toBeGreaterThanOrEqual(PERCHED.perches[0]!.left)
    const halfway = integrate(next.state, next.intent, next.state.motion!.durationMs / 2)
    expect(halfway.arrived).toBe(false)
    expect(halfway.y).toBeLessThan((FLOOR.floorY + PERCHED.perches[0]!.y) / 2)
    const landed = beat(advance(next.state), world)
    expect(landed.state.perchId).toBe('composer')
    expect(landed.state.y).toBe(PERCHED.perches[0]!.y)
    const removed = beat(next.state, FLOOR)
    expect(removed.state.motion).toBeUndefined()
    expect(removed.intent.hopToPerch).toBeUndefined()
    const rehomed = beat(landed.state, FLOOR)
    expect(rehomed.state.y).toBe(FLOOR.floorY)
    expect(rehomed.state.perchId).toBeUndefined()
  })

  it.each(['walk', 'hop', 'float', 'fly'] as const)('uses the %s profile for a real go motion', locomotion => {
    const state = { ...rest(), profile: profileFor(locomotion) }
    const next = beat(state, FLOOR, IDLE, [{ action: 'go', place: 'right' }])
    const motion = next.state.motion!
    expect(motion.durationMs).toBeCloseTo(((motion.toX - state.x) / state.profile.speedPxPerSecond) * 1000)
    expect(motion.arcHeight).toBe(locomotion === 'walk' ? 0 : state.profile.hopHeight)
    const frame = integrate(next.state, next.intent, motion.durationMs / 2)
    expect(frame.x).toBeGreaterThan(state.x)
    expect(frame.x).toBeLessThan(motion.toX)
    expect(frame.facing).toBe(1)
    expect(integrate(next.state, next.intent, motion.durationMs * 2)).toEqual({
      x: motion.toX,
      y: motion.toY,
      facing: 1,
      arrived: true
    })
  })

  it('keeps a seeded trace deterministic, bounded, and independent of host state mutation', () => {
    function trace(world: PetWorld, signals: PetSignals) {
      const rng = seeded(42)
      let state = createEngineState({ now: 1000, x: 80, y: FLOOR.floorY })
      const decisions = []

      for (let i = 0; i < 150; i++) {
        const before = structuredClone(state)
        const next = decide(state, world, signals, [], rng)
        expect(state).toEqual(before)
        expect(next.wakeAt).toBeGreaterThan(state.now)
        expect(roamIsFree(next.state.x, world.free)).toBe(true)

        if (next.state.motion) {
          for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
            const frame = integrate(next.state, next.intent, next.state.motion.durationMs * fraction)
            expect(roamIsFree(frame.x, world.free)).toBe(true)
          }
        }

        decisions.push(next.intent)
        state = advance(next.state)
      }

      return decisions
    }

    const first = trace(SPLIT, IDLE)
    expect(first).toEqual(trace(SPLIT, IDLE))
    expect(first.some(intent => intent.targetX !== undefined)).toBe(true)
    expect(first.some(intent => intent.targetX === undefined)).toBe(true)
  })
})

describe('routine playback before stage integration', () => {
  it('plays nearer end, farther end and back to its origin in order', () => {
    let state = {
      ...rest(),
      routine: {
        routine: {
          name: 'route',
          steps: [
            { kind: 'walk', to: 'end' },
            { kind: 'walk', to: 'far' },
            { kind: 'walk', to: 'back' }
          ]
        },
        step: 0,
        originX: 100
      }
    } as PetEngineState

    for (const expected of [FLOOR.free[0]!.left, FLOOR.free[0]!.right, 100]) {
      const next = beat(state)
      expect(next.state.motion!.toX).toBe(expected)
      state = advance(next.state)
    }

    expect(beat(state).state.routine).toBeUndefined()
  })

  it('skips a hop whose perch vanished and immediately plays the next step', () => {
    const state = {
      ...rest(),
      routine: {
        routine: { name: 'lost-perch', steps: [{ kind: 'hop' }, { kind: 'pose', pose: 'review', ms: 1400 }] },
        step: 0,
        originX: 100
      }
    } as PetEngineState

    const next = beat(state, FLOOR)
    expect(next.intent.pose).toBe('review')
    expect(next.state.routine?.step).toBe(2)
    expect(next.state.motion).toBeUndefined()
  })

  it('abandons the rest of a routine when a command preempts it', () => {
    const state = {
      ...rest(),
      routine: {
        routine: { name: 'quiet', steps: [{ kind: 'pose', pose: 'lounging', ms: 5000 }] },
        step: 0,
        originX: 100
      }
    } as PetEngineState

    const next = beat(state, FLOOR, IDLE, [{ action: 'wave' }])
    expect(next.intent.pose).toBe('wave')
    expect(next.state.routine).toBeUndefined()
    expect(beat(advance(next.state)).intent.pose).toBe('idle')
  })

  it('keeps each host personality independent, including nested dwell and routines', () => {
    const original = profileFor()
    const tuned = profileFor()
    tuned.speedPxPerSecond = 2
    tuned.dwell.minMs = 1
    ;(tuned.routines[0]!.steps as unknown[]).splice(0)
    expect(profileFor()).toEqual(original)
  })
})
