/**
 * The headless bot runtime receives identifiers only. It re-reads an event through a later
 * app-bot command before it treats the event as a turn.
 */
export interface MatrixAppBotEvent {
  roomId: string
  eventId: string
}

/** Bot identity is pinned by its published key pair, independently of person
 * cross-signing. Unknown/unsigned device shields may therefore be resolved by
 * that pin; imported, forwarded and mismatched-key provenance never is. */
export function appBotPinnedShield(reason: number | null | undefined): boolean {
  return reason === null || reason === 1 || reason === 2 || reason === 3
}
