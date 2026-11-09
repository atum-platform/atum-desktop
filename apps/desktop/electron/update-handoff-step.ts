/**
 * The restart-to-update progress helper's whole decision logic, as one self-contained function.
 *
 * It runs in two places: here under vitest, and inside the macOS helper window
 * (`osascript -l JavaScript`, see update-handoff.ts), which embeds this function's own source
 * text. It therefore must not reference anything outside its body: no imports, no outer
 * constants, no nested named functions, no object spread (esbuild could inject helpers).
 *
 * Milestones come from Squirrel.Mac's own ShipIt log (Squirrel/ShipIt-main.m and
 * Squirrel/SQRLInstaller.m at Electron's pin fffea30e): "Beginning installation" once the app has
 * quit, "Moving bundle from" at the swap, "Installation completed successfully" after ShipIt's
 * cleanup, "Successfully launched application" at relaunch. The bar is anchored to those real
 * milestones and only eases inside a phase, so it can never run ahead of what ShipIt has done.
 */

export interface UpdateHelperState {
  appGoneAt: number | null
  began: number | null
  swapped: number | null
  installed: number | null
  launched: number | null
  failedAt: number | null
  openedAt: number | null
  lastOpenAttempt: number | null
  /** The staged swap finished its renames. Its launcher owns reopening the app, not this window. */
  staged: number | null
}

export interface UpdateHelperFacts {
  now: number
  startedAt: number
  /** The old Atum process is still alive. */
  appRunning: boolean
  /** The new Atum window is on screen (written by the next launch). */
  shown: boolean
  /** The quit was refused; nothing will install now. */
  cancelled: boolean
  /** The old process reported that its install handoff failed. */
  failed: boolean
  /** ShipIt log text appended since the previous step. */
  log: string
}

export interface UpdateHelperStep {
  state: UpdateHelperState
  view: { phase: 'updating' | 'slow' | 'failed'; progress: number | null; elapsed: number }
  /** Open the app bundle (whatever version is installed there). */
  open: boolean
  exit: boolean
}

export const UPDATE_HELPER_INITIAL_STATE: UpdateHelperState = {
  appGoneAt: null,
  began: null,
  swapped: null,
  installed: null,
  launched: null,
  failedAt: null,
  openedAt: null,
  lastOpenAttempt: null,
  staged: null
}

export function atumUpdateHelperStep(previous: UpdateHelperState, facts: UpdateHelperFacts): UpdateHelperStep {
  const state = Object.assign({}, previous)
  const now = facts.now
  const log = typeof facts.log === 'string' ? facts.log : ''
  const elapsed = Math.max(0, now - facts.startedAt)

  if (state.began === null && /Beginning installation|Resuming installation attempt|stage state=swap/.test(log)) {state.began = now}

  if (state.swapped === null && /Moving bundle from|stage state=relaunch/.test(log)) {state.swapped = now}

  if (state.installed === null && /Installation completed successfully|stage state=relaunch/.test(log)) {state.installed = now}

  if (state.staged === null && /stage state=relaunch/.test(log)) {state.staged = now}

  if (state.launched === null && /Successfully launched application|Application launched at/.test(log)) {state.launched = now}

  if (!facts.appRunning && state.appGoneAt === null) {state.appGoneAt = now}

  if (
    state.failedAt === null &&
    (facts.failed || /Installation error|Installation cancelled|Too many attempts to install|Error aborting installation/.test(log))
  ) {
    state.failedAt = now
  }

  // ShipIt never started after the app quit, or the whole swap is far past any measured run.
  if (state.failedAt === null && state.installed === null) {
    if (state.appGoneAt !== null && state.began === null && now - state.appGoneAt > 90_000) {state.failedAt = now}

    if (elapsed > 15 * 60_000) {state.failedAt = now}
  }

  const failed = state.failedAt !== null
  const openSpaced = state.lastOpenAttempt === null || now - state.lastOpenAttempt >= 3_000

  // Failure: bring back whatever version is installed (ShipIt restores the old bundle on error).
  // Success without ShipIt's own relaunch: open the new version ourselves. A staged swap has its own launcher,
  // which also handles the new version dying: a second reopen from here would race its recovery (re-review F4).
  const wantsOpen =
    (failed && !facts.appRunning) ||
    (!failed && state.staged === null && state.installed !== null && state.launched === null && now - state.installed > 30_000)

  const open = wantsOpen && state.openedAt === null && openSpaced

  const exit =
    facts.cancelled ||
    facts.shown ||
    (state.appGoneAt === null && elapsed > 3 * 60_000) ||
    (state.launched !== null && now - state.launched > 90_000) ||
    (state.openedAt !== null && now - state.openedAt > 90_000) ||
    elapsed > 20 * 60_000

  let progress: number | null = null

  if (facts.shown) {
    progress = 1
  } else if (!failed) {
    // [milestone start, its share of the bar, phase end share, expected phase length in ms]
    // Expected lengths are the 2026-11-04 0.20.38 restart measured from ShipIt's log.
    let from = 0
    let to = 0.06
    let since = facts.startedAt
    let expected = 10_000

    if (state.launched !== null) {
      from = 0.97; to = 1; since = state.launched; expected = 8_000
    } else if (state.installed !== null) {
      from = 0.9; to = 0.97; since = state.installed; expected = 12_000
    } else if (state.swapped !== null) {
      from = 0.55; to = 0.9; since = state.swapped; expected = 75_000
    } else if (state.began !== null || state.appGoneAt !== null) {
      from = 0.06; to = 0.55; since = state.began ?? state.appGoneAt ?? now; expected = 100_000
    }

    // Eases toward the phase's end without reaching it until ShipIt says the phase is over.
    progress = from + (to - from) * 0.95 * (1 - Math.exp(-Math.max(0, now - since) / expected))
  }

  return {
    state,
    view: { phase: failed ? 'failed' : elapsed > 6 * 60_000 ? 'slow' : 'updating', progress, elapsed },
    open,
    exit
  }
}
