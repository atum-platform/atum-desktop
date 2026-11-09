import type { MatrixRoom } from '../../../apps/desktop/shared/matrix'

export interface ChatAgent {
  assistantId: string | null
  principal: string
  userId: string
  name: string
  avatarUrl: string | null
  isMain: boolean
  roomId: string | null
  answering: 'cloud' | 'local' | null
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const UUID_PATH = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const UUID = new RegExp(`^${UUID_PATH}$`, 'iu')
const AVATAR_ORIGIN = 'https://public-config.example.invalid'
const LOCAL_AVATAR_ORIGINS = new Set(['http://127.0.0.1:54321', 'http://localhost:54321'])
const ROOM_ID = /^![!-9;-~]+:[!-~]+$/u
const ROOM_ID_MIN_BYTES = 4
const ROOM_ID_MAX_BYTES = 1_024
const utf8 = new TextEncoder()

/** Contract 5: a canonical room ID or explicit null; a missing field is incompatible. */
function canonicalRoomId(row: Record<string, unknown>): string | null {
  if (!Object.hasOwn(row, 'roomId')) throw new Error('invalid_roster')
  const value = row.roomId
  if (value === null) return null
  if (typeof value !== 'string') throw new Error('invalid_roster')
  const bytes = utf8.encode(value).length
  if (bytes < ROOM_ID_MIN_BYTES || bytes > ROOM_ID_MAX_BYTES || !ROOM_ID.test(value)) throw new Error('invalid_roster')
  return value
}

/** Keep a compromised roster response from turning the authenticated app into an image beacon. */
function canonicalAvatarUrl(value: unknown, assistantId: string | null): string | null {
  if (value == null || !assistantId || typeof value !== 'string' || value.length > 2_048) return null
  try {
    const url = new URL(value)
    const localRuntime =
      typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
    if (
      (url.origin !== AVATAR_ORIGIN && !(localRuntime && LOCAL_AVATAR_ORIGINS.has(url.origin))) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !new RegExp(
        `^/storage/v1/object/public/atum-avatars-v1/assistants/principals/${UUID_PATH}/${assistantId}/${UUID_PATH}\\.(?:jpg|png|webp)$`,
        'iu'
      ).test(url.pathname)
    )
      return null
    return url.href
  } catch {
    return null
  }
}

/** Consumes platform 0244's exact canonical `roomId`; never guesses from names or legacy `room_id`. */
export function chatRoster(value: unknown): ChatAgent[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('invalid_roster')
  const seen = new Set<string>()
  return value.map(raw => {
    const row = object(raw)
    if (
      !row ||
      typeof row.agentPrincipal !== 'string' ||
      !row.agentPrincipal ||
      row.agentPrincipal.length > 128 ||
      typeof row.matrixUser !== 'string' ||
      row.matrixUser.length > 1_024 ||
      !/^@[^:\s]+:[^\s]+$/u.test(row.matrixUser) ||
      seen.has(row.agentPrincipal)
    )
      throw new Error('invalid_roster')
    seen.add(row.agentPrincipal)
    const roomId = canonicalRoomId(row)
    if (row.status != null && row.status !== 'active') throw new Error('invalid_roster')
    if (row.is_default != null && typeof row.is_default !== 'boolean') throw new Error('invalid_roster')
    const assistantId = typeof row.id === 'string' && UUID.test(row.id) ? row.id : null
    return {
      assistantId,
      principal: row.agentPrincipal,
      userId: row.matrixUser,
      name: typeof row.display_name === 'string' && row.display_name.trim() ? row.display_name.slice(0, 200) : 'Atum',
      avatarUrl: canonicalAvatarUrl(row.avatar_url, assistantId),
      isMain: row.is_default === true,
      roomId,
      answering: row.answering === 'cloud' || row.answering === 'local' ? row.answering : null
    }
  })
}

export function admittedChatRoom(agent: ChatAgent, rooms: readonly MatrixRoom[]): MatrixRoom | undefined {
  // SDK command admission rechecks live room policy. This is a UI gate, never authority.
  return agent.answering === 'cloud' && agent.roomId
    ? rooms.find(room => room.id === agent.roomId && room.membership === 'join' && !room.encrypted && room.plainAgent)
    : undefined
}
