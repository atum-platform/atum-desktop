import { Direction, EventStatus, EventType, Filter, type MatrixClient, MatrixEvent, MsgType, type Room } from 'matrix-js-sdk'

import {canonicalJson} from '../../../../packages/device-protocol/canonical'
import type {MatrixCompanyAISdkCommand} from '../../shared/matrix-company-ai-sdk'
import { COMPANY_AI_WATCH_COUNTERS, type MatrixCompanyAIWatchDiagnostics } from '../../shared/matrix-company-ai-sdk'
import type {
  MatrixCompanyAIFindPublishedRequest,
  MatrixCompanyAIJoinRequest,
  MatrixCompanyAIJoinResult,
  MatrixCompanyAIOnboardingWelcomeRequest,
  MatrixCompanyAIReadEventRequest,
  MatrixCompanyAIThreadMessageRequest,
  MatrixCompanyAIWatchCheckpoint,
  MatrixCompanyAIWatchHint,
  MatrixCompanyAIWatchRequest,
  MatrixCompanyAIWatchValue,
  MatrixCompanyPrivateCosGreetingRequest,
  MatrixCompanyPrivateCosJoinResult,
  MatrixCompanyPrivateCosPublishRequest,
  MatrixCompanyPrivateCosQuestionRequest,
  MatrixCompanyPrivateCosScope,
  MatrixCompanyPrivateCosVerifiedEvent,
  MatrixCompanyPrivateCosWatchRequest
} from '../../shared/matrix-company-ai-sdk'
import { companyChannelRoomBinding, MATRIX_COMPANY_CHANNEL_TYPE } from '../../shared/matrix-company-channel-room'
import type {
  MatrixCompanyCitationOpenRequest,
  MatrixCompanyCitationOpenValue
} from '../../shared/matrix-company-search'

import {privateCosJoinFailure} from './sdk-error-code'
import { sendWithTransaction } from './turn'

/**
 * The CoS SDK commands. Every one fails closed: a room must be a joined
 * `io.atum.company_channel.v1` room whose immutable create binding names the
 * requested company (and channel), and every event is re-read from the server
 * before it becomes a question, a hint or a publication.
 */

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const ROOM_ID = /^![!-9;-~]{1,255}:[!-~]{1,255}$/u
const EVENT_ID = /^\$[!-~]{1,511}$/u
const USER_ID = /^@[!-9;-~]{1,255}:[!-~]{1,255}$/u
const TRANSACTION_ID = /^[A-Za-z0-9._~-]{8,128}$/u
const WELCOME_TRANSACTION_ID = /^atum-company-welcome-[a-f0-9]{32}$/u
const BOARD_LINK = /^https:\/\/atumplatform\.com\/#atum-board\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?:\/card\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})?$/u
const QUESTION_LIMIT = 4_000
const HISTORY_LIMIT = 8
const HISTORY_CHARACTERS = 12_000
const WATCH_LIMIT = 100
const WATCH_SEED_PAGES = 10
const WATCH_FETCHES_PER_SCAN = 4
const WATCH_EVENTS_PER_ROOM = 25
// Company channel creation currently forbids m.room.encryption. Keep the page filter message-only for cost,
// but fail the watch loudly below if that invariant ever changes instead of silently missing encrypted mentions.
const WATCH_FILTER=Filter.fromJson(null,'company-ai-watch',{room:{timeline:{types:[EventType.RoomMessage]}}})

function watchToken(value: string): boolean {
  return value.length >= 1 && value.length <= 4_096 &&
    [...value].every(character => character.codePointAt(0)! >= 32 && character.codePointAt(0) !== 127)
}

function unavailable(): never {
  throw new Error('matrix_company_ai_unavailable')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textContent(event: MatrixEvent): string | null {
  if (event.isRedacted() || event.isDecryptionFailure() || event.getType() !== EventType.RoomMessage) {
    return null
  }

  const content = event.getContent()

  if (!record(content) || content.msgtype !== MsgType.Text || typeof content.body !== 'string') {
    return null
  }

  // An edit is not a new question or answer; its server projection replaces the target.
  if (record(content['m.relates_to']) && content['m.relates_to'].rel_type === 'm.replace') {
    return null
  }

  return content.body
}

function relatedTo(content: Record<string, unknown>): Record<string, unknown> | null {
  const relation = content['m.relates_to']

  return record(relation) ? relation : null
}

function threadRootOf(content: Record<string, unknown>): string | null {
  const relation = relatedTo(content)

  if (!relation) {
    return null
  }

  return relation.rel_type === 'm.thread' && typeof relation.event_id === 'string' && EVENT_ID.test(relation.event_id)
    ? relation.event_id
    : null
}

function replyToOf(content: Record<string, unknown>): string | null {
  const relation = relatedTo(content)
  const reply = relation ? relation['m.in_reply_to'] : undefined

  return record(reply) && typeof reply.event_id === 'string' && EVENT_ID.test(reply.event_id) ? reply.event_id : null
}

function mentionedUserIds(content: Record<string, unknown>): string[] {
  const mentions = content['m.mentions']
  const ids = record(mentions) ? mentions.user_ids : undefined

  return Array.isArray(ids) && ids.length <= 100 && ids.every(item => typeof item === 'string' && USER_ID.test(item)) &&
    new Set(ids).size === ids.length
    ? (ids as string[])
    : []
}

function immutableRoomBinding(room: Room): { companyId: string; channelId: string } | null {
  const creation = room.currentState.getStateEvents(EventType.RoomCreate, '')
  const binding = creation && companyChannelRoomBinding(creation.getContent(), creation.getSender())

  return binding && room.getType() === MATRIX_COMPANY_CHANNEL_TYPE && creation.getRoomId() === room.roomId
    ? { companyId: binding.companyId, channelId: binding.channelId }
    : null
}

function roomBinding(room: Room): { companyId: string; channelId: string } | null {
  return room.getMyMembership() === 'join' ? immutableRoomBinding(room) : null
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) {return true}

  if (!record(left) || !record(right)) {return false}
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()

  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] &&
    sameJson(left[key], right[key]))
}

/**
 * The planned power levels, exactly, except for one key Synapse adds on its own: `historical: 100`
 * (the server's default for the historical-events power level; the platform plan never sets it).
 * Any other extra key, or another historical value, still fails.
 */
function samePrivatePowerLevels(actual: unknown, expected: unknown): boolean {
  if (record(actual) && record(expected) && !('historical' in expected) && actual.historical === 100) {
    const { historical: _serverDefault, ...planned } = actual

    return sameJson(planned, expected)
  }

  return sameJson(actual, expected)
}

/** Invite authority is deliberately tiny: exact destination plus immutable create type. */
function validPrivateCosScope(scope: MatrixCompanyPrivateCosScope): void {
  if (!ROOM_ID.test(scope.roomId) || !UUID.test(scope.companyId) || !UUID.test(scope.memberPrincipal) ||
      !UUID.test(scope.membershipIncarnation) || !UUID.test(scope.executorId) || !UUID.test(scope.attemptId)||
      !USER_ID.test(scope.memberUserId) ||
      !USER_ID.test(scope.agentUserId) || !USER_ID.test(scope.managerUserId) ||
      scope.memberUserId === scope.agentUserId) {throw new Error('matrix_private_cos_scope_invalid')}
}

function privateCosInvite(client: MatrixClient, scope: MatrixCompanyPrivateCosScope): Room {
  validPrivateCosScope(scope)
  const room = client.getRoom(scope.roomId)

  if (!room || room.roomId !== scope.roomId) {throw new Error('matrix_private_cos_room_missing')}

  if (room.getType() !== 'io.atum.assistant') {throw new Error('matrix_private_cos_room_type_invalid')}

  return room
}

/** Full private-room state is authoritative only after the invite was accepted and synced. */
function privateCosRoom(client: MatrixClient, scope: MatrixCompanyPrivateCosScope,
  membership: 'agent' | 'pair'): Room {
  const room = privateCosInvite(client, scope)
  const marker = room.currentState.getStateEvents('io.atum.company_private_cos', '')
  const powers = room.currentState.getStateEvents(EventType.RoomPowerLevels, '')
  const name = room.currentState.getStateEvents(EventType.RoomName, '')
  const history = room.currentState.getStateEvents(EventType.RoomHistoryVisibility, '')
  const joinRule = room.currentState.getStateEvents(EventType.RoomJoinRules, '')
  const guest = room.currentState.getStateEvents(EventType.RoomGuestAccess, '')
  const encryption = room.currentState.getStateEvents(EventType.RoomEncryption, '')
  const markerContent = marker?.getContent()

  if (!record(markerContent) || Object.keys(markerContent).sort().join(',') !==
        ['v','classification','companyId','membershipIncarnation','executorId','attemptId'].sort().join(',') ||
      markerContent.v !== 1 || markerContent.classification !== 'company_private_cos' ||
      markerContent.companyId !== scope.companyId || markerContent.membershipIncarnation !== scope.membershipIncarnation ||
      markerContent.executorId !== scope.executorId||markerContent.attemptId!==scope.attemptId||
      !samePrivatePowerLevels(powers?.getContent(), scope.powerLevels) ||
      !sameJson(name?.getContent(), {name:scope.roomName}) ||
      !sameJson(history?.getContent(), {history_visibility:scope.historyVisibility}) ||
      !sameJson(joinRule?.getContent(), {join_rule:scope.joinRule}) ||
      !sameJson(guest?.getContent(), {guest_access:scope.guestAccess}) || encryption) {return unavailable()}

  if (room.getMyMembership() !== 'join') {return unavailable()}
  const joined=room.getJoinedMembers().map(member=>member.userId)

  if(!joined.includes(scope.agentUserId)||joined.some(userId=>![scope.memberUserId,scope.agentUserId].includes(userId)))
    {return unavailable()}

  if (membership === 'pair') {
    const members = [...joined].sort()
    const expected = [scope.memberUserId, scope.agentUserId].sort()

    if (members.length !== 2 || members[0] !== expected[0] || members[1] !== expected[1]) {return unavailable()}
  }

  return room
}

async function quarantineCompanyPrivateCosRoom(client: MatrixClient, roomId: string): Promise<'quarantined'> {
  await client.leave(roomId)

  return 'quarantined'
}

/** The other joined user in a verified plain private-CoS room; ordinary desktop sends mention it. */
export function companyPrivateCosRecipient(room:Room,senderUserId:string):string|null{
  const marker=room.currentState.getStateEvents('io.atum.company_private_cos','')
  const name=room.currentState.getStateEvents(EventType.RoomName,'')
  const encryption=room.currentState.getStateEvents(EventType.RoomEncryption,'')
  const content=marker?.getContent()
  const members=room.getJoinedMembers().map(member=>member.userId)

  if(room.getMyMembership()!=='join'||room.getType()!=='io.atum.assistant'||encryption||
    !record(content)||Object.keys(content).sort().join(',')!==
      ['v','classification','companyId','membershipIncarnation','executorId','attemptId'].sort().join(',')||
    content.v!==1||content.classification!=='company_private_cos'||!UUID.test(String(content.companyId))||
    !UUID.test(String(content.membershipIncarnation))||!UUID.test(String(content.executorId))||
    !UUID.test(String(content.attemptId))||
    !sameJson(name?.getContent(),{name:'Chief of Staff'})||members.length!==2||!members.includes(senderUserId)){return null}

  return members.find(userId=>userId!==senderUserId)??null
}

/** Accept only the platform-bound private invite, then prove the synced room is joined and unchanged. */
export async function joinCompanyPrivateCosRoom(
  client: MatrixClient,
  scope: MatrixCompanyPrivateCosScope,
  active: () => boolean = () => true
): Promise<MatrixCompanyPrivateCosJoinResult> {
  if (!active()) {return unavailable()}

  if (client.getUserId() !== scope.agentUserId) {throw new Error('matrix_private_cos_identity_unavailable')}
  validPrivateCosScope(scope)

  // PREPARED can come from a restored cache predating this room/invite. Keep the
  // session alive for live sync; activation owns the bounded wait and lease fence.
  if (!client.getRoom(scope.roomId)) {return 'join_pending'}
  const room = privateCosInvite(client, scope)

  if (room.getMyMembership() === 'join') {
    if (room.getJoinedMembers().some(member => member.userId === scope.managerUserId)) {return 'manager_pending'}

    try {privateCosRoom(client, scope, 'agent')}
    catch {return quarantineCompanyPrivateCosRoom(client, scope.roomId)}

    return 'already_joined'
  }

  if (room.getMyMembership() !== 'invite') {return 'not_invited'}

  const accepted = await client.joinRoom(scope.roomId).catch(error => {
    throw privateCosJoinFailure(error)
  })

  if (accepted.roomId !== scope.roomId) {throw new Error('matrix_private_cos_join_result_invalid')}
  const deadline = Date.now() + 5_000

  for (;;) {
    if (!active()) {return unavailable()}
    const joined = client.getRoom(scope.roomId)

    if (joined?.getMyMembership() === 'join') {
      if (joined.getJoinedMembers().some(member => member.userId === scope.managerUserId)) {return 'manager_pending'}

      try {privateCosRoom(client, scope, 'agent')}
      catch {return quarantineCompanyPrivateCosRoom(client, scope.roomId)}

      return 'joined'
    }

    if (Date.now() >= deadline) {return 'join_pending'}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Teardown may leave only the exact room that was bound to this private executor. */
export async function leaveCompanyPrivateCosRoom(client: MatrixClient,
  scope: MatrixCompanyPrivateCosScope): Promise<true> {
  const room = privateCosInvite(client, scope)

  if (room.getMyMembership() === 'join' || room.getMyMembership() === 'invite') {
    await client.leave(scope.roomId)
  }

  return true
}

/**
 * Accept one platform-selected Company CoS invitation. The command destination
 * is necessary but not sufficient authority: immutable room-v11 state and the
 * authenticated SDK identity are both re-checked before and after the join.
 * A room this client has not been invited to yet is `not_invited`, not an error:
 * the platform plan can name a room before the channel manager's invite syncs.
 */
export async function joinCompanyAIChannel(
  client: MatrixClient,
  command: MatrixCompanyAIJoinRequest,
  expectedUserId: string,
  active: () => boolean = () => true,
  confirmMs = 5_000
): Promise<MatrixCompanyAIJoinResult> {
  if (!active() || !UUID.test(command.companyId) || !UUID.test(command.channelId) ||
      !ROOM_ID.test(command.roomId) || !USER_ID.test(expectedUserId) || client.getUserId() !== expectedUserId) {
    return unavailable()
  }

  const bound = (room: Room | null): boolean => {
    const binding = room && immutableRoomBinding(room)

    return binding?.companyId === command.companyId && binding.channelId === command.channelId
  }

  const room = client.getRoom(command.roomId)

  if (!room) {
    return 'not_invited'
  }

  if (!bound(room)) {
    return unavailable()
  }

  if (room.getMyMembership() === 'join') {
    return 'already_joined'
  }

  if (room.getMyMembership() !== 'invite') {
    return 'not_invited'
  }

  const accepted = await client.joinRoom(command.roomId)

  if (accepted.roomId !== command.roomId) {
    return unavailable()
  }

  // matrix-js-sdk returns a detached Room from joinRoom; the stored room turns
  // `join` only when sync delivers it. Wait a bounded time for that read-back.
  const deadline = Date.now() + confirmMs

  for (;;) {
    if (!active()) {
      return unavailable()
    }

    const joined = client.getRoom(command.roomId)

    if (joined?.getMyMembership() === 'join') {
      return bound(joined) ? 'joined' : unavailable()
    }

    if (Date.now() >= deadline) {
      return 'join_pending'
    }

    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** A joined company channel room for this company, re-derived from immutable state. */
function companyRoom(client: MatrixClient, roomId: string, companyId: string): Room {
  if (!ROOM_ID.test(roomId)) {
    return unavailable()
  }

  const room = client.getRoom(roomId)
  const binding = room && roomBinding(room)

  return room && binding?.companyId === companyId ? room : unavailable()
}

/** A joined company channel room for this company and channel. */
function companyChannelRoom(client: MatrixClient, companyId: string, channelId: string): Room {
  if (!UUID.test(channelId)) {
    return unavailable()
  }

  for (const candidate of client.getRooms()) {
    const binding = roomBinding(candidate)

    if (binding?.companyId === companyId && binding.channelId === channelId) {
      return candidate
    }
  }

  return unavailable()
}

function exactEvent(room: Room, raw: unknown, eventId: string): MatrixEvent {
  return optionalExactEvent(room,raw,eventId)??unavailable()
}

function optionalExactEvent(room:Room,raw:unknown,eventId:string):MatrixEvent|null{
  if(!record(raw)){return null}
  const event=new MatrixEvent(raw as never)

  return event.getId()===eventId&&event.getRoomId()===room.roomId&&textContent(event)!==null?event:null
}

function matrixEventMissing(error:unknown):boolean{
  const value=error as {errcode?:unknown;httpStatus?:unknown;statusCode?:unknown;message?:unknown}|null

  return value?.errcode==='M_NOT_FOUND'||value?.httpStatus===404||value?.statusCode===404||
    value?.message==='matrix_not_found'
}

function orderedThread(room: Room, rootId: string, triggerId: string): MatrixEvent[] {
  const events = [...room.getLiveTimeline().getEvents(), ...(room.getThread?.(rootId)?.events ?? [])]

  return [...new Map(events.map(event => [event.getId(), event])).values()]
    .filter(event => {
      if (event.getId() === triggerId || event.getId() === rootId || (textContent(event) ?? '').length === 0) {
        return false
      }

      const content = event.getContent()

      return threadRootOf(content) === rootId && event.getSender() !== null
    })
    .sort((left, right) => left.getTs() - right.getTs())
}

interface WatchPosition {roomId:string;token:string;liveEventId:string|null;draining:boolean}

function watchPositions(checkpoint:MatrixCompanyAIWatchCheckpoint):{positions:Map<string,WatchPosition>;nextRoomId:string|null}{
  if (!record(checkpoint) || !Array.isArray(checkpoint.positions) || checkpoint.positions.length > 10_000 ||
      checkpoint.nextRoomId!==undefined&&checkpoint.nextRoomId!==null&&
        (typeof checkpoint.nextRoomId!=='string'||!ROOM_ID.test(checkpoint.nextRoomId))) {
    return unavailable()
  }

  const positions = new Map<string,WatchPosition>()

  for (const value of checkpoint.positions) {
    if (!record(value) || !['roomId,token','draining,liveEventId,roomId,token']
      .includes(Object.keys(value).sort().join(',')) ||
        typeof value.roomId !== 'string' || !ROOM_ID.test(value.roomId) ||
        typeof value.token !== 'string' || !watchToken(value.token) || positions.has(value.roomId)||
        value.liveEventId!==undefined&&value.liveEventId!==null&&
          (typeof value.liveEventId!=='string'||!EVENT_ID.test(value.liveEventId))||
        value.draining!==undefined&&typeof value.draining!=='boolean') {
      return unavailable()
    }

    positions.set(value.roomId,{roomId:value.roomId,token:value.token,
      liveEventId:typeof value.liveEventId==='string'?value.liveEventId:null,
      draining:value.draining??true})
  }

  return {positions,nextRoomId:checkpoint.nextRoomId??null}
}

function roomMovement(room:Room):string|null{
  const event=room.getLiveTimeline().getEvents().at(-1)
  const eventId=event?.getId()

  return eventId&&EVENT_ID.test(eventId)?eventId:null
}

function pageToken(value: unknown): string | null {
  return typeof value === 'string' && watchToken(value) ? value : null
}

/** Find one bounded historical boundary, then let forward pagination deliver every event after it. */
async function seedWatchPosition(
  client: MatrixClient,
  roomId: string,
  catchupAfterMs: number,
  active: () => boolean,
  pageScanned?: () => void
): Promise<string> {
  let from: string | null = null
  let boundary = pageToken(client.store.getSyncToken())

  for (let page = 0; page < WATCH_SEED_PAGES; page += 1) {
    if (!active()) {
      return unavailable()
    }

    const batch=await client.createMessagesRequest(roomId,from,WATCH_LIMIT,Direction.Backward,WATCH_FILTER)

    if (!Array.isArray(batch.chunk) || batch.chunk.length > WATCH_LIMIT) {
      return unavailable()
    }

    pageScanned?.()
    const start = pageToken(batch.start)
    const end = pageToken(batch.end)
    boundary = end ?? start ?? boundary

    const reached = batch.chunk.length < WATCH_LIMIT || batch.chunk.some(raw => {
      const at = new MatrixEvent(raw).getTs()

      return Number.isSafeInteger(at) && at <= catchupAfterMs
    })

    if (reached || !end) {
      return boundary ?? unavailable()
    }

    from = end
  }

  return boundary ?? unavailable()
}

async function forwardWatchPage(
  client: MatrixClient,
  room: Room,
  from: string,
  limit: number,
  active: () => boolean
): Promise<{events:MatrixEvent[];token:string;draining:boolean}> {
  if (!active()) {
    return unavailable()
  }

  const batch=await client.createMessagesRequest(room.roomId,from,limit,Direction.Forward,WATCH_FILTER)

  if (!Array.isArray(batch.chunk) || batch.chunk.length > limit) {
    return unavailable()
  }

  const end=pageToken(batch.end)

  if(end&&batch.chunk.length>0&&end===from){return unavailable()}
  const token=end??from

  if(!token){
    return unavailable()
  }

  const events: MatrixEvent[] = []

  for (const raw of batch.chunk) {
    if (!active()) {
      return unavailable()
    }

    const event = new MatrixEvent(raw)

    if (event.getRoomId() !== room.roomId) {
      return unavailable()
    }

    if (event.isEncrypted()) {
      await client.decryptEventIfNeeded(event)
    }

    events.push(event)
  }

  return {events,token,draining:Boolean(end)}
}

/** Hints for messages that address the CoS in this company's joined channel rooms. */
export async function watchCompanyAI(
  client: MatrixClient,
  command: MatrixCompanyAIWatchRequest,
  active: () => boolean = () => true
): Promise<MatrixCompanyAIWatchValue> {
  if (!active() || !UUID.test(command.companyId) || !USER_ID.test(command.agentUserId) ||
      !Number.isSafeInteger(command.catchupAfterMs) || command.catchupAfterMs < 0) {
    return unavailable()
  }

  const prior=watchPositions(command.checkpoint)
  const hints: Array<MatrixCompanyAIWatchHint & { at: number }> = []

  const diagnostics = Object.fromEntries(COMPANY_AI_WATCH_COUNTERS.map(key => [key, 0])) as MatrixCompanyAIWatchDiagnostics
  const rooms:Room[]=[]

  for(const room of client.getRooms()){
    diagnostics.rooms += 1

    if (room.getMyMembership() !== 'join') {continue}
    diagnostics.joined += 1
    const binding = roomBinding(room)

    if (!binding) { diagnostics.unbound += 1;

 continue }

    if(binding.companyId!==command.companyId){diagnostics.otherCompany += 1;

 continue}

    diagnostics.bound += 1

    if(room.currentState.getStateEvents(EventType.RoomEncryption,'')){return unavailable()}
    rooms.push(room)
  }

  rooms.sort((left,right)=>left.roomId.localeCompare(right.roomId))

  const roomIds=new Set(rooms.map(room=>room.roomId))
  const positions=new Map([...prior.positions].filter(([roomId])=>roomIds.has(roomId)))
  const nextAfter=prior.nextRoomId
  let start=nextAfter?rooms.findIndex(room=>room.roomId>nextAfter):0

  if(start<0){start=0}
  const selected=rooms.slice(start)
  let fetches=0
  let lastVisited=nextAfter
  let nextRoomId:string|null=null

  for (const room of selected) {
    const previous=positions.get(room.roomId)
    const liveEventId=roomMovement(room)
    const moved=!previous||previous.draining||previous.liveEventId!==liveEventId

    if(moved&&fetches>=WATCH_FETCHES_PER_SCAN){
      nextRoomId=lastVisited

      break
    }

    if(!previous){
      diagnostics.seeded += 1
      fetches+=1
      positions.set(room.roomId,{roomId:room.roomId,
        token:await seedWatchPosition(client,room.roomId,command.catchupAfterMs,active,
          () => { diagnostics.seedPages += 1 }),liveEventId,draining:true})
      lastVisited=room.roomId

      continue
    }

    if(!moved){
      diagnostics.unchanged += 1
      lastVisited=room.roomId

      continue
    }

    fetches+=1
    const page=await forwardWatchPage(client,room,previous.token,WATCH_EVENTS_PER_ROOM,active)
    diagnostics.pages += 1

    if (page.token !== previous.token) {diagnostics.checkpointMoved += 1}
    positions.set(room.roomId,{roomId:room.roomId,token:page.token,liveEventId,draining:page.draining})
    lastVisited=room.roomId

    for (const event of page.events) {
      const eventId = event.getId()
      const at = event.getTs()
      const content = event.getContent()

      diagnostics.scanned += 1

      if (!eventId || !EVENT_ID.test(eventId) || !Number.isSafeInteger(at)) {
        diagnostics.invalid += 1;

 continue
      }

      if (event.getSender() === command.agentUserId) { diagnostics.self += 1;

 continue }

      if (textContent(event) === null) { diagnostics.nonText += 1;

 continue }

      if (!mentionedUserIds(content).includes(command.agentUserId)) { diagnostics.notMentioned += 1;

 continue }

      const relation = relatedTo(content)

      if ((relation?.rel_type !== undefined && relation.rel_type !== 'm.thread') ||
          (relation?.rel_type === 'm.thread' && threadRootOf(content) === null)) {
        diagnostics.relation += 1

        continue
      }

      diagnostics.matched += 1
      hints.push({roomId:room.roomId,eventId,at,atMs:at})
    }
  }

  hints.sort((left, right) => left.at - right.at || left.eventId.localeCompare(right.eventId))

  return {
    schemaVersion: 2,
    diagnostics,
    hints:hints.map(({roomId,eventId,atMs})=>({roomId,eventId,atMs})),
    checkpoint:{positions:[...positions.values()].sort((left,right)=>left.roomId.localeCompare(right.roomId)),nextRoomId}
  }
}

/** Poll only the bound two-user private room and return addressed original text events. */
export async function watchCompanyPrivateCos(
  client: MatrixClient,
  command: MatrixCompanyPrivateCosWatchRequest,
  active: () => boolean = () => true
): Promise<{ schemaVersion: 2; events: MatrixCompanyPrivateCosVerifiedEvent[];
  checkpoint: MatrixCompanyAIWatchCheckpoint; pairJoined: boolean }> {
  if (!active() || !Number.isSafeInteger(command.catchupAfterMs) || command.catchupAfterMs < 0) {
    return unavailable()
  }

  const prior=watchPositions(command.checkpoint)
  const room = privateCosRoom(client, command, 'agent')
  const members = room.getJoinedMembers().map(member => member.userId).sort()
  const expected = [command.memberUserId, command.agentUserId].sort()

  if (members.length !== 2 || members[0] !== expected[0] || members[1] !== expected[1]) {
    return { schemaVersion: 2, events: [], checkpoint: command.checkpoint, pairJoined: false }
  }

  const previous=prior.positions.get(room.roomId)
  const liveEventId=roomMovement(room)

  if(!previous){
    return {schemaVersion:2,events:[],checkpoint:{positions:[{roomId:room.roomId,
      token:await seedWatchPosition(client,room.roomId,command.catchupAfterMs,active),liveEventId,draining:true}],
    nextRoomId:null},pairJoined:true}
  }

  if(!previous.draining&&previous.liveEventId===liveEventId){return {schemaVersion:2,events:[],
    checkpoint:{positions:[previous],nextRoomId:null},pairJoined:true}}

  const page=await forwardWatchPage(client,room,previous.token,WATCH_EVENTS_PER_ROOM,active)

  const selected = page.events.flatMap(event => {
    const eventId = event.getId()
    const sender = event.getSender()
    const content = event.getContent()

    if (!eventId || !EVENT_ID.test(eventId) || sender !== command.memberUserId ||
        textContent(event) === null || !mentionedUserIds(content).includes(command.agentUserId)) {return []}

    const relation = relatedTo(content)

    if (relation?.rel_type === 'm.replace') {return []}

    return [{roomId: room.roomId, eventId, senderUserId: sender, mentionedAgentUserId: command.agentUserId,
      original: true as const, eventType: 'm.room.message' as const, messageType: 'm.text' as const,
      at:event.getTs(),atMs:event.getTs()}]
  }).sort((left, right) => left.at - right.at || left.eventId.localeCompare(right.eventId))

  return {schemaVersion:2,events:selected.map(({at:_at,...event})=>event),
    checkpoint:{positions:[{roomId:room.roomId,token:page.token,liveEventId,draining:page.draining}],nextRoomId:null},
    pairJoined:true}
}

/** Exact trigger plus a bounded seed, from the bound private room and no other room. */
export async function readCompanyPrivateCosQuestion(
  client: MatrixClient,
  command: MatrixCompanyPrivateCosQuestionRequest,
  active: () => boolean = () => true
): Promise<{text: string; seed: Array<{role: 'user' | 'assistant'; content: string}>}> {
  if (!active() || !EVENT_ID.test(command.eventId)) {return unavailable()}
  const room = privateCosRoom(client, command, 'pair')
  const trigger = exactEvent(room, await client.fetchRoomEvent(room.roomId, command.eventId), command.eventId)

  if (!active() || trigger.getSender() !== command.memberUserId ||
      !mentionedUserIds(trigger.getContent()).includes(command.agentUserId)) {return unavailable()}

  const text = bounded(textContent(trigger) ?? '', QUESTION_LIMIT)
  const seed: Array<{role: 'user' | 'assistant'; content: string}> = []
  let total = 0

  for (const event of room.getLiveTimeline().getEvents()
    .filter(event => event.getId() !== command.eventId && textContent(event) !== null)
    .sort((left, right) => left.getTs() - right.getTs()).reverse()) {
    const body = bounded(textContent(event) ?? '', QUESTION_LIMIT)

    if (total + body.length > HISTORY_CHARACTERS) {break}
    total += body.length
    seed.unshift({role: event.getSender() === command.agentUserId ? 'assistant' : 'user', content: body})

    if (seed.length === HISTORY_LIMIT) {break}
  }

  return {text, seed}
}

/** One deterministic reply in the bound private room. */
export async function publishCompanyPrivateCos(
  client: MatrixClient,
  command: MatrixCompanyPrivateCosPublishRequest
): Promise<string> {
  if (!EVENT_ID.test(command.eventId) || !TRANSACTION_ID.test(command.transactionId) ||
      command.text.length < 1 || command.text.length > 65_536) {return unavailable()}

  const room = privateCosRoom(client, command, 'pair')
  const trigger = exactEvent(room, await client.fetchRoomEvent(room.roomId, command.eventId), command.eventId)

  if (trigger.getSender() !== command.memberUserId) {return unavailable()}

  const eventId = await sendWithTransaction(client, room.roomId, command.transactionId, () => client.sendEvent(
    room.roomId, EventType.RoomMessage, {msgtype: MsgType.Text, body: command.text,
      'm.relates_to': {'m.in_reply_to': {event_id: command.eventId}}} as never, command.transactionId))

  return typeof eventId === 'string' && EVENT_ID.test(eventId) ? eventId : unavailable()
}

/** The platform-authored first greeting, still confined to the bound private room. */
export async function publishCompanyPrivateCosGreeting(
  client: MatrixClient,
  command: MatrixCompanyPrivateCosGreetingRequest
): Promise<string> {
  if (!TRANSACTION_ID.test(command.transactionId) || command.text.length < 1 || command.text.length > 4_096 ||
      command.mention.userId !== command.memberUserId || command.agentPill.userId!==command.agentUserId||
      command.agentPill.displayName!=='Chief of Staff'||command.agentPill.label!=='@Chief of Staff'||
      command.agentPill.href!==`https://matrix.to/#/${command.agentUserId}`||!command.text.includes(command.agentPill.label)||
      !['company_board_card','company_board'].includes(command.link.kind) || command.link.companyId !== command.companyId ||
      !UUID.test(command.link.boardId) || command.link.title.length < 1 ||
      command.link.kind==='company_board_card'&&(!UUID.test(command.link.cardId)||
        command.link.url!==`https://atumplatform.com/#atum-board/${command.companyId}/${command.link.boardId}/card/${command.link.cardId}`)||
      command.link.kind==='company_board'&&command.link.url!==
        `https://atumplatform.com/#atum-board/${command.companyId}/${command.link.boardId}`||
      !['en','vi'].includes(command.locale)) {return unavailable()}

  const room = privateCosRoom(client, command, 'pair')
  const pill=`<a href="${escapeHtml(command.agentPill.href)}">${escapeHtml(command.agentPill.label)}</a>`
  const body=`${command.text}\n\n${command.link.title}: ${command.link.url}`

  const formattedBody=`${escapeHtml(command.text).replace(escapeHtml(command.agentPill.label),pill)}`+
    `<br><br><a href="${escapeHtml(command.link.url)}">${escapeHtml(command.link.title)}</a>`

  const eventId = await sendWithTransaction(client, room.roomId, command.transactionId, () => client.sendEvent(
    room.roomId, EventType.RoomMessage, {msgtype: MsgType.Text, body,
      format:'org.matrix.custom.html',formatted_body:formattedBody,
      'm.mentions': {user_ids: [command.memberUserId]}} as never, command.transactionId))

  return typeof eventId === 'string' && EVENT_ID.test(eventId) ? eventId : unavailable()
}

/**
 * One exact company event, as the frozen intake seam expects it. `roomBinding`
 * comes from immutable room state; the body and mentions are read from the
 * server's copy, never from a sync projection.
 */
export async function readCompanyAIEvent(
  client: MatrixClient,
  command: MatrixCompanyAIReadEventRequest,
  active: () => boolean = () => true
): Promise<unknown> {
  if (!active() || !UUID.test(command.companyId) || !EVENT_ID.test(command.eventId)) {
    return unavailable()
  }

  const room=client.getRoom(command.roomId)
  const binding=room&&roomBinding(room)

  if(!room||binding?.companyId!==command.companyId){return null}

  let raw:unknown

  try{raw=await client.fetchRoomEvent(room.roomId,command.eventId)}
  catch(error){if(matrixEventMissing(error)){return null;}throw error}

  const event=optionalExactEvent(room,raw,command.eventId)

  if(!event){return null}

  if (!active()) {
    return unavailable()
  }

  const content = event.getContent()
  const sender = event.getSender()

  if (!sender || !USER_ID.test(sender)) {
    return null
  }

  const threadRootEventId = threadRootOf(content)
  const inReplyToEventId = replyToOf(content)
  let root: Record<string, unknown> | null = null

  if (threadRootEventId) {
    let raw:unknown

    try{raw=await client.fetchRoomEvent(room.roomId,threadRootEventId)}
    catch(error){if(matrixEventMissing(error)){return null;}throw error}

    const rootEvent=optionalExactEvent(room,raw,threadRootEventId)

    if(!rootEvent){return null}
    const rootContent = rootEvent.getContent()

    if (threadRootOf(rootContent) !== null) {
      return null
    }

    root = {
      roomId: room.roomId,
      eventId: threadRootEventId,
      eventType: 'm.room.message',
      messageType: 'm.text',
      original: true,
      relation: 'top_level'
    }
  }

  return {
    schemaVersion: 1,
    roomBinding: binding,
    roomId: room.roomId,
    eventId: command.eventId,
    senderUserId: sender,
    senderKind: 'human',
    eventType: 'm.room.message',
    messageType: 'm.text',
    original: true,
    relation: threadRootEventId ? 'thread' : 'top_level',
    threadRootEventId: threadRootEventId ?? command.eventId,
    inReplyToEventId,
    mentionedUserIds: mentionedUserIds(content),
    mentionsRoom: false,
    root
  }
}

function bounded(text: string, limit: number): string {
  const characters = [...text]

  return characters.length <= limit ? text : characters.slice(0, limit).join('')
}

/** The trigger message plus bounded same-thread history, inside the frozen limits. */
export async function readCompanyAIQuestion(
  client: MatrixClient,
  command: { companyId: string; channelId: string; threadRootEventId: string; triggerEventId: string },
  agentUserId: string,
  active: () => boolean = () => true
): Promise<{ text: string; history: Array<{ role: 'user' | 'assistant'; text: string; senderUserId?: string }> }> {
  if (!active() || !UUID.test(command.companyId) || !EVENT_ID.test(command.threadRootEventId) ||
      !EVENT_ID.test(command.triggerEventId) || !USER_ID.test(agentUserId)) {
    return unavailable()
  }

  const room = companyChannelRoom(client, command.companyId, command.channelId)
  const rootId = command.threadRootEventId
  const rootRaw = await client.fetchRoomEvent(room.roomId, rootId)
  const root = exactEvent(room, rootRaw, rootId)

  if (threadRootOf(root.getContent()) !== null) {
    return unavailable()
  }

  const triggerRaw = await client.fetchRoomEvent(room.roomId, command.triggerEventId)
  const trigger = exactEvent(room, triggerRaw, command.triggerEventId)
  const content = trigger.getContent()
  const triggerRoot = threadRootOf(content)

  if (command.triggerEventId !== rootId && triggerRoot !== rootId) {
    return unavailable()
  }

  if (!active()) {
    return unavailable()
  }

  const text = bounded(textContent(trigger) ?? '', QUESTION_LIMIT)
  const history: Array<{ role: 'user' | 'assistant'; text: string; senderUserId?: string }> = []
  let total = 0

  for (const event of orderedThread(room, rootId, command.triggerEventId).reverse()) {
    const body = bounded(textContent(event) ?? '', QUESTION_LIMIT)

    if (total + body.length > HISTORY_CHARACTERS) {
      break
    }

    total += body.length
    const ours = event.getSender() === agentUserId
    history.unshift({ role: ours ? 'assistant' : 'user', text: body,
      ...(!ours ? { senderUserId: event.getSender()! } : {}) })

    if (history.length === HISTORY_LIMIT) {
      break
    }
  }

  return { text, history }
}

function companyThreadContent(rootId: string, replyToId: string, text: string) {
  return {
    msgtype: MsgType.Text,
    body: text,
    'm.relates_to': {
      rel_type: 'm.thread',
      event_id: rootId,
      is_falling_back: true,
      'm.in_reply_to': { event_id: replyToId }
    }
  }
}

/** The frozen `m.thread` answer relation under the platform's transaction ID. */
export async function publishCompanyThread(
  client: MatrixClient,
  command: {
    companyId: string
    roomId: string
    threadRootEventId: string
    triggerEventId: string
    transactionId: string
    text: string
  }
): Promise<string> {
  if (!UUID.test(command.companyId) || !EVENT_ID.test(command.threadRootEventId) ||
      !EVENT_ID.test(command.triggerEventId) || !TRANSACTION_ID.test(command.transactionId) ||
      command.text.length < 1 || command.text.length > 65_536) {
    return unavailable()
  }

  const room = companyRoom(client, command.roomId, command.companyId)

  await requireFlatCompanyTarget(client, room, command.threadRootEventId, command.triggerEventId)

  const eventId = await sendWithTransaction(client, room.roomId, command.transactionId, () =>
    client.sendEvent(
      room.roomId,
      EventType.RoomMessage,
      companyThreadContent(command.threadRootEventId, command.triggerEventId, command.text) as never,
      command.transactionId
    )
  )

  return typeof eventId === 'string' && EVENT_ID.test(eventId) ? eventId : unavailable()
}

const PUBLICATION_SCAN_PAGES = 5
const PUBLICATION_SCAN_LIMIT = 50
/** How far before the task's start a publication could still be stamped (clock skew). */
const PUBLICATION_SKEW_MS = 5 * 60_000

function unsignedTransaction(event: MatrixEvent): string | null {
  const unsigned = event.getUnsigned() as Record<string, unknown> | undefined

  return unsigned && typeof unsigned.transaction_id === 'string' ? unsigned.transaction_id : null
}

/**
 * Recovery-only: the exact event this publication already produced, or `null`
 * when a bounded newest-first thread scan proves it absent. Matrix dedupes a
 * transaction ID only per access token, and the controller rotates the CoS
 * token on every attach, so the sent event itself is the durable identity. An
 * inconclusive scan throws: the caller retries later instead of sending twice.
 */
export async function findCompanyThread(
  client: MatrixClient,
  command: MatrixCompanyAIFindPublishedRequest,
  active: () => boolean = () => true
): Promise<string | null> {
  if (!active() || !UUID.test(command.companyId) || !ROOM_ID.test(command.roomId) ||
      !EVENT_ID.test(command.threadRootEventId) || !EVENT_ID.test(command.triggerEventId) ||
      !TRANSACTION_ID.test(command.transactionId) || command.text.length < 1 || command.text.length > 65_536 ||
      !Number.isSafeInteger(command.sinceMs) || command.sinceMs < 0) {
    return unavailable()
  }

  const room = companyRoom(client, command.roomId, command.companyId)
  const userId = client.getUserId()
  const cutoff = command.sinceMs - PUBLICATION_SKEW_MS
  let covered = false
  let uncertain = false

  const inspect = (event: MatrixEvent): string | undefined => {
    const at = event.getTs()

    if (Number.isSafeInteger(at) && at < cutoff) {
      covered = true
    }

    if (!userId || event.getSender() !== userId) {
      return undefined
    }

    if (event.isDecryptionFailure() || event.getType() === EventType.RoomMessageEncrypted) {
      uncertain ||= !Number.isSafeInteger(at) || at >= cutoff

      return undefined
    }

    const id = event.getId()
    const content = event.getOriginalContent()

    const marked = textContent(event) === command.text &&
      threadRootOf(content) === command.threadRootEventId &&
      replyToOf(content) === command.triggerEventId

    const matches = event.getType() === EventType.RoomMessage && !event.isRedacted() &&
      (event.status === null || event.status === EventStatus.SENT) &&
      typeof id === 'string' && id.startsWith('$') &&
      (marked || unsignedTransaction(event) === command.transactionId)

    return matches ? id : undefined
  }

  // A retry in this process may still hold the event locally; presence is proof.
  for (const event of [...room.getLiveTimeline().getEvents()].reverse()) {
    if (!active()) {
      return unavailable()
    }

    const found = inspect(event)

    if (found) {
      return found
    }
  }

  // A fresh server read proves presence, and reaching the publication's instant
  // proves absence. Relations decrypt transparently.
  let from: string | undefined

  for (let page = 0; page < PUBLICATION_SCAN_PAGES; page++) {
    if (!active()) {
      return unavailable()
    }

    const batch = await client.relations(room.roomId, command.threadRootEventId, 'm.thread',
      EventType.RoomMessage, { from, limit: PUBLICATION_SCAN_LIMIT, dir: Direction.Backward })

    for (const event of batch.events) {
      if (!active()) {
        return unavailable()
      }

      const found = inspect(event)

      if (found) {
        return found
      }
    }

    if (!batch.nextBatch || batch.events.length === 0) {
      covered = true

      break
    }

    from = batch.nextBatch
  }

  if (covered && !uncertain) {
    return null
  }

  throw new Error('matrix_company_ai_lookup_unconfirmed')
}

/** One reminder reply in a channel's source thread, mentioning only mapped recipients. */
export async function publishCompanyThreadMessage(
  client: MatrixClient,
  command: MatrixCompanyAIThreadMessageRequest
): Promise<string> {
  if (!UUID.test(command.companyId) || !EVENT_ID.test(command.threadRootEventId) ||
      !TRANSACTION_ID.test(command.transactionId) || command.text.length < 1 || command.text.length > 65_536 ||
      !Array.isArray(command.mentions) || command.mentions.length < 1 || command.mentions.length > 100 ||
      command.mentions.some(userId => !USER_ID.test(userId)) || new Set(command.mentions).size !== command.mentions.length) {
    return unavailable()
  }

  const room = companyChannelRoom(client, command.companyId, command.channelId)

  await requireFlatCompanyTarget(client, room, command.threadRootEventId, command.threadRootEventId)

  const content = {
    ...companyThreadContent(command.threadRootEventId, command.threadRootEventId, command.text),
    'm.mentions': { user_ids: command.mentions }
  }

  const eventId = await sendWithTransaction(client, room.roomId, command.transactionId, () =>
    client.sendEvent(room.roomId, EventType.RoomMessage, content as never, command.transactionId)
  )

  return typeof eventId === 'string' && EVENT_ID.test(eventId) ? eventId : unavailable()
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/** One top-level creation welcome, under the platform's stable Matrix transaction ID. */
export async function publishCompanyOnboardingWelcome(
  client: MatrixClient,
  command: MatrixCompanyAIOnboardingWelcomeRequest
): Promise<string> {
  const link = BOARD_LINK.exec(command.boardLink)

  if (!UUID.test(command.companyId) || !WELCOME_TRANSACTION_ID.test(command.transactionId) ||
      [...command.body].length < 1 || [...command.body].length > 240 || link?.[1] !== command.companyId) {
    return unavailable()
  }

  const room = companyRoom(client, command.roomId, command.companyId)

  const content = {msgtype: MsgType.Text, body: command.body, format: 'org.matrix.custom.html',
    formatted_body: `<a href="${command.boardLink}">${escapeHtml(command.body)}</a>`}

  const eventId = await sendWithTransaction(client, room.roomId, command.transactionId, () =>
    client.sendEvent(room.roomId, EventType.RoomMessage, content as never, command.transactionId)
  )

  return typeof eventId === 'string' && EVENT_ID.test(eventId) ? eventId : unavailable()
}

/** The room's own server copy of one flat-thread target; nested threads never pass. */
async function requireFlatCompanyTarget(
  client: MatrixClient,
  room: Room,
  rootId: string,
  replyToId: string
): Promise<void> {
  if (!EVENT_ID.test(rootId) || !EVENT_ID.test(replyToId)) {
    return unavailable()
  }

  const root = exactEvent(room, await client.fetchRoomEvent(room.roomId, rootId), rootId)

  if (threadRootOf(root.getContent()) !== null) {
    return unavailable()
  }

  if (replyToId === rootId) {
    return
  }

  const reply = exactEvent(room, await client.fetchRoomEvent(room.roomId, replyToId), replyToId)

  if (threadRootOf(reply.getContent()) !== rootId) {
    return unavailable()
  }
}

/**
 * Read one exact cited company message. The caller selects the room through the
 * existing company message selection command; this only proves the event is real,
 * belongs to the bound channel and is not inside a nested thread.
 */
export async function openCompanyCitation(
  client: MatrixClient,
  command: MatrixCompanyCitationOpenRequest,
  active: () => boolean = () => true
): Promise<MatrixCompanyCitationOpenValue> {
  if (!active() || !UUID.test(command.companyId) || !UUID.test(command.channelId) || !EVENT_ID.test(command.eventId)) {
    return unavailable()
  }

  const room = companyRoom(client, command.roomId, command.companyId)
  const binding = roomBinding(room)

  if (binding?.channelId !== command.channelId) {
    return unavailable()
  }

  const event = exactEvent(room, await client.fetchRoomEvent(room.roomId, command.eventId), command.eventId)

  if (!active()) {
    return unavailable()
  }

  const threadRootEventId = threadRootOf(event.getContent())

  if (threadRootEventId) {
    const root = exactEvent(room, await client.fetchRoomEvent(room.roomId, threadRootEventId), threadRootEventId)

    if (threadRootOf(root.getContent()) !== null) {
      return unavailable()
    }
  }

  return { threadRootEventId }
}

/** Fresh native membership, resolved only through this joined room's immutable binding. */
export async function readCompanyAIJoinedMembers(client: MatrixClient,
  input: {companyId: string; channelId: string}, active: () => boolean) {
  if (!active() || !UUID.test(input.companyId)) {return unavailable()}
  const room = companyChannelRoom(client, input.companyId, input.channelId)
  // Own deadline: the engine command's 30 s timeout must not consume the turn budget.
  let timer: ReturnType<typeof setTimeout> | undefined

  const result = await Promise.race([
    client.members(room.roomId, 'join'),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('matrix_roster_timeout')), 5_000) })
  ]).finally(() => clearTimeout(timer))

  if (!active() || companyChannelRoom(client, input.companyId, input.channelId) !== room) {return unavailable()}

  return result.chunk.filter(member => member.room_id === room.roomId && member.type === EventType.RoomMember &&
    member.content.membership === 'join' && typeof member.state_key === 'string')
    .map(member => ({userId: member.state_key!, displayName: typeof member.content.displayname === 'string'
      ? member.content.displayname.slice(0, 1024) : null}))
}

/** Controller-authorized company presentation, using native send/edit/redact operations. */
export async function publishCompanyPresentation(client:MatrixClient,
  command:Extract<MatrixCompanyAISdkCommand,{kind:'companyPresentation'}>):Promise<string> {
  const {identity,operation,triggerEventId}=command

  if (!/^atum-company-presentation-[a-f0-9]{64}$/u.test(operation.transactionId) ||
      !EVENT_ID.test(identity.threadRootEventId) || !EVENT_ID.test(triggerEventId)) {return unavailable()}

  if (identity.audience.kind==='private' && (!command.privateScope ||
      command.privateScope.companyId!==identity.companyId || command.privateScope.memberPrincipal!==identity.audience.memberPrincipal ||
      command.privateScope.membershipIncarnation!==identity.audience.membershipIncarnation)) {return unavailable()}

  const room=identity.audience.kind==='channel' ? companyChannelRoom(client,identity.companyId,identity.audience.channelId) :
    command.privateScope ? privateCosRoom(client,command.privateScope,'pair') : unavailable()

  if (room.roomId!==identity.roomId) {return unavailable()}
  await requireFlatCompanyTarget(client,room,identity.threadRootEventId,triggerEventId)

  if (operation.targetEventId) {
    const raw=await client.fetchRoomEvent(room.roomId,operation.targetEventId)

    if (!record(raw)) {return unavailable()}
    const original=new MatrixEvent(raw as never)

    if (original.getId()!==operation.targetEventId || original.getRoomId()!==room.roomId ||
        original.getType()!==EventType.RoomMessage || original.isDecryptionFailure()) {return unavailable()}

    if (operation.operation==='redact' && original.getSender()===client.getUserId() && original.isRedacted()) {return operation.targetEventId}
    const content=original.getContent()
    const marker=content['io.atum.progress']??content['io.atum.company']

    if (operation.operation==='redact' && (!content['io.atum.progress'] ||
        content['m.relates_to']?.rel_type!=='m.thread' ||
        content['m.relates_to']?.event_id!==identity.threadRootEventId ||
        content['m.relates_to']?.['m.in_reply_to']?.event_id!==triggerEventId)) {return unavailable()}

    if (original.getSender()!==client.getUserId() || !marker || marker.profile!=='atum.agent-turns/1.6' ||
        Object.entries(identity).some(([key,value])=>canonicalJson(marker[key])!==canonicalJson(value))) {return unavailable()}
  }

  if (command.readOnly && !command.reconcile) {return unavailable()}

  if (operation.operation==='redact') {
    if (command.readOnly) {throw Error('matrix_company_presentation_lookup_unconfirmed')}

    if (!operation.targetEventId) {return unavailable()}
    await client.redactEvent(room.roomId,operation.targetEventId,operation.transactionId)

    return operation.targetEventId
  }

  // Adopt final-publication read-back before resending across access-token rotation.
  // A bounded, incomplete or undecryptable scan cannot prove absence.
  if (command.reconcile) {
    let from:string|undefined
    let uncertain=false
    let covered=false

    for (let page=0;page<PUBLICATION_SCAN_PAGES;page++) {
      const batch=await client.relations(room.roomId,operation.targetEventId??identity.threadRootEventId,
        operation.operation==='edit'?'m.replace':'m.thread',EventType.RoomMessage,
        {from,limit:PUBLICATION_SCAN_LIMIT,dir:Direction.Backward})

      for (const event of batch.events) {
        if (event.getSender()!==client.getUserId()) {continue}

        if (event.isDecryptionFailure() || event.getType()===EventType.RoomMessageEncrypted) {uncertain=true;

continue}

        if (canonicalJson(event.getOriginalContent())===canonicalJson(operation.content) ||
            unsignedTransaction(event)===operation.transactionId) {
          const id=event.getId()

          if (id&&EVENT_ID.test(id)) {return id}
        }
      }

      if (!batch.nextBatch) {covered=true;

break}

      from=batch.nextBatch
    }

    if (!covered || uncertain) {throw Error('matrix_company_presentation_lookup_unconfirmed')}
  }

  if (command.readOnly) {throw Error('matrix_company_presentation_lookup_absent')}

  const eventId=await sendWithTransaction(client,room.roomId,operation.transactionId,()=>client.sendEvent(
    room.roomId,EventType.RoomMessage,operation.content as never,operation.transactionId))

  return typeof eventId==='string'&&EVENT_ID.test(eventId)?eventId:unavailable()
}
