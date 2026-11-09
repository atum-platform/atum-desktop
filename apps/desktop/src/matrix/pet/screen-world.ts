import { clampToScreens, type DisplayInfo, screenLedges, type SurfaceInput } from '../../../electron/screen-surfaces'
import type { PetWorld } from '../../../shared/pet-engine/types'

/** Main-only adapter. The portable engine receives local coordinates, never Electron. */
export function petScreenWorld(
  displays: DisplayInfo[],
  point: { x: number; y: number },
  width: number,
  height: number
) {
  const input: SurfaceInput = { displays, petW: width, petH: height }
  const clamped = clampToScreens(point, input)

  const display =
    displays.find(
      ({ workArea: a }) =>
        clamped.x >= a.x && clamped.x < a.x + a.width && clamped.y >= a.y && clamped.y < a.y + a.height
    ) ?? displays[0]

  if (!display) {
    return undefined
  }

  const area = display.workArea
  const ledge = screenLedges({ ...input, displays: [display] })[0]

  const world: PetWorld = {
    width: area.width,
    floorY: area.height,
    free: ledge ? [{ left: ledge.left - area.x, right: ledge.right - area.x }] : [],
    perches: []
  }

  return { world, origin: { x: area.x, y: area.y }, point: { x: clamped.x - area.x, y: clamped.y - area.y } }
}
