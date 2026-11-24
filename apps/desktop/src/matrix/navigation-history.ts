import { atom, computed } from 'nanostores'

/**
 * The window's navigation history (layout r2 §1, owner 2026-11-24): every screen and what was open
 * on it, so the title bar's ← → step through places as a browser's do. One history for the window;
 * it lives as long as the window does (a relaunch starts a new one, as a browser's new window does).
 *
 * An entry names a place, never content: a screen, and on it a room id, a Store shelf or a Drive place.
 */
export type MatrixNavScreen = 'chat' | 'work' | 'workplace' | 'discover' | 'drive'

export interface MatrixNavEntry {
  screen: MatrixNavScreen
  /** Chat or Team Space: the open room. */
  roomId?: string
  /** Store: the open shelf. */
  shelf?: string
  /** Drive: the open sidebar place (`recents`, `root` or `folder:<name>`). */
  place?: string
}

export interface MatrixNavHistory {
  entries: MatrixNavEntry[]
  index: number
  /** A step in flight: the window lands on `target` in several renders, which are not new places. */
  travel?: { target: MatrixNavEntry; until: number }
}

/** A browser keeps about this many; older places fall off the back. */
export const MATRIX_NAV_LIMIT = 100
/** How long a step may take to land (a room selection goes through main) before it counts as done. */
export const MATRIX_NAV_TRAVEL_MS = 1500

export function sameMatrixNavEntry(left: MatrixNavEntry | undefined, right: MatrixNavEntry | undefined): boolean {
  return Boolean(
    left &&
      right &&
      left.screen === right.screen &&
      (left.roomId ?? '') === (right.roomId ?? '') &&
      (left.shelf ?? '') === (right.shelf ?? '') &&
      (left.place ?? '') === (right.place ?? '')
  )
}

/** Where the window is now. The same place twice is one entry; a new place drops anything ahead. */
export function recordMatrixNavEntry(state: MatrixNavHistory, entry: MatrixNavEntry, now: number): MatrixNavHistory {
  if (state.travel) {
    if (sameMatrixNavEntry(state.travel.target, entry)) {
      return { entries: state.entries, index: state.index }
    }

    // Still on the way: the places passed through are not history.
    if (now < state.travel.until) {
      return state
    }
  }

  const current = state.entries[state.index]

  if (sameMatrixNavEntry(current, entry)) {
    return state.travel ? { entries: state.entries, index: state.index } : state
  }

  // Only the selection changed on the same screen while it was still settling (Chat landing on its last
  // conversation): the place is refined, not a new step.
  const refines =
    current && current.screen === entry.screen && !current.roomId && !current.shelf && !current.place

  const kept = state.entries.slice(0, refines ? state.index : state.index + 1)
  const entries = [...kept, entry].slice(-MATRIX_NAV_LIMIT)

  return { entries, index: entries.length - 1 }
}

/** One step back (-1) or forward (+1): the target, and the history travelling to it. */
export function stepMatrixNavEntry(
  state: MatrixNavHistory,
  delta: -1 | 1,
  now: number
): { state: MatrixNavHistory; target?: MatrixNavEntry } {
  const index = state.index + delta
  const target = state.entries[index]

  if (!target) {
    return { state }
  }

  return { state: { entries: state.entries, index, travel: { target, until: now + MATRIX_NAV_TRAVEL_MS } }, target }
}

export const $matrixNavHistory = atom<MatrixNavHistory>({ entries: [], index: -1 })

/**
 * A screen's own history inside the window's (Drive's folders): while it can step, ← → step it, and the
 * window's places come after. The screen sets it while it is on screen and clears it when it goes.
 */
export interface MatrixNavLocal {
  back: boolean
  forward: boolean
  step(delta: -1 | 1): void
}

export const $matrixNavLocal = atom<MatrixNavLocal | null>(null)

export function setMatrixNavLocal(local: MatrixNavLocal | null): void {
  $matrixNavLocal.set(local)
}

export const $matrixNavCan = computed([$matrixNavHistory, $matrixNavLocal], (state, local) => ({
  back: Boolean(local?.back) || state.index > 0,
  forward: Boolean(local?.forward) || (state.index >= 0 && state.index < state.entries.length - 1)
}))

export function recordMatrixNav(entry: MatrixNavEntry): void {
  const current = $matrixNavHistory.get()
  const next = recordMatrixNavEntry(current, entry, Date.now())

  if (next !== current) {
    $matrixNavHistory.set(next)
  }
}

/** The window's own way to a place, set by the shell that owns its state. */
let goTo: ((entry: MatrixNavEntry) => void) | null = null

export function setMatrixNavHandler(handler: ((entry: MatrixNavEntry) => void) | null): void {
  goTo = handler
}

export function stepMatrixNav(delta: -1 | 1): void {
  const local = $matrixNavLocal.get()

  if (local && (delta < 0 ? local.back : local.forward)) {
    local.step(delta)

    return
  }

  const { state, target } = stepMatrixNavEntry($matrixNavHistory.get(), delta, Date.now())

  if (target && goTo) {
    $matrixNavHistory.set(state)
    goTo(target)
  }
}

export function resetMatrixNav(): void {
  $matrixNavHistory.set({ entries: [], index: -1 })
}
