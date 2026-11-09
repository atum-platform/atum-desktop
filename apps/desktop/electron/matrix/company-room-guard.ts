import type { MatrixCommand, MatrixRoom } from '../../shared/matrix'
import { MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE } from '../../shared/matrix-company-channel-room'

import { MatrixCompanyError } from './company'

/**
 * Membership of a company channel belongs to the company authority (the platform
 * directory and the hosted channel manager), never to the person. A Matrix leave,
 * forget or member-moderation command on such a room would strand the member
 * outside a channel the directory still lists, so main refuses every path.
 *
 * "Company channel" is the platform directory's claim, never the room's own: a room's
 * create-event type and binding are written by whoever created it, so a stranger can
 * mint a room that looks exactly like a channel. Only a room whose exact
 * `{companyId, channelId, roomId}` the current directory lists is guarded. A successful
 * negative read proves a spoof; an unavailable read never hands a joined room to Personal.
 */
const COMPANY_ROOM_REFUSED: ReadonlySet<MatrixCommand['kind']> = new Set([
  'leave',
  'forget',
  'invite',
  'removeMember',
  'ban',
  'unban'
])

export function companyRoomCommandRefused(kind: MatrixCommand['kind']): boolean {
  return COMPANY_ROOM_REFUSED.has(kind)
}

type CompanyClaim = Pick<MatrixRoom, 'id' | 'roomType' | 'companyChannel'> & Partial<Pick<MatrixRoom, 'membership'>>

/**
 * A joined company conversation (a company DM or group DM) is the company's, like a channel, and has
 * no Personal-style leave, forget, invitation or moderation: hiding it is the person's own presentation
 * state on the platform, and who takes part is the platform's participant set. Unlike a channel this
 * needs no directory confirmation: nothing legitimate leaves such a room through Matrix, and a stranger's
 * room that merely claims the type is never shown in this window (it is quarantined, not listed), so
 * refusing these commands on a joined one costs nothing. An invitation to one can still be declined.
 */
export function assertCompanyConversationCommandAllowed(
  kind: MatrixCommand['kind'],
  room: Pick<MatrixRoom, 'roomType' | 'membership'> | undefined
): void {
  if (room?.roomType === MATRIX_COMPANY_CONVERSATION_TYPE && room.membership === 'join' && companyRoomCommandRefused(kind)) {
    throw new Error('matrix_company_room_managed')
  }
}

export type CompanyChannelDirectoryRead = (companyId: string) => Promise<unknown>

/** A room's own metadata says it is a company channel; nothing here is trusted yet. */
export function claimsCompanyChannel(room: CompanyClaim | undefined): room is CompanyClaim & {
  companyChannel: { companyId: string; channelId: string }
} {
  return Boolean(room?.companyChannel) && room?.roomType === MATRIX_COMPANY_CHANNEL_TYPE
}

/** The ready rooms of a directory response, by channel ID; undefined when the shape is not one. */
function readyRooms(value: unknown): Map<string, string> | undefined {
  const channels = value && typeof value === 'object' ? Reflect.get(value, 'channels') : undefined

  if (!Array.isArray(channels)) {
    return undefined
  }

  const rooms = new Map<string, string>()

  for (const item of channels) {
    const id = item?.channel?.id
    const room = item?.room

    if (typeof id === 'string' && room?.state === 'ready' && typeof room.roomId === 'string') {
      rooms.set(id, room.roomId)
    }
  }

  return rooms
}

/** Whether the directory read lists exactly this channel in exactly this room. */
export function directoryConfirms(value: unknown, claim: { channelId: string }, roomId: string): boolean {
  return readyRooms(value)?.get(claim.channelId) === roomId
}

/**
 * Confirmed means: the platform directory for this account lists the claimed channel with
 * this very room ID. This compatibility predicate answers false on a failed read; command
 * enforcement below distinguishes that failure and fails closed for joined rooms.
 */
export async function companyRoomConfirmed(
  room: CompanyClaim | undefined,
  read: CompanyChannelDirectoryRead
): Promise<boolean> {
  if (!claimsCompanyChannel(room)) {
    return false
  }

  try {
    return directoryConfirms(await read(room.companyChannel.companyId), room.companyChannel, room.id)
  } catch {
    return false
  }
}

/** Throws for managed commands on a confirmed room, or while a joined claim cannot be checked. */
export async function assertCompanyRoomCommandAllowed(
  kind: MatrixCommand['kind'],
  room: CompanyClaim | undefined,
  read: CompanyChannelDirectoryRead
): Promise<void> {
  if (!companyRoomCommandRefused(kind) || !claimsCompanyChannel(room)) {
    return
  }

  try {
    if (directoryConfirms(await read(room.companyChannel.companyId), room.companyChannel, room.id)) {
      throw new Error('matrix_company_room_managed')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'matrix_company_room_managed') {
      throw error
    }

    // A joined room cannot become personally managed merely because its authority is offline.
    // Invitations retain the narrow decline escape hatch; a successful negative directory read
    // still proves a spoof claim and leaves it manageable as an ordinary invitation/room.
    if (!(kind === 'leave' && room.membership === 'invite')) {
      throw new Error('matrix_company_room_unavailable')
    }
  }
}

/** The room as an ordinary room: the claim in its own metadata is not shown to the window. */
function ordinary(room: MatrixRoom): MatrixRoom {
  const { companyChannel: _claim, ...rest } = room

  return rest.roomType === MATRIX_COMPANY_CHANNEL_TYPE ? { ...rest, roomType: undefined } : rest
}

/** How the window is shown one room (`CompanyChannelConfirmations.status`): a closed vocabulary, safe to log. */
export type CompanyChannelProjectionStatus =
  | 'confirmed'
  | 'pending'
  | 'read-failed'
  | 'read-denied'
  | 'withdrawn'
  | 'unlisted'
  | 'unclaimed'
  | 'signed-out'

/**
 * The main-log line for a company channel the person selected: how the window will be shown it and the person's
 * Matrix membership. Closed words only, no room, company or channel identifier.
 */
export function companyChannelSelectedLine(
  status: CompanyChannelProjectionStatus,
  membership: string | undefined
): string | null {
  if (status === 'unclaimed') {
    return null
  }

  const member = ['join', 'invite', 'leave', 'ban', 'knock'].includes(membership ?? '') ? membership : 'none'

  return `[Matrix] company channel selected: projection=${status} membership=${member}`
}

/** The main-log line for a company channel whose `select` or `join` the SDK refused: its closed error code, nothing else. */
export function companyChannelOpenFailedLine(kind: 'select' | 'join', error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const code = /^matrix_[a-z_]{1,64}$/u.test(message) ? message : 'error'

  return `[Matrix] company channel ${kind} failed: ${code}`
}

type Confirmation = {
  at: number
  rooms?: Map<string, string>
  failure?: 'denied' | 'transient'
}

function readFailure(error: unknown): 'denied' | 'transient' {
  return error instanceof MatrixCompanyError && ['authentication', 'denied', 'missing', 'invalid'].includes(error.code)
    ? 'denied'
    : 'transient'
}

/** The signed-in session as the other account-scoped controllers see it (`account.appScope()`). */
export interface CompanyConfirmationScope {
  accountKey: string
  generation: number
}

const sameScope = (a: CompanyConfirmationScope | null, b: CompanyConfirmationScope | null) =>
  a?.accountKey === b?.accountKey && a?.generation === b?.generation

/**
 * What the window is shown. A room whose creator merely claims to be a company channel is
 * published as ordinary only after a successful first read disproves it. While the first
 * read is in flight, on a failed read, or after a previously confirmed binding disappears,
 * the claim stays company-classified and its open transcript is quarantined.
 *
 * Every answer is fenced by the session (`activate`): a sign-out followed by a sign-in as the
 * same user is a new session, so a read that started before it can never apply. A confirmation
 * also expires on its own: a timer re-reads each company still in use when its answer goes
 * stale, so a channel the directory dropped stops being treated as company-owned without
 * waiting for the next room-list change.
 */
export class CompanyChannelConfirmations {
  private scope: CompanyConfirmationScope | null = null
  private epoch = 0
  private abort = new AbortController()
  private readonly known = new Map<string, Confirmation>()
  private readonly loading = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly confirmed = new Set<string>()
  private unavailableRooms = new Set<string>()
  private wanted = new Set<string>()

  constructor(
    private readonly ports: {
      read: (companyId: string, signal: AbortSignal) => Promise<unknown>
      /** Called when a read settles with a different answer than before. */
      changed: () => void
      now?: () => number
    },
    private readonly staleMs = 60_000,
    private readonly failedMs = 10_000
  ) {}

  /** Binds the confirmations to one signed-in session; any other session starts from nothing. */
  activate(scope: CompanyConfirmationScope | null) {
    if (sameScope(scope, this.scope)) {
      return
    }

    this.scope = scope
    this.epoch += 1
    this.abort.abort()
    this.abort = new AbortController()
    this.known.clear()
    this.loading.clear()
    this.confirmed.clear()
    this.unavailableRooms = new Set()
    this.wanted = new Set()

    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }

    this.timers.clear()
  }

  /** Quit: nothing reads or republishes afterwards. */
  stop() {
    this.activate(null)
  }

  /**
   * The one projection of a snapshot for any renderer: push, pull and anything added later
   * must come through here, so the window never sees a room's own unconfirmed claim.
   */
  project<T extends { rooms: MatrixRoom[] }>(snapshot: T): T {
    const rooms = this.view(snapshot.rooms)

    const open = 'roomId' in snapshot && typeof snapshot.roomId === 'string' && this.unavailableRooms.has(snapshot.roomId)

    if (open) {
      return {
        ...snapshot,
        rooms,
        roomId: null,
        destination: null,
        messages: [],
        members: [],
        canSend: false,
        typing: [],
        threads: [],
        membershipLines: []
      }
    }

    return rooms === snapshot.rooms ? snapshot : { ...snapshot, rooms }
  }

  /**
   * What this projection does with one room, for main's log: shown as a confirmed channel, held back while the
   * first read is in flight or after a failed one, published as an ordinary room after a negative read, or not a
   * channel claim at all. Reads nothing and changes nothing.
   */
  status(room: MatrixRoom | undefined): CompanyChannelProjectionStatus {
    if (!claimsCompanyChannel(room)) {
      return 'unclaimed'
    }

    if (!this.scope) {
      return 'signed-out'
    }

    const known = this.known.get(room.companyChannel.companyId)

    if (!known) {
      return 'pending'
    }

    if (known.rooms?.get(room.companyChannel.channelId) === room.id) {
      return 'confirmed'
    }

    if (known.failure) {
      return known.failure === 'denied' ? 'read-denied' : 'read-failed'
    }

    return this.confirmed.has(`${room.companyChannel.companyId}\0${room.companyChannel.channelId}\0${room.id}`)
      ? 'withdrawn'
      : 'unlisted'
  }

  view(rooms: MatrixRoom[]): MatrixRoom[] {
    if (!rooms.some(room => room.companyChannel || room.roomType === MATRIX_COMPANY_CHANNEL_TYPE)) {
      this.wanted = new Set()
      this.unavailableRooms = new Set()

      return rooms
    }

    const wanted = new Set<string>()
    const unavailable = new Set<string>()

    const next = rooms.map(room => {
      if (!claimsCompanyChannel(room) || !this.scope) {
        return ordinary(room)
      }

      const { companyId } = room.companyChannel
      wanted.add(companyId)
      const known = this.known.get(companyId)
      this.refresh(companyId, known)

      // First read still in flight: keep the claim for a moment rather than flash it into Home.
      if (!known) {
        unavailable.add(room.id)
        return room
      }

      const key = `${companyId}\0${room.companyChannel.channelId}\0${room.id}`
      const listed = known.rooms?.get(room.companyChannel.channelId) === room.id

      if (listed) {
        this.confirmed.add(key)
        return room
      }

      // A successful first negative read proves the room's self-authored claim is a spoof.
      // Failure, or a room confirmed earlier in this session and then omitted, is quarantined:
      // it keeps its company classification but cannot remain open or writable.
      if (known.failure || this.confirmed.has(key)) {
        unavailable.add(room.id)
        return room
      }

      return ordinary(room)
    })

    this.wanted = wanted
    this.unavailableRooms = unavailable

    return next
  }

  private refresh(companyId: string, known: Confirmation | undefined) {
    const now = this.ports.now?.() ?? Date.now()

    if (this.loading.has(companyId) || (known && now - known.at < this.ttl(known))) {
      return
    }

    this.read(companyId)
  }

  private ttl(known: Confirmation) {
    return known.rooms ? this.staleMs : this.failedMs
  }

  private read(companyId: string) {
    const epoch = this.epoch
    this.loading.add(companyId)
    clearTimeout(this.timers.get(companyId))
    this.timers.delete(companyId)

    void this.ports.read(companyId, this.abort.signal).then(
      value => {
        const rooms = readyRooms(value)

        return rooms ? { rooms } : { failure: 'transient' as const }
      },
      error => ({ failure: readFailure(error) })
    ).then(result => {
      // A different session (even the same user signing in again) or a quit: this answer is void.
      if (epoch !== this.epoch) {
        return
      }

      this.loading.delete(companyId)
      const before = this.known.get(companyId)
      const known: Confirmation = { at: this.ports.now?.() ?? Date.now(), ...result }
      this.known.set(companyId, known)
      this.expireLater(companyId, known)

      if (
        !before ||
        before.failure !== known.failure ||
        JSON.stringify([...(before.rooms ?? [])]) !== JSON.stringify([...(known.rooms ?? [])])
      ) {
        this.ports.changed()
      }
    })
  }

  /** Re-reads while some room of this company still claims a channel; republishes only on a change. */
  private expireLater(companyId: string, known: Confirmation) {
    const epoch = this.epoch

    const timer = setTimeout(() => {
      this.timers.delete(companyId)

      if (epoch !== this.epoch) {
        return
      }

      if (!this.wanted.has(companyId)) {
        this.known.delete(companyId)

        return
      }

      this.read(companyId)
    }, this.ttl(known))

    timer.unref?.()
    this.timers.set(companyId, timer)
  }
}
