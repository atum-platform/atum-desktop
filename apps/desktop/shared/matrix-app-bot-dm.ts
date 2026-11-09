/**
 * What opening an official bot's chat did (Moon, Andy), as the SDK answers main: which room it
 * opened and which rung of the ladder chose it (src/matrix/app-bot-dm.ts). Main writes it as one
 * diagnostic line per open; no message content and no room id crosses, only closed codes, counts
 * and the room id main hashes for the log.
 *
 * Until the server owns each person's bot room (S4 of the 2026-10-09 simplification plan), the
 * desktop picks it. The ladder never makes a new room while a usable one exists:
 * - `reused`: the room the account's pointer names;
 * - `recovered`: another room with this bot that still works, and the pointer now names it;
 * - `rejoined`: a room with this bot the person had left, where the bot has invited them back;
 * - `rejoin_impossible`: every room with this bot is one the person left, and a left room
 *   cannot be rejoined without an invitation (the rooms are invite-only), so a new one was made;
 * - `created`: there was no room with this bot to use;
 * - `moved`: the only working rooms with this bot had end-to-end encryption (made before 0.20,
 *   owner decision D1); the old one was marked moved and a new plain room was made. It happens
 *   once per bot: afterwards the plain room is `reused`.
 *
 * When the platform names the room first (`POST /api/matrix/v1/apps/{slug}/bot/start`,
 * spec/canonical-room/v1.1; electron/matrix/app-bots/platform-room.ts) the same words say what this
 * device did with the room it was given: `reused` (its pointer already named it), `recovered`
 * (another device's room, or one the pointer did not name), `created` (this device made it and the
 * platform kept it) and `moved` (an encrypted chat from before 0.20 was left behind for it).
 */
export const APP_BOT_DM_OUTCOMES = ['reused', 'recovered', 'rejoined', 'created', 'rejoin_impossible', 'moved'] as const

export type AppBotDmOutcome = (typeof APP_BOT_DM_OUTCOMES)[number]

/**
 * Why that rung:
 * - `pointer`: the pointer's room works;
 * - `pointer_missing`: no pointer yet (or one this device cannot read);
 * - `pointer_left`: the pointer names a room the person left;
 * - `pointer_unusable`: the person is still in the pointer's room, but it is no longer the
 *   bot's one-to-one chat (the bot left it, or someone else is in it);
 * - `pointer_empty`: the pointer's room has no messages while another room with the bot has;
 * - `pointer_encrypted`: the pointer's room works but has end-to-end encryption (before 0.20);
 * - `invited`: the bot invited the person back into a room they had left;
 * - `invite_only`: rooms the person left exist, and none can be rejoined;
 * - `no_usable_room`: rooms with the bot exist, and none works as its chat;
 * - `first_use`: no room with the bot ever;
 * - `canonical`: the platform named the room (the server arbitrates which room is the bot's chat
 *   when several devices start at once), so no rung of the local ladder chose it.
 */
export const APP_BOT_DM_REASONS = [
  'pointer',
  'pointer_missing',
  'pointer_left',
  'pointer_unusable',
  'pointer_empty',
  'pointer_encrypted',
  'invited',
  'invite_only',
  'no_usable_room',
  'first_use',
  'canonical'
] as const

export type AppBotDmReason = (typeof APP_BOT_DM_REASONS)[number]

/**
 * What the open did to the account's pointer to the bot's chat:
 * - `kept`: it already named the opened room;
 * - `written`: it names the opened room now;
 * - `write_failed`: the write failed; the room still opened, and the next open chooses again.
 */
export const APP_BOT_DM_POINTER = ['kept', 'written', 'write_failed'] as const

export type AppBotDmPointer = (typeof APP_BOT_DM_POINTER)[number]

/**
 * Whether the person had deleted the opened chat (Delete chat keeps a bot's room, out of sight):
 * - `none`: they had not;
 * - `shown`: they had, and opening the bot showed it again on every device of theirs;
 * - `failed`: they had, and showing it again failed; it opens here, and stays out of the list
 *   on their other devices.
 */
export const APP_BOT_DM_SHOWN = ['none', 'shown', 'failed'] as const

export type AppBotDmShown = (typeof APP_BOT_DM_SHOWN)[number]

export interface AppBotDmOpened {
  roomId: string
  outcome: AppBotDmOutcome
  reason: AppBotDmReason
  /** Rooms with this bot that work as its chat, the opened one included. */
  joined: number
  /** Rooms with this bot the person has left (or that this device no longer holds). */
  left: number
  pointer: AppBotDmPointer
  shown: AppBotDmShown
}

/** The room this device already has as the bot's plain chat, to offer the platform (it records it
 * as the canonical one if none is yet), and the selection the person had when it was looked for. */
export interface AppBotDmFound {
  roomId: string | null
  /** Passed back to `openAppBotRoom`: a room opens only if the person has not chosen another since. */
  selection: number
}

/** A plain one-to-one chat with the bot this device has just made (not selected, no pointer yet).
 * `moved`: an encrypted chat from before 0.20 was marked moved on the way. */
export interface AppBotDmMade {
  roomId: string
  moved: boolean
}

/** Whether a room that lost the race was left (only while nobody had written in it). */
export interface AppBotDmLeft {
  left: boolean
}

/** What Delete chat did to an official bot's chat: kept it, out of sight (never left). */
export interface AppBotDmHidden {
  outcome: 'hidden'
  appId: string
}

function row(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000
}

/** The SDK's answer to `openAppBotDm`, read strictly: anything else is not an answer. */
export function parseAppBotDmOpened(value: unknown): AppBotDmOpened | null {
  const opened = row(value)

  if (
    !opened ||
    typeof opened.roomId !== 'string' ||
    !opened.roomId.startsWith('!') ||
    opened.roomId.length > 1024 ||
    !APP_BOT_DM_OUTCOMES.includes(opened.outcome as AppBotDmOutcome) ||
    !APP_BOT_DM_REASONS.includes(opened.reason as AppBotDmReason) ||
    !count(opened.joined) ||
    !count(opened.left) ||
    !APP_BOT_DM_POINTER.includes(opened.pointer as AppBotDmPointer) ||
    !APP_BOT_DM_SHOWN.includes(opened.shown as AppBotDmShown)
  ) {
    return null
  }

  return {
    roomId: opened.roomId,
    outcome: opened.outcome as AppBotDmOutcome,
    reason: opened.reason as AppBotDmReason,
    joined: opened.joined,
    left: opened.left,
    pointer: opened.pointer as AppBotDmPointer,
    shown: opened.shown as AppBotDmShown
  }
}

const CANONICAL_ROOM_ID = /^![!-9;-~]+:[!-~]+$/u
const CANONICAL_USER_ID = /^@[!-9;-~]+:[!-~]+$/u

/** A room id as the platform's canonical-room contract writes it: server-qualified, printable. */
export function isCanonicalMatrixRoomId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 4 && value.length <= 1024 && CANONICAL_ROOM_ID.test(value)
}

/** A Matrix user id as the platform's canonical-room contract writes it. */
export function isCanonicalMatrixUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 4 && value.length <= 1024 && CANONICAL_USER_ID.test(value)
}

/** The SDK's answer to `findAppBotDm`, read strictly. */
export function parseAppBotDmFound(value: unknown): AppBotDmFound | null {
  const found = row(value)
  const named = found?.roomId
  const roomId = named === null ? null : isCanonicalMatrixRoomId(named) ? named : undefined
  const selection = found?.selection

  if (roomId === undefined || typeof selection !== 'number' || !Number.isSafeInteger(selection) || selection < 0) {
    return null
  }

  return { roomId, selection }
}

/** The SDK's answer to `makeAppBotDm`, read strictly. */
export function parseAppBotDmMade(value: unknown): AppBotDmMade | null {
  const made = row(value)

  return made && isCanonicalMatrixRoomId(made.roomId) && typeof made.moved === 'boolean'
    ? { roomId: made.roomId, moved: made.moved }
    : null
}

/** The SDK's answer to `leaveAppBotDm`, read strictly. */
export function parseAppBotDmLeft(value: unknown): AppBotDmLeft | null {
  const left = row(value)

  return left && typeof left.left === 'boolean' ? { left: left.left } : null
}

/** The SDK's answer to Delete chat when the chat was an official bot's: kept, out of sight. */
export function parseAppBotDmHidden(value: unknown): AppBotDmHidden | null {
  const hidden = row(value)

  return hidden?.outcome === 'hidden' && typeof hidden.appId === 'string' && hidden.appId.length <= 64
    ? { outcome: 'hidden', appId: hidden.appId }
    : null
}
