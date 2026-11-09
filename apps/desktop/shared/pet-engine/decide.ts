import {
  chooseGesture,
  chooseMove,
  chooseRoutine,
  dwellMs,
  pickStrollTarget,
  resolvePose,
  type Rng,
  shouldSleep
} from './behaviour'
import { roamIsFree, roamNearestFree, type RoamSpan } from './lane'
import { profileFor } from './profile'
import type {
  PetCommand,
  PetDecision,
  PetEngineState,
  PetHop,
  PetIntent,
  PetPerch,
  PetPose,
  PetSignals,
  PetWorld
} from './types'

/** A leap onto or off a ledge takes this long whatever the height: the legacy pet's spring
 * (`use-pet-roam.ts` JUMP_DUR_MS). A climb at walking pace read as a slow lift in place. */
export const PET_LEAP_MS = 460
/** The run-up before a leap covers at least this much ground when the ledge allows it, so the
 * jump reads as one: steps, then the spring. */
export const PET_RUN_UP_MIN_PX = 40
/** A leap carries her this far on in the direction she ran, so the arc travels. */
const LEAP_DRIFT_PX = 16

/** Where a hop takes off and lands, at the target's height. Over an overlap both are the overlap
 * (a straight-up hop); across a gap (`PetWorld.reach`) she takes off from the end of the surface she
 * stands on and lands just inside the near end of the target. `perchId` names a real perch (never
 * a floor). */
interface Ledge {
  takeoff: RoamSpan
  land: RoamSpan
  y: number
  perchId?: string
}

/** The horizontal gap between two spans; zero when they overlap or touch. */
function gapBetween(a: RoamSpan, b: RoamSpan): number {
  return Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right))
}

/** Whether a leap can join the surface she stands on to `target`. */
function joins(here: RoamSpan, target: RoamSpan, world: PetWorld): boolean {
  return gapBetween(here, target) <= Math.max(0, world.reach ?? 0)
}

/** The takeoff and landing between `here` and a reachable `target`. */
function ledgeBetween(here: RoamSpan, target: RoamSpan & { y: number; perchId?: string }): Ledge {
  const left = Math.max(target.left, here.left)
  const right = Math.min(target.right, here.right)
  const ends = { y: target.y, ...(target.perchId ? { perchId: target.perchId } : {}) }

  if (left <= right) {
    return { ...ends, takeoff: { left, right }, land: { left, right } }
  }

  return target.left > here.right
    ? {
        ...ends,
        takeoff: { left: here.right, right: here.right },
        land: { left: target.left, right: Math.min(target.right, target.left + LEAP_DRIFT_PX) }
      }
    : {
        ...ends,
        takeoff: { left: here.left, right: here.left },
        land: { left: Math.max(target.left, target.right - LEAP_DRIFT_PX), right: target.right }
      }
}

export function createEngineState({
  now,
  x = 0,
  y = 0,
  profile = profileFor(),
  stateRows = ['idle', 'waving', 'jumping', 'running', 'waiting', 'failed', 'review', 'lounging']
}: Pick<PetEngineState, 'now'> & Partial<Pick<PetEngineState, 'x' | 'y' | 'profile' | 'stateRows'>>): PetEngineState {
  return {
    now,
    x,
    y,
    profile,
    stateRows,
    facing: -1,
    visible: true,
    intent: { pose: 'idle', mirror: false },
    wakeAt: null,
    pendingCommands: []
  }
}

function finish(state: PetEngineState, intent: PetIntent, delayMs: number | null): PetDecision {
  const wakeAt = delayMs === null ? null : Math.max(state.wakeAt ?? state.now, state.now + Math.max(1, delayMs))
  const next = { ...state, intent, wakeAt }

  return { state: next, intent, wakeAt }
}

/** A standing pose. Standing ends any motion, and with it any run-up's planned leap. */
function pose(state: PetEngineState, value: PetPose, delay: number | null, bubble?: PetIntent['bubble']): PetDecision {
  return finish(
    { ...state, motion: undefined, hop: undefined },
    {
      pose: resolvePose(value, state.stateRows),
      mirror: state.facing > 0,
      ...(bubble ? { bubble } : {})
    },
    delay
  )
}

function spans(world: PetWorld): RoamSpan[] {
  return world.free
    .filter(span => Number.isFinite(span.left) && Number.isFinite(span.right))
    .map(span => ({ left: Math.max(0, span.left), right: Math.min(world.width, span.right) }))
    .filter(span => span.left <= span.right)
}

function perchFor(state: PetEngineState, world: PetWorld): PetPerch | undefined {
  return world.perches.find(
    perch =>
      perch.id === state.perchId &&
      validPerch(perch, world) &&
      roamIsFree(state.x, [perch]) &&
      (!!state.motion || state.y === perch.y)
  )
}

function validPerch(perch: PetPerch, world: PetWorld): boolean {
  return (
    Number.isFinite(perch.left) &&
    Number.isFinite(perch.right) &&
    Number.isFinite(perch.y) &&
    perch.left >= 0 &&
    perch.left <= perch.right &&
    perch.right <= world.width
  )
}

function reachablePerches(state: PetEngineState, world: PetWorld, here: RoamSpan): PetPerch[] {
  const perches = world.perches.filter(
    perch => perch.id !== state.perchId && validPerch(perch, world) && joins(here, perch, world)
  )

  // A real perch needs a way back down. Floor destinations remain inside the
  // same clear horizontal corridor; their synthetic IDs never become stands.
  if (state.perchId && state.y !== world.floorY) {
    perches.push(
      ...world.free
        .map((span, index) => ({ ...span, y: world.floorY, id: `floor:${index}` }))
        .filter(span => joins(here, span, world))
    )
  }

  return perches
}

/** A walk along the surface she stands on, at the profile's pace. */
function travel(state: PetEngineState, toX: number): PetDecision {
  if (toX === state.x) {
    return pose(state, 'idle', 1800)
  }

  const durationMs = Math.max(200, (Math.abs(toX - state.x) / state.profile.speedPxPerSecond) * 1000)

  return finish(
    {
      ...state,
      motion: {
        fromX: state.x,
        fromY: state.y,
        toX,
        toY: state.y,
        startedAt: state.now,
        durationMs,
        arcHeight: state.profile.locomotion === 'walk' ? 0 : state.profile.hopHeight
      }
    },
    { pose: resolvePose('run', state.stateRows), mirror: toX > state.x, targetX: toX },
    durationMs
  )
}

/** Where `hop` can still take off from and land at `x`, or undefined once its target has gone or
 * can no longer be reached from where she stands. A way down needs her to be up on a perch. */
function ledgeFor(hop: PetHop, x: number, state: PetEngineState, world: PetWorld, here: RoamSpan): Ledge | undefined {
  if (hop.id.startsWith('floor:')) {
    if (!state.perchId) {
      return undefined
    }

    return spans(world)
      .filter(span => joins(here, span, world))
      .map(span => ledgeBetween(here, { ...span, y: world.floorY }))
      .find(ledge => roamIsFree(x, [ledge.takeoff]))
  }

  const perch = world.perches.find(value => value.id === hop.id && validPerch(value, world) && value.y === hop.y)
  const ledge = perch && joins(here, perch, world) ? ledgeBetween(here, { ...perch, perchId: perch.id }) : undefined

  return ledge && roamIsFree(x, [ledge.takeoff]) ? ledge : undefined
}

/** Where a run-up ends: somewhere on the ledge's overlap, far enough from her for a few visible
 * steps; when the overlap is too short for that, its far end. */
function runUp(x: number, ledge: RoamSpan, rng: Rng): number {
  const pick = ledge.left + rng() * (ledge.right - ledge.left)

  if (Math.abs(pick - x) >= PET_RUN_UP_MIN_PX) {
    return pick
  }

  return Math.abs(ledge.left - x) >= Math.abs(ledge.right - x) ? ledge.left : ledge.right
}

/** The spring itself: a fixed short ballistic arc onto (or off) the ledge, carried a little
 * forward in the direction she ran, never past the overlap. */
function leap(state: PetEngineState, ledge: Ledge): PetDecision {
  const { land } = ledge
  const anchor = Math.min(land.right, Math.max(land.left, state.x))
  const heading = anchor === state.x ? state.facing : anchor > state.x ? 1 : -1
  const toX = Math.min(land.right, Math.max(land.left, anchor + heading * LEAP_DRIFT_PX))
  const facing = toX === state.x ? state.facing : toX > state.x ? 1 : -1

  return finish(
    {
      ...state,
      facing,
      hop: undefined,
      motion: {
        fromX: state.x,
        fromY: state.y,
        toX,
        toY: ledge.y,
        startedAt: state.now,
        durationMs: PET_LEAP_MS,
        arcHeight: Math.max(1, state.profile.hopHeight),
        kind: 'leap'
      }
    },
    {
      pose: resolvePose('jump', state.stateRows),
      mirror: facing > 0,
      targetX: toX,
      ...(ledge.perchId ? { hopToPerch: ledge.perchId } : {})
    },
    PET_LEAP_MS
  )
}

/** A hop is two beats, as the legacy pet did it: a walk to a takeoff point inside the overlap
 * with the target, then the leap. Standing already where a run-up would end, she just leaps. */
function hop(
  state: PetEngineState,
  candidates: readonly PetPerch[],
  here: RoamSpan,
  rng: Rng
): PetDecision | undefined {
  const target = candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))]

  if (!target) {
    return undefined
  }

  const ledge = ledgeBetween(here, { ...target, ...(target.id.startsWith('floor:') ? {} : { perchId: target.id }) })
  const takeoff = runUp(state.x, ledge.takeoff, rng)

  return Math.abs(takeoff - state.x) < 0.5
    ? leap(state, ledge)
    : travel({ ...state, hop: { id: target.id, y: target.y } }, takeoff)
}

function command(state: PetEngineState, value: PetCommand, world: PetWorld, here: RoamSpan): PetDecision {
  if (value.action === 'go' && value.place) {
    const desired = { left: 0, right: world.width, center: world.width / 2 }[value.place]

    return travel(state, Math.min(here.right, Math.max(here.left, desired)))
  }

  const actionPose: Record<Exclude<PetCommand['action'], 'go'>, PetPose> = {
    wave: 'wave',
    jump: 'jump',
    sit: 'waiting',
    lounge: 'lounging',
    sleep: 'sleep'
  }

  return pose(state, value.action === 'go' ? 'idle' : actionPose[value.action], 1800)
}

/** One beat. Commands are fresh input batches, not a persistent desired state.
 * Hosts re-decide on world/signals/input changes and at wakeAt; RAF is only for
 * an active motion. All time and randomness are supplied by the host. */
export function decide(
  input: PetEngineState,
  world: PetWorld,
  signals: PetSignals,
  commands: readonly PetCommand[],
  rng: Rng
): PetDecision {
  const flight = input.motion?.kind === 'leap' ? input.motion : undefined

  if (!flight) {
    return decideAt(input, world, signals, commands, rng)
  }

  // A leap is one move: the beat is decided from where it lands, never from a point in mid-air
  // (beside a surface, a reach leap's path crosses ground she may not stand on). If the beat ends
  // the leap (work, a command, sleep, a vanished target), she is simply there; while it flies on,
  // the drawn point stays the one in the air.
  const landed = decideAt(
    {
      ...input,
      x: flight.toX,
      y: flight.toY,
      perchId: input.intent.hopToPerch ?? (flight.toY === world.floorY ? undefined : input.perchId)
    },
    world,
    signals,
    commands,
    rng
  )

  if (landed.state.motion !== flight) {
    return landed
  }

  const state = { ...landed.state, x: input.x, y: input.y, perchId: input.perchId }

  return { ...landed, state }
}

function decideAt(
  input: PetEngineState,
  world: PetWorld,
  signals: PetSignals,
  commands: readonly PetCommand[],
  rng: Rng
): PetDecision {
  const freshCommands = commands.length > 0 && commands !== input.lastCommandBatch
  let state = { ...input, ...(freshCommands ? { lastCommandBatch: commands } : {}) }
  const free = spans(world)

  const retainedPerch = state.perchId
    ? world.perches.find(perch => perch.id === state.perchId && validPerch(perch, world))
    : undefined

  if (retainedPerch && state.motion?.kind !== 'leap') {
    const x = Math.max(retainedPerch.left, Math.min(retainedPerch.right, state.x))

    if (state.motion) {
      const toX = Math.max(retainedPerch.left, Math.min(retainedPerch.right, state.motion.toX))
      state = {
        ...state,
        x,
        y: retainedPerch.y,
        motion: {
          ...state.motion,
          fromX: Math.max(retainedPerch.left, Math.min(retainedPerch.right, state.motion.fromX)),
          fromY: retainedPerch.y,
          toX,
          toY: retainedPerch.y
        },
        intent: { ...state.intent, targetX: toX }
      }
    } else {
      state = { ...state, x, y: retainedPerch.y }
    }
  }

  let perched = perchFor(state, world)
  let here: RoamSpan | undefined = perched ?? free.find(span => roamIsFree(state.x, [span]))

  // An inactive host never moves even when the world changes under the pet.
  // If her old position is no longer safe, the host hides rather than moves her.
  if (signals.away || signals.reducedMotion) {
    return pose({ ...state, visible: !!here, pendingCommands: [], routine: undefined }, 'idle', null)
  }

  if (state.perchId && !perched) {
    state = {
      ...state,
      y: world.floorY,
      perchId: undefined,
      motion: undefined,
      hop: undefined,
      routine: undefined,
      intent: { pose: 'idle', mirror: state.facing > 0 }
    }
  }

  if (!here) {
    const nearest = roamNearestFree(state.x, free)

    if (nearest === undefined) {
      return pose(
        { ...state, visible: false, pendingCommands: [], routine: undefined, perchId: undefined },
        'idle',
        null
      )
    }

    state = {
      ...state,
      x: nearest,
      y: world.floorY,
      perchId: undefined,
      motion: undefined,
      hop: undefined,
      intent: { pose: 'idle', mirror: state.facing > 0 }
    }
    here = free.find(span => roamIsFree(nearest, [span]))!
    perched = undefined
  }

  state.visible = true

  if (!perched && !state.motion) {
    state.y = world.floorY
  } else if (
    !perched &&
    state.motion &&
    state.motion.kind !== 'leap' &&
    state.motion.fromY === state.motion.toY &&
    state.motion.toY === state.y &&
    state.y !== world.floorY
  ) {
    // The floor moved under a walk along it (a composer growing or shrinking): the walk carries on along
    // the new line rather than finishing on the old one, inside whatever now stands there. A leap, and a
    // walk on a perch, are not touched.
    state = {
      ...state,
      y: world.floorY,
      motion: { ...state.motion, fromY: world.floorY, toY: world.floorY }
    }
  }

  // Work state owns the standing pose and consumes rather than defers commands.
  if (signals.work !== 'idle') {
    const workPose = { working: 'run', waiting: 'waiting', failed: 'failed' } as const

    return pose(
      { ...state, y: perched?.y ?? world.floorY, pendingCommands: [], routine: undefined },
      workPose[signals.work],
      null,
      signals.work === 'waiting' ? 'yourTurn' : signals.work === 'failed' ? 'failed' : undefined
    )
  }

  if (freshCommands) {
    state = {
      ...state,
      y: perched?.y ?? world.floorY,
      pendingCommands: [...commands],
      routine: undefined,
      motion: undefined,
      hop: undefined
    }
  } else if (!state.pendingCommands.length && shouldSleep(signals.idleMs)) {
    return pose({ ...state, y: perched?.y ?? world.floorY, routine: undefined }, 'sleep', null)
  }

  if (state.motion) {
    const { toX, toY } = state.motion

    const destination = state.intent.hopToPerch
      ? world.perches.find(
          perch =>
            perch.id === state.intent.hopToPerch &&
            validPerch(perch, world) &&
            toY === perch.y &&
            roamIsFree(toX, [perch]) &&
            roamIsFree(toX, [here!])
        )
      : roamIsFree(toX, [here]) &&
        (!state.perchId || toY !== world.floorY || roamIsFree(toX, world.free)) &&
        (toY === state.y || (toY === world.floorY && roamIsFree(toX, world.free))) &&
        // A run-up is only worth finishing while its ledge still meets the takeoff point.
        (!state.hop || !!ledgeFor(state.hop, toX, state, world, here))

    if (!destination) {
      state = {
        ...state,
        y: perched?.y ?? world.floorY,
        motion: undefined,
        hop: undefined,
        routine: undefined,
        intent: { pose: 'idle', mirror: state.facing > 0 }
      }
    } else if (state.now >= state.motion.startedAt + state.motion.durationMs) {
      state = {
        ...state,
        x: toX,
        y: toY,
        motion: undefined,
        perchId: state.intent.hopToPerch ?? (toY === world.floorY ? undefined : state.perchId),
        intent: { pose: 'idle', mirror: state.facing > 0 }
      }
      perched = perchFor(state, world)
      here = perched ?? free.find(span => roamIsFree(state.x, [span]))!
    }
  }

  if (!freshCommands && state.wakeAt !== null && state.now < state.wakeAt) {
    return { state, intent: state.intent, wakeAt: state.wakeAt }
  }

  // At the end of a run-up: the leap, if its ledge still meets her here.
  if (state.hop && !state.motion) {
    const ledge = ledgeFor(state.hop, state.x, state, world, here)

    if (ledge) {
      return leap(state, ledge)
    }

    state = { ...state, hop: undefined }
  }

  if (state.pendingCommands.length) {
    const [next, ...rest] = state.pendingCommands

    return command({ ...state, pendingCommands: rest }, next, world, here)
  }

  const perches = reachablePerches(state, world, here)

  if (!state.routine) {
    const routine = chooseRoutine(rng, {
      canHop: perches.length > 0,
      chance: state.profile.routineChance,
      routines: state.profile.routines
    })

    if (routine) {
      state.routine = { routine, step: 0, originX: state.x }
    }
  }

  while (state.routine) {
    const step = state.routine.routine.steps[state.routine.step]
    const next = { ...state, routine: { ...state.routine, step: state.routine.step + 1 } }

    if (!step) {
      state.routine = undefined
    } else if (step.kind === 'pose') {
      return pose(next, step.pose, step.ms)
    } else if (step.kind === 'hop') {
      const result = perches.length ? hop(next, perches, here, rng) : undefined

      if (result) {
        return result
      }

      state = next
    } else {
      const near = Math.abs(state.x - here.left) <= Math.abs(here.right - state.x) ? here.left : here.right

      const desired =
        step.to === 'back'
          ? state.routine.originX
          : step.to === 'end'
            ? near
            : near === here.left
              ? here.right
              : here.left

      return travel(next, Math.max(here.left, Math.min(here.right, desired)))
    }
  }

  const move = chooseMove(perches.length > 0, rng, state.profile)

  if (move === 'hop') {
    const result = hop(state, perches, here, rng)

    if (result) {
      return result
    }
  }

  if (move === 'stroll' && here.right - here.left > 4) {
    return travel(state, pickStrollTarget({ ...here, y: state.y }, state.x, rng))
  }

  const gesture = chooseGesture(rng, {
    onPerch: !!perched,
    chance: state.profile.gestureChance,
    weights: perched ? state.profile.perchGestureWeights : state.profile.gestureWeights
  })

  return pose(state, gesture ?? 'idle', dwellMs(state.profile.dwell, rng))
}
