/**
 * Origin assertions (S1 WS-3b; contract `atum.cloud-answering/1` §3.2, build plan §3.2).
 *
 * A message typed in Atum on this Mac to an agent that answers in the cloud carries, inside the
 * owner's message content under `io.atum.origin`, an assertion signed by this Mac's device
 * identity key: which device service, enrollment and account epoch, this boot, a fresh nonce, the
 * owner, agent, room, the owner's Matrix device and its fingerprint, and the request digest v2 of
 * the whole content. The controller verifies it (WS-3a) and then routes the turn's tools to this
 * Mac by default.
 *
 * After the chat server acknowledges the send, the device logs `{assertionHash, roomId, eventId}`
 * in its own encrypted store. Device admission step 9 (WS-4) checks a `TurnGrant`'s
 * `(roomId, eventId, originAssertionHash)` against this log (`matches`), so a controller can never
 * reuse a genuine assertion for another event. The device also sends a signed `OriginReceipt` when
 * connected, for the controller's audit; that receipt is never an admission requirement.
 *
 * An assertion is minted once per question and reused for every re-send of the same transaction
 * (the chat server deduplicates by transaction, so the event keeps the first content), unless it is
 * too old for the controller's ±300 s window; then a new one is minted and every one minted for the
 * transaction is logged against the event the send returns.
 */
import { randomBytes } from 'node:crypto'

import type { MatrixOriginAssertion } from '../../../shared/matrix'

import {
  b64u,
  type DeviceSigner,
  ORIGIN_CONTENT_KEY,
  originAssertionHash,
  originSignedBytes,
  requestDigestV2
} from './device-key'
import type { DeviceStateStore } from './epochs'

export interface DeviceOriginIdentity {
  deviceServiceId: string
  identityKid: string
  enrollmentEpoch: number
}

/** The owner's Matrix device on this Mac: the one that sends the message. */
export interface DeviceOriginOwner {
  userId: string
  deviceId: string
  /** Its ed25519 fingerprint, Matrix unpadded base64. */
  fingerprint: string
}

export interface OriginReceiptBody {
  assertionHash: string
  roomId: string
  eventId: string
}

export const DEVICE_ORIGIN = {
  /** Reuse an assertion for a re-send while it is well inside the controller's ±300 s window. */
  reuseMs: 240_000,
  /** The controller's nonce window: the log is kept as long. */
  logMs: 7 * 24 * 60 * 60_000,
  logMax: 2048,
  /** A question never acknowledged is forgotten after a day (its turn is long over). */
  pendingMs: 24 * 60 * 60_000,
  pendingMax: 256,
  assertionsPerTransaction: 4,
  /** Receipts are offered for a day; the controller only uses them for audit and recovery. */
  receiptMs: 24 * 60 * 60_000
} as const

const PENDING_KEY = 'device-origin-pending-v1'
const LOG_KEY = 'device-origin-log-v1'

interface PendingOrigin {
  roomId: string
  at: number
  items: { hash: string; assertion: MatrixOriginAssertion }[]
}

interface OriginLogEntry {
  h: string
  r: string
  e: string
  at: number
  /** The receipt reached an open connection. */
  rc?: true
}

const ROOM = /^![!-~]+$/
const EVENT = /^\$[!-~]+$/
const USER = /^@[!-9;-~]+:[!-~]+$/
const DEVICE = /^[!-~]{1,255}$/
const FINGERPRINT = /^[A-Za-z0-9+/]{43}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const KID = /^[A-Za-z0-9_-]{43}$/

export class DeviceOriginError extends Error {
  constructor(readonly code: 'invalid' | 'store_unavailable' | 'signature_failed') {
    super(`device_origin_${code}`)
    this.name = 'DeviceOriginError'
  }
}

export class DeviceOrigin {
  constructor(
    private readonly deps: {
      store: DeviceStateStore
      signer: Pick<DeviceSigner, 'signIdentity'>
      /** The active enrollment, or null: an unenrolled Mac sends no assertion. */
      identity(): DeviceOriginIdentity | null
      accountEpoch(): number
      bootId(): string
      now?(): number
      nonce?(): string
    }
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private read<T>(key: string, fallback: T): T {
    const raw = this.deps.store.getItem(key)

    if (this.deps.store.failureCode()) {
      throw new DeviceOriginError('store_unavailable')
    }

    try {
      return raw ? (JSON.parse(raw) as T) : fallback
    } catch {
      return fallback
    }
  }

  private pending(): Record<string, PendingOrigin> {
    const value = this.read<Record<string, PendingOrigin>>(PENDING_KEY, {})

    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }

  private log(): OriginLogEntry[] {
    const value = this.read<OriginLogEntry[]>(LOG_KEY, [])

    return Array.isArray(value) ? value : []
  }

  private write(entries: { pending?: Record<string, PendingOrigin>; log?: OriginLogEntry[] }): void {
    const now = this.now()
    const values: Record<string, string> = {}

    if (entries.pending) {
      const kept = Object.entries(entries.pending)
        .filter(([, value]) => now - value.at < DEVICE_ORIGIN.pendingMs)
        .sort(([, a], [, b]) => b.at - a.at)
        .slice(0, DEVICE_ORIGIN.pendingMax)

      values[PENDING_KEY] = JSON.stringify(Object.fromEntries(kept))
    }

    if (entries.log) {
      values[LOG_KEY] = JSON.stringify(
        entries.log.filter(entry => now - entry.at < DEVICE_ORIGIN.logMs).slice(-DEVICE_ORIGIN.logMax)
      )
    }

    // One write for both keys: a crash leaves either the pending record or the log entry.
    if (this.deps.store.setItems) {
      this.deps.store.setItems(values)
    } else {
      for (const [key, value] of Object.entries(values)) {
        this.deps.store.setItem(key, value)
      }
    }
  }

  /**
   * The signed assertion for this exact content, sent under `transactionId` to `roomId` for the
   * agent `agentUserId`. Null when this Mac has no active enrollment. `content` is the message as
   * the SDK will send it, without `io.atum.origin`.
   */
  async assert(input: {
    transactionId: string
    roomId: string
    agentUserId: string
    owner: DeviceOriginOwner
    content: Record<string, unknown>
  }): Promise<MatrixOriginAssertion | null> {
    const identity = this.deps.identity()

    if (!identity) {
      return null
    }

    if (
      typeof input.transactionId !== 'string' ||
      !input.transactionId ||
      input.transactionId.length > 255 ||
      !ROOM.test(input.roomId) ||
      input.roomId.length > 1024 ||
      !USER.test(input.agentUserId) ||
      !USER.test(input.owner.userId) ||
      !DEVICE.test(input.owner.deviceId) ||
      !FINGERPRINT.test(input.owner.fingerprint) ||
      !UUID.test(identity.deviceServiceId) ||
      !KID.test(identity.identityKid) ||
      !Number.isSafeInteger(identity.enrollmentEpoch) ||
      identity.enrollmentEpoch < 1 ||
      Object.hasOwn(input.content, ORIGIN_CONTENT_KEY)
    ) {
      throw new DeviceOriginError('invalid')
    }

    const dg = requestDigestV2(input.content)
    const ae = this.deps.accountEpoch()
    const boot = this.deps.bootId()
    const now = this.now()
    const known = this.pending()[input.transactionId]

    const reusable = known?.items
      .map(item => item.assertion)
      .reverse()
      .find(
        assertion =>
          assertion.dg === dg &&
          assertion.room === input.roomId &&
          assertion.agent === input.agentUserId &&
          assertion.owner === input.owner.userId &&
          assertion.dev === input.owner.deviceId &&
          assertion.fpr === input.owner.fingerprint &&
          assertion.dsid === identity.deviceServiceId &&
          assertion.kid === identity.identityKid &&
          assertion.ee === identity.enrollmentEpoch &&
          assertion.ae === ae &&
          assertion.boot === boot &&
          now - assertion.t >= 0 &&
          now - assertion.t < DEVICE_ORIGIN.reuseMs
      )

    if (reusable) {
      return reusable
    }

    const unsigned = {
      v: 1 as const,
      dsid: identity.deviceServiceId,
      kid: identity.identityKid,
      ee: identity.enrollmentEpoch,
      ae,
      boot,
      n: this.deps.nonce?.() ?? b64u(randomBytes(16)),
      t: now,
      owner: input.owner.userId,
      agent: input.agentUserId,
      room: input.roomId,
      dev: input.owner.deviceId,
      fpr: input.owner.fingerprint,
      dg
    }

    const signature = await this.deps.signer.signIdentity(originSignedBytes(unsigned))

    if (signature.kid !== identity.identityKid) {
      throw new DeviceOriginError('signature_failed')
    }

    const assertion: MatrixOriginAssertion = { ...unsigned, sig: signature.sig }
    const hash = originAssertionHash(unsigned)

    // Read again after the await: another question may have been recorded meanwhile.
    const pending = this.pending()
    const record = pending[input.transactionId]

    pending[input.transactionId] = {
      roomId: input.roomId,
      at: this.now(),
      items: [...(record?.roomId === input.roomId ? record.items : []), { hash, assertion }].slice(
        -DEVICE_ORIGIN.assertionsPerTransaction
      )
    }

    this.write({ pending })

    return assertion
  }

  /**
   * The chat server acknowledged the question (`eventId`), or a read-back found it: every assertion
   * minted for this transaction is logged against that event. Returns the receipts to offer the
   * controller. Nothing to log (an unasserted question) returns none.
   */
  sent(transactionId: string, roomId: string, eventId: string): OriginReceiptBody[] {
    if (!ROOM.test(roomId) || !EVENT.test(eventId) || eventId.length > 1024) {
      return []
    }

    const pending = this.pending()
    const record = pending[transactionId]

    if (!record || record.roomId !== roomId) {
      return []
    }

    const at = this.now()
    const log = this.log()
    const added = record.items.filter(item => !log.some(entry => entry.h === item.hash && entry.e === eventId))

    delete pending[transactionId]
    this.write({ pending, log: [...log, ...added.map(item => ({ h: item.hash, r: roomId, e: eventId, at }))] })

    return added.map(item => ({ assertionHash: item.hash, roomId, eventId }))
  }

  /** Admission step 9: this device logged this assertion for exactly this room and event. */
  matches(input: OriginReceiptBody): boolean {
    try {
      return this.log().some(
        entry => entry.h === input.assertionHash && entry.r === input.roomId && entry.e === input.eventId
      )
    } catch {
      return false
    }
  }

  /**
   * The whole log, oldest first: what WS-4's admission reads for step 9 (`originLog()`). Empty when
   * the store cannot be read, so a grant bound to a device origin is refused, never admitted.
   */
  entries(): OriginReceiptBody[] {
    try {
      const now = this.now()

      return this.log()
        .filter(entry => now - entry.at < DEVICE_ORIGIN.logMs)
        .map(entry => ({ assertionHash: entry.h, roomId: entry.r, eventId: entry.e }))
    } catch {
      return []
    }
  }

  /** Receipts not yet offered to the controller, newest last, at most `limit`. */
  unreceipted(limit = 32): OriginReceiptBody[] {
    const now = this.now()

    return this.log()
      .filter(entry => !entry.rc && now - entry.at < DEVICE_ORIGIN.receiptMs)
      .slice(-limit)
      .map(entry => ({ assertionHash: entry.h, roomId: entry.r, eventId: entry.e }))
  }

  /** These receipts went out on an open connection. */
  receipted(receipts: OriginReceiptBody[]): void {
    if (!receipts.length) {
      return
    }

    const log = this.log().map(entry =>
      receipts.some(each => each.assertionHash === entry.h && each.eventId === entry.e)
        ? { ...entry, rc: true as const }
        : entry
    )

    this.write({ log })
  }
}
