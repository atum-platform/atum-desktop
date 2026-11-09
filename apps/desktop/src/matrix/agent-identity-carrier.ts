import { ClientEvent, type MatrixClient } from 'matrix-js-sdk'
import type { ReceivedToDeviceMessage } from 'matrix-js-sdk/lib/sync-accumulator'

import type {
  MatrixAgentIdentityToDeviceEvent,
  MatrixAgentIdentityToDeviceRead,
  MatrixAgentIdentityToDeviceSend
} from '../../shared/matrix-security'

const EVENT_TYPES = new Set<MatrixAgentIdentityToDeviceEvent['type']>([
  'io.atum.agent_identity.request',
  'io.atum.agent_identity.grant',
  'io.atum.agent_identity.escrow',
  'io.atum.agent_identity.escrowed',
  'io.atum.agent_identity.refused'
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const USER = /^@[!-9;-~]+:[!-~]+$/
const DEVICE = /^[!-~]{1,255}$/
const NONCE = /^[A-Za-z0-9_-]{43}$/
const SLOT = /^io\.atum\.agent-recovery\.[A-Za-z0-9_-]{1,1072}$/
const RECOVERY_KEY = /^[A-Za-z0-9 ]{1,256}$/
const MAX_PENDING = 32
const DEFAULT_READ = 8

export interface MatrixAgentIdentityToDeviceMessage {
  type: MatrixAgentIdentityToDeviceEvent['type']
  content: MatrixAgentIdentityToDeviceEvent['content']
  senderUserId: string
  senderDeviceId: string
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))
const id = (value: unknown) => typeof value === 'string' && UUID.test(value)
const user = (value: unknown) => typeof value === 'string' && value.length <= 1024 && USER.test(value)
const device = (value: unknown) => typeof value === 'string' && DEVICE.test(value)
const nonce = (value: unknown) => typeof value === 'string' && NONCE.test(value)
const expiresAt = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
const recoveryKey = (value: unknown): value is string => typeof value === 'string' && RECOVERY_KEY.test(value)
const slot = (value: unknown) => typeof value === 'string' && value.length >= 23 && value.length <= 1100 && SLOT.test(value)

function validEvent(value: unknown): value is MatrixAgentIdentityToDeviceEvent {
  if (!object(value) || typeof value.type !== 'string' || !EVENT_TYPES.has(value.type as MatrixAgentIdentityToDeviceEvent['type']) || !object(value.content)) {
    return false
  }

  const content = value.content
  const common = content.v === 1 && id(content.enrollmentId) && nonce(content.nonce)

  switch (value.type) {
    case 'io.atum.agent_identity.request':
      return (
        common &&
        hasOnly(content, ['v', 'enrollmentId', 'executorId', 'agentUserId', 'deviceId', 'purpose', 'nonce', 'expiresAt']) &&
        id(content.executorId) && user(content.agentUserId) && device(content.deviceId) &&
        (content.purpose === 'restore' || content.purpose === 'escrow') && expiresAt(content.expiresAt)
      )
    case 'io.atum.agent_identity.grant':
      return common && hasOnly(content, ['v', 'enrollmentId', 'nonce', 'recoveryKey']) && recoveryKey(content.recoveryKey)
    case 'io.atum.agent_identity.escrow':
      return (
        common &&
        hasOnly(content, ['v', 'enrollmentId', 'executorId', 'agentUserId', 'expiresAt', 'nonce', 'slot', 'recoveryKey']) &&
        id(content.executorId) && user(content.agentUserId) && expiresAt(content.expiresAt) && slot(content.slot) && recoveryKey(content.recoveryKey)
      )
    case 'io.atum.agent_identity.escrowed':
      return common && hasOnly(content, ['v', 'enrollmentId', 'nonce', 'slot']) && slot(content.slot)
    case 'io.atum.agent_identity.refused':
      return (
        common &&
        hasOnly(content, ['v', 'enrollmentId', 'nonce', 'reason']) &&
        ['unknown_enrollment', 'wrong_state', 'device_mismatch', 'expired', 'no_key', 'declined', 'recovery_unavailable'].includes(String(content.reason))
      )
    default:
      return false
  }
}

function validRecipient(value: unknown): value is { userId: string; deviceId: string } {
  return object(value) && hasOnly(value, ['userId', 'deviceId']) && user(value.userId) && device(value.deviceId)
}

function validRead(value: unknown): value is MatrixAgentIdentityToDeviceRead {
  return (
    object(value) &&
    value.kind === 'agentIdentityToDeviceRead' &&
    hasOnly(value, ['kind', 'sender', 'limit']) &&
    validRecipient(value.sender) &&
    (value.limit === undefined || (Number.isInteger(value.limit) && (value.limit as number) >= 1 && (value.limit as number) <= MAX_PENDING))
  )
}

/**
 * Fixed, native-only carrier for the cloud identity handoff. It deliberately has no
 * snapshot state: pending messages can contain recovery material and stay only until a
 * trusted main-process handshake consumes them.
 */
export function agentIdentityCarrier(client: MatrixClient) {
  const pending: MatrixAgentIdentityToDeviceMessage[] = []
  let live = true

  const receive = (received: ReceivedToDeviceMessage) => {
    if (!live || !received.encryptionInfo || !EVENT_TYPES.has(received.message.type as MatrixAgentIdentityToDeviceEvent['type'])) {
      return
    }

    const { encryptionInfo, message } = received
    // Never accept clear sender fields as identity: use the SDK's Olm result and require
    // it to agree with the decrypted event envelope. senderVerified is intentionally not
    // required here because this handoff establishes the cloud device's first trust.
    if (!encryptionInfo.sender || !encryptionInfo.senderDevice || message.sender !== encryptionInfo.sender) {
      return
    }

    const event = { type: message.type, content: message.content }

    if (!user(encryptionInfo.sender) || !device(encryptionInfo.senderDevice) || !validEvent(event)) {
      return
    }

    if (pending.length === MAX_PENDING) {
      return
    }

    pending.push({
      type: event.type,
      content: event.content,
      senderUserId: encryptionInfo.sender,
      senderDeviceId: encryptionInfo.senderDevice
    })
  }

  client.on(ClientEvent.ReceivedToDeviceMessage, receive)

  return {
    async generateRecoveryKey(): Promise<string> {
      if (!live) {
        throw new Error('matrix_agent_identity_stopped')
      }

      const generated = await client.getCrypto()!.createRecoveryKeyFromPassphrase()

      try {
        const encodedPrivateKey = generated.encodedPrivateKey

        if (!recoveryKey(encodedPrivateKey)) {
          throw new Error('matrix_agent_identity_invalid')
        }

        return encodedPrivateKey
      } finally {
        generated.privateKey.fill(0)
      }
    },
    async command(command: MatrixAgentIdentityToDeviceSend | MatrixAgentIdentityToDeviceRead): Promise<MatrixAgentIdentityToDeviceMessage[] | null> {
      if (!live) {
        throw new Error('matrix_agent_identity_stopped')
      }

      if (command.kind === 'agentIdentityToDeviceSend') {
        if (!validRecipient(command.recipient) || !validEvent(command.event)) {
          throw new Error('matrix_agent_identity_invalid')
        }

        const batch = await client.getCrypto()!.encryptToDeviceMessages(command.event.type, [command.recipient], command.event.content)

        if (!live) {
          throw new Error('matrix_agent_identity_stopped')
        }

        await client.queueToDevice(batch)

        return null
      }

      if (!validRead(command)) {
        throw new Error('matrix_agent_identity_invalid')
      }

      const limit = command.limit ?? DEFAULT_READ
      const accepted: MatrixAgentIdentityToDeviceMessage[] = []
      const retained: MatrixAgentIdentityToDeviceMessage[] = []

      for (const message of pending) {
        if (
          accepted.length < limit &&
          message.senderUserId === command.sender.userId &&
          message.senderDeviceId === command.sender.deviceId
        ) {
          accepted.push(message)
        } else {
          retained.push(message)
        }
      }

      pending.splice(0, pending.length, ...retained)

      return accepted
    },
    stop() {
      live = false
      pending.splice(0, pending.length)
      client.off(ClientEvent.ReceivedToDeviceMessage, receive)
    }
  }
}
