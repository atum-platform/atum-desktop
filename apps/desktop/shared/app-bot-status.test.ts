import { describe, expect, it } from 'vitest'

import type { AppBotDescriptor } from './app-catalog'
import { appBotGuestReady, appBotGuestState, parseAppBotStatus } from './app-bot-status'

const bot = (guest = true): AppBotDescriptor => ({
  v: 1,
  user_id: '@app-demoza:atumplatform.com',
  handle: 'demoza_bot',
  display_name: 'Demoza',
  avatar: { url: 'https://cdn.test/demoza.png', sha256: 'a'.repeat(64) },
  device_generation: 1,
  device: { device_id: 'SKINEA_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
  state: 'active',
  groups: false,
  consent: 'accepted',
  disclosure_version: 1,
  open_route_id: 'chat',
  open_shared_memory: false,
  purchase_route_id: 'chat',
  guest_enabled: guest,
  direct_profile: guest ? 'atum.turn-memory/2' : 'atum.turn-memory/1'
})

const status = (guest: Record<string, unknown> | undefined) => ({
  profile: 'atum.app-bot-status/1',
  consent: { state: 'required', disclosure_version: 1 },
  link: { state: 'never_linked', ready: false, available: true },
  ...(guest === undefined ? {} : { guest })
})

describe('app bot status', () => {
  it('keeps the linked-only shape and treats a missing guest projection as unsupported', () => {
    const parsed = parseAppBotStatus(status(undefined))

    expect(parsed).not.toBeNull()
    expect(parsed?.guest).toBeUndefined()
    expect(appBotGuestState(bot(false), parsed)).toBe('unsupported')
    expect(appBotGuestState(bot(true), parsed)).toBe('unavailable')
  })

  it('accepts the reviewed guest states and rejects inconsistent ones', () => {
    for (const state of ['start_required', 'ready', 'linked', 'unavailable'] as const) {
      const value = status({ enabled: true, state })
      expect(parseAppBotStatus(state === 'linked'
        ? { ...value, link: { state: 'linked', ready: true, available: true } }
        : value)?.guest).toEqual({ enabled: true, state })
    }

    expect(parseAppBotStatus(status({ enabled: true, state: 'unsupported' }))).toBeNull()
    expect(parseAppBotStatus(status({ enabled: false, state: 'ready' }))).toBeNull()
    expect(parseAppBotStatus(status({ enabled: true, state: 'future' }))).toBeNull()
    expect(parseAppBotStatus({
      ...status({ enabled: true, state: 'linked' }),
      link: { state: 'never_linked', ready: false, available: true }
    })).toBeNull()
    expect(parseAppBotStatus({
      ...status({ enabled: true, state: 'ready' }),
      link: { state: 'linked', ready: true, available: true }
    })).toBeNull()
  })

  it('requires fresh accepted consent and a ready guest state before a guest send', () => {
    const ready = {
      ...status({ enabled: true, state: 'ready' }),
      consent: { state: 'accepted', disclosure_version: 1 }
    }

    expect(appBotGuestReady(parseAppBotStatus(ready), 1)).toBe(true)
    expect(appBotGuestReady(parseAppBotStatus(ready), 2)).toBe(false)
    expect(appBotGuestReady(parseAppBotStatus({ ...ready, guest: { enabled: true, state: 'start_required' } }), 1)).toBe(false)
    expect(appBotGuestReady(parseAppBotStatus({ ...ready, consent: { state: 'required', disclosure_version: 1 } }), 1)).toBe(false)
    expect(appBotGuestReady(null, 1)).toBe(false)
  })
})
