/**
 * A retired agent's chats leave the person's chat list. Retiring an agent stops its runtime
 * and clears its device (forgetRetiredAgent), but its chats with the owner used to stay in the
 * roster as ordinary chats, since the agent no longer answers in them. This module decides
 * which chats go and when; the human SDK host leaves and forgets each one (`forgetAgentRoom`),
 * after re-reading the server's full room state, so a room anyone else was ever in stays.
 *
 * Leave + forget is the person's own Delete chat: it is account-wide (every device of theirs
 * drops it) and never deletes history on the server. It is safe to repeat: a forgotten room
 * is no longer in the sync, so it is never nominated again, on this Mac or another.
 */
import type { MatrixRoom } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import type { MatrixAgentDefinitionRecord } from './agent-definition'

/** After a failure that may pass (offline, a slow server), the next try waits this long. */
export const RETIRED_AGENT_ROOMS_RETRY_MS = 60_000

/** The Matrix users of the person's retired agents: the roster's tombstones (0157) and any
 * agent retired on this Mac. A tombstone never names a user the roster lists as active (the
 * default included), so a stale or mistaken one cannot touch a live agent's chats. A
 * retirement on this Mac outranks the roster: the roster main holds was read before it (or
 * was fetched before it and handled after), so it still lists that agent as active. Main only
 * reports a retirement whose Matrix user no other live agent here answers as; the person's
 * default agent cannot be retired, so the roster's word on it always stands. */
export function matrixRetiredAgentUsers(input: {
  roster: readonly MatrixAgentDefinitionRecord[]
  retiredHere: Iterable<string>
}): string[] {
  const here = new Set(input.retiredHere)

  const active = new Set(
    input.roster
      .filter(
        agent => agent.status === 'active' && (agent.isDefault || !agent.matrixUser || !here.has(agent.matrixUser))
      )
      .map(agent => agent.matrixUser)
  )

  const retired = [...input.roster.filter(agent => agent.status === 'retired').map(agent => agent.matrixUser), ...here]

  return [...new Set(retired)].filter((user): user is string => Boolean(user) && !active.has(user))
}

/**
 * The owner's chats with retired agents, from the last sync: a room the owner has joined, of
 * the assistant type or untyped, whose every listed member is the owner or one retired agent.
 * The last sync only nominates a room; a lazily loaded member list can hide a third person, so
 * the SDK re-reads the full room state before it leaves and forgets one. A room the SDK has
 * refused (`refused`) is not nominated again.
 */
export function matrixRetiredAgentRooms(input: {
  rooms: readonly MatrixRoom[]
  ownerId: string | undefined
  retired: readonly string[]
  refused?: ReadonlySet<string>
}): Array<{ roomId: string; agentId: string }> {
  const { ownerId } = input
  const retired = new Set(input.retired)

  if (!ownerId || retired.size === 0 || retired.has(ownerId)) {
    return []
  }

  return input.rooms.flatMap(room => {
    const members = room.participants ?? []
    const others = new Set(members.map(member => member.userId).filter(userId => userId !== ownerId))
    const [agentId] = others

    if (
      input.refused?.has(room.id) ||
      room.membership !== 'join' ||
      (room.roomType !== undefined && room.roomType !== MATRIX_ASSISTANT_ROOM_TYPE) ||
      others.size !== 1 ||
      !agentId ||
      !retired.has(agentId) ||
      !members.some(member => member.userId === ownerId)
    ) {
      return []
    }

    return [{ roomId: room.id, agentId }]
  })
}

export interface MatrixRetiredAgentRoomsDeps {
  /** The human host's `forgetAgentRoom`: `kept` when the server's room state shows it is not
   * only the owner's chat with that agent; a rejection is a failure that may pass. */
  forget: (input: { roomId: string; ownerId: string; agentId: string }) => Promise<unknown>
  now?: () => number
  log?: (line: string) => void
}

/**
 * The retired agents of the signed-in person and the sweep that clears their chats. Main tells
 * it the roster (`roster`) and each retirement on this Mac (`retired`), and offers it every
 * published snapshot (`sweep`); a sweep runs only while the chats are synced, one at a time.
 */
export class MatrixRetiredAgentRooms {
  private owner: string | undefined
  private rosterRecords: readonly MatrixAgentDefinitionRecord[] = []
  private readonly here = new Set<string>()
  private readonly refused = new Set<string>()
  private retryAt = 0
  private running: Promise<void> | undefined
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly deps: MatrixRetiredAgentRoomsDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
  }

  /** The authoritative roster for this owner: its tombstones name the retired agents. */
  roster(owner: string | undefined, roster: readonly MatrixAgentDefinitionRecord[]) {
    this.scope(owner)
    this.rosterRecords = roster
  }

  /** An agent retired on this Mac: its chats go now, before the next roster read. */
  retired(owner: string | undefined, matrixUser: string | undefined) {
    this.scope(owner)

    if (owner && matrixUser && matrixUser !== owner) {
      this.here.add(matrixUser)
      // A retirement is news: a pause after an earlier failure does not hold it back.
      this.retryAt = 0
    }
  }

  /** The retired agents' Matrix users this owner's chats are cleared of. */
  users(): string[] {
    return matrixRetiredAgentUsers({ roster: this.rosterRecords, retiredHere: this.here })
  }

  /** Leaves and forgets every nominated chat, one after another. Never throws. */
  sweep(view: { owner: string | undefined; ready: boolean; rooms: readonly MatrixRoom[] }): Promise<void> {
    if (this.running || !view.ready || !view.owner || view.owner !== this.owner || this.now() < this.retryAt) {
      return this.running ?? Promise.resolve()
    }

    const owner = view.owner

    const rooms = matrixRetiredAgentRooms({
      rooms: view.rooms,
      ownerId: owner,
      retired: this.users(),
      refused: this.refused
    })

    if (rooms.length === 0) {
      return Promise.resolve()
    }

    this.running = (async () => {
      for (const { roomId, agentId } of rooms) {
        // Signed out or another person meanwhile: nothing more for the old one.
        if (this.owner !== owner) {
          return
        }

        let answer: unknown

        try {
          answer = await this.deps.forget({ roomId, ownerId: owner, agentId })
        } catch (error) {
          this.retryAt = this.now() + RETIRED_AGENT_ROOMS_RETRY_MS
          this.log(
            `[Matrix] a retired agent's chat is still in the chat list, retrying: ${error instanceof Error ? error.message : 'failed'}`
          )

          return
        }

        if (answer === 'kept') {
          // Someone else was in it, or it is not a direct chat: it stays, and is not asked again.
          this.refused.add(roomId)
        } else {
          this.log("[Matrix] a retired agent's chat left the chat list")
        }
      }
    })().finally(() => {
      this.running = undefined
    })

    return this.running
  }

  /** Everything here belongs to one signed-in person. */
  private scope(owner: string | undefined) {
    if (owner === this.owner) {
      return
    }

    this.owner = owner
    this.rosterRecords = []
    this.here.clear()
    this.refused.clear()
    this.retryAt = 0
  }
}
