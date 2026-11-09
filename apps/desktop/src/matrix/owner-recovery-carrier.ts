import { ClientEvent, type MatrixClient, type SendToDeviceContentMap } from 'matrix-js-sdk'
import type { ReceivedToDeviceMessage } from 'matrix-js-sdk/lib/sync-accumulator'

import type {
  MatrixOwnerRecoveryChannelOpen,
  MatrixOwnerRecoveryDrop,
  MatrixOwnerRecoveryDropReason,
  MatrixOwnerRecoveryDropsRead,
  MatrixOwnerRecoveryEvent,
  MatrixOwnerRecoveryMessage,
  MatrixOwnerRecoveryToDeviceRead,
  MatrixOwnerRecoveryToDeviceSend
} from '../../shared/matrix-security'

/**
 * The person's recovery key, moved from one of their devices to another they just approved
 * ( WS-C), end-to-end encrypted to that one device.
 *
 * Two messages, both between one person's own devices: the new device asks the device it has
 * just verified with (`io.atum.owner_recovery.request`, a one-time nonce, no secret), and that
 * device answers once (`io.atum.owner_recovery.grant`, the key bound to the nonce).
 *
 * Only what the SDK decrypted counts, and only from a device this one has verified
 * (`senderVerified`: the comparison the person just made), from the same person: a server can
 * neither forge nor read either message. Unlike the agent identity carrier, a sender that is not
 * verified is never accepted here. Nothing is kept in a snapshot; pending messages wait only for
 * main to read them.
 *
 * Opening the channel (`ownerRecoveryChannelOpen`): the first encrypted message between two
 * devices needs an Olm session, and a session started by each device at the same moment can leave
 * one of them unable to read the other, with the SDK unwedging it only once the session is an
 * hour old. After a comparison both devices start one at the same instant (the new device with its
 * key request, the approving device answering the secrets the SDK shares after any verification),
 * so the new device opens the channel while the person is still comparing, and nothing is asked
 * until it exists on both sides.
 *
 * A dropped message leaves only its reason (a closed code, `ownerRecoveryDrops`), so main can log
 * why a handoff went quiet: never the message, its sender or its device.
 */
const EVENT_TYPES = new Set<MatrixOwnerRecoveryEvent['type']>([
  'io.atum.owner_recovery.request',
  'io.atum.owner_recovery.grant'
])

const USER = /^@[!-9;-~]+:[!-~]+$/
const DEVICE = /^[!-~]{1,255}$/
const NONCE = /^[A-Za-z0-9_-]{43}$/
/** The comparison's transaction ID (the SDK's, any printable ASCII without spaces). */
const TXN = /^[!-~]{1,255}$/
const RECOVERY_KEY = /^[A-Za-z0-9 ]{1,256}$/
const KEY_ID = /^[!-~]{1,255}$/
const MAX_PENDING = 32
/** Drops older than this are not reported: they belong to an earlier handoff. */
const DROP_WINDOW_MS = 10 * 60 * 1000
const MAX_DROPS = 64

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(key => keys.includes(key))

function validEvent(value: unknown): value is MatrixOwnerRecoveryEvent {
  if (!object(value) || !EVENT_TYPES.has(value.type as MatrixOwnerRecoveryEvent['type']) || !object(value.content)) {
    return false
  }

  const content = value.content

  const common =
    content.v === 1 &&
    typeof content.nonce === 'string' &&
    NONCE.test(content.nonce) &&
    typeof content.txn === 'string' &&
    TXN.test(content.txn)

  if (value.type === 'io.atum.owner_recovery.request') {
    return common && hasOnly(content, ['v', 'nonce', 'txn'])
  }

  return (
    common &&
    hasOnly(content, ['v', 'nonce', 'txn', 'recoveryKey', 'keyId']) &&
    typeof content.recoveryKey === 'string' &&
    RECOVERY_KEY.test(content.recoveryKey) &&
    typeof content.keyId === 'string' &&
    KEY_ID.test(content.keyId)
  )
}

function validDevice(value: unknown): value is { userId: string; deviceId: string } {
  return (
    object(value) &&
    hasOnly(value, ['userId', 'deviceId']) &&
    typeof value.userId === 'string' &&
    value.userId.length <= 1024 &&
    USER.test(value.userId) &&
    typeof value.deviceId === 'string' &&
    DEVICE.test(value.deviceId)
  )
}

/**
 * Why a received owner-recovery message is not accepted, or `undefined` when it is: decrypted by
 * the SDK, from this same person, from another of their devices this one has verified, and the
 * envelope agrees with the Olm result.
 */
function dropReason(
  received: ReceivedToDeviceMessage,
  me: string | null,
  myDevice: string | null
): MatrixOwnerRecoveryDropReason | undefined {
  const { encryptionInfo, message } = received

  if (!encryptionInfo) {
    return 'not_encrypted'
  }

  if (!encryptionInfo.senderVerified) {
    return 'unverified_sender'
  }

  if (!encryptionInfo.sender || !encryptionInfo.senderDevice) {
    return 'unknown_sender'
  }

  if (encryptionInfo.sender !== me || message.sender !== me) {
    return 'other_person'
  }

  if (encryptionInfo.senderDevice === myDevice) {
    return 'own_device'
  }

  return validEvent({ type: message.type, content: message.content }) && DEVICE.test(encryptionInfo.senderDevice)
    ? undefined
    : 'invalid'
}

export function ownerRecoveryCarrier(client: MatrixClient, now: () => number = Date.now) {
  const pending: MatrixOwnerRecoveryMessage[] = []
  const drops: Array<{ reason: MatrixOwnerRecoveryDropReason; at: number }> = []
  let live = true

  const dropped = (reason: MatrixOwnerRecoveryDropReason) => {
    if (drops.length === MAX_DROPS) {
      drops.shift()
    }

    drops.push({ reason, at: now() })
  }

  const receive = (received: ReceivedToDeviceMessage) => {
    if (!live || !EVENT_TYPES.has(received.message.type as MatrixOwnerRecoveryEvent['type'])) {
      return
    }

    const { encryptionInfo, message } = received
    const reason = dropReason(received, client.getUserId(), client.getDeviceId())

    if (reason || !encryptionInfo?.senderDevice) {
      dropped(reason ?? 'unknown_sender')

      return
    }

    const event = { type: message.type, content: message.content } as MatrixOwnerRecoveryEvent

    // A device asks again until it is answered: when full, the oldest message goes, never the
    // newest.
    if (pending.length === MAX_PENDING) {
      pending.shift()
      dropped('overflow')
    }

    pending.push({
      type: event.type,
      content: event.content,
      senderDeviceId: encryptionInfo.senderDevice,
      receivedAt: now()
    } as MatrixOwnerRecoveryMessage)
  }

  client.on(ClientEvent.ReceivedToDeviceMessage, receive)

  const deliver = async (
    type: string,
    recipient: { userId: string; deviceId: string },
    content: Record<string, unknown>
  ) => {
    const batch = await client.getCrypto()!.encryptToDeviceMessages(type, [recipient], content)

    if (!live) {
      throw new Error('matrix_owner_recovery_stopped')
    }

    // The SDK's queue resolves after persistence, not delivery. This handoff has its own
    // nonce-bound retry loop and exactly one recipient, so wait for homeserver acceptance instead of
    // reporting a key as sent while a queue drain is still detached.
    const messages: SendToDeviceContentMap = new Map()

    for (const message of batch.batch) {
      const devices = messages.get(message.userId) ?? new Map()
      devices.set(message.deviceId, message.payload)
      messages.set(message.userId, devices)
    }

    await client.sendToDevice(batch.eventType, messages)
  }

  return {
    async command(
      command:
        | MatrixOwnerRecoveryToDeviceSend
        | MatrixOwnerRecoveryChannelOpen
        | MatrixOwnerRecoveryToDeviceRead
        | MatrixOwnerRecoveryDropsRead
    ): Promise<MatrixOwnerRecoveryMessage[] | MatrixOwnerRecoveryDrop[] | null> {
      if (!live) {
        throw new Error('matrix_owner_recovery_stopped')
      }

      if (command.kind === 'ownerRecoveryDrops') {
        const since = now() - DROP_WINDOW_MS
        const counts = new Map<MatrixOwnerRecoveryDropReason, number>()

        for (const drop of drops.splice(0, drops.length)) {
          if (drop.at >= since) {
            counts.set(drop.reason, (counts.get(drop.reason) ?? 0) + 1)
          }
        }

        return [...counts].map(([reason, count]) => ({ reason, count }))
      }

      if (command.kind === 'ownerRecoveryToDeviceSend' || command.kind === 'ownerRecoveryChannelOpen') {
        // Only to one of this person's own other devices.
        if (
          !validDevice(command.recipient) ||
          command.recipient.userId !== client.getUserId() ||
          command.recipient.deviceId === client.getDeviceId() ||
          (command.kind === 'ownerRecoveryToDeviceSend' && !validEvent(command.event))
        ) {
          throw new Error('matrix_owner_recovery_invalid')
        }

        if (command.kind === 'ownerRecoveryChannelOpen') {
          await deliver('m.dummy', command.recipient, {})
        } else {
          await deliver(command.event.type, command.recipient, command.event.content)
        }

        return null
      }

      if (!object(command) || typeof command.senderDeviceId !== 'string' || !DEVICE.test(command.senderDeviceId)) {
        throw new Error('matrix_owner_recovery_invalid')
      }

      const accepted = pending.filter(message => message.senderDeviceId === command.senderDeviceId)
      const retained = pending.filter(message => message.senderDeviceId !== command.senderDeviceId)
      pending.splice(0, pending.length, ...retained)

      return accepted
    },
    stop() {
      live = false
      pending.splice(0, pending.length)
      drops.splice(0, drops.length)
      client.off(ClientEvent.ReceivedToDeviceMessage, receive)
    }
  }
}
