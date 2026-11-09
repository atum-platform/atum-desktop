import { EventType, type MatrixClient, Preset } from 'matrix-js-sdk'

import {
  companyRoomBinding,
  MATRIX_COMPANY_PROJECT_BINDING,
  MATRIX_COMPANY_PROJECT_TYPE,
  MATRIX_COMPANY_ROOM_VERSION,
  type MatrixCompanyRoomBinding,
  type MatrixCompanyRoomTarget,
  validCompanyRoomBinding
} from '../../shared/matrix-company-room'

import { findBoundRoom } from './joined-room-discovery'

const denied = () => { throw new Error('matrix_company_room_required') }
const userId = (value: string) => /^@[^\s:]{1,255}:[^\s]{1,255}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

const sameBinding = (left: MatrixCompanyRoomBinding, right: MatrixCompanyRoomBinding) =>
  Object.keys(left).every(key => Reflect.get(left, key) === Reflect.get(right, key))

function target(input: MatrixCompanyRoomTarget) {
  if (!validCompanyRoomBinding(input) || !/^![^\s:]{1,255}:[^\s]{1,255}$/.test(input.roomId) ||
      !Array.isArray(input.memberUserIds) || input.memberUserIds.length > 100 ||
      input.memberUserIds.some(id => !userId(id) || [input.managerUserId, input.serviceUserId].includes(id)) ||
      new Set(input.memberUserIds).size !== input.memberUserIds.length) {denied()}
}

/** Full current server state. A joined room or a client-authored binding is insufficient. */
async function state(client: MatrixClient, input: MatrixCompanyRoomBinding & { roomId: string }, active: () => boolean) {
  if (!active() || !validCompanyRoomBinding(input)) {denied()}
  const events = await client.roomState(input.roomId)

  if (!active()) {denied()}

  const read = (type: string) => {
    const found = events.filter(event => event.type === type && event.state_key === '')

    if (found.length !== 1) {denied()}

    return found[0]!
  }

  // A room made before 0.20: Megolm, history from joining (kept, never downgraded). A 0.20 room:
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  const encrypted = events.some(event => event.type === EventType.RoomEncryption && event.state_key === '')
  const history = read(EventType.RoomHistoryVisibility).content.history_visibility

  const creation = read(EventType.RoomCreate)
  const binding = companyRoomBinding(creation.content, creation.sender)
  const power = read(EventType.RoomPowerLevels).content

  // Pin v11: v12 has implicit creator powers/additional creators which require
  // a different policy. Never silently admit those semantics through this gate.
  if (!binding || !sameBinding(binding, input) ||
      creation.content.predecessor !== undefined || creation.content.additional_creators !== undefined ||
      (encrypted
        ? read(EventType.RoomEncryption).content.algorithm !== 'm.megolm.v1.aes-sha2' || history !== 'joined'
        : history !== 'shared') ||
      read(EventType.RoomJoinRules).content.join_rule !== 'invite' ||
      read(EventType.RoomGuestAccess).content.guest_access !== 'forbidden' ||
      !object(power.users) || power.users[input.managerUserId] !== 100 ||
      Object.entries(power.users).some(([id, level]) => !userId(id) || level !== (id === input.managerUserId ? 100 : 0)) ||
      power.users_default !== 0 || power.events_default !== 0 || power.state_default !== 100 ||
      ['invite', 'kick', 'ban', 'redact'].some(key => power[key] !== 100) ||
      !object(power.events) || Object.values(power.events).some(level => level !== 100) ||
      !object(power.notifications) || power.notifications.room !== 100) {denied()}

  const members = events.filter(event => event.type === EventType.RoomMember)

  // Left/banned state accumulates for the room's lifetime. Only the current
  // encryption audience counts against the live participant bound.
  if (members.filter(event => ['join', 'invite', 'knock'].includes(String(event.content.membership))).length > 1000 ||
      new Set(members.map(event => event.state_key)).size !== members.length ||
      members.some(event => !userId(event.state_key) || !['join', 'invite', 'leave', 'ban', 'knock'].includes(String(event.content.membership))) ||
      !members.some(event => event.state_key === input.managerUserId && event.content.membership === 'join')) {denied()}

  return members
}

export async function createCompanyProjectRoom(
  client: MatrixClient,
  input: MatrixCompanyRoomBinding & { name: string },
  active: () => boolean = () => true
): Promise<string> {
  if (!active() || !validCompanyRoomBinding(input) || client.getUserId() !== input.managerUserId ||
      typeof input.name !== 'string' || input.name.trim() !== input.name || input.name.length < 1 ||
      input.name.length > 120 || Array.from(input.name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {denied()}

  // The consumer must durably consume a create attempt before this call. Matrix
  // createRoom has no transaction ID: an unknown reply is recovered by find,
  // never by blindly retrying this POST.
  const result = await client.createRoom({
    name: input.name,
    preset: Preset.PrivateChat,
    room_version: MATRIX_COMPANY_ROOM_VERSION,
    creation_content: {
      type: MATRIX_COMPANY_PROJECT_TYPE,
      [MATRIX_COMPANY_PROJECT_BINDING]: {
        companyId: input.companyId, projectId: input.projectId,
        servicePrincipal: input.servicePrincipal, serviceUserId: input.serviceUserId
      }
    },
    power_level_content_override: {
      users: { [input.managerUserId]: 100 }, users_default: 0,
      events: {}, events_default: 0, state_default: 100,
      invite: 100, kick: 100, ban: 100, redact: 100, notifications: { room: 100 }
    },
    // Preserve user-visible identity, state and recovery behavior across connection changes.
    initial_state: [
      { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'shared' } },
      { type: EventType.RoomJoinRules, state_key: '', content: { join_rule: 'invite' } },
      { type: EventType.RoomGuestAccess, state_key: '', content: { guest_access: 'forbidden' } }
    ]
  })

  if (!active() || !/^![^\s:]{1,255}:[^\s]{1,255}$/.test(result.room_id)) {denied()}

  return result.room_id
}

/** An interrupted creation may have succeeded before its reply was lost. */
export async function findCompanyProjectRoom(
  client: MatrixClient,
  input: MatrixCompanyRoomBinding,
  active: () => boolean = () => true
): Promise<string | null> {
  if (!active() || !validCompanyRoomBinding(input) || client.getUserId() !== input.managerUserId) {denied()}

  const found = await findBoundRoom(client, active, {
    roomType: MATRIX_COMPANY_PROJECT_TYPE,
    binding: companyRoomBinding,
    matches: binding => sameBinding(binding, input),
    conflict: () => { throw new Error('matrix_company_room_conflict') },
    denied
  })

  // Drift is a failed recovery, not permission to create a replacement room.
  if (found !== null) {await state(client, { ...input, roomId: found }, active)}

  return found
}

export async function readCompanyProjectRoom(
  client: MatrixClient,
  input: MatrixCompanyRoomTarget & { allowServiceInvite?: boolean },
  active: () => boolean = () => true
): Promise<void> {
  target(input)
  const allowed = new Set([input.managerUserId, input.serviceUserId, ...input.memberUserIds])

  if (!allowed.has(client.getUserId() ?? '')) {denied()}
  const members = await state(client, input, active)

  if (members.some(event => ['join', 'invite', 'knock'].includes(String(event.content.membership)) && !allowed.has(event.state_key)) ||
      input.memberUserIds.some(id => !members.some(event => event.state_key === id && ['join', 'invite'].includes(String(event.content.membership)))) ||
      !members.some(event => event.state_key === client.getUserId() &&
        (event.content.membership === 'join' || (input.allowServiceInvite && event.state_key === input.serviceUserId && event.content.membership === 'invite'))) ||
      !members.some(event => event.state_key === input.serviceUserId &&
        (event.content.membership === 'join' || (input.allowServiceInvite && event.content.membership === 'invite')))) {denied()}
}

/** Trusted manager only; domain authority is checked before and after by its consumer. */
export async function reconcileCompanyProjectRoom(
  client: MatrixClient, input: MatrixCompanyRoomTarget, active: () => boolean = () => true
): Promise<void> {
  target(input)

  if (client.getUserId() !== input.managerUserId) {denied()}
  const members = await state(client, input, active)
  const allowed = new Set([input.managerUserId, input.serviceUserId, ...input.memberUserIds])

  for (const member of members) {
    if (!active()) {denied()}

    if (!allowed.has(member.state_key) && ['join', 'invite', 'knock'].includes(String(member.content.membership))) {
      await client.ban(input.roomId, member.state_key)
    }
  }

  for (const id of [...allowed].sort()) {
    if (!active()) {denied()}
    const member = members.find(event => event.state_key === id)

    if (member?.content.membership === 'join' || member?.content.membership === 'invite') {continue}

    if (member?.content.membership === 'ban') {
      await client.unban(input.roomId, id)

      if (!active()) {denied()}
    }

    await client.invite(input.roomId, id)
  }

  await readCompanyProjectRoom(client, { ...input, allowServiceInvite: true }, active)
}

/** Only this explicit service device joins; manager custody never runs a model. */
export async function joinCompanyProjectRoom(
  client: MatrixClient, input: MatrixCompanyRoomTarget, active: () => boolean = () => true
): Promise<void> {
  target(input)

  if (!active() || client.getUserId() !== input.serviceUserId) {denied()}
  const room = client.getRoom(input.roomId)

  if (room?.getMyMembership() === 'join') {
    await readCompanyProjectRoom(client, input, active)

    return
  }

  // An invite only supplies stripped state; joined history does not permit a
  // full roomState request yet. Admit the exact manager invitation, then check
  // full state after joining. This is never permission to run or publish.
  const creation = room?.currentState.getStateEvents(EventType.RoomCreate, '')
  const encryption = room?.currentState.getStateEvents(EventType.RoomEncryption, '')
  const invitation = room?.currentState.getStateEvents(EventType.RoomMember, input.serviceUserId)
  const binding = creation && companyRoomBinding(creation.getContent(), creation.getSender())

  // A plain invitation (0.20) is admitted; one with encryption still needs Megolm. Full state is
  // checked again after joining.
  if (!room || room.getMyMembership() !== 'invite' || !binding || !sameBinding(binding, input) ||
      invitation?.getContent().membership !== 'invite' || invitation.getSender() !== input.managerUserId ||
      (encryption && encryption.getContent().algorithm !== 'm.megolm.v1.aes-sha2') || !active()) {denied()}

  await client.joinRoom(input.roomId)
  await readCompanyProjectRoom(client, input, active)
}

/** Rotate the CoS publisher's session after a current roster reconciliation. */
export async function rotateCompanyProjectSession(
  client: MatrixClient, input: MatrixCompanyRoomTarget, active: () => boolean = () => true
): Promise<void> {
  if (client.getUserId() !== input.serviceUserId) {denied()}
  await readCompanyProjectRoom(client, input, active)
  // Server state and the SDK's encryption recipients can differ until sync
  // catches up. Discarding a session alone would then rekey to the old audience.
  const room = client.getRoom(input.roomId)

  if (!room || room.getMyMembership() !== 'join') {denied()}

  // A plain room (0.20) has no session to rotate: the roster check above is the whole job.
  if (!room!.hasEncryptionStateEvent()) {return}
  const recipients = await room!.getEncryptionTargetMembers()
  const allowed = new Set([input.managerUserId, input.serviceUserId, ...input.memberUserIds])

  if (!active() || recipients.some(member => !allowed.has(member.userId)) ||
      !recipients.some(member => member.userId === input.serviceUserId)) {denied()}

  const crypto = client.getCrypto()

  if (!crypto || !active()) {denied()}
  await crypto!.forceDiscardSession(input.roomId)
  await readCompanyProjectRoom(client, input, active)
}
