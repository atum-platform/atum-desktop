import { MATRIX_ALIAS_CONTACTS_MAX, type MatrixAliasContact, type MatrixAliasErrorCode, type MatrixAliasRequest, type MatrixAliasView } from '../../shared/matrix-aliases'

import type { NativeGrant } from './authorization'
import { readDomainJson } from './domain'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const HANDLE = /^[a-z][a-z0-9_]{2,31}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
const handle = (value: unknown): value is string => typeof value === 'string' && HANDLE.test(value)
// The same address shape a conversation's invite accepts, so a found person can be messaged.
const matrixUser = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024 && /^@[^:\s]+:[^\s]+$/.test(value)
const PRINCIPAL_KINDS = ['human', 'agent', 'app', 'organization'] as const
// The local Matrix ID the contacts route accepts (spec/public-handles/v1.1), at most 255 bytes.
const CONTACT_USER = /^@[a-z0-9._=/-]{1,255}:[A-Za-z0-9.-]{1,253}(?::[0-9]{1,5})?$/u
const contactUser = (value: unknown): value is string =>
  typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 255 && CONTACT_USER.test(value)

const normalized = (value: string) => {
  const result = value.replace(/^@/, '').toLowerCase()

  return HANDLE.test(result) ? result : null
}

const generation = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1

const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key))

export class MatrixAliasError extends Error {
  constructor(readonly code: MatrixAliasErrorCode, readonly retryAfterSeconds?: number) { super(`matrix_alias_${code}`) }
}

const handleInput = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 33

const REQUIRED: Record<MatrixAliasRequest['action'], string[]> = {
  current: ['action'],
  check: ['action', 'handle'],
  lookup: ['action', 'handle'],
  search: ['action', 'email'],
  contacts: ['action', 'matrixUsers'],
  claim: ['action', 'handle', 'requestId'],
  rename: ['action', 'handle', 'from', 'requestId']
}

/** The longest wait a rename refusal names: the platform's 30 days, and a day's margin. */
const RENAME_WAIT_MAX_SECONDS = 31 * 86400

/** Fixed operations only. No caller owner, principal, URL, bearer or arbitrary RPC. */
export function parseMatrixAliasRequest(value: unknown): MatrixAliasRequest {
  if (!object(value) || !Object.hasOwn(REQUIRED, value.action as string) ||
    (Object.hasOwn(value, 'assistantId') && !uuid(value.assistantId))) { throw new MatrixAliasError('invalid') }

  const action = value.action as MatrixAliasRequest['action']

  // Finding someone has no assistant selector: the directory answers the same for everyone.
  const finding = action === 'lookup' || action === 'search' || action === 'contacts'

  if (!keys(value, REQUIRED[action], action === 'contacts' ? ['schemaVersion'] : finding ? [] : ['assistantId']) ||
    (action !== 'current' && action !== 'search' && action !== 'contacts' && !handleInput(value.handle)) ||
    (action === 'contacts' && (value.schemaVersion !== undefined && value.schemaVersion !== 2 || !Array.isArray(value.matrixUsers) || value.matrixUsers.length < 1 ||
      value.matrixUsers.length > MATRIX_ALIAS_CONTACTS_MAX || !value.matrixUsers.every(contactUser) ||
      new Set(value.matrixUsers).size !== value.matrixUsers.length)) ||
    (action === 'search' && (typeof value.email !== 'string' || value.email !== value.email.trim() ||
      value.email !== value.email.toLowerCase() || value.email.length > 254 || !EMAIL.test(value.email))) ||
    (action === 'rename' && !handleInput(value.from)) ||
    ((action === 'claim' || action === 'rename') && !uuid(value.requestId))) { throw new MatrixAliasError('invalid') }

  const target = typeof value.assistantId === 'string' ? { assistantId: value.assistantId } : {}

  if (action === 'current') { return { action: 'current', ...target } }

  if (action === 'check') { return { action: 'check', handle: value.handle as string, ...target } }

  if (action === 'lookup') { return { action: 'lookup', handle: value.handle as string } }

  if (action === 'search') { return { action: 'search', email: value.email as string } }

  if (action === 'contacts') { return { action: 'contacts', matrixUsers: [...(value.matrixUsers as string[])], ...(value.schemaVersion === 2 ? {schemaVersion:2 as const} : {}) } }

  if (action === 'rename') {
    return { action: 'rename', handle: value.handle as string, from: value.from as string, requestId: value.requestId as string, ...target }
  }

  return { action: 'claim', handle: value.handle as string, requestId: value.requestId as string, ...target }
}

export function parseMatrixAliasResponse(value: unknown, input: MatrixAliasRequest): MatrixAliasView {
  function invalid(): never { throw new MatrixAliasError('unavailable') }

  if (input.action === 'current') {
    if (value === null) { return { kind: 'current', alias: null } }

    if (!object(value) || !keys(value, ['handle', 'generation']) || !handle(value.handle) || !generation(value.generation)) { invalid() }

    return { kind: 'current', alias: { handle: value.handle, generation: value.generation } }
  }

  if (!object(value)) { invalid() }

  if (input.action === 'check') {
    const codes = ['alias_invalid', 'alias_bot_suffix_required', 'alias_bot_suffix_reserved', 'alias_reserved', 'alias_unavailable']

    if (!keys(value, ['handle', 'available', 'code']) || !(value.handle === null || handle(value.handle)) ||
      typeof value.available !== 'boolean' || !(value.code === null || codes.includes(value.code as string)) || value.available !== (value.code === null) ||
      value.handle !== normalized(input.handle) || (value.available && value.handle === null)) { invalid() }

    return { kind: 'check', handle: value.handle, available: value.available, code: value.code as string | null }
  }

  if (input.action === 'lookup') {
    // The answer must be about the handle that was asked for, normalized exactly as asked.
    if (typeof value.state !== 'string' || value.handle !== normalized(input.handle)) { invalid() }

    if (value.state === 'assigned') {
      if (!keys(value, ['handle', 'state', 'principal', 'kind', 'generation', 'matrixUser']) || !handle(value.handle) ||
        !uuid(value.principal) || !PRINCIPAL_KINDS.includes(value.kind as never) || !generation(value.generation) ||
        !(value.matrixUser === null || matrixUser(value.matrixUser))) { invalid() }

      // The principal stays in main: a chat needs the Matrix address, never the domain identity.
      return {
        kind: 'lookup', handle: value.handle, state: 'assigned',
        principalKind: value.kind as (typeof PRINCIPAL_KINDS)[number], matrixUser: value.matrixUser as string | null
      }
    }

    if (!keys(value, ['handle', 'state'])) { invalid() }

    if (value.state === 'invalid' && value.handle === null) { return { kind: 'lookup', handle: null, state: 'invalid' } }

    if ((value.state === 'available' || value.state === 'unavailable') && handle(value.handle)) {
      return { kind: 'lookup', handle: value.handle, state: value.state }
    }

    invalid()
  }

  if (input.action === 'search') {
    if (!keys(value, ['kind', 'matrixUser']) || value.kind !== 'search' ||
      !(value.matrixUser === null || matrixUser(value.matrixUser))) { invalid() }
    return { kind: 'search', matrixUser: value.matrixUser as string | null }
  }

  if (input.action === 'contacts') {
    const contacts = value.contacts
    const v2 = input.schemaVersion === 2
    if (!keys(value, v2 ? ['contacts','schemaVersion','revision'] : ['contacts']) ||
      v2 && (value.schemaVersion !== 2 || !Number.isSafeInteger(value.revision) || Number(value.revision)<0) ||
      !Array.isArray(contacts) || contacts.length !== input.matrixUsers.length ||
      !contacts.every((entry,index) => object(entry) &&
        keys(entry,v2 ? ['matrixUser','handle','status','generation'] : ['matrixUser','handle']) &&
        entry.matrixUser === input.matrixUsers[index] &&
        (v2 ? entry.status==='resolved' ? handle(entry.handle) && generation(entry.generation)
          : ['not_visible','unknown'].includes(String(entry.status)) && entry.handle===null && entry.generation===null
          : entry.handle===null || handle(entry.handle)))) { invalid() }
    return {kind:'contacts',contacts:contacts as MatrixAliasContact[],
      ...(v2 ? {schemaVersion:2 as const,revision:Number(value.revision)} : {})}
  }

  const rename = input.action === 'rename'

  if (!keys(value, ['handle', 'state', 'principal', 'generation', ...(rename ? ['previous'] : [])], ['replayed']) || !handle(value.handle) ||
    value.state !== 'assigned' || !uuid(value.principal) || !generation(value.generation) || value.handle !== normalized(input.handle) ||
    (Object.hasOwn(value, 'replayed') && value.replayed !== true) ||
    (rename && (!handle(value.previous) || value.previous !== normalized(input.from) || value.previous === value.handle))) { invalid() }

  const replayed = value.replayed === true ? { replayed: true as const } : {}

  // The principal stays in main, as for every directory answer.
  return rename
    ? { kind: 'rename', handle: value.handle, generation: value.generation, previous: value.previous as string, ...replayed }
    : { kind: 'claim', handle: value.handle, generation: value.generation, ...replayed }
}

/** A 403 says why only when handles are not open yet; anything unreadable stays a denial. */
async function refusalReason(response: Response): Promise<string | undefined> {
  try {
    const body = await readDomainJson(response, 1024)

    return object(body) && object(body.details) && typeof body.details.reason === 'string' ? body.details.reason : undefined
  } catch { return undefined }
}

/** Named native domain resource. Redirects and cookies cannot move the MAS bearer. */
export async function requestMatrixAlias(resource: string, grant: NativeGrant, value: MatrixAliasRequest, signal: AbortSignal): Promise<MatrixAliasView> {
  const input = parseMatrixAliasRequest(value)
  signal.throwIfAborted()
  const query = new URLSearchParams()

  if (input.action === 'check' || input.action === 'lookup') {
    // The wire value is the normalized handle the response is checked against, whoever called.
    const handle = normalized(input.handle)

    if (!handle) { throw new MatrixAliasError('invalid') }
    query.set('handle', handle)
  }

  if ('assistantId' in input && input.assistantId) { query.set('assistantId', input.assistantId) }
  const read = input.action !== 'claim' && input.action !== 'rename' && input.action !== 'search' && input.action !== 'contacts'

  const body = input.action === 'search'
    ? JSON.stringify({ email: input.email })
    : input.action === 'contacts'
    ? JSON.stringify({ matrixUsers: input.matrixUsers, ...(input.schemaVersion===2 ? {schemaVersion:2} : {}) })
    : input.action === 'claim' || input.action === 'rename'
    ? JSON.stringify({
      handle: input.handle,
      ...(input.action === 'rename' ? { from: input.from } : {}),
      requestId: input.requestId,
      ...(input.assistantId ? { assistantId: input.assistantId } : {})
    })
    : undefined

  const response = await fetch(`${resource}/aliases/${input.action}${read && query.size ? `?${query}` : ''}`, {
    method: read ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${grant.accessToken}`, Accept: 'application/json', ...(!read ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body } : {}),
    redirect: 'error', credentials: 'omit', cache: 'no-store', signal
  })

  if (response.status !== 200) {
    let code: MatrixAliasErrorCode = ({ 400: 'invalid', 401: 'authentication', 403: 'denied', 404: 'missing', 409: 'conflict', 429: 'limit' } as const)[response.status] ?? 'unavailable'

    // The domain authority answers JSON, so its 404 means the target is gone. Any other 404 is a
    // Shell without this route (rename, before 0208's Shell): unavailable, and the change can be
    // retried once it is deployed. Never "this assistant is no longer available".
    if (code === 'missing' && !response.headers.get('content-type')?.startsWith('application/json')) { code = 'unavailable' }
    const raw = response.headers.get('Retry-After')
    // A check budget waits at most a day; a rename can wait the rest of its 30 days.
    const longest = input.action === 'rename' ? RENAME_WAIT_MAX_SECONDS : 86400
    const seconds = raw !== null && /^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= longest ? Number(raw) : undefined

    // Only a change reads its refusal: the reader consumes (and closes) the body itself.
    if (code === 'denied' && !read) {
      if (await refusalReason(response) === 'alias_claims_closed') { code = 'closed' }
    } else { await response.body?.cancel() }

    throw new MatrixAliasError(code, code === 'limit' ? seconds : undefined)
  }

  if (!response.headers.get('content-type')?.startsWith('application/json')) { await response.body?.cancel(); throw new MatrixAliasError('unavailable') }

  try {
    const result = parseMatrixAliasResponse(await readDomainJson(response), input)
    signal.throwIfAborted()

    return result
  } catch { throw new MatrixAliasError('unavailable') }
}
