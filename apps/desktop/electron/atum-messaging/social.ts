export const ATUM_SOCIAL_CONTRACT = 'atum.social/1' as const
export const ATUM_SOCIAL_VERSION = '1' as const

export type SocialRelationshipState =
  | 'none'
  | 'outgoing_pending'
  | 'incoming_pending'
  | 'connected'
  | 'blocked_by_me'
  | 'unavailable'

export interface SocialProfile {
  profileId: string
  displayName: string
  handle: string
  verified: boolean
  avatar: string | null
}

export type SocialProjection =
  | {
      availability: 'available'
      profile: SocialProfile
      state: Exclude<SocialRelationshipState, 'unavailable'>
      version: number
      canMessage: boolean
      directThreadId: string | null
    }
  | {
      availability: 'unavailable'
      profile: null
      state: 'unavailable'
      version: 0
      canMessage: false
      directThreadId: null
    }

export interface SocialLookupResponse {
  accountEpoch: string
  projection: SocialProjection
}

export interface SocialMutationResponse extends SocialLookupResponse {
  operationId: string
  replayed: boolean
}

export interface SocialSyncChange {
  changeId: string
  projection: SocialProjection
}

export interface SocialSyncResponse {
  accountEpoch: string
  changes: SocialSyncChange[]
  nextCursor: string
  hasMore: boolean
}

export type SocialMutationAction = 'request' | 'accept' | 'decline' | 'block' | 'unblock'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/u

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid_social_response:${name}`)
  }

  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()

  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`invalid_social_response:${name}.fields`)
  }
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`invalid_social_response:${name}`)
  }

  return value
}

function projection(value: unknown): SocialProjection {
  const row = object(value, 'projection')
  exact(row, ['availability', 'profile', 'state', 'version', 'can_message', 'direct_thread_id'], 'projection')

  if (row.availability === 'unavailable') {
    if (
      row.profile !== null ||
      row.state !== 'unavailable' ||
      row.version !== 0 ||
      row.can_message !== false ||
      row.direct_thread_id !== null
    ) {
      throw new Error('invalid_social_response:projection.unavailable')
    }

    return {
      availability: 'unavailable',
      profile: null,
      state: 'unavailable',
      version: 0,
      canMessage: false,
      directThreadId: null
    }
  }

  if (row.availability !== 'available') {
    throw new Error('invalid_social_response:projection.availability')
  }

  const rawProfile = object(row.profile, 'projection.profile')
  exact(rawProfile, ['profile_id', 'display_name', 'handle', 'verified', 'avatar'], 'projection.profile')
  const states = new Set(['none', 'outgoing_pending', 'incoming_pending', 'connected', 'blocked_by_me'])

  if (
    typeof rawProfile.display_name !== 'string' ||
    !rawProfile.display_name.trim() ||
    rawProfile.display_name.length > 160 ||
    typeof rawProfile.handle !== 'string' ||
    !HANDLE.test(rawProfile.handle) ||
    typeof rawProfile.verified !== 'boolean' ||
    (rawProfile.avatar !== null && typeof rawProfile.avatar !== 'string') ||
    typeof row.state !== 'string' ||
    !states.has(row.state) ||
    !Number.isSafeInteger(row.version) ||
    Number(row.version) < 0 ||
    typeof row.can_message !== 'boolean' ||
    (row.direct_thread_id !== null && typeof row.direct_thread_id !== 'string')
  ) {
    throw new Error('invalid_social_response:projection.available')
  }

  const directThreadId = row.direct_thread_id === null ? null : uuid(row.direct_thread_id, 'projection.direct_thread_id')
  const canMessage = row.can_message as boolean

  if (canMessage !== (row.state === 'connected' && directThreadId !== null)) {
    throw new Error('invalid_social_response:projection.can_message')
  }

  return {
    availability: 'available',
    profile: {
      profileId: uuid(rawProfile.profile_id, 'projection.profile.profile_id'),
      displayName: rawProfile.display_name,
      handle: rawProfile.handle,
      verified: rawProfile.verified,
      avatar: rawProfile.avatar as string | null
    },
    state: row.state as Exclude<SocialRelationshipState, 'unavailable'>,
    version: Number(row.version),
    canMessage,
    directThreadId
  }
}

export function parseSocialLookupResponse(value: unknown): SocialLookupResponse {
  const body = object(value, 'lookup')
  exact(body, ['account_epoch', 'projection'], 'lookup')

  return { accountEpoch: uuid(body.account_epoch, 'account_epoch'), projection: projection(body.projection) }
}

export function parseSocialMutationResponse(value: unknown): SocialMutationResponse {
  const body = object(value, 'mutation')
  exact(body, ['account_epoch', 'operation_id', 'replayed', 'projection'], 'mutation')

  if (typeof body.replayed !== 'boolean') {
    throw new Error('invalid_social_response:mutation.replayed')
  }

  const parsedProjection = projection(body.projection)

  if (parsedProjection.availability === 'available' && parsedProjection.version < 1) {
    throw new Error('invalid_social_response:mutation.projection.version')
  }

  return {
    accountEpoch: uuid(body.account_epoch, 'account_epoch'),
    operationId: uuid(body.operation_id, 'operation_id'),
    replayed: body.replayed,
    projection: parsedProjection
  }
}

export function parseSocialSyncResponse(value: unknown): SocialSyncResponse {
  const body = object(value, 'sync')
  exact(body, ['account_epoch', 'changes', 'next_cursor', 'has_more'], 'sync')

  if (!Array.isArray(body.changes) || typeof body.next_cursor !== 'string' || typeof body.has_more !== 'boolean') {
    throw new Error('invalid_social_response:sync')
  }

  let previous = -1n

  const changes = body.changes.map((value, index) => {
    const change = object(value, `sync.changes.${index}`)
    exact(change, ['change_id', 'projection'], `sync.changes.${index}`)

    if (typeof change.change_id !== 'string' || !/^[1-9][0-9]*$/u.test(change.change_id)) {
      throw new Error(`invalid_social_response:sync.changes.${index}.change_id`)
    }

    const current = BigInt(change.change_id)

    if (current <= previous) {
      throw new Error('invalid_social_response:sync.change_order')
    }

    previous = current

    const parsedProjection = projection(change.projection)

    if (parsedProjection.availability === 'available' && parsedProjection.version < 1) {
      throw new Error(`invalid_social_response:sync.changes.${index}.projection.version`)
    }

    return { changeId: change.change_id, projection: parsedProjection }
  })

  return {
    accountEpoch: uuid(body.account_epoch, 'account_epoch'),
    changes,
    nextCursor: body.next_cursor,
    hasMore: body.has_more
  }
}
