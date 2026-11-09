import { roamControlSpans, roamFreeSpans, roamNearestFree } from '../../../shared/pet-engine/lane'
import type { PetWorld } from '../../../shared/pet-engine/types'

import { type PetWalkSurfaceGeometry, petWorldFromGeometry } from './surface-model'

// The mature companion walks whole named edges. A generic button is not
// furniture: treating every control as a wall is how the old stage collapsed
// into tiny gaps beside the composer. Surface owners mark only deliberate
// obstructions.
const AVOID = '[data-pet-avoid]'
const WALK_SURFACE = '[data-pet-walk-surface], [data-pet-perch]'
// Furniture: everything the composer dock draws beside the composer (prompts, notices). It paints
// beneath her layer: she never stands on a rim that runs into it, and walks the floor in front of
// it. Only her own anchor in the dock is not furniture.
const DOCK = '[data-matrix-composer-dock]'
const OWN = '[data-matrix-pet], [data-pet-own], [data-pet-glass]'
// In-tree layers drawn over the whole chat (a full-frame workspace, an in-chat dialog).
const IN_TREE_COVER = '[data-overlay-surface], [role="dialog"]'
// A tooltip is momentary and follows the pointer: it never moves her.
const MOMENTARY = '[role="tooltip"], [data-slot="tooltip-content"]'
// A cover smaller than this is a focus guard or a screen-reader-only node, not something she can be under.
const MIN_COVER_PX = 4

export function petStageRoot(lane: HTMLElement): Element | null {
  return (
    lane.closest('[data-pet-stage-root]') ??
    lane.closest('[data-pet-stage]') ??
    lane.closest('[data-atum-chat]') ??
    lane.parentElement
  )
}

function surfaceName(element: HTMLElement): string {
  return (
    element.dataset.petWalkSurface ??
    element.dataset.petPerch ??
    (element.matches('[data-slot="composer-surface"]') ? 'composer' : 'surface')
  )
}

function visibleRect(element: HTMLElement): DOMRect | undefined {
  // Inert takes a surface out of the keyboard's reach, not off the screen: it is still painted
  // (a chat under a full-frame workspace), so it stays a surface. Only a hidden one is gone.
  if (element.closest('[hidden]')) {
    return undefined
  }

  const rect = element.getBoundingClientRect()

  return rect.width > 0 && rect.height > 0 ? rect : undefined
}

function measured(element: Element): DOMRect | undefined {
  const rect = element.getBoundingClientRect()

  return rect.width > 0 && rect.height > 0 ? rect : undefined
}

/** The dock's furniture: each box it draws, opened up only where it holds a walk surface (the
 * composer root's padding sits above the rim, so the root is not furniture; its other children are). */
function furniture(element: Element, surfaces: readonly Element[]): DOMRect[] {
  return [...element.children].flatMap(child => {
    if (child.matches(OWN) || surfaces.includes(child)) {
      return []
    }

    if (surfaces.some(surface => child.contains(surface))) {
      return furniture(child, surfaces)
    }

    const rect = child.closest('[hidden]') ? undefined : measured(child)

    return rect ? [rect] : []
  })
}

function own(layer: Element): boolean {
  return layer.matches(OWN) || Boolean(layer.querySelector(OWN))
}

function momentary(layer: Element): boolean {
  return layer.matches(MOMENTARY) || Boolean(layer.querySelector(MOMENTARY))
}

/** A body-level node that paints nothing is no cover. react-textarea-autosize measures text in a
 * hidden textarea pinned to the page's top right; counted as a cover, it took the side-panel
 * browser's top edge from her (0.20.27). */
function unpainted(layer: Element): boolean {
  const style = layer.ownerDocument.defaultView?.getComputedStyle(layer)

  return style?.visibility === 'hidden' || style?.display === 'none' || style?.opacity === '0'
}

/** What is layered over her stage: open menus, popovers and dialogs portalled to the document
 * body (they paint above the whole app), and overlay surfaces inside the stage root. */
function covers(root: Element | null, body: HTMLElement): DOMRect[] {
  const page = body.ownerDocument.body
  const app = root ? [...page.children].find(child => child.contains(root)) : undefined

  const layers = [
    ...[...page.children].filter(child => child !== app && !['SCRIPT', 'STYLE', 'TEMPLATE'].includes(child.tagName)),
    ...(root?.querySelectorAll(IN_TREE_COVER) ?? [])
  ]

  return layers.flatMap(layer => {
    if (body.contains(layer) || own(layer) || momentary(layer) || layer.closest('[hidden]') || unpainted(layer)) {
      return []
    }

    const rect = measured(layer)

    return rect && rect.width >= MIN_COVER_PX && rect.height >= MIN_COVER_PX ? [rect] : []
  })
}

/** DOM adapter only: measure the current shell, then hand pure geometry to the model. */
export function readPetWindowWorld(
  stage: HTMLElement,
  body: HTMLElement,
  size: { width: number; height: number; footY?: number },
  dock?: HTMLElement
): PetWorld {
  const box = stage.getBoundingClientRect()
  const root = petStageRoot(stage)
  const floorElement = dock ?? root?.querySelector<HTMLElement>('[data-pet-floor]')
  const floorBottom = floorElement?.getBoundingClientRect().bottom ?? box.bottom

  const marked = [...(root?.querySelectorAll<HTMLElement>(AVOID) ?? [])]
    .filter(element => !body.contains(element))
    .map(element => element.getBoundingClientRect())
    .filter(rect => rect.width > 0 && rect.height > 0)

  if (dock) {
    const floorY = Math.min(box.height, Math.max(0, floorBottom - box.top))

    const free = roamFreeSpans(
      box.width,
      size.width,
      roamControlSpans({ left: box.left, bottom: box.top + floorY }, size.height, marked)
    )

    const paw = root?.querySelector<HTMLElement>('[data-pet-paw]')?.getBoundingClientRect()
    const preferred = (paw?.left ?? dock.getBoundingClientRect().right) - box.left - size.width - 8

    const point =
      roamNearestFree(preferred, free) ?? Math.max(0, Math.min(preferred, Math.max(0, box.width - size.width)))

    return { width: box.width, floorY, free: [{ left: point, right: point }], perches: [] }
  }

  const tagged = [...(root?.querySelectorAll<HTMLElement>(WALK_SURFACE) ?? [])]

  // Compatibility for a shared composer that has not opted into the marker yet.
  const composer =
    root?.querySelector<HTMLElement>('[data-matrix-composer-dock] [data-slot="composer-surface"]') ??
    root?.querySelector<HTMLElement>('[data-slot="composer-surface"]')

  if (composer && !tagged.includes(composer)) {
    tagged.push(composer)
  }

  // What paints over her layer (and marked no-stand places) takes ground away everywhere; what the
  // dock draws beneath her layer only keeps her off a rim that runs into it.
  const obstacles = [...marked, ...covers(root, body)]
  const dockFurniture = [...(root?.querySelectorAll(DOCK) ?? [])].flatMap(dock => furniture(dock, tagged))

  const occurrences = new Map<string, number>()

  const surfaces = tagged.flatMap((element): PetWalkSurfaceGeometry[] => {
    const rect = visibleRect(element)

    if (!rect) {
      return []
    }

    const name = surfaceName(element)
    const occurrence = occurrences.get(name) ?? 0

    occurrences.set(name, occurrence + 1)

    return [{ id: `${name}:${occurrence}`, rect }]
  })

  return petWorldFromGeometry({
    stage: box,
    floorBottom,
    body: { width: size.width, height: size.height, footY: size.footY ?? size.height },
    furniture: dockFurniture,
    obstacles,
    surfaces
  })
}

/**
 * Every measured boundary is observed. ResizeObserver runs before paint, and
 * the stage reconciles immediately in that callback, so a panel transition or
 * growing composer cannot leave one visible frame on the old edge. Layers
 * portalled to the document body (an opening menu) are watched too; changes
 * elsewhere in the app tree, and in her own portalled UI, are not.
 */
export function observePetWindowWorld(stage: HTMLElement, changed: () => void): () => void {
  const root = petStageRoot(stage)
  const page = stage.ownerDocument.body
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(changed)

  const watch = () => {
    resize?.disconnect()
    resize?.observe(stage)

    if (root) {
      resize?.observe(root)
    }

    for (const element of root?.querySelectorAll(
      `${WALK_SURFACE}, [data-pet-floor], [data-slot="composer-root"], [data-slot="composer-surface"], [data-slot="composer-actions"], [data-pet-avoid], [data-pet-paw], ${DOCK} > *, ${IN_TREE_COVER}`
    ) ?? []) {
      resize?.observe(element)
    }

    for (const element of page.children) {
      if (!root || !element.contains(root)) {
        resize?.observe(element)
      }
    }
  }

  watch()

  const mutations =
    typeof MutationObserver === 'undefined'
      ? undefined
      : new MutationObserver(() => {
          watch()
          changed()
        })

  mutations?.observe(root ?? stage, {
    attributeFilter: ['hidden', 'inert', 'data-pet-avoid', 'data-overlay-surface', 'role'],
    attributes: true,
    childList: true,
    subtree: true
  })

  // A portalled menu mounts as a body child and is placed by a style write once it has measured.
  const app = root ? [...page.children].find(child => child.contains(root)) : undefined

  const layer = (target: Node) =>
    target === page || (!app?.contains(target) && !(target instanceof Element && target.closest(OWN)))

  const layers =
    typeof MutationObserver === 'undefined'
      ? undefined
      : new MutationObserver(records => {
          if (records.some(record => layer(record.target))) {
            watch()
            changed()
          }
        })

  layers?.observe(page, {
    attributeFilter: ['hidden', 'style', 'data-state'],
    attributes: true,
    childList: true,
    subtree: true
  })
  root?.addEventListener('scroll', changed, { capture: true, passive: true })

  return () => {
    resize?.disconnect()
    mutations?.disconnect()
    layers?.disconnect()
    root?.removeEventListener('scroll', changed, { capture: true })
  }
}
