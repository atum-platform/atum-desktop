import {
  ClientEvent,
  EventType,
  type MatrixClient,
  type MatrixEvent,
  Method,
  Preset,
  type Room,
  RoomEvent
} from 'matrix-js-sdk'
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api/CryptoEvent'

import type { MatrixIdentity } from '../../../shared/matrix'
import {
  isMatrixFounderUserId,
  MATRIX_FOUNDER_CHAT_MARKER,
  type MatrixFounderChatMarker,
  type MatrixFounderChatResult,
  matrixFounderRoomMark,
  type MatrixFounderSdkCommand,
  parseMatrixFounderChatRecord
} from '../../../shared/matrix-founder'
import { createMatrixSyncHealth, matrixSyncedAfter } from '../../../shared/matrix-sync-health'

import { trustCrossSignedDevices } from './cross-signed-trust'

declare module 'matrix-js-sdk' {
  interface AccountDataEvents {
    'io.atum.founder_chat': Record<string, unknown>
  }
}

/** How long a new or adopted chat may take to arrive through sync before it is opened anyway. */
const ROOM_ARRIVAL_MS = 15_000
/** How long a send waits for the founder's devices to arrive once the chat exists. */
const DEVICE_ARRIVAL_MS = 8_000
/** How many times one invitation is tried while the server says to slow down. */
const JOIN_ATTEMPTS = 20
/** Accounts that are never a person writing to the founder. */
const INTERNAL_LOCALPART = /^@(?:agent|app|service|system)-/u

type ServerRecord = { state: 'absent' } | { state: 'present'; founder?: string; room?: string }

/** The server's wait for a rate-limited request, bounded; null when it is not one. */
function retryAfter(error: unknown): number | null {
  const value = error as {
    errcode?: string
    getRetryAfterMs?: () => number | null
    data?: { retry_after_ms?: unknown }
  }

  if (value?.errcode !== 'M_LIMIT_EXCEEDED') {
    return null
  }

  let ms: number | null | undefined

  try {
    ms = value.getRetryAfterMs?.()
  } catch {
    ms = undefined
  }

  const raw = ms ?? value.data?.retry_after_ms

  return Math.min(300_000, Math.max(1000, typeof raw === 'number' && Number.isFinite(raw) ? raw : 10_000))
}

/**
 * The Founder chat on the person's own client (plan
 *  D5–D7; shared/matrix-founder.ts).
 *
 * - The person's side: makes the chat when the person's first message asks for it (`explicit`:
 *   the recipe below, never on its own since 2026-10-25), records it in account data, and trusts
 *   the founder's cross-signed devices before making it and before every send there.
 * - The founder's side (signed in as the founder): joins a person's direct invitation, one at a
 *   time, and trusts that person's cross-signed devices before every reply. Only people who
 *   wrote ever invite the founder.
 *
 * Nothing here changes `createConversation`, the global blacklist or any room's blacklist.
 */
export function matrixFounderChat(
  client: MatrixClient,
  identity: MatrixIdentity,
  deps: {
    /** The SDK is running and ready. */
    active(): boolean
    /** Something the snapshot shows changed. */
    changed(): void
    /** Records a direct chat in `m.direct` (serialized by the caller; a presentation hint). */
    rememberDirect(userId: string, roomId: string): void
    now?(): number
    sleep?(ms: number): Promise<void>
  }
) {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let synced = false
  let stopped = false
  let founder: string | null = null
  let mode: 'off' | 'person' | 'founder' = 'off'
  let applying: Promise<unknown> = Promise.resolve()
  let joining: Promise<void> = Promise.resolve()
  const queuedJoins = new Set<string>()
  /** Chats this device made this session: one that loses a race is left, if still empty. */
  const madeHere = new Set<string>()
  /** Invitations the server refused to let the founder join (gone, forbidden): not asked again
   * on every sync, only after a restart. */
  const refusedJoins = new Set<string>()
  /** People the founder has joined or answered this session: their new devices are trusted. */
  const partners = new Set<string>()

  const me = () => client.getSafeUserId()

  const live = () =>
    !stopped && deps.active() && client.getUserId() === identity.userId && client.getDeviceId() === identity.deviceId

  function snapshot(): MatrixFounderChatMarker {
    if (!live() || !synced) {
      return { state: 'unknown' }
    }

    try {
      const event = client.getAccountData(MATRIX_FOUNDER_CHAT_MARKER)

      if (!event) {
        return { state: 'absent' }
      }

      // A record this build cannot read is a record all the same: never made again.
      const record = parseMatrixFounderChatRecord(event.getContent())

      return record
        ? { state: 'present', founder: record.founder, roomId: record.room }
        : { state: 'present', founder: '', roomId: '' }
    } catch {
      return { state: 'unknown' }
    }
  }

  /** The record as the server has it now (another device may have written it since). */
  async function serverRecord(): Promise<ServerRecord> {
    const raw = await client.http
      .authedRequest<unknown>(
        Method.Get,
        `/user/${encodeURIComponent(me())}/account_data/${encodeURIComponent(MATRIX_FOUNDER_CHAT_MARKER)}`
      )
      .catch(error => {
        if ((error as { errcode?: string })?.errcode === 'M_NOT_FOUND') {
          return undefined
        }

        throw error
      })

    if (raw === undefined) {
      return { state: 'absent' }
    }

    const record = parseMatrixFounderChatRecord(raw)

    return record ? { state: 'present', founder: record.founder, room: record.room } : { state: 'present' }
  }

  const membership = (room: Room, userId: string) => room.getMember(userId)?.membership ?? ''

  /** Joined by this account, with the founder joined or invited (encrypted before 0.20, plain
   * since). */
  function usable(roomId: string | undefined, who: string): boolean {
    const room = roomId ? client.getRoom(roomId) : null

    return Boolean(room && room.getMyMembership() === 'join' && ['join', 'invite'].includes(membership(room, who)))
  }

  /** Everyone joined or invited, besides this account. */
  function others(room: Room): string[] {
    return room
      .getMembers()
      .filter(member => ['join', 'invite'].includes(member.membership ?? '') && member.userId !== me())
      .map(member => member.userId)
  }

  /** A chat this account made with the room's own mark for this founder, only the two of them
   * in it: the oldest one is adopted rather than made again. */
  function adoptable(who: string): Room | undefined {
    return client
      .getRooms()
      .filter(room => {
        const create = room.currentState.getStateEvents(EventType.RoomCreate, '')
        const mark = room.currentState.getStateEvents(MATRIX_FOUNDER_CHAT_MARKER, '')
        const rest = others(room)

        return (
          room.getMyMembership() === 'join' &&
          create?.getSender() === me() &&
          mark?.getSender() === me() &&
          matrixFounderRoomMark(mark.getContent()) === who &&
          rest.length === 1 &&
          rest[0] === who
        )
      })
      .sort(
        (left, right) =>
          (left.currentState.getStateEvents(EventType.RoomCreate, '')?.getTs() ?? 0) -
            (right.currentState.getStateEvents(EventType.RoomCreate, '')?.getTs() ?? 0) ||
          left.roomId.localeCompare(right.roomId)
      )[0]
  }

  /** Whether this account wrote anything in a room (a chat someone used is never discarded). */
  function holdsMine(room: Room): boolean {
    return room
      .getLiveTimeline()
      .getEvents()
      .some(
        event =>
          event.getSender() === me() &&
          (event.getType() === EventType.RoomMessage || event.getWireType() === EventType.RoomMessageEncrypted)
      )
  }

  /** A chat this device made that another device's chat replaced: left and forgotten while empty. */
  async function discardLoser(roomId: string) {
    madeHere.delete(roomId)
    const room = client.getRoom(roomId)

    if (!room || holdsMine(room)) {
      return
    }

    try {
      if (['join', 'invite'].includes(room.getMyMembership())) {
        await client.leave(roomId)
      }

      await client.forget(roomId, true)
    } catch {
      // It stays an ordinary chat; nothing depends on it.
    }
  }

  async function waitForRoom(roomId: string) {
    for (let waited = 0; waited < ROOM_ARRIVAL_MS && !stopped; waited += 100) {
      if (client.getRoom(roomId)?.getMyMembership() === 'join') {
        return
      }

      await sleep(100)
    }
  }

  /** Preserve user-visible identity, state and recovery behavior across connection changes. */
  async function make(who: string): Promise<string> {
    const response = await client.createRoom({
      preset: Preset.PrivateChat,
      is_direct: true,
      invite: [who],
      initial_state: [
        { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'shared' } },
        { type: EventType.RoomGuestAccess, state_key: '', content: { guest_access: 'forbidden' } },
        { type: MATRIX_FOUNDER_CHAT_MARKER, state_key: '', content: { v: 1, founder: who } }
      ]
    })

    madeHere.add(response.room_id)

    return response.room_id
  }

  /** The person's own request (their first message): the chat they have, else the one another
   * device of theirs made, else a new one (it may replace a record whose chat they left). */
  async function ensure(who: string): Promise<MatrixFounderChatResult> {
    const record = await serverRecord()

    if (!live()) {
      return { state: 'waiting', reason: 'offline' }
    }

    // Already made (by this device or another): that chat, never a second.
    if (record.state === 'present' && record.founder === who && usable(record.room, who)) {
      return { state: 'ready', roomId: record.room! }
    }

    // The record names a chat this device has not synced yet (a second device starting just
    // after the first). Wait for it rather than make a second room beside it and invite the
    // Founder again. A chat this device does know and cannot use is the person's own (they
    // left it), and may still be replaced.
    if (record.state === 'present' && record.founder === who && record.room && !client.getRoom(record.room)) {
      await waitForRoom(record.room)

      if (usable(record.room, who)) {
        return { state: 'ready', roomId: record.room }
      }

      if (!live()) {
        return { state: 'waiting', reason: 'offline' }
      }

      if (!client.getRoom(record.room)) {
        return { state: 'waiting', reason: 'founder_not_ready' }
      }
    }

    // A plain chat (0.20) reaches the founder whatever their devices: no readiness to wait for.
    const roomId = adoptable(who)?.roomId ?? (await make(who))

    if (stopped) {
      return { state: 'waiting', reason: 'offline' }
    }

    await client.setAccountDataRaw(MATRIX_FOUNDER_CHAT_MARKER, { v: 1, founder: who, room: roomId, at: now() })
    deps.rememberDirect(who, roomId)

    // Another device of this account may have made its own meanwhile: its record stands.
    const after = await serverRecord().catch(() => ({ state: 'absent' }) as ServerRecord)
    const winner = after.state === 'present' && after.founder === who && after.room ? after.room : roomId

    if (winner !== roomId && madeHere.has(roomId)) {
      await discardLoser(roomId)
    }

    await waitForRoom(winner)
    // The founder is tracked now that a room is shared: trust what arrived already.
    void trustCrossSignedDevices(client, who).catch(() => {})

    return { state: 'ready', roomId: winner }
  }

  /** Founder mode's admission: a person's own direct invitation (plain since 0.20, or encrypted),
   * never an agent's or an app's, never from someone ignored, and from the person who made the
   * room. */
  function personInvitation(room: Room): string | null {
    if (room.getMyMembership() !== 'invite') {
      return null
    }

    const own = room.currentState.getStateEvents(EventType.RoomMember, me())
    const inviter = own?.getSender()
    const creator = room.currentState.getStateEvents(EventType.RoomCreate, '')?.getSender()

    return own?.getContent()?.is_direct === true &&
      inviter &&
      inviter === creator &&
      inviter !== me() &&
      !client.isUserIgnored(inviter) &&
      !INTERNAL_LOCALPART.test(inviter)
      ? inviter
      : null
  }

  async function join(roomId: string) {
    for (let attempt = 0; attempt < JOIN_ATTEMPTS; attempt += 1) {
      const room = client.getRoom(roomId)
      const inviter = room ? personInvitation(room) : null

      if (!live() || mode !== 'founder' || !inviter) {
        return
      }

      try {
        await client.joinRoom(roomId)
        partners.add(inviter)
        void trustCrossSignedDevices(client, inviter).catch(() => {})

        return
      } catch (error) {
        const wait = retryAfter(error)

        if (wait === null) {
          refusedJoins.add(roomId)

          return
        }

        await sleep(wait)
      }
    }

    // Still slowed down after every try: left for the next start.
    refusedJoins.add(roomId)
  }

  /** One join at a time: the server limits joins, and thousands of people may write at once. */
  function admit(room: Room) {
    if (
      mode !== 'founder' ||
      queuedJoins.has(room.roomId) ||
      refusedJoins.has(room.roomId) ||
      !personInvitation(room)
    ) {
      return
    }

    queuedJoins.add(room.roomId)
    joining = joining
      .then(() => join(room.roomId))
      .catch(() => {})
      .finally(() => {
        queuedJoins.delete(room.roomId)
      })
  }

  function admitAll() {
    if (mode === 'founder' && synced && live()) {
      for (const room of client.getRooms()) {
        admit(room)
      }
    }
  }

  /** The person in a two-person direct chat they invited the founder to (the founder's side of a
   * Founder chat), else none: never the founder's own assistant or an app. */
  function partnerIn(room: Room): string | null {
    const rest = others(room)
    const partner = rest.length === 1 ? rest[0]! : null

    return partner &&
      room.getMyMembership() === 'join' &&
      room.getDMInviter() === partner &&
      !INTERNAL_LOCALPART.test(partner)
      ? partner
      : null
  }

  /** Trusts `who` for a send in `room`; when nothing is known yet, waits a little for their
   * devices to arrive (the room's own key query), then tries once more. */
  async function reachable(who: string, room: Room): Promise<boolean> {
    let trust = await trustCrossSignedDevices(client, who)

    if (trust.count > 0 || trust.state !== 'no_identity') {
      return trust.count > 0
    }

    let updated: ((users: string[]) => void) | undefined

    const arrived = new Promise<void>(resolve => {
      updated = users => {
        if (users.includes(who)) {
          resolve()
        }
      }

      client.on(CryptoEvent.DevicesUpdated, updated)
    })

    try {
      // Starts the room's key query; any key it shares goes only to devices already trusted.
      client.getCrypto()?.prepareToEncrypt(room)
      await Promise.race([arrived, sleep(DEVICE_ARRIVAL_MS)])
    } finally {
      client.off(CryptoEvent.DevicesUpdated, updated!)
    }

    trust = await trustCrossSignedDevices(client, who)

    return trust.count > 0
  }

  async function apply(command: MatrixFounderSdkCommand): Promise<MatrixFounderChatResult> {
    if (
      (command.founder !== null && !isMatrixFounderUserId(command.founder)) ||
      !['explicit', 'none'].includes(command.create)
    ) {
      throw new Error('matrix_command_invalid')
    }

    founder = command.founder

    if (founder === null) {
      mode = 'off'

      return { state: 'disabled' }
    }

    if (founder === me()) {
      mode = 'founder'
      admitAll()

      return { state: 'founder_mode' }
    }

    mode = 'person'

    // Told who the founder is, for trust: nothing is made, whatever the record says. The chat
    // exists only once the person's first message asks for it (`explicit`).
    if (command.create === 'none') {
      return { state: 'declined' }
    }

    if (!live()) {
      return { state: 'waiting', reason: 'offline' }
    }

    if (!synced) {
      return { state: 'waiting', reason: 'not_synced' }
    }

    try {
      return await ensure(founder)
    } catch (error) {
      if (stopped || !live()) {
        return { state: 'waiting', reason: 'offline' }
      }

      throw error
    }
  }

  // Synced after a sync response (the saved one counts here), and a reconnecting sync does not
  // unmake it (matrix-sync-health.ts): the chat does not flicker to "not synced" on a blip. An
  // outage that outlasts its grace does, by timer, since no sync event says so.
  const health = createMatrixSyncHealth({
    onChange: next => {
      if (next === 'offline' && synced && !stopped) {
        synced = false
        deps.changed()
      }
    }
  })

  const sync = (state: string, _previous?: unknown, data?: unknown) => {
    synced = matrixSyncedAfter(synced, state, health.observe(state, data), { prepared: true })
    admitAll()
    deps.changed()
  }

  const accountData = (event: MatrixEvent) => {
    if (event.getType() !== MATRIX_FOUNDER_CHAT_MARKER) {
      return
    }

    // Both devices kept their own chat: the record names the one that stands.
    const record = parseMatrixFounderChatRecord(event.getContent())

    if (record) {
      for (const roomId of [...madeHere]) {
        if (roomId !== record.room) {
          void discardLoser(roomId)
        }
      }
    }

    deps.changed()
  }

  const invited = (room: Room, membership: string) => {
    if (membership === 'invite') {
      admit(room)
    }
  }

  const devicesUpdated = (users: string[]) => {
    const watched = mode === 'person' && founder ? [founder] : mode === 'founder' ? [...partners] : []

    for (const user of users.filter(each => watched.includes(each))) {
      void trustCrossSignedDevices(client, user).catch(() => {})
    }
  }

  client.on(ClientEvent.Sync, sync)
  client.on(ClientEvent.AccountData, accountData)
  client.on(RoomEvent.MyMembership, invited)
  client.on(CryptoEvent.DevicesUpdated, devicesUpdated)

  return {
    snapshot,
    /** One at a time: a creation never races another on this device. */
    apply(command: MatrixFounderSdkCommand): Promise<MatrixFounderChatResult> {
      const next = applying.then(
        () => apply(command),
        () => apply(command)
      )

      applying = next.catch(() => {})

      return next
    },
    /**
     * Before every send and attachment. The person's side: in a chat with only the founder,
     * the founder's devices are trusted first, and a send that would reach no device of theirs
     * is refused. The founder's side: the same for the other person of a two-person chat.
     */
    async beforeSend(roomId: string): Promise<void> {
      const room = client.getRoom(roomId)

      if (!room || !founder || mode === 'off' || stopped) {
        return
      }

      if (mode === 'person') {
        const rest = others(room)

        if (
          room.hasEncryptionStateEvent() &&
          rest.length === 1 &&
          rest[0] === founder &&
          !(await reachable(founder, room))
        ) {
          throw new Error('matrix_founder_unready')
        }

        return
      }

      const partner = partnerIn(room)

      if (partner) {
        partners.add(partner)

        // Device trust matters only where messages are encrypted; a plain chat reaches everyone.
        if (room.hasEncryptionStateEvent() && !(await reachable(partner, room))) {
          throw new Error('matrix_founder_recipient_unready')
        }
      }
    },
    stop() {
      stopped = true
      synced = false
      health.dispose()
      client.off(ClientEvent.Sync, sync)
      client.off(ClientEvent.AccountData, accountData)
      client.off(RoomEvent.MyMembership, invited)
      client.off(CryptoEvent.DevicesUpdated, devicesUpdated)
    }
  }
}
