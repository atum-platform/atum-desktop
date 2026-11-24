import { useEffect, useState } from 'react'

import type { MatrixRoom } from '../../shared/matrix'
import type { MatrixDriveBridge, MatrixDriveView } from '../../shared/matrix-drive'

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
