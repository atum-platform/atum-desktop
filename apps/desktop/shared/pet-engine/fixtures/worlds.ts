import { profileFor } from '../profile'
import type { PetSignals, PetWorld, StageProfile } from '../types'

export const IDLE: PetSignals = { work: 'idle', idleMs: 0, away: false, reducedMotion: false }
export const FLOOR: PetWorld = { width: 600, floorY: 300, free: [{ left: 0, right: 500 }], perches: [] }
export const SPLIT: PetWorld = {
  ...FLOOR,
  free: [
    { left: 0, right: 120 },
    { left: 240, right: 500 }
  ]
}
export const PERCHED: PetWorld = {
  ...FLOOR,
  perches: [
    { id: 'composer', left: 80, right: 240, y: 220 },
    { id: 'rail', left: 400, right: 500, y: 80 }
  ]
}
export const LOAF: StageProfile = { ...profileFor(), routineChance: 0, restChance: 1, gestureChance: 0 }
export const STROLL: StageProfile = { ...LOAF, restChance: 0, hopChance: 0 }
export const HOP: StageProfile = { ...STROLL, hopChance: 1 }

/** Test-local seeded source; no cross-language PRNG contract is promised. */
export function seeded(seed: number): () => number {
  let value = seed >>> 0

  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0

    return value / 2 ** 32
  }
}
