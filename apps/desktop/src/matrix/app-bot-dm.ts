import { EventType, type MatrixClient, MatrixEvent, type Room } from 'matrix-js-sdk'

import { APP_UUID } from '../../shared/app-shortcuts'
import type { MatrixRoomAppBot } from '../../shared/matrix'
import type { AppBotDmOutcome, AppBotDmReason } from '../../shared/matrix-app-bot-dm'

declare module 'matrix-js-sdk' {
  interface AccountDataEvents {
    [key: `io.atum.app_bot.dm.${string}`]: { v: 1; room_id: string; bot_user_id: string }
  }

  interface RoomAccountDataEvents {
    'io.atum.app_bot.hidden': { v: 1; at: number }
  }
}

/**
 * An official bot's one chat with this account (Moon, Andy): which room it is, and what Delete
 * chat does to it (Q5 of the 2026-10-09 simplification plan, until the server owns each
 * person's bot room in S4).
 *
 * The owner saw a new, empty Moon or Andy room after a restart: the desktop accepted the room its
 * pointer named only when nobody but the person and the bot had ever been in it, recovered only
 * among rooms the person was still in, and otherwise made a new room. Now a room is reused
 * whenever it still works as the bot's chat, and a new one is made only when none does.
 *
 * A room the person left cannot be rejoined from here: bot rooms are made invite-only
 * (`createConversation`, `Preset.PrivateChat`), so a join without an invitation is refused. The
 * desktop never tries one. It joins only when the bot itself has invited the person back.
 * Delete chat never leaves a bot's room any more; it keeps it out of sight
 * (`APP_BOT_DM_HIDDEN`), so its history is never orphaned.
 */

/** The room state the desktop puts in a new bot chat's initial state (atum.app-bots/1 §4.1). */
export const APP_BOT_DM_MARKER = 'io.atum.app_bot.dm'

/** Delete chat on a bot's chat: per-person room account data (private to them, on every device
 * of theirs) holding when it was deleted. `{}` clears it: account data cannot be removed. */
export const APP_BOT_DM_HIDDEN = 'io.atum.app_bot.hidden'

const USER_ID = /^@[^:\s]+:[^\s]+$/u

/** Whether a value is a Matrix user id of the shape a bot's marker or pointer carries. */
export function isAppBotUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID.test(value)
}

export interface AppBotDmMarker {
  appId: string
  botUserId: string
}

/** The bot a room was made for, from its marker, and only when this account set the marker: a
 * room someone else made proves nothing. */
export function appBotDmMarker(room: Room, ownerId: string): AppBotDmMarker | null {
  const event = room.currentState.getStateEvents(APP_BOT_DM_MARKER, '')
  const content = event?.getContent<Record<string, unknown>>()

  return event &&
    event.getSender() === ownerId &&
    content?.v === 1 &&
    typeof content.app_id === 'string' &&
    APP_UUID.test(content.app_id) &&
    typeof content.bot_user_id === 'string' &&
    USER_ID.test(content.bot_user_id)
    ? { appId: content.app_id, botUserId: content.bot_user_id }
    : null
}

/**
 * Whether a room works as this bot's one-to-one chat now: this account's marker for this bot,
 * the person in it, and the bot in it (joined or invited) with nobody else, with or without
 * end-to-end encryption (0.20 makes bot chats plain; which of the two is opened is
 * `chooseAppBotDm`'s rule). Who was in it before no longer counts (it did until 0.19.4). The bot
 * service still keeps its own rule
 * (atum.app-bots/1 §3.2): a room that ever held a third person stays a group to the bot, so Andy
 * has left such a room (which fails "the bot in it") and Moon answers there only when named.
 */
export function appBotDmUsable(room: Room, ownerId: string, appId: string, botUserId: string): boolean {
  const marker = appBotDmMarker(room, ownerId)

  if (marker?.appId !== appId || marker.botUserId !== botUserId || room.getMyMembership() !== 'join') {
    return false
  }

  const present = room.getMembers().filter(member => member.membership === 'join' || member.membership === 'invite')

  return (
    present.some(member => member.userId === botUserId) &&
    present.every(member => member.userId === ownerId || member.userId === botUserId)
  )
}

/** When the room's latest message was sent, as far back as this device's timeline reaches; 0
 * for a room nobody has written in. */
export function appBotDmLastMessageAt(room: Room): number {
  const events = room.getLiveTimeline().getEvents()

  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!

    if (event.getType() === EventType.RoomMessage || event.getWireType() === EventType.RoomMessageEncrypted) {
      return event.getTs()
    }
  }

  return 0
}

/** When the person deleted this bot chat, if they did. */
export function appBotDmHiddenAt(room: Room): number | undefined {
  const content = room.getAccountData(APP_BOT_DM_HIDDEN)?.getContent<Record<string, unknown>>()

  return content?.v === 1 && typeof content.at === 'number' && Number.isSafeInteger(content.at) && content.at > 0
    ? content.at
    : undefined
}

/** The room this account's pointer names for the bot (atum.app-bots/1 §4.2), if it names one. */
export function appBotDmPointer(client: MatrixClient, appId: string, botUserId: string): string | undefined {
  const pointer = client.getAccountData(`io.atum.app_bot.dm.${appId}`)?.getContent<Record<string, unknown>>()

  return pointer?.v === 1 &&
    pointer.bot_user_id === botUserId &&
    typeof pointer.room_id === 'string' &&
    pointer.room_id.startsWith('!') &&
    pointer.room_id.length <= 1024
    ? pointer.room_id
    : undefined
}

/** One room the person has, or had, with the bot. */
export interface AppBotDmCandidate {
  roomId: string
  /** Still in it, invited back, or gone: left, banned, or a room this device no longer holds (a
   * left room is not kept across a restart, and Delete chat used to forget the room too). */
  membership: 'join' | 'invite' | 'gone'
  usable: boolean
  /** Invited by the bot itself: the only invitation the desktop accepts on the person's behalf. */
  invitedByBot: boolean
  /** The room has end-to-end encryption: a chat made before 0.20. Opening the bot moves out of
   * it into a plain chat once (`moved`); it is never opened as the bot's chat again. */
  encrypted: boolean
  lastMessageAt: number
  lastActiveAt: number
}

export type AppBotDmChoice =
  | { action: 'open' | 'join'; roomId: string; outcome: AppBotDmOutcome; reason: AppBotDmReason }
  /** `retire`: the encrypted chat the person is moving out of, marked moved before the new one
   * is made (`io.atum.app_bot.legacy_moved`, the existing "moved" note). */
  | { action: 'create'; outcome: AppBotDmOutcome; reason: AppBotDmReason; retire?: string }

/** What this device knows about one room id: rooms it holds are read; any other is gone. */
export function appBotDmCandidate(
  client: MatrixClient,
  roomId: string,
  appId: string,
  botUserId: string
): AppBotDmCandidate {
  const room = client.getRoom(roomId)
  const membership = room?.getMyMembership()
  const ownerId = client.getSafeUserId()

  if (!room || (membership !== 'join' && membership !== 'invite')) {
    return {
      roomId,
      membership: 'gone',
      usable: false,
      invitedByBot: false,
      encrypted: false,
      lastMessageAt: 0,
      lastActiveAt: 0
    }
  }

  // An invitation's stripped state carries the encryption state too.
  const encrypted = room.hasEncryptionStateEvent()

  if (membership === 'invite') {
    const invite = room.currentState.getStateEvents(EventType.RoomMember, ownerId)

    return {
      roomId,
      membership,
      usable: false,
      invitedByBot: invite?.getContent().membership === 'invite' && invite.getSender() === botUserId,
      encrypted,
      lastMessageAt: 0,
      lastActiveAt: room.getLastActiveTimestamp()
    }
  }

  return {
    roomId,
    membership,
    usable: appBotDmUsable(room, ownerId, appId, botUserId),
    invitedByBot: false,
    encrypted,
    lastMessageAt: appBotDmLastMessageAt(room),
    lastActiveAt: room.getLastActiveTimestamp()
  }
}

/** The room with the most history first: the latest message, then the latest activity. */
function byHistory(left: AppBotDmCandidate, right: AppBotDmCandidate) {
  return (
    right.lastMessageAt - left.lastMessageAt ||
    right.lastActiveAt - left.lastActiveAt ||
    left.roomId.localeCompare(right.roomId)
  )
}

/** Why the pointer's room was not opened, when another room is opened or made instead. */
function pointerReason(pointer: AppBotDmCandidate | undefined): AppBotDmReason {
  if (!pointer) {
    return 'pointer_missing'
  }

  if (pointer.usable) {
    return pointer.encrypted ? 'pointer_encrypted' : 'pointer_empty'
  }

  return pointer.membership === 'join' ? 'pointer_unusable' : 'pointer_left'
}

/**
 * Which room opening the bot uses, in order. Since 0.20 the bot's chat is a plain room (owner
 * decision D1): a working room with end-to-end encryption (made before 0.20) is never opened as
 * its chat, and a plain room always beats it, whatever the pointer names.
 * 1. a plain room the person left that the bot has invited them back to, when no working plain
 *    room has a message: the bot invites the person back into the room that holds their
 *    history, and an empty working room must not keep them out of it. A working room with
 *    messages wins over an invitation: the person is already talking there;
 * 2. the pointer's room, when it works and is plain (unless it is empty and another working
 *    plain room has messages);
 * 3. the working plain room with the most recent message, else the most recently active one;
 * 4. `moved`: only encrypted rooms work. The one the pointer names (else the one with the most
 *    history) is marked moved, and a new plain room is made; from then on the plain room is
 *    reused. Its history stays readable where its keys are;
 * 5. a new room: `rejoin_impossible` when rooms the person left exist (they are invite-only and
 *    the desktop never tries a join that the server refuses), else `created`.
 */
export function chooseAppBotDm(
  pointedId: string | undefined,
  candidates: readonly AppBotDmCandidate[]
): AppBotDmChoice {
  const pointer = pointedId ? candidates.find(candidate => candidate.roomId === pointedId) : undefined
  const usable = candidates.filter(candidate => candidate.usable && !candidate.encrypted).sort(byHistory)
  const talked = usable.some(candidate => candidate.lastMessageAt > 0)

  const invited = [
    ...(pointer ? [pointer] : []),
    ...candidates.filter(candidate => candidate !== pointer).sort(byHistory)
  ].find(candidate => candidate.membership === 'invite' && candidate.invitedByBot && !candidate.encrypted)

  if (invited && !talked) {
    return { action: 'join', roomId: invited.roomId, outcome: 'rejoined', reason: 'invited' }
  }

  if (pointer?.usable && !pointer.encrypted && (pointer.lastMessageAt > 0 || !talked)) {
    return { action: 'open', roomId: pointer.roomId, outcome: 'reused', reason: 'pointer' }
  }

  const best = usable[0]

  if (best) {
    return { action: 'open', roomId: best.roomId, outcome: 'recovered', reason: pointerReason(pointer) }
  }

  const old = pointer?.usable
    ? pointer
    : candidates.filter(candidate => candidate.usable && candidate.encrypted).sort(byHistory)[0]

  if (old) {
    return { action: 'create', outcome: 'moved', reason: pointerReason(pointer), retire: old.roomId }
  }

  if (candidates.some(candidate => candidate.membership === 'gone')) {
    return { action: 'create', outcome: 'rejoin_impossible', reason: 'invite_only' }
  }

  return { action: 'create', outcome: 'created', reason: candidates.length > 0 ? 'no_usable_room' : 'first_use' }
}

/** The bots this account has a pointer for (atum.app-bots/1 §4.2), keyed like `appBotDmRooms`. */
function pointedBots(client: MatrixClient): AppBotDmMarker[] {
  const bots: AppBotDmMarker[] = []

  for (const [type, event] of client.store.accountData) {
    const appId = type.startsWith('io.atum.app_bot.dm.') ? type.slice('io.atum.app_bot.dm.'.length) : ''
    const botUserId = event.getContent<Record<string, unknown>>().bot_user_id

    if (
      APP_UUID.test(appId) &&
      typeof botUserId === 'string' &&
      USER_ID.test(botUserId) &&
      appBotDmPointer(client, appId, botUserId)
    ) {
      bots.push({ appId, botUserId })
    }
  }

  return bots
}

/**
 * The rooms the bot has invited the person back to: listed under the bot in the person's
 * `m.direct`, and the invitation sent by the bot itself. Its marker cannot be read before the
 * person joins, so these two together say whose chat it is.
 */
function appBotDmInvites(client: MatrixClient, botUserId: string): Room[] {
  const direct = client.getAccountData(EventType.Direct)?.getContent<Record<string, unknown>>()?.[botUserId]
  const ownerId = client.getSafeUserId()

  return (Array.isArray(direct) ? direct : []).flatMap(id => {
    const room = typeof id === 'string' ? client.getRoom(id) : null
    const invite = room?.getMyMembership() === 'invite' ? room.currentState.getStateEvents(EventType.RoomMember, ownerId) : null

    return room && invite?.getContent().membership === 'invite' && invite.getSender() === botUserId ? [room] : []
  })
}

/**
 * Every room this device holds that is an official bot's chat, for the roster: the rooms that
 * work as its chat, and the rooms the bot has invited the person back to. Which one each bot's
 * row opens (the room `chooseAppBotDm` would use, so a click lands where the row points) and
 * which ones the person deleted. A deleted chat shows again once something newer than the
 * deletion arrives in it. An invitation from the bot is drawn in the bot's row too, never as a
 * second row of its own.
 */
export function appBotDmRooms(client: MatrixClient): Map<string, MatrixRoomAppBot> {
  const ownerId = client.getSafeUserId()
  const bots = new Map<string, { marker: AppBotDmMarker; rooms: Room[] }>()

  const bot = (marker: AppBotDmMarker) => {
    const key = `${marker.appId}\u0000${marker.botUserId}`
    const value = bots.get(key) ?? { marker, rooms: [] }
    bots.set(key, value)

    return value
  }

  for (const room of client.getRooms()) {
    const marker = room.getMyMembership() === 'join' ? appBotDmMarker(room, ownerId) : null

    if (marker && appBotDmUsable(room, ownerId, marker.appId, marker.botUserId)) {
      bot(marker).rooms.push(room)
    }
  }

  // A bot whose every room the person left still has its pointer, and its invitations back.
  pointedBots(client).forEach(bot)

  const rooms = new Map<string, MatrixRoomAppBot>()

  for (const { marker, rooms: held } of bots.values()) {
    const invites = appBotDmInvites(client, marker.botUserId).filter(room => !rooms.has(room.roomId))
    const all = [...held, ...invites]
    const candidates = all.map(room => appBotDmCandidate(client, room.roomId, marker.appId, marker.botUserId))
    const choice = chooseAppBotDm(appBotDmPointer(client, marker.appId, marker.botUserId), candidates)

    all.forEach((room, index) => {
      const hiddenAt = room.getMyMembership() === 'join' ? appBotDmHiddenAt(room) : undefined

      rooms.set(room.roomId, {
        appId: marker.appId,
        botUserId: marker.botUserId,
        ...(choice.action !== 'create' && choice.roomId === room.roomId ? { current: true as const } : {}),
        ...(hiddenAt !== undefined && candidates[index]!.lastMessageAt <= hiddenAt ? { hidden: true as const } : {})
      })
    })
  }

  return rooms
}

/** Delete chat on a bot's chat: keep the room, out of sight, on every device of the person's. */
export async function hideAppBotDm(client: MatrixClient, room: Room): Promise<void> {
  const content = { v: 1 as const, at: Math.max(Date.now(), appBotDmLastMessageAt(room)) }

  await client.setRoomAccountData(room.roomId, APP_BOT_DM_HIDDEN, content)
  // The server holds it now; its sync echo can lag, and the chat should leave the list at once.
  room.addAccountData([new MatrixEvent({ type: APP_BOT_DM_HIDDEN, content })])
}

/** Opening the bot shows its deleted chat again. Answers whether there was one to show. */
export async function showAppBotDm(client: MatrixClient, roomId: string): Promise<boolean> {
  const room = client.getRoom(roomId)

  if (!room || appBotDmHiddenAt(room) === undefined) {
    return false
  }

  await client.setRoomAccountData(roomId, APP_BOT_DM_HIDDEN, {})
  room.addAccountData([new MatrixEvent({ type: APP_BOT_DM_HIDDEN, content: {} })])

  return true
}
