import type { MatrixClient } from 'matrix-js-sdk'

/**
 * What trusting one person's devices found (plan D6). `trusted`: their cross-signing identity
 * is known and unchanged, and every device it signed is trusted on this device now.
 * `no_identity`: no identity is known for them (yet), so nothing new was trusted.
 * `identity_changed`: their identity changed since this device first saw it, so nothing new is
 * trusted until the person approves it. `count` is how many of their devices this device trusts
 * after the step: the ones a message would reach.
 */
export type CrossSignedTrust =
  | { state: 'trusted'; count: number }
  | { state: 'no_identity'; count: number }
  | { state: 'identity_changed'; count: number }

/**
 * Atum shares room keys only with verified devices (`globalBlacklistUnverifiedDevices`). For the
 * Founder chat (and, on the founder's side, each person's chat with them), this device trusts
 * the other person's devices that their own cross-signing identity signed, and only while that
 * identity is known and unchanged (rust crypto pins the first one it sees). Trust is only ever
 * added (`setDeviceVerified(…, true)`), only for this one user, and the global and per-room
 * blacklists are never touched. A device the server injects is unsigned, and a reset identity
 * needs approval: neither is trusted here.
 */
export async function trustCrossSignedDevices(client: MatrixClient, userId: string): Promise<CrossSignedTrust> {
  const crypto = client.getCrypto()

  if (!crypto) {
    return { state: 'no_identity', count: 0 }
  }

  const devices = await crypto.getUserDeviceInfo([userId], true)
  const identity = await crypto.getUserVerificationStatus(userId)
  const state = !identity.known ? 'no_identity' : identity.needsUserApproval ? 'identity_changed' : 'trusted'
  let count = 0

  for (const deviceId of devices.get(userId)?.keys() ?? []) {
    const status = await crypto.getDeviceVerificationStatus(userId, deviceId)

    if (!status) {
      continue
    }

    if (state === 'trusted' && status.signedByOwner && !status.localVerified) {
      await crypto.setDeviceVerified(userId, deviceId, true)
      count += 1

      continue
    }

    if (status.isVerified()) {
      count += 1
    }
  }

  return { state, count }
}
