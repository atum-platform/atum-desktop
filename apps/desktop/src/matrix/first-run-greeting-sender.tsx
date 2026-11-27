import { useEffect } from 'react'

import { $firstRunPick } from '@/app/connections/first-run-store'

import { sendFirstRunGreetingOnce } from './first-run-greeting'

/** How long the greeting waits for the launch pick before it goes anyway (the assistant then names the model it has). */
export const FIRST_RUN_GREETING_WAIT_MS = 6_000

/**
 * Sends the hidden opening intent once for the first-run room, after the launch pick settled (or `FIRST_RUN_GREETING_WAIT_MS`),
 * so the assistant's welcome names the model it actually starts on. Renders nothing.
 */
export function FirstRunGreetingSender({
  roomId,
  seed,
  send
}: {
  roomId: string
  seed: string
  /** The route the composer uses for this room. */
  send: (body: string) => Promise<unknown>
}) {
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined

    const go = () => {
      clearTimeout(timer)
      unsubscribe?.()

      if (!cancelled) {
        void sendFirstRunGreetingOnce(roomId, seed, send)
      }
    }

    if ($firstRunPick.get() !== undefined) {
      go()
    } else {
      timer = setTimeout(go, FIRST_RUN_GREETING_WAIT_MS)
      unsubscribe = $firstRunPick.listen(pick => {
        if (pick !== undefined) {
          go()
        }
      })
    }

    return () => {
      cancelled = true
      clearTimeout(timer)
      unsubscribe?.()
    }
    // One attempt per room and seed; `send` is a fresh closure every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, seed])

  return null
}
