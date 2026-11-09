/** `atum.pet-chat/1` (spec/pet-chat/v1, pinned bda64f81). One pet, one short chat
 * turn. The pet is a companion, never an assistant: the request carries only its
 * own ref, a message id, the owner's text and the locale. */

export const ATUM_PET_CHAT_LOCALES = ['vi', 'en', 'ja', 'zh', 'zh-hant'] as const
export const ATUM_PET_CHAT_BUNDLED_SLUGS = ['gigi', 'cookie', 'mochi', 'bailey'] as const
export const ATUM_PET_CHAT_MESSAGE_MAX = 500
export const ATUM_PET_CHAT_REPLY_MAX = 240
export const ATUM_PET_CHAT_TURNS_MAX = 8
export const ATUM_PET_CHAT_DAILY_CAP = 200
export const ATUM_PET_CHAT_PERSONALITY_MAX = 4000
export const ATUM_PET_CHAT_MEMORY_MAX = 600

export type AtumPetChatLocale = (typeof ATUM_PET_CHAT_LOCALES)[number]
export type AtumPetChatBundledSlug = (typeof ATUM_PET_CHAT_BUNDLED_SLUGS)[number]

export type AtumPetChatRef = { kind: 'bundled'; slug: AtumPetChatBundledSlug } | { kind: 'personal'; pet_id: string }

export interface AtumPetChatRequest {
  ref: AtumPetChatRef
  message_id: string
  message: string
  locale: AtumPetChatLocale
}

export interface AtumPetChatHistoryRequest {
  ref: AtumPetChatRef
}

export interface AtumPetChatTurn {
  role: 'user' | 'pet'
  text: string
  at: string
}

export type AtumPetChatAction =
  | { action: 'sit' | 'lounge' | 'sleep' | 'jump' | 'wave' }
  | { action: 'go'; place: 'center' }

export interface AtumPetChatReply {
  v: 1
  reply: string
  action: AtumPetChatAction | null
  recent: AtumPetChatTurn[]
  messages_today: number
  daily_cap: typeof ATUM_PET_CHAT_DAILY_CAP
}

export interface AtumPetChatHistory {
  v: 1
  pet_key: string
  display_name: string
  personality: string
  memory_summary: string
  recent: AtumPetChatTurn[]
  messages_today: number
  daily_cap: typeof ATUM_PET_CHAT_DAILY_CAP
}

export type AtumPetChatErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'insufficient_protons'
  | 'forbidden'
  | 'rate_limited'
  | 'temporarily_unavailable'

export type AtumPetChatResult = { ok: true; reply: AtumPetChatReply } | { ok: false; code: AtumPetChatErrorCode }

export type AtumPetChatHistoryResult =
  | { ok: true; history: AtumPetChatHistory }
  | { ok: false; code: AtumPetChatErrorCode }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

const PET_KEY =
  /^(?:bundled:(?:gigi|cookie|mochi|bailey)|personal:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.]\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u

const FORBIDDEN = new Set([
  'assistant_id',
  'room_id',
  'conversation_id',
  'agent_id',
  'principal',
  'owner_id',
  'owner_user_id',
  'account_id',
  'model',
  'tools',
  'tool_choice',
  'system'
])

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_pet_chat')
  }

  return value as Record<string, unknown>
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]) {
  for (const key of Object.keys(row)) {
    if (!keys.includes(key) || FORBIDDEN.has(key)) {
      throw new Error('invalid_pet_chat')
    }
  }
}

function string(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || [...value].length < min || [...value].length > max) {
    throw new Error('invalid_pet_chat')
  }

  return value
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error('invalid_pet_chat')
  }

  return value
}

function locale(value: unknown): AtumPetChatLocale {
  if (typeof value !== 'string' || !ATUM_PET_CHAT_LOCALES.includes(value as AtumPetChatLocale)) {
    throw new Error('invalid_pet_chat')
  }

  return value as AtumPetChatLocale
}

export function parseAtumPetChatRef(value: unknown): AtumPetChatRef {
  const row = record(value)

  if (row.kind === 'bundled') {
    exactKeys(row, ['kind', 'slug'])

    if (!ATUM_PET_CHAT_BUNDLED_SLUGS.includes(row.slug as AtumPetChatBundledSlug)) {
      throw new Error('invalid_pet_chat')
    }

    return { kind: 'bundled', slug: row.slug as AtumPetChatBundledSlug }
  }

  if (row.kind === 'personal') {
    exactKeys(row, ['kind', 'pet_id'])

    return { kind: 'personal', pet_id: uuid(row.pet_id) }
  }

  throw new Error('invalid_pet_chat')
}

export function atumPetChatRefKey(ref: AtumPetChatRef): string {
  return ref.kind === 'bundled' ? `bundled:${ref.slug}` : `personal:${ref.pet_id}`
}

export function parseAtumPetChatRequest(value: unknown): AtumPetChatRequest {
  const row = record(value)
  exactKeys(row, ['ref', 'message_id', 'message', 'locale'])

  return {
    ref: parseAtumPetChatRef(row.ref),
    message_id: uuid(row.message_id),
    message: string(row.message, 1, ATUM_PET_CHAT_MESSAGE_MAX),
    locale: locale(row.locale)
  }
}

export function parseAtumPetChatHistoryRequest(value: unknown): AtumPetChatHistoryRequest {
  const row = record(value)
  exactKeys(row, ['ref'])

  return { ref: parseAtumPetChatRef(row.ref) }
}

export function parseAtumPetChatTurn(value: unknown): AtumPetChatTurn {
  const row = record(value)
  exactKeys(row, ['role', 'text', 'at'])

  if (row.role !== 'user' && row.role !== 'pet') {
    throw new Error('invalid_pet_chat')
  }

  if (typeof row.at !== 'string' || !TIMESTAMP.test(row.at) || !Number.isFinite(Date.parse(row.at))) {
    throw new Error('invalid_pet_chat')
  }

  return {
    role: row.role,
    text: string(row.text, 1, row.role === 'user' ? ATUM_PET_CHAT_MESSAGE_MAX : ATUM_PET_CHAT_REPLY_MAX),
    at: row.at
  }
}

export function parseAtumPetChatTurns(value: unknown): AtumPetChatTurn[] {
  if (!Array.isArray(value) || value.length > ATUM_PET_CHAT_TURNS_MAX) {
    throw new Error('invalid_pet_chat')
  }

  return value.map(parseAtumPetChatTurn)
}

export function parseAtumPetChatAction(value: unknown): AtumPetChatAction | null {
  if (value === null) {
    return null
  }

  const row = record(value)

  if (row.action === 'go') {
    exactKeys(row, ['action', 'place'])

    if (row.place !== 'center') {
      throw new Error('invalid_pet_chat')
    }

    return { action: 'go', place: 'center' }
  }

  exactKeys(row, ['action'])

  if (!['sit', 'lounge', 'sleep', 'jump', 'wave'].includes(row.action as string)) {
    throw new Error('invalid_pet_chat')
  }

  return { action: row.action as 'sit' | 'lounge' | 'sleep' | 'jump' | 'wave' }
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > ATUM_PET_CHAT_DAILY_CAP) {
    throw new Error('invalid_pet_chat')
  }

  return Number(value)
}

function dailyCap(value: unknown): typeof ATUM_PET_CHAT_DAILY_CAP {
  if (value !== ATUM_PET_CHAT_DAILY_CAP) {
    throw new Error('invalid_pet_chat')
  }

  return ATUM_PET_CHAT_DAILY_CAP
}

export function parseAtumPetChatReply(value: unknown): AtumPetChatReply {
  const row = record(value)

  if (row.v !== 1 || !('action' in row)) {
    throw new Error('invalid_pet_chat')
  }

  return {
    v: 1,
    reply: string(row.reply, 1, ATUM_PET_CHAT_REPLY_MAX),
    action: parseAtumPetChatAction(row.action),
    recent: parseAtumPetChatTurns(row.recent),
    messages_today: count(row.messages_today),
    daily_cap: dailyCap(row.daily_cap)
  }
}

export function parseAtumPetChatHistory(value: unknown): AtumPetChatHistory {
  const row = record(value)

  if (row.v !== 1 || typeof row.pet_key !== 'string' || !PET_KEY.test(row.pet_key)) {
    throw new Error('invalid_pet_chat')
  }

  if (typeof row.personality !== 'string' || [...row.personality].length > ATUM_PET_CHAT_PERSONALITY_MAX) {
    throw new Error('invalid_pet_chat')
  }

  if (typeof row.memory_summary !== 'string' || [...row.memory_summary].length > ATUM_PET_CHAT_MEMORY_MAX) {
    throw new Error('invalid_pet_chat')
  }

  return {
    v: 1,
    pet_key: row.pet_key,
    display_name: string(row.display_name, 1, 400),
    personality: row.personality,
    memory_summary: row.memory_summary,
    recent: parseAtumPetChatTurns(row.recent),
    messages_today: count(row.messages_today),
    daily_cap: dailyCap(row.daily_cap)
  }
}

const ERROR_CODES: readonly AtumPetChatErrorCode[] = [
  'invalid_request',
  'not_found',
  'insufficient_protons',
  'forbidden',
  'rate_limited',
  'temporarily_unavailable'
]

export function parseAtumPetChatError(value: unknown): AtumPetChatErrorCode {
  const row = record(value)
  const error = record(row.error)
  const code = error.code

  if (typeof code !== 'string' || !ERROR_CODES.includes(code as AtumPetChatErrorCode)) {
    throw new Error('invalid_pet_chat')
  }

  return code as AtumPetChatErrorCode
}

export function isAtumPetChatErrorCode(value: unknown): value is AtumPetChatErrorCode {
  return typeof value === 'string' && ERROR_CODES.includes(value as AtumPetChatErrorCode)
}
