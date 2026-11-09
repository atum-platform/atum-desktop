import type { MatrixOwnDevices } from './matrix-security'

/**
 * One of the person's own devices that their identity has not signed (owner finding 1a,
 * 2026-10-06: the phone's Element X session was never verified, so every assistant refused it,
 * silently). Display facts only: its own name and when it was last active. The window offers to
 * verify it (Settings › Privacy & Security › Your devices); the assistants keep refusing it until
 * it is, exactly as before.
 */
export interface MatrixUnverifiedOwnDevice {
  deviceId: string
  name?: string
  lastSeenAt: number
}

/** A device last active longer ago than this is not raised: it is probably a session left
 * behind, which the devices list still shows with its Verify and Sign out. */
export const MATRIX_UNVERIFIED_DEVICE_RECENT_MS = 14 * 24 * 60 * 60_000

/**
 * The person's own devices worth raising, most recently active first: seen recently, not
 * signed by their identity and not verified by hand on this Mac. Only once this Mac trusts the
 * identity itself (`verified`): before that every device reads as unsigned here, and what this
 * Mac needs is to be unlocked, which the window already asks for.
 */
export function matrixUnverifiedOwnDevices(
  read: MatrixOwnDevices | null | undefined,
  now: number
): MatrixUnverifiedOwnDevice[] {
  if (read?.identity !== 'verified') {
    return []
  }

  return read.devices
    .filter(
      device =>
        !device.signedByOwner &&
        !device.crossSigningVerified &&
        !device.locallyVerified &&
        typeof device.lastSeenAt === 'number' &&
        Number.isFinite(device.lastSeenAt) &&
        now - device.lastSeenAt <= MATRIX_UNVERIFIED_DEVICE_RECENT_MS
    )
    .sort((a, b) => b.lastSeenAt! - a.lastSeenAt!)
    .map(device => ({
      deviceId: device.deviceId,
      ...(device.name ? { name: device.name } : {}),
      lastSeenAt: device.lastSeenAt!
    }))
}

/** The calendar day on this Mac ("2026-10-06"): a dismissed reminder or the assistant's line
 * about a device comes back at most once a day. */
export function matrixLocalDay(at: number): string {
  const date = new Date(at)

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-')
}
