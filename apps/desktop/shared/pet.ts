/** Presentation data shared by Hermes-backed surfaces; no account or profile state. */
export type PetState =
  | 'idle'
  | 'wave'
  | 'run'
  | 'failed'
  | 'review'
  | 'jump'
  | 'waiting'
  | 'lounging'
  | 'sleep'
  | 'carried'

/** A held pet is named and explained, never silently replaced by another pet. */
export interface PetHold {
  slug: string
  displayName?: string
  reason: string
}

export interface PetInfo {
  enabled: boolean
  held?: PetHold | null
  slug?: string
  displayName?: string
  mime?: string
  spritesheetBase64?: string
  /** Engine sheet revision (`mtime_ns:size`), not the portable preference CAS. */
  spritesheetRevision?: string
  frameW?: number
  frameH?: number
  framesPerState?: number
  /** Real padding-trimmed counts; don't animate transparent trailing cells. */
  framesByState?: Record<string, number>
  /** Concrete atlas rows can differ from the coarse Hermes activity names. */
  framesByRow?: Record<string, number>
  loopMs?: number
  scale?: number
  /** Pet's own size multiplier; `scale` remains the person's setting. */
  size?: number
  stateRows?: string[]
  /** Nominal standing size relative to the existing Gigi reference. */
  sizeClass?: PetSizeClass
  /** Cell pixels: exclusive bottom of idle feet and horizontal body centre. */
  anchor?: PetAnchor
  /** Tight opaque union for each atlas row, in cell pixels. */
  bounds?: Record<string, PetBounds>
  locomotion?: PetLocomotion
}

export type PetLocomotion = 'walk' | 'hop' | 'float' | 'fly'

export interface PetSizeClass {
  naturalHeightPt: number
}

export interface PetAnchor {
  footY: number
  centerX: number
}

export interface PetBounds {
  x: number
  y: number
  width: number
  height: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

const BOUNDS_ROWS = new Set([
  'idle',
  'wave',
  'waving',
  'run',
  'running',
  'running-left',
  'running-right',
  'failed',
  'review',
  'jump',
  'jumping',
  'waiting',
  'lounging',
  'sleep',
  'carried',
  'look-0',
  'look-1',
  'extra1',
  'extra2'
])

/** Additive boundary only: legacy size/cell acceptance belongs to the caller. */
export function hasValidPetPresentationMetadata(value: PetInfo): boolean {
  if (value.sizeClass !== undefined) {
    const size = value.sizeClass

    if (
      !record(size) ||
      Object.keys(size).length !== 1 ||
      !finite(size.naturalHeightPt) ||
      size.naturalHeightPt < 40 ||
      size.naturalHeightPt > 300
    ) {
      return false
    }
  }

  if (value.anchor !== undefined) {
    const anchor = value.anchor

    if (
      !record(anchor) ||
      Object.keys(anchor).length !== 2 ||
      !finite(anchor.footY) ||
      !finite(anchor.centerX) ||
      anchor.footY < 0 ||
      anchor.footY > 208 ||
      anchor.centerX < 0 ||
      anchor.centerX > 192
    ) {
      return false
    }
  }

  if (value.bounds !== undefined) {
    if (!record(value.bounds)) {
      return false
    }

    const entries = Object.entries(value.bounds)

    if (entries.length < 1 || entries.length > 32) {
      return false
    }

    for (const [row, box] of entries) {
      if (
        !BOUNDS_ROWS.has(row) ||
        !record(box) ||
        Object.keys(box).length !== 4 ||
        !finite(box.x) ||
        !finite(box.y) ||
        !finite(box.width) ||
        !finite(box.height) ||
        box.x < 0 ||
        box.y < 0 ||
        box.width <= 0 ||
        box.height <= 0 ||
        box.x + box.width > 192 ||
        box.y + box.height > 208
      ) {
        return false
      }
    }
  }

  return value.locomotion === undefined || ['walk', 'hop', 'float', 'fly'].includes(value.locomotion)
}

// Mirrors agent.pet.constants.DEFAULT_SCALE; the engine normally sends scale.
export const PET_DRAW_SCALE_DEFAULT = 0.33

/** The person's scale × the pet's own size. Used by every drawing surface. */
export function petDrawScale(info: Pick<PetInfo, 'scale' | 'size'>, fallbackScale = PET_DRAW_SCALE_DEFAULT): number {
  return (info.scale ?? fallbackScale) * (info.size ?? 1)
}
