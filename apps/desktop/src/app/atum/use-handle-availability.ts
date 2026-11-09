import { useEffect, useState } from 'react'

import { isValidHandle, normalizeHandleInput } from '@/lib/atum-handle'
import { atumMessagingClient } from '@/lib/atum-messaging-client'

export type HandleAvailabilityState =
  | 'idle'
  | 'invalid'
  | 'current'
  | 'checking'
  | 'available'
  | 'taken'
  | 'reserved'
  | 'cooldown'
  | 'failed'

/** Terminal states of a save attempt, mapped from the plane's error code. */
export function handleSaveFailure(error: unknown): Extract<HandleAvailabilityState, 'taken' | 'reserved' | 'cooldown' | 'invalid' | 'failed'> {
  const code = error instanceof Error ? error.message : ''

  return code.includes('cooldown')
    ? 'cooldown'
    : code.includes('reserved')
      ? 'reserved'
      : code.includes('taken')
        ? 'taken'
        : code.includes('invalid')
          ? 'invalid'
          : 'failed'
}

/**
 * Live availability for a username the person is typing. Debounced so a
 * keystroke never becomes a request; `current` short-circuits the plane,
 * which would otherwise report your own name as taken.
 */
export function useHandleAvailability(
  raw: string,
  options: { enabled: boolean; currentHandle: string | null }
): { state: HandleAvailabilityState; value: string } {
  const value = normalizeHandleInput(raw)
  const [state, setState] = useState<HandleAvailabilityState>('idle')

  useEffect(() => {
    if (!options.enabled) {
      setState('idle')

      return
    }

    if (!value) {
      setState('idle')

      return
    }

    if (value === options.currentHandle) {
      setState('current')

      return
    }

    if (!isValidHandle(value)) {
      setState('invalid')

      return
    }

    setState('checking')
    let active = true

    const timer = window.setTimeout(() => {
      let client: ReturnType<typeof atumMessagingClient>

      try {
        client = atumMessagingClient()
      } catch {
        setState('failed')

        return
      }

      void client
        .handleAvailability(value)
        .then(result => {
          if (!active) {
            return
          }

          setState(
            result.available
              ? 'available'
              : result.reason === 'reserved'
                ? 'reserved'
                : result.reason === 'cooldown'
                  ? 'cooldown'
                  : result.reason === 'invalid'
                    ? 'invalid'
                    : 'taken'
          )
        })
        .catch(() => {
          if (active) {
            setState('failed')
          }
        })
    }, 300)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [options.currentHandle, options.enabled, value])

  return { state, value }
}
