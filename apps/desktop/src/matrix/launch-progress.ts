import type { MatrixReadinessStep, MatrixSnapshot } from '../../shared/matrix'

/** The five checks the window waits on, in the gate's order (electron/matrix/readiness.ts). */
export const LAUNCH_STEPS: readonly MatrixReadinessStep[] = ['signed_in', 'assistant', 'hermes', 'ai', 'authority']

/**
 * Each step's share of the bar and how long it usually runs, from the candidate's own
 * gate log on the Mac mini (2026-09-28): signing in and the account check take
 * milliseconds, waking the assistant 20–70 s, preparing its workspace 1–4 s, and reaching
 * Atum's AI up to 3 s. The bar follows that reality instead of splitting it evenly.
 */
const SHARE: Record<MatrixReadinessStep, number> = { signed_in: 3, assistant: 62, hermes: 20, ai: 12, authority: 3 }

const USUALLY_MS: Record<MatrixReadinessStep, number> = {
  signed_in: 800,
  assistant: 30_000,
  hermes: 2_500,
  ai: 1_500,
  authority: 800
}

/** A step never looks finished before it is: its share fills to at most this much. */
const STEP_CEILING = 0.9

/**
 * Where the launch stands: the index of the step running (or blocked), or
 * `LAUNCH_STEPS.length` when nothing is left. Builds without the readiness gate fall back
 * to the older setup steps.
 */
export function launchStepIndex(snapshot: MatrixSnapshot): number {
  const readiness = snapshot.readiness

  if (readiness) {
    if (readiness.phase === 'ready' || readiness.phase === 'degraded') {
      return LAUNCH_STEPS.length
    }

    return Math.max(0, LAUNCH_STEPS.indexOf(readiness.step ?? 'signed_in'))
  }

  if (snapshot.state !== 'ready') {
    return 0
  }

  if (!snapshot.startup) {
    return LAUNCH_STEPS.length
  }

  return snapshot.startup.step === 'model' ? LAUNCH_STEPS.indexOf('ai') : LAUNCH_STEPS.indexOf('assistant')
}

/**
 * The bar's percentage for a step that has run `elapsedMs`: the finished steps' shares,
 * plus the running step's share filled along an easing curve that slows but never stops,
 * so a long step still visibly moves. Below 100 until every step has passed.
 */
export function launchPercent(index: number, elapsedMs: number): number {
  if (index >= LAUNCH_STEPS.length) {
    return 100
  }

  const step = LAUNCH_STEPS[index]!
  const before = LAUNCH_STEPS.slice(0, index).reduce((sum, value) => sum + SHARE[value], 0)
  const filled = 1 - Math.exp(-Math.max(0, elapsedMs) / USUALLY_MS[step])

  return Math.min(99, Math.floor(before + SHARE[step] * STEP_CEILING * filled))
}

/** How long the person's own chats usually take to be ready on a cold start (the SDK cache
 * or its first sync, gate step `signed_in`). */
const CHAT_USUALLY_MS = 1_500

/**
 * The launch screen's bar: it waits only for the person's chats now (the assistant keeps
 * getting ready in its own chat, launch-notice.tsx), so it fills toward 90 along the same
 * kind of curve and reads 100 only once the chats are there.
 */
export function launchGatePercent(elapsedMs: number): number {
  return Math.min(99, Math.floor(90 * (1 - Math.exp(-Math.max(0, elapsedMs) / CHAT_USUALLY_MS))))
}
