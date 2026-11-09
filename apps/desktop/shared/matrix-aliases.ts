import type { MatrixHandleDiagnostic } from './matrix-handle-diagnostic'

/** Public aliases are independent of permanent Matrix identities. */
export interface MatrixAliasAssignment { handle: string; generation: number }
export interface MatrixAliasCheck { handle: string | null; available: boolean; code: string | null }
export interface MatrixAliasClaim extends MatrixAliasAssignment { replayed?: true }
export interface MatrixAliasIntent { handle: string; requestId: string; assistantId?: string }
/** A rename (spec/public-handles/v1): `from` is the handle the person was shown. The old
 * handle stays theirs for 30 days, and the next rename waits 30 days. */
export interface MatrixAliasRenameIntent extends MatrixAliasIntent { from: string }
export interface MatrixAliasRename extends MatrixAliasClaim { previous: string }
/** Who holds a handle today, for finding someone: never a reason, holder or earlier owner.
 * `matrixUser` is the address a chat needs; the directory may not know it (null). */
export type MatrixAliasLookup =
  | { handle: null; state: 'invalid' }
  | { handle: string; state: 'available' | 'unavailable' }
  | { handle: string; state: 'assigned'; principalKind: 'human' | 'agent' | 'app' | 'organization'; matrixUser: string | null }
/** Exact verified-email result. The email and MAS identity never leave main. */
export interface MatrixAliasSearch { matrixUser: string | null }
/** Most Matrix IDs one contacts read may carry (spec/public-handles/v1.1). */
export const MATRIX_ALIAS_CONTACTS_MAX = 50
/** A contact's public handle, or null: a stranger, someone without a handle and someone opted
 * out look the same (spec/public-handles/v1.1). Never a room, principal or reason. */
export interface MatrixAliasContact {
  matrixUser: string; handle: string | null
  status?: 'resolved' | 'not_visible' | 'unknown'
  generation?: number | null
}
export type MatrixAliasRequest =
  | { action: 'current'; assistantId?: string }
  | { action: 'check'; handle: string; assistantId?: string }
  | { action: 'lookup'; handle: string }
  | { action: 'search'; email: string }
  /** The handles of people the signed-in person already knows, by Matrix ID (1 to 50, distinct). */
  | { action: 'contacts'; matrixUsers: string[]; schemaVersion?: 2 }
  | ({ action: 'claim' } & MatrixAliasIntent)
  | ({ action: 'rename' } & MatrixAliasRenameIntent)
export type MatrixAliasView =
  | { kind: 'current'; alias: MatrixAliasAssignment | null }
  | ({ kind: 'check' } & MatrixAliasCheck)
  | ({ kind: 'lookup' } & MatrixAliasLookup)
  | ({ kind: 'search' } & MatrixAliasSearch)
  /** One entry per requested ID, in request order. */
  | { kind: 'contacts'; contacts: MatrixAliasContact[]; schemaVersion?: 2; revision?: number }
  | ({ kind: 'claim' } & MatrixAliasClaim)
  | ({ kind: 'rename' } & MatrixAliasRename)
/** `closed`: handles are not open yet (the naming policy awaits the owner's approval).
 * `limit` with `retryAfterSeconds`: a check budget, or, after a rename, the 30-day wait. */
export type MatrixAliasErrorCode = 'authentication' | 'denied' | 'closed' | 'missing' | 'conflict' | 'limit' | 'invalid' | 'unavailable' | 'cancelled'
/** A change sent but not yet answered, kept by main across restarts with its request id. */
export type MatrixAliasChange = Extract<MatrixAliasRequest, { action: 'claim' | 'rename' }>
export type MatrixAliasResult = { ok: true; value: MatrixAliasView } | { ok: false; error: MatrixAliasErrorCode; retryAfterSeconds?: number }
export type MatrixAliasPendingResult = { ok: true; request: MatrixAliasChange | null } | { ok: false; error: MatrixAliasErrorCode }
export interface MatrixAliasBridge {
  pending(): Promise<MatrixAliasPendingResult>
  request(input: MatrixAliasRequest): Promise<MatrixAliasResult>
  /** Fire and forget: how the create sheet, or the launch's missing-handle walk, settled a
   * handle, for main.log (closed values only). */
  diagnostic?(line: MatrixHandleDiagnostic): void
}
