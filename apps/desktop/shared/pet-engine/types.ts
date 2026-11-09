import type { PetState } from '../pet'

import type { DwellRange, RoamGesture, Routine } from './behaviour'
import type { RoamSpan } from './lane'

export type PetPose = PetState
export type Locomotion = 'walk' | 'hop' | 'float' | 'fly'
export type Facing = -1 | 1

export interface PetCommand {
  action: 'go' | 'wave' | 'jump' | 'sit' | 'lounge' | 'sleep'
  place?: 'left' | 'right' | 'center'
}

export interface PetIntent {
  pose: PetPose
  mirror: boolean
  targetX?: number
  hopToPerch?: string
  bubble?: 'yourTurn' | 'failed' | 'reply'
}

export interface PetSignals {
  work: 'idle' | 'working' | 'waiting' | 'failed'
  idleMs: number
  away: boolean
  reducedMotion: boolean
}

export interface PetPerch extends RoamSpan {
  id: string
  y: number
}

export interface PetWorld {
  width: number
  floorY: number
  /** Safe left-edge positions, already accounting for the sprite's width. */
  free: readonly RoamSpan[]
  perches: readonly PetPerch[]
  /** The widest horizontal gap (between left-edge spans) a leap may cross from one surface to
   * another. Without it only surfaces that overlap horizontally connect (a straight-up hop). */
  reach?: number
}

export interface StageProfile {
  locomotion: Locomotion
  restChance: number
  hopChance: number
  dwell: DwellRange
  gestureChance: number
  gestureWeights: readonly (readonly [RoamGesture, number])[]
  perchGestureWeights: readonly (readonly [RoamGesture, number])[]
  routineChance: number
  routines: readonly Routine[]
  speedPxPerSecond: number
  hopHeight: number
}

export interface PetMotion {
  fromX: number
  fromY: number
  toX: number
  toY: number
  startedAt: number
  durationMs: number
  /** A walk's bob, or for a leap the clearance of its apex above the higher end. */
  arcHeight: number
  /** `leap`: a short ballistic jump onto or off a ledge, at a fixed duration
   * (the legacy pet's 460 ms spring), never a walk-speed lift. */
  kind?: 'leap'
}

/** The surface a run-up leads to: a real perch, or a synthetic `floor:<n>` way back down. */
export interface PetHop {
  id: string
  y: number
}

export interface PetRoutine {
  routine: Routine
  step: number
  originX: number
}

export interface PetEngineState {
  /** Monotonic host time corresponding to x/y; the engine reads no clock. */
  now: number
  x: number
  y: number
  facing: Facing
  visible: boolean
  intent: PetIntent
  wakeAt: number | null
  profile: StageProfile
  stateRows: readonly string[]
  perchId?: string
  motion?: PetMotion
  /** Set while she walks to a takeoff point; the leap follows when she gets there. */
  hop?: PetHop
  routine?: PetRoutine
  pendingCommands: readonly PetCommand[]
  /** One batch object is accepted once; hosts create a fresh batch on input. */
  lastCommandBatch?: readonly PetCommand[]
}

export interface PetDecision {
  state: PetEngineState
  intent: PetIntent
  wakeAt: number | null
}
