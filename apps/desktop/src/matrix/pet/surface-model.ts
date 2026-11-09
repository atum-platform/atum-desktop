import {
  ROAM_CONTROL_GAP_PX,
  roamControlSpans,
  roamFreeSpans,
  type RoamRect,
  type RoamSpan
} from '../../../shared/pet-engine/lane'
import type { PetWorld } from '../../../shared/pet-engine/types'

export interface PetStageGeometry {
  bottom: number
  left: number
  right: number
  top: number
}

export interface PetBodyGeometry {
  /** Painted cell height. */
  height: number
  /** Ground-to-cell-top distance of the opaque foot baseline. */
  footY: number
  width: number
}

export interface PetWalkSurfaceGeometry {
  /** Stable across layout changes; span suffixes are added only when controls split the edge. */
  id: string
  rect: RoamRect
  /** Controls owned by this surface whose horizontal stretch is not walkable. */
  blocks?: readonly RoamRect[]
}

export interface PetWorldGeometry {
  body: PetBodyGeometry
  /** The visible bottom edge of the stage. */
  floorBottom?: number
  /** Boxes painted beneath her layer beside her surfaces (the dock's notices and prompts). A rim
   * stand point keeps out of them; the floor runs in front of them. */
  furniture?: readonly RoamRect[]
  /** Boxes that paint over her layer (open menus, popovers, in-tree overlays) or are marked as no
   * place to stand (`data-pet-avoid`). No stand point on any line may share a pixel with one. */
  obstacles?: readonly RoamRect[]
  stage: PetStageGeometry
  surfaces: readonly PetWalkSurfaceGeometry[]
}

function intersect(left: readonly RoamSpan[], right: readonly RoamSpan[]): RoamSpan[] {
  return left.flatMap(a =>
    right
      .map(b => ({ left: Math.max(a.left, b.left), right: Math.min(a.right, b.right) }))
      .filter(span => span.left <= span.right)
  )
}

function widthOf(rect: Pick<RoamRect, 'left' | 'right'>): number {
  return Math.max(0, rect.right - rect.left)
}

function heightOf(rect: Pick<RoamRect, 'bottom' | 'top'>): number {
  return Math.max(0, rect.bottom - rect.top)
}

function localSpan(stage: PetStageGeometry, rect: Pick<RoamRect, 'left' | 'right'>): RoamSpan {
  return { left: rect.left - stage.left, right: rect.right - stage.left }
}

/** The cell top that puts the sprite's declared foot baseline exactly on an edge. */
export function petTopForSurface(surfaceY: number, footY: number): number {
  return surfaceY - footY
}

/**
 * One pure projection from measured layout to the engine's floor/perches.
 *
 * The invariant : nothing ever paints over
 * her, and the ground is hers. Her layer paints above everything in the chat (the composer, its
 * dock, a side panel), so the floor is the stage's whole bottom edge and she walks it in front of
 * them; it loses only the stretches under what paints over her layer (`obstacles`). A surface's top
 * edge is a perch; standing there she also keeps out of other surfaces and the dock's furniture
 * above it. Floor and rim are joined by a straight hop where they overlap, and by `reach`, a leap
 * across a gap, where they do not.
 */
export function petWorldFromGeometry({
  body,
  floorBottom,
  furniture = [],
  obstacles = [],
  stage,
  surfaces
}: PetWorldGeometry): PetWorld {
  const width = widthOf(stage)
  const floorY = Math.min(heightOf(stage), Math.max(0, (floorBottom ?? stage.bottom) - stage.top))
  const floorLine = { left: stage.left, bottom: stage.top + floorY }

  // A walk line is clear where nothing that paints over her (with daylight) meets her band.
  const uncovered = (line: { left: number; bottom: number }): RoamSpan[] =>
    roamFreeSpans(width, body.width, roamControlSpans(line, body.height, obstacles))

  // A rim is also clear of the furniture (with daylight) and the other surfaces (flush) above it.
  const clearOn = (line: { left: number; bottom: number }, own: PetWalkSurfaceGeometry): RoamSpan[] =>
    intersect(
      intersect(
        uncovered(line),
        roamFreeSpans(width, body.width, roamControlSpans(line, body.height, furniture))
      ),
      roamFreeSpans(
        width,
        body.width,
        roamControlSpans(
          line,
          body.height,
          surfaces.filter(surface => surface !== own).map(surface => surface.rect)
        ),
        0
      )
    )

  const free = uncovered(floorLine)

  const perches = surfaces.flatMap(surface => {
    const rect = surface.rect
    const y = rect.top - stage.top

    if (
      widthOf(rect) < body.width ||
      heightOf(rect) <= 0 ||
      y < body.footY ||
      y >= floorY ||
      rect.right <= stage.left ||
      rect.left >= stage.right
    ) {
      return []
    }

    const edge = {
      left: Math.max(0, rect.left - stage.left),
      right: Math.min(width - body.width, rect.right - stage.left - body.width)
    }

    if (edge.left > edge.right) {
      return []
    }

    const line = { left: stage.left, bottom: rect.top }
    const owned = roamFreeSpans(width, body.width, (surface.blocks ?? []).map(rect => localSpan(stage, rect)))
    const spans = intersect(intersect([edge], clearOn(line, surface)), owned)

    return spans.map((span, index) => ({ ...span, id: `${surface.id}:${index}`, y }))
  })

  // Where an obstacle ends a floor or a rim, the next surface is one body width away (left-edge
  // coordinates), so a leap must cross at least that gap; the daylight is slack for fractional layout.
  return { width, floorY, free, perches, reach: body.width + ROAM_CONTROL_GAP_PX }
}
