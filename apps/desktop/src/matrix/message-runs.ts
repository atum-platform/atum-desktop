import type { MatrixMessage, MatrixRoom } from '../../shared/matrix'

import { matrixNewDay } from './message-time'

/** Messages from one sender within this long of each other read as one run. */
export const MESSAGE_RUN_MS = 5 * 60_000

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function matrixRunBreak(
  previous: Pick<MatrixMessage, 'sender' | 'timestamp'> | undefined,
  next: Pick<MatrixMessage, 'id' | 'sender' | 'timestamp'>,
  firstUnreadId?: string
): boolean {
  return (
    !previous ||
    previous.sender !== next.sender ||
    next.timestamp - previous.timestamp > MESSAGE_RUN_MS ||
    matrixNewDay(previous.timestamp, next.timestamp) ||
    next.id === firstUnreadId
  )
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function matrixRoomShowsSenders(room: Pick<MatrixRoom, 'appBot' | 'assistant' | 'direct'>): boolean {
  return !room.assistant && !room.direct && !room.appBot
}
