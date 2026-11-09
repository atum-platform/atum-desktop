import {
  Direction,
  EventStatus,
  EventType,
  type ISendEventResponse,
  type MatrixClient,
  MatrixEvent,
  MatrixEventEvent,
  MsgType
} from 'matrix-js-sdk'

import { canonicalJson } from '../../../../packages/device-protocol/canonical'
import { matrixMessageTooLong, type MatrixOriginAssertion, type MatrixSdkCommand, type MatrixTurnLookup } from '../../shared/matrix'
import { MATRIX_ANSWER_PART_KEY, matrixAnswerPart } from '../../shared/matrix-answer-parts'
import { MATRIX_CHECK_IN_NUDGE_KEY, parseMatrixCheckInNudge } from '../../shared/matrix-check-ins'
import { MATRIX_GOOGLE_PROVENANCE, MATRIX_GOOGLE_PROVENANCE_KEY } from '../../shared/matrix-google-tools'
import {
  MATRIX_CRON_KEY,
  MATRIX_FIND_TURN,
  MATRIX_HANDOFF_KEY,
  MATRIX_TURN_KEY,
  matrixCronMarker,
  matrixCronTransaction,
  matrixQuestionTransaction,
  matrixTurnContent,
  matrixTurnId
} from '../../shared/matrix-turn'

import { requireAgentPostRoom } from './conversations'
import { prepareMatrixEvent } from './prepare-event'

/** The content key a signed origin assertion travels under (atum.cloud-answering/1 §3.2). */
const ORIGIN_KEY = 'io.atum.origin'

/** How long a send already in flight (a previous attempt) may take to settle. */
const SETTLE_MS = 30_000

/**
 * Sends once per call, always under the same transaction ID. The SDK has no scheduler
 * (sdk.ts passes none), so the local-turn engine in main is the only retry owner.
 * A retry while the SDK still holds this transaction's local echo reuses that echo
 * (`resendEvent`); after a restart it sends afresh under the same ID. Synapse
 * deduplicates by transaction; where that may not apply (access-token rotation), main
 * re-sends only after `findTurn` proved the event absent.
 */
export async function sendWithTransaction(
  client: MatrixClient,
  roomId: string,
  transactionId: string,
  send: () => Promise<ISendEventResponse>
): Promise<string> {
  const room = client.getRoom(roomId)
  const existing = room?.getEventForTxnId(transactionId)

  if (room && existing) {
    if (existing.status === EventStatus.NOT_SENT) {
      return eventId(await client.resendEvent(existing, room))
    }

    return settled(existing)
  }

  return eventId(await send())
}

function eventId(response: ISendEventResponse | undefined): string {
  if (typeof response?.event_id !== 'string' || !response.event_id.startsWith('$')) {
    throw new Error('matrix_send_failed')
  }

  return response.event_id
}

/** The outcome of an attempt already in flight: its event ID, or failure. */
function settled(event: MatrixEvent): Promise<string> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      event.off(MatrixEventEvent.Status, check)
    }

    const check = () => {
      const id = event.getId()

      if ((event.status === EventStatus.SENT || event.status === null) && id?.startsWith('$')) {
        done()
        resolve(id)
      } else if (event.status === EventStatus.NOT_SENT || event.status === EventStatus.CANCELLED) {
        done()
        reject(new Error('matrix_send_failed'))
      }
    }

    const timer = setTimeout(() => {
      done()
      reject(new Error('matrix_send_pending'))
    }, SETTLE_MS)

    event.on(MatrixEventEvent.Status, check)
    check()
  })
}

/** A local-path question: the text main ran, the turn marker, the fixed transaction ID. */
export async function sendMatrixTurn(
  client: MatrixClient,
  command: Extract<MatrixSdkCommand, { kind: 'sendTurn' }>
): Promise<string> {
  const turnId = matrixTurnId(command.turnId)

  if (
    !turnId ||
    command.transactionId !== matrixQuestionTransaction(turnId) ||
    typeof command.body !== 'string' ||
    !command.body.length ||
    matrixMessageTooLong(command.body)
  ) {
    throw new Error('matrix_command_invalid')
  }

  // The agent's own chat (plain since 0.20) or an encrypted room as before (`agentPostRoom`).
  await requireAgentPostRoom(client, client.getRoom(command.roomId))

  // A cloud question is always handed off (no Mac answers it), and only a cloud question carries
  // this Mac's origin assertion.
  if (
    (command.cloud !== undefined && (command.cloud !== true || command.handoff !== true)) ||
    (command.origin !== undefined && command.cloud !== true)
  ) {
    throw new Error('matrix_command_invalid')
  }

  // A reply names a message of this room (never with the handoff marker for another Mac: it would
  // refuse it; the cloud brain reads the quote). Every attempt sends the same content under the
  // same transaction.
  if (
    command.replyTo !== undefined &&
    ((command.handoff === true && command.cloud !== true) ||
      typeof command.replyTo !== 'string' ||
      !command.replyTo.startsWith('$') ||
      command.replyTo.length > 1024)
  ) {
    throw new Error('matrix_command_invalid')
  }

  // A handed-off question must reach the Mac that answers this agent: every answering Mac
  // skips the local-turn marker, so it carries the handoff marker instead.
  const content = matrixTurnContent({
    body: command.body,
    turnId,
    ...(command.handoff === true ? { handoff: true as const } : {}),
    ...(command.replyTo ? { replyTo: command.replyTo } : {})
  })

  // A question to an agent that answers in the cloud carries this Mac's signed origin assertion.
  // It must cover exactly these bytes and this room; anything else is refused, never sent bare.
  if (command.origin !== undefined) {
    if (!(await originCovers(command.origin, command.roomId, content))) {
      throw new Error('matrix_origin_mismatch')
    }

    content[ORIGIN_KEY] = command.origin
  }

  return sendWithTransaction(client, command.roomId, command.transactionId, () =>
    client.sendEvent(
      command.roomId,
      EventType.RoomMessage,
      content as { msgtype: MsgType.Text; body: string },
      command.transactionId
    )
  )
}

/** Request digest v2: unpadded base64url SHA-256 of the canonical content without its origin. */
async function requestDigestV2(content: Record<string, unknown>): Promise<string> {
  const { [ORIGIN_KEY]: _origin, ...rest } = content

  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(rest)))
  )

  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** The contract's origin assertion fields, exactly. */
const ORIGIN_FIELDS = 'ae,agent,boot,dev,dg,dsid,ee,fpr,kid,n,owner,room,sig,t,v'

/** The assertion has the contract's exact fields, names this room, and its `dg` is this content's. */
async function originCovers(origin: MatrixOriginAssertion, roomId: string, content: Record<string, unknown>) {
  if (
    !origin ||
    typeof origin !== 'object' ||
    Object.keys(origin).sort().join(',') !== ORIGIN_FIELDS ||
    origin.v !== 1 ||
    origin.room !== roomId ||
    typeof origin.dg !== 'string' ||
    typeof origin.sig !== 'string' ||
    JSON.stringify(origin).length > 4096
  ) {
    return false
  }

  try {
    return (await requestDigestV2(content)) === origin.dg
  } catch {
    return false
  }
}

/** A scheduled job's result as the agent: the run marker, a transaction fixed per run. */
export async function publishMatrixCron(
  client: MatrixClient,
  command: Extract<MatrixSdkCommand, { kind: 'publishCron' }>
): Promise<string> {
  const { content, transactionId } = await buildMatrixCron(client, command)

  return sendWithTransaction(client, command.roomId, transactionId, () =>
    client.sendEvent(command.roomId, EventType.RoomMessage, content, transactionId)
  )
}

/** Prepare exactly the cron event the direct path sends, without publishing it. */
export async function prepareMatrixCron(client: MatrixClient, command: Extract<MatrixSdkCommand, { kind: 'prepareCron' }>) {
  const { content } = await buildMatrixCron(client, { ...command, kind: 'publishCron' })

  return prepareMatrixEvent(client, client.getRoom(command.roomId)!, EventType.RoomMessage, content)
}

async function buildMatrixCron(client: MatrixClient, command: Extract<MatrixSdkCommand, { kind: 'publishCron' }>) {
  const runId = matrixTurnId(command.runId)

  if (
    !runId ||
    typeof command.body !== 'string' ||
    !command.body.trim() ||
    command.body.length > 16000 ||
    typeof command.jobId !== 'string' ||
    !command.jobId ||
    command.jobId.length > 200 ||
    (command.notify !== undefined && command.notify !== false)
  ) {
    throw new Error('matrix_command_invalid')
  }

  // The agent's own chat (plain since 0.20) or an encrypted room as before (`agentPostRoom`).
  await requireAgentPostRoom(client, client.getRoom(command.roomId))

  // A check-in's nudge goes beside the run marker, for its card, as validated here; an
  // invalid one is refused, never posted half-formed.
  const nudge = command.nudge === undefined ? undefined : parseMatrixCheckInNudge(command.nudge)

  if (command.nudge !== undefined && !nudge) {
    throw new Error('matrix_command_invalid')
  }

  const transactionId = matrixCronTransaction(runId)

  const content = {
    msgtype: command.notify === false ? MsgType.Notice as const : MsgType.Text as const,
    body: command.body,
    [MATRIX_CRON_KEY]: { run: runId, job: command.jobId },
    ...(nudge ? { [MATRIX_CHECK_IN_NUDGE_KEY]: nudge } : {}),
    // A latched agent's scheduled post may summarize Google data (spec/awareness/v1 §3.7).
    ...(command.google === true ? { [MATRIX_GOOGLE_PROVENANCE_KEY]: { ...MATRIX_GOOGLE_PROVENANCE } } : {})
  }

  return { content, transactionId }
}

/**
 * Read-back on the device that sent the event (it can decrypt its own events): the
 * live timeline, then at most `pages` × `pageSize` events of fresh `/messages`, within the
 * deadline. `absent` only when the scan reached before the turn began without an
 * undecryptable event from that sender; anything short of that is `unknown`.
 */
export async function findMatrixTurn(
  client: MatrixClient,
  command: Extract<MatrixSdkCommand, { kind: 'findTurn' }>,
  now: () => number = Date.now
): Promise<MatrixTurnLookup> {
  const turnId = matrixTurnId(command.turnId)

  if (
    !turnId ||
    typeof command.sender !== 'string' ||
    !command.sender ||
    !Number.isFinite(command.since) ||
    (command.part !== undefined && (!Number.isSafeInteger(command.part) || command.part < 0 || command.marker !== undefined))
  ) {
    throw new Error('matrix_command_invalid')
  }

  const deadline = now() + MATRIX_FIND_TURN.deadlineMs
  let timer: ReturnType<typeof setTimeout> | undefined

  const expired = new Promise<MatrixTurnLookup>(resolve => {
    timer = setTimeout(() => resolve({ state: 'unknown' }), MATRIX_FIND_TURN.deadlineMs)
  })

  try {
    return await Promise.race([scan(client, command, turnId, () => now() >= deadline), expired])
  } catch {
    return { state: 'unknown' }
  } finally {
    clearTimeout(timer)
  }
}

async function scan(
  client: MatrixClient,
  command: Extract<MatrixSdkCommand, { kind: 'findTurn' }>,
  turnId: string,
  late: () => boolean
): Promise<MatrixTurnLookup> {
  const room = client.getRoom(command.roomId)

  if (room?.getMyMembership() !== 'join') {
    return { state: 'unknown' }
  }

  const cutoff = command.since - MATRIX_FIND_TURN.skewMs
  let covered = false
  let uncertain = false

  const inspect = (event: MatrixEvent): string | undefined => {
    if (event.getTs() < cutoff) {
      covered = true
    }

    if (event.getSender() !== command.sender) {
      return undefined
    }

    if (event.isDecryptionFailure() || event.getType() === EventType.RoomMessageEncrypted) {
      // Failed OR still decrypting: either could be the turn itself.
      uncertain ||= event.getTs() >= cutoff

      return undefined
    }

    // The marker as first sent: an edit's replacement text carries none, and an edited
    // question must never read as absent (and be sent again).
    const content = event.getOriginalContent()

    // One part of a split answer is found only by its own position, never by another part.
    const marked =
      (command.marker === 'cron'
        ? matrixCronMarker(content)
        : matrixTurnId(content[command.marker === 'handoff' ? MATRIX_HANDOFF_KEY : MATRIX_TURN_KEY])) === turnId &&
      (command.part === undefined || matrixAnswerPart(content[MATRIX_ANSWER_PART_KEY])?.index === command.part)

    // The turn's own local echo still in flight may yet land: wait, never re-send. A failed
    // echo (not sent) may be re-sent; the SDK reuses its transaction ID (sendWithTransaction).
    if (marked && (event.status === EventStatus.SENDING || event.status === EventStatus.QUEUED || event.status === EventStatus.ENCRYPTING)) {
      uncertain = true

      return undefined
    }

    const id = event.getId()

    return event.getType() === EventType.RoomMessage &&
      !event.isRedacted() &&
      (event.status === null || event.status === EventStatus.SENT) &&
      id?.startsWith('$') &&
      marked
      ? id
      : undefined
  }

  const timeline = room.getLiveTimeline()

  // Newest first, so reaching an event before the cutoff means every newer one was seen.
  for (const event of [...timeline.getEvents()].reverse()) {
    if (late()) {return { state: 'unknown' }}

    if (event.isEncrypted()) {await client.decryptEventIfNeeded(event)}
    const found = inspect(event)

    if (found) {
      return { state: 'found', eventId: found }
    }
  }

  // A restored SDK timeline may predate a successful send whose receipt we lost.
  // Its old events/backward token prove nothing about the current server tail.
  // A live match proves presence; only a fresh bounded server scan proves absence.
  let from: string | null = null
  covered = false

  for (let page = 0; !covered && page < MATRIX_FIND_TURN.pages; page++) {
    if (late()) {
      return { state: 'unknown' }
    }

    const batch = await client.createMessagesRequest(command.roomId, from, MATRIX_FIND_TURN.pageSize, Direction.Backward)

    for (const raw of batch.chunk ?? []) {
      if (late()) {
        return { state: 'unknown' }
      }

      const event = new MatrixEvent(raw)

      if (event.isEncrypted()) {
        await client.decryptEventIfNeeded(event)
      }

      const found = inspect(event)

      if (found) {
        return { state: 'found', eventId: found }
      }
    }

    if (!batch.end || !batch.chunk?.length) {
      covered = true
    }

    from = batch.end ?? null
  }

  return covered && !uncertain ? { state: 'absent' } : { state: 'unknown' }
}
