/**
 * Test-only catalog fixtures: an app bot exactly as the platform's `atum.app-catalog/1` projection
 * sends it, built from data alone. `ACME` is an app this client has no code for. A test that runs a
 * feature on it proves the feature needs no code per app; `Demoza` is the shape production sends
 * for the first guest-enabled bot (atum-platform migration 0266 and the 2026-10-24 promotion).
 */
import { type AppBotDescriptor, type AppDescriptor, parseAppDescriptor } from './app-catalog'

export interface BotAppSeed {
  slug: string
  name: string
  appId: string
  versionId: string
  /** The reviewed guest capability: `guest_enabled` with the explicit `turn-memory/2` profile. */
  guest: boolean
}

export const ACME: BotAppSeed = {
  slug: 'acme',
  name: 'Acme',
  appId: '00000000-0000-4000-8000-e2f66bfade22',
  versionId: '00000000-0000-4000-8000-b1428d1b7e2c',
  guest: false
}

export const ACME_GUEST: BotAppSeed = { ...ACME, guest: true }

export const Demoza: BotAppSeed = {
  slug: 'demoza',
  name: 'Demoza',
  appId: '00000000-0000-4000-8000-f8cea4c3b21c',
  versionId: '00000000-0000-4000-8000-5561398833a5',
  guest: true
}

export const botUserOf = (seed: Pick<BotAppSeed, 'slug'>) => `@app-${seed.slug}:atumplatform.com`

const SHA = 'f2faeee5'.repeat(8)

/** One catalog entry as it arrives on the wire (before the client's strict parse). */
export function botAppWire(
  seed: BotAppSeed,
  overrides: Record<string, unknown> = {},
  bot: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    app: seed.slug,
    app_id: seed.appId,
    app_version_id: seed.versionId,
    name: { vi: seed.name, en: seed.name },
    subtitle: { vi: `Trò chuyện với ${seed.name}`, en: `Chat with ${seed.name}` },
    description: null,
    icon: { url: `https://api.atumplatform.com/specialists/${seed.slug}.png`, sha256: SHA },
    accent: '#2f6f5e',
    affiliation: 'first_party',
    verified: true,
    verification: 'official',
    availability: 'available',
    roster_default: true,
    roster_order: 5,
    supported_modes: ['direct'],
    matrix_room_context: null,
    has_surface: false,
    has_history: false,
    link: { mode: 'external_account', state: 'never_linked' },
    bot: {
      v: 1,
      user_id: botUserOf(seed),
      handle: `${seed.slug}_bot`,
      display_name: seed.name,
      avatar: { url: `https://api.atumplatform.com/specialists/${seed.slug}-avatar.png`, sha256: SHA },
      device_generation: 1,
      device: { device_id: `${seed.slug.toUpperCase()}_1`, ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
      state: 'active',
      groups: false,
      consent: 'required',
      disclosure_version: 1,
      open_route_id: 'chat',
      open_shared_memory: false,
      purchase_route_id: 'chat',
      guest_enabled: seed.guest,
      direct_profile: seed.guest ? 'atum.turn-memory/2' : 'atum.turn-memory/1',
      ...bot
    },
    ...overrides
  }
}

/** The same entry after the client's strict parse: what main hands the window in the snapshot. */
export function botApp(
  seed: BotAppSeed,
  overrides: Record<string, unknown> = {},
  bot: Record<string, unknown> = {}
): AppDescriptor & { bot: AppBotDescriptor } {
  return parseAppDescriptor(botAppWire(seed, overrides, bot)) as AppDescriptor & { bot: AppBotDescriptor }
}
