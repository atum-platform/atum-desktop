import { useEffect } from 'react'

import { shouldSleep } from '../../../shared/pet-engine/behaviour'

export { shouldSleep, SLEEP_AFTER_MS } from '../../../shared/pet-engine/behaviour'

import { $petGestureUntil, $petState, playPetGesture } from '@/store/pet'

/**
 * The `sleep` row's trigger (v4 optional row, plan 2026-09-13 decision 10): a
 * long idle. Not the pet's idle — the person's. No pointer or key for this long
 * while the assistant is at rest, and she settles down and shuts her eyes;
 * the first movement wakes her. A sheet without the row lounges instead (the
 * sprite's stand-in), which is still the honest picture of "nothing has
 * happened here for a while".
 */
// How long one sleep gesture holds; re-issued while the idle continues, so the
// wander (which yields to a gesture in flight) never walks out from under it.
export const SLEEP_HOLD_MS = 60_000
const TICK_MS = 1000
// Re-issue this far before the hold would lapse.
const RENEW_MARGIN_MS = 5000

/** States the pet can be in and still be counted idle for sleeping purposes. */
const RESTING: ReadonlySet<string> = new Set(['idle', 'sleep', 'lounging', 'waiting'])

export function usePetSleep({ enabled }: { enabled: boolean }): void {
  useEffect(() => {
    if (!enabled) {
      return
    }

    let lastActive = performance.now()
    let asleep = false

    const wake = () => {
      lastActive = performance.now()

      if (asleep) {
        asleep = false
        playPetGesture(null, 0)
      }
    }

    // The assistant getting busy is activity too — a working pet does not nap.
    const unsubState = $petState.listen(state => {
      if (!RESTING.has(state)) {
        wake()
      }
    })

    const events: Array<keyof WindowEventMap> = ['pointermove', 'pointerdown', 'keydown', 'wheel']

    for (const name of events) {
      window.addEventListener(name, wake, { passive: true })
    }

    const tick = setInterval(() => {
      const now = performance.now()

      if (!asleep) {
        if (shouldSleep(now - lastActive) && $petState.get() === 'idle') {
          asleep = true
          playPetGesture('sleep', SLEEP_HOLD_MS)
        }

        return
      }

      // Still idle: keep the gesture alive rather than let it lapse to idle
      // and be re-issued a beat later (a blink of wakefulness).
      if (Date.now() > $petGestureUntil.get() - RENEW_MARGIN_MS) {
        playPetGesture('sleep', SLEEP_HOLD_MS)
      }
    }, TICK_MS)

    return () => {
      clearInterval(tick)
      unsubState()

      for (const name of events) {
        window.removeEventListener(name, wake)
      }

      if (asleep) {
        playPetGesture(null, 0)
      }
    }
  }, [enabled])
}
