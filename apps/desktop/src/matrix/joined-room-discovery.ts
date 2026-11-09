import { EventType, type MatrixClient } from 'matrix-js-sdk'

import type { MatrixCompanyChannelDiscoveryReport } from '../../shared/matrix-company-channel-room'

/**
 * A room's create event is immutable, so once it has been READ, "this room is bound to X (or to nothing we recognise)"
 * is permanent. Remembering that per client and room type makes discovery resumable: an interrupted or lease-limited
 * pass on a very large account never starts again from nothing, and a settled account re-reads only rooms it has not
 * yet classified. There is deliberately no joined-room ceiling: a manager that has joined many rooms must still be
 * able to recover a lost create instead of failing closed forever.
 *
 * Only a create event the server actually returned may settle a room. The synced room cache is a hint: its type is
 * `undefined` both for a room whose create event has not synced yet and for a plain untyped room, so it can neither
 * prove a negative nor be remembered as one. A wrong permanent negative hides the manager's own room, and the next
 * create attempt then makes a duplicate whose binding conflicts with it forever.
 */
const classified = new WeakMap<MatrixClient, Map<string, Map<string, unknown>>>()
/** The most `roomState` reads (and leaves) in flight at once. */
const PAGE = 50

/**
 * A room whose create event the server will not give is not a verdict, but one such room must not wedge every channel's
 * creation for ever either. Each pass that cannot read a room extends its streak (a pass that can read it ends the
 * streak and settles the room). Streaks live in memory only: a restarted manager reads every room afresh.
 *
 * What a streak may lead to depends on what the manager can PROVE from the synced copy of the room's create event,
 * which, unlike `getType()`, is never ambiguous (an absent event is `unknown`, not a type):
 *
 * - `foreign`: created by someone else. It can never be this manager's room, so it blocks nothing; once its streak is
 *   3 passes over at least a minute the manager leaves it.
 * - `other`: created by this manager for a different binding. It cannot be the room being looked for, so it blocks
 *   nothing, but it may be a bound channel room whose only admin is this manager: never left, reported instead.
 * - `target`: created by this manager for the binding being looked for. Unreadable means unrecoverable: the pass is
 *   refused (never "none found"), never left, reported.
 * - `unknown`: no create event has synced, so nothing can be proven: refused, never left, reported.
 *
 * Absence from the platform's plan or work list is NOT such a proof. The work list names only channels with work due,
 * and a reconciled `ready` channel drops out of it, so a bound room can look unbound from there.
 */
type Provenance = 'foreign' | 'other' | 'target' | 'unknown'

interface Streak {
  since: number
  passes: number
  provenance: Provenance
}

const unreadable = new WeakMap<MatrixClient, Map<string, Streak>>()
/** Rooms left since the last report. */
const departed = new WeakMap<MatrixClient, Set<string>>()
/** An unreadable room is acted on only after this many consecutive unreadable passes... */
const UNREADABLE_PASSES = 3
/** ...spanning at least this long. */
const UNREADABLE_MS = 60_000
/** The most rooms one report names. */
const REPORTED = 50

const due = (streak: Streak, now: number) => streak.passes >= UNREADABLE_PASSES && now - streak.since >= UNREADABLE_MS

/** The server saying it will not show this room: an answer about the room, unlike a network error, 5xx or timeout. */
const refused = (error: unknown) => typeof error === 'object' && error !== null && 'httpStatus' in error &&
  [400, 403, 404].includes(Number(error.httpStatus))

export interface BoundRoomScan<Binding> {
  /** The immutable create `type` this family of rooms carries; the synced room cache filters on it for free. */
  roomType: string
  binding(content: Record<string, unknown>, sender: string): Binding | undefined
  matches(binding: Binding): boolean
  /** Thrown when two rooms carry the same binding: never guess which one is real. */
  conflict(): never
  denied(): never
  /**
   * Set only by a family whose runtime journals `discoveryReport`. Discovery leaves a room only where the leave will be
   * visible; any other family still stops a foreign unreadable room from blocking it, and leaves it joined.
   */
  reported?: boolean
}

function provenanceOf<Binding>(client: MatrixClient, id: string, scan: BoundRoomScan<Binding>): Provenance {
  const creation = client.getRoom(id)?.currentState?.getStateEvents(EventType.RoomCreate, '')
  const sender = creation?.getSender()
  const manager = client.getUserId()

  if (!creation || !sender || !manager) {return 'unknown'}

  if (sender !== manager) {return 'foreign'}
  const binding = scan.binding(creation.getContent(), sender)

  return binding !== undefined && scan.matches(binding) ? 'target' : 'other'
}

/** The one joined room whose immutable create metadata matches, or null. Server state is read in bounded pages. */
export async function findBoundRoom<Binding>(
  client: MatrixClient,
  active: () => boolean,
  scan: BoundRoomScan<Binding>
): Promise<string | null> {
  const { joined_rooms: rooms } = await client.getJoinedRooms()

  if (!active()) {scan.denied()}
  const families = classified.get(client) ?? new Map<string, Map<string, unknown>>()

  classified.set(client, families)
  const memo = (families.get(scan.roomType) ?? new Map<string, unknown>()) as Map<string, Binding | null>

  families.set(scan.roomType, memo)
  const joined = new Set(rooms)
  const ids = [...joined].sort()
  const unclassified: string[] = []
  const streaks = unreadable.get(client) ?? new Map<string, Streak>()

  unreadable.set(client, streaks)

  // A room that is no longer joined has no streak to continue.
  for (const id of streaks.keys()) {
    if (!joined.has(id)) {streaks.delete(id)}
  }

  for (const id of ids) {
    if (memo.has(id)) {continue}
    const local = client.getRoom(id)?.getType()

    // A synced type that is a different string lets this pass skip the room without a server read, but is never
    // written to the memo: only the server's create event settles a room for good. Anything else, `undefined`
    // included, is unknown and is read from the server like any room not yet classified.
    if (typeof local === 'string' && local !== scan.roomType) {
      streaks.delete(id)

      continue
    }

    unclassified.push(id)
  }

  const now = Date.now()
  const missed = new Map<string, Streak>()

  for (let start = 0; start < unclassified.length; start += PAGE) {
    if (!active()) {scan.denied()}
    await Promise.all(unclassified.slice(start, start + PAGE).map(async id => {
      const events = await client.roomState(id).catch((error: unknown) => {
        // A refusal is the server's answer about this room, as unreadable as a state without its create event. Any
        // other failure says nothing about the room and fails the pass, as it always did.
        if (refused(error)) {return []}

        throw error
      })

      if (!active()) {scan.denied()}
      const creation = events.find(event => event.type === EventType.RoomCreate && event.state_key === '')

      // An answer without the create event is an incomplete read, not a verdict: leave the room unclassified so the
      // next pass reads it again. A create event that was read and is not ours (wrong type or binding) is permanent.
      if (!creation) {
        const previous = streaks.get(id)
        const next = { since: previous?.since ?? now, passes: (previous?.passes ?? 0) + 1, provenance: provenanceOf(client, id, scan) }

        streaks.set(id, next)
        missed.set(id, next)

        return
      }

      streaks.delete(id)
      memo.set(id, scan.binding(creation.content, creation.sender) ?? null)
    }))
  }

  // Only a room that could be the one being looked for may make "none found" untrue. A foreign or otherwise-bound room
  // cannot, however unreadable.
  let unread = 0
  const leaving: string[] = []

  for (const [id, entry] of missed) {
    if (entry.provenance === 'target' || entry.provenance === 'unknown') {unread += 1}
    else if (entry.provenance === 'foreign' && scan.reported === true && due(entry, now)) {leaving.push(id)}
  }

  for (let start = 0; start < leaving.length; start += PAGE) {
    if (!active()) {scan.denied()}
    await Promise.all(leaving.slice(start, start + PAGE).map(async id => {
      try {
        await client.leave(id)
      } catch {
        // Staying is harmless (a foreign room blocks nothing) and the next pass tries again.
        return
      }

      streaks.delete(id)
      departed.set(client, (departed.get(client) ?? new Set<string>()).add(id))
    }))
  }

  if (leaving.length > 0 && !active()) {scan.denied()}
  let found: string | null = null

  for (const id of ids) {
    const binding = memo.get(id)

    if (!binding || !scan.matches(binding)) {continue}

    if (found) {scan.conflict()}
    found = id
  }

  // A bound room that was read is certain. "No such room" is not certain while any room that could be the one being
  // looked for could not be read, and a caller that is told "none" may create a second room. Drift is a failed pass,
  // not permission to create.
  if (found === null && unread > 0) {scan.denied()}

  return found
}

async function digest(id: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))

  return [...new Uint8Array(bytes).slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * What discovery did and could not do, for the controller's journal. Rooms are named only by a short hash of their id.
 * `left` is drained: each room is reported once. `unreadable` is the current state, so it repeats until it is fixed.
 */
export async function discoveryReport(client: MatrixClient): Promise<MatrixCompanyChannelDiscoveryReport> {
  const gone = departed.get(client) ?? new Set<string>()
  const left = [...gone].sort().slice(0, REPORTED)
  const now = Date.now()

  for (const id of left) {gone.delete(id)}

  const kept = [...(unreadable.get(client) ?? [])]
    .filter(([, entry]) => entry.provenance !== 'foreign' && due(entry, now))
    .map(([id]) => id)
    .sort()
    .slice(0, REPORTED)

  return { left: await Promise.all(left.map(digest)), unreadable: await Promise.all(kept.map(digest)) }
}
