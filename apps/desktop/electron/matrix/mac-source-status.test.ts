import { expect, it } from 'vitest'

import { macSourceStatus, type MatrixReachMac } from '../../shared/matrix-agent-sources'

const mac = (id: string, state: MatrixReachMac['state'], source: 'ready' | 'needs_permission' | 'off' = 'off', thisMac = false): MatrixReachMac => ({
  id, name: id, thisMac, state, sources: { messages: source, browser: source, folders: source, location: source }
})

it.each([
  { name: 'any ready source wins', macs: [mac('here', 'needs_permission', 'needs_permission', true), mac('other', 'ready', 'ready')], expected: { status: 'ready' } },
  { name: 'this Mac permission first', macs: [mac('other', 'needs_permission', 'needs_permission'), mac('here', 'needs_permission', 'needs_permission', true)], expected: { status: 'needs_permission', statusMac: 'here', permission: 'fullDisk' } },
  { name: 'remote permission', macs: [mac('other', 'needs_permission', 'needs_permission')], expected: { status: 'needs_permission', statusMac: 'other', permission: 'fullDisk' } },
  { name: 'older Mac', macs: [mac('old', 'older')], expected: { status: 'update_mac', statusMac: 'old' } },
  { name: 'one offline', macs: [mac('sleeping', 'offline')], expected: { status: 'mac_offline', statusMac: 'sleeping' } },
  { name: 'fleet offline', macs: [mac('a', 'offline'), mac('b', 'offline')], expected: { status: 'mac_offline' } },
  { name: 'this Mac disconnected', macs: [mac('here', 'not_connected', 'off', true)], expected: { status: 'this_mac_disconnected' } },
  { name: 'no Mac', macs: [], expected: { status: 'needs_mac' } }
])('$name', ({ macs, expected }) => {
  expect(macSourceStatus(true, [], macs, 'messages')).toEqual(expected)
})
it('attributes a held-off gate ONLY with server evidence, and only while off', () => {
  const old = [mac('old', 'older')]
  expect(macSourceStatus(false, [], old, 'messages')).toEqual({ status: 'ready' })
  expect(macSourceStatus(false, ['old'], old, 'messages')).toEqual({ status: 'held_off_by_older_mac', heldOffBy: ['old'] })
  expect(macSourceStatus(true, ['old'], [mac('ready', 'ready', 'ready')], 'messages')).toEqual({ status: 'ready' })
})
