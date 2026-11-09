import type { MatrixRoom } from '../../shared/matrix'

import type { MatrixRosterCopy } from './roster-copy'

/**
 * The chat list's row semantics, adopted from Element's room list (launch night). Pure:
 * the rows render these answers, the tests pin them.
 */

/** What a row's badge says, strongest first: a mention, a count, then a quiet dot. */
export type MatrixRosterBadge =
  | { kind: 'mention'; count: number }
  | { kind: 'count'; count: number }
  | { kind: 'dot'; tone: 'marked' | 'activity' }
  | null

export interface MatrixRosterCounts {
  /** The server's notification count. */
  notifications: number
  /** Of those, mentions and keywords. */
  highlights: number
  /** Messages from others not read yet, notified or not. */
  activity: boolean
  /** Marked unread by its owner. */
  marked: boolean
  /** Muted: only mentions count; everything else is quiet activity. */
  muted: boolean
}

export function matrixRoomCounts(room: MatrixRoom): MatrixRosterCounts {
  return {
    notifications: Math.max(0, room.unreadNotifications ?? 0),
    highlights: Math.max(0, room.highlights ?? 0),
    activity: Boolean(room.unread),
    marked: Boolean(room.markedUnread),
    muted: Boolean(room.muted)
  }
}

/** An assistant's row sums its chats: one badge for all of them (never muted as a whole). */
export function matrixAgentCounts(rooms: readonly MatrixRoom[]): MatrixRosterCounts {
  return rooms.map(matrixRoomCounts).reduce<MatrixRosterCounts>(
    (total, room) => {
      // A muted chat's ordinary messages are quiet activity on its assistant's row too.
      const counted = room.muted ? room.highlights : room.notifications

      return {
        notifications: total.notifications + counted,
        highlights: total.highlights + room.highlights,
        activity: total.activity || room.activity || (room.muted && room.notifications > 0),
        marked: total.marked || room.marked,
        muted: false
      }
    },
    { notifications: 0, highlights: 0, activity: false, marked: false, muted: false }
  )
}

/**
 * Element's rules: a mention is the strong badge (with the whole count), notifications are a
 * count, a chat you marked unread is a dot, and messages that did not notify (a muted chat)
 * are a quieter dot. A muted chat counts only its mentions.
 */
export function matrixRosterBadge(counts: MatrixRosterCounts): MatrixRosterBadge {
  const notifications = counts.muted ? counts.highlights : counts.notifications

  if (counts.highlights > 0) {
    return { kind: 'mention', count: Math.max(notifications, counts.highlights) }
  }

  if (notifications > 0) {
    return { kind: 'count', count: notifications }
  }

  if (counts.marked) {
    return { kind: 'dot', tone: 'marked' }
  }

  return counts.activity || counts.notifications > 0 ? { kind: 'dot', tone: 'activity' } : null
}

/** A count as a badge prints it. */
export function matrixRosterBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

/** Waiting for the person: a count, a mention, a mark or quiet activity. */
export function matrixRoomHasUnread(room: MatrixRoom): boolean {
  return matrixRosterBadge(matrixRoomCounts(room)) !== null
}

/**
 * An assistant's one conversation, which its roster row and the palette open: its marked main
 * room; on an account with no marks yet, its chat holding unread messages, else its newest.
 * Rooms are newest first.
 */
export function matrixAgentConversationRoom<T extends MatrixRoom>(
  rooms: readonly T[],
  main: string | undefined
): T | undefined {
  return main ? (rooms.find(room => room.id === main) ?? rooms[0]) : (rooms.find(matrixRoomHasUnread) ?? rooms[0])
}

/**
 * What a row's second line says about the latest message: your own with "You:", someone
 * else's in a group with their name, a file by its name, media by what it is. A chat with
 * one person, or with your assistant, needs no name for the other side.
 */
export function matrixRosterPreview(room: MatrixRoom, copy: MatrixRosterCopy, deleted: string): string | undefined {
  const preview = room.preview

  if (!preview) {
    return undefined
  }

  const said = {
    text: preview.text ?? '',
    file: preview.text ? copy.fileNamed(preview.text) : copy.file,
    image: copy.photo,
    video: copy.video,
    audio: copy.audio,
    sticker: copy.sticker,
    deleted,
    unreadable: copy.waiting
  }[preview.kind]

  if (!said) {
    return undefined
  }

  // What happened to a message, not what anyone said: no name before it.
  if (preview.kind === 'deleted' || preview.kind === 'unreadable') {
    return said
  }

  if (preview.own) {
    return copy.byline(copy.you, said)
  }

  const group = !room.direct && !room.assistant

  return group && preview.sender ? copy.byline(preview.sender, said) : said
}
