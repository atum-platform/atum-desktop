import { EventType, type MatrixClient, MsgType, type Room } from 'matrix-js-sdk'

import { validStopEvent } from '../../../../packages/device-protocol/stop-target'
import { agentTaskMessageWire, MATRIX_AGENT_TASK_KEY } from '../../shared/agent-task'
import { AGENT_SWEEP_SYSTEM_JOB_ID } from '../../shared/background-sweep'
import type { MatrixSdkCommand } from '../../shared/matrix'
import { isMatrixAgentStatusCode } from '../../shared/matrix-agent-status-copy'
import { MATRIX_ANSWER_PART_KEY, matrixAnswerPart } from '../../shared/matrix-answer-parts'
import { appGroupBinding } from '../../shared/matrix-app-room'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import { type MatrixDeviceIsolation, matrixLegacyGroupKeys } from '../../shared/matrix-device-isolation'
import { MATRIX_GOOGLE_PROVENANCE, MATRIX_GOOGLE_PROVENANCE_KEY } from '../../shared/matrix-google-tools'
import { matrixPetReplyMixin } from '../../shared/matrix-pet-intent'
import { MATRIX_CRON_KEY, MATRIX_TURN_KEY, matrixTurnId } from '../../shared/matrix-turn'

import { agentTaskRoomBinding, readAgentTaskRoom } from './agent-tasks'
import { isMatrixPrivateChat } from './assistant-room'
import { requireAgentPostRoom } from './conversations'
import { groupChainPublication } from './group-chain-publish'
import { matrixInterimPayload, matrixNoticeEditPayload, matrixRedactableProgressLine, matrixRedactionTransaction } from './notice-edit'
import { confirmedPlainRoom } from './plain-room'
import { type MatrixPreparedEvent, prepareMatrixEvent } from './prepare-event'
import { sendWithTransaction } from './turn'

type ResultCommand = Extract<MatrixSdkCommand, { kind: 'publishResult' | 'prepareResult' }>

/** The same SDK publication path for local Hermes and owner-local app proxies. */
export async function publishMatrixResult(
  client: MatrixClient,
  command: Extract<MatrixSdkCommand, { kind: 'publishResult' }>,
  deviceIsolation?: MatrixDeviceIsolation
): Promise<string> {
  const { content, transactionId } = await buildMatrixResult(client, command, deviceIsolation)

  return sendWithTransaction(client, command.roomId, transactionId, () =>
    client.sendEvent(command.roomId, EventType.RoomMessage, content, transactionId)
  )
}

/**
 * The event `publishMatrixResult` would send, prepared as the final bytes and NOT sent (the room's encryption
 * applied, its keys shared, nothing PUT): an agent whose home the placement model governs hands these bytes to the
 * platform, whose worker sends them (atum.agent-home/2.1). Every check and every field of the send path applies.
 */
export async function prepareMatrixResult(
  client: MatrixClient,
  command: Extract<MatrixSdkCommand, { kind: 'prepareResult' }>,
  deviceIsolation?: MatrixDeviceIsolation
): Promise<MatrixPreparedEvent> {
  const { room, content } = await buildMatrixResult(client, command, deviceIsolation)

  return prepareMatrixEvent(client, room, EventType.RoomMessage, content)
}

/** Everything a result needs before it is sent or prepared: the room it may be said in, and the event itself. */
async function buildMatrixResult(
  client: MatrixClient,
  command: ResultCommand,
  deviceIsolation?: MatrixDeviceIsolation
) {
  const room = client.getRoom(command.roomId)
  const creation = room?.currentState.getStateEvents(EventType.RoomCreate, '')
  const binding = creation && appGroupBinding(creation.getContent(), creation.getSender())
  const cachedTaskBinding = room && command.task === true ? agentTaskRoomBinding(room) : undefined
  const taskBinding = cachedTaskBinding
    ? await readAgentTaskRoom(client, {
        roomId: command.roomId,
        ownerId: cachedTaskBinding.owner,
        agentPrincipal: cachedTaskBinding.targetPrincipal,
        agentUserId: cachedTaskBinding.targetUser
      })
    : undefined

  if (command.task === true && !taskBinding) {
    throw new Error('matrix_command_invalid')
  }

  // Its own chat, a group's answer, or any encrypted room as before (`agentPostRoom`); an app's
  // answer also in its plain pair (an untyped room) or in a plain app group bound to this app,
  // plain only when the crypto store agrees (`confirmedPlainRoom`), as every plaintext send.
  const plainAppRoom =
    command.app === true &&
    room?.getMyMembership() === 'join' &&
    (binding ? binding.app === client.getUserId() : room.getType() === undefined) &&
    (await confirmedPlainRoom(client, room))

  const plainTaskRoom = Boolean(
    command.task === true &&
    taskBinding &&
    taskBinding.targetUser === client.getUserId() &&
    room?.getMyMembership() === 'join' &&
    (await confirmedPlainRoom(client, room))
  )

  if (!plainAppRoom && !plainTaskRoom) {
    await requireAgentPostRoom(client, room, command.group)
  }

  if (!room) {
    throw new Error('matrix_encrypted_room_required')
  }

  if (binding?.app === client.getUserId() && matrixLegacyGroupKeys(deviceIsolation)) {
    // Main rechecks full current membership/binding immediately before this
    // trusted command. Only this app's disclosed group replies use standard
    // joined-device sharing. Never alter global/human/private-room trust.
    // The SDK override is in-memory: reapply on every send/retry after restart.
    room.setBlacklistUnverifiedDevices(false)
  }

  shareGroupKeys(client, room, command.group, deviceIsolation)

  const turnId = command.turnId === undefined ? undefined : matrixTurnId(command.turnId)

  // A cloud assistant's status notice carries its closed code beside the sentence, so an app
  // can show its own words for it (atum.agent-home/1 status outbox).
  // One part of an answer too long for one message: its position goes beside the turn's markers.
  const part = command.part === undefined ? undefined : matrixAnswerPart(command.part)
  // A follow-up sweep's offer is a standalone scheduled-post form: no reply target and the
  // system job marker, exactly as the cloud controller publishes it.
  const sweepRun = command.sweep === true ? matrixTurnId(command.invocationId) : undefined

  if ((command.turnId !== undefined && !turnId) || (command.status !== undefined && !isMatrixAgentStatusCode(command.status)) ||
      (command.task === true) !== (command.taskOutcome !== undefined) ||
      (command.taskOutcome !== undefined && !['completed', 'failed', 'stopped'].includes(command.taskOutcome)) ||
      (command.stopEvent !== undefined && (command.status !== 'resuming_on_device' || !validStopEvent(command.stopEvent))) ||
      (command.part !== undefined && !part) ||
      (command.sweep === true && (!sweepRun || command.turnId !== undefined || command.part !== undefined ||
        command.status !== undefined || command.stopEvent !== undefined || command.pet !== undefined ||
        command.task !== undefined || command.group !== undefined || command.app !== undefined ||
        command.chain !== undefined))) {
    throw new Error('matrix_command_invalid')
  }

  // An ordinary rich reply is a room message with m.in_reply_to. Do not use the
  // SDK's thread overload here: that would turn every assistant answer into an
  // m.thread relation. A local-path answer additionally carries its fixed turn
  // marker and transaction ID (`atum-a-<turnId>`). A sweep's offer is the cloud's
  // standalone form: the cron marker names the system job and nothing replies.
  const content = command.sweep === true
    ? {
        msgtype: MsgType.Text as const,
        body: command.body,
        [MATRIX_CRON_KEY]: { run: sweepRun!, job: AGENT_SWEEP_SYSTEM_JOB_ID },
        // Derived from Google data: the cloud reader never indexes it.
        ...(command.google === true ? { [MATRIX_GOOGLE_PROVENANCE_KEY]: { ...MATRIX_GOOGLE_PROVENANCE } } : {})
      }
    : {
        msgtype: MsgType.Text as const,
        ...matrixPetReplyMixin(command.pet, command.group !== true && !binding &&
          room.getType() === MATRIX_ASSISTANT_ROOM_TYPE && room.getMembers().length === 2 &&
          room.getMembers().every(member => member.membership === 'join')),

        body: command.body,
        ...(command.group && command.chain ? groupChainPublication(command.mentionsFrom ?? command.body, command.chain) : {}),
        'm.relates_to': { 'm.in_reply_to': { event_id: command.eventId } },
        'io.atum.result': {
          invocation: command.invocationId,
          transaction: command.transactionId,
          ...(command.status ? { status: command.status } : {}),
          ...(command.stopEvent ? { stopEvent: command.stopEvent } : {})
        },
        ...(turnId ? { [MATRIX_TURN_KEY]: turnId } : {}),
        ...(taskBinding && (!part || part.index === part.count - 1)
          ? {
              [MATRIX_AGENT_TASK_KEY]: agentTaskMessageWire(
                taskBinding.taskId,
                command.taskOutcome!,
                Date.now()
              )
            }
          : {}),
        ...(part ? { [MATRIX_ANSWER_PART_KEY]: part } : {}),
        // Derived from Google data: the cloud reader never indexes it.
        ...(command.google === true ? { [MATRIX_GOOGLE_PROVENANCE_KEY]: { ...MATRIX_GOOGLE_PROVENANCE } } : {})
      }

  return { room, content, transactionId: command.matrixTransactionId ?? command.transactionId }
}

/**
 * An assistant's answer in a group is for everyone there: its device shares the room's keys
 * with every member's device, the standard Matrix default, instead of only verified ones
 * (`globalBlacklistUnverifiedDevices`, sdk.ts). Per room and only for an ordinary group (no
 * room type) that main has just re-read as one (readGroupRoom): never the assistant's private
 * room (typed, or an older direct chat of two), an app group or a company room, and never the
 * account-wide setting. In memory only,
 * so it is applied again on every post, after a restart too.
 */
function requireGroupPublicationRoom(client: MatrixClient, room: Room, group: true | undefined) {
  if (group === true && (room.getType() || isMatrixPrivateChat(client, room))) {
    throw new Error('matrix_group_room_required')
  }
}

function shareGroupKeys(client: MatrixClient, room: Room, group: true | undefined, mode?: MatrixDeviceIsolation) {
  requireGroupPublicationRoom(client, room, group)

  if (group === true && matrixLegacyGroupKeys(mode)) {
    room.setBlacklistUnverifiedDevices(false)
  }
}

/** The transaction of the agent's status line about one message: the same on every attempt,
 * so the server keeps one line however often it is sent, and never another message's (every
 * UTF-16 unit outside [A-Za-z0-9_-] is written as `.` and four hex digits). */
export function matrixNoticeTransaction(eventId: string): string {
  const escaped = eventId.slice(1).replace(/[^\w-]/g, unit => `.${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)

  return `atum-n-${escaped}`
}

/**
 * The agent's status line about one of the owner's messages (a reply it holds because it can't
 * read the message that reply answers). An `m.notice`, Matrix's message for automated status:
 * people's apps show it like any message, and nothing reads it as a question, an answer or
 * part of the conversation the assistant resumes (continuity.ts counts it as a gap, never as
 * unknown agent text). A rich reply to that message, under a transaction fixed per message.
 * A small allowlist of system notices supplies a narrower deterministic transaction so retries
 * from separate devices collapse to the same event.
 */
export async function publishMatrixNotice(
  client: MatrixClient,
  command: Extract<MatrixSdkCommand, { kind: 'publishNotice' }>,
  current: () => boolean = () => true,
  deviceIsolation?: MatrixDeviceIsolation
): Promise<string> {
  const dailyEarlier = typeof command.transactionId === 'string' &&
    /^atum-earlier-[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-f0-9]{64}$/.test(command.transactionId)

  const groupRoutingFailure = typeof command.transactionId === 'string' &&
    /^atum-grf-[a-f0-9]{64}$/.test(command.transactionId)

  const fixedTransaction = dailyEarlier || groupRoutingFailure

  if (
    typeof command.eventId !== 'string' ||
    !command.eventId.startsWith('$') ||
    command.eventId.length > 255 ||
    typeof command.body !== 'string' ||
    // A removal carries no words; every other notice and an interim remark must.
    (command.redact === true ? command.body !== '' : !command.body.trim()) ||
    command.body.length > 1000 ||
    // The progress line and the interim remark are the owner's private chat only (agent-turns/1.3,
    // 1.4): never a group notice.
    ((command.progress !== undefined || command.interim !== undefined || command.redact !== undefined) &&
      command.group !== undefined) ||
    (dailyEarlier && (command.group !== undefined || command.statusLine !== undefined ||
      command.progress !== undefined || command.replaces !== undefined || command.revision !== undefined)) ||
    (groupRoutingFailure && (command.group !== true || command.statusLine !== undefined ||
      command.progress !== undefined || command.replaces !== undefined || command.revision !== undefined))
  ) {
    throw new Error('matrix_command_invalid')
  }

  const room = await requireAgentPostRoom(client, client.getRoom(command.roomId), command.group)

  shareGroupKeys(client, room, command.group, deviceIsolation)

  if (command.redact === true) {
    const present = await matrixRedactableProgressLine(client, command)

    if (!current() || client.getRoom(command.roomId) !== room) {
      throw new Error('matrix_encrypted_room_required')
    }

    if (!present) {
      return command.replaces!
    }

    await client.redactEvent(command.roomId, command.replaces!, matrixRedactionTransaction(command.replaces!))

    return command.replaces!
  }

  const interim = command.interim === true && !fixedTransaction ? matrixInterimPayload(command) : null

  if (command.interim !== undefined && !interim) {
    throw new Error('matrix_command_invalid')
  }

  const edit = fixedTransaction || interim ? interim : await matrixNoticeEditPayload(client, command)

  if (!current() || client.getRoom(command.roomId) !== room) {
    throw new Error('matrix_encrypted_room_required')
  }

  await requireAgentPostRoom(client, room, command.group)

  const transactionId = edit?.transactionId ?? (fixedTransaction ? command.transactionId! : matrixNoticeTransaction(command.eventId))

  const content = edit?.content ?? {
    msgtype: MsgType.Notice as const,
    body: command.body,
    'm.relates_to': { 'm.in_reply_to': { event_id: command.eventId } }
  }

  return sendWithTransaction(client, command.roomId, transactionId, () =>
    client.sendEvent(command.roomId, EventType.RoomMessage, content, transactionId)
  )
}

/**
 * An assistant's disclosure line before an admitted shared answer, posted by the assistant so
 * every member sees it on any client: what it is, that it answers only the person who added it
 * (when they mention it or reply to it), and what of the group reaches an AI service. Fixed
 * copy in its owner's language (`matrixActionCopy.groupJoined`), an `m.notice` so nothing
 * takes it for a question or an answer. Main supplies a stable per-invocation transaction
 * after validating the audience; older callers retain the per-room/join default transaction.
 */
export async function publishMatrixGroupNotice(
  client: MatrixClient,
  command: Extract<MatrixSdkCommand, { kind: 'publishGroupNotice' }>,
  deviceIsolation?: MatrixDeviceIsolation
): Promise<string> {
  if (typeof command.body !== 'string' || !command.body.trim() || command.body.length > 1000 ||
    (command.transactionId !== undefined &&
      (typeof command.transactionId !== 'string' || !/^atum-gd-[a-f0-9]{64}$/.test(command.transactionId)))) {
    throw new Error('matrix_command_invalid')
  }

  const room = client.getRoom(command.roomId)

  // A group: encrypted as before, or plain (new groups are plain since 0.20).
  await requireAgentPostRoom(client, room, true)

  if (!room) {
    throw new Error('matrix_encrypted_room_required')
  }

  shareGroupKeys(client, room, true, deviceIsolation)

  // Once per time it joins: its own join event names this stay in the group, so it is said
  // again after it is removed and added back, and never twice for one stay.
  const joined = room.currentState.getStateEvents(EventType.RoomMember, client.getUserId() ?? '')?.getId()

  if (!joined?.startsWith('$')) {
    throw new Error('matrix_encrypted_room_required')
  }

  const escaped = `${command.roomId.slice(1)}${joined.slice(1)}`.replace(
    /[^\w-]/g,
    unit => `.${unit.charCodeAt(0).toString(16).padStart(4, '0')}`
  )

  const transactionId = command.transactionId ?? `atum-g-${escaped}`

  return sendWithTransaction(client, command.roomId, transactionId, () =>
    client.sendEvent(command.roomId, EventType.RoomMessage, { msgtype: MsgType.Notice, body: command.body }, transactionId)
  )
}
