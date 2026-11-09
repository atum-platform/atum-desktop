import type { Facing, PetEngineState, PetIntent, PetMotion } from './types'

export interface MotionResult {
  x: number
  y: number
  facing: Facing
  arrived: boolean
}

/**
 * A leap's height at `progress` (0–1): a parabola through the takeoff and the landing whose apex
 * clears the higher of the two by `arcHeight`, so she rises, tops out above the ledge and drops
 * onto it (or springs up a little before dropping off one) — constant gravity over a fixed time.
 */
function leapY(motion: PetMotion, progress: number): number {
  const apex = Math.min(motion.fromY, motion.toY) - Math.max(1, motion.arcHeight)
  const rise = motion.fromY - apex
  const fall = motion.toY - apex
  const b = -2 * (rise + Math.sqrt(rise * fall))
  const a = motion.toY - motion.fromY - b

  return motion.fromY + b * progress + a * progress * progress
}

/** Predict dtMs forward from the state's position/time without mutating it.
 * Commit the result and advance state.now by dtMs before the next frame. */
export function integrate(state: PetEngineState, intent: PetIntent, dtMs: number): MotionResult {
  const motion = state.motion

  if (!motion || intent.targetX !== motion.toX) {
    return { x: state.x, y: state.y, facing: state.facing, arrived: true }
  }

  const elapsed = Math.max(0, state.now - motion.startedAt) + Math.max(0, Number.isFinite(dtMs) ? dtMs : 0)
  const progress = Math.min(1, elapsed / Math.max(1, motion.durationMs))
  const facing = motion.toX === motion.fromX ? state.facing : motion.toX > motion.fromX ? 1 : -1

  if (progress === 1) {return { x: motion.toX, y: motion.toY, facing, arrived: true }}

  const x = motion.fromX + (motion.toX - motion.fromX) * progress

  const y =
    motion.kind === 'leap'
      ? leapY(motion, progress)
      : motion.fromY + (motion.toY - motion.fromY) * progress - Math.sin(Math.PI * progress) * motion.arcHeight

  return { x, y, facing, arrived: progress === 1 }
}
