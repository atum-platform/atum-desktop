import { expect, it } from 'vitest'

import type { MatrixReachMac } from '../../shared/matrix-agent-sources'

import type { DeviceServiceRecord } from './device/enrollment'
import { projectMacFleet } from './mac-fleet'

const sources = { messages: 'ready', browser: 'needs_permission', location: 'off', folders: 'ready' } as const

const row = (id: string, extra: Partial<DeviceServiceRecord> = {}) => ({ deviceServiceId: id, displayName: id, state: 'active',
  presence: { connected: true, lastSeenAt: 100_000 }, sourceProtocol: 1, sources, ...extra }) as DeviceServiceRecord

it('projects full authenticated fleet readiness, offline/old state and last seen into frozen macs[]', () => {
  const macs = projectMacFleet([row('A'), row('B', { presence: { connected: false, lastSeenAt: 99_000 } }),
    row('old', { sourceProtocol: undefined, sources: undefined }),
    row('expired', { presence: { connected: true, lastSeenAt: 1 } }), row('revoked', { state: 'revoked' })], undefined, 100_001)

  expect(macs).toEqual([
    { id: 'A', name: 'A', thisMac: false, state: 'needs_permission', sources, lastSeenAt: 100_000 },
    { id: 'B', name: 'B', thisMac: false, state: 'offline', sources, lastSeenAt: 99_000 },
    { id: 'old', name: 'old', thisMac: false, state: 'older', lastSeenAt: 100_000 },
    { id: 'expired', name: 'expired', thisMac: false, state: 'offline', sources, lastSeenAt: 1 }
  ])
  expect(projectMacFleet([row('legacy', { presence: undefined, sourceProtocol: undefined, sources: undefined })], undefined)[0]?.state).toBe('not_connected')
})

it('uses current permissions only for this Mac and cannot resurrect a missing enrollment', () => {
  const here: MatrixReachMac = { id: 'A', name: 'local', thisMac: true, state: 'needs_permission', sources: { ...sources, messages: 'needs_permission' } }
  const result = projectMacFleet([row('A'), row('B')], here, 100_001)
  expect(result[0]).toMatchObject({ id: 'A', name: 'A', thisMac: true, sources: { messages: 'needs_permission' } })
  expect(result[1]).toMatchObject({ id: 'B', thisMac: false, sources: { messages: 'ready' } })
  expect(projectMacFleet([], here)[0]?.state).toBe('not_connected')
})
