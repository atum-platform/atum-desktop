import { createHash } from 'node:crypto'

/**
 * The progress line's original transaction (agent-turns/1.3): stable across ambiguous publication
 * retries, distinct per invocation and never a status line's (`atum-cn-` / `atum-sn-`). Hosts only
 * (Node); the SDK accepts exactly this shape (`src/matrix/notice-edit.ts`).
 */
export function matrixProgressNoticeTransaction(
  agentId: string,
  invocationId: string,
  roomId: string,
  eventId: string,
  generation = 0
): string {
  // Generation 0 is the turn's first line; a line removed mid-turn (a wait that ended with nothing to
  // return to) and shown again is a new original under the next generation (agent-turns/1.4).
  const parts = ['progress', agentId, invocationId, roomId, eventId, ...(generation ? [generation] : [])]

  return `atum-cp-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`
}

/**
 * An interim remark's transaction (agent-turns/1.4): stable across ambiguous publication retries,
 * distinct per remark of the turn. Hosts only (Node); the SDK accepts exactly this shape.
 */
export function matrixInterimTransaction(
  agentId: string,
  invocationId: string,
  roomId: string,
  eventId: string,
  sequence: number
): string {
  return `atum-ci-${createHash('sha256').update(JSON.stringify(['interim', agentId, invocationId, roomId, eventId, sequence])).digest('hex')}`
}
