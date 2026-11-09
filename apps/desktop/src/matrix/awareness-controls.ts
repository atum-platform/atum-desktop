import { Direction, EventType, type MatrixClient, MatrixEvent, Preset } from 'matrix-js-sdk'

import type { AwarenessSource } from '../../shared/awareness/types'
import {
  AWARENESS_CONTROL_EVENT,
  AWARENESS_CONTROL_REFERENCE,
  AWARENESS_CONTROL_ROOM_TYPE,
  type AwarenessControl,
  type AwarenessControlReference,
  validAwarenessControl,
  validAwarenessControlReference
} from '../../shared/matrix-awareness-controls'
import type { MatrixAwarenessRoom } from '../../shared/matrix-awareness-controls'

export type { AwarenessControl, AwarenessControlReference } from '../../shared/matrix-awareness-controls'

declare module 'matrix-js-sdk' {
  interface AccountDataEvents {
    [AWARENESS_CONTROL_REFERENCE]: AwarenessControlReference
  }
  interface TimelineEvents {
    [AWARENESS_CONTROL_EVENT]: AwarenessControl
  }
}

/**
 * Native owner intent is carried by a single, owner-only Matrix room. Since 0.20
 * it is made without end-to-end encryption, so a reader without keys can read it;
 * an older encrypted one keeps working. This module deliberately has no renderer,
 * model, reader, key, or identity input: the authenticated SDK owner is the only
 * authority it observes.
 */
type StateEvent = {
  event_id?: unknown
  type?: unknown
  state_key?: unknown
  sender?: unknown
  content?: unknown
}

interface ClientPreparation {
  promise?: Promise<AwarenessControlReference>
  /** A create or reference write may have reached the server. A process must
   * never issue a second create after that unknown outcome; a fresh SDK client
   * starts by reading server account data again. */
  uncertain: boolean
}

const preparations = new WeakMap<MatrixClient, ClientPreparation>()
const MEGOLM = 'm.megolm.v1.aes-sha2'

function failure(kind: 'invalid' | 'stale' | 'unavailable' | 'uncertain'): Error {
  return new Error(`matrix_awareness_controls_${kind}`)
}

function active(live: () => boolean): void {
  if (!live()) {
    throw failure('stale')
  }
}

function ownerOf(client: MatrixClient): string {
  const owner = client.getSafeUserId()

  if (typeof owner !== 'string' || !/^@[^\s:]+:[^\s:]+$/.test(owner)) {
    throw failure('unavailable')
  }

  return owner
}

function only(events: StateEvent[], type: string): StateEvent | undefined {
  const found = events.filter(event => event.type === type)

  return found.length === 1 && found[0]?.state_key === '' ? found[0] : undefined
}

function content(event: StateEvent | undefined): Record<string, unknown> | undefined {
  const value = event?.content

  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Validates server state, never local cache state. Membership state retains a
 * leave/ban record, so requiring the sole membership state to be the owner is
 * a fail-closed check that no other user has ever participated. Encryption is
 * optional (0.20 makes the room plain); when present it is the owner's Megolm. */
async function validateRoom(client: MatrixClient, roomId: string, owner: string, live: () => boolean): Promise<void> {
  active(live)
  const raw = await client.roomState(roomId)
  active(live)

  if (!Array.isArray(raw)) {
    throw failure('invalid')
  }

  const events = raw as StateEvent[]
  const create = only(events, EventType.RoomCreate)
  const encryption = only(events, EventType.RoomEncryption)
  const history = only(events, EventType.RoomHistoryVisibility)
  const createContent = content(create)
  const encryptionContent = content(encryption)
  const historyContent = content(history)
  const members = events.filter(event => event.type === EventType.RoomMember)

  if (
    !createContent ||
    createContent.type !== AWARENESS_CONTROL_ROOM_TYPE ||
    create?.sender !== owner ||
    (createContent.creator !== undefined && createContent.creator !== owner) ||
    (events.some(event => event.type === EventType.RoomEncryption) &&
      (!encryptionContent || encryptionContent.algorithm !== MEGOLM || encryption?.sender !== owner)) ||
    !historyContent ||
    historyContent.history_visibility !== 'joined' ||
    history?.sender !== owner ||
    members.length !== 1 ||
    members[0]?.state_key !== owner ||
    members[0]?.sender !== owner ||
    content(members[0])?.membership !== 'join'
  ) {
    throw failure('invalid')
  }
}

async function readReference(client: MatrixClient, live: () => boolean): Promise<AwarenessControlReference | null> {
  active(live)
  // MatrixClient returns null only for an absent server account-data event. A
  // transport/read error deliberately propagates and is never treated as absent.
  const value = await client.getAccountDataFromServer(AWARENESS_CONTROL_REFERENCE)
  active(live)

  if (value === null) {
    return null
  }

  if (!validAwarenessControlReference(value)) {
    throw failure('invalid')
  }

  return value
}

/** Read all intent to the immutable creation boundary. An unreadable page is
 * never an empty policy, and event timestamps never decide concurrent order. */
async function readControls(client: MatrixClient, live: () => boolean): Promise<{roomId?:string;controls:AwarenessControl[]}> {
  const owner=ownerOf(client), reference=await readReference(client,live)

  if (!reference) {return {controls:[]}}
  await validateCurrentReference(client,reference,owner,live)
  const state=await client.roomState(reference.roomId)
  active(live)
  const anchor=state.find(e=>e.type === EventType.RoomCreate && e.state_key === '')?.event_id
  // A controls room without encryption (0.20) carries plain control events; in an
  // encrypted one a plaintext control is refused, as before (no downgrade).
  const plain = !state.some(e => e.type === EventType.RoomEncryption)

  if (typeof anchor !== 'string') {throw failure('invalid')}
  const controls:AwarenessControl[]=[], cursors=new Set<string>(), seen=new Set<string>()
  let from:string|null=null

  for(let at=0;at<200;at++) {
    const page=await client.createMessagesRequest(reference.roomId,from,50,Direction.Backward)
    active(live)

    if (!Array.isArray(page.chunk) || page.chunk.length>50) {throw failure('invalid')}

    for(const raw of page.chunk) {
      if(typeof raw.event_id !== 'string' || seen.has(raw.event_id) || (raw.room_id !== undefined && raw.room_id !== reference.roomId)) {throw failure('invalid')}
      seen.add(raw.event_id)

      if(raw.event_id === anchor) {
        await validateCurrentReference(client,reference,owner,live)
        const ordered=controls.reverse(), ids=new Map<string,string>()

        for(const control of ordered) {
          const body=JSON.stringify(control), old=ids.get(control.id)

          if(old && old !== body) {throw failure('invalid')}
          ids.set(control.id,body)
        }

        return {roomId:reference.roomId,controls:ordered}
      }

      if(raw.type === EventType.RoomRedaction) {throw failure('invalid')}

      if (
        plain &&
        raw.type === AWARENESS_CONTROL_EVENT &&
        typeof (raw as { state_key?: unknown }).state_key !== 'string'
      ) {
        const event = new MatrixEvent({ ...raw, room_id: reference.roomId })

        if (event.isRedacted() || event.getSender() !== owner || !validAwarenessControl(event.getContent())) {
          throw failure('invalid')
        }

        controls.push(event.getContent() as AwarenessControl)

        continue
      }

      if(raw.type !== EventType.RoomMessageEncrypted) {
        if(typeof (raw as {state_key?:unknown}).state_key !== 'string') {throw failure('invalid')}

        continue
      }

      const event=new MatrixEvent({...raw,room_id:reference.roomId})
      await client.decryptEventIfNeeded(event)
      active(live)

      if(event.isDecryptionFailure() || event.isRedacted() || event.getSender() !== owner ||
          event.getType() !== AWARENESS_CONTROL_EVENT || !validAwarenessControl(event.getContent())) {throw failure('invalid')}

      controls.push(event.getContent() as AwarenessControl)
    }

    if(!page.end || page.end === from || cursors.has(page.end)) {throw failure('unavailable')}
    cursors.add(page.end);from=page.end
  }

  throw failure('unavailable')
}

function roomSources(client:MatrixClient, roomId:string):AwarenessSource[] {
  const room=client.getRoom(roomId)

  if(!room || room.getMyMembership() !== 'join') {throw failure('unavailable')}
  const type=room.currentState.getStateEvents(EventType.RoomCreate,'')?.getContent().type

  if(type === AWARENESS_CONTROL_ROOM_TYPE) {throw failure('invalid')}

  if(type === 'io.atum.assistant') {return [{kind:'assistant_chat',id:roomId}]}

  if(type === 'io.atum.app_group.v1') {return [{kind:'app_exchange',id:roomId}]}

  // m.direct is mutable display metadata. One room preference covers both
  // human classifications so moving it cannot resurrect excluded evidence.
  return [{kind:'human_dm',id:roomId},{kind:'human_group',id:roomId}]
}

/** A room the owner may switch: an encrypted one as before (Megolm, history from joining), or
 * one without encryption (0.20 agent, bot, people and group chats) with any history setting. */
function eligibleState(encryption: unknown, history: unknown): boolean {
  return encryption === undefined || (encryption === MEGOLM && history === 'joined')
}

function eligible(client:MatrixClient,roomId:string):boolean {
  const room=client.getRoom(roomId)
  const encryption=room?.currentState.getStateEvents(EventType.RoomEncryption,'')

  return !!room && room.getMyMembership() === 'join' &&
    eligibleState(encryption ? (encryption.getContent().algorithm ?? null) : undefined,
      room.currentState.getStateEvents(EventType.RoomHistoryVisibility,'')?.getContent().history_visibility)
}

/** Null when the account has no controls room (no owner reader was ever enrolled):
 * there is nothing a choice could apply to, so the owner is not offered one. */
export async function readAwarenessRooms(client:MatrixClient,live:()=>boolean):Promise<MatrixAwarenessRoom[] | null> {
  const {roomId,controls}=await readControls(client,live)
  active(live)

  if (!roomId) {return null}

  return client.getRooms().filter(r=>r.roomId !== roomId && eligible(client,r.roomId)).map(room=>{
    const sources=roomSources(client,room.roomId), kinds=new Set(sources.map(s=>s.kind)), included=new Map<string,boolean>()
    let forgotten=false

    for(const control of controls) {
      if(control.action === 'include' && control.source.id === room.roomId && kinds.has(control.source.kind)) {included.set(control.source.kind,control.included)}

      if(control.action === 'withdraw' && (control.scope.kind === 'account' ||
          (control.scope.kind === 'source' && control.scope.source.id === room.roomId && kinds.has(control.scope.source.kind)))) {forgotten=true}
    }

    return {roomId:room.roomId,name:room.name || room.roomId,included:![...included.values()].includes(false),forgotten}
  }).sort((a,b)=>a.name.localeCompare(b.name))
}

/** Native derives source scope from the current authenticated room. No
 * renderer-supplied source, operation id or arbitrary withdrawal crosses here. */
export async function changeAwarenessRoom(client:MatrixClient,roomId:string,action:'include'|'exclude'|'forget',live:()=>boolean):Promise<MatrixAwarenessRoom[]> {
  active(live)

  if(!/^![^\s:]+:[^\s]+$/.test(roomId) || !['include','exclude','forget'].includes(action) || !eligible(client,roomId)) {throw failure('invalid')}

  // Resolve any existing history error before accepting further owner intent.
  // Without a controls room there is no reader to honour the change.
  if (!(await readControls(client,live)).roomId) {throw failure('unavailable')}
  const state=await client.roomState(roomId)
  active(live)
  const membership=state.find(e=>e.type === EventType.RoomMember && e.state_key === ownerOf(client))
  const encryption=state.find(e=>e.type === EventType.RoomEncryption && e.state_key === '')

  if(membership?.content?.membership !== 'join' ||
      !eligibleState(encryption ? (encryption.content?.algorithm ?? null) : undefined,
        state.find(e=>e.type === EventType.RoomHistoryVisibility && e.state_key === '')?.content?.history_visibility)) {throw failure('unavailable')}

  for(const source of roomSources(client,roomId)) {
    if(!eligible(client,roomId)) {throw failure('stale')}

    const control:AwarenessControl=action === 'forget' ? {v:1,id:globalThis.crypto.randomUUID(),action:'withdraw',scope:{kind:'source',source},reason:'forget'} :
      {v:1,id:globalThis.crypto.randomUUID(),action:'include',source,included:action === 'include'}

    await sendAwarenessControl(client,control,live)
  }

  const rooms=await readAwarenessRooms(client,live)

  if (!rooms) {throw failure('stale')}

  return rooms
}

async function validateCurrentReference(
  client: MatrixClient,
  reference: AwarenessControlReference,
  owner: string,
  live: () => boolean
): Promise<AwarenessControlReference> {
  await validateRoom(client, reference.roomId, owner, live)
  const current = await readReference(client, live)

  if (current === null || current.roomId !== reference.roomId) {
    throw failure('stale')
  }

  return current
}

function validCreatedRoom(value: unknown): value is { room_id: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    validAwarenessControlReference({ v: 1, roomId: (value as { room_id?: unknown }).room_id })
  )
}

async function prepare(
  client: MatrixClient,
  live: () => boolean,
  state: ClientPreparation
): Promise<AwarenessControlReference> {
  const owner = ownerOf(client)
  const reference = await readReference(client, live)

  if (reference !== null) {
    return validateCurrentReference(client, reference, owner, live)
  }

  state.uncertain = true

  const created = await client.createRoom({
    preset: Preset.PrivateChat,
    creation_content: { type: AWARENESS_CONTROL_ROOM_TYPE },
    // No end-to-end encryption (0.20): a reader without keys reads the owner's choices.
    initial_state: [{ type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'joined' } }]
  })

  active(live)

  if (!validCreatedRoom(created)) {
    throw failure('invalid')
  }

  const ours: AwarenessControlReference = { v: 1, roomId: created.room_id }
  await validateRoom(client, ours.roomId, owner, live)

  // Account data has no compare-and-set. Re-read after creation: if another
  // owner device won, validate and use that existing room; this orphan never
  // authorizes adoption or a second create.
  const concurrent = await readReference(client, live)

  if (concurrent !== null) {
    const current = await validateCurrentReference(client, concurrent, owner, live)
    state.uncertain = false

    return current
  }

  await client.setAccountData(AWARENESS_CONTROL_REFERENCE, ours)
  active(live)
  const written = await readReference(client, live)

  if (written === null) {
    throw failure('stale')
  }

  const current = await validateCurrentReference(client, written, owner, live)
  state.uncertain = false

  return current
}

/** Reads existing owner custody or creates exactly one room for this SDK client.
 * Any unknown create/write outcome closes creation for that client instance. */
export async function prepareAwarenessControls(
  client: MatrixClient,
  live: () => boolean
): Promise<AwarenessControlReference> {
  let state = preparations.get(client)

  if (!state) {
    state = { uncertain: false }
    preparations.set(client, state)
  }

  if (state.uncertain && !state.promise) {
    throw failure('uncertain')
  }

  if (state.promise) {
    return state.promise
  }

  state.promise = prepare(client, live, state).finally(() => {
    state!.promise = undefined
  })

  return state.promise
}

/** Sends one exact owner intent under a deterministic Matrix transaction ID.
 * There is intentionally no automatic retry: the caller can safely observe the
 * accepted event before deciding whether a later explicit retry is warranted. */
export async function sendAwarenessControl(
  client: MatrixClient,
  control: AwarenessControl,
  live: () => boolean
): Promise<void> {
  if (!validAwarenessControl(control)) {
    throw failure('invalid')
  }

  const owner = ownerOf(client)
  const reference = await readReference(client, live)

  if (reference === null) {
    throw failure('unavailable')
  }

  const current = await validateCurrentReference(client, reference, owner, live)
  active(live)
  await client.sendEvent(current.roomId, AWARENESS_CONTROL_EVENT, control, `atum-aw-control-${control.id}`)
  active(live)
}
