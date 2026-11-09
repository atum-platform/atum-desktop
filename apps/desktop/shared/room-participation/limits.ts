/** Owner-only meeting rooms default to everyone (Plan 1, owner decision 2026-10-06): the server's
 * per-room daily cap (0200/0206) is live in production since 2026-10-08, so answers stay bounded. */
export const MATRIX_MEETING_DEFAULT = 'joins' as const
export const EVERYONE_ANSWERS_MAX = 2
export const DAILY_TURNS_DEFAULT = 30
export const DAILY_TURNS_MIN = 1
export const DAILY_TURNS_MAX = 200
export const GROUP_FRESHNESS_MS = 120_000
export const FLOOR_WAIT_MS = 180_000
export const FLOOR_POLL_MS = 2_000
export const FLOOR_MAX_AGE_MS = GROUP_FRESHNESS_MS + FLOOR_WAIT_MS + 30_000
export const CHAIN_DEPTH_MAX = 3
export const CHAIN_TURNS_MAX = 6
export const CHAIN_ORIGIN_AGE_MS = 600_000
export const RECENT_MESSAGES = 50
export const RECENT_CHARS = 12_000
export const RECENT_PAGES = 3
export const RECENT_DEADLINE_MS = 8_000
export const ROOM_AGENTS_ACCOUNT_DATA = 'io.atum.room.agents'
export const ROOM_USAGE_ACCOUNT_DATA = 'io.atum.room.usage'
