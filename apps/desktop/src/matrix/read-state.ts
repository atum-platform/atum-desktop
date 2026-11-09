import { inMainTimelineForReceipt, type MatrixEvent, ReceiptType, type Room } from 'matrix-js-sdk'

/**
 * Other people's synced public `m.read` receipts that sit on this exact event, oldest first.
 *
 * Exact placement is the Element X model: a reader's avatar goes under the message their
 * receipt names, not under every earlier message they passed on the way. Atum itself
 * acknowledges privately (`read-receipts.ts`), so nothing here is inferred from a local send.
 *
 * The SDK's `getReceiptsForEvent` cache is not used: when a later synthesized sender receipt
 * exists for the reader, the SDK drops the real receipt before caching it, and the reader
 * would vanish from the event its public receipt names. Each joined member's latest real
 * receipt (`ignoreSynthesized`) names its event directly. Thread receipts stay in their thread.
 */
export function publicReaders(room: Room, event: MatrixEvent): string[] {
  const id = event.getId()

  if (!id || event.status !== null || event.isDecryptionFailure() || !inMainTimelineForReceipt(event)) {
    return []
  }

  const sender = event.getSender()

  return room
    .getJoinedMembers()
    .flatMap(member => {
      if (member.userId === sender) {
        return []
      }

      const receipt = room.getReadReceiptForUserId(member.userId, true, ReceiptType.Read)

      if (!receipt || receipt.eventId !== id) {
        return []
      }

      const thread = receipt.data.thread_id

      return thread === undefined || thread === 'main'
        ? [{ userId: member.userId, ts: receipt.data.ts }]
        : []
    })
    .sort((left, right) => left.ts - right.ts || left.userId.localeCompare(right.userId))
    .map(receipt => receipt.userId)
}
