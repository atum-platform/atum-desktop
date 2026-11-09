/** Existing identities, qualified by the existing app relationship in trusted code. */
export const PARTICIPANT_REFS_CONTRACT = 'atum.participant-ref/1' as const
export const PARTICIPANT_REFS_HEADER = 'x-atum-participant-refs' as const

export type ParticipantRef =
  | { kind: 'user'; id: string }
  | { kind: 'assistant'; id: string }
  | { kind: 'app'; id: string; appInstallationId: string }

/** Display only. Never an invocation target or proof of authority. */
export interface ParticipantDisplay {
  kind: ParticipantRef['kind']
  id: string
  displayName: string
  avatarUrl?: string
  ownerUserId?: string
  ownerDisplayName?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Closed snake-case wire shape; app relationship identifiers stay in main. */
export function parseParticipantRef(value: unknown): ParticipantRef {
  const row = record(value)
  const id = uuid(row?.id)
  const kind = row?.kind
  const allowed = kind === 'app' ? ['kind', 'id', 'app_installation_id'] : ['kind', 'id']

  if (!row || !id || !['user', 'assistant', 'app'].includes(String(kind))
    || Object.keys(row).some(key => !allowed.includes(key))) {
    throw new Error('invalid_response:participant_ref')
  }

  if (kind === 'app') {
    const appInstallationId = uuid(row.app_installation_id)

    if (!appInstallationId) { throw new Error('invalid_response:participant_ref') }

    return { kind, id, appInstallationId }
  }

  return { kind: kind as 'user' | 'assistant', id }
}

export function participantRefKey(ref: ParticipantRef): string {
  return `${ref.kind}:${ref.id.toLowerCase()}${ref.kind === 'app' ? `:${ref.appInstallationId.toLowerCase()}` : ''}`
}

function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 ? value.trim() : undefined
}

/** A snapshot is valid as a unit; fields are never borrowed from legacy groups. */
export function parseParticipantSnapshot(value: unknown): ParticipantDisplay | null {
  const row = record(value)
  const id = uuid(row?.id)
  const kind = row?.kind
  const displayName = label(row?.display_name)

  if (!row || !id || !displayName || (kind !== 'user' && kind !== 'assistant' && kind !== 'app')) { return null }
  const ownerUserId = uuid(row.owner_user_id)

  if (kind !== 'user' && !ownerUserId) { return null }
  const display: ParticipantDisplay = { kind, id, displayName }

  if (kind !== 'user') {
    display.ownerUserId = ownerUserId!
    const ownerDisplayName = label(row.owner_display_name)

    if (ownerDisplayName) { display.ownerDisplayName = ownerDisplayName }
  }

  if (typeof row.avatar_url === 'string' && row.avatar_url.length <= 2048) {
    try {
      const url = new URL(row.avatar_url)

      if (url.protocol === 'https:' && !url.username && !url.password) { display.avatarUrl = row.avatar_url }
    } catch { /* Invalid optional photo falls back to the existing initial. */ }
  }

  return display
}

/** Use only within the current account scope; history remains keyed by message ID. */
export function participantDisplayKey(display: ParticipantDisplay): string {
  return `${display.kind}:${display.id}${display.kind === 'app' ? `:${display.ownerUserId}` : ''}`
}
