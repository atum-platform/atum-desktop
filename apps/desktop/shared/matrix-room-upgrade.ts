/**
 * Room upgrades (Matrix spec, "Room upgrades"): an old room's `m.room.tombstone` names its
 * replacement, and the replacement's `m.room.create` names its predecessor. A link is trusted only
 * when both ends agree. These are display hints; the SDK re-reads room state before it acts.
 */

/** What the old room shows about its replacement. */
export type MatrixRoomSuccessor =
  /** Joined, and its create event points back here: just open it. */
  | { roomId: string; state: 'open' }
  /** Not joined yet (an invitation, or not known until joined). `backlink` says whether the
   * replacement's state was readable enough to confirm it points back here before joining. */
  | { roomId: string; state: 'join'; backlink: 'verified' | 'pending' }
  /** The replacement cannot be confirmed as this room's: its create event names another room,
   * or its state is not readable yet. Nothing is offered. */
  | { roomId: string; state: 'unconfirmed' }

/** What the replacement shows about the room it replaced: only a joined, mutually confirmed one. */
export interface MatrixRoomPredecessor {
  roomId: string
}
