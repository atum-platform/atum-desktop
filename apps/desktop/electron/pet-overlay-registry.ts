/**
 * Bookkeeping for the pet overlay windows — one per assistant.
 *
 * The decisions that need to be right (which key a call addresses, where a new
 * window lands, which one retires when the cap is reached) are pure functions
 * here so they can be unit-tested; electron/main.ts owns the BrowserWindow
 * objects and calls into these. Same split as electron/hermes-home.ts.
 */

/**
 * Pets that predate per-agent binding — and any caller that names no pet —
 * share this key, so single-overlay behaviour keeps working unchanged until the
 * renderer starts sending real assistant ids.
 */
const DEFAULT_PET_ID = '__active__'

/**
 * Every open overlay animates forever: they are created with
 * `backgroundThrottling: false` precisely so the sprite keeps moving while the
 * app is minimized. The window count is therefore a standing CPU cost, not just
 * visual clutter, and has to be bounded.
 */
const MAX_PET_OVERLAYS = 5

/** How far a colliding overlay is nudged, in px, per cascade step. */
const CASCADE_STEP = 28

interface Point {
  x: number
  y: number
}

type Bounds = Point & { height?: number; width?: number }

/**
 * Normalise a pet id.
 *
 * A pet id is an assistant's agent key — its Hermes profile key, the same value
 * the renderer sends with every pet RPC and groups sessions by. Deliberately NOT
 * the assistant's `identityId`: that is the id allowed to leave the machine, but
 * the backend leaves it empty whenever it never minted one, and every
 * identity-less profile would then normalise to the default below and share a
 * single window. A window key never leaves this process, so the always-present
 * profile key is both safe and correct here. Anything blank addresses the
 * default.
 */
function petIdOf(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''

  return id || DEFAULT_PET_ID
}

/**
 * Nudge `bounds` off any origin in `taken`.
 *
 * Two pets popped out from the same in-window spot would otherwise land exactly
 * on top of each other and read as one pet. Walks a diagonal until the origin is
 * clear, giving up after `limit` steps rather than marching a window off-screen
 * chasing a spot that a dense set of overlays may never leave free.
 */
function cascadeBounds<T extends Bounds>(bounds: T, taken: readonly Point[], limit = MAX_PET_OVERLAYS): T {
  let { x, y } = bounds

  for (let i = 0; i < limit; i += 1) {
    const collides = taken.some(
      point => Math.abs(point.x - x) < CASCADE_STEP && Math.abs(point.y - y) < CASCADE_STEP
    )

    if (!collides) {
      break
    }

    x += CASCADE_STEP
    y += CASCADE_STEP
  }

  return { ...bounds, x, y }
}

/**
 * Which keys must close before one more overlay can open.
 *
 * Least-recently-opened first. Exempting a user-pinned pet needs the pin concept
 * the renderer does not have yet (plan W3); until then every overlay is equally
 * retirable, which is why the cap is generous rather than tight.
 */
function retireesFor(order: readonly string[], max = MAX_PET_OVERLAYS): string[] {
  const excess = order.length - max + 1

  return excess > 0 ? order.slice(0, excess) : []
}

export { CASCADE_STEP, cascadeBounds, DEFAULT_PET_ID, MAX_PET_OVERLAYS, petIdOf, retireesFor }
