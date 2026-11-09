import type { MatrixMessage } from '../../shared/matrix'

/** First received top-level message after the frozen fully-read marker. */
export function matrixFirstUnreadMessageId(
  messages: readonly MatrixMessage[],
  markerEventId: string | undefined,
  fallback?: string
): string | undefined {
  if (!markerEventId) {
    return fallback
  }

  const marker = messages.findIndex(message => message.id === markerEventId)

  if (marker < 0) {
    return fallback
  }

  return messages.slice(marker + 1).find(message => !message.own && !message.thread)?.id
}
