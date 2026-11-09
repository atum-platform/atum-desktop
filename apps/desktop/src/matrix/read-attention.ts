import { useEffect, useRef, useState } from 'react'

/** A refused answer is said again a few times (the SDK may be restarting), then waits for the next change. */
export const ATTEND_RETRY_MS = [1_000, 4_000, 15_000] as const

/** This window is in front of the person: focused and not hidden or minimised. */
function windowInFront(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** Follows window focus and visibility; a webview inside the window keeps it in front. */
export function useWindowInFront(): boolean {
  const [inFront, setInFront] = useState(windowInFront)

  useEffect(() => {
    const update = () => setInFront(windowInFront())

    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    update()

    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  return inFront
}

/**
 * Tells the SDK which conversation the person is reading: the selected room while its
 * transcript is on screen in a focused window, otherwise none. The SDK acknowledges the
 * newest event of an attended room with a private receipt (read-receipts.ts), which is
 * what clears its unread badge on every device. Only changes cross the bridge; a new
 * connection (`connected` turning true) hears the current answer again.
 */
export function useMatrixReadAttention(input: { roomId: string | null; onScreen: boolean; connected: boolean }) {
  const inFront = useWindowInFront()
  const attended = input.roomId && input.onScreen && inFront ? input.roomId : null
  // What the SDK last accepted; undefined when unknown (a new connection, a refusal).
  const told = useRef<string | null | undefined>(undefined)
  const refused = useRef<{ roomId: string | null; count: number }>({ roomId: null, count: 0 })
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!input.connected) {
      told.current = undefined

      return
    }

    if (attended === told.current) {
      return
    }

    told.current = attended
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined

    void Promise.resolve()
      .then(() => window.atumMatrix.attend?.(attended))
      .then(
        () => {
          if (refused.current.roomId === attended) {
            refused.current = { roomId: null, count: 0 }
          }
        },
        () => {
          if (told.current !== attended) {
            return
          }

          told.current = undefined
          const count = refused.current.roomId === attended ? refused.current.count : 0
          refused.current = { roomId: attended, count: count + 1 }
          const delay = ATTEND_RETRY_MS[count]

          if (live && delay !== undefined) {
            timer = setTimeout(() => setRetry(value => value + 1), delay)
          }
        }
      )

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [attended, input.connected, retry])

  return attended
}
