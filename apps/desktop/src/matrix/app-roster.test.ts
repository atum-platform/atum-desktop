import { expect, it } from 'vitest'

import type { AppBotDescriptor, AppDescriptor, AppRosterState } from '../../shared/app-catalog'
import type { AppShortcutState } from '../../shared/app-shortcuts'

import { appRoster, appRosterKind, appRosterVisibility } from './app-roster'

function descriptor(n: number, extra: Partial<AppDescriptor> = {}): AppDescriptor {
  return {
    app: `app${n}`,
    app_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    app_version_id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    name: { en: `App ${n}` },
    subtitle: null,
    description: null,
    icon: null,
    accent: null,
    affiliation: null,
    verified: false,
    verification: null,
    availability: 'available',
    roster_default: true,
    roster_order: n,
    supported_modes: [],
    has_surface: true,
    has_history: false,
    link: { mode: 'none', state: 'never_linked' },
    bot: null,
    ...extra
  }
}

function bot(n: number): AppBotDescriptor {
  return {
    v: 1,
    user_id: `@app-app${n}:atumplatform.com`,
    handle: `app${n}_bot`,
    display_name: `App ${n}`,
    avatar: { url: 'https://cdn.test/app.png', sha256: 'a'.repeat(64) },
    device_generation: 1,
    device: { device_id: `APP_${n}`, ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
    state: 'active',
    groups: true,
    consent: 'accepted',
    disclosure_version: 1,
    open_route_id: 'chat',
    open_shared_memory: false,
    purchase_route_id: 'chat'
  }
}

function comingSoon(n: number, extra: Partial<AppDescriptor> = {}): AppDescriptor {
  return descriptor(n, {
    availability: 'unavailable',
    has_surface: false,
    supported_modes: [],
    roster_state: 'coming_soon',
    ...extra
  })
}

const preference = (
  visibility: AppShortcutState['visibility'],
  status: AppShortcutState['status'] = 'ready'
): AppShortcutState => ({ visibility, status })

it('offers addressed-only chat shortcuts without requiring a browser pane or legacy mode', () => {
  const chat = descriptor(0, { has_surface: false, matrix_room_context: 'addressed_only' })
  const shown = { [chat.app_id]: preference('shown') }

  expect(appRoster([chat], shown)).toEqual([chat])
  expect(appRoster([{ ...chat, matrix_room_context: null }], shown)).toEqual([])
  expect(appRoster([{ ...chat, matrix_room_context: null, has_surface: true }], shown)).toHaveLength(1)
})

it('uses one default table for live apps, bots and coming-soon rows', () => {
  const live = descriptor(0, { roster_default: true })
  const appBot = descriptor(1, { bot: bot(1), roster_default: true })
  const placeholder = comingSoon(2, { roster_default: true })
  const noDefault = [live, appBot, placeholder].map(app => ({ ...app, roster_default: false }))

  const ready = (apps: AppDescriptor[]) => Object.fromEntries(apps.map(app => [app.app_id, preference('default')]))

  // A bot no longer bypasses the effective server default: its row must be curated too.
  expect(appRoster([live, appBot], ready([live, appBot])).map(app => app.app_id)).toEqual([live.app_id, appBot.app_id])
  expect(appRoster(noDefault, ready(noDefault))).toEqual([])
  expect(appRoster([placeholder], ready([placeholder]))).toEqual([])
  expect(appRosterKind(placeholder)).toBe('coming_soon')
  expect(appRosterVisibility(placeholder, ready([placeholder])[placeholder.app_id])).toBe('shown')
  expect(appRosterVisibility(placeholder, preference('hidden'))).toBe('hidden')
})

it('keeps explicit Matrix preferences above every server default', () => {
  const live = descriptor(0, { roster_default: false })
  const appBot = descriptor(1, { bot: bot(1), roster_default: false })
  const placeholder = comingSoon(2, { roster_default: false })

  expect(appRosterVisibility(live, preference('shown'))).toBe('shown')
  expect(appRosterVisibility(appBot, preference('shown'))).toBe('shown')
  expect(appRosterVisibility(placeholder, preference('shown'))).toBe('shown')
  expect(appRosterVisibility(placeholder, preference('hidden'))).toBe('hidden')
  expect(appRosterVisibility({ ...live, roster_default: true }, preference('hidden'))).toBe('hidden')
  expect(appRosterVisibility({ ...appBot, roster_default: true }, preference('hidden'))).toBe('hidden')
  expect(appRosterVisibility({ ...live, roster_default: true }, preference('hidden', 'loading'))).toBe('hidden')
  expect(appRosterVisibility(live, preference('shown', 'readonly'))).toBe('shown')
  // Explicit show cannot make an unavailable ordinary app executable.
  expect(appRosterVisibility({ ...live, availability: 'unavailable' }, preference('shown'))).toBe('hidden')
})

it('never guesses a default while the preference is unknown, loading or read-only', () => {
  const live = descriptor(0, { roster_default: true })
  const placeholder = comingSoon(1, { roster_default: true })

  for (const state of [preference('unknown'), preference('default', 'loading'), preference('default', 'readonly')]) {
    expect(appRosterVisibility(live, state)).toBe('hidden')
    expect(appRosterVisibility(placeholder, state)).toBe('hidden')
  }

  expect(appRosterVisibility(live)).toBe('hidden')
  expect(appRosterVisibility(placeholder)).toBe('hidden')
})

it('does not cap rows the server explicitly defaulted', () => {
  const apps = Array.from({ length: 8 }, (_, n) => descriptor(n))
  const ready = Object.fromEntries(apps.map(app => [app.app_id, preference('default')]))

  expect(appRoster(apps, ready).map(app => app.app_id)).toEqual(apps.map(app => app.app_id))
  expect(
    appRoster(
      apps.map(app => ({ ...app, roster_default: false })),
      { [apps[5]!.app_id]: preference('shown') }
    ).map(app => app.app_id)
  ).toEqual([apps[5]!.app_id])
})

it('applies a server default toggle to the same binary while leaving the person preference byte-identical', () => {
  const userDefault = { [descriptor(0).app_id]: preference('default') }
  const before = structuredClone(userDefault)
  const shown = descriptor(0, { roster_default: true })
  const hidden = descriptor(0, { roster_default: false })

  expect(appRoster([shown], userDefault)).toHaveLength(1)
  expect(appRoster([hidden], userDefault)).toEqual([])
  expect(userDefault).toEqual(before)

  const override = { [shown.app_id]: preference('shown') }
  expect(appRoster([hidden], override)).toHaveLength(1)
  expect(appRoster([shown], override)).toHaveLength(1)
  expect(override).toEqual({ [shown.app_id]: preference('shown') })

  const pinnedHidden = { [shown.app_id]: preference('hidden') }
  expect(appRoster([shown], pinnedHidden)).toEqual([])
  expect(pinnedHidden).toEqual({ [shown.app_id]: preference('hidden') })
})

it('treats coming-soon as a presentation state independent of executable availability', () => {
  const availableLegacy = descriptor(0)
  const markedAvailable: AppDescriptor = { ...availableLegacy, roster_state: 'available' as AppRosterState }

  expect(appRosterKind(availableLegacy)).toBe('live')
  expect(appRosterKind(markedAvailable)).toBe('live')
  expect(appRosterVisibility(markedAvailable, preference('default'))).toBe('shown')

  const placeholder = comingSoon(1)
  // Even an explicit show cannot turn a hand-built non-inert coming-soon row into presentation.
  expect(appRosterVisibility({ ...placeholder, has_surface: true }, preference('shown'))).toBe('hidden')
  expect(appRosterVisibility({ ...placeholder, bot: bot(1) }, preference('shown'))).toBe('hidden')
})
