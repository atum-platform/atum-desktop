import type { MatrixReachMac } from '../../shared/matrix-agent-sources'

import type { DeviceServiceRecord } from './device/enrollment'

/** Owner registry is the only source of OTHER Macs' facts; this Mac owns its current permissions. */
export function projectMacFleet(rows: readonly DeviceServiceRecord[], here: MatrixReachMac | undefined, now = Date.now()): MatrixReachMac[] {
  const macs = rows.filter(row => row.state === 'active').map((row): MatrixReachMac => {
    const seen = row.presence ? { lastSeenAt: row.presence.lastSeenAt } : {}

    if (row.deviceServiceId === here?.id) {return { ...here, name: row.displayName, ...seen }}
    const online = row.presence?.connected === true && row.presence.lastSeenAt <= now + 5_000 && now - row.presence.lastSeenAt < 90_000

    return { id: row.deviceServiceId, name: row.displayName, thisMac: false, ...seen,
      state: !row.presence ? 'not_connected' : !online ? 'offline' : row.sourceProtocol !== 1 || !row.sources ? 'older' :
        Object.values(row.sources).includes('needs_permission') ? 'needs_permission' : 'ready',
      ...(row.sources ? { sources: { ...row.sources } } : {}) }
  })

  // A local installation not yet enrolled still has the existing Connect affordance.
  if (here && !macs.some(mac => mac.id === here.id)) {macs.unshift({ ...here, state: 'not_connected' })}

  return macs
}
