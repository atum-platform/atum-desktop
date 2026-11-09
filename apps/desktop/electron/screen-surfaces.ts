/**
 * The desktop's walkable geometry, for a pet that roams the whole screen rather
 * than the inside of the app window.
 *
 * Pure on purpose: `electron/main.ts` hands in what Electron reports and this
 * decides what counts as a surface, so the rules are unit-testable without a
 * display attached.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  /** The whole display. */
  bounds: Rect
  /** The display minus the menu bar and the Dock. */
  workArea: Rect
}

/** A horizontal line the pet can stand on, in screen coordinates. */
export interface ScreenLedge {
  /** The surface line: where the pet's feet rest. */
  y: number
  /** Bounds for the pet's top-left x, so the whole sprite stays on the ledge. */
  left: number
  right: number
  /** Only one kind now — see `screenLedges`. Kept named for logs and tests. */
  kind: 'floor'
}

export interface SurfaceInput {
  displays: DisplayInfo[]
  /** The app's own window frame, when it is visible. */
  appWindow?: null | Rect
  /** On-screen size of the pet. */
  petW: number
  petH: number
}

/** Minimum walkable run; anything narrower is a perch, not a surface. */
const MIN_LEDGE_PX = 40

function ledge(y: number, left: number, right: number, kind: ScreenLedge['kind'], petW: number): null | ScreenLedge {
  const usableRight = right - petW

  return usableRight - left >= MIN_LEDGE_PX ? { kind, left, right: usableRight, y } : null
}

/**
 * The ground, one line per display.
 *
 * This deliberately does NOT include the app window's title bar or the strip
 * under the menu bar, both of which it used to. They made the pet's landing spot
 * unpredictable: drop her anywhere over the Atum window and she perched on its
 * title bar instead of falling to the floor, which reads as her getting stuck on
 * invisible furniture rather than obeying gravity. One ground line is the whole
 * model, and it is the one people expect.
 *
 * The floor is the bottom of the *work area*, so with a Dock she stands on top
 * of it and without one she stands on the bottom of the screen — no Dock
 * detection needed, and a hidden Dock simply moves the line.
 *
 * The cost is that a single ledge per display means nothing to hop between, so
 * the desktop wander is rests and strolls. Worth it: a predictable floor beats
 * a richer world she gets caught in.
 */
export function screenLedges({ displays, petW }: SurfaceInput): ScreenLedge[] {
  const out: ScreenLedge[] = []

  for (const { workArea } of displays) {
    const floor = ledge(
      workArea.y + workArea.height,
      workArea.x,
      workArea.x + workArea.width,
      'floor',
      petW
    )

    if (floor) {
      out.push(floor)
    }
  }

  return out
}

/**
 * Clamp a pet position to somewhere on screen.
 *
 * A pet dragged to another display, or left behind when a display is
 * unplugged, must not strand itself in coordinates nothing can reach. Picks the
 * display the pet's centre is nearest and keeps it inside that work area.
 */
export function clampToScreens(point: { x: number; y: number }, input: SurfaceInput): { x: number; y: number } {
  const { displays, petW, petH } = input

  if (displays.length === 0) {
    return point
  }

  const cx = point.x + petW / 2
  const cy = point.y + petH / 2

  const distance = (d: DisplayInfo) => {
    const { workArea: a } = d
    const dx = Math.max(a.x - cx, 0, cx - (a.x + a.width))
    const dy = Math.max(a.y - cy, 0, cy - (a.y + a.height))

    return Math.hypot(dx, dy)
  }

  const home = displays.reduce((best, d) => (distance(d) < distance(best) ? d : best), displays[0]!)
  const { workArea } = home

  return {
    x: Math.min(Math.max(point.x, workArea.x), workArea.x + workArea.width - petW),
    y: Math.min(Math.max(point.y, workArea.y), workArea.y + workArea.height - petH)
  }
}

/**
 * Resolve a named place the agent can send the pet to, as a target x.
 *
 * Deliberately coarse: an assistant saying "go to the left side of the screen"
 * means a region, not a pixel, and a pet that lands on an exact coordinate reads
 * as teleporting furniture rather than as a dog being called.
 */
/** Where each named place sits along a ledge, as a fraction of its span. */
const PLACES: Record<string, number> = {
  center: 0.5,
  centre: 0.5,
  left: 0.08,
  middle: 0.5,
  right: 0.92
}

export function targetXFor(place: string, ledge: ScreenLedge): null | number {
  const fraction = PLACES[place.trim().toLowerCase()]

  return fraction === undefined ? null : ledge.left + (ledge.right - ledge.left) * fraction
}
