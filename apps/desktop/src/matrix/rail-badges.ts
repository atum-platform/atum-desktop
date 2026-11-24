import { useEffect, useState } from 'react'

import type { MatrixRoom } from '../../shared/matrix'
import type { MatrixDriveBridge, MatrixDriveView } from '../../shared/matrix-drive'
import type { MatrixStoreSnapshot } from '../../shared/matrix-store'
import type { MatrixWorkBridge, WorkAttentionSnapshot } from '../../shared/matrix-work'

import { matrixRoomCounts, matrixRosterBadge } from './roster-preview'

/**
 * A rail destination's badge (layout r2 G, owner 2026-11-24; it replaces the title bar's bell):
 * `waiting` is a red count of conversations waiting for the person, `new` an ink dot for something
 * new that doesn't need them, `problem` a red dot for a problem only they can fix (Drive only).
 */
export type MatrixRailBadge =
  | { kind: 'waiting'; count: number; label: string }
  | { kind: 'new'; label: string }
  | { kind: 'problem'; label: string }

export interface MatrixRailBadgeLabels {
  waiting: string
  new: string
}

/**
 * Chat's badge: the personal chats (not Team Space's) that wait for the person, one per conversation
 * (a mention or a notifying unread, as the roster row shows it), plus each assistant that asks for
 * them; else an ink dot for any quieter unread. The rail and the row that caused it always agree.
 */
export function matrixChatRailBadge(
  rooms: readonly MatrixRoom[],
  assistantAsks: number,
  labels: MatrixRailBadgeLabels
): MatrixRailBadge | undefined {
  let waiting = Math.max(0, assistantAsks)
  let quiet = false

  for (const room of rooms) {
    if (room.membership !== 'join' || room.companyChannel || room.companyConversation) {
      continue
    }

    const badge = matrixRosterBadge(matrixRoomCounts(room))

    if (badge?.kind === 'mention' || badge?.kind === 'count') {
      waiting += 1
    } else if (badge) {
      quiet = true
    }
  }

  return waiting > 0
    ? { kind: 'waiting', count: waiting, label: labels.waiting }
    : quiet
      ? { kind: 'new', label: labels.new }
      : undefined
}

/** Drive's badge: a red dot while Drive has a problem only the person can fix (a stopped sync, conflicts). */
export function matrixDriveRailBadge(view: MatrixDriveView | null, label: string): MatrixRailBadge | undefined {
  if (!view) {
    return undefined
  }

  const stopped =
    view.state === 'error' ||
    view.state === 'reauthenticate' ||
    view.state === 'cleanup_failed' ||
    (view.state === 'disconnected' && Boolean(view.problem))

  const issue = view.issues?.some(each => each.code === 'conflicts' || each.code === 'errors' || each.code === 'signed_out')

  return stopped || issue ? { kind: 'problem', label } : undefined
}

/**
 * The Drive view for the rail: what Drive publishes (its launch connect, its sync), never a read of
 * its own. `read()` activates Drive and lists the folder, which the rail has no business starting.
 */
export function useMatrixDriveRailView(bridge: MatrixDriveBridge | undefined): MatrixDriveView | null {
  const [view, setView] = useState<MatrixDriveView | null>(null)

  useEffect(() => {
    if (!bridge) {
      setView(null)

      return
    }

    let alive = true

    const accept = (next: MatrixDriveView) => {
      if (alive) {
        setView(previous => (!previous || next.revision >= previous.revision ? next : previous))
      }
    }

    const unsubscribe = bridge.subscribe(accept)

    return () => {
      alive = false
      unsubscribe()
    }
  }, [bridge])

  return view
}

/**
 * Work's badge: a red count of the view's threads that ask for the person (an approval, an answer),
 * else an ink dot while a thread finished that they haven't looked at. The view says both (T3's own
 * thread states); nothing is read from Work for it.
 */
export function matrixWorkRailBadge(
  attention: WorkAttentionSnapshot | null,
  labels: MatrixRailBadgeLabels
): MatrixRailBadge | undefined {
  if (!attention) {
    return undefined
  }

  return attention.waiting > 0
    ? { kind: 'waiting', count: attention.waiting, label: labels.waiting }
    : attention.finished > 0
      ? { kind: 'new', label: labels.new }
      : undefined
}

/** What the Work view last reported about its threads; null while Work isn't running. */
export function useMatrixWorkAttention(bridge: MatrixWorkBridge | undefined): WorkAttentionSnapshot | null {
  const [attention, setAttention] = useState<WorkAttentionSnapshot | null>(null)

  useEffect(() => {
    if (!bridge?.onAttentionChanged) {
      setAttention(null)

      return
    }

    let alive = true
    const unsubscribe = bridge.onAttentionChanged(next => alive && setAttention(next))

    void bridge
      .getAttention?.()
      .then(next => alive && setAttention(current => current ?? next))
      .catch(() => {})

    return () => {
      alive = false
      unsubscribe()
    }
  }, [bridge])

  return attention
}

/**
 * The Store's badge: an ink dot while something the person got (a purchase, a gift) arrived after
 * they last opened the Store. Never a count, never the balance.
 */
export function matrixStoreRailBadge(
  store: MatrixStoreSnapshot | undefined,
  seenAt: number | null,
  label: string
): MatrixRailBadge | undefined {
  if (!store || seenAt === null) {
    return undefined
  }

  const arrived = store.entitlements.some(row => row.state === 'active' && Date.parse(row.grantedAt) > seenAt)

  return arrived ? { kind: 'new', label } : undefined
}

const STORE_SEEN_KEY = 'io.atum.store.seenAt'

function readSeen(account: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(`${STORE_SEEN_KEY}:${account}`))

    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function writeSeen(account: string, at: number) {
  try {
    window.localStorage.setItem(`${STORE_SEEN_KEY}:${account}`, String(at))
  } catch {
    // Storage off: the dot clears for this window only.
  }
}

/**
 * When this account last had the Store open on this Mac. The first time there is no record it starts
 * now, so what was already there is never "new". Opening the Store marks everything seen.
 */
export function useMatrixStoreSeen(account: string, storeOpen: boolean): number | null {
  const [seen, setSeen] = useState<{ account: string; at: number | null }>(() => ({ account, at: readSeen(account) }))
  const at = seen.account === account ? seen.at : readSeen(account)

  // Once per opening (and once for an account with no record): never on each render, or `now` would loop.
  useEffect(() => {
    if (!account || (!storeOpen && readSeen(account) !== null)) {
      return
    }

    const now = Date.now()
    writeSeen(account, now)
    setSeen({ account, at: now })
  }, [account, storeOpen])

  return at
}
