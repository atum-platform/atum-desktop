import { createHash } from 'node:crypto'

import type { MatrixIdentity, MatrixNewSignIn } from '../../shared/matrix'
import type { MatrixOwnDevices } from '../../shared/matrix-security'

/**
 * Devices Atum itself signs in: agent and app principals, and the owner-reader companion the
 * cloud controller runs as this person. They are sessions of Atum, never a person signing in,
 * so the banner must stay quiet for them (G13).
 */
export const MATRIX_NON_HUMAN_DEVICE = /^(?:ATUM_AGENT_|ATUM_APP_BOT_|ATUM_COMPANION_)/iu

/** Where main keeps the banner's ledger (device-trust.json, encrypted by native safeStorage). */
export interface MatrixNewSignInStore {
  read(): string | null
  write(value: string): void
}

interface NewSignInLedgerEntry {
  /** SHA-256 of each device this Mac has already accounted for, never a device ID in the clear. */
  acknowledged: string[]
}

interface NewSignInLedger {
  v: 1
  accounts: Record<string, NewSignInLedgerEntry>
}

export interface MatrixNewSignInDecision {
  alert: MatrixNewSignIn | null
  /** Present only on the first look: every device then existing is the baseline (no storm). */
  baseline?: string[]
}

const LIMIT = 1000
const KEY = /^[a-f0-9]{64}$/u
const PRINTABLE = /^[\x21-\x7e]{1,255}$/u
const CONTROL = /\p{Cc}/gu

const digest = (namespace: string, value: string): string =>
  createHash('sha256')
    .update(JSON.stringify([namespace, value]))
    .digest('hex')

/** The account sign-in a banner belongs to: the person and this Mac's Matrix device. */
export function matrixNewSignInScope(identity: MatrixIdentity): string {
  return `${identity.userId}\n${identity.deviceId}`
}

/** Still the same account sign-in? A switch or a sign-out is a different scope (the banner ends). */
export function matrixNewSignInSameScope(
  shown: string | undefined,
  identity: MatrixIdentity | null | undefined
): boolean {
  return identity != null && shown === matrixNewSignInScope(identity)
}

const accountKey = (identity: MatrixIdentity): string => digest('atum-new-sign-in/v1', matrixNewSignInScope(identity))

const deviceKey = (deviceId: string): string => digest('atum-new-sign-in-device/v1', deviceId)

/** The device's own name, bounded and without control characters; nothing when it has none. */
function displayName(name: string | undefined): string | undefined {
  if (typeof name !== 'string') {
    return undefined
  }

  const value = name.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120)

  return value || undefined
}

/**
 * Which of the person's own devices to raise (G13). `acknowledged: null` means this account has
 * never been looked at on this Mac: every device on the list becomes the baseline, so the first
 * launch (or the release that adds this banner) never storms the owner with old devices. Later,
 * a device that is not the baseline, not acknowledged, not enrolled by Atum and not this Mac is
 * a new sign-in. The most recently active one is shown; dismissals persist by device.
 */
export function matrixNewSignInDevice(input: {
  read: MatrixOwnDevices | null | undefined
  identity: MatrixIdentity
  acknowledged: readonly string[] | null
  excluded?: ReadonlySet<string>
}): MatrixNewSignInDecision {
  const devices = input.read?.devices ?? []
  const excluded = input.excluded ?? new Set<string>()

  if (input.acknowledged === null) {
    return { alert: null, baseline: devices.map(device => deviceKey(device.deviceId)) }
  }

  const acknowledged = new Set(input.acknowledged)

  const device = devices
    .filter(
      candidate =>
        candidate.deviceId !== input.identity.deviceId &&
        PRINTABLE.test(candidate.deviceId) &&
        !excluded.has(candidate.deviceId) &&
        !MATRIX_NON_HUMAN_DEVICE.test(candidate.deviceId) &&
        !acknowledged.has(deviceKey(candidate.deviceId))
    )
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.deviceId.localeCompare(b.deviceId))[0]

  if (!device) {
    return { alert: null }
  }

  const name = displayName(device.name)

  return { alert: { deviceId: device.deviceId, ...(name ? { name } : {}) } }
}

/**
 * What the banner should show after a device-list read. A transient failed read (nil) or a list
 * that momentarily comes back empty never hides a notice the person has not answered; the next
 * device-list change looks again. Only a dismissal (`settled`) may clear the banner when the read
 * offers nothing else, because the person has answered the notice already.
 */
export function matrixNewSignInView(input: {
  identity: MatrixIdentity | null | undefined
  read: MatrixOwnDevices | null | undefined
  shown: MatrixNewSignIn | undefined
  ledger: MatrixNewSignInLedger
  excluded?: ReadonlySet<string>
  settled?: boolean
}): MatrixNewSignIn | undefined {
  const { identity, read } = input

  if (!identity || !read) {
    return input.settled ? undefined : input.shown
  }

  if (input.shown && !input.settled && read.devices.length === 0) {
    return input.shown
  }

  return input.ledger.observe(identity, read, input.excluded) ?? undefined
}

/**
 * Persists the baseline and dismissals per account sign-in. The in-memory copy leads so a full
 * disk never brings back a banner the person dismissed in this run; the encrypted store keeps it
 * across restarts.
 */
export class MatrixNewSignInLedger {
  private memory: string | null = null

  constructor(private readonly store: MatrixNewSignInStore | undefined) {}

  private load(): NewSignInLedger {
    let raw = this.memory

    if (raw === null) {
      try {
        raw = this.store?.read() ?? null
      } catch {
        raw = null
      }
    }

    try {
      const value = JSON.parse(raw ?? '{}') as unknown
      const accounts: Record<string, NewSignInLedgerEntry> = {}

      const rawAccounts =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as { accounts?: unknown }).accounts
          : undefined

      if (rawAccounts && typeof rawAccounts === 'object' && !Array.isArray(rawAccounts)) {
        for (const [key, entry] of Object.entries(rawAccounts as Record<string, unknown>)) {
          if (!KEY.test(key) || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
            continue
          }

          const acknowledged = (entry as { acknowledged?: unknown }).acknowledged

          // A partly corrupt entry is dropped whole: an empty baseline would make every
          // existing device look new on the next read.
          if (!Array.isArray(acknowledged) || !acknowledged.every(item => typeof item === 'string' && KEY.test(item))) {
            continue
          }

          accounts[key] = { acknowledged: acknowledged.slice(0, LIMIT) }
        }
      }

      return { v: 1, accounts }
    } catch {
      return { v: 1, accounts: {} }
    }
  }

  private save(ledger: NewSignInLedger): void {
    const value = JSON.stringify(ledger)
    this.memory = value

    try {
      this.store?.write(value)
    } catch {
      // The run's copy is the truth until it lands; a later dismissal writes again.
    }
  }

  /** The device to raise, recording the baseline on the account's first look. */
  observe(
    identity: MatrixIdentity,
    read: MatrixOwnDevices | null | undefined,
    excluded?: ReadonlySet<string>
  ): MatrixNewSignIn | null {
    const ledger = this.load()
    const key = accountKey(identity)
    const entry = ledger.accounts[key]

    const decision = matrixNewSignInDevice({
      read,
      identity,
      acknowledged: entry ? entry.acknowledged : null,
      excluded
    })

    if (decision.baseline) {
      ledger.accounts[key] = { acknowledged: decision.baseline.slice(-LIMIT) }
      this.save(ledger)
    }

    return decision.alert
  }

  /** Dismissing the banner accounts for that device; it never raises again for this sign-in. */
  acknowledge(identity: MatrixIdentity, deviceId: string): void {
    if (!PRINTABLE.test(deviceId)) {
      return
    }

    const ledger = this.load()
    const key = accountKey(identity)
    const entry = ledger.accounts[key] ?? { acknowledged: [] }
    const value = deviceKey(deviceId)

    if (entry.acknowledged.includes(value)) {
      return
    }

    ledger.accounts[key] = { acknowledged: [...entry.acknowledged, value].slice(-LIMIT) }
    this.save(ledger)
  }
}
