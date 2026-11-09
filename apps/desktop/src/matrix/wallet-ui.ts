import { useCallback, useEffect, useRef, useState } from 'react'

import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixWalletBridge, MatrixWalletEntry, MatrixWalletHistory } from '../../shared/matrix-wallet'

export const MICRO_PROTONS = 1_000_000

/** Provider values are integer micro-Protons. The UI never rounds spendable value up. */
export function wholeProtons(value: number) {
  return Math.floor(Math.max(0, value) / MICRO_PROTONS)
}

/** Prices keep their micro-Proton precision to the final formatter: no rounding turns one offer into another. */
export function microProtons(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(Math.abs(value) / MICRO_PROTONS)
}

/**
 * An activity amount the way people count it: whole Protons, rounded. A movement under
 * one Proton (a short AI turn) reads "<1", never a misleading 0 or a six-place fraction.
 */
export function activityProtons(value: number, locale: string) {
  const magnitude = Math.abs(value)

  if (magnitude > 0 && magnitude < MICRO_PROTONS / 2) {
    return `<${new Intl.NumberFormat(locale).format(1)}`
  }

  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(magnitude / MICRO_PROTONS))
}

/** A renderer-history cache belongs to this exact native identity and account generation. */
export function matrixWalletScope(snapshot: MatrixSnapshot) {
  const identity = snapshot.identity

  return identity ? `${identity.userId}:${identity.deviceId}:${snapshot.petScope ?? ''}` : null
}

export interface MatrixWalletHistoryView {
  entries: MatrixWalletEntry[]
  error: boolean
  loading: boolean
  next: string | null
}

interface ScopedWalletHistory extends MatrixWalletHistoryView {
  session: string | null
}

const emptyHistory = (session: string | null = null): ScopedWalletHistory => ({
  entries: [],
  error: false,
  loading: false,
  next: null,
  session
})

function validEntry(value: unknown): value is MatrixWalletEntry {
  if (!value || typeof value !== 'object') {
    return false
  }

  const entry = value as Record<string, unknown>

  return (
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    entry.id.length <= 512 &&
    typeof entry.at === 'string' &&
    entry.at.length > 0 &&
    entry.at.length <= 128 &&
    typeof entry.kind === 'string' &&
    entry.kind.length > 0 &&
    entry.kind.length <= 128 &&
    typeof entry.status === 'string' &&
    entry.status.length > 0 &&
    entry.status.length <= 128 &&
    Number.isSafeInteger(entry.amount) &&
    (entry.reference === null || (typeof entry.reference === 'string' && entry.reference.length <= 1024)) &&
    (entry.closedAt === null || (typeof entry.closedAt === 'string' && entry.closedAt.length <= 128))
  )
}

function validHistory(value: unknown): value is MatrixWalletHistory {
  if (!value || typeof value !== 'object') {
    return false
  }

  const history = value as Record<string, unknown>

  return (
    Array.isArray(history.entries) &&
    history.entries.length <= 50 &&
    history.entries.every(validEntry) &&
    (history.next === null ||
      (typeof history.next === 'string' && history.next.length > 0 && history.next.length <= 1024))
  )
}

/**
 * Reads the native, owner-bound wallet history only while its pane is visible.
 * Each scope reset invalidates outstanding responses; a bad/looping cursor is an
 * unavailable history, never an empty successful result.
 */
export function useMatrixWalletHistory(snapshot: MatrixSnapshot, open: boolean, bridge?: MatrixWalletBridge) {
  const scope = matrixWalletScope(snapshot)
  const session = open && scope && bridge ? scope : null
  const view = useRef(emptyHistory())
  const generation = useRef(0)
  const cursors = useRef(new Set<string>())
  const ids = useRef(new Set<string>())
  const request = useRef<Promise<void> | null>(null)
  const [history, setHistory] = useState<ScopedWalletHistory>(emptyHistory)

  const publish = (next: ScopedWalletHistory) => {
    view.current = next
    setHistory(next)
  }

  const page = useCallback(
    async (before: string | null, currentGeneration: number, currentSession: string) => {
      if (!bridge || !session || request.current) {
        return
      }

      const current = view.current
      publish({ ...current, loading: true, error: false })

      const pending = bridge
        .history(before ?? undefined)
        .then(value => {
          if (
            generation.current !== currentGeneration ||
            view.current.session !== currentSession ||
            !validHistory(value)
          ) {
            if (generation.current === currentGeneration && view.current.session === currentSession) {
              publish({ ...view.current, error: true, loading: false, next: null })
            }

            return
          }

          const duplicatePage = value.entries.length > 0 && value.entries.every(entry => ids.current.has(entry.id))
          const repeatedCursor = value.next !== null && (value.next === before || cursors.current.has(value.next))

          if (duplicatePage || repeatedCursor || (value.entries.length === 0 && value.next !== null)) {
            publish({ ...view.current, error: true, loading: false, next: null })

            return
          }

          if (before) {
            cursors.current.add(before)
          }

          const entries = value.entries.filter(entry => {
            if (ids.current.has(entry.id)) {
              return false
            }

            ids.current.add(entry.id)

            return true
          })

          publish({
            entries: [...view.current.entries, ...entries],
            error: false,
            loading: false,
            next: value.next,
            session: currentSession
          })
        })
        .catch(() => {
          if (generation.current === currentGeneration && view.current.session === currentSession) {
            publish({ ...view.current, error: true, loading: false, next: null })
          }
        })
        .finally(() => {
          if (request.current === pending) {
            request.current = null
          }
        })

      request.current = pending
      await pending
    },
    [bridge, session]
  )

  useEffect(() => {
    generation.current += 1
    const currentGeneration = generation.current
    cursors.current = new Set()
    ids.current = new Set()
    request.current = null
    publish(emptyHistory(session))

    if (!session || !bridge) {
      return
    }

    void page(null, currentGeneration, session)

    return () => {
      if (generation.current === currentGeneration) {
        generation.current += 1
        request.current = null
      }
    }
  }, [bridge, page, session])

  const loadMore = useCallback(() => {
    const current = view.current

    if (!current.loading && !current.error && current.next && current.session === session && session) {
      void page(current.next, generation.current, session)
    }
  }, [page, session])

  const visible = view.current.session === session ? history : emptyHistory()

  return { entries: visible.entries, error: visible.error, loading: visible.loading, next: visible.next, loadMore }
}
