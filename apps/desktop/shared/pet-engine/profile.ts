import { petDrawScale, type PetInfo } from '../pet'

import { GESTURE_WEIGHTS, PAUSE_DWELL, PERCH_GESTURE_WEIGHTS, ROUTINES } from './behaviour'
import { roamSize } from './lane'
import type { Locomotion, StageProfile } from './types'

const WALK: StageProfile = {
  locomotion: 'walk',
  restChance: 0.62,
  hopChance: 0.2,
  dwell: PAUSE_DWELL,
  gestureChance: 0.18,
  gestureWeights: GESTURE_WEIGHTS,
  perchGestureWeights: PERCH_GESTURE_WEIGHTS,
  routineChance: 0.1,
  routines: ROUTINES,
  speedPxPerSecond: 48,
  hopHeight: 24
}

/** Species-level defaults; per-pet personality configuration is deferred. */
const STAGE_PROFILES: Readonly<Record<Locomotion, StageProfile>> = {
  walk: WALK,
  hop: { ...WALK, locomotion: 'hop', restChance: 0.55, speedPxPerSecond: 60, hopHeight: 18 },
  float: {
    ...WALK,
    locomotion: 'float',
    restChance: 0.75,
    dwell: { minMs: 2500, meanMs: 6000, maxMs: 18000 },
    speedPxPerSecond: 32,
    hopHeight: 8
  },
  fly: { ...WALK, locomotion: 'fly', restChance: 0.5, speedPxPerSecond: 72, hopHeight: 32 }
}

export function profileFor(locomotion: Locomotion = 'walk'): StageProfile {
  const defaults = STAGE_PROFILES[locomotion]

  // Each host may tune its own speed without changing another pet's personality.
  return {
    ...defaults,
    dwell: { ...defaults.dwell },
    gestureWeights: defaults.gestureWeights.map(([pose, weight]) => [pose, weight] as const),
    perchGestureWeights: defaults.perchGestureWeights.map(([pose, weight]) => [pose, weight] as const),
    routines: defaults.routines.map(routine => ({ ...routine, steps: routine.steps.map(step => ({ ...step })) }))
  }
}

export type StageSurface = 'lane' | 'window' | 'overlay'
export const STAGE_MAX_HEIGHT: Readonly<Record<StageSurface, number>> = { lane: 220, window: 240, overlay: 260 }

// Owner chose unchanged Gigi/Cookie and approved relative sizes on2026-10-06.
// Gigi's existing 96px cell contains a 119/208-height opaque dog. New nominal
// standing sizes use that same reference density, then account for their own
// row silhouette. No slug-specific display behavior or legacy-manifest rewrite.
export const STAGE_REFERENCE_OPAQUE_RATIO = 119 / 208

export function stageSize(
  frame: { w: number; h: number },
  info: Pick<PetInfo, 'scale' | 'size' | 'sizeClass' | 'bounds'>,
  surface: StageSurface = 'lane'
): { width: number; height: number; zoom: number } {
  const drawScale = petDrawScale(info)

  if (!info.sizeClass) {
    return roamSize(frame, drawScale)
  }

  const naturalHeight = info.sizeClass.naturalHeightPt
  const scale = info.scale ?? 0.33

  if (!(scale > 0 && frame.h > 0 && frame.w > 0 && drawScale > 0)) {
    return { width: 0, height: 0, zoom: 1 }
  }

  if (!Number.isFinite(naturalHeight) || naturalHeight < 40 || naturalHeight > 300) {
    return roamSize(frame, drawScale)
  }

  const opaqueHeight = info.bounds?.idle?.height ?? frame.h * STAGE_REFERENCE_OPAQUE_RATIO

  if (!(opaqueHeight > 0 && Number.isFinite(opaqueHeight))) {
    return roamSize(frame, drawScale)
  }

  const cellHeight = (naturalHeight * scale ** 0.4 * STAGE_REFERENCE_OPAQUE_RATIO * frame.h) / opaqueHeight
  const height = Math.min(STAGE_MAX_HEIGHT[surface], Math.max(40, cellHeight))

  return {
    width: Math.round((frame.w * height) / frame.h),
    height: Math.round(height),
    zoom: height / (frame.h * drawScale)
  }
}
