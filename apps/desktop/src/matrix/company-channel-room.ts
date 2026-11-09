import { EventType, type MatrixClient, Preset } from 'matrix-js-sdk'

import {
  companyChannelRoomBinding,
  companyRoomTargetBinding,
  MATRIX_COMPANY_CHANNEL_BINDING,
  MATRIX_COMPANY_CHANNEL_MAX_BANS,
  MATRIX_COMPANY_CHANNEL_MAX_MEMBERS,
  MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
  MATRIX_COMPANY_CHANNEL_TOPIC_MAX,
  MATRIX_COMPANY_CHANNEL_TYPE,
  MATRIX_COMPANY_CONVERSATION_BINDING,
  MATRIX_COMPANY_CONVERSATION_TYPE,
  type MatrixCompanyChannelRoomBinding,
  type MatrixCompanyChannelRoomTarget,
  type MatrixCompanyChannelRoomWitness,
  type MatrixCompanyRoomTargetBinding,
  type MatrixCompanyRoomTargetInput,
  validCompanyChannelRoomBinding,
  validCompanyRoomTargetBinding
} from '../../shared/matrix-company-channel-room'

import { findBoundRoom } from './joined-room-discovery'

const denied = (): never => { throw new Error('matrix_company_channel_room_required') }
const userId = (value: string) => /^@[!-9;-~]{1,255}:[!-~]{1,255}$/.test(value)
const roomId = (value: string) => /^![!-9;-~]{1,255}:[!-~]{1,255}$/.test(value)
const avatarUri = (value: string) => /^mxc:\/\/[A-Za-z0-9._-]{1,255}\/[A-Za-z0-9_-]{1,255}$/u.test(value)

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** Room metadata stays manager-owned; shared pins are the one state event ordinary joined
 * members may write. Older rooms without the explicit exception remain readable so a manager
 * reconciliation can add it in place. */
const validPowerEvents = (value: unknown): value is Record<string, unknown> =>
  object(value) && Object.entries(value).every(([type, level]) =>
    level === (type === EventType.RoomPinnedEvents ? 0 : 100))

const hasControl = (value: string) => [...value].some(character => {
  const code = character.codePointAt(0)!

  return code < 32 || code === 127
})

const sameBinding = (left: MatrixCompanyChannelRoomBinding, right: MatrixCompanyChannelRoomBinding) =>
  left.companyId === right.companyId && left.channelId === right.channelId && left.managerUserId === right.managerUserId

async function sha256(value: unknown): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))

  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const validName = (value: unknown) => typeof value === 'string' && value.trim() === value &&
  [...value].length >= 1 && [...value].length <= 80 && !hasControl(value)

// A topic may span lines; every other control character is refused.
const validTopic = (value: unknown) => typeof value === 'string' &&
  [...value].length <= MATRIX_COMPANY_CHANNEL_TOPIC_MAX &&
  ![...value].some(character => {
    const code = character.codePointAt(0)!

    return (code < 32 && code !== 10) || code === 127
  })

function target(input: MatrixCompanyChannelRoomTarget): void {
  if (!validCompanyChannelRoomBinding(input) || !roomId(input.roomId) ||
      !Array.isArray(input.memberUserIds) || input.memberUserIds.length > MATRIX_COMPANY_CHANNEL_MAX_MEMBERS ||
      !Array.isArray(input.bannedUserIds) || input.bannedUserIds.length > MATRIX_COMPANY_CHANNEL_MAX_BANS ||
      !['open', 'archived_read_only'].includes(input.posting) ||
      input.displayName !== undefined && !validName(input.displayName) ||
      input.topic !== undefined && !validTopic(input.topic) ||
      input.avatarUri !== undefined && input.avatarUri !== null && !avatarUri(input.avatarUri) ||
      input.roomMentionUserIds !== undefined && (!Array.isArray(input.roomMentionUserIds) ||
        input.roomMentionUserIds.length > 100 || new Set(input.roomMentionUserIds).size !== input.roomMentionUserIds.length ||
        input.roomMentionUserIds.some((id, index) => !userId(id) || !input.memberUserIds.includes(id) ||
          index > 0 && id <= input.roomMentionUserIds![index - 1]!)) ||
      [...input.memberUserIds, ...input.bannedUserIds].some(id => !userId(id) || id === input.managerUserId) ||
      new Set(input.memberUserIds).size !== input.memberUserIds.length ||
      new Set(input.bannedUserIds).size !== input.bannedUserIds.length ||
      input.memberUserIds.some(id => input.bannedUserIds.includes(id))) {
    denied()
  }
}

function roomMentionPowerMatches(
  power: Record<string, unknown>,
  managerUserId: string,
  roomMentionUserIds: readonly string[]
): boolean {
  if (!object(power.users) || !object(power.notifications) || power.notifications.room !== 50) {
    return false
  }

  const expected = new Set(roomMentionUserIds)
  const entries = Object.entries(power.users)

  return power.users[managerUserId] === 100 &&
    entries.length === expected.size + 1 &&
    entries.every(([id, level]) => id === managerUserId ? level === 100 : expected.has(id) && level === 50)
}

async function state(
  client: MatrixClient,
  input: MatrixCompanyChannelRoomBinding & { roomId: string },
  active: () => boolean,
  posting?: MatrixCompanyChannelRoomTarget['posting']
) {
  if (!active() || !validCompanyChannelRoomBinding(input) || !roomId(input.roomId)) {denied()}
  const events = await client.roomState(input.roomId)

  if (!active()) {denied()}

  const read = (type: string) => {
    const found = events.filter(event => event.type === type && event.state_key === '')

    if (found.length !== 1) {denied()}

    return found[0]!
  }

  if (events.some(event => event.type === EventType.RoomEncryption && event.state_key === '')) {denied()}
  const creation = read(EventType.RoomCreate)
  const binding = companyChannelRoomBinding(creation.content, creation.sender)
  const history = read(EventType.RoomHistoryVisibility).content.history_visibility
  const joinRule = read(EventType.RoomJoinRules).content.join_rule
  const guest = read(EventType.RoomGuestAccess).content.guest_access
  const power = read(EventType.RoomPowerLevels).content
  const expectedEventsDefault = posting === 'archived_read_only' ? 100 : 0

  if (!binding || !sameBinding(binding, input) || creation.content.predecessor !== undefined ||
      creation.content.additional_creators !== undefined || history !== 'shared' || joinRule !== 'invite' ||
      guest !== 'forbidden' || !object(power.users) || power.users[input.managerUserId] !== 100 ||
      Object.entries(power.users).some(([id, level]) =>
        !userId(id) || (id === input.managerUserId ? level !== 100 : ![0, 50].includes(Number(level)))) ||
      power.users_default !== 0 || ![0, 100].includes(Number(power.events_default)) ||
      posting !== undefined && power.events_default !== expectedEventsDefault || power.state_default !== 100 ||
      ['invite', 'kick', 'ban', 'redact'].some(key => power[key] !== 100) ||
      !validPowerEvents(power.events) ||
      !object(power.notifications) || ![50, 100].includes(Number(power.notifications.room))) {
    denied()
  }

  const members = events.filter(event => event.type === EventType.RoomMember)

  if (members.filter(event => ['join', 'invite', 'knock'].includes(String(event.content.membership))).length > 1000 ||
      new Set(members.map(event => event.state_key)).size !== members.length ||
      members.some(event => !userId(event.state_key) ||
        !['join', 'invite', 'leave', 'ban', 'knock'].includes(String(event.content.membership))) ||
      !members.some(event => event.state_key === input.managerUserId && event.content.membership === 'join')) {
    denied()
  }

  const roomDigest = await sha256([
    MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
    MATRIX_COMPANY_CHANNEL_TYPE,
    input.companyId,
    input.channelId,
    input.managerUserId
  ])

  const policyWitness = await sha256([
    MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
    MATRIX_COMPANY_CHANNEL_TYPE,
    input.companyId,
    input.channelId,
    input.managerUserId,
    history,
    joinRule,
    guest,
    100,
    0,
    Number(power.events_default)
  ])

  // Name and topic are mutable room metadata, not part of the immutable create binding or the policy witness.
  const named = events.find(event => event.type === EventType.RoomName && event.state_key === '')
  const topical = events.find(event => event.type === EventType.RoomTopic && event.state_key === '')
  const avatars = events.filter(event => event.type === EventType.RoomAvatar && event.state_key === '')

  if (avatars.length > 1) {denied()}
  const name = typeof named?.content.name === 'string' ? named.content.name : ''
  const topic = typeof topical?.content.topic === 'string' ? topical.content.topic : ''
  const avatar = typeof avatars[0]?.content.url === 'string' ? avatars[0].content.url : null

  return { members, power, name, topic, avatarUri: avatar, witness: { roomId: input.roomId, roomDigest, policyWitness } }
}

export async function createCompanyChannelRoom(
  client: MatrixClient,
  input: MatrixCompanyChannelRoomBinding & { name: string },
  active: () => boolean = () => true
): Promise<string> {
  if (!active() || !validCompanyChannelRoomBinding(input) || client.getUserId() !== input.managerUserId ||
      typeof input.name !== 'string' || input.name.trim() !== input.name || [...input.name].length < 1 ||
      [...input.name].length > 80 || hasControl(input.name)) {
    denied()
  }

  const result = await client.createRoom({
    name: input.name,
    preset: Preset.PrivateChat,
    room_version: MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
    creation_content: {
      type: MATRIX_COMPANY_CHANNEL_TYPE,
      [MATRIX_COMPANY_CHANNEL_BINDING]: { companyId: input.companyId, channelId: input.channelId }
    },
    power_level_content_override: {
      users: { [input.managerUserId]: 100 }, users_default: 0,
      events: { [EventType.RoomPinnedEvents]: 0 }, events_default: 0, state_default: 100,
      invite: 100, kick: 100, ban: 100, redact: 100, notifications: { room: 100 }
    },
    initial_state: [
      { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'shared' } },
      { type: EventType.RoomJoinRules, state_key: '', content: { join_rule: 'invite' } },
      { type: EventType.RoomGuestAccess, state_key: '', content: { guest_access: 'forbidden' } }
    ]
  })

  if (!active() || !roomId(result.room_id)) {denied()}

  return result.room_id
}

/** Recover an unknown create only through its exact immutable create metadata. */
export async function findCompanyChannelRoom(
  client: MatrixClient,
  input: MatrixCompanyChannelRoomBinding,
  active: () => boolean = () => true
): Promise<MatrixCompanyChannelRoomWitness | null> {
  if (!active() || !validCompanyChannelRoomBinding(input) || client.getUserId() !== input.managerUserId) {denied()}

  const found = await findBoundRoom(client, active, {
    roomType: MATRIX_COMPANY_CHANNEL_TYPE,
    binding: companyChannelRoomBinding,
    matches: binding => sameBinding(binding, input),
    conflict: () => { throw new Error('matrix_company_channel_room_conflict') },
    denied,
    // The controller journals the report command (company-channel-runtime.ts), so a leave here is visible.
    reported: true
  })

  if (found === null) {return null}

  // Drift is a failed recovery, not permission to create a replacement room.
  return (await state(client, { ...input, roomId: found }, active)).witness
}

async function verifiedCompanyChannelRoom(
  client: MatrixClient,
  input: MatrixCompanyChannelRoomTarget,
  active: () => boolean = () => true
) {
  target(input)

  if (client.getUserId() !== input.managerUserId) {denied()}
  const current = await state(client, input, active, input.posting)
  const allowed = new Set([input.managerUserId, ...input.memberUserIds])

  if (current.members.some(event => ['join', 'invite', 'knock'].includes(String(event.content.membership)) &&
      !allowed.has(event.state_key)) || input.memberUserIds.some(id => !current.members.some(event =>
        event.state_key === id && ['join', 'invite'].includes(String(event.content.membership)))) ||
      input.bannedUserIds.some(id => !current.members.some(event =>
        event.state_key === id && event.content.membership === 'ban')) ||
      input.displayName !== undefined && current.name !== input.displayName ||
      input.topic !== undefined && current.topic !== input.topic ||
      input.avatarUri !== undefined && current.avatarUri !== input.avatarUri) {
    denied()
  }
  if (input.roomMentionUserIds !== undefined &&
      !roomMentionPowerMatches(current.power, input.managerUserId, input.roomMentionUserIds)) {
    denied()
  }

  return current
}

export async function readCompanyChannelRoom(
  client: MatrixClient,
  input: MatrixCompanyChannelRoomTarget,
  active: () => boolean = () => true
): Promise<MatrixCompanyChannelRoomWitness> {
  return (await verifiedCompanyChannelRoom(client, input, active)).witness
}

export async function reconcileCompanyChannelRoom(
  client: MatrixClient,
  input: MatrixCompanyChannelRoomTarget,
  active: () => boolean = () => true
): Promise<MatrixCompanyChannelRoomWitness & {membershipObservations: Array<{
  userId: string
  membership: 'join' | 'invite' | 'leave' | 'ban'
  joinEventId: string | null
}>}> {
  target(input)

  if (client.getUserId() !== input.managerUserId) {denied()}
  let current = await state(client, input, active)
  const allowed = new Set([input.managerUserId, ...input.memberUserIds])
  const expectedEventsDefault = input.posting === 'archived_read_only' ? 100 : 0

  if ((current.power.events as Record<string, unknown>)[EventType.RoomPinnedEvents] !== 0) {
    if (!active()) {denied()}
    await client.sendStateEvent(input.roomId, EventType.RoomPowerLevels, {
      ...current.power,
      events: { ...(current.power.events as Record<string, unknown>), [EventType.RoomPinnedEvents]: 0 }
    }, '')
    current = await state(client, input, active)
  }

  const desiredPower = (eventsDefault: number) => ({
    ...current.power,
    users: input.roomMentionUserIds === undefined
      ? current.power.users
      : Object.fromEntries([[input.managerUserId, 100], ...input.roomMentionUserIds.map(id => [id, 50] as const)]),
    events_default: eventsDefault,
    notifications: { room: input.roomMentionUserIds === undefined ? 100 : 50 }
  })
  const setPosting = async (eventsDefault: number) => {
    if (!active()) {denied()}
    await client.sendStateEvent(input.roomId, EventType.RoomPowerLevels, desiredPower(eventsDefault), '')
  }

  // Posting policy is ordered around the membership work so that a pass which dies midway never leaves the room writable
  // when it should not be. ARCHIVE closes the room first and proves it closed (a strict readback) before anything else
  // changes. RESTORE reopens it last, after every ban, invite and metadata write: a removed member is never able to post
  // into a room that was reopened before their ban landed. Either way an interrupted pass leaves the room read-only.
  if (expectedEventsDefault === 100 && current.power.events_default !== 100) {
    await setPosting(100)
    // Everything else below works from this fresh view; if the platform did not apply the closure it ends here.
    current = await state(client, input, active, input.posting)
  }

  const banned = new Set<string>()

  for (const member of current.members) {
    if (!active()) {denied()}

    if (!allowed.has(member.state_key) && ['join', 'invite', 'knock'].includes(String(member.content.membership))) {
      await client.ban(input.roomId, member.state_key)
      banned.add(member.state_key)
    }
  }

  // Exclusions and possible grants: an acknowledged join, an issued invite, or an invitation whose reply was lost
  // and so left no member event at all. Each is banned, never assumed absent.
  for (const id of [...input.bannedUserIds].sort()) {
    if (!active()) {denied()}
    const member = current.members.find(event => event.state_key === id)

    if (member?.content.membership !== 'ban' && !banned.has(id)) {await client.ban(input.roomId, id)}
  }

  for (const id of [...input.memberUserIds].sort()) {
    if (!active()) {denied()}
    const member = current.members.find(event => event.state_key === id)

    if (member?.content.membership === 'join' || member?.content.membership === 'invite') {continue}

    if (member?.content.membership === 'ban') {
      await client.unban(input.roomId, id)

      if (!active()) {denied()}
    }

    await client.invite(input.roomId, id)
  }

  // Name and topic are state events under the manager's power level 100; nobody else can write them.
  if (input.displayName !== undefined && current.name !== input.displayName) {
    if (!active()) {denied()}
    await client.sendStateEvent(input.roomId, EventType.RoomName, { name: input.displayName }, '')
  }

  if (input.topic !== undefined && current.topic !== input.topic) {
    if (!active()) {denied()}
    await client.sendStateEvent(input.roomId, EventType.RoomTopic, { topic: input.topic }, '')
  }

  if (input.avatarUri !== undefined && current.avatarUri !== input.avatarUri) {
    if (!active()) {denied()}
    await client.sendStateEvent(
      input.roomId,
      EventType.RoomAvatar,
      input.avatarUri === null ? {} : { url: input.avatarUri },
      ''
    )
  }

  const mentionPowerChanged = input.roomMentionUserIds !== undefined &&
    !roomMentionPowerMatches(current.power, input.managerUserId, input.roomMentionUserIds)

  if ((expectedEventsDefault === 0 && current.power.events_default !== 0) || mentionPowerChanged) {
    await setPosting(expectedEventsDefault)
  }

  const final = await verifiedCompanyChannelRoom(client, input, active)
  const relevant = new Set([...input.memberUserIds, ...input.bannedUserIds])
  const membershipObservations = final.members.filter(event => relevant.has(event.state_key)).map(event => {
    const membership = event.content.membership as 'join' | 'invite' | 'leave' | 'ban'
    const joinEventId = membership === 'join' ? event.event_id : null

    if (membership === 'join' && (typeof joinEventId !== 'string' || !/^[$][!-~]+$/u.test(joinEventId))) {denied()}

    return {userId: event.state_key, membership, joinEventId}
  }).sort((left, right) => left.userId.localeCompare(right.userId))

  return {...final.witness, membershipObservations}
}

const sameTargetBinding = (left: MatrixCompanyRoomTargetBinding, right: MatrixCompanyRoomTargetBinding) =>
  left.companyId === right.companyId && left.managerUserId === right.managerUserId &&
  JSON.stringify(left.target) === JSON.stringify(right.target)

function legacyBinding(input: MatrixCompanyRoomTargetBinding): MatrixCompanyChannelRoomBinding | undefined {
  return input.target.kind === 'channel'
    ? { companyId: input.companyId, channelId: input.target.channelId, managerUserId: input.managerUserId }
    : undefined
}

function targetInput(input: MatrixCompanyRoomTargetInput): void {
  if (!validCompanyRoomTargetBinding(input) || !roomId(input.roomId) ||
      !Array.isArray(input.memberUserIds) || input.memberUserIds.length > MATRIX_COMPANY_CHANNEL_MAX_MEMBERS ||
      !Array.isArray(input.bannedUserIds) || input.bannedUserIds.length > MATRIX_COMPANY_CHANNEL_MAX_BANS ||
      !['open', 'archived_read_only', 'participant_read_only'].includes(input.posting) ||
      input.target.kind === 'channel' && input.posting === 'participant_read_only' ||
      !validName(input.displayName) || !validTopic(input.topic) ||
      input.roomMentionUserIds !== undefined && (!Array.isArray(input.roomMentionUserIds) ||
        input.target.kind !== 'channel' && input.roomMentionUserIds.length > 0 || input.roomMentionUserIds.length > 100 ||
        new Set(input.roomMentionUserIds).size !== input.roomMentionUserIds.length ||
        input.roomMentionUserIds.some((id, index) => !userId(id) || !input.memberUserIds.includes(id) ||
          index > 0 && id <= input.roomMentionUserIds![index - 1]!)) ||
      [...input.memberUserIds, ...input.bannedUserIds].some(id => !userId(id) || id === input.managerUserId) ||
      new Set(input.memberUserIds).size !== input.memberUserIds.length ||
      new Set(input.bannedUserIds).size !== input.bannedUserIds.length ||
      input.memberUserIds.some(id => input.bannedUserIds.includes(id))) {
    denied()
  }
}

async function conversationState(
  client: MatrixClient,
  input: MatrixCompanyRoomTargetBinding & { roomId: string },
  active: () => boolean,
  posting?: MatrixCompanyRoomTargetInput['posting']
) {
  if (input.target.kind !== 'conversation') {denied()}
  const conversation = input.target as Extract<MatrixCompanyRoomTargetBinding['target'], { kind: 'conversation' }>

  if (!active() || !validCompanyRoomTargetBinding(input) || !roomId(input.roomId)) {
    denied()
  }
  const events = await client.roomState(input.roomId)

  if (!active()) {denied()}
  const read = (type: string) => {
    const found = events.filter(event => event.type === type && event.state_key === '')

    if (found.length !== 1) {denied()}

    return found[0]!
  }
  if (events.some(event => event.type === EventType.RoomEncryption && event.state_key === '')) {denied()}
  const creation = read(EventType.RoomCreate)
  const binding = companyRoomTargetBinding(creation.content, creation.sender)
  const history = read(EventType.RoomHistoryVisibility).content.history_visibility
  const joinRule = read(EventType.RoomJoinRules).content.join_rule
  const guest = read(EventType.RoomGuestAccess).content.guest_access
  const power = read(EventType.RoomPowerLevels).content
  const expectedEventsDefault = posting === undefined ? undefined : posting === 'open' ? 0 : 100

  if (!binding || !sameTargetBinding(binding, input) || creation.content.predecessor !== undefined ||
      creation.content.additional_creators !== undefined || history !== 'shared' || joinRule !== 'invite' ||
      guest !== 'forbidden' || !object(power.users) || power.users[input.managerUserId] !== 100 ||
      Object.entries(power.users).some(([id, level]) => !userId(id) || level !== (id === input.managerUserId ? 100 : 0)) ||
      power.users_default !== 0 || ![0, 100].includes(Number(power.events_default)) ||
      expectedEventsDefault !== undefined && power.events_default !== expectedEventsDefault || power.state_default !== 100 ||
      ['invite', 'kick', 'ban', 'redact'].some(key => power[key] !== 100) ||
      !validPowerEvents(power.events) ||
      !object(power.notifications) || power.notifications.room !== 100) {
    denied()
  }
  const members = events.filter(event => event.type === EventType.RoomMember)

  if (members.filter(event => ['join', 'invite', 'knock'].includes(String(event.content.membership))).length > 1000 ||
      new Set(members.map(event => event.state_key)).size !== members.length ||
      members.some(event => !userId(event.state_key) ||
        !['join', 'invite', 'leave', 'ban', 'knock'].includes(String(event.content.membership))) ||
      !members.some(event => event.state_key === input.managerUserId && event.content.membership === 'join')) {
    denied()
  }
  const roomDigest = await sha256([
    MATRIX_COMPANY_CHANNEL_ROOM_VERSION, MATRIX_COMPANY_CONVERSATION_TYPE, input.companyId,
    conversation.conversationId, conversation.conversationKind, conversation.participantSetDigest, input.managerUserId
  ])
  const policyWitness = await sha256([
    MATRIX_COMPANY_CHANNEL_ROOM_VERSION, MATRIX_COMPANY_CONVERSATION_TYPE, input.companyId,
    conversation.conversationId, conversation.conversationKind, conversation.participantSetDigest, input.managerUserId,
    history, joinRule, guest, 100, 0, Number(power.events_default)
  ])
  const named = events.find(event => event.type === EventType.RoomName && event.state_key === '')
  const topical = events.find(event => event.type === EventType.RoomTopic && event.state_key === '')

  return {
    members, power,
    name: typeof named?.content.name === 'string' ? named.content.name : '',
    topic: typeof topical?.content.topic === 'string' ? topical.content.topic : '',
    witness: { roomId: input.roomId, roomDigest, policyWitness }
  }
}

/** Create one v12 target room. Channel targets retain the frozen v1 channel create metadata. */
export async function createCompanyRoomTarget(
  client: MatrixClient,
  input: MatrixCompanyRoomTargetBinding & { name: string },
  active: () => boolean = () => true
): Promise<string> {
  const channel = legacyBinding(input)

  if (channel) {return createCompanyChannelRoom(client, { ...channel, name: input.name }, active)}
  if (input.target.kind !== 'conversation') {denied()}
  const conversation = input.target as Extract<MatrixCompanyRoomTargetBinding['target'], { kind: 'conversation' }>

  if (!active() || !validCompanyRoomTargetBinding(input) || client.getUserId() !== input.managerUserId || !validName(input.name)) {
    denied()
  }
  const result = await client.createRoom({
    name: input.name,
    preset: Preset.PrivateChat,
    room_version: MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
    creation_content: {
      type: MATRIX_COMPANY_CONVERSATION_TYPE,
      [MATRIX_COMPANY_CONVERSATION_BINDING]: {
        companyId: input.companyId, conversationId: conversation.conversationId,
        conversationKind: conversation.conversationKind, participantSetDigest: conversation.participantSetDigest
      }
    },
    power_level_content_override: {
      users: { [input.managerUserId]: 100 }, users_default: 0,
      events: { [EventType.RoomPinnedEvents]: 0 }, events_default: 0, state_default: 100,
      invite: 100, kick: 100, ban: 100, redact: 100, notifications: { room: 100 }
    },
    initial_state: [
      { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'shared' } },
      { type: EventType.RoomJoinRules, state_key: '', content: { join_rule: 'invite' } },
      { type: EventType.RoomGuestAccess, state_key: '', content: { guest_access: 'forbidden' } }
    ]
  })

  if (!active() || !roomId(result.room_id)) {denied()}

  return result.room_id
}

/** Recover an uncertain v12 create only through the exact immutable target metadata. */
export async function findCompanyRoomTarget(
  client: MatrixClient,
  input: MatrixCompanyRoomTargetBinding,
  active: () => boolean = () => true
): Promise<MatrixCompanyChannelRoomWitness | null> {
  const channel = legacyBinding(input)

  if (channel) {return findCompanyChannelRoom(client, channel, active)}
  if (!active() || !validCompanyRoomTargetBinding(input) || input.target.kind !== 'conversation' ||
      client.getUserId() !== input.managerUserId) {
    denied()
  }
  const found = await findBoundRoom(client, active, {
    roomType: MATRIX_COMPANY_CONVERSATION_TYPE,
    binding: companyRoomTargetBinding,
    matches: binding => sameTargetBinding(binding, input),
    conflict: () => { throw new Error('matrix_company_conversation_room_conflict') },
    denied,
    reported: true
  })

  return found === null ? null : (await conversationState(client, { ...input, roomId: found }, active)).witness
}

export async function readCompanyRoomTarget(
  client: MatrixClient,
  input: MatrixCompanyRoomTargetInput,
  active: () => boolean = () => true
): Promise<MatrixCompanyChannelRoomWitness> {
  targetInput(input)
  const channel = legacyBinding(input)

  if (channel) {
    return readCompanyChannelRoom(client, {
      ...channel, roomId: input.roomId, memberUserIds: input.memberUserIds, bannedUserIds: input.bannedUserIds,
      posting: input.posting as MatrixCompanyChannelRoomTarget['posting'], displayName: input.displayName, topic: input.topic,
      ...(input.avatarUri !== undefined ? { avatarUri: input.avatarUri } : {}),
      ...(input.roomMentionUserIds !== undefined ? { roomMentionUserIds: input.roomMentionUserIds } : {})
    }, active)
  }
  if (client.getUserId() !== input.managerUserId) {denied()}
  const current = await conversationState(client, input, active, input.posting)
  const allowed = new Set([input.managerUserId, ...input.memberUserIds])

  if (current.members.some(event => ['join', 'invite', 'knock'].includes(String(event.content.membership)) &&
      !allowed.has(event.state_key)) || input.memberUserIds.some(id => !current.members.some(event =>
        event.state_key === id && ['join', 'invite'].includes(String(event.content.membership)))) ||
      input.bannedUserIds.some(id => !current.members.some(event =>
        event.state_key === id && event.content.membership === 'ban')) || current.name !== input.displayName ||
      current.topic !== input.topic) {
    denied()
  }

  return current.witness
}

export async function reconcileCompanyRoomTarget(
  client: MatrixClient,
  input: MatrixCompanyRoomTargetInput,
  active: () => boolean = () => true
): Promise<MatrixCompanyChannelRoomWitness> {
  targetInput(input)
  const channel = legacyBinding(input)

  if (channel) {
    return reconcileCompanyChannelRoom(client, {
      ...channel, roomId: input.roomId, memberUserIds: input.memberUserIds, bannedUserIds: input.bannedUserIds,
      posting: input.posting as MatrixCompanyChannelRoomTarget['posting'], displayName: input.displayName, topic: input.topic,
      ...(input.avatarUri !== undefined ? { avatarUri: input.avatarUri } : {}),
      ...(input.roomMentionUserIds !== undefined ? { roomMentionUserIds: input.roomMentionUserIds } : {})
    }, active)
  }
  if (client.getUserId() !== input.managerUserId) {denied()}
  let current = await conversationState(client, input, active)
  const allowed = new Set([input.managerUserId, ...input.memberUserIds])
  const expectedEventsDefault = input.posting === 'open' ? 0 : 100
  const membershipEffect = async (effect: () => Promise<unknown>) => {
    if (!active()) {denied()}
    await effect()
    // A Matrix request can outlive the manager term. Never start the next
    // membership effect until the exact term is proved live again.
    if (!active()) {denied()}
  }
  const setPosting = async () => {
    if (!active()) {denied()}
    await client.sendStateEvent(input.roomId, EventType.RoomPowerLevels,
      { ...current.power, events_default: expectedEventsDefault }, '')
  }

  if ((current.power.events as Record<string, unknown>)[EventType.RoomPinnedEvents] !== 0) {
    if (!active()) {denied()}
    await client.sendStateEvent(input.roomId, EventType.RoomPowerLevels, {
      ...current.power,
      events: { ...(current.power.events as Record<string, unknown>), [EventType.RoomPinnedEvents]: 0 }
    }, '')
    current = await conversationState(client, input, active)
  }

  if (expectedEventsDefault === 100 && current.power.events_default !== 100) {
    await setPosting()
    current = await conversationState(client, input, active, input.posting)
  }
  const banned = new Set<string>()

  for (const member of current.members) {
    if (!active()) {denied()}
    if (!allowed.has(member.state_key) && ['join', 'invite', 'knock'].includes(String(member.content.membership))) {
      await membershipEffect(() => client.ban(input.roomId, member.state_key))
      banned.add(member.state_key)
    }
  }
  for (const id of [...input.bannedUserIds].sort()) {
    if (!active()) {denied()}
    const member = current.members.find(event => event.state_key === id)

    if (member?.content.membership !== 'ban' && !banned.has(id)) {
      await membershipEffect(() => client.ban(input.roomId, id))
    }
  }
  for (const id of [...input.memberUserIds].sort()) {
    if (!active()) {denied()}
    const member = current.members.find(event => event.state_key === id)

    if (member?.content.membership === 'join' || member?.content.membership === 'invite') {continue}
    if (member?.content.membership === 'ban') {
      await membershipEffect(() => client.unban(input.roomId, id))
    }
    await membershipEffect(() => client.invite(input.roomId, id))
  }
  if (current.name !== input.displayName) {
    if (!active()) {denied()}
    await client.sendStateEvent(input.roomId, EventType.RoomName, { name: input.displayName }, '')
  }
  if (current.topic !== input.topic) {
    if (!active()) {denied()}
    await client.sendStateEvent(input.roomId, EventType.RoomTopic, { topic: input.topic }, '')
  }
  if (expectedEventsDefault === 0 && current.power.events_default !== 0) {await setPosting()}

  return readCompanyRoomTarget(client, input, active)
}
