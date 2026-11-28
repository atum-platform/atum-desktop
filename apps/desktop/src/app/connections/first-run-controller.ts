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
