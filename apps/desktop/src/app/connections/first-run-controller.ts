import { atom } from 'nanostores'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The first run's one sequencer on the desktop (docs/plans/2026-11-28-unified-first-run-and-48h.md, storyboard
 * docs/mockups/new-user-flow/). It decides what the first chat shows, in order, and holds everything else back:
 *
 * 1. The assistant's own welcome. While it is being written: a typing bubble. With no answer after
 *    `FIRST_RUN_GREETING_RETRY_MS` the welcome request goes once more ("retrying"); with still no answer, one quiet line and
 *    Try again ("quiet"). No ready-made greeting ever stands in (owner rule: agents speak for themselves).
 * 2. The one Connections list, once the welcome is there or the quiet state shows, so nobody is stuck behind a silent agent.
 * 3. Other first-chat notices (the Mac sources notice) wait until the list is answered.
 *
 * The 48 hours themselves are sequenced by native Hermes cron on the agent; the welcome request is the handoff.
 */

/** How long the first chat waits for the welcome before it asks once more, and again before it goes quiet. */
export const FIRST_RUN_GREETING_RETRY_MS = 20_000

export type FirstRunGreetingPhase = 'pending' | 'retrying' | 'quiet'
export type FirstRunGreetingView = FirstRunGreetingPhase | 'generated'

export interface FirstRunStage {
  greeting: FirstRunGreetingView
  /** The Connections list shows under the welcome. */
  connections: boolean
}

/** Pure: what the first chat shows for the welcome and whether the Connections list follows it. */
export function firstRunStage(input: { greeting: boolean; phase: FirstRunGreetingPhase }): FirstRunStage {
  const greeting: FirstRunGreetingView = input.greeting ? 'generated' : input.phase

  return { greeting, connections: greeting === 'generated' || greeting === 'quiet' }
}

/**
 * The welcome's waiting phase. `waiting` is true while the request is out and no welcome has arrived. After the delay it
 * resends once (`retrying`), then goes `quiet`; Try again resends and waits once more. A welcome that arrives at any point wins.
 */
export function useFirstRunGreetingPhase({
  delayMs = FIRST_RUN_GREETING_RETRY_MS,
  resend,
  waiting
}: {
  delayMs?: number
  resend?: () => Promise<unknown>
  waiting: boolean
}): { phase: FirstRunGreetingPhase; tryAgain(): void } {
  const [phase, setPhase] = useState<FirstRunGreetingPhase>('pending')
  const resendRef = useRef(resend)

  resendRef.current = resend

  useEffect(() => {
    if (!waiting || phase === 'quiet') {
      return
    }

    const timer = setTimeout(() => {
      if (phase === 'pending' && resendRef.current) {
        setPhase('retrying')
        void resendRef.current().catch(() => undefined)
      } else {
        setPhase('quiet')
      }
    }, delayMs)

    return () => clearTimeout(timer)
  }, [delayMs, phase, waiting])

  const tryAgain = useCallback(() => {
    setPhase('retrying')
    void resendRef.current?.().catch(() => undefined)
  }, [])

  return { phase, tryAgain }
}

/** True while a first-run Connections list is on screen with rows still unanswered. */
export const $firstRunListOpen = atom(false)

/** Pure: the first chat's other notices wait for the welcome and for the Connections list to be answered. */
export function firstRunHoldsNotices(input: { firstRunHere: boolean; listOpen: boolean }): boolean {
  return input.firstRunHere || input.listOpen
}

/*
 * The conversational ask (owner 2026-11-28; storyboard frames 08a–08i). Atum first connects everything that needs no action from
 * the person (the AI plans already signed in on this Mac, and every source macOS lets it read without a prompt). The assistant's
 * own welcome then names what it found and asks for the rest; under it the window draws one action row: Sure, a quiet Not now,
 * and Choose what to connect (the full list). Sure runs the remaining steps one after another, each as the native macOS prompt
 * only, and offers Google's browser sign-in last as one tap. Nothing blocks the chat: a denied or skipped step settles quietly.
 *
 * The state lives here, not in the list, because the list moves while it runs: the first connected source admits first learning,
 * which closes the welcome card, and the same list then sits under the welcome message instead.
 */

/** The steps Sure runs, in order. Google's sign-in needs the person's own click, so it is offered last as a single tap. */
export const FIRST_RUN_SURE_ORDER = ['folders', 'messages', 'mac-reach'] as const

export type FirstRunSureStep = (typeof FIRST_RUN_SURE_ORDER)[number] | 'google'

/**
 * - `ask`: Sure / Not now / Choose what to connect.
 * - `running`: one progress line where the row was (`step` now, `next` after it).
 * - `google`: the last, manual step as one tap.
 * - `done`: one summary line. `later`: Not now; only the way back to the list stays.
 */
export type FirstRunAskPhase = 'ask' | 'running' | 'google' | 'done' | 'later'

export interface FirstRunAskState {
  phase: FirstRunAskPhase
  step?: FirstRunSureStep
  next?: FirstRunSureStep
  /** The steps Sure ran (for the summary line). */
  ran: FirstRunSureStep[]
  /** Choose what to connect opened the full list. */
  choosing: boolean
  /** The automatic pass already ran in this window. */
  autoRan: boolean
}

const ASK_START: FirstRunAskState = { phase: 'ask', ran: [], choosing: false, autoRan: false }

export const $firstRunAsk = atom<FirstRunAskState>(ASK_START)

/** What the mounted list can do for the ask. The list registers one while it is on screen. */
export interface FirstRunAskRunner {
  /** The steps still waiting on the person, in any order (rows on Connect that Sure may run). */
  pending(): readonly FirstRunSureStep[]
  /** Runs one step and settles when the person has answered it (granted, denied, skipped or left). Never rejects on a no. */
  run(step: FirstRunSureStep): Promise<void>
  /** Admits first learning on whatever is connected (a no-op when nothing is, or when it already started). */
  admitLearning(): Promise<void>
  /** Not now: open rows read Skipped; learning starts on what is connected, or is declined when nothing is. */
  notNow(): Promise<void>
}

const $runner = atom<FirstRunAskRunner | null>(null)

/** The list's runner while it is mounted. Returns the cleanup. */
export function registerFirstRunAskRunner(runner: FirstRunAskRunner): () => void {
  $runner.set(runner)

  return () => {
    if ($runner.get() === runner) {
      $runner.set(null)
    }
  }
}

/** How long Sure waits for the list to come back after it moved (the welcome card closing), before it settles. */
export const FIRST_RUN_RUNNER_WAIT_MS = 5_000

function currentRunner(waitMs: number): Promise<FirstRunAskRunner | null> {
  const now = $runner.get()

  if (now) {
    return Promise.resolve(now)
  }

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      stop()
      resolve(null)
    }, waitMs)

    const stop = $runner.listen(next => {
      if (next) {
        clearTimeout(timer)
        stop()
        resolve(next)
      }
    })
  })
}

/** Ends a run in `phase`, dropping the progress line's steps. */
function settleAsk(phase: FirstRunAskPhase): void {
  const { autoRan, choosing, ran } = $firstRunAsk.get()

  $firstRunAsk.set({ phase, ran, choosing, autoRan })
}

/** Pure: the step after `from` that is still pending (Google last), for the progress line. */
export function firstRunNextStep(from: number, pending: readonly FirstRunSureStep[]): FirstRunSureStep | undefined {
  return FIRST_RUN_SURE_ORDER.slice(from + 1).find(step => pending.includes(step)) ?? (pending.includes('google') ? 'google' : undefined)
}

/**
 * Sure: every pending step in order, each settling before the next starts, then Google as one tap (or done). A step the person
 * denies, skips or leaves settles quietly and the next one runs.
 */
export async function runFirstRunSure(waitMs = FIRST_RUN_RUNNER_WAIT_MS): Promise<void> {
  if ($firstRunAsk.get().phase !== 'ask') {
    return
  }

  $firstRunAsk.set({ ...$firstRunAsk.get(), phase: 'running', choosing: false })

  for (const [index, step] of FIRST_RUN_SURE_ORDER.entries()) {
    const runner = await currentRunner(waitMs)

    if (!runner) {
      break
    }

    const pending = runner.pending()

    if (!pending.includes(step)) {
      continue
    }

    const state = $firstRunAsk.get()
    $firstRunAsk.set({ ...state, step, next: firstRunNextStep(index, pending), ran: [...state.ran, step] })
    await runner.run(step).catch(() => undefined)
  }

  const runner = await currentRunner(waitMs)
  // Everything may have connected automatically: Sure is then the yes for learning on it.
  await runner?.admitLearning().catch(() => undefined)

  settleAsk(runner?.pending().includes('google') ? 'google' : 'done')
}

/** The one tap for Google's browser sign-in, last. */
export async function runFirstRunGoogle(waitMs = FIRST_RUN_RUNNER_WAIT_MS): Promise<void> {
  if ($firstRunAsk.get().phase !== 'google') {
    return
  }

  const { autoRan, choosing, ran } = $firstRunAsk.get()
  $firstRunAsk.set({ phase: 'running', step: 'google', ran: [...ran, 'google'], choosing, autoRan })

  const runner = await currentRunner(waitMs)
  await runner?.run('google').catch(() => undefined)
  settleAsk('done')
}

/** Not now, from the ask or from the Google tap. Nothing else is asked; the way back stays one tap away. */
export async function firstRunNotNow(waitMs = FIRST_RUN_RUNNER_WAIT_MS): Promise<void> {
  const { phase } = $firstRunAsk.get()

  if (phase === 'google') {
    $firstRunAsk.set({ ...$firstRunAsk.get(), phase: 'done' })

    return
  }

  if (phase !== 'ask') {
    return
  }

  $firstRunAsk.set({ ...$firstRunAsk.get(), phase: 'later', choosing: false })
  const runner = await currentRunner(waitMs)
  await runner?.notNow().catch(() => undefined)
}

/** Choose what to connect: the full list, row by row, in place of the ask row. */
export function firstRunChoose(): void {
  $firstRunAsk.set({ ...$firstRunAsk.get(), choosing: true })
}

/** The automatic pass runs once per window, wherever the list first mounts (the panel, the card or the chat). */
export function claimFirstRunAutoPass(): boolean {
  if ($firstRunAsk.get().autoRan) {
    return false
  }

  $firstRunAsk.set({ ...$firstRunAsk.get(), autoRan: true })

  return true
}

/** Pure: the ask holds other first-chat notices until it is answered. */
export function firstRunAskOpen(state: FirstRunAskState): boolean {
  return !state.choosing && (state.phase === 'ask' || state.phase === 'running' || state.phase === 'google')
}

export function resetFirstRunAskForTests(): void {
  $firstRunAsk.set(ASK_START)
  $runner.set(null)
}
