import type { RecentContext, RoomContextInput, RoomMember } from './types'

/** Main supplies enrolled identity facts; the SDK supplies verified room context. */
export interface GroupRecentTarget extends RoomContextInput {
  ownerId: string
  ownAgentIds: readonly string[]
  /** Routing reads verified room information preceding the triggering event, never agent memory. */
  purpose?: 'routing'
}

export interface GroupRecentRead {
  roomId: string
  viewerAgentId: string
  members: RoomMember[]
  context: RecentContext
}
