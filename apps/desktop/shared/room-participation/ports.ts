import type { ChainEvent, RoomContextInput, RoomContextResult, RoomMember, RoomPolicy } from './types'

export interface RoomContextReader {
  readRecent(input: RoomContextInput): Promise<RoomContextResult>
}

/** Owner SDK adapters supply authoritative facts; none of these methods are model tools. */
export interface RoomPort extends RoomContextReader {
  readMembers(roomId: string): Promise<readonly RoomMember[]>
  readPolicy(roomId: string): Promise<RoomPolicy>
  readSettled(roomId: string, originEventId: string): Promise<readonly string[]>
  readOwnerEvent(roomId: string, eventId: string): Promise<ChainEvent | null>
  publish(roomId: string, content: Readonly<Record<string, unknown>>): Promise<{ eventId: string }>
}
