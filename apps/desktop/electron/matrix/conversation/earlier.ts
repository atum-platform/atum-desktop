import { EarlierConversationError, shouldPostEarlierNotice } from '../../../shared/agent-conversation'

export interface ConversationNoticePorts {
  current(): boolean
  leaseHolder(): boolean
  lastDay(roomId: string): string | undefined
  rememberDay(roomId: string, day: string): void
  publish(roomId: string, body: string, transactionId: string): Promise<void>
}

/** A static notice before admission: no claim, hold or model call. */
export async function postEarlierConversationNotice(
  error: unknown,
  ports: ConversationNoticePorts,
  body: string,
  now: number
): Promise<boolean> {
  if (!(error instanceof EarlierConversationError)) {
    return false
  }
  const day = new Date(now).toISOString().slice(0, 10)
  if (
    !ports.current() ||
    !shouldPostEarlierNotice({ leaseHolder: ports.leaseHolder(), day, lastDay: ports.lastDay(error.roomId) })
  ) {
    return true
  }
  await ports.publish(error.roomId, body, `atum-earlier-${day}`)
  if (ports.current() && ports.leaseHolder()) {
    ports.rememberDay(error.roomId, day)
  }
  return true
}
