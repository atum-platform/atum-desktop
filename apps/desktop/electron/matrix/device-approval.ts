import { createHash, randomBytes, randomInt } from 'node:crypto'

import type { MatrixIdentity, MatrixSdkCommand } from '../../shared/matrix'
import {
  MATRIX_OWNER_RECOVERY_DROP_REASONS,
  type MatrixApprovalFailure,
  type MatrixApprovalNumbers,
  type MatrixApprovalView,
  type MatrixOwnDevice,
  type MatrixOwnDevices,
  type MatrixOwnerRecoveryDrop,
  type MatrixOwnerRecoveryMessage,
  type MatrixSecurity,
  type MatrixVerification
} from '../../shared/matrix-security'

/**
 * One tap on another of the person's devices approves a new one
 * ( WS-C).
 *
 * The new device (`request`: it has no recovery key) asks the person's other devices with the
 * standard Matrix verification. An Atum that keeps the key (`approve`) asks the person first
 * ("Yes, it's me": only the device the person is at claims the request, never one left
 * unattended, which would take it from every other device), then starts the SAS comparison and
 * shows three complete decimal candidates: the new device's standard three-value Matrix code,
 * and two decoys that share its first value. The person taps the code on the new device's screen. That match
 * is the security boundary: a plain "yes, it's me" would let whoever controls the server (Atum
 * included) add a device and receive everything after one careless tap. With the complete
 * standard decimal SAS, a server in the middle succeeds once in 2^39 tries; comparing any two
 * values retains 26 bits (the rows differ after the first, so nobody can choose by that value
 * alone), while a blind tap still fails two times in three. The new device confirms its side only with a device the person's
 * identity has signed (`peer`): one it never signed is never verified here. A device that trusts
 * the person's identity needs one that identity signed; a new Mac has nothing to check the
 * identity against, so it also waits for the person's one "I picked this code" (`confirmPicked`)
 * before it confirms, and a device whose identity was replaced elsewhere never asks or confirms
 * at all (main asks only for a device that never had a key, and never lets an approval replace
 * a kept one).
 *
 * Once both sides are done the new device asks that one device for the key with a one-time nonce
 * (`io.atum.owner_recovery.request`), and it answers, end-to-end encrypted to that device
 * (`io.atum.owner_recovery.grant`, owner-recovery-carrier.ts: decrypted, same person, from the
 * verified device only). Either message can be lost, so the new device asks again with the same
 * nonce until the key arrives, and the approving device answers that nonce again for two minutes;
 * every finished comparison is its own approval, so a lost key never strands the device. The new
 * device checks the key against the server, keeps it and unlocks silently (owner-unlock.ts). The
 * same answer follows the person's own full comparison from Settings, started on a device that
 * keeps the key, and a device without the key asks the same way after any finished comparison
 * with another of the person's devices.
 *
 * Guessing is bounded on the approving device, across restarts (device-trust.json): a wrong row
 * refuses that device for ten minutes and a second one within a day for a day, "This wasn't me"
 * refuses it for a day, and at most three approval sheets open in an hour, whichever devices ask.
 * That hourly budget is for devices the person's identity never signed: a request from one it
 * signed is the person trying again on a phone or Mac they already approved (Verify, Try again),
 * so it neither waits for the budget nor uses it up. A refusal still turns it away.
 * A refused request is cancelled, before this device unlocks too, so the generic verification
 * prompt never offers it instead; a refused device gets no key, even from an answer already
 * running, and only the person's right row on the sheet sends one.
 *
 * A device that is asleep when the request is made still sees it when it wakes within ten
 * minutes (to-device messages wait on the server); later than that, the new device's
 * account-data marker (`io.atum.device_approval`, no secret, 24 h) makes it start the comparison
 * itself.
 */

/** A device the person used within this long can approve a new one. */
export const MATRIX_APPROVAL_ACTIVE_MS = 30 * 24 * 60 * 60 * 1000
/** How long each side waits for the other's message after the comparison. */
const MESSAGE_WAIT_MS = 2 * 60 * 1000
/** The new device asks again after this long without the key (a message can be lost), then after
 * twice as long each time, up to `RESEND_MAX_MS`. Same nonce: the answer is the same key. */
const RESEND_MS = 3_000
const RESEND_MAX_MS = 30_000
/** A key older than this is never used. */
const GRANT_MAX_AGE_MS = 10 * 60 * 1000
/** A device that is asleep may still approve within this long (the account-data marker). */
const MARKER_MS = 24 * 60 * 60 * 1000
/** One wrong row: that device's requests are refused for this long. */
const MUTE_MS = 10 * 60 * 1000
/** "This wasn't me", or a second wrong row within a day: that device is refused for a day. */
const REFUSE_MS = 24 * 60 * 60 * 1000
/** Wrong rows from one device within a day before it is refused for a day. */
const MISMATCH_LIMIT = 2
/** Approval sheets this device opens in an hour, whichever devices ask: a person cannot be asked to
 * guess a row again and again by fresh devices either. */
const PROMPTS_PER_HOUR = 3
const HOUR_MS = 60 * 60 * 1000
/** A verification request lives this long (the Matrix specification); a device that wakes within
 * it answers the request itself, so a marker counts only once it is older than this. */
const REQUEST_LIFE_MS = 10 * 60 * 1000
/** A new device that found none of the person's other devices to ask looks once more after this. */
const ASK_AGAIN_MS = 30_000
const POLL_MS = 1_000

const DROP_REASONS = new Set<string>(MATRIX_OWNER_RECOVERY_DROP_REASONS)

/** A closed code for the log: an SDK or bridge error's own code (`matrix_not_ready`), never its
 * text, which can carry request data. */
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''

  return /^[a-z][a-z0-9_]{0,63}$/.test(message) ? message : 'error'
}

/** Where this Mac keeps its approval ledger (device-trust.json in main). */
export interface MatrixApprovalLedgerStore {
  read(): string | null
  write(value: string): void
}

export interface MatrixDeviceApprovalPort {
  /** The person's device on this Mac, while its SDK runs. */
  me(): MatrixIdentity | undefined
  /** The person's SDK on this Mac. */
  command(value: MatrixSdkCommand, timeoutMs?: number): Promise<unknown>
  /** Approver: the key this Mac keeps and the key id it opens, while this device is unlocked. */
  grantable(): { key: string; keyId: string } | undefined
  /** Requester: this device still has no key (owner-unlock.ts `needs_key`). */
  needsKey(): boolean
  /** Requester: a key from the approving device, to check, keep and unlock with. */
  received(key: string, keyId: string): Promise<boolean>
  /** Approver: tell the person (a system notification), by the device's own name. */
  notify(deviceName: string | undefined): void
  changed(): void
  log(line: string): void
  /** Approver: wrong rows, refusals and prompts, kept across restarts. In memory without one. */
  ledger?: MatrixApprovalLedgerStore
  now?(): number
  wait?(milliseconds: number): Promise<void>
  /** A uniform choice in [0, n). */
  random?(n: number): number
}

interface Run {
  role: 'request' | 'approve'
  state: MatrixApprovalView['state']
  since: number
  /** The verification this run follows (security.ts id). */
  requestId?: string
  /** Its transaction ID, the same on the other device: the key request names it. */
  flowId?: string
  deviceId?: string
  deviceName?: string
  numbers?: MatrixApprovalNumbers
  choices?: MatrixApprovalNumbers[]
  answer?: number
  accepted?: boolean
  started?: boolean
  confirmed?: boolean
  picked?: boolean
  /** Approver: the person picked the right row on this sheet; nothing else sends the key. */
  matched?: boolean
  /** Requester: a new Mac waits for the person's "I picked this code" before confirming its side. */
  awaitingTap?: boolean
  finishing?: boolean
  /** Approver: this side sends the request (a waiting device's marker, or Try again after a
   * comparison that took too long). */
  fromMarker?: boolean
  /** Approver, at `failed`: `there` when this Mac approved that device but it never finished
   * there; anything else is this Mac's own part (`here`). */
  failure?: MatrixApprovalFailure
  generation: number
}

const TERMINAL = new Set<MatrixApprovalView['state']>(['done', 'mismatch', 'declined', 'timeout', 'failed'])
const PENDING = new Set<MatrixVerification['state']>(['requested', 'ready', 'started', 'compare'])

/**
 * Whether this device can let `device` approve it. A device that trusts the person's identity
 * needs one that identity signed and it verified; a new Mac, with nothing to check the identity
 * against, one the identity the server serves signed (and the person's "I picked this code"). A device
 * whose identity was replaced elsewhere trusts none: the server could serve anyone's.
 */
function trusted(own: MatrixOwnDevices, device: MatrixOwnDevice | undefined): boolean {
  if (!device || own.identity === 'changed') {
    return false
  }

  return own.identity === 'verified' ? device.crossSigningVerified === true : device.signedByOwner === true
}

function cancelState(code: string | undefined): MatrixApprovalView['state'] {
  if (code === 'm.mismatched_sas' || code === 'm.key_mismatch' || code === 'm.mismatched_commitment') {
    return 'mismatch'
  }

  if (code === 'm.user') {
    return 'declined'
  }

  return code === 'm.timeout' ? 'timeout' : 'failed'
}

interface LedgerEntry {
  /** When a wrong row was picked for this device, within the last day. */
  mismatches?: number[]
  /** Refused until then: one wrong row (ten minutes), "This wasn't me" or a second one (a day). */
  until?: number
  reason?: 'muted' | 'refused'
}

interface Ledger {
  v: 1
  /** By a hash of the person and the requesting device: never a device ID in the clear. */
  devices: Record<string, LedgerEntry>
  /** When this device opened an approval sheet, within the last hour. */
  prompts: number[]
}

/**
 * The approving device's memory of who it refused and how often it asked the person
 * (device-trust.json in main): wrong rows, "This wasn't me" and the hourly prompt budget must
 * outlive a restart, or quitting Atum would reset them for whoever is guessing.
 */
class ApprovalLedger {
  private memory: string | null = null

  constructor(
    private readonly store: MatrixApprovalLedgerStore | undefined,
    private readonly now: () => number
  ) {}

  private key(userId: string, deviceId: string): string {
    return createHash('sha256')
      .update(JSON.stringify(['atum-device-approval/v1', userId, deviceId]))
      .digest('hex')
  }

  private load(): Ledger {
    // This run's latest copy, else what an earlier run kept.
    let raw = this.memory

    if (raw === null) {
      try {
        raw = this.store?.read() ?? null
      } catch {
        raw = null
      }
    }

    const now = this.now()
    const ledger: Ledger = { v: 1, devices: {}, prompts: [] }

    try {
      const value = raw ? (JSON.parse(raw) as Partial<Ledger>) : undefined

      for (const [key, entry] of Object.entries(value?.devices ?? {})) {
        if (!/^[a-f0-9]{64}$/.test(key) || !entry || typeof entry !== 'object') {
          continue
        }

        const mismatches = (Array.isArray(entry.mismatches) ? entry.mismatches : []).filter(
          (time): time is number => typeof time === 'number' && time > now - REFUSE_MS
        )

        const until = typeof entry.until === 'number' && entry.until > now ? entry.until : undefined

        if (mismatches.length || until) {
          ledger.devices[key] = {
            ...(mismatches.length ? { mismatches } : {}),
            ...(until ? { until, reason: entry.reason === 'refused' ? 'refused' : 'muted' } : {})
          }
        }
      }

      ledger.prompts = (Array.isArray(value?.prompts) ? value.prompts : []).filter(
        (time): time is number => typeof time === 'number' && time > now - HOUR_MS
      )
    } catch {
      // An unreadable ledger starts empty; never a reason to stop approving.
    }

    return ledger
  }

  private save(ledger: Ledger): void {
    const value = JSON.stringify(ledger)
    this.memory = value

    try {
      this.store?.write(value)
    } catch {
      // Kept in memory for this run; the next write tries the file again.
    }
  }

  /** Why this device's requests are refused now, if they are. */
  refusal(userId: string, deviceId: string): 'muted' | 'refused' | undefined {
    const entry = this.load().devices[this.key(userId, deviceId)]

    return entry?.until ? entry.reason : undefined
  }

  /** A wrong row: refused for ten minutes, or for a day at the second within a day. */
  mismatch(userId: string, deviceId: string): void {
    const ledger = this.load()
    const key = this.key(userId, deviceId)
    const now = this.now()
    const mismatches = [...(ledger.devices[key]?.mismatches ?? []), now]
    const refused = mismatches.length >= MISMATCH_LIMIT
    ledger.devices[key] = {
      mismatches,
      until: now + (refused ? REFUSE_MS : MUTE_MS),
      reason: refused ? 'refused' : 'muted'
    }
    this.save(ledger)
  }

  /** "This wasn't me": refused for a day. */
  decline(userId: string, deviceId: string): void {
    const ledger = this.load()
    const key = this.key(userId, deviceId)
    ledger.devices[key] = { ...ledger.devices[key], until: this.now() + REFUSE_MS, reason: 'refused' }
    this.save(ledger)
  }

  /** Whether another approval sheet may open within this hour. */
  promptAllowed(): boolean {
    return this.load().prompts.length < PROMPTS_PER_HOUR
  }

  /** One more approval sheet this hour; returns when, for `unprompt`. */
  prompted(): number {
    const ledger = this.load()
    const at = this.now()
    ledger.prompts.push(at)
    this.save(ledger)

    return at
  }

  /** That sheet was the person's own retry from a device their identity signed: it gives back
   * what it took from this hour's budget. */
  unprompt(at: number): void {
    const ledger = this.load()
    const index = ledger.prompts.indexOf(at)

    if (index >= 0) {
      ledger.prompts.splice(index, 1)
      this.save(ledger)
    }
  }
}

export class MatrixDeviceApproval {
  private run?: Run
  /** The latest SDK snapshot may arrive before the command reply that names its request. */
  private verification?: MatrixVerification
  private generation = 0
  /** Bumped at sign-out: every answer still running stops. */
  private epoch = 0
  private readonly ledger: ApprovalLedger
  private readonly markersTried = new Set<string>()
  /** When each of the person's devices last asked this one (a marker for it waits until the
   * request has expired). */
  private readonly asked = new Map<string, number>()
  /** Requests this device refused (cancelled once). */
  private readonly refused = new Set<string>()
  /** The latest approval of each device, answering its key requests; an older one stops. */
  private readonly answering = new Map<string, symbol>()
  /** The person's own comparisons from Settings (not this sheet): seen at the symbols, answered. */
  private readonly checks = new Map<string, { compared?: boolean; answered?: boolean }>()
  /** Requester: comparisons this device already asked the key for (one ask each). */
  private readonly fetched = new Set<string>()
  /** Requester: each comparison's encrypted channel to the other device, opened once while the
   * person compares (`openChannel`); settles when it is open or could not be. */
  private readonly channels = new Map<string, Promise<void>>()
  /** Requests over this hour's budget whose device this one is checking (`overBudget`). */
  private readonly budgetChecks = new Set<string>()
  /** Requests from a device the person's identity signed: their own retry, outside the budget. */
  private readonly exempt = new Set<string>()
  /** Requests that arrived while another approval was running here (logged once each). */
  private readonly busy = new Set<string>()

  constructor(private readonly port: MatrixDeviceApprovalPort) {
    this.ledger = new ApprovalLedger(port.ledger, () => this.now())
  }

  private now(): number {
    return this.port.now?.() ?? Date.now()
  }

  private wait(milliseconds: number): Promise<void> {
    return this.port.wait?.(milliseconds) ?? new Promise(resolve => setTimeout(resolve, milliseconds))
  }

  private random(n: number): number {
    return this.port.random?.(n) ?? randomInt(n)
  }

  private set(patch: Partial<Run>): void {
    if (!this.run) {
      return
    }

    const state = patch.state ?? this.run.state
    this.run = { ...this.run, ...patch, ...(state !== this.run.state ? { since: this.now() } : {}) }
    this.port.changed()
  }

  /** What the window shows; never a key, never a raw device ID. */
  view(): MatrixApprovalView | undefined {
    const run = this.run

    if (!run) {
      return undefined
    }

    return {
      role: run.role,
      state: run.state,
      since: run.since,
      ...(run.deviceName ? { deviceName: run.deviceName } : {}),
      ...(run.role === 'request' && run.state === 'compare' && run.numbers ? { numbers: run.numbers } : {}),
      ...(run.role === 'request' && run.state === 'compare' && run.awaitingTap ? { confirm: true as const } : {}),
      // Once the person picked the right row, the rows go: the sheet says to tap "I picked this code"
      // on the other device (the comparison times out about a minute after the pick).
      ...(run.role === 'approve' && run.state === 'compare' && run.choices && !run.matched
        ? { choices: run.choices }
        : {}),
      ...(run.role === 'approve' && run.state === 'compare' && run.matched ? { picked: true as const } : {}),
      ...(run.role === 'approve' && run.state === 'failed' && run.failure ? { failure: run.failure } : {})
    }
  }

  /** The person's other devices and what this device knows of their identity (security.ts);
   * `undefined` when the answer is not one. */
  private async own(): Promise<MatrixOwnDevices | undefined> {
    const value = (await this.port.command({ kind: 'ownDevices' }, 30_000)) as MatrixOwnDevices | null

    return value &&
      Array.isArray(value.devices) &&
      (value.identity === 'verified' || value.identity === 'new' || value.identity === 'changed')
      ? value
      : undefined
  }

  /**
   * This device has no key: ask the person's other devices. `false` when none of them could
   * answer (none signed by the person's identity and active in the last 30 days), or when the
   * identity this device verified was replaced elsewhere: the person uses their key instead.
   */
  async request(): Promise<boolean> {
    const me = this.port.me()

    if (!me || (this.run && !TERMINAL.has(this.run.state))) {
      return Boolean(this.run && !TERMINAL.has(this.run.state))
    }

    const own = await this.own()

    if (own?.identity === 'changed') {
      this.port.log('[Matrix] approval: the account’s identity changed elsewhere; not asking')

      return false
    }

    const since = this.now() - MATRIX_APPROVAL_ACTIVE_MS

    const approvers = (own?.devices ?? [])
      .filter(device => trusted(own!, device) && typeof device.lastSeenAt === 'number' && device.lastSeenAt >= since)
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))

    if (!approvers.length) {
      this.port.log('[Matrix] approval: no other device can approve this one')

      return false
    }

    this.generation += 1
    this.run = {
      role: 'request',
      state: 'waiting',
      since: this.now(),
      ...(approvers[0]!.name ? { deviceName: approvers[0]!.name } : {}),
      generation: this.generation
    }
    this.port.changed()
    const generation = this.generation

    const now = this.now()

    await this.port
      .command({
        kind: 'approvalMarker',
        marker: { deviceId: me.deviceId, requestedAt: now, expiresAt: now + MARKER_MS }
      })
      .catch(() => this.port.log('[Matrix] approval: marker not written'))

    try {
      const verification = (await this.port.command({ kind: 'approvalRequest' }, 30_000)) as MatrixVerification | null
      const current = this.port.me()

      if (
        this.run?.generation === generation &&
        current?.userId === me.userId &&
        current.deviceId === me.deviceId &&
        verification?.userId === me.userId &&
        verification.incoming === false &&
        typeof verification.id === 'string'
      ) {
        // A refused request can finish within one coalesced SDK snapshot. Bind the
        // authoritative reply first, then replay only that exact request's latest state.
        this.set({ requestId: verification.id })
        this.follow(this.verification?.id === verification.id ? this.verification : verification, me)
      }

      this.port.log('[Matrix] approval: asked the person’s other devices')
    } catch {
      this.set({ state: 'failed' })

      return false
    }

    return true
  }

  /**
   * `request`, and once more after 30 s when no device could be asked yet (the device list or its
   * last-active times had not arrived at the first sync) or the request failed, while
   * `stillNeeded`. Never throws.
   */
  async requestSoon(stillNeeded: () => boolean): Promise<boolean> {
    if (await this.request().catch(() => false)) {
      return true
    }

    await this.wait(ASK_AGAIN_MS)

    return stillNeeded() ? this.request().catch(() => false) : false
  }

  /** Every snapshot of the person's SDK: follow the comparison, and a waiting device's marker. */
  observe(security: MatrixSecurity | undefined): void {
    const me = this.port.me()

    if (!me) {
      return
    }

    const verification = security?.verification
    this.verification = verification?.userId === me.userId ? verification : undefined

    if (verification && verification.userId === me.userId) {
      if (verification.incoming && verification.deviceId && verification.state === 'requested') {
        this.asked.set(verification.deviceId, this.asked.get(verification.deviceId) ?? this.now())
      }

      this.openChannel(verification, me)
      this.follow(verification, me)
    }

    this.marker(security, me)
  }

  /**
   * Requester: while the person compares the codes, open the encrypted channel to the device it is
   * comparing with, so the key request after the comparison finds a session already there. When
   * the comparison finishes, this device's key request and the other device's own secret sharing
   * (the SDK sends the secrets it holds to any device just verified) each start an Olm session at
   * the same instant; the two sessions can collide, this device then cannot read what the other
   * answers (`InvalidMAC`), and the SDK only replaces such a session once it is an hour old: the
   * key request went unanswered however often it was resent . Confirming waits for this to settle, so the
   * other device has this channel before anything else reaches it; a failure only logs, and the
   * comparison goes on as before.
   */
  private openChannel(verification: MatrixVerification, me: MatrixIdentity): void {
    if (
      !verification.deviceId ||
      verification.deviceId === me.deviceId ||
      (verification.state !== 'ready' && verification.state !== 'started' && verification.state !== 'compare') ||
      this.channels.has(verification.id) ||
      !this.port.needsKey()
    ) {
      return
    }

    this.channels.set(
      verification.id,
      this.port
        .command(
          { kind: 'ownerRecoveryChannelOpen', recipient: { userId: me.userId, deviceId: verification.deviceId } },
          30_000
        )
        .then(() => this.port.log('[Matrix] approval role=request channel=open'))
        .catch(error => this.port.log(`[Matrix] approval role=request channel=failed code=${errorCode(error)}`))
    )
  }

  private follow(verification: MatrixVerification, me: MatrixIdentity): void {
    let run = this.run

    if (!run || run.requestId !== verification.id) {
      if (verification.state === 'done' || verification.state === 'cancelled') {
        this.checked(verification, me)
        this.verified(verification, me)

        return
      }

      if (
        run?.role === 'approve' &&
        run.state === 'unlocking' &&
        verification.incoming &&
        PENDING.has(verification.state) &&
        verification.deviceId &&
        verification.deviceId === run.deviceId
      ) {
        // The device this Mac just approved asks again while this Mac still waits for it (the
        // person tried again there): the new request takes over, the old wait ends
        // (`answer=end result=superseded`), and the new one goes through the same checks below.
        this.answering.set(verification.deviceId, Symbol('takeover'))
        this.port.log('[Matrix] approval role=approve request=takeover')
        this.run = undefined
        this.generation += 1
        this.port.changed()
        run = undefined
      }

      if (run?.role === 'request' && run.state !== 'unlocking' && run.state !== 'done' && this.port.needsKey()) {
        // Our own request, or an approver that woke up later and asks us: a fresh attempt, so
        // nothing still waiting from an earlier one can touch it.
        this.generation += 1
        this.run = {
          role: 'request',
          state: 'waiting',
          since: run.requestId ? this.now() : run.since,
          requestId: verification.id,
          ...(run.deviceName ? { deviceName: run.deviceName } : {}),
          generation: this.generation
        }
        this.port.changed()
      } else if (
        verification.incoming &&
        PENDING.has(verification.state) &&
        (!run || TERMINAL.has(run.state)) &&
        !this.port.grantable()
      ) {
        // Before this device unlocks it opens no sheet, and the generic prompt shows the request:
        // a device it refused, or one over this hour's budget, is turned away there too.
        const reason = this.refusalFor(verification, me)

        if (reason === 'limit') {
          void this.overBudget(verification, me)
        } else if (reason) {
          this.refuse(verification, reason)
        } else {
          this.checked(verification, me)
        }

        return
      } else if (verification.incoming && this.port.grantable() && (!run || TERMINAL.has(run.state))) {
        // Another of the person's devices asks this one. Refused without a sheet when that device
        // had a wrong row or "This wasn't me", or when this device already asked the person three
        // times this hour; cancelled, so nothing else offers it either (the generic prompt). Over
        // the budget, a device the person's identity signed is their own retry (`overBudget`).
        const reason = this.refusalFor(verification, me)

        if (reason === 'limit') {
          void this.overBudget(verification, me)

          return
        }

        if (reason) {
          this.refuse(verification, reason)

          return
        }

        // Counted now, so a burst of requests cannot open more sheets than the budget while the
        // device list is read; given back when that device turns out to be one the person's
        // identity signed (`name`).
        const promptedAt = this.exempt.has(verification.id) ? undefined : this.ledger.prompted()

        this.generation += 1
        this.run = {
          role: 'approve',
          state: 'asked',
          since: this.now(),
          requestId: verification.id,
          ...(verification.deviceId ? { deviceId: verification.deviceId } : {}),
          generation: this.generation
        }
        this.port.changed()
        this.port.notify(undefined)
        void this.name(verification.deviceId, promptedAt)
      } else if (
        run?.role === 'approve' &&
        run.fromMarker &&
        run.state === 'waiting' &&
        !run.requestId &&
        !verification.incoming
      ) {
        // Our own request to a device that left a marker.
        this.set({ requestId: verification.id })
      } else {
        if (
          verification.incoming &&
          PENDING.has(verification.state) &&
          run &&
          !TERMINAL.has(run.state) &&
          !this.busy.has(verification.id)
        ) {
          // Another approval is still running here: this request opens nothing, and says so.
          this.busy.add(verification.id)
          this.port.log(`[Matrix] approval role=${run.role} request=ignored reason=busy`)
        }

        this.checked(verification, me)

        return
      }

      run = this.run!
    }

    if (verification.deviceId && verification.deviceId !== run.deviceId) {
      this.set({ deviceId: verification.deviceId })
    }

    if (verification.flowId && verification.flowId !== run.flowId) {
      this.set({ flowId: verification.flowId })
    }

    if (verification.state === 'cancelled') {
      if (run.role === 'approve' && verification.cancelCode === 'm.accepted') {
        // Another of the person's devices answered it: nothing for this one to say.
        this.run = undefined
        this.port.changed()

        return
      }

      if (!TERMINAL.has(run.state) && run.state !== 'unlocking') {
        this.port.log(`[Matrix] approval role=${run.role} cancelled code=${verification.cancelCode ?? 'unknown'}`)
        this.set({ state: cancelState(verification.cancelCode) })
      }

      return
    }

    const respond = async (action: 'accept' | 'start' | 'confirm' | 'mismatch' | 'cancel') => {
      if (action === 'confirm') {
        await this.channels.get(verification.id)
      }

      return this.port.command({ kind: 'verificationRespond', id: verification.id, action }, 30_000).catch(() => {
        this.port.log(`[Matrix] approval role=${run!.role} ${action} failed`)
      })
    }

    // The new Mac accepts a request from the device that came to approve it (a marker's), when
    // the person's identity signed that device.
    if (verification.state === 'requested' && verification.incoming && run.role === 'request' && !run.accepted) {
      this.set({ accepted: true })
      void this.peer(verification, run.generation).then(trust => trust && respond('accept'))

      return
    }

    // The approving side starts the comparison, whichever side asked.
    if (verification.state === 'ready' && run.role === 'approve' && !run.started) {
      this.set({ started: true })
      void respond('start')

      return
    }

    if (verification.state === 'compare') {
      const numbers = this.approvalNumbers(verification.decimals)

      if (!numbers) {
        this.port.log(`[Matrix] approval role=${run.role} compare=invalid_decimal_sas`)
        this.set({ state: 'failed' })
        void respond('cancel')

        return
      }

      if (run.role === 'request') {
        if (!run.confirmed) {
          this.set({ confirmed: true })
          void this.peer(verification, run.generation).then(trust => {
            if (!trust || this.run?.generation !== run.generation) {
              return
            }

            if (trust === 'new') {
              // Nothing here to check the person's identity against: the person says they picked
              // the number code on their other device first ("I picked it", `confirmPicked`).
              this.set({ state: 'compare', numbers, awaitingTap: true })

              return
            }

            this.set({ state: 'compare', numbers })
            void respond('confirm')
          })
        }
      } else if (!run.choices) {
        this.set({ state: 'compare', ...this.choices(numbers) })
      }

      return
    }

    // The Rust SDK forgets the other device once the request is done; the run remembers it.
    const deviceId = verification.deviceId || run.deviceId
    const flowId = verification.flowId || run.flowId

    if (verification.state === 'done' && !run.finishing && (!deviceId || !flowId)) {
      // Nothing names the device or the comparison, so no key can be asked for or answered:
      // said, rather than left spinning.
      this.port.log(`[Matrix] approval role=${run.role} done=missing_flow`)
      this.set({ finishing: true, state: 'failed' })

      return
    }

    if (verification.state === 'done' && !run.finishing && deviceId && flowId) {
      if (run.role === 'approve' && !run.matched) {
        // Finished without the person's right row on this sheet (a "match" confirmed outside
        // it): the SDK may have signed that device itself when the comparison was confirmed, but
        // this sheet never sends it the key.
        this.port.log('[Matrix] approval role=approve done=without_pick')
        this.set({ finishing: true, state: 'failed' })

        return
      }

      this.port.log(`[Matrix] approval role=${run.role} done`)
      this.set({
        finishing: true,
        state: run.role === 'request' ? 'unlocking' : run.state === 'compare' ? 'unlocking' : run.state
      })

      if (run.role === 'request') {
        this.fetched.add(verification.id)
      }

      void (run.role === 'request'
        ? this.askForKey(me, deviceId, flowId, run.generation)
        : this.sendKey(me, deviceId, flowId, run.generation))
    }
  }

  /**
   * Requester: the person compared this device with another of theirs in the generic prompt, with
   * no approval running here (none could be asked at sign-in, or the last one had ended). Once that
   * comparison is done and this device still has no key, it asks that device for it exactly as
   * after an approval, and a device that keeps the key answers the person's own comparison
   * (`checked`). Asking gives nothing away: only a key that opens the account's recovery is used.
   */
  private verified(verification: MatrixVerification, me: MatrixIdentity): void {
    const deviceId = verification.deviceId
    const flowId = verification.flowId

    if (
      verification.state !== 'done' ||
      verification.userId !== me.userId ||
      !deviceId ||
      deviceId === me.deviceId ||
      !flowId ||
      this.fetched.has(verification.id) ||
      (this.run && !TERMINAL.has(this.run.state)) ||
      !this.port.needsKey()
    ) {
      return
    }

    this.fetched.add(verification.id)
    this.generation += 1
    this.run = {
      role: 'request',
      state: 'unlocking',
      since: this.now(),
      requestId: verification.id,
      deviceId,
      flowId,
      finishing: true,
      generation: this.generation
    }
    this.port.changed()
    this.port.log('[Matrix] approval role=request after=verification')
    void this.askForKey(me, deviceId, flowId, this.generation)
  }

  /** Why a request from another of the person's devices is turned away now, if it is: that
   * device was refused here (`muted`, `refused`), or this hour's budget is spent (`limit`). */
  private refusalFor(verification: MatrixVerification, me: MatrixIdentity): string | undefined {
    const refusal = verification.deviceId ? this.ledger.refusal(me.userId, verification.deviceId) : undefined

    return refusal ?? (this.exempt.has(verification.id) || this.ledger.promptAllowed() ? undefined : 'limit')
  }

  /**
   * Approver: a request over this hour's budget. When the person's identity signed the asking
   * device, it is the person trying again on a phone or Mac they already approved (Verify or Try
   * again there): it goes on as if within the budget, without using it up. Any other device is
   * refused, as before. Checked once per request; a request that moved on meanwhile is left alone.
   */
  private async overBudget(verification: MatrixVerification, me: MatrixIdentity): Promise<void> {
    if (this.budgetChecks.has(verification.id) || this.refused.has(verification.id)) {
      return
    }

    this.budgetChecks.add(verification.id)
    const epoch = this.epoch
    let own: MatrixOwnDevices | undefined

    try {
      own = await this.own()
    } catch {
      own = undefined
    }

    const latest = this.verification
    const current = this.port.me()

    if (
      this.epoch !== epoch ||
      current?.userId !== me.userId ||
      latest?.id !== verification.id ||
      !PENDING.has(latest.state) ||
      (this.run && !TERMINAL.has(this.run.state))
    ) {
      // Looked at again with the next snapshot, if it is still asking.
      this.budgetChecks.delete(verification.id)
      this.port.log('[Matrix] approval role=approve budget=stale')

      return
    }

    const signed =
      own &&
      trusted(
        own,
        own.devices.find(device => device?.deviceId === verification.deviceId)
      )

    if (!signed) {
      if (!own) {
        this.port.log('[Matrix] approval role=approve budget=unchecked')
      }

      this.refuse(verification, 'limit')

      return
    }

    this.exempt.add(verification.id)
    this.port.log('[Matrix] approval role=approve budget=exempt reason=own_device over=limit')
    this.follow(latest, me)
  }

  /** Approver: refuse one request from another of the person's devices, once. */
  private refuse(verification: MatrixVerification, reason: string): void {
    if (this.refused.has(verification.id)) {
      return
    }

    this.refused.add(verification.id)

    // An answer still running for that device (a comparison from Settings) stops too.
    if (verification.deviceId) {
      this.answering.delete(verification.deviceId)
    }

    this.port.log(`[Matrix] approval role=approve refused reason=${reason}`)
    void this.port
      .command({ kind: 'verificationRespond', id: verification.id, action: 'cancel' }, 30_000)
      .catch(() => {})
  }

  /**
   * The person compared all the symbols with one of their own devices from Settings (the generic
   * prompt, started on this device, never this sheet): once it is done, that device asks for the
   * key exactly as after an approval, and gets it the same way. Only on a device that keeps the
   * key, and only a comparison this device showed (it reached the symbols here): the person's own
   * "they match" on this device is what finished it.
   */
  private checked(verification: MatrixVerification, me: MatrixIdentity): void {
    if (verification.incoming || verification.userId !== me.userId) {
      return
    }

    const check = this.checks.get(verification.id) ?? {}

    if (verification.state === 'compare') {
      this.checks.set(verification.id, { ...check, compared: true })

      return
    }

    if (
      verification.state !== 'done' ||
      !check.compared ||
      check.answered ||
      !verification.deviceId ||
      !verification.flowId
    ) {
      return
    }

    this.checks.set(verification.id, { ...check, answered: true })

    if (!this.port.grantable()) {
      this.port.log('[Matrix] approval role=approve from=settings skipped reason=no_key')

      return
    }

    this.port.log('[Matrix] approval role=approve from=settings')
    void this.answer(me, verification.deviceId, verification.flowId)
  }

  /**
   * Requester: the device on the other side can approve this one (`trusted`). The new device
   * confirms its side of the comparison without comparing anything itself, so it does that only
   * with such a device: one the identity never signed (made by someone who took over the
   * account, say) would otherwise be verified by this device and receive every message key it
   * sends, and on a device whose identity was replaced elsewhere the server could serve anyone's.
   * Such a comparison is cancelled before anything is confirmed, and the person can try again or
   * use their key. Returns what this device knows of the identity (`new`: the person's "I picked
   * them" comes first), or `undefined` when it refused.
   */
  private async peer(
    verification: MatrixVerification,
    generation: number
  ): Promise<MatrixOwnDevices['identity'] | undefined> {
    let own: MatrixOwnDevices | undefined

    if (verification.deviceId) {
      try {
        own = await this.own()
      } catch {
        own = undefined
      }
    }

    if (this.run?.generation !== generation) {
      return undefined
    }

    const trust =
      own &&
      trusted(
        own,
        own.devices.find(device => device?.deviceId === verification.deviceId)
      )
        ? own.identity
        : undefined

    if (!trust) {
      this.port.log(
        `[Matrix] approval role=request peer=${own?.identity === 'changed' ? 'identity_changed' : 'unsigned'}`
      )
      this.set({ state: 'failed' })
      await this.port
        .command({ kind: 'verificationRespond', id: verification.id, action: 'cancel' }, 30_000)
        .catch(() => {})
    }

    return trust
  }

  /**
   * Requester: "I picked this code". A new Mac, with nothing to check the person's identity against,
   * confirms its side of the comparison only once the person says they picked its number code on
   * their other device: no device is let in without them.
   */
  async confirmPicked(): Promise<void> {
    const run = this.run

    // Only while this device still never had a key (`needsKey`): one whose key went stale takes
    // only a typed key, so it confirms no comparison, whichever device answered.
    if (
      !run ||
      run.role !== 'request' ||
      run.state !== 'compare' ||
      !run.awaitingTap ||
      !run.requestId ||
      !this.port.needsKey()
    ) {
      throw new Error('matrix_approval_stale')
    }

    this.set({ awaitingTap: false })
    this.port.log('[Matrix] approval role=request picked')

    try {
      await this.channels.get(run.requestId)
      await this.port.command({ kind: 'verificationRespond', id: run.requestId, action: 'confirm' }, 30_000)
    } catch {
      if (this.run?.generation === run.generation) {
        this.set({ state: 'failed' })
      }
    }
  }

  /**
   * Three complete Matrix decimal SAS candidates, in random order. The two decoys share the
   * true first value but use four unique values absent from the true tuple. The complete
   * authenticated tuple appears exactly once, and the first value alone can never identify it.
   */
  private choices(right: MatrixApprovalNumbers): { choices: MatrixApprovalNumbers[]; answer: number } {
    const unavailable = new Set(right)

    const draw = (): number => {
      const slot = this.random(8_192 - unavailable.size)
      let value = 1_000 + slot

      for (const excluded of [...unavailable].sort((left, right) => left - right)) {
        if (value >= excluded) {
          value += 1
        }
      }

      unavailable.add(value)

      return value
    }

    const decoys: MatrixApprovalNumbers[] = [
      [right[0], draw(), draw()],
      [right[0], draw(), draw()]
    ]

    const answer = this.random(3)
    const choices = [...decoys]
    choices.splice(answer, 0, right)

    return { choices, answer }
  }

  private approvalNumbers(values: number[] | undefined): MatrixApprovalNumbers | undefined {
    if (
      !values ||
      values.length !== 3 ||
      !values.every(value => Number.isSafeInteger(value) && value >= 1_000 && value <= 9_191)
    ) {
      return undefined
    }

    return [values[0]!, values[1]!, values[2]!]
  }

  /**
   * The other device's own name, for the approval sheet (never its ID). With `promptedAt`, the
   * sheet it opened counted against this hour's budget: when the person's identity signed that
   * device, it is their own retry and the budget gets it back.
   */
  private async name(deviceId: string | undefined, promptedAt?: number): Promise<void> {
    if (!deviceId) {
      return
    }

    try {
      const own = await this.own()
      const device = own?.devices.find(each => each?.deviceId === deviceId)

      if (promptedAt !== undefined && own && trusted(own, device)) {
        this.ledger.unprompt(promptedAt)
        this.port.log('[Matrix] approval role=approve budget=exempt reason=own_device')
      }

      if (device?.name && this.run?.deviceId === deviceId) {
        this.set({ deviceName: device.name })
      }
    } catch {
      // A device without a known name is "a new device".
    }
  }

  /**
   * Approver: the person's answer. The right row confirms; any other, or none, refuses, and that
   * device is refused for ten minutes (a day at its second wrong row within a day). Returns the
   * refused device, for "Sign that device out".
   */
  async pick(index: number | null): Promise<string | undefined> {
    const run = this.run
    const me = this.port.me()

    if (!run || run.role !== 'approve' || run.state !== 'compare' || run.picked || !run.requestId) {
      throw new Error('matrix_approval_stale')
    }

    const right = index !== null && index === run.answer
    this.set({ picked: true, ...(right ? { matched: true } : {}) })
    this.port.log(`[Matrix] approval role=approve pick=${right ? 'match' : 'mismatch'}`)

    if (!right && run.deviceId && me) {
      // Counted before the answer leaves, so no failure on the way can skip it; an answer still
      // running for that device stops.
      this.ledger.mismatch(me.userId, run.deviceId)
      this.answering.delete(run.deviceId)
    }

    await this.port.command(
      { kind: 'verificationRespond', id: run.requestId, action: right ? 'confirm' : 'mismatch' },
      30_000
    )

    if (right) {
      return undefined
    }

    this.set({ state: 'mismatch' })

    return run.deviceId
  }

  /**
   * Approver: Try again after a comparison that took too long (the person didn't pick, or didn't
   * tap "I picked this code" on the new device, within about a minute). This device asks that device
   * again, as for a waiting device's marker; the person picks the right row again. Never for a
   * device refused here, and only while this device keeps the key.
   */
  async again(): Promise<void> {
    const run = this.run
    const me = this.port.me()

    if (!run || run.role !== 'approve' || run.state !== 'timeout' || !run.deviceId || !me || !this.port.grantable()) {
      throw new Error('matrix_approval_stale')
    }

    if (this.ledger.refusal(me.userId, run.deviceId)) {
      throw new Error('matrix_approval_unavailable')
    }

    this.generation += 1
    const generation = this.generation
    this.run = {
      role: 'approve',
      state: 'waiting',
      since: this.now(),
      deviceId: run.deviceId,
      ...(run.deviceName ? { deviceName: run.deviceName } : {}),
      accepted: true,
      fromMarker: true,
      generation
    }
    this.port.changed()
    this.port.log('[Matrix] approval role=approve again')

    try {
      await this.port.command({ kind: 'verificationStart', userId: me.userId, deviceId: run.deviceId }, 30_000)
    } catch {
      if (this.run?.generation === generation) {
        this.set({ state: 'failed' })
      }
    }
  }

  /**
   * Approver: the device of the request just refused here (a wrong row, a mismatch the other side
   * reported, "This wasn't me"), while the sheet still shows it: for "Sign that device out".
   */
  refusedDevice(): string | undefined {
    const run = this.run

    return run?.role === 'approve' && (run.state === 'mismatch' || run.state === 'declined') ? run.deviceId : undefined
  }

  /** Approver: "This wasn't me". That device is refused for a day. */
  async decline(): Promise<string | undefined> {
    const run = this.run
    const me = this.port.me()

    if (!run || run.role !== 'approve') {
      throw new Error('matrix_approval_stale')
    }

    if (run.deviceId && me) {
      this.ledger.decline(me.userId, run.deviceId)
    }

    if (run.deviceId) {
      // An answer still running for that device (a comparison from Settings) stops too.
      this.answering.delete(run.deviceId)
    }

    if (run.requestId && !TERMINAL.has(run.state)) {
      await this.port
        .command({ kind: 'verificationRespond', id: run.requestId, action: 'cancel' }, 30_000)
        .catch(() => {})
    }

    this.port.log('[Matrix] approval role=approve declined')
    this.set({ state: 'declined' })

    return run.deviceId
  }

  /**
   * The window closed the approval. An approval closed before it finished ("not now", Escape) ends
   * its request too, so the generic verification prompt never offers it instead; the device is not
   * refused for it.
   */
  dismiss(): void {
    const run = this.run

    if (!run || (!TERMINAL.has(run.state) && run.role !== 'approve')) {
      return
    }

    if (run.role === 'approve' && !TERMINAL.has(run.state) && run.state !== 'unlocking' && run.requestId) {
      this.port.log('[Matrix] approval role=approve dismissed')
      void this.port
        .command({ kind: 'verificationRespond', id: run.requestId, action: 'cancel' }, 30_000)
        .catch(() => {})
    }

    this.run = undefined
    this.generation += 1
    this.port.changed()
  }

  /**
   * This device has its key now, however it came (typed, from iCloud, approved): its waiting
   * marker goes, or another device that wakes within the day would ask the person to approve a
   * Mac that no longer needs it.
   */
  unlocked(security: MatrixSecurity | undefined): void {
    const me = this.port.me()

    if (!me || security?.approvalMarker?.deviceId !== me.deviceId) {
      return
    }

    void this.port
      .command({ kind: 'approvalMarker', marker: null })
      .catch(() => this.port.log('[Matrix] approval: marker not cleared'))
  }

  /**
   * This device's key went stale (owner-unlock.ts `stale`: the account's recovery was changed
   * elsewhere, maybe while its request was running): only a typed key unlocks it now, and no
   * comparison may let another device in. Its request still running is cancelled, so the person's
   * "I picked this code" can't confirm whichever device answered (the server could serve anyone's), and
   * its waiting marker goes, as when it unlocks.
   */
  stale(security: MatrixSecurity | undefined): void {
    const run = this.run

    if (run?.role === 'request' && !TERMINAL.has(run.state)) {
      const me = this.port.me()
      const pending = security?.verification

      // The request just sent, before this run followed it.
      const id =
        run.requestId ??
        (me && pending && pending.userId === me.userId && !pending.incoming && PENDING.has(pending.state)
          ? pending.id
          : undefined)

      if (id && run.state !== 'unlocking') {
        void this.port
          .command({ kind: 'verificationRespond', id, action: 'cancel' }, 30_000)
          .catch(() => this.port.log('[Matrix] approval role=request cancel failed'))
      }

      this.port.log('[Matrix] approval role=request stale')
      this.run = undefined
      this.generation += 1
      this.port.changed()
    }

    this.unlocked(security)
  }

  /** Signed out, or another account: nothing carries over but the refusals. */
  reset(): void {
    this.run = undefined
    this.verification = undefined
    this.generation += 1
    this.epoch += 1
    this.markersTried.clear()
    this.asked.clear()
    this.refused.clear()
    this.answering.clear()
    this.checks.clear()
    this.fetched.clear()
    this.channels.clear()
    this.budgetChecks.clear()
    this.exempt.clear()
    this.busy.clear()
  }

  /** Approver that woke later: a new device's marker starts the comparison from here. */
  private marker(security: MatrixSecurity | undefined, me: MatrixIdentity): void {
    const marker = security?.approvalMarker

    if (
      !marker ||
      marker.deviceId === me.deviceId ||
      marker.expiresAt <= this.now() ||
      // Its own request is still alive: this device (or another) answers that one instead.
      this.now() - marker.requestedAt < REQUEST_LIFE_MS ||
      this.now() - (this.asked.get(marker.deviceId) ?? 0) < REQUEST_LIFE_MS ||
      this.markersTried.has(`${marker.deviceId}:${marker.expiresAt}`) ||
      (this.run && !TERMINAL.has(this.run.state)) ||
      security?.verification?.state === 'requested' ||
      security?.verification?.state === 'ready' ||
      security?.verification?.state === 'started' ||
      security?.verification?.state === 'compare' ||
      !this.port.grantable() ||
      this.ledger.refusal(me.userId, marker.deviceId) ||
      !this.ledger.promptAllowed()
    ) {
      return
    }

    this.markersTried.add(`${marker.deviceId}:${marker.expiresAt}`)
    this.ledger.prompted()
    this.generation += 1
    this.run = {
      role: 'approve',
      state: 'asked',
      since: this.now(),
      deviceId: marker.deviceId,
      fromMarker: true,
      generation: this.generation
    }
    this.port.changed()
    this.port.notify(undefined)
    void this.name(marker.deviceId)
    this.port.log('[Matrix] approval role=approve a waiting device asks')
  }

  /**
   * Approver: "Yes, it's me". Claims the request (or, for a waiting device's marker, sends one)
   * and the comparison follows. Only the device the person is at does this.
   */
  async accept(): Promise<void> {
    const run = this.run
    const me = this.port.me()

    if (!run || run.role !== 'approve' || run.state !== 'asked' || !me) {
      throw new Error('matrix_approval_stale')
    }

    this.set({ state: 'waiting', accepted: true })
    this.port.log('[Matrix] approval role=approve accepted')

    try {
      if (run.fromMarker) {
        await this.port.command({ kind: 'verificationStart', userId: me.userId, deviceId: run.deviceId! }, 30_000)
      } else {
        await this.port.command({ kind: 'verificationRespond', id: run.requestId!, action: 'accept' }, 30_000)
      }
    } catch {
      if (this.run?.generation === run.generation) {
        this.set({ state: 'failed' })
      }
    }
  }

  /**
   * Why the carrier (owner-recovery-carrier.ts) dropped messages lately, as one line per reason:
   * a key request or a key that never arrived here leaves its reason in the log. Never throws.
   */
  private async drops(role: Run['role']): Promise<void> {
    const drops = (await this.port.command({ kind: 'ownerRecoveryDrops' }, 30_000).catch(() => [])) as
      | MatrixOwnerRecoveryDrop[]
      | null

    for (const drop of Array.isArray(drops) ? drops : []) {
      if (DROP_REASONS.has(drop?.reason) && Number.isSafeInteger(drop.count) && drop.count > 0) {
        this.port.log(`[Matrix] approval role=${role} carrier_drop reason=${drop.reason} count=${drop.count}`)
      }
    }
  }

  /** One log line per distinct code within one key exchange, however often it repeats. */
  private once(): (line: string) => void {
    const seen = new Set<string>()

    return line => {
      if (!seen.has(line)) {
        seen.add(line)
        this.port.log(line)
      }
    }
  }

  /**
   * Requester: ask the device just verified for the key, naming the comparison (its transaction
   * ID) with a one-time nonce, and wait for it. A request or its answer can be lost on the way, so
   * the same request goes again after 3 s, then 6, 12, 24 and every 30 s, until the key arrives or
   * two minutes have passed.
   */
  private async askForKey(me: MatrixIdentity, deviceId: string, flowId: string, generation: number): Promise<void> {
    const nonce = randomBytes(32).toString('base64url')
    const txn = flowId
    const asked = this.now()

    const ask = () =>
      this.port.command(
        {
          kind: 'ownerRecoveryToDeviceSend',
          recipient: { userId: me.userId, deviceId },
          event: { type: 'io.atum.owner_recovery.request', content: { v: 1, nonce, txn } }
        },
        30_000
      )

    const log = this.once()

    try {
      await ask()
      log('[Matrix] approval role=request key_request=sent')
    } catch (error) {
      log(`[Matrix] approval role=request key_request=failed code=${errorCode(error)}`)

      if (this.run?.generation === generation) {
        this.set({ state: 'failed' })
      }

      return
    }

    const deadline = asked + MESSAGE_WAIT_MS
    let again = RESEND_MS
    let sent = this.now()

    while (this.run?.generation === generation && this.now() < deadline) {
      const messages = (await this.port
        .command({ kind: 'ownerRecoveryToDeviceRead', senderDeviceId: deviceId }, 30_000)
        .catch(() => [])) as MatrixOwnerRecoveryMessage[]

      await this.drops('request')

      for (const message of Array.isArray(messages) ? messages : []) {
        const skip =
          message.type !== 'io.atum.owner_recovery.grant'
            ? 'wrong_type'
            : message.senderDeviceId !== deviceId
              ? 'other_sender'
              : message.content.txn !== txn
                ? 'other_txn'
                : message.content.nonce !== nonce
                  ? 'other_nonce'
                  : this.now() - message.receivedAt > GRANT_MAX_AGE_MS
                    ? 'expired'
                    : undefined

        if (skip || message.type !== 'io.atum.owner_recovery.grant') {
          log(`[Matrix] approval role=request grant=skipped reason=${skip ?? 'wrong_type'}`)

          continue
        }

        const ok = await this.port.received(message.content.recoveryKey, message.content.keyId).catch(() => false)

        if (this.run?.generation !== generation) {
          return
        }

        this.port.log(`[Matrix] approval role=request key=${ok ? 'received' : 'refused'}`)

        if (ok) {
          await this.port.command({ kind: 'approvalMarker', marker: null }).catch(() => {})
        }

        this.set({ state: ok ? 'done' : 'failed' })

        return
      }

      if (this.now() - sent >= again && this.run?.generation === generation) {
        await ask().catch(error =>
          log(`[Matrix] approval role=request key_request=resend_failed code=${errorCode(error)}`)
        )
        sent = this.now()
        again = Math.min(again * 2, RESEND_MAX_MS)
      }

      await this.wait(POLL_MS)
    }

    if (this.run?.generation === generation) {
      // Verified, but no key came (an approver without Atum's key, such as another app).
      this.port.log('[Matrix] approval role=request key=none')
      this.set({ state: 'failed' })
    } else {
      log('[Matrix] approval role=request key_request=superseded')
    }
  }

  /** Approver: sign the device just approved, then answer its key request (`answer`). */
  private async sendKey(me: MatrixIdentity, deviceId: string, flowId: string, generation: number): Promise<void> {
    const { sent, signed } = await this.answer(me, deviceId, flowId, () => {
      if (this.run?.generation === generation) {
        this.set({ state: 'done' })
      }
    })

    if (!sent && this.run?.generation === generation && !TERMINAL.has(this.run.state)) {
      // No key went out (that device never asked, or this Mac could not send it): `answer`
      // logged why (`answer=end result=...`). Signed here, that device is approved and only its
      // older messages may stay closed (`there`); unsigned, this Mac's part did not finish.
      this.set({ state: 'failed', failure: signed ? 'there' : 'here' })
    }
  }

  /**
   * Approver: the device this one just verified (an approval, or the person's own comparison in
   * Settings) is signed by the person's identity, then gets the key when it asks within two
   * minutes, naming this comparison (`flowId`): a request left over from an earlier one is never
   * answered. The first request binds the answer to its nonce: the same request again (its answer
   * was lost) gets the same key again, any other nonce gets nothing. A newer approval of the same
   * device takes over from this one. Returns whether the key went out, and whether this Mac
   * signed that device.
   */
  private async answer(
    me: MatrixIdentity,
    deviceId: string,
    flowId: string,
    onSent?: () => void
  ): Promise<{ sent: boolean; signed: boolean }> {
    const epoch = this.epoch
    const token = Symbol(deviceId)
    this.answering.set(deviceId, token)
    const current = () => this.epoch === epoch && this.answering.get(deviceId) === token

    const log = this.once()

    /** Why this answer ends, as one closed code (`no_request`: that device never asked within two
     * minutes). */
    const end = (result: 'sent' | 'no_request' | 'superseded' | 'stopped' | 'signed_out' | 'no_key' | 'refused') => {
      this.port.log(`[Matrix] approval role=approve answer=end result=${result}`)
    }

    const ended = () =>
      this.epoch !== epoch ? 'signed_out' : this.answering.get(deviceId) === undefined ? 'stopped' : 'superseded'

    let signed = false

    try {
      await this.port.command({ kind: 'approveOwnDevice', deviceId }, 30_000)
      signed = true
      this.port.log('[Matrix] approval role=approve sign=ok')
    } catch (error) {
      this.port.log(`[Matrix] approval role=approve sign=failed code=${errorCode(error)}`)
    }

    const deadline = this.now() + MESSAGE_WAIT_MS
    let bound: { nonce: string; txn: string } | undefined
    let sent = false

    while (current() && this.now() < deadline) {
      const messages = (await this.port
        .command({ kind: 'ownerRecoveryToDeviceRead', senderDeviceId: deviceId }, 30_000)
        .catch(() => [])) as MatrixOwnerRecoveryMessage[]

      await this.drops('approve')

      for (const request of Array.isArray(messages) ? messages : []) {
        if (!current()) {
          break
        }

        const skip =
          request.type !== 'io.atum.owner_recovery.request'
            ? 'wrong_type'
            : request.senderDeviceId !== deviceId
              ? 'other_sender'
              : request.content.txn !== flowId
                ? 'other_txn'
                : undefined

        if (skip) {
          // A request naming another comparison (an earlier one, or one this device never
          // finished) is never answered.
          log(`[Matrix] approval role=approve request=skipped reason=${skip}`)

          continue
        }

        if (bound && (request.content.nonce !== bound.nonce || request.content.txn !== bound.txn)) {
          this.port.log('[Matrix] approval role=approve request=other_nonce')

          continue
        }

        const grant = this.port.grantable()

        // That device was refused (a wrong row or "This wasn't me", before this answer began or
        // while it ran): nothing goes to it.
        const refused = this.ledger.refusal(me.userId, deviceId)

        if (!grant || refused) {
          // Refused, or this device no longer holds the key it would send (locked, or the key
          // changed): nothing goes to that device.
          this.port.log(`[Matrix] approval role=approve key=withheld reason=${refused ? 'refused' : 'no_key'}`)
          end(refused ? 'refused' : 'no_key')

          if (this.answering.get(deviceId) === token) {
            this.answering.delete(deviceId)
          }

          return { sent, signed }
        }

        bound ??= { nonce: request.content.nonce, txn: request.content.txn }

        try {
          await this.port.command(
            {
              kind: 'ownerRecoveryToDeviceSend',
              recipient: { userId: me.userId, deviceId },
              event: {
                type: 'io.atum.owner_recovery.grant',
                content: { v: 1, nonce: bound.nonce, txn: bound.txn, recoveryKey: grant.key, keyId: grant.keyId }
              }
            },
            30_000
          )
          this.port.log(`[Matrix] approval role=approve key=${sent ? 'resent' : 'sent'}`)

          if (!sent) {
            sent = true
            onSent?.()
          }
        } catch (error) {
          this.port.log(`[Matrix] approval role=approve key=failed code=${errorCode(error)}`)
        }
      }

      await this.wait(POLL_MS)
    }

    end(!current() ? ended() : sent ? 'sent' : 'no_request')

    if (this.answering.get(deviceId) === token) {
      this.answering.delete(deviceId)
    }

    return { sent, signed }
  }
}
