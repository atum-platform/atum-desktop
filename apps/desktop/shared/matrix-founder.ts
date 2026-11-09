import type { AppRosterState } from './app-catalog'
import { parseVerificationTier, type VerificationTier } from './verification'

/**
 * The Founder chat (owner decisions 2026-09-29 and 2026-10-05; plan
 *  §5): a person's own client makes one
 * chat with the platform's founder, once per account, and never again on its own after they leave
 * it. Since 2026-10-25 (owner) nothing is made when the platform is read or the roster is drawn:
 * the roster offers a local draft, and the chat (with its one invitation) is made by the person's
 * first message, as Element Web does for a direct chat (its `LocalRoom`, made on the first send).
 *
 * `io.atum.founder_chat` names two records, both written by the person's client:
 *
 * - account data, the person's record of their Founder chat: `{ v: 1, founder, room, at }`.
 *   Any record at all, even one this build cannot read, means the chat was made once and is
 *   never made again automatically;
 * - room state (state key ''), the room's own mark: `{ v: 1, founder }`, so a chat this
 *   account made and has not recorded yet is found and adopted, never duplicated.
 */
export const MATRIX_FOUNDER_CHAT_MARKER = 'io.atum.founder_chat'

/** The platform's official-accounts profile (atum-platform spec/official-accounts/v1). */
export const MATRIX_OFFICIAL_ACCOUNTS_PROFILE = 'atum.official-accounts/1'

/** The most accounts the platform lists. */
export const MATRIX_OFFICIAL_ACCOUNTS_MAX = 64

/** One account Atum marks, by its Matrix id: its tier, and its role and handle when it has them.
 * The optional roster fields are effective owner-scoped presentation only (amendment
 * 2026-10-21); they never change identity, tier, role, handle or the founder wrapper. */
export interface MatrixOfficialAccount {
  userId: string
  tier: VerificationTier
  role?: 'founder'
  handle?: string
  rosterDefault?: boolean
  rosterOrder?: number
  rosterState?: AppRosterState
}

/** Effective owner-scoped roster presentation for the configured Founder. Legacy producers
 * omit both fields; `matrixFounderRoster` resolves that to the previous default behavior. */
export interface MatrixFounderRoster {
  /** Server suggestion for a new account with no record. Never a permission or a rewrite. */
  default: boolean
  /** Effective order; the reviewed Founder base fallback is 0. */
  order: number
  /** Presentation-only. `coming_soon` suppresses automatic creation but grants nothing. */
  state: AppRosterState
}

/** The founder as the window shows them: always official; `roomId` once this account's
 * Founder chat exists (main sets it only when the SDK's record names this founder). The
 * roster fields are presentation only: an existing human DM stays verified and usable when
 * the server default is off. */
export interface MatrixFounderView {
  userId: string
  verification: 'official'
  roomId?: string
  /** Set while this account has no record of a Founder chat and the platform's default roster
   * offers one: the window draws a local draft row. Nothing exists on the server until the
   * person's first message makes the chat (`MatrixFounderSdkCommandexplicit`). */
  offer?: true
  handle?: string
  rosterDefault?: boolean
  rosterOrder?: number
  rosterState?: AppRosterState
}

/**
 * The effective Founder roster presentation: the parsed official-account row when it carries
 * the amendment fields, else the legacy default/available presentation. `undefined` while the
 * platform names no founder or cannot be read, so callers never guess on that state.
 */
export function matrixFounderRoster(official: MatrixOfficialAccounts | undefined): MatrixFounderRoster | undefined {
  const founder = official?.founder?.userId

  if (!founder) {
    return undefined
  }

  const row = official.accounts.find(account => account.userId === founder)

  return {
    default: row?.rosterDefault ?? true,
    order: row?.rosterOrder ?? 0,
    state: row?.rosterState ?? 'available'
  }
}

/** The SDK's view of the account-data record: unknown until synced; any record is present
 * (one this build cannot read has empty `founder` and `roomId`, and still counts). */
export type MatrixFounderChatMarker =
  | { state: 'unknown' }
  | { state: 'absent' }
  | { state: 'present'; founder: string; roomId: string }

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export type MatrixFounderSdkCommand = {
  kind: 'founderChat'
  founder: string | null
  create: 'explicit' | 'none'
}

/**
 * What the SDK did. `declined`: nothing is made on its own: either a record exists and its chat
 * is no longer joined (the person left it, or the founder did), or the founder was only
 * configured (`none`). `waiting`: nothing was made yet and a later try may succeed.
 * `founder_mode`: this account is the founder.
 */
export type MatrixFounderChatResult =
  | { state: 'ready'; roomId: string }
  | { state: 'declined' }
  | { state: 'waiting'; reason: 'not_synced' | 'founder_not_ready' | 'offline' }
  | { state: 'founder_mode' }
  | { state: 'disabled' }

/** The Founder chat made or found, and selected; or nothing to open (the window offers the email). */
export type MatrixFounderContactResult = { roomId: string } | { unavailable: true }

/** The window's one Founder capability: make (or find) the chat and select it. The window asks
 * only when the person sends the first message of a Founder draft; opening the draft asks for
 * nothing and invites no one. */
export interface MatrixFounderBridge {
  contact(): Promise<MatrixFounderContactResult>
}

/** The platform's answer: who the founder is, and every account that carries a mark. */
export interface MatrixOfficialAccounts {
  founder: { userId: string } | null
  accounts: MatrixOfficialAccount[]
}

/** The account-data record, as written: `{ v: 1, founder, room, at }`. */
export interface MatrixFounderChatRecord {
  v: 1
  founder: string
  room: string
  at: number
}

const MATRIX_USER = /^@[^:\s]+:\S+$/u
const MATRIX_ROOM = /^!\S+$/u
const HANDLE = /^[a-z][a-z0-9_]{2,31}$/u

/** A Matrix user id, by shape (at most 255 bytes, as Matrix allows). */
export function isMatrixFounderUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && MATRIX_USER.test(value)
}

/** A Matrix room id, by shape (older `!x:server` and newer `!x` ids alike). */
export function isMatrixFounderRoomId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 2 && value.length <= 255 && MATRIX_ROOM.test(value)
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function invalid(): never {
  throw new Error('matrix_official_accounts_invalid')
}

/**
 * Parses only the profile this build knows, with the platform's promises checked: at most 64
 * accounts, one row per account, and a named founder listed exactly once, official, with the
 * founder role (no other row may claim it). Known fields are copied; unknown optional fields
 * (the updates channel's room, later) are ignored. Anything else throws: an unreadable answer
 * is unavailable, never an empty list.
 */
export function parseOfficialAccounts(value: unknown): MatrixOfficialAccounts {
  const body = object(value)

  if (body?.profile !== MATRIX_OFFICIAL_ACCOUNTS_PROFILE) {
    throw new Error('matrix_official_accounts_profile')
  }

  if (!Array.isArray(body.accounts) || body.accounts.length > MATRIX_OFFICIAL_ACCOUNTS_MAX) {
    invalid()
  }

  const accounts = body.accounts.map(raw => {
    const row = object(raw)
    const tier = parseVerificationTier(row?.tier)

    if (
      !row ||
      !isMatrixFounderUserId(row.user_id) ||
      !tier ||
      !(row.role === undefined || row.role === null || row.role === 'founder') ||
      !(
        row.handle === undefined ||
        row.handle === null ||
        (typeof row.handle === 'string' && HANDLE.test(row.handle))
      ) ||
      (row.roster_default !== undefined && typeof row.roster_default !== 'boolean') ||
      (row.roster_order !== undefined &&
        (typeof row.roster_order !== 'number' ||
          !Number.isInteger(row.roster_order) ||
          row.roster_order < 0 ||
          row.roster_order > 2_147_483_647)) ||
      (row.roster_state !== undefined && row.roster_state !== 'available' && row.roster_state !== 'coming_soon')
    ) {
      invalid()
    }

    const rosterDefault = typeof row.roster_default === 'boolean' ? row.roster_default : undefined
    const rosterOrder = typeof row.roster_order === 'number' ? row.roster_order : undefined

    const rosterState: AppRosterState | undefined =
      row.roster_state === 'available' || row.roster_state === 'coming_soon' ? row.roster_state : undefined

    return {
      userId: row.user_id,
      tier,
      ...(row.role === 'founder' ? { role: 'founder' as const } : {}),
      ...(typeof row.handle === 'string' ? { handle: row.handle } : {}),
      ...(rosterDefault !== undefined ? { rosterDefault } : {}),
      ...(rosterOrder !== undefined ? { rosterOrder } : {}),
      ...(rosterState ? { rosterState } : {})
    }
  })

  if (new Set(accounts.map(account => account.userId)).size !== accounts.length) {
    invalid()
  }

  let founder: MatrixOfficialAccounts['founder'] = null

  if (body.founder !== null) {
    const named = object(body.founder)

    if (!named || !isMatrixFounderUserId(named.user_id)) {
      invalid()
    }

    founder = { userId: named.user_id }
  }

  const roles = accounts.filter(account => account.role === 'founder')

  if (
    founder
      ? roles.length !== 1 || roles[0]!.userId !== founder.userId || roles[0]!.tier !== 'official'
      : roles.length !== 0
  ) {
    invalid()
  }

  return { founder, accounts }
}

/** The account-data record, when this build can read it; null for anything else (which still
 * counts as a record: see MATRIX_FOUNDER_CHAT_MARKER). */
export function parseMatrixFounderChatRecord(value: unknown): MatrixFounderChatRecord | null {
  const record = object(value)

  return record &&
    record.v === 1 &&
    isMatrixFounderUserId(record.founder) &&
    isMatrixFounderRoomId(record.room) &&
    Number.isSafeInteger(record.at) &&
    (record.at as number) >= 0
    ? { v: 1, founder: record.founder, room: record.room, at: record.at as number }
    : null
}

/** The founder a room's own mark names (`{ v: 1, founder }`), else none. */
export function matrixFounderRoomMark(value: unknown): string | null {
  const mark = object(value)

  return mark?.v === 1 && isMatrixFounderUserId(mark.founder) ? mark.founder : null
}
