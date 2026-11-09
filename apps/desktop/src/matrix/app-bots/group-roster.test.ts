import { expect, it } from 'vitest'

import type { AppDescriptor } from '../../../shared/app-catalog'
import { groupApps, groupAppState } from '../people'

function botApp(groupsEnabled: boolean): AppDescriptor {
  return {
    app: groupsEnabled ? 'moon' : 'andy', app_id: groupsEnabled ? 'moon-id' : 'andy-id', app_version_id: 'version-id',
    name: { en: groupsEnabled ? 'Moon' : 'Andy' }, subtitle: null, description: null, icon: null, accent: null,
    affiliation: 'first_party', verified: true, availability: 'available', roster_default: true, roster_order: groupsEnabled ? 1 : 2,
    supported_modes: ['direct'], matrix_room_context: 'addressed_only', has_surface: true,
    link: { mode: 'external_account', state: 'linked' },
    bot: {
      v: 1, user_id: `@${groupsEnabled ? 'moon' : 'andy'}:test`, handle: groupsEnabled ? 'moon' : 'andy', display_name: groupsEnabled ? 'Moon' : 'Andy',
      avatar: { url: 'https://cdn.test/app.png', sha256: 'a'.repeat(64) }, device_generation: 1,
      device: { device_id: 'BOT', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) }, state: 'active', groups: groupsEnabled,
      consent: 'accepted', disclosure_version: 1, open_route_id: 'chat', open_shared_memory: false, purchase_route_id: 'chat'
    }
  }
}

it('shows a groups-disabled official app in the picker but keeps it disabled', () => {
  const moon = botApp(true)
  const andy = botApp(false)

  expect(groupApps([moon, andy])).toEqual([moon, andy])
  expect(groupAppState(moon)).toBe('ready')
  expect(groupAppState(andy)).toBe('unavailable')
})

it('lists an official bot whatever the operator-set room context, but not a plain app without one', () => {
  const moon = { ...botApp(true), matrix_room_context: null }
  const plain = { ...botApp(false), app_id: 'plain-id', bot: null, matrix_room_context: null }

  expect(groupApps([moon, plain])).toEqual([moon])
  expect(groupAppState(moon)).toBe('ready')
})
