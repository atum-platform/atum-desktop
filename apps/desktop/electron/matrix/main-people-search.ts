import type { MatrixAliasRequest, MatrixAliasView } from '../../shared/matrix-aliases'
import type {
  MatrixPeoplePrivacyResponse,
  MatrixPeopleSearchRequest,
  MatrixPeopleSearchResponse,
  MatrixPeopleSearchSdkCommand,
  MatrixPeopleSearchValue
} from '../../shared/matrix-people-search'

import { MatrixAliasError } from './aliases'
import { requireMatrixCaller } from './ipc-policy'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const HANDLE = /^[a-z][a-z0-9_]{2,31}$/u
const USER_ID = /^@[^:\s]+:[^\s]+$/u

interface Context {
  event: Parameters<typeof requireMatrixCaller>[0]
  ui: Parameters<typeof requireMatrixCaller>[1]
  uiUrl: string
  closing: boolean
  available(): boolean
  alias(input: MatrixAliasRequest): Promise<MatrixAliasView>
  sdk(command: MatrixPeopleSearchSdkCommand): Promise<unknown>
}

function gate(context: Context) {
  requireMatrixCaller(context.event, context.ui, context.uiUrl)
  return context.closing ? 'unavailable' as const : !context.available() ? 'authentication' as const : null
}

function parse(input: unknown): MatrixPeopleSearchRequest | null {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2) {
    return null
  }
  const { query, limit } = input as Record<string, unknown>
  return typeof query === 'string' && query === query.trim() && [...query].length >= 2 && [...query].length <= 80 &&
    Number.isSafeInteger(limit) && Number(limit) >= 1 && Number(limit) <= 25 ? { query, limit: Number(limit) } : null
}

function value(raw: unknown, limit: number): MatrixPeopleSearchValue {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('matrix_people_search_unavailable')
  }
  const source = raw as { results?: unknown; limited?: unknown }
  if (!Array.isArray(source.results) || source.results.length > limit || typeof source.limited !== 'boolean') {
    throw new Error('matrix_people_search_unavailable')
  }
  const seen = new Set<string>()
  const results = source.results.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('matrix_people_search_unavailable')
    }
    const person = item as Record<string, unknown>
    if (!USER_ID.test(String(person.userId)) || seen.has(String(person.userId)) ||
      typeof person.name !== 'string' || !person.name.trim() || [...person.name].length > 255 ||
      (person.handle !== undefined && (typeof person.handle !== 'string' || !HANDLE.test(person.handle))) ||
      (person.avatarUrl !== undefined && typeof person.avatarUrl !== 'string')) {
      throw new Error('matrix_people_search_unavailable')
    }
    seen.add(String(person.userId))
    return {
      userId: String(person.userId),
      name: person.name,
      ...(person.handle ? { handle: person.handle as string } : {}),
      ...(person.avatarUrl ? { avatarUrl: person.avatarUrl as string } : {})
    }
  })
  return { results, limited: source.limited }
}

function refusal(error: unknown): MatrixPeopleSearchResponse {
  return error instanceof MatrixAliasError
    ? { ok: false, error: error.code, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }
    : { ok: false, error: 'unavailable' }
}

export async function handleMatrixPeopleSearch(input: unknown, context: Context): Promise<MatrixPeopleSearchResponse> {
  const refused = gate(context)
  if (refused) {
    return { ok: false, error: refused }
  }
  const request = parse(input)
  if (!request) {
    return { ok: false, error: 'invalid' }
  }
  try {
    const email = request.query.toLowerCase()
    const handle = request.query.replace(/^@/, '').toLowerCase()
    let query = request.query.startsWith('@') ? request.query.slice(1) : request.query
    let exactUserId: string | undefined
    if (EMAIL.test(email)) {
      const found = await context.alias({ action: 'search', email })
      if (found.kind !== 'search') {
        throw new Error('matrix_people_search_unavailable')
      }
      if (!found.matrixUser) {
        return { ok: true, value: { results: [], limited: false } }
      }
      query = found.matrixUser
      exactUserId = found.matrixUser
    }
    let exactHandle: MatrixPeopleSearchValue['results'][number] | undefined
    if (!exactUserId && HANDLE.test(handle)) {
      try {
        const found = await context.alias({ action: 'lookup', handle })
        if (found.kind === 'lookup' && found.state === 'assigned' && found.principalKind === 'human' && found.matrixUser) {
          exactHandle = { userId: found.matrixUser, name: `@${handle}`, handle }
        }
      } catch {
        // Handle lookup is an additive public-alias path. A spent/unavailable alias
        // budget must not turn the independent native name search into an empty result.
      }
    }
    try {
      const raw = await context.sdk({ kind: 'peopleSearch', query, limit: request.limit, ...(exactUserId ? { exactUserId } : {}) })
      const directory = value(raw, request.limit)
      if (!exactHandle) {
        return { ok: true, value: directory }
      }
      const matched = directory.results.findIndex(person => person.userId === exactHandle.userId)
      if (matched >= 0) {
        return {
          ok: true,
          value: {
            ...directory,
            results: directory.results.map((person, index) => index === matched
              ? { ...person, handle: exactHandle.handle }
              : person)
          }
        }
      }
      const results = [exactHandle, ...directory.results].slice(0, request.limit)
      return { ok: true, value: { results, limited: directory.limited || results.length <= directory.results.length } }
    } catch (error) {
      if (exactHandle) {
        return { ok: true, value: { results: [exactHandle], limited: false } }
      }
      throw error
    }
  } catch (error) { return refusal(error) }
}

export async function handleMatrixPeoplePrivacy(
  input: unknown,
  context: Context
): Promise<MatrixPeoplePrivacyResponse> {
  const refused = gate(context)
  if (refused) {
    return { ok: false, error: refused }
  }
  try {
    const write = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 1 &&
      typeof Reflect.get(input, 'enabled') === 'boolean'
    const read = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0
    if (!write && !read) {
      return { ok: false, error: 'invalid' }
    }
    const enabled = await context.sdk(write
      ? { kind: 'peoplePrivacyWrite', enabled: Reflect.get(input, 'enabled') as boolean }
      : { kind: 'peoplePrivacyRead' })
    if (typeof enabled !== 'boolean') {
      throw new Error('matrix_people_privacy_unavailable')
    }
    return { ok: true, enabled }
  } catch { return { ok: false, error: 'unavailable' } }
}
