import {
  matrixAttachmentMsgtype,
  type MatrixDomainIdentity,
  type MatrixIdentity,
  type MatrixInvocationMessage,
  matrixOwnerWireType,
  type MatrixRecoveredResult,
  type MatrixResultBinding,
  matrixRoomTextTooLong,
  type MatrixSdkCommand
} from '../../shared/matrix'

import { matrixInvocationRequestHash } from './invocation'

interface Dependencies {
  context(): { human: MatrixIdentity; domain: MatrixDomainIdentity }
  read(command: MatrixSdkCommand): Promise<unknown>
  authorize(input: Record<string, unknown>): Promise<unknown>
}

const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v)

/** A different human device may inspect the old result without enrolling a new
 * executor. No execute/prepare/confirm/write dependency exists on this path. */
export async function recoverMatrixResult(
  deps: Dependencies,
  target: { roomId: string; eventId: string },
  signal: AbortSignal
): Promise<MatrixRecoveredResult> {
  const context = deps.context()

  const live = () => {
    signal.throwIfAborted()

    if (JSON.stringify(deps.context()) !== JSON.stringify(context)) {
      throw new Error('matrix_recovery_cancelled')
    }
  }

  live()
  const message = (await deps.read({ kind: 'readInvocation', ...target })) as MatrixInvocationMessage
  live()

  if (
    !message ||
    message.roomId !== target.roomId ||
    message.eventId !== target.eventId ||
    message.sender !== context.human.userId ||
    !matrixOwnerWireType(message.wireType) ||
    !message.senderDevice ||
    !(message.content?.msgtype === 'm.text' || matrixAttachmentMsgtype(message.content?.msgtype)) ||
    typeof message.content.body !== 'string' ||
    !message.content.body.length ||
    matrixRoomTextTooLong(message.content.body) ||
    (matrixAttachmentMsgtype(message.content.msgtype) &&
      (!message.content.attachment || !/^[a-f0-9]{64}$/.test(message.content.attachment.fingerprint)))
  ) {
    throw new Error('matrix_recovery_untrusted')
  }

  const requestHash = matrixInvocationRequestHash(message)
  const row = (await deps.authorize({ operation: 'recover', ...target, requestHash })) as Record<string, unknown>
  live()

  if (row?.state !== 'completed') {
    return { state: 'unknown' }
  }

  if (
    row.owner !== context.domain.principal ||
    row.roomId !== target.roomId ||
    row.eventId !== target.eventId ||
    row.requestHash !== requestHash ||
    row.senderDevice !== message.senderDevice ||
    !uuid(row.invocationId) ||
    !uuid(row.transactionId) ||
    typeof row.agentUserId !== 'string' ||
    !/^@[^:\s]+:[^\s]+$/.test(row.agentUserId) ||
    typeof row.agentDevice !== 'string' ||
    !row.agentDevice.length ||
    row.agentDevice.length > 255 ||
    (row.publishedEvent !== undefined &&
      (typeof row.publishedEvent !== 'string' || !row.publishedEvent.startsWith('$')))
  ) {
    throw new Error('matrix_recovery_untrusted')
  }

  const binding: MatrixResultBinding = {
    ...target,
    agentUserId: row.agentUserId,
    agentDevice: row.agentDevice,
    invocationId: row.invocationId,
    transactionId: row.transactionId,
    ...(typeof row.publishedEvent === 'string' ? { publishedEvent: row.publishedEvent } : {})
  }

  const result = (await deps.read({ kind: 'readResult', ...binding })) as MatrixRecoveredResult
  live()

  if (result?.state !== 'published' && result?.state !== 'unverified') {
    return { state: 'unknown' }
  }

  // Without a server-recorded publication ID, only positive verified evidence
  // may identify a lost acknowledgement. Imported history is display-only.
  if ((!message.senderVerified || result.state === 'unverified') && !binding.publishedEvent) {
    return { state: 'unknown' }
  }

  if (
    typeof result.eventId !== 'string' ||
    !result.eventId.startsWith('$') ||
    typeof result.body !== 'string' ||
    !result.body.length ||
    // Any message this app sends (MATRIX_MESSAGE_MAX_BYTES): a long answer, or one part of a split one.
    matrixRoomTextTooLong(result.body) ||
    (binding.publishedEvent && result.eventId !== binding.publishedEvent)
  ) {
    throw new Error('matrix_recovery_untrusted')
  }

  return {
    state: message.senderVerified && result.state === 'published' ? 'published' : 'unverified',
    eventId: result.eventId,
    body: result.body
  }
}
