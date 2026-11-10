import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../packages/device-protocol/fixtures/${name}`, import.meta.url), 'utf8'))

it('projects the real reads-disabled advertisement into native FDA status and unknown peer presence', async () => {
  const { nativeMacSourceStatus, MacSourceReadiness } = await import('./mac-sources/readiness')
  const { MatrixAgentSourceSettings } = await import('./agent-source-settings')
  const { projectMacFleet } = await import('./mac-fleet')
  const row = (id: string, extra: Record<string, unknown> = {}) => ({ ...fixture('device-fleet/fixtures/record-fleet.json'), deviceServiceId: id, ...extra })
  const consent = { google: true, messages: true, browser: true, folders: true, location: true, teamSpaces: true }
  const advertised = new MacSourceReadiness().snapshot(consent, 'not-granted', false, 100_000)
  expect(Object.values(advertised).every(value => value === 'off')).toBe(true)
  const macs = projectMacFleet([row('A', { sources: advertised, presence: { connected: true, lastSeenAt: 100_000 } }), row('unknown', { presence: undefined })], {
    id: 'A', name: 'This Mac', thisMac: true, state: 'needs_permission', sources: nativeMacSourceStatus(consent, 'not-granted')
  }, 100_001)
  const settings = new MatrixAgentSourceSettings({ scope: () => ({ accountKey: 'account', generation: 1 }),
    gates: () => ({ ...consent, team_spaces: true }), facts: () => ({ mac: true, fullDisk: 'not-granted', googleConnected: true }),
    macs: () => macs, commit: () => { throw new Error('read-only fixture') }, sync: () => {} })
  const view = await settings.read()
  expect(view.sources.find(source => source.optOutGate === 'messages')).toMatchObject({ status: 'needs_permission', permission: 'fullDisk' })
  expect(view.macs.find(mac => mac.id === 'unknown')?.state).toBe('not_connected')
  expect(view.macs.some(mac => mac.state === 'offline')).toBe(false)
})
