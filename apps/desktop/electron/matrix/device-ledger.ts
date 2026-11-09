import { createHash } from 'node:crypto'

import type { MatrixIdentity } from '../../shared/matrix'

/**
 * The public key each of this Mac's own devices had when it was last ready
 * ( WS-E). A device's local encryption store can be
 * lost (Chromium dropped Atum Moon's on a full disk); the SDK then makes new keys under the same
 * device ID, and every other device refuses them for good, so it can neither read new messages
 * nor be trusted. Nothing on screen said so. Comparing the key with the last one seen catches it
 * at once: for the person's own device, the only mend is a new sign-in (a new device; the
 * recovery key kept here unlocks it by itself).
 *
 * Public keys only, by a hash of the account and device.
 */
export interface MatrixDeviceLedgerStore {
  read(): string | null
  write(value: string): void
}

function entry(identity: MatrixIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify(['atum-device-ledger/v1', identity.userId, identity.deviceId]))
    .digest('hex')
}

export class MatrixDeviceLedger {
  constructor(private readonly store: MatrixDeviceLedgerStore) {}

  private load(): Record<string, string> {
    try {
      const value = JSON.parse(this.store.read() ?? '{}') as unknown

      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {}
    } catch {
      return {}
    }
  }

  /**
   * `same` (or `first`, recorded now) when the device still has the key it had; `replaced` when
   * the key changed under the same device ID. Never records a replacement over the old key.
   */
  observe(identity: MatrixIdentity, ed25519: string): 'first' | 'same' | 'replaced' {
    if (typeof ed25519 !== 'string' || !ed25519 || ed25519.length > 128) {
      return 'same'
    }

    const ledger = this.load()
    const key = entry(identity)
    const known = ledger[key]

    if (known === ed25519) {
      return 'same'
    }

    if (known) {
      return 'replaced'
    }

    ledger[key] = ed25519

    try {
      this.store.write(JSON.stringify(ledger))
    } catch {
      // Unrecorded, the next launch records it; never a reason to fail the device.
    }

    return 'first'
  }

  /** A device that is gone (signed out): its entry goes too. */
  forget(identity: MatrixIdentity): void {
    const ledger = this.load()
    const key = entry(identity)

    if (key in ledger) {
      delete ledger[key]

      try {
        this.store.write(JSON.stringify(ledger))
      } catch {
        // Harmless: a device ID is never reused by a new sign-in.
      }
    }
  }
}
