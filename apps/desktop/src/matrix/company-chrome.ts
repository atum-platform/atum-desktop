import { atom } from 'nanostores'

import type { MatrixRoom } from '../../shared/matrix'

import {
  matrixAgentCounts,
  matrixRoomCounts,
  type MatrixRosterBadge,
  matrixRosterBadge
} from './roster-preview'

/**
 * Team Space chrome rules that cross the shell and the company workspace. A company channel
 * is the company's room, not a personal chat: the personal menu, pet, awareness line and
 * assistant prompts stay out of it, and its membership is never edited through Matrix.
 */
export function isCompanyRoom(room: Pick<MatrixRoom, 'companyChannel'> | null | undefined): boolean {
  return Boolean(room?.companyChannel)
}

/** The header's Members button asks the open company workspace to show its roster. */
export const $companyOverviewRequest = atom(0)

export function requestCompanyOverview(): void {
  $companyOverviewRequest.set($companyOverviewRequest.get() + 1)
}

/** The sidebar's channel order (ready rooms only), published for the channel shortcuts. */
export const $companyChannelOrder = atom<readonly string[]>([])

/** The company the workspace has selected; the order above is that company's directory. */
export const $companyChannelCompanyId = atom<string | undefined>(undefined)

/**
 * The joined channels ⌘K may offer: only the selected company's, and only those its
 * authoritative directory currently lists (`order`). Another company's channel, or a room
 * the directory no longer lists, is never offered.
 */
export function companyPaletteChannels(
  rooms: readonly MatrixRoom[],
  companyId: string | undefined,
  order: readonly string[]
): MatrixRoom[] {
  if (!companyId) {
    return []
  }

  const listed = new Set(order)

  return rooms.filter(
    room => room.membership === 'join' && room.companyChannel?.companyId === companyId && listed.has(room.id)
  )
}

/** The badge a set of company channels adds up to (a muted channel counts only its mentions). */
export function companyRoomsBadge(rooms: readonly MatrixRoom[], companyId?: string): MatrixRosterBadge {
  const scoped = rooms.filter(room => {
    const bound = room.companyChannel ?? room.companyConversation

    return room.membership === 'join' && bound && (!companyId || bound.companyId === companyId)
  })

  return scoped.length ? matrixRosterBadge(matrixAgentCounts(scoped)) : null
}

/** One channel's badge, by the personal roster's rules. */
export function companyRoomBadge(room: MatrixRoom | undefined): MatrixRosterBadge {
  return room ? matrixRosterBadge(matrixRoomCounts(room)) : null
}

/**
 * The next channel in sidebar order, wrapping. With `unreadOnly` it skips channels with nothing
 * waiting (Slack's Shift+Option+Arrow); the current channel is never its own answer.
 */
export function neighbouringCompanyChannel(
  order: readonly string[],
  rooms: readonly MatrixRoom[],
  current: string | null | undefined,
  direction: 1 | -1,
  unreadOnly = false
): string | undefined {
  const byId = new Map(rooms.filter(room => room.membership === 'join').map(room => [room.id, room]))
  const ids = order.filter(id => byId.has(id))

  if (ids.length === 0) {
    return undefined
  }

  const start = current ? ids.indexOf(current) : -1

  for (let step = 1; step <= ids.length; step += 1) {
    const index = start < 0 ? (direction === 1 ? step - 1 : ids.length - step) : (start + direction * step + ids.length * step) % ids.length
    const id = ids[index]!

    if (id === current) {
      continue
    }

    if (!unreadOnly || companyRoomBadge(byId.get(id)) !== null) {
      return id
    }
  }

  return undefined
}
