import {EventType, type MatrixClient, Preset} from 'matrix-js-sdk'

import type {MatrixCompanyPrivateCosRoomPlan} from '../../shared/matrix-company-private-cos-room'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const USER = /^@[!-9;-~]{1,255}:[!-~]{1,255}$/u
const ROOM = /^![!-9;-~]{1,255}:[!-~]{1,255}$/u

const denied = (): never => {throw Error('matrix_company_private_cos_room_required')}

const PROTECTED = ['m.room.join_rules','m.room.power_levels','m.room.history_visibility','m.room.encryption',
  'm.room.guest_access','m.room.name','m.room.avatar','m.room.topic','io.atum.company_private_cos',
  'm.room.server_acl','m.room.tombstone'] as const

function validPower(plan: MatrixCompanyPrivateCosRoomPlan): boolean {
  const power = plan.powerLevels

  return power?.users?.[plan.manager.userId] === 100 && power.users[plan.participants[0].userId] === 0 &&
    power.users[plan.participants[1].userId] === 0 && Object.keys(power.users).length === 3 &&
    power.users_default === 0 && power.events_default === 0 && power.state_default === 100 &&
    power.invite === 100 && power.kick === 100 && power.ban === 100 && power.redact === 100 &&
    PROTECTED.every(type => power.events[type] === 100) && Object.keys(power.events).length === PROTECTED.length
}

export function validCompanyPrivateCosRoomPlan(plan: MatrixCompanyPrivateCosRoomPlan): boolean {
  const member = plan?.participants?.[0], agent = plan?.participants?.[1]

  return plan?.schemaVersion === 1 && UUID.test(plan.attemptId) && UUID.test(plan.companyId) &&
    UUID.test(plan.membershipIncarnation) && UUID.test(plan.executorId) && UUID.test(plan.manager?.executorId) &&
    plan.state === 'create' && plan.roomId === null && plan.roomName === 'Chief of Staff' &&
    USER.test(plan.manager?.userId) && Number.isSafeInteger(plan.manager?.assignmentEpoch) && plan.manager.assignmentEpoch >= 1 &&
    plan.participants.length === 2 && member.role === 'member' && agent.role === 'agent' && USER.test(member.userId) &&
    USER.test(agent.userId) && member.userId !== agent.userId && ![member.userId,agent.userId].includes(plan.manager.userId) &&
    plan.roomType === 'io.atum.assistant' && plan.roomVersion === '11' && plan.classification === 'company_private_cos' &&
    plan.preset === 'private_chat' && plan.direct === true && plan.encrypted === false &&
    plan.historyVisibility === 'joined' && plan.joinRule === 'invite' && plan.guestAccess === 'forbidden' &&
    plan.managerPower === 100 && plan.participantPower === 0 && plan.invitePower === 100 && plan.managerLeaves === true &&
    plan.marker?.type === 'io.atum.company_private_cos' && plan.marker.stateKey === '' && plan.marker.content?.v === 1 &&
    plan.marker.content.classification === 'company_private_cos' && plan.marker.content.companyId === plan.companyId &&
    plan.marker.content.membershipIncarnation === plan.membershipIncarnation &&
    plan.marker.content.executorId === plan.executorId && plan.marker.content.attemptId===plan.attemptId&&validPower(plan)
}

/** Recover a create-response crash by the exact immutable attempt marker before creating again. */
export async function findCompanyPrivateCosRoom(client:MatrixClient,plan:MatrixCompanyPrivateCosRoomPlan,
  active:()=>boolean=()=>true):Promise<string|null>{
  if(!active()||!validCompanyPrivateCosRoomPlan(plan)||client.getUserId()!==plan.manager.userId){denied()}

  for(const room of client.getRooms()){
    if(room.roomId&&!ROOM.test(room.roomId)||room.getType()!==plan.roomType){continue}
    // A room the manager has left is dead (the 11-07 stranded room carries the same marker): never rebind to it.
    if(room.getMember(plan.manager.userId)?.membership!=='join'){continue}
    const creation=room.currentState.getStateEvents(EventType.RoomCreate,'')

    if(!creation||Array.isArray(creation)||creation.getSender()!==plan.manager.userId){continue}
    const marker=room.currentState.getStateEvents(plan.marker.type,plan.marker.stateKey)
    const content=marker&&!Array.isArray(marker)?marker.getContent():null

    if(content&&typeof content==='object'&&!Array.isArray(content)&&
      Object.keys(content).sort().join(',')===Object.keys(plan.marker.content).sort().join(',')&&
      Object.entries(plan.marker.content).every(([key,value])=>content[key]===value)){
      if(!active()){denied()}

      return room.roomId
    }
  }

  return null
}

/** Keep a local resident until the bot joins; leaving an empty room discards Synapse current state. */
export async function createCompanyPrivateCosRoom(client: MatrixClient, plan: MatrixCompanyPrivateCosRoomPlan,
  active: () => boolean = () => true): Promise<string> {
  if (!active() || !validCompanyPrivateCosRoomPlan(plan) || client.getUserId() !== plan.manager.userId) {denied()}

  const created = await client.createRoom({preset: Preset.PrivateChat, room_version: plan.roomVersion,
    name: plan.roomName, is_direct: true, invite: plan.participants.map(participant => participant.userId),
    creation_content: {type: plan.roomType},
    power_level_content_override: plan.powerLevels,
    initial_state: [
      {type: EventType.RoomHistoryVisibility, state_key: '', content: {history_visibility: plan.historyVisibility}},
      {type: EventType.RoomJoinRules, state_key: '', content: {join_rule: plan.joinRule}},
      {type: EventType.RoomGuestAccess, state_key: '', content: {guest_access: plan.guestAccess}},
      {type: plan.marker.type, state_key: plan.marker.stateKey, content: plan.marker.content}
    ]})

  if (!active() || !ROOM.test(created.room_id)) {denied()}

  return created.room_id
}

/** Complete bootstrap only for the exact bound attempt after its bot is resident. */
export async function finishCompanyPrivateCosRoom(client: MatrixClient, plan: MatrixCompanyPrivateCosRoomPlan,
  roomId: string, active: () => boolean = () => true): Promise<boolean> {
  if (!active() || !ROOM.test(roomId) || (plan.roomId !== null && plan.roomId !== roomId) || !validCompanyPrivateCosRoomPlan({...plan,state:'create',roomId:null}) ||
      client.getUserId() !== plan.manager.userId) {denied()}

  const room = client.getRoom(roomId)

  if (!room) {return false}

  const creation = room.currentState.getStateEvents(EventType.RoomCreate, '')
  const marker = room.currentState.getStateEvents(plan.marker.type, plan.marker.stateKey)
  const content = marker?.getContent()

  if (room.roomId !== roomId || room.getType() !== plan.roomType || creation?.getSender() !== plan.manager.userId ||
      !content || Object.keys(content).sort().join(',') !== Object.keys(plan.marker.content).sort().join(',') ||
      !Object.entries(plan.marker.content).every(([key,value]) => content[key] === value)) {denied()}

  if (room.getMember(plan.participants[1].userId)?.membership !== 'join') {return false}

  if (room.getMember(plan.manager.userId)?.membership === 'join') {await client.leave(roomId)}

  if (!active()) {denied()}

  return true
}
