import { roamNearestFree } from '../../../shared/pet-engine/lane'
import type { PetEngineState, PetWorld } from '../../../shared/pet-engine/types'

/** Where the companion stands, in stage-local pixels: her left edge and ground line. */
export interface PetLanding {
  perchId?: string
  x: number
  y: number
}

// Unchanged since 0.19.2, so a resting place saved by then (a drop point) is honoured once.
const STAGE_POSITION_KEY = 'atum.matrix.pet-stage-position.v1'

function restKey(principal: string): string {
  return `${STAGE_POSITION_KEY}:${encodeURIComponent(principal)}`
}

/** The last place this agent's companion came to rest, from this Mac's window storage. */
export function recallPetRest(principal: string): PetLanding | undefined {
  try {
    const value = JSON.parse(window.localStorage.getItem(restKey(principal)) ?? 'null') as Partial<PetLanding> | null
    const x = value?.x
    const y = value?.y
    const perchId = value?.perchId

    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
      return undefined
    }

    return {
      ...(typeof perchId === 'string' ? { perchId } : {}),
      x,
      y
    }
  } catch {
    return undefined
  }
}

/** Keep where she came to rest, so any remount (a focus re-read, a room switch, a restart) puts
 * her back there rather than at an old drop point. */
export function rememberPetRest(principal: string, landing: PetLanding): void {
  try {
    window.localStorage.setItem(restKey(principal), JSON.stringify(landing))
  } catch {
    // Position is cosmetic. A private-storage failure must never stop the pet.
  }
}

export function samePetLanding(left: PetLanding | undefined, right: PetLanding): boolean {
  return Boolean(left && left.x === right.x && left.y === right.y && left.perchId === right.perchId)
}

/** Where a remount should put her back: a walk's current point, or a leap's landing. */
export function petRestingPlace(state: Pick<PetEngineState, 'x' | 'y' | 'perchId' | 'motion' | 'intent'>): PetLanding {
  const motion = state.motion

  if (motion?.kind === 'leap') {
    return {
      ...(state.intent.hopToPerch ? { perchId: state.intent.hopToPerch } : {}),
      x: motion.toX,
      y: motion.toY
    }
  }

  return {
    ...(state.perchId ? { perchId: state.perchId } : {}),
    x: state.x,
    y: motion ? motion.toY : state.y
  }
}

/** Clamp a dropped or restored point to a currently walkable floor/perch. A restored point keeps
 * to the perch she was on when it is still there, even if it has moved (the composer grew). */
export function settlePet(world: PetWorld, width: number, at: PetLanding): PetLanding {
  const own = at.perchId ? world.perches.find(perch => perch.id === at.perchId) : undefined

  if (own && own.left <= own.right) {
    return { perchId: own.id, x: Math.max(own.left, Math.min(own.right, at.x)), y: own.y }
  }

  const surfaces = [
    ...world.free.map(span => ({ ...span, y: world.floorY, perchId: undefined })),
    ...world.perches.map(perch => ({ ...perch, perchId: perch.id }))
  ]

  const landing = surfaces
    .map(surface => {
      const nextX = Math.max(surface.left, Math.min(surface.right, at.x))

      return {
        ...surface,
        containsDropX: at.x >= surface.left && at.x <= surface.right,
        distance: Math.hypot(nextX - at.x, surface.y - at.y),
        x: nextX
      }
    })
    .sort(
      (left, right) =>
        Number(right.containsDropX) - Number(left.containsDropX) || left.distance - right.distance
    )[0]

  return {
    ...(landing?.perchId ? { perchId: landing.perchId } : {}),
    x: landing?.x ?? Math.max(0, Math.min(world.width - width, at.x)),
    y: landing?.y ?? world.floorY
  }
}

export function defaultPetLanding(world: PetWorld, width: number): PetLanding {
  const preferred = Math.max(0, (world.width - width) * 0.18)
  const x = roamNearestFree(preferred, world.free) ?? preferred

  return settlePet(world, width, { x, y: world.floorY })
}
