/**
 * The assistant card's bridge (window ↔ native). The window never sees the platform's
 * resource, grant or assistant ID: it names an assistant by its agent principal, reads one
 * owner-scoped view of it, and writes back the two things the card edits — the name and the
 * persona — fenced by the revisions it read. Native checks the name again and keeps the
 * model, reasoning, skills and photo recipe exactly as the platform holds them.
 */

import { matrixProfilePhoto, type MatrixProfilePhotoType } from './matrix-profile'

export interface MatrixAssistantCard {
  principal: string
  displayName: string
  isDefault: boolean
  /** The persona as stored. For a primary assistant with none, Atum's own (see `inherited`). */
  soul: string
  /** The persona shown is Atum's built-in one, not stored on the platform yet. */
  inherited: boolean
  /** The names of the skills its definition carries. */
  skills: string[]
  definitionRevision: number
  identityRevision: number
}

export interface MatrixAssistantCardChange {
  principal: string
  expectedDefinitionRevision: number
  expectedIdentityRevision: number
  /** A new name (not for the primary assistant). */
  displayName?: string
  /** A new persona (the whole text). */
  soul?: string
}

/**
 * - `conflict`: the record changed elsewhere since it was read; `card` is the latest.
 * - `reserved` / `invalid` / `duplicate` / `locked`: the name was refused.
 * - `offline` / `unavailable` / `denied` / `missing`: nothing was written.
 */
export type MatrixAssistantCardError =
  | 'conflict'
  | 'reserved'
  | 'invalid'
  | 'duplicate'
  | 'locked'
  | 'offline'
  | 'unavailable'
  | 'denied'
  | 'missing'

export type MatrixAssistantCardResult =
  | { ok: true; card: MatrixAssistantCard }
  | { ok: false; error: MatrixAssistantCardError; card?: MatrixAssistantCard }

export interface MatrixAssistantAvatarChange {
  principal: string
  avatar: { type: MatrixProfilePhotoType; bytes: Uint8Array } | null
}

export type MatrixAssistantAvatarResult =
  | { ok: true; avatarUrl: string | null }
  | { ok: false; error: MatrixAssistantCardError }

export interface MatrixAssistantCardsBridge {
  read(principal: string): Promise<MatrixAssistantCardResult>
  save(change: MatrixAssistantCardChange): Promise<MatrixAssistantCardResult>
  avatar(change: MatrixAssistantAvatarChange): Promise<MatrixAssistantAvatarResult>
}

const PRINCIPAL = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/** A principal from the window, or nothing. */
export function matrixAssistantCardPrincipal(value: unknown): string | undefined {
  return typeof value === 'string' && PRINCIPAL.test(value) ? value : undefined
}

/** A change from the window: a principal, two revisions, and at least one field. */
export function matrixAssistantCardChange(value: unknown): MatrixAssistantCardChange | undefined {
  const row = value as Record<string, unknown> | null

  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return undefined
  }

  const principal = matrixAssistantCardPrincipal(row.principal)
  const definition = row.expectedDefinitionRevision
  const identity = row.expectedIdentityRevision

  if (
    !principal ||
    !Number.isSafeInteger(definition) ||
    (definition as number) < 0 ||
    !Number.isSafeInteger(identity) ||
    (identity as number) < 1 ||
    (row.displayName !== undefined && typeof row.displayName !== 'string') ||
    (row.soul !== undefined && typeof row.soul !== 'string') ||
    (row.displayName === undefined && row.soul === undefined) ||
    (typeof row.displayName === 'string' && row.displayName.length > 4096) ||
    (typeof row.soul === 'string' && new TextEncoder().encode(row.soul).byteLength > 65_536)
  ) {
    return undefined
  }

  return {
    principal,
    expectedDefinitionRevision: definition as number,
    expectedIdentityRevision: identity as number,
    ...(row.displayName !== undefined ? { displayName: row.displayName as string } : {}),
    ...(row.soul !== undefined ? { soul: row.soul as string } : {})
  }
}

/** A canonical agent-photo change from the trusted renderer boundary. */
export function matrixAssistantAvatarChange(value: unknown): MatrixAssistantAvatarChange | undefined {
  const row = value as Record<string, unknown> | null
  const principal = row && typeof row === 'object' && !Array.isArray(row)
    ? matrixAssistantCardPrincipal(row.principal)
    : undefined

  if (!principal || Object.keys(row!).sort().join(',') !== 'avatar,principal') {
    return undefined
  }

  if (row!.avatar === null) {
    return { principal, avatar: null }
  }

  try {
    const photo = matrixProfilePhoto(row!.avatar)

    return { principal, avatar: { type: photo.type, bytes: photo.bytes } }
  } catch {
    return undefined
  }
}
