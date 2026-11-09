import { describe, expect, it } from 'vitest'

import moonLook from './__fixtures__/look-pack-v1/fixtures/moon.published.json'
import {
  ANDY_APP_ONBOARDING_DISCLOSURE_VERSION,
  APP_BOT_DISCLOSURE_VERSION,
  APP_BOT_HISTORY_DISCLOSURE_VERSION,
  APP_CATALOG_PROFILE,
  appBotDisclosureVersion,
  appCatalogNames,
  appLocalizedCopy,
  MOON_APP_ONBOARDING_DISCLOSURE_VERSION,
  parseAppCatalog,
  parseAppDescriptor,
  usesContainedAppOnboarding
} from './app-catalog'
import { ACME, ACME_GUEST, botAppWire, Demoza } from './app-catalog.test-support'

const river = {
  app: 'river',
  app_id: '00000000-0000-4000-8000-11e594f48195',
  app_version_id: '00000000-0000-4000-8000-e79acd97ac88',
  name: { en: 'River', vi: 'Sông' },
  subtitle: { en: 'A neutral third provider' },
  description: { en: 'Explore the current.' },
  icon: { url: 'https://cdn.atum.test/river.png', sha256: 'a'.repeat(64) },
  accent: '#12A4DE',
  affiliation: 'partner',
  verified: true,
  availability: 'available',
  roster_default: true,
  roster_order: 0,
  supported_modes: ['direct'],
  has_surface: true,
  link: { mode: 'none', state: 'never_linked' }
}

const vneid = {
  app: 'vneid',
  app_id: '00000000-0000-4000-8000-a1d6ab74e541',
  app_version_id: '00000000-0000-4000-8000-ad81de9d518d',
  name: { en: 'VNeID', vi: 'VNeID' },
  subtitle: null,
  description: null,
  icon: {
    url: 'https://cdn.atum.test/specialists/vneid.png',
    sha256: '154c855bc0d19febb5ab42eb883443ce0f51c5c8b6d3f09e75a3af831385b643'
  },
  accent: null,
  affiliation: null,
  verified: false,
  verification: null,
  availability: 'unavailable',
  roster_default: true,
  roster_order: 6,
  roster_state: 'coming_soon',
  supported_modes: [],
  matrix_room_context: null,
  bot: null,
  has_surface: false,
  has_history: false,
  link: { mode: 'none', state: 'never_linked' }
}

const riverBot = {
  v: 1,
  user_id: '@app-river:atumplatform.com',
  handle: 'river_bot',
  display_name: 'River',
  avatar: { url: 'https://cdn.atum.test/moon.png', sha256: 'b'.repeat(64) },
  device_generation: 1,
  device: { device_id: 'ATUM_APP_BOT_MOON_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
  state: 'active',
  groups: true,
  consent: 'accepted',
  disclosure_version: 1,
  open_route_id: 'chat',
  open_shared_memory: true,
  purchase_route_id: 'chat'
}

const moonBot = {
  ...riverBot,
  user_id: '@app-moon:atumplatform.com',
  handle: 'moon_bot',
  display_name: 'Moon'
}

describe('app catalog parser', () => {
  it('recognizes only explicit Matrix addressed-only context independently of legacy modes', () => {
    for (const context of [undefined, null, 'shared_group', 'atum.turn-room/2', true, {}]) {
      expect(parseAppDescriptor({ ...river, matrix_room_context: context }).matrix_room_context).toBeNull()
    }
    expect(parseAppDescriptor({ ...river, supported_modes: [], matrix_room_context: 'addressed_only' })).toMatchObject({
      supported_modes: [],
      matrix_room_context: 'addressed_only'
    })
  })
  it('normalizes stable UUIDs and refuses ids which the native preference boundary rejects', () => {
    expect(parseAppDescriptor({ ...river, app_id: '00000000-0000-4000-8000-4BB0C27AA34B' }).app_id).toBe(
      '00000000-0000-4000-8000-4bb0c27aa34b'
    )
    expect(() => parseAppDescriptor({ ...river, app_id: '00000000-0000-0000-0000-000000000001' })).toThrow()
  })
  it('accepts the recognized v1 third-provider projection and ignores future presentation fields', () => {
    const catalog = parseAppCatalog({
      profile: APP_CATALOG_PROFILE,
      apps: [{ ...river, future_presentation: { label: 'ignore me' } }],
      future_root_presentation: true
    })

    expect(catalog.apps[0]).toMatchObject({ app: 'river', affiliation: 'partner', verified: true })
    expect(appLocalizedCopy(catalog.apps[0].name, 'ja')).toBe('River')
    expect(catalog.apps[0].has_history).toBe(false)
    expect(parseAppDescriptor({ ...river, has_history: true }).has_history).toBe(true)
    expect(() => parseAppDescriptor({ ...river, has_history: 'yes' })).toThrow('app_catalog_invalid')
  })

  it('refuses an unsupported profile and malformed trust/presentation facts', () => {
    expect(() => parseAppCatalog({ profile: 'atum.app-catalog/3', apps: [] })).toThrow(
      'app_catalog_profile_unsupported'
    )
    expect(() => parseAppCatalog({ profile: APP_CATALOG_PROFILE, apps: [{ ...river, accent: 'red' }] })).toThrow(
      'app_catalog_invalid'
    )
    expect(() =>
      parseAppCatalog({ profile: APP_CATALOG_PROFILE, apps: [{ ...river, link: { mode: 'none', state: 'linked' } }] })
    ).toThrow('app_catalog_invalid')
    expect(() =>
      parseAppCatalog({
        profile: APP_CATALOG_PROFILE,
        apps: [
          {
            ...river,
            name: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`en-${index + 10}`, 'River']))
          }
        ]
      })
    ).toThrow('app_catalog_invalid')
  })

  it('decodes negotiated catalog v2 with or without its optional look', () => {
    const descriptor = {
      app: river.app,
      app_id: river.app_id,
      app_version_id: river.app_version_id,
      name: river.name,
      subtitle: river.subtitle,
      description: river.description,
      icon: river.icon,
      affiliation: river.affiliation,
      verification: 'verified',
      availability: river.availability,
      roster_default: river.roster_default,
      roster_order: river.roster_order,
      bot: null,
      link: { mode: 'none', state: 'never_linked' },
      chat: {
        direct: false,
        direct_profile: null,
        guest_capable: false,
        linking: 'none',
        addressed_groups: false
      },
      onboarding: { disclosure: { version: 1, digest: 'b'.repeat(64), format: 'atum.disclosure-lines/1' }, intake: [], first_value: null },
      presentation: { future_optional_shape: true, background_pattern: 'gravity-well' },
      actions: [],
      outcome_actions: []
    }

    const without = parseAppCatalog({
      profile: 'atum.app-catalog/2',
      apps: [descriptor],
      omissions_authoritative: true
    })

    expect(without).toMatchObject({ profile: 'atum.app-catalog/2', omissionsAuthoritative: true })
    expect(without.apps[0]).not.toHaveProperty('look')
    expect(JSON.stringify(without)).not.toContain('gravity-well')

    const look = structuredClone(moonLook)
    look.publisher.app_id = river.app_id
    const withLook = parseAppCatalog({
      profile: 'atum.app-catalog/2',
      apps: [{ ...descriptor, look }],
      omissions_authoritative: true
    })

    expect(withLook.apps[0]?.look).toMatchObject({
      pack_id: '00000000-0000-4000-8000-177920da9661',
      chat: { background: { light: { base: '#0E1D60' } } }
    })

    expect(
      parseAppCatalog({
        profile: 'atum.app-catalog/2',
        apps: [{ ...descriptor, look: { profile: 'future' } }],
        omissions_authoritative: true
      }).apps[0]?.look
    ).toBeNull()
  })

  it('requires unique app ids and slugs', () => {
    expect(() =>
      parseAppCatalog({
        profile: APP_CATALOG_PROFILE,
        apps: [river, { ...river, app: 'river-two' }]
      })
    ).toThrow('app_catalog_invalid')
  })

  it("reads the app's verification tier: present, absent and unknown", () => {
    expect(parseAppDescriptor({ ...river, verification: 'official' }).verification).toBe('official')
    expect(parseAppDescriptor({ ...river, verification: 'verified' }).verification).toBe('verified')
    // An older platform sends no tier: no mark, whatever the legacy flag says.
    expect(parseAppDescriptor(river)).toMatchObject({ verified: true, verification: null })
    expect(parseAppDescriptor({ ...river, verification: null }).verification).toBeNull()

    // The platform's own word for no tier, and words this build does not know, draw nothing.
    for (const verification of ['unverified', 'gold', true, { tier: 'official' }]) {
      expect(parseAppDescriptor({ ...river, verification }).verification).toBeNull()
    }

    const catalog = parseAppCatalog({ profile: APP_CATALOG_PROFILE, apps: [{ ...river, verification: 'official' }] })
    expect(catalog.apps[0]?.verification).toBe('official')
  })

  it('exports the same strict descriptor decoder for a workspace companion', () => {
    expect(parseAppDescriptor({ ...river, unknown_optional_presentation: true })).toMatchObject({ app: 'river' })
    expect(() => parseAppDescriptor({ ...river, app_id: 'not-a-uuid' })).toThrow('app_catalog_invalid')
  })

  it('copies an official app-chat identity only when its device facts are complete', () => {
    expect(parseAppDescriptor({ ...river, bot: riverBot }).bot).toMatchObject({
      user_id: '@app-river:atumplatform.com',
      device_generation: 1,
      device: { device_id: 'ATUM_APP_BOT_MOON_1' }
    })
    expect(parseAppDescriptor({ ...river, bot: null }).bot).toBeNull()
    expect(() => parseAppDescriptor({ ...river, bot: { ...riverBot, device_generation: 0 } })).toThrow(
      'app_catalog_invalid'
    )
    expect(() => parseAppDescriptor({ ...river, bot: { ...riverBot, device: null } })).toThrow('app_catalog_invalid')
    expect(() =>
      parseAppDescriptor({ ...river, bot: { ...riverBot, device: { ...riverBot.device, ed25519: 'short' } } })
    ).toThrow('app_catalog_invalid')
  })

  it('reads explicit Bot API transport while absent and unknown values stay on the legacy path', () => {
    expect(parseAppDescriptor({ ...river, bot: { ...riverBot, transport_mode: 'bot_api' } }).bot?.transport_mode).toBe(
      'bot_api'
    )
    expect(parseAppDescriptor({ ...river, bot: riverBot }).bot?.transport_mode).toBe('legacy_turn')
    expect(
      parseAppDescriptor({ ...river, bot: { ...riverBot, transport_mode: 'future_transport' } }).bot?.transport_mode
    ).toBe('legacy_turn')
  })

  it('binds an official bot to the app slug it claims, never an arbitrary @app identity', () => {
    expect(() => parseAppDescriptor({ ...river, bot: { ...riverBot, user_id: '@app-moon:atumplatform.com' } })).toThrow(
      'app_catalog_invalid'
    )
  })

  it('reads the explicit guest capability and refuses inconsistent combinations', () => {
    const guest = { ...river, bot: { ...riverBot, guest_enabled: true, direct_profile: 'atum.turn-memory/2' } }

    expect(parseAppDescriptor(guest).bot).toMatchObject({
      guest_enabled: true,
      direct_profile: 'atum.turn-memory/2'
    })
    // Older catalogs omit both: linked-only v1 stays byte-compatible.
    expect(parseAppDescriptor({ ...river, bot: riverBot }).bot).toMatchObject({
      guest_enabled: false,
      direct_profile: 'atum.turn-memory/1'
    })
    expect(() => parseAppDescriptor({ ...river, bot: { ...riverBot, guest_enabled: true } })).toThrow('app_catalog_invalid')
    expect(() =>
      parseAppDescriptor({ ...river, bot: { ...riverBot, direct_profile: 'atum.turn-memory/2' } })
    ).toThrow('app_catalog_invalid')
    expect(() =>
      parseAppDescriptor({ ...river, bot: { ...riverBot, guest_enabled: true, direct_profile: 'atum.turn-memory/1' } })
    ).toThrow('app_catalog_invalid')
  })

  it('reads the staged Moon 3 and Andy 2 disclosures without activating or guessing a future version', () => {
    const moon = parseAppDescriptor({
      ...river,
      app: 'moon',
      has_history: true,
      bot: { ...moonBot, disclosure_version: MOON_APP_ONBOARDING_DISCLOSURE_VERSION }
    })
    const andy = parseAppDescriptor({
      ...river,
      app: 'andy',
      bot: {
        ...moonBot,
        user_id: '@app-andy:atumplatform.com',
        handle: 'andy_bot',
        display_name: 'Andy',
        groups: false,
        disclosure_version: ANDY_APP_ONBOARDING_DISCLOSURE_VERSION
      }
    })

    expect(usesContainedAppOnboarding(moon)).toBe(true)
    expect(appBotDisclosureVersion(moon)).toBe(MOON_APP_ONBOARDING_DISCLOSURE_VERSION)
    expect(usesContainedAppOnboarding(andy)).toBe(true)
    expect(appBotDisclosureVersion(andy)).toBe(ANDY_APP_ONBOARDING_DISCLOSURE_VERSION)

    expect(appBotDisclosureVersion({ ...moon, bot: { ...moon.bot!, disclosure_version: 4 } })).toBe(
      APP_BOT_HISTORY_DISCLOSURE_VERSION
    )
    expect(appBotDisclosureVersion({ ...andy, bot: { ...andy.bot!, disclosure_version: 3 } })).toBe(
      APP_BOT_DISCLOSURE_VERSION
    )
  })

  it('parses the optional roster state as a closed presentation enum, with absent meaning legacy', () => {
    // Old producers omit it: the reply parses exactly as before and never invents a state.
    expect(parseAppDescriptor(river).roster_state).toBeUndefined()
    expect(JSON.stringify(parseAppDescriptor(river))).not.toContain('roster_state')

    expect(parseAppDescriptor({ ...river, roster_state: 'available' }).roster_state).toBe('available')
    expect(parseAppDescriptor(vneid)).toMatchObject({
      app: 'vneid',
      availability: 'unavailable',
      roster_state: 'coming_soon',
      bot: null,
      has_surface: false,
      link: { mode: 'none', state: 'never_linked' }
    })

    // An unknown presentation key beside it is stripped; the known state still reads.
    expect(parseAppDescriptor({ ...vneid, future_presentation: 'ignore me' }).roster_state).toBe('coming_soon')
  })

  it('refuses malformed roster states and a coming-soon row that claims executable authority', () => {
    for (const roster_state of ['hidden', 'Coming_Soon', '', true, 1, null, {}]) {
      expect(() => parseAppDescriptor({ ...river, roster_state })).toThrow('app_catalog_invalid')
    }

    expect(() => parseAppDescriptor({ ...vneid, availability: 'available' })).toThrow('app_catalog_invalid')
    expect(() => parseAppDescriptor({ ...vneid, has_surface: true })).toThrow('app_catalog_invalid')
    expect(() =>
      parseAppDescriptor({ ...vneid, bot: { ...riverBot, user_id: '@app-vneid:atumplatform.com' } })
    ).toThrow('app_catalog_invalid')
    expect(() => parseAppDescriptor({ ...vneid, supported_modes: ['direct'] })).toThrow('app_catalog_invalid')
    expect(() => parseAppDescriptor({ ...vneid, matrix_room_context: 'addressed_only' })).toThrow('app_catalog_invalid')
    expect(() => parseAppDescriptor({ ...vneid, has_history: true })).toThrow('app_catalog_invalid')
    expect(() => parseAppDescriptor({ ...vneid, link: { mode: 'external_account', state: 'never_linked' } })).toThrow(
      'app_catalog_invalid'
    )
  })

  it('keeps two owners’ effective defaults and order as served bytes, without adding cohort fields', () => {
    const internal = parseAppDescriptor({ ...vneid, roster_default: true, roster_order: 6 })
    const publicOwner = parseAppDescriptor({ ...vneid, roster_default: false, roster_order: 42 })

    expect([internal.roster_default, internal.roster_order, internal.roster_state]).toEqual([true, 6, 'coming_soon'])
    expect([publicOwner.roster_default, publicOwner.roster_order, publicOwner.roster_state]).toEqual([
      false,
      42,
      'coming_soon'
    ])
    // The client never receives or sends a cohort/audience; only these effective values exist.
    expect(JSON.stringify(internal)).not.toMatch(/audience|cohort|policy/iu)
  })
})

describe('an app with an official bot needs no code of its own', () => {
  it('reads the platform projection of an app this client has never heard of', () => {
    expect(parseAppDescriptor(botAppWire(ACME))).toMatchObject({
      app: 'acme',
      app_id: ACME.appId,
      roster_default: true,
      bot: { user_id: '@app-acme:atumplatform.com', state: 'active', guest_enabled: false }
    })
    expect(parseAppDescriptor(botAppWire(ACME_GUEST)).bot).toMatchObject({
      guest_enabled: true,
      direct_profile: 'atum.turn-memory/2'
    })
  })

  it('reads the guest-enabled shape production sends for Demoza', () => {
    expect(parseAppDescriptor(botAppWire(Demoza))).toMatchObject({
      app: 'demoza',
      app_id: '00000000-0000-4000-8000-f8cea4c3b21c',
      roster_default: true,
      roster_order: 5,
      availability: 'available',
      bot: { user_id: '@app-demoza:atumplatform.com', guest_enabled: true, consent: 'required' }
    })
  })

  it('lists the new app beside Moon and Andy without disturbing them', () => {
    const catalog = parseAppCatalog({
      profile: APP_CATALOG_PROFILE,
      apps: [
        botAppWire({ ...ACME, slug: 'moon', name: 'Moon', appId: '00000000-0000-4000-8000-e79acd97ac88' }),
        botAppWire({ ...ACME, slug: 'andy', name: 'Andy', appId: '00000000-0000-4000-8000-993224b4fe85' }),
        botAppWire(ACME_GUEST)
      ]
    })

    expect(catalog.apps.map(app => app.app)).toEqual(['moon', 'andy', 'acme'])
    expect(catalog.apps.map(app => app.bot?.guest_enabled)).toEqual([false, false, true])
  })
})

describe('the names the apps in a catalog go by', () => {
  it('lists each app’s name in every language, its bot’s name and its slug as words, once', () => {
    const catalog = parseAppCatalog({
      profile: APP_CATALOG_PROFILE,
      apps: [
        botAppWire(Demoza, { name: { vi: 'Demoza', en: 'Demoza', ja: 'カタログ' } }, { display_name: 'Demoza Coach' }),
        botAppWire(
          { ...ACME, slug: 'etax-mobile', name: 'eTax Mobile', appId: '00000000-0000-4000-8000-f3e028aaa653' },
          {},
          { handle: 'etax_mobile_bot' }
        )
      ]
    })

    expect(appCatalogNames(catalog.apps)).toEqual([
      'Demoza',
      'カタログ',
      'Demoza Coach',
      'demoza',
      'eTax Mobile',
      'etax mobile'
    ])
  })

  it('is empty for no catalog, and lists an app that has no bot too', () => {
    expect(appCatalogNames(undefined)).toEqual([])
    expect(appCatalogNames(null)).toEqual([])
    expect(appCatalogNames([])).toEqual([])
    expect(appCatalogNames([{ app: 'river', name: { en: ' River ' }, bot: null }])).toEqual(['River', 'river'])
  })
})
