import { describe, expect, it, vi } from 'vitest'

import type { AppBotDescriptor } from '../../../shared/app-catalog'

import { appBotPinFailure, appBotTrustState, isHistoricalAppBotDevice, pinAppBotDevice } from './trust'

const bot: AppBotDescriptor = {
  v: 1, user_id: '@app-moon:atumplatform.com', handle: 'moon_bot', display_name: 'Moon',
  avatar: { url: 'https://cdn.test/moon.png', sha256: 'a'.repeat(64) }, device_generation: 2,
  device: { device_id: 'ATUM_APP_BOT_MOON_2', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
  state: 'active', groups: true, consent: 'accepted', disclosure_version: 1,
  open_route_id: 'chat', open_shared_memory: true, purchase_route_id: 'chat'
}

describe('app bot device trust', () => {
  it('refuses an active bot until the exact catalog device is pinned', () => {
    expect(appBotTrustState(bot, null)).toBe('untrusted')
    expect(appBotTrustState(bot, { generation: 2, deviceId: 'ATUM_APP_BOT_MOON_2', fingerprint: bot.device!.ed25519, curve25519: bot.device!.curve25519, retired: [] })).toBe('active')
    expect(appBotTrustState({ ...bot, state: 'paused' }, null)).toBe('paused')
  })

  it('pins a newer device, retires every other listed bot device, and rotates every bot room', async () => {
    const command = vi.fn(async (_command: unknown) => null)
    const write = vi.fn(async () => {})
    command.mockImplementation(async ({ kind }: { kind: string }) => kind === 'devices'
      ? [
          { userId: bot.user_id, deviceId: 'ATUM_APP_BOT_MOON_1', fingerprint: 'old' },
          { userId: bot.user_id, deviceId: 'ATUM_APP_BOT_MOON_STALE', fingerprint: 'stale' },
          { userId: bot.user_id, deviceId: bot.device!.device_id, fingerprint: bot.device!.ed25519 }
        ]
      : null)
    const record = await pinAppBotDevice('moon', bot, { command, botRoomIds: async () => ['!one:test', '!two:test'] }, {
      read: async () => ({ generation: 1, deviceId: 'ATUM_APP_BOT_MOON_1', fingerprint: 'old', curve25519: 'oldcurve', retired: [] }), write
    }, 100)

    expect(command).toHaveBeenNthCalledWith(1, { kind: 'verify', userId: bot.user_id, deviceId: bot.device!.device_id, fingerprint: bot.device!.ed25519 })
    expect(command).toHaveBeenCalledWith({ kind: 'retireDevice', userId: bot.user_id, deviceId: 'ATUM_APP_BOT_MOON_1' })
    expect(command).toHaveBeenCalledWith({ kind: 'retireDevice', userId: bot.user_id, deviceId: 'ATUM_APP_BOT_MOON_STALE' })
    expect(command).toHaveBeenCalledWith({ kind: 'rotateOutboundKeys', roomId: '!one:test' })
    expect(record.retired).toEqual([
      { deviceId: 'ATUM_APP_BOT_MOON_1', fingerprint: 'old', curve25519: 'oldcurve', retiredAt: 100 },
      { deviceId: 'ATUM_APP_BOT_MOON_STALE', fingerprint: 'stale', curve25519: null, retiredAt: 100 }
    ])
    expect(write).toHaveBeenCalledWith('moon', record)
  })

  it('rejects catalog rollback and treats retired-device messages as historical only', async () => {
    await expect(pinAppBotDevice('moon', { ...bot, device_generation: 1 }, { command: async () => null, botRoomIds: async () => [] }, {
      read: async () => ({ generation: 2, deviceId: bot.device!.device_id, fingerprint: bot.device!.ed25519, curve25519: bot.device!.curve25519, retired: [] }), write: async () => {}
    })).rejects.toThrow('app_bot_generation_rollback')
    const record = { generation: 2, deviceId: 'new', fingerprint: 'new', curve25519: 'curve', retired: [{ deviceId: 'old', fingerprint: 'old', curve25519: 'oldcurve', retiredAt: 100 }] }
    expect(isHistoricalAppBotDevice(record, 'old', 99)).toBe(true)
    expect(isHistoricalAppBotDevice(record, 'old', 100)).toBe(false)
  })

  it('refuses a changed fingerprint at the same device generation', async () => {
    await expect(pinAppBotDevice('moon', { ...bot, device: { ...bot.device!, ed25519: 'c'.repeat(43) } }, { command: async () => null, botRoomIds: async () => [] }, {
      read: async () => ({ generation: 2, deviceId: bot.device!.device_id, fingerprint: bot.device!.ed25519, curve25519: bot.device!.curve25519, retired: [] }), write: async () => {}
    })).rejects.toThrow('app_bot_generation_conflict')
  })

  it('refuses a changed encryption key before verification or pin replacement', async () => {
    const command = vi.fn(async () => null)
    const write = vi.fn(async () => {})
    await expect(pinAppBotDevice('moon', { ...bot, device: { ...bot.device!, curve25519: 'c'.repeat(43) } }, { command, botRoomIds: async () => [] }, {
      read: async () => ({ generation: 2, deviceId: bot.device!.device_id, fingerprint: bot.device!.ed25519, curve25519: bot.device!.curve25519, retired: [] }), write
    })).rejects.toThrow('app_bot_generation_conflict')
    expect(command).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('tells the person a device it cannot pin is untrusted, from the pin itself', async () => {
    // A catalog fingerprint the SDK does not download (the SDK's own refusal) ...
    const mismatch = await pinAppBotDevice('moon', bot, {
      command: async () => { throw new Error('matrix_fingerprint_mismatch') }, botRoomIds: async () => []
    }, { read: async () => null, write: async () => {} }).catch(error => appBotPinFailure(error, bot))

    expect(mismatch).toEqual(new Error('matrix_app_bot_untrusted'))

    // ... or a rollback below this Mac's pin.
    const rollback = await pinAppBotDevice('moon', { ...bot, device_generation: 1 }, { command: async () => null, botRoomIds: async () => [] }, {
      read: async () => ({ generation: 2, deviceId: bot.device!.device_id, fingerprint: bot.device!.ed25519, curve25519: bot.device!.curve25519, retired: [] }),
      write: async () => {}
    }).catch(error => appBotPinFailure(error, bot))

    expect(rollback).toEqual(new Error('matrix_app_bot_untrusted'))
  })

  it('says why a bot that stopped being active cannot be pinned, and keeps other failures as they are', () => {
    expect(appBotPinFailure(new Error('app_bot_not_active'), { ...bot, state: 'paused' })).toEqual(new Error('matrix_app_bot_paused'))
    const store = new Error('app_bot_trust_store_unavailable')
    expect(appBotPinFailure(store, bot)).toBe(store)
  })
})
