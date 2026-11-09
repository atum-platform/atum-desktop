export const MATRIX_NOTES_SELF_ROOM_TYPE = 'com.atum.notes.self'
export const MATRIX_NOTES_SELF_ACCOUNT_DATA = 'com.atum.notes_self'
export const MATRIX_NOTES_SELF_TAG = 'u.atum.notes_self'
/** Immutable create-content key that makes a notes room belong to exactly one company. */
export const MATRIX_NOTES_SELF_COMPANY_KEY = 'com.atum.notes_self.company_id'

const ROOM_ID = /^![!-9;-~]{1,255}:[!-~]{1,255}$/u
export const MATRIX_NOTES_SELF_COMPANY_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u

export interface MatrixNotesSelfPointer {
  version: 1
  room_id: string
}

export interface MatrixNotesSelfDuplicate {
  roomId: string
  /** Unknown history is retained like notes: only a proven-empty room may be tombstoned. */
  content: 'notes' | 'unknown'
}

export interface MatrixNotesSelfScopeSnapshot {
  state: 'uncreated' | 'ready' | 'uncertain' | 'readonly' | 'quarantined'
  /** The deterministic earliest owner-created room with a one-person audience. */
  roomId?: string
  /** Non-empty or not-yet-proven-empty duplicates remain discoverable under the winner. */
  duplicates: MatrixNotesSelfDuplicate[]
  /** Typed owner-created rooms whose audience is no longer the owner alone. */
  quarantinedRoomIds: string[]
  /** Proven-empty duplicates already redirected with an m.room.tombstone. */
  retiredRoomIds: string[]
  /** False for unknown/newer account data: clients may discover but never overwrite it. */
  pointerWritable: boolean
}

export interface MatrixNotesSelfSnapshot extends MatrixNotesSelfScopeSnapshot {
  /** Company-id keyed notes rooms. Omitted by older clients and before a company scope is discovered. */
  companies?: Record<string, MatrixNotesSelfScopeSnapshot>
}

export type MatrixNotesSelfPointerRead =
  | { state: 'absent' }
  | { state: 'known'; value: MatrixNotesSelfPointer }
  | { state: 'readonly' }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Unknown or newer account data is read-only. A known v1 pointer may be repaired after discovery. */
export function readMatrixNotesSelfPointer(value: unknown): MatrixNotesSelfPointerRead {
  if (value === undefined) {
    return { state: 'absent' }
  }

  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.room_id !== 'string' ||
    !ROOM_ID.test(value.room_id) ||
    Object.keys(value).length !== 2
  ) {
    return { state: 'readonly' }
  }

  return { state: 'known', value: { version: 1, room_id: value.room_id } }
}

/** One account-data event per company avoids cross-device map clobbering between independent companies. */
export function matrixNotesSelfAccountData(companyId?: string): string {
  return companyId ? `${MATRIX_NOTES_SELF_ACCOUNT_DATA}.${companyId}` : MATRIX_NOTES_SELF_ACCOUNT_DATA
}

export function matrixCompanyNotesSelf(
  snapshot: MatrixNotesSelfSnapshot | undefined,
  companyId: string | undefined
): MatrixNotesSelfScopeSnapshot | undefined {
  return companyId ? snapshot?.companies?.[companyId] : snapshot
}

function scopes(snapshot: MatrixNotesSelfSnapshot | undefined): MatrixNotesSelfScopeSnapshot[] {
  return snapshot ? [snapshot, ...Object.values(snapshot.companies ?? {})] : []
}

export function matrixNotesSelfRoom(snapshot: MatrixNotesSelfSnapshot | undefined, roomId: string): boolean {
  return scopes(snapshot).some(value => value.state === 'ready' && value.roomId === roomId)
}

export function matrixNotesSelfKnownRoom(snapshot: MatrixNotesSelfSnapshot | undefined, roomId: string): boolean {
  return scopes(snapshot).some(value =>
    value.roomId === roomId ||
    value.duplicates.some(room => room.roomId === roomId) ||
    value.quarantinedRoomIds.includes(roomId) ||
    value.retiredRoomIds.includes(roomId)
  )
}

export function matrixNotesSelfCompanyId(
  snapshot: MatrixNotesSelfSnapshot | undefined,
  roomId: string
): string | undefined {
  return Object.entries(snapshot?.companies ?? {}).find(([, value]) =>
    value.roomId === roomId ||
    value.duplicates.some(room => room.roomId === roomId) ||
    value.quarantinedRoomIds.includes(roomId) ||
    value.retiredRoomIds.includes(roomId)
  )?.[0]
}
