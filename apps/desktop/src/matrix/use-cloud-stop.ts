import { useEffect, useRef, useState } from 'react'

import type { MatrixStopResult } from './cloud-stop'

/** How long an unconfirmed Stop keeps saying "Stopping…" before it settles without a word. */
export const MATRIX_STOP_SETTLE_MS = 15_000

/**
 * One owner Stop for the composer. A Stop the agent has not confirmed keeps saying "Stopping…"
 * until the turn's final clears its target or a short while passes; it never claims stopped.
 */
export function useMatrixCloudStop({ roomId, stopKey }: { roomId: string; stopKey: string | undefined }) {
  const [sending, setSending] = useState(false)
  const [refused, setRefused] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null)
  // A stop that was already asked for stays disabled until its target clears or moves on: the
  // snapshot clears it, not the request resolving.
  const requested = useRef<string | null>(null)

  useEffect(() => {
    setRefused(false)
    setSending(false)
    setUnconfirmed(null)
  }, [roomId])

  useEffect(() => {
    if (!unconfirmed) {
      return
    }

    const settle = window.setTimeout(() => setUnconfirmed(null), MATRIX_STOP_SETTLE_MS)

    return () => window.clearTimeout(settle)
  }, [unconfirmed])

  const stop = (run: () => Promise<MatrixStopResult>) => {
    if (!stopKey || requested.current === stopKey) {
      return
    }

    const key = stopKey
    requested.current = key
    setRefused(false)
    setUnconfirmed(null)
    setSending(true)
    void run()
      .then(result => {
        if (result === 'sent') {
          requested.current = null
        } else if (result === 'stopping') {
          setUnconfirmed(key)
        }
      })
      .catch(() => {
        requested.current = null
        setRefused(true)
      })
      .finally(() => setSending(false))
  }

  return {
    stopping: sending || (unconfirmed !== null && unconfirmed === stopKey),
    refused,
    requested: Boolean(stopKey) && requested.current === stopKey,
    stop
  }
}
