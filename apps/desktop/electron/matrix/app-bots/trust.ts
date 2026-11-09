import type { AppBotDescriptor } from '../../../shared/app-catalog'
import type { MatrixSdkCommand } from '../../../shared/matrix'
import { appBotOpenRefusal } from '../../../shared/matrix-app-bot-failure'

export type AppBotTrustState = 'starting' | 'active' | 'paused' | 'unavailable' | 'untrusted'

export interface AppBotTrustRecord {
  generation: number
  deviceId: string
  fingerprint: string
  curve25519: string
  /** A legacy cache may not have the Curve25519 key. It stays retired but can
   * never authenticate historical bot content until the catalog supplies it. */
  retired: Array<{ deviceId: string; fingerprint: string; curve25519: string | null; retiredAt: number }>
}

export interface AppBotTrustPort {
  command(command: MatrixSdkCommand): Promise<unknown>
  /** All encrypted rooms currently containing the bot, read from the human SDK. */
  botRoomIds(userId: string): Promise<string[]>
}

interface ListedDevice {
  userId: string
  deviceId: string
  fingerprint: string
}

function listedBotDevices(value: unknown, userId: string): ListedDevice[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error('app_bot_devices_invalid')
  }

  const devices = value.filter((candidate): candidate is ListedDevice => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return false
    }
    const row = candidate as Record<string, unknown>
    return row.userId === userId &&
      typeof row.deviceId === 'string' && row.deviceId.length > 0 && row.deviceId.length <= 255 &&
      typeof row.fingerprint === 'string' && row.fingerprint.length > 0 && row.fingerprint.length <= 255
  })

  if (devices.length !== value.length || !devices.some(device => device.deviceId)) {
    throw new Error('app_bot_devices_invalid')
  }

  return devices
}

/**
 * Desktop-owned persistence deliberately stores only public device facts.  The
 * platform catalog remains authoritative: a cached record can prevent a
 * rollback but it can never introduce a new device.
 */
export interface AppBotTrustStore {
  read(appId: string): Promise<AppBotTrustRecord | null>
  write(appId: string, record: AppBotTrustRecord): Promise<void>
}

export function appBotTrustState(bot: AppBotDescriptor | null, pinned: AppBotTrustRecord | null): AppBotTrustState {
  if (!bot || bot.state !== 'active') {
    return bot?.state ?? 'unavailable'
  }

  if (!bot.device || !pinned || pinned.generation !== bot.device_generation || pinned.deviceId !== bot.device.device_id) {
    return 'untrusted'
  }

  return 'active'
}

/** A device published at a lower generation can never replace a local pin. */
export function catalogDeviceIsRollback(bot: AppBotDescriptor, pinned: AppBotTrustRecord | null): boolean {
  return Boolean(pinned && bot.device_generation < pinned.generation)
}

/**
 * Pins the catalog's current device and makes the outbound room-key rotation
 * explicit after every retired device.  Verification happens before any invite
 * or send; callers surface `untrusted` when this rejects.
 */
export async function pinAppBotDevice(
  appId: string,
  bot: AppBotDescriptor,
  port: AppBotTrustPort,
  store: AppBotTrustStore,
  now = Date.now()
): Promise<AppBotTrustRecord> {
  if (!bot.device || bot.state !== 'active') {
    throw new Error('app_bot_not_active')
  }

  const existing = await store.read(appId)

  if (catalogDeviceIsRollback(bot, existing)) {
    throw new Error('app_bot_generation_rollback')
  }

  if (
    existing?.generation === bot.device_generation &&
    (existing.deviceId !== bot.device.device_id || existing.fingerprint !== bot.device.ed25519 || existing.curve25519 !== bot.device.curve25519)
  ) {
    throw new Error('app_bot_generation_conflict')
  }

  await port.command({ kind: 'verify', userId: bot.user_id, deviceId: bot.device.device_id, fingerprint: bot.device.ed25519 })

  const retired = [...(existing?.retired ?? [])]

  if (existing && existing.generation < bot.device_generation) {
    const devices = listedBotDevices(await port.command({ kind: 'devices', userId: bot.user_id }), bot.user_id)
    const outgoing = devices.filter(device => device.deviceId !== bot.device!.device_id)

    for (const device of outgoing) {
      await port.command({ kind: 'retireDevice', userId: bot.user_id, deviceId: device.deviceId })
      if (!retired.some(previous => previous.deviceId === device.deviceId && previous.fingerprint === device.fingerprint)) {
        retired.push({
          deviceId: device.deviceId,
          fingerprint: device.fingerprint,
          curve25519: device.deviceId === existing.deviceId ? existing.curve25519 : null,
          retiredAt: now
        })
      }
    }

    for (const roomId of await port.botRoomIds(bot.user_id)) {
      await port.command({ kind: 'rotateOutboundKeys', roomId })
    }
  }

  const record = {
    generation: bot.device_generation,
    deviceId: bot.device.device_id,
    fingerprint: bot.device.ed25519,
    curve25519: bot.device.curve25519,
    retired
  }
  await store.write(appId, record)
  return record
}

/**
 * What a failed pin tells the person (atum-app-bots v1 §2.6): a catalog device that does not
 * match what the SDK downloads, a rollback, a conflicting generation or an unreadable device
 * list all fail closed as `untrusted`. Other failures (a local store, the SDK) keep their code.
 */
export function appBotPinFailure(error: unknown, bot: AppBotDescriptor): unknown {
  const code = error instanceof Error ? error.message : ''

  if (/\b(?:matrix_fingerprint_mismatch|app_bot_generation_rollback|app_bot_generation_conflict|app_bot_devices_invalid)\b/u.test(code)) {
    return new Error('matrix_app_bot_untrusted')
  }

  if (/\bapp_bot_not_active\b/u.test(code)) {
    return new Error(appBotOpenRefusal(bot) ?? 'matrix_app_bot_unavailable')
  }

  return error
}

/** A retained device remains attributable only for messages sent before retirement. */
export function isHistoricalAppBotDevice(record: AppBotTrustRecord, deviceId: string, eventTimestamp: number): boolean {
  return record.deviceId === deviceId || record.retired.some(device => device.deviceId === deviceId && eventTimestamp < device.retiredAt)
}
