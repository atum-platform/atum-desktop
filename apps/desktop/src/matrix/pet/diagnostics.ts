import type { MatrixPetDiagnostic } from '../../../shared/matrix-pet-diagnostic'
import type { PetEngineState, PetWorld } from '../../../shared/pet-engine/types'

export type PetDiagnosticLine = Omit<MatrixPetDiagnostic, 'repeats'>
export type PetStartReason = NonNullable<MatrixPetDiagnostic['reason']>

/** A burst of restarts for one reason is one line a minute, with how many there were. */
export const PET_START_LINE_MS = 60_000
/** Pose and surface churn: a work/pose/surface/window combination is written at most once per
 * window; returning to it later counts toward its next line. A change of work signal or window
 * state is never held back (see `state`), so the last line always says what she is doing now. */
export const PET_STATE_LINE_MS = 5 * 60_000
// Lines remembered for windowing; the oldest are forgotten first.
const LIMIT = 200

/**
 * The companion's lifecycle, rate-limited before it ever leaves the window: one line per engine
 * start (why it started, and whether she came back to her resting place) and one per change of
 * what she is doing (work signal, pose, surface and the window around her; the line also says
 * her x tenth). A change of work signal or window state is always written, so leaving `failed`
 * or `hidden` is never lost and a stuck Gigi reads differently from one that recovered; only
 * pose and surface churn is windowed. Every value is a closed code (main validates them again
 * and bounds a flood). Pure apart from `send`, so the windowing is testable.
 */
export function createPetDiagnostics(
  send: (line: MatrixPetDiagnostic) => void,
  now: () => number = () => performance.now()
) {
  const written = new Map<string, { at: number; since: number }>()
  const started = new Set<string>()
  const current = new Map<string, string>()
  // The episode (see `episode`) of the last line actually sent, per principal.
  const lastSent = new Map<string, string>()

  const offer = (principal: string, key: string, windowMs: number, line: PetDiagnosticLine): boolean => {
    const at = now()
    const last = written.get(key)

    if (last && at - last.at < windowMs) {
      last.since += 1

      return false
    }

    // A Map keeps insertion order: re-inserting moves this key last, so the oldest go first.
    written.delete(key)
    written.set(key, { at, since: 0 })

    while (written.size > LIMIT) {
      written.delete(written.keys().next().value!)
    }

    lastSent.set(principal, episode(line))

    try {
      send({ ...line, repeats: last?.since ?? 0 })
    } catch {
      // Diagnostics only: they must never affect the companion.
    }

    return true
  }

  const doing = (line: PetDiagnosticLine) => `${line.work}|${line.pose}|${line.surface}|${line.window}`
  // What a stuck companion would be stuck in: her work signal, the window around her, and
  // whether she has anywhere to stand. Leaving any of these is always written.
  const episode = (line: PetDiagnosticLine) => `${line.work}|${line.window}|${line.surface === 'hidden'}`

  return {
    /** Has a stage for this principal started before in this window's lifetime? */
    seen: (principal: string) => started.has(principal),
    start(principal: string, line: PetDiagnosticLine) {
      started.add(principal)

      if (offer(principal, `${line.agent}|start|${line.reason}`, PET_START_LINE_MS, line)) {
        current.set(principal, doing(line))
      } else {
        // A folded restart wrote nothing: the next state line must still say what she does.
        current.delete(principal)
      }
    },
    /**
     * What she does now; written only when it changed. A new work signal, window state or
     * hidden/shown surface (than the last line sent) is written at once; pose and ledge churn
     * is windowed.
     */
    state(principal: string, line: PetDiagnosticLine) {
      const key = doing(line)

      if (current.get(principal) === key) {
        return
      }

      current.set(principal, key)
      const windowMs = lastSent.get(principal) === episode(line) ? PET_STATE_LINE_MS : 0
      offer(principal, `${line.agent}|state|${key}`, windowMs, line)
    }
  }
}

/** The window's one diagnostics stream; a window without the bridge (a test) writes nowhere. */
export const petStageDiagnostics = createPetDiagnostics(line => window.atumMatrix?.pets?.diagnostic?.(line))

/** Where she stands, as a closed code: perch ids are `<kind>:<n>[:<corridor>]`. */
export function petSurfaceCode(state: Pick<PetEngineState, 'visible' | 'perchId'>): MatrixPetDiagnostic['surface'] {
  if (!state.visible) {
    return 'hidden'
  }

  if (!state.perchId) {
    return 'floor'
  }

  const kind = state.perchId.split(':')[0]

  return kind === 'composer' || kind === 'rail' || kind === 'toolbar' ? kind : 'perch'
}

/** Her left edge across the walkable width, in tenths. */
export function petXBucket(x: number, world: PetWorld | undefined, width: number): number | null {
  if (!world || !Number.isFinite(x)) {
    return null
  }

  const span = world.width - width

  return span > 0 ? Math.min(9, Math.max(0, Math.floor((x / span) * 10))) : 0
}

/** At most the first eight characters of the agent principal, as main.log names agents. */
export function petLogAgent(agent: string): string {
  return agent.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'none'
}
