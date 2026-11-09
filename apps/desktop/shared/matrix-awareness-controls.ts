import type { AwarenessSource, AwarenessWithdrawalScope } from './awareness/types'

/** Append-only owner intent in the controls room: an owner-only Matrix room, made
 * without end-to-end encryption since 0.20 (older ones stay encrypted). The
 * companion never creates it or sends into it; this is not an identity carrier. */
export const AWARENESS_CONTROL_ROOM_TYPE = 'io.atum.awareness.controls.v1'
export const AWARENESS_CONTROL_REFERENCE = 'io.atum.awareness.controls'
export const AWARENESS_CONTROL_EVENT = 'io.atum.awareness.control.v1'
export interface AwarenessControlReference { v: 1; roomId: string }
export type AwarenessControl = { v: 1; id: string } & (
  | { action: 'include'; source: AwarenessSource; included: boolean }
  | { action: 'withdraw'; scope: AwarenessWithdrawalScope; reason: 'forget' | 'delete' | 'account_deleted' }
)
export type MatrixAwarenessControlCommand =
  | { kind: 'awarenessPrepareControls' }
  | { kind: 'awarenessControl'; control: AwarenessControl }
  | { kind: 'awarenessRooms' }
  | { kind: 'awarenessRoomChange'; roomId: string; action: 'include' | 'exclude' | 'forget' }

/** Presentation of accepted owner intent; it is not a managed suppression receipt. */
export interface MatrixAwarenessRoom {
  roomId: string
  name: string
  included: boolean
  forgotten: boolean
}
export interface MatrixAwarenessView {
  identity: { userId: string; deviceId: string }
  rooms: MatrixAwarenessRoom[]
}
/** The account has no controls room. Only the owner-reader enrollment path
 * creates one, so no companion exists to honour a choice: show nothing. */
export interface MatrixAwarenessUnavailable {
  available: false
}
export interface MatrixAwarenessBridge {
  read(): Promise<MatrixAwarenessView | MatrixAwarenessUnavailable>
  change(identity: MatrixAwarenessView['identity'], roomId: string, action: 'include' | 'exclude' | 'forget'): Promise<MatrixAwarenessView>
}

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const ref = (v: unknown): v is string => typeof v === 'string' && /^[!-~]{1,1024}$/.test(v)

function exact(v: unknown, fields: string[]): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).length === fields.length && Object.keys(v).every(k => fields.includes(k))
}

function source(v: any): v is AwarenessSource {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).every(k => ['kind','id','agentPrincipal'].includes(k)) &&
    ['assistant_chat','human_dm','human_group','app_exchange','drive_file','native_memory','owner_statement'].includes(v.kind) &&
    ref(v.id) && (v.agentPrincipal === undefined || uuid.test(v.agentPrincipal))
}

export function validAwarenessControl(value: unknown): value is AwarenessControl {
  const v = value as any

  if (!v || v.v !== 1 || typeof v.id !== 'string' || !uuid.test(v.id)) {return false}

  if (v.action === 'include') {return exact(v,['v','id','action','source','included']) && source(v.source) && typeof v.included === 'boolean'}

  if (v.action !== 'withdraw' || !exact(v,['v','id','action','scope','reason']) ||
      !['forget','delete','account_deleted'].includes(v.reason)) {return false}

  const s = v.scope

  const valid = s?.kind === 'account' ? exact(s,['kind']) : s?.kind === 'fact' ? exact(s,['kind','evidenceId']) && ref(s.evidenceId) :
    s?.kind === 'source' ? exact(s,['kind','source']) && source(s.source) :
    s?.kind === 'object' ? exact(s,['kind','source','objectId']) && source(s.source) && ref(s.objectId) : false

  return valid && (v.reason !== 'account_deleted' || s.kind === 'account')
}

export function validAwarenessControlReference(value: unknown): value is AwarenessControlReference {
  return exact(value,['v','roomId']) && value.v === 1 && /^![^\s:]+:[^\s]+$/.test(value.roomId)
}
