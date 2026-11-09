/**
 * The device service: grant table, the §3.3 admission order, rate limits, the paused state
 * (S1 build plan §3.3, §4, WS-4 `device/service.ts`).
 *
 * This is the device half of the three authorities (Astra follow-up #1): the controller authenticates
 * and proposes, **the device independently decides** whether a command fits its locally enrolled
 * capabilities, and a trusted native prompt authorizes the exceptions. A controller signature proves
 * where a command came from, not that the owner wants it — so every `Execute` runs the ten-step
 * admission order here before anything happens, and any failure is a `refused` Receipt with the ledger
 * still at `not_started`.
 *
 * The admission functions are pure (no crypto, no I/O): they consume already-computed facts
 * (signature validity, the correct argsHash, whether the commandId was seen) so they can be held to the
 * vendored `device-service/1` case fixtures exactly. `DeviceService` wires them to the real crypto
 * (`canonical.ts`), the ledger, the grants store and approvals.
 */
import type { WorkspaceConfirm, WorkspaceFinalize } from '../../../../../packages/device-protocol'

import { ApprovalWindow } from './approval-window'
import type { ApprovalAnswer } from './approvals'
import type { AuditWriter } from './audit'
import { argsHash, deviceMessageHash } from './canonical'
import type { ChatGptRelayHandler } from './chatgpt-relay'
import type {
  DeviceApproval,
  DeviceArtifact,
  DeviceCapability,
  DeviceExecutor,
  DeviceGrant,
  DeviceLedgerState,
  DeviceProtectedCapability,
  DeviceTool
} from './contracts'
import type { DriveDeleteContext } from './drive-delete'
import { type StandingGrant, standingGrantMatches } from './grants-store'
import type { DeviceLedger, LedgerRecord } from './ledger'
import { classifyExecute, SILENT_CAPABILITIES, toolScope } from './policy'
import { DeviceStopFence, type StopReason } from './stop'

/** Keep identical to `@atum/device-protocol` `DeviceRefusal`. */
export type DeviceRefusal =
  | 'wrong_owner'
  | 'wrong_agent'
  | 'wrong_device'
  | 'stale_enrollment'
  | 'stale_account_epoch'
  | 'stale_connection'
  | 'bad_signature'
  | 'unpinned_controller_key'
  | 'expired'
  | 'replayed'
  | 'seq_gap'
  | 'args_hash_mismatch'
  | 'origin_not_mine'
  | 'scope'
  | 'protected_needs_approval'
  | 'approval_denied'
  | 'approval_timeout'
  | 'stopped'
  | 'signed_out'
  | 'rate_limited'
  | 'paused'

/** Frozen timings (device-service/1 `parameters`). */
export const DEVICE_TIMINGS = {
  admissionMs: 15_000,
  approvalMs: 60_000,
  heartbeatMs: 5_000,
  authorityWindowMs: 15_000,
  skewMs: 30_000,
  executePerSecond: 10,
  executePerTurn: 600,
  protectedPromptsPerMinute: 3,
  denialsBeforeAutoRefuse: 3
} as const

// -------------------------------------------------------------- Grant admission

export interface GrantAdmissionDevice {
  readonly ownerUserId: string
  readonly deviceServiceId: string
  readonly enrollmentEpoch: number
  readonly accountEpoch: number
  readonly connectionId: string
  readonly connectionEpoch: number
  readonly signedIn: boolean
  readonly localScopes: readonly DeviceCapability[]
  readonly cloudAgents: readonly string[]
  readonly receivedAt: number
}

export interface GrantAdmissionFacts {
  readonly signatureValid: boolean
  readonly kidPinned: boolean
}

export interface OriginLogEntry {
  readonly assertionHash: string
  readonly roomId: string
  readonly eventId: string
}

export type GrantAdmission =
  | { readonly outcome: 'accepted'; readonly effectiveScopes: DeviceCapability[] }
  | { readonly outcome: 'refused'; readonly refusal: DeviceRefusal }

function originBound(grant: DeviceGrant, log: readonly OriginLogEntry[]): boolean {
  if (grant.originKind !== 'device') {
    return true
  }

  return log.some(
    entry =>
      entry.assertionHash === grant.originAssertionHash &&
      entry.roomId === grant.roomId &&
      entry.eventId === grant.eventId
  )
}

function intersectScopes(
  grantScopes: readonly DeviceCapability[],
  localScopes: readonly DeviceCapability[]
): DeviceCapability[] {
  const local = new Set(localScopes)

  return grantScopes.filter(scope => local.has(scope))
}

/** Admit (or refuse) a `TurnGrant` against this device's identity, epochs, connection and policy. */
export function admitGrant(
  device: GrantAdmissionDevice,
  grant: DeviceGrant,
  facts: GrantAdmissionFacts,
  originLog: readonly OriginLogEntry[]
): GrantAdmission {
  if (!device.signedIn) {
    return { outcome: 'refused', refusal: 'signed_out' }
  }

  if (!facts.kidPinned) {
    return { outcome: 'refused', refusal: 'unpinned_controller_key' }
  }

  if (!facts.signatureValid) {
    return { outcome: 'refused', refusal: 'bad_signature' }
  }

  if (grant.ownerUserId !== device.ownerUserId) {
    return { outcome: 'refused', refusal: 'wrong_owner' }
  }

  if (!device.cloudAgents.includes(grant.agentUserId)) {
    return { outcome: 'refused', refusal: 'wrong_agent' }
  }

  if (grant.targetDeviceServiceId !== device.deviceServiceId) {
    return { outcome: 'refused', refusal: 'wrong_device' }
  }

  if (grant.enrollmentEpoch !== device.enrollmentEpoch) {
    return { outcome: 'refused', refusal: 'stale_enrollment' }
  }

  if (grant.accountEpoch !== device.accountEpoch) {
    return { outcome: 'refused', refusal: 'stale_account_epoch' }
  }

  if (grant.connectionId !== device.connectionId) {
    return { outcome: 'refused', refusal: 'stale_connection' }
  }

  if (device.receivedAt > grant.expiresAt) {
    return { outcome: 'refused', refusal: 'expired' }
  }

  if (!originBound(grant, originLog)) {
    return { outcome: 'refused', refusal: 'origin_not_mine' }
  }

  const effectiveScopes = intersectScopes(grant.scopes, device.localScopes)

  if (effectiveScopes.length === 0) {
    return { outcome: 'refused', refusal: 'scope' }
  }

  return { outcome: 'accepted', effectiveScopes }
}

// -------------------------------------------------------------- Execute admission

export interface ExecuteAdmissionDevice {
  readonly deviceServiceId: string
  readonly enrollmentEpoch: number
  readonly accountEpoch: number
  readonly connectionId: string
  readonly connectionEpoch: number
  readonly signedIn: boolean
  readonly paused: boolean
  readonly receivedAt: number
}

export interface AdmittedGrant {
  readonly body: DeviceGrant
  /** The device's view of the grant's liveness. */
  readonly status: 'live' | 'stopped'
  /** The highest seq admitted so far under this grant. */
  readonly lastSeq: number
  readonly effectiveScopes: readonly DeviceCapability[]
  /** The current authority deadline (renewed by `Renew`), never past the grant's `expiresAt`. */
  readonly authorityUntil: number
}

export interface ExecuteBody {
  readonly commandId: string
  readonly grantId: string
  readonly seq: number
  readonly connectionId: string
  readonly connectionEpoch: number
  readonly deviceServiceId: string
  readonly enrollmentEpoch: number
  readonly accountEpoch: number
  readonly tool: DeviceTool
  readonly args: Record<string, unknown>
  readonly argsHash: string
  readonly inputManifestHash: string | null
  readonly needs: readonly DeviceProtectedCapability[]
  readonly proposedEffect: 'ordinary' | DeviceProtectedCapability
  readonly admitBy: number
  readonly timeoutMs: number
}

export interface ExecuteAdmissionFacts {
  readonly signatureValid: boolean
  readonly kidPinned: boolean
  /** The correct argsHash the device computed over the canonical args. */
  readonly argsHash: string
}

export interface SeenCommand {
  readonly commandId: string
  readonly commandHash: string
}

export type ExecuteAdmission =
  | { readonly outcome: 'admitted'; readonly relax: DeviceProtectedCapability[]; readonly approvalHash?: string }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'needs_approval'; readonly capabilities: DeviceProtectedCapability[] }
  | { readonly outcome: 'refused'; readonly refusal: DeviceRefusal }

export interface ExecuteAdmissionInput {
  readonly device: ExecuteAdmissionDevice
  readonly grant: AdmittedGrant
  /** The agent this Execute is for (the grant's `agentUserId`). A standing grant only covers its own agent. */
  readonly agentUserId: string
  readonly execute: ExecuteBody
  /** The command's own hash (device-computed) — used for dedup against `seen`. */
  readonly commandHash: string
  readonly facts: ExecuteAdmissionFacts
  readonly seen: readonly SeenCommand[]
  readonly originLog: readonly OriginLogEntry[]
  readonly standingGrants: readonly StandingGrant[]
  /** Capabilities covered by a fresh, verified approval for this exact command. */
  readonly freshApprovals?: ReadonlySet<DeviceProtectedCapability>
  readonly timings?: Pick<typeof DEVICE_TIMINGS, 'skewMs'>
  /** Where the owner's Drive roots are, so a mass delete of the Drive classifies as `bulk_destructive`. */
  readonly drive?: DriveDeleteContext | null
}

/**
 * Run the device admission order for one `Execute`. Returns `admitted` (with the capabilities whose
 * Seatbelt denies to lift), `duplicate` (return the stored Receipt), `needs_approval` (prompt for the
 * named capabilities), or `refused` with the reason. Any refusal leaves the ledger at `not_started`.
 *
 * Dedup precedes the seq check so an identical re-send returns its stored Receipt rather than being
 * refused as a replay of a non-increasing seq (the `execute-duplicate-returns-receipt` invariant).
 */
export function admitExecute(input: ExecuteAdmissionInput): ExecuteAdmission {
  const { device, grant, execute, facts } = input
  const skewMs = input.timings?.skewMs ?? DEVICE_TIMINGS.skewMs

  if (!device.signedIn) {
    return refused('signed_out')
  }

  // Step 1: controller key pinned and signature valid.
  if (!facts.kidPinned) {
    return refused('unpinned_controller_key')
  }

  if (!facts.signatureValid) {
    return refused('bad_signature')
  }

  // Step 2: this device, current connection.
  if (execute.deviceServiceId !== device.deviceServiceId) {
    return refused('wrong_device')
  }

  if (execute.connectionId !== device.connectionId || execute.connectionEpoch !== device.connectionEpoch) {
    return refused('stale_connection')
  }

  // Step 3: current epochs.
  if (execute.accountEpoch !== device.accountEpoch) {
    return refused('stale_account_epoch')
  }

  if (execute.enrollmentEpoch !== device.enrollmentEpoch) {
    return refused('stale_enrollment')
  }

  // Step 4: grant live and covers the tool.
  if (grant.status !== 'live') {
    return refused('stopped')
  }

  if (!grant.effectiveScopes.includes(toolScope(execute.tool))) {
    return refused('scope')
  }

  // Step 6 (before seq): dedup. An identical payload returns its stored Receipt; a different payload
  // under the same id is a replay.
  const seen = input.seen.find(entry => entry.commandId === execute.commandId)

  if (seen) {
    return seen.commandHash === input.commandHash ? { outcome: 'duplicate' } : refused('replayed')
  }

  // Step 5: seq strictly increases within the grant.
  if (execute.seq <= grant.lastSeq) {
    return refused('replayed')
  }

  if (execute.seq > grant.lastSeq + 1) {
    return refused('seq_gap')
  }

  // Step 7: argsHash matches the canonical args.
  if (execute.argsHash !== facts.argsHash) {
    return refused('args_hash_mismatch')
  }

  // Step 8: within admitBy (monotonic + skew) and within the renewed authority window.
  if (device.receivedAt > grant.authorityUntil || device.receivedAt > execute.admitBy + skewMs) {
    return refused('expired')
  }

  // Step 9: origin binding for device-origin turns.
  if (!originBound(grant.body, input.originLog)) {
    return refused('origin_not_mine')
  }

  // Step 10: effect classification, approval, paused gate.
  if (execute.tool === 'computer_use' && device.paused) {
    return refused('paused')
  }

  const classified = classifyExecute({
    tool: execute.tool,
    args: execute.args,
    needs: execute.needs,
    proposedEffect: execute.proposedEffect
  }, input.drive)

  const target = commandTarget(execute)
  const fresh = input.freshApprovals ?? new Set<DeviceProtectedCapability>()
  const uncovered: DeviceProtectedCapability[] = []

  for (const cap of classified) {
    const covered =
      fresh.has(cap) ||
      input.standingGrants.some(grantEntry => standingGrantMatches(grantEntry, cap, target, input.agentUserId))

    if (!covered) {
      uncovered.push(cap)
    }
  }

  if (uncovered.length) {
    return { outcome: 'needs_approval', capabilities: uncovered }
  }

  return { outcome: 'admitted', relax: [...classified] }
}

function refused(refusal: DeviceRefusal): ExecuteAdmission {
  return { outcome: 'refused', refusal }
}

/** The natural target string of a command, used to match standing grants and build the approval. */
export function commandTarget(execute: ExecuteBody): string {
  if (typeof execute.args.command === 'string') {
    return execute.args.command
  }

  if (typeof execute.args.path === 'string') {
    return execute.args.path
  }

  return execute.tool
}

// -------------------------------------------------------------- Renew / Revoke

export interface RenewInput {
  readonly receivedAt: number
  readonly grant: Pick<AdmittedGrant, 'status'> & { readonly expiresAt: number }
  readonly until: number
  readonly kidPinned: boolean
  readonly authorityWindowMs?: number
}

export type RenewEvaluation =
  | { readonly outcome: 'extended'; readonly authorityUntil: number }
  | { readonly outcome: 'ignored'; readonly reason: 'unpinned_controller_key' | 'stopped' | 'past_grant' | 'window' }

/** Evaluate a `Renew`. The authority window may extend to `until`, but never past the grant's end and
 * never further than the authority window from now. */
export function evaluateRenew(input: RenewInput): RenewEvaluation {
  const windowMs = input.authorityWindowMs ?? DEVICE_TIMINGS.authorityWindowMs

  if (!input.kidPinned) {
    return { outcome: 'ignored', reason: 'unpinned_controller_key' }
  }

  if (input.grant.status !== 'live') {
    return { outcome: 'ignored', reason: 'stopped' }
  }

  if (input.until > input.grant.expiresAt) {
    return { outcome: 'ignored', reason: 'past_grant' }
  }

  if (input.until - input.receivedAt > windowMs) {
    return { outcome: 'ignored', reason: 'window' }
  }

  return { outcome: 'extended', authorityUntil: input.until }
}

export interface RevokeInput {
  readonly deviceEnrollmentEpoch: number
  readonly lastRevokeSeq: number
  readonly revoke: { readonly enrollmentEpoch: number; readonly revokeSeq: number }
  readonly kidPinned: boolean
}

export type RevokeEvaluation =
  | { readonly outcome: 'applied' }
  | { readonly outcome: 'ignored'; readonly reason: 'unpinned_controller_key' | 'other_epoch' | 'older_revoke' }

/** Evaluate a `Revoke`. A delayed older revoke can never undo a newer one. */
export function evaluateRevoke(input: RevokeInput): RevokeEvaluation {
  if (!input.kidPinned) {
    return { outcome: 'ignored', reason: 'unpinned_controller_key' }
  }

  if (input.revoke.enrollmentEpoch !== input.deviceEnrollmentEpoch) {
    return { outcome: 'ignored', reason: 'other_epoch' }
  }

  if (input.revoke.revokeSeq <= input.lastRevokeSeq) {
    return { outcome: 'ignored', reason: 'older_revoke' }
  }

  return { outcome: 'applied' }
}

// -------------------------------------------------------------- Rate limiting

/**
 * Per-turn and per-second Execute rate limits, and the protected-prompt budget (device-service/1
 * `parameters`). After `denialsBeforeAutoRefuse` denials in a turn, further protected requests are
 * auto-refused without prompting again.
 */
export class RateLimiter {
  private perTurn = 0
  private windowStart = 0
  private inWindow = 0
  private promptWindowStart = 0
  private promptsInWindow = 0
  private denials = 0

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Returns true when an Execute is within the per-second and per-turn budgets. */
  admitExecuteRate(): boolean {
    const now = this.now()

    if (now - this.windowStart >= 1000) {
      this.windowStart = now
      this.inWindow = 0
    }

    if (this.inWindow >= DEVICE_TIMINGS.executePerSecond) {
      return false
    }

    if (this.perTurn >= DEVICE_TIMINGS.executePerTurn) {
      return false
    }

    this.inWindow += 1
    this.perTurn += 1

    return true
  }

  /** Returns true when a protected prompt may be shown (budget + auto-refuse floor). */
  admitPrompt(): boolean {
    const now = this.now()

    if (now - this.promptWindowStart >= 60_000) {
      this.promptWindowStart = now
      this.promptsInWindow = 0
    }

    if (this.denials >= DEVICE_TIMINGS.denialsBeforeAutoRefuse) {
      return false
    }

    if (this.promptsInWindow >= DEVICE_TIMINGS.protectedPromptsPerMinute) {
      return false
    }

    this.promptsInWindow += 1

    return true
  }

  recordDenial(): void {
    this.denials += 1
  }

  /** True once this turn has had `denialsBeforeAutoRefuse` denials: protected requests are refused
   * without asking again. */
  deniedOut(): boolean {
    return this.denials >= DEVICE_TIMINGS.denialsBeforeAutoRefuse
  }

  /** Reset the per-turn counters (called when a new turn's grant is admitted). */
  resetTurn(): void {
    this.perTurn = 0
    this.denials = 0
  }
}

// -------------------------------------------------------------- Grant table

/** The device's live grants, keyed by grantId, with their seq and authority state. */
export class GrantTable {
  private grants = new Map<string, AdmittedGrant>()

  set(grant: AdmittedGrant): void {
    this.grants.set(grant.body.grantId, grant)
  }

  get(grantId: string): AdmittedGrant | undefined {
    return this.grants.get(grantId)
  }

  /** Advance the admitted seq after a command is accepted. */
  advanceSeq(grantId: string, seq: number): void {
    const grant = this.grants.get(grantId)

    if (grant && seq > grant.lastSeq) {
      this.grants.set(grantId, { ...grant, lastSeq: seq })
    }
  }

  extendAuthority(grantId: string, authorityUntil: number): void {
    const grant = this.grants.get(grantId)

    if (grant) {
      this.grants.set(grantId, { ...grant, authorityUntil })
    }
  }

  stop(grantId: string): void {
    const grant = this.grants.get(grantId)

    if (grant) {
      this.grants.set(grantId, { ...grant, status: 'stopped' })
    }
  }

  /** Stop every live grant (Stop / sign-out / sleep). */
  stopAll(): void {
    for (const [id, grant] of this.grants) {
      this.grants.set(id, { ...grant, status: 'stopped' })
    }
  }

  clear(): void {
    this.grants.clear()
  }

  live(): AdmittedGrant[] {
    return [...this.grants.values()].filter(grant => grant.status === 'live')
  }
}

export type { DeviceApproval }

// -------------------------------------------------------------- The device service

/**
 * The frames WS-3b's `DeviceConnection` hands the device service, and the session they arrived on.
 * Structurally identical to `connection.ts` `DeviceInboundFrame`/`DeviceSession` (WS-3b), re-declared
 * so the service builds without the connection in this lane; `DeviceService` satisfies its
 * `DeviceFrameSink` and is attached with `connection.attach(service)`.
 */
export interface DeviceSessionFacts {
  readonly workspaceProtocol?: 1
  readonly connectionId: string
  readonly connectionEpoch: number
  readonly localGeneration: number
  readonly deviceServiceId: string
  readonly enrollmentEpoch: number
  readonly accountEpoch: number
}

export type DeviceFrameVerdict = 'ok' | 'bad_signature' | 'unpinned_controller_key'

export interface DeviceInboundFrameFacts {
  readonly type: 'TurnGrant' | 'Execute' | 'Renew' | 'Cancel' | 'WorkspaceFinalize' | 'WorkspaceConfirm' | 'ChatGptRelayRequest'
  readonly body: Record<string, unknown>
  readonly kid: string
  readonly verdict: DeviceFrameVerdict
  /** Monotonic receipt time (the connection's `performance.now()`), for `admitBy`. */
  readonly receivedAt: number
}

export type DeviceOutboundType = 'GrantAck' | 'Receipt' | 'Status' | 'Stop' | 'WorkspaceResult' | 'WorkspaceRefused' | 'ChatGptRelayResponse'

export interface DeviceOutboundFrameFacts {
  readonly type: DeviceOutboundType
  readonly body: Record<string, unknown>
}

export type DeviceConnectionCloseReason =
  | 'drop'
  | 'sleep'
  | 'stop'
  | 'sign_out'
  | 'account_switch'
  | 'revoked'
  | 'protocol'
  | 'unpinned'
  | 'silence'
  | 'unenrolled'

/** Who this Mac serves right now (read live on every frame). */
export interface DeviceIdentityFacts {
  /** The owner's Matrix user ID on this Mac. */
  readonly ownerUserId: string
  readonly signedIn: boolean
  /** What this Mac offers agents (`computer` only while the GUI broker can run). */
  readonly localScopes: readonly DeviceCapability[]
  /** The owner's agents (Matrix user IDs) this Mac serves: every active one, wherever it answers
   * (`served-agents.ts`). The field keeps its S1 name. */
  readonly cloudAgents: readonly string[]
}

export interface DeviceServiceDeps {
  connected?(): void
  relay?: Pick<ChatGptRelayHandler, 'handle' | 'disable'>
  workspace?: {
    finalize(request: WorkspaceFinalize, session: DeviceSessionFacts): Promise<void>
    confirm(request: WorkspaceConfirm, session: DeviceSessionFacts): Promise<void>
  }
  readonly ledger: DeviceLedger
  readonly executor: DeviceExecutor
  /** The Drive roots on this Mac, read live per command (absent when the Mac has no Drive workspace). */
  drive?(): DriveDeleteContext | null
  /** The owner's verified standing grants (`GrantsStore`). */
  readonly standingGrants: { list(): StandingGrant[] }
  /** One Touch ID approval for one capability of one command (`approvals.ts` `requestApproval`). */
  approve(input: {
    commandHash: string
    capability: DeviceProtectedCapability
    target: string
    agentUserId: string
  }): Promise<ApprovalAnswer>
  identity(): DeviceIdentityFacts | null
  /** This Mac's origin log (WS-3b `origin.ts`), for admission step 9. */
  originLog(): readonly OriginLogEntry[]
  /** Sends one device-signed frame on the current connection (WS-3b `DeviceConnection.send`). */
  send(type: DeviceOutboundType, body: Record<string, unknown>): Promise<boolean>
  /** Streams a Receipt artifact's bytes as chunk frames before its Receipt (WS-3b; send_file). */
  sendArtifact?(commandId: string, artifact: DeviceArtifact): Promise<boolean>
  /** Called once an artifact's bytes are no longer needed. */
  discardArtifact?(artifact: DeviceArtifact): void
  readonly audit: AuditWriter
  readonly indicator?: {
    grantActive(grantId: string, agentUserId: string): void
    firstAction(grantId: string, agentUserId: string): void
    grantEnded(grantId: string): void
  }
  /** Synchronously kill every process group the device host owns (the Stop fence's floor). */
  killAllGroups?(): void
  /** Async tail of a fence: close the GUI broker, sweep marked descendants. */
  afterFence?(reason: StopReason): Promise<void> | void
  /** The durable account epoch, read live (WS-3b `epochs.ts`); defaults to the session's. */
  accountEpoch?(): number
  now?(): number
  monotonic?(): number
  setTimer?(callback: () => void, ms: number): unknown
  clearTimer?(timer: unknown): void
  log?(line: string): void
}

interface InflightCommand {
  readonly grantId: string
  readonly controller: AbortController
  approvalGeneration: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const B64U_SHA256 = /^[A-Za-z0-9_-]{43}$/
const TOOLS: ReadonlySet<string> = new Set(['terminal', 'read_file', 'write_file', 'patch', 'search_files', 'computer_use', 'send_file'])
const CAPABILITIES: ReadonlySet<string> = new Set(['terminal', 'files', 'computer', 'send_file'])

const PROTECTED: ReadonlySet<string> = new Set([
  'ssh_agent', 'keychain', 'browser_store', 'cloud_cli', 'persistence', 'network_new_host', 'sudo',
  'other_agent_write', 'exec_downloaded', 'bulk_destructive', 'gui_upload'
])

/** Room for the rest of a Receipt/Status frame inside the hub's 1 MiB payload limit. */
const RESULT_BUDGET_BYTES = 900 * 1024
const OUTPUT_MAX = 65_536
/** A command that outlives its own timeout by this much is killed and reported `unknown`. */
const WATCHDOG_GRACE_MS = 30_000

/** Refusals that say something about this command (so an identical re-send gets the same answer).
 * Refusals about the frame's authenticity or freshness are not recorded. */
const RECORDED_REFUSALS: ReadonlySet<DeviceRefusal> = new Set([
  'args_hash_mismatch', 'expired', 'origin_not_mine', 'scope', 'seq_gap', 'rate_limited', 'paused',
  'protected_needs_approval', 'approval_denied', 'approval_timeout', 'stopped'
])

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function parseExecute(body: Record<string, unknown>): ExecuteBody | null {
  const { args, needs, proposedEffect } = body

  if (
    !UUID.test(String(body.commandId)) ||
    !UUID.test(String(body.grantId)) ||
    !Number.isSafeInteger(body.seq) ||
    !UUID.test(String(body.connectionId)) ||
    !Number.isSafeInteger(body.connectionEpoch) ||
    !UUID.test(String(body.deviceServiceId)) ||
    !Number.isSafeInteger(body.enrollmentEpoch) ||
    !Number.isSafeInteger(body.accountEpoch) ||
    !TOOLS.has(String(body.tool)) ||
    !isPlainObject(args) ||
    !B64U_SHA256.test(String(body.argsHash)) ||
    !(body.inputManifestHash === null || B64U_SHA256.test(String(body.inputManifestHash))) ||
    !Array.isArray(needs) ||
    !needs.every(each => PROTECTED.has(String(each))) ||
    !(proposedEffect === 'ordinary' || PROTECTED.has(String(proposedEffect))) ||
    !Number.isSafeInteger(body.admitBy) ||
    !Number.isSafeInteger(body.timeoutMs) ||
    (body.timeoutMs as number) < 1000 ||
    (body.timeoutMs as number) > 900_000
  ) {
    return null
  }

  return body as unknown as ExecuteBody
}

function parseGrant(body: Record<string, unknown>): DeviceGrant | null {
  const scopes = body.scopes
  const writer = body.writerEpoch as Record<string, unknown> | undefined

  if (
    !UUID.test(String(body.grantId)) ||
    typeof body.ownerUserId !== 'string' ||
    typeof body.agentUserId !== 'string' ||
    typeof body.agentPrincipal !== 'string' ||
    !['device', 'other', 'schedule'].includes(String(body.originKind)) ||
    !(body.originAssertionHash === null || typeof body.originAssertionHash === 'string') ||
    !isPlainObject(writer) ||
    !Number.isSafeInteger(writer.leaseGeneration) ||
    typeof writer.leaseTokenHash !== 'string' ||
    !UUID.test(String(body.targetDeviceServiceId)) ||
    !Number.isSafeInteger(body.enrollmentEpoch) ||
    !Number.isSafeInteger(body.accountEpoch) ||
    !Array.isArray(scopes) ||
    !scopes.every(each => CAPABILITIES.has(String(each))) ||
    !UUID.test(String(body.connectionId)) ||
    !Number.isSafeInteger(body.issuedAt) ||
    !Number.isSafeInteger(body.expiresAt) ||
    (body.expiresAt as number) < (body.issuedAt as number) ||
    (body.expiresAt as number) - (body.issuedAt as number) > 1_800_000
  ) {
    return null
  }

  return body as unknown as DeviceGrant
}

/**
 * Make a tool result safe to sign and to fit a frame: canonical JSON allows only safe integers, so a
 * fractional or huge number becomes its decimal string; `undefined` disappears; and the longest
 * strings are cut (with a marker) until the result fits its budget.
 */
export function boundedResultData(value: unknown, budget = RESULT_BUDGET_BYTES): unknown {
  const clean = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input === 'boolean' || typeof input === 'string') {
      return input
    }

    if (typeof input === 'number') {
      return Number.isSafeInteger(input) ? input : String(input)
    }

    if (typeof input === 'bigint') {
      return input.toString()
    }

    if (depth > 32) {
      return '[nested too deeply]'
    }

    if (Array.isArray(input)) {
      return input.map(each => (each === undefined ? null : clean(each, depth + 1)))
    }

    if (typeof input === 'object') {
      const out: Record<string, unknown> = {}

      for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
        if (entry !== undefined && typeof entry !== 'function') {
          out[key] = clean(entry, depth + 1)
        }
      }

      return out
    }

    return null
  }

  const data = clean(value, 0)

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const size = Buffer.byteLength(JSON.stringify(data) ?? '', 'utf8')

    if (size <= budget) {
      return data
    }

    // Find and halve the longest string leaf.
    let longest: { holder: Record<string, unknown> | unknown[]; key: string | number; length: number } | null = null

    const visit = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach((entry, index) => {
          if (typeof entry === 'string' && (!longest || entry.length > longest.length)) {
            longest = { holder: node, key: index, length: entry.length }
          } else {
            visit(entry)
          }
        })
      } else if (node && typeof node === 'object') {
        for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
          if (typeof entry === 'string' && (!longest || entry.length > longest.length)) {
            longest = { holder: node as Record<string, unknown>, key, length: entry.length }
          } else {
            visit(entry)
          }
        }
      }
    }

    visit(data)
    const target = longest as { holder: Record<string, unknown> | unknown[]; key: string | number; length: number } | null

    if (!target || target.length < 64) {
      break
    }

    const text = (target.holder as Record<string | number, string>)[target.key]

    const keep = Math.max(32, Math.floor(text.length / 2))

    ;(target.holder as Record<string | number, string>)[target.key] =
      `${text.slice(0, keep)}\n…[truncated on the device: ${text.length - keep} more characters]`
  }

  return { error: 'The result was too large to send from this Mac.' }
}

/** The Receipt `result` for a finished command: the Hermes tool's own result as `data`, and the
 * terminal's exit code when there is one (WS-3a maps `data` straight to the tool result). */
export function receiptResult(tool: DeviceTool, raw: unknown): { exitCode?: number; output?: string; data?: unknown } {
  if (raw === undefined) {
    return {}
  }

  const data = boundedResultData(raw)
  const result: { exitCode?: number; output?: string; data?: unknown } = { data }

  if (tool === 'terminal' && isPlainObject(data) && typeof data.exit_code === 'number' && Number.isSafeInteger(data.exit_code)) {
    result.exitCode = Math.max(-1000, Math.min(1000, data.exit_code))
  }

  if (typeof raw === 'string') {
    result.output = raw.length > OUTPUT_MAX ? `${raw.slice(0, OUTPUT_MAX - 64)}\n…[truncated on the device]` : raw
    delete result.data
  }

  return result
}

/** A Receipt body from a ledger record (the stored, signed-again answer for dedup and Status). */
export function receiptOfRecord(record: LedgerRecord): Record<string, unknown> {
  return {
    commandId: record.commandId,
    commandHash: record.commandHash,
    seq: record.seq,
    state: record.state,
    ...(record.refusal ? { refusal: record.refusal } : {}),
    ...(record.result && Object.keys(record.result).length ? { result: record.result } : {}),
    artifacts: (record.artifacts ?? []).map(each => ({ name: each.name, size: each.size, sha256: each.sha256 })),
    ...(record.approvalHash ? { approvalHash: record.approvalHash } : {}),
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.endedAt ? { endedAt: record.endedAt } : {})
  }
}

/**
 * The Mac's device service (S1 build plan §3.3, §4 WS-4 `DeviceService`): the grant table, the §3.3
 * admission order on every `Execute`, the protected-capability prompts, the durable ledger, the rate
 * limits, the paused state, and the Stop fence. It is WS-3b's `DeviceFrameSink`: `frame` admits and
 * returns at once (a command's Receipt goes out later through `send`), `status` answers a reconnect's
 * `StatusQuery` from the ledger, and `closed` ends the authority of a dropped connection.
 */
export class DeviceService {
  private readonly grants = new GrantTable()
  private readonly limiters = new Map<string, RateLimiter>()
  private readonly inflight = new Map<string, InflightCommand>()
  private readonly acted = new Set<string>()
  private readonly expiry = new Map<string, unknown>()
  /** Connections whose authority a fence or a close ended: anything still queued on them is refused. */
  private readonly fenced = new Set<string>()
  private approvalGeneration = 0
  /** Owner decision 2026-10-20: one Touch ID per agent + capability per task window (≤ 30 min). */
  private readonly approvalWindow = new ApprovalWindow(() => this.now())
  private pausedCount = 0
  /** Whole-host collection barrier: unlike an approval pause, this refuses every tool. */
  private collecting = false
  private collectingGrantId: string | null = null
  private fencing: StopReason | null = null
  private readonly fence: DeviceStopFence

  constructor(private readonly deps: DeviceServiceDeps) {
    this.fence = new DeviceStopFence({
      grants: this.grants,
      setStopped: () => {
        // A local Stop ends the grants; the connection stays up for the next turn. Sleep, sign-out and
        // account switch end the connection's authority too (WS-3b closes it as well).
        if (this.fencing !== 'local_stop') {
          for (const grant of this.grants.live()) {
            this.fenced.add(grant.body.connectionId)
          }
        }
      },
      voidApprovals: () => {
        this.approvalGeneration += 1
      },
      bumpConnectionEpoch: () => {
        // The connection's own epoch is WS-3b's; here every in-flight command loses its authority.
        for (const command of this.inflight.values()) {
          command.controller.abort(new Error('device_stopped'))
        }
      },
      bumpAccountEpoch: () => {},
      ownedProcessGroups: () => [],
      killProcessGroup: () => {},
      closeBroker: () => undefined,
      sendStop: () => undefined,
      accountEpoch: () => this.deps.accountEpoch?.() ?? 0
    })
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private monotonic(): number {
    return this.deps.monotonic?.() ?? performance.now()
  }

  /** The wall-clock time a frame was received, measured on the monotonic clock since then. */
  private wallAtReceipt(receivedAt: number): number {
    return this.now() - Math.max(0, this.monotonic() - receivedAt)
  }

  private log(line: string): void {
    this.deps.log?.(`[Device] ${line}`)
  }

  /** An approval sheet is up: the GUI broker refuses, and `computer_use` is refused as `paused`. */
  paused(): boolean {
    return this.pausedCount > 0
  }

  setPaused(paused: boolean): void {
    this.pausedCount = Math.max(0, this.pausedCount + (paused ? 1 : -1))
  }

  /**
   * Freeze a copy only after the host's responsibility tree is quiescent. The host is shared,
   * so abort all its commands and block all new Execute admissions until collection returns.
   * A caller must already have authenticated the lifecycle request on this exact session.
   * Stop, sign-out, expiry or a failed sweep leave the copy unsaved and return no snapshot.
   */
  workspaceGeneration(): number {return this.approvalGeneration}

  workspaceGrant(grantId: string): DeviceGrant | null {
    const grant = this.grants.get(grantId)

    return grant?.status === 'live' ? grant.body : null
  }

  async collectWorkspace<T>(grantId: string, session: DeviceSessionFacts,
    quiesce: () => Promise<void>, collect: (grant: DeviceGrant) => Promise<T>): Promise<T | null> {
    const grant = this.grants.get(grantId)
    const identity = this.deps.identity()

    if (this.collecting || !grant || grant.status !== 'live' || !identity?.signedIn
      || !grant.effectiveScopes.includes('files')
      || identity.ownerUserId !== grant.body.ownerUserId || this.fenced.has(session.connectionId)
      || grant.body.connectionId !== session.connectionId || grant.body.targetDeviceServiceId !== session.deviceServiceId
      || grant.body.enrollmentEpoch !== session.enrollmentEpoch || grant.body.accountEpoch !== session.accountEpoch
      || (this.deps.accountEpoch?.() ?? session.accountEpoch) !== session.accountEpoch
      || Math.min(grant.authorityUntil, grant.body.expiresAt) <= this.now()) {return null}

    this.collecting = true
    this.collectingGrantId = grantId
    this.approvalGeneration += 1
    const generation = this.approvalGeneration
    this.endGrant(grantId)

    for (const command of this.inflight.values()) {command.controller.abort(new Error('workspace_collecting'))}

    try {
      this.deps.killAllGroups?.()
      await quiesce()

      const current = () => generation === this.approvalGeneration && this.deps.identity()?.signedIn
        && this.deps.identity()?.ownerUserId === grant.body.ownerUserId
        && !this.fenced.has(session.connectionId)
        && (this.deps.accountEpoch?.() ?? session.accountEpoch) === session.accountEpoch
        && grant.body.expiresAt > this.now()

      if (!current()) {return null}
      const snapshot = await collect(grant.body)

      return current() ? snapshot : null
    } finally {
      this.collecting = false
      this.collectingGrantId = null
    }
  }

  /** Whether the grant a GUI action belongs to still has authority (the broker re-checks it). */
  grantLive(grantId: string): boolean {
    const grant = this.grants.get(grantId)

    return Boolean(grant && grant.status === 'live' && !this.fenced.has(grant.body.connectionId))
  }

  grantOf(commandId: string): string | null {
    return this.inflight.get(commandId)?.grantId ?? null
  }

  liveGrants(): boolean {
    return this.grants.live().length > 0
  }

  /** The agents whose grants are live (the egress prompt names the agent asking). */
  liveAgentUserIds(): string[] {
    return [...new Set(this.grants.live().map(grant => grant.body.agentUserId))]
  }

  /** The hash a command was admitted under (an upload approval binds to it), or null. */
  commandHashOf(commandId: string): string | null {
    return this.deps.ledger.get(commandId)?.commandHash ?? null
  }

  liveGrantIds(): string[] {
    return this.grants.live().map(grant => grant.body.grantId)
  }

  // ---------------------------------------------------------------- the frame sink

  async frame(frame: DeviceInboundFrameFacts, session: DeviceSessionFacts): Promise<DeviceOutboundFrameFacts[]> {
    switch (frame.type) {
      case 'WorkspaceFinalize':

      case 'WorkspaceConfirm':
        if (frame.verdict === 'ok' && session.workspaceProtocol === 1 && this.deps.workspace) {
          const operation = frame.type === 'WorkspaceFinalize'
            ? this.deps.workspace.finalize(frame.body as unknown as WorkspaceFinalize, session)
            : this.deps.workspace.confirm(frame.body as unknown as WorkspaceConfirm, session)

          void operation.catch(() => this.log('workspace lifecycle failed; copy retained'))
        }

        return []

      case 'TurnGrant':
        return [this.turnGrant(frame, session)]

      case 'ChatGptRelayRequest':
        return this.deps.relay
          ? [{ type: 'ChatGptRelayResponse', body: await this.deps.relay.handle(frame.body, session, frame.verdict) }]
          : [{ type: 'ChatGptRelayResponse', body: {
              capabilityId: typeof frame.body.capabilityId === 'string'
                ? frame.body.capabilityId
                : '00000000-0000-4000-8000-000000000000',
              state: 'refused', status: 403, code: 'relay_disabled'
            } }]

      case 'Execute':
        return this.execute(frame, session)

      case 'Renew':
        this.renew(frame)

        return []

      case 'Cancel':
        this.cancel(frame)

        return []

      default:
        return []
    }
  }

  status(query: { commandIds: string[] }): { receipts: Record<string, unknown>[] } {
    this.deps.connected?.()
    const receipts: Record<string, unknown>[] = []
    let budget = RESULT_BUDGET_BYTES

    for (const commandId of query.commandIds.slice(0, 256)) {
      const record = this.deps.ledger.get(commandId)

      if (!record) {
        continue
      }

      let receipt = receiptOfRecord(record)
      const size = Buffer.byteLength(JSON.stringify(receipt), 'utf8')

      if (size > budget) {
        // Keep the state (what the controller must know) and drop the bulky result.
        const { result: _dropped, ...rest } = receipt
        receipt = record.result?.exitCode === undefined ? rest : { ...rest, result: { exitCode: record.result.exitCode } }
      }

      budget -= Buffer.byteLength(JSON.stringify(receipt), 'utf8')
      receipts.push(receipt)
    }

    return { receipts }
  }

  /**
   * A connection's authority ended. Its grants are dead either way; for sleep, Stop, sign-out, account
   * switch and revocation the fence also kills what is running. A dropped or silent link lets running
   * commands finish: their Receipts wait in the ledger for the next connection's status exchange.
   */
  closed(session: DeviceSessionFacts, reason: DeviceConnectionCloseReason): void {
    this.fenced.add(session.connectionId)

    for (const grant of this.grants.live()) {
      if (grant.body.connectionId === session.connectionId) {
        this.endGrant(grant.body.grantId)
      }
    }

    const fenceReason: Partial<Record<DeviceConnectionCloseReason, StopReason>> = {
      sleep: 'sleep',
      stop: 'local_stop',
      sign_out: 'sign_out',
      account_switch: 'account_switch',
      revoked: 'local_stop',
      unenrolled: 'local_stop'
    }

    const stop = fenceReason[reason]

    if (stop) {
      void this.stop(stop)
    }
  }

  /**
   * The Stop fence. Synchronous before it returns: every grant stops, pending approvals are void, every
   * running command is aborted and its process groups killed. The returned promise is the async tail
   * (the broker closes, marked descendants are swept, and for a local Stop the controller is told).
   */
  stop(reason: StopReason): Promise<void> {
    const grantIds = this.liveGrantIds()
    this.fencing = reason
    const fenced = this.fence.fence(reason)
    this.fencing = null
    // A Stop (and sign-out, account switch, sleep) ends every task approval window.
    this.approvalWindow.clear()
    this.deps.relay?.disable()

    try {
      this.deps.killAllGroups?.()
    } catch {
      // The fence never fails on a group that is already gone.
    }

    for (const grantId of grantIds) {
      this.endGrant(grantId)
    }

    this.deps.audit.record({ decision: 'stopped', summary: reason })

    return (async () => {
      await fenced

      try {
        await this.deps.afterFence?.(reason)
      } catch {
        this.log('fence_cleanup_failed')
      }

      // Sign-out, account switch and sleep close the connection with a signed Stop of their own (WS-3b).
      if (reason === 'local_stop' && grantIds.length) {
        await this.deps
          .send('Stop', { reason, accountEpoch: this.deps.accountEpoch?.() ?? 0, grantIds: grantIds.slice(0, 64) })
          .catch(() => false)
      }
    })()
  }

  // ---------------------------------------------------------------- TurnGrant / Renew / Cancel

  private turnGrant(frame: DeviceInboundFrameFacts, session: DeviceSessionFacts): DeviceOutboundFrameFacts {
    const grantId = typeof frame.body.grantId === 'string' ? frame.body.grantId : ''

    const refuse = (refusal: DeviceRefusal): DeviceOutboundFrameFacts => {
      this.deps.audit.record({ decision: 'refused', grantId, tool: 'grant', summary: refusal })

      return { type: 'GrantAck', body: { grantId, accepted: false, refusal, effectiveScopes: [] } }
    }

    const grant = parseGrant(frame.body)
    const identity = this.deps.identity()

    if (!grant) {
      return refuse('scope')
    }

    if (!identity || !identity.signedIn) {
      return refuse('signed_out')
    }

    if (this.fenced.has(session.connectionId)) {
      return refuse('stale_connection')
    }

    const admission = admitGrant(
      {
        ownerUserId: identity.ownerUserId,
        deviceServiceId: session.deviceServiceId,
        enrollmentEpoch: session.enrollmentEpoch,
        accountEpoch: this.deps.accountEpoch?.() ?? session.accountEpoch,
        connectionId: session.connectionId,
        connectionEpoch: session.connectionEpoch,
        signedIn: identity.signedIn,
        localScopes: identity.localScopes,
        cloudAgents: identity.cloudAgents,
        receivedAt: this.wallAtReceipt(frame.receivedAt)
      },
      grant,
      { signatureValid: frame.verdict === 'ok', kidPinned: frame.verdict !== 'unpinned_controller_key' },
      this.deps.originLog()
    )

    if (admission.outcome === 'refused') {
      return refuse(admission.refusal)
    }

    const now = this.now()
    this.grants.set({
      body: grant,
      status: 'live',
      lastSeq: 0,
      effectiveScopes: admission.effectiveScopes,
      authorityUntil: Math.min(now + DEVICE_TIMINGS.authorityWindowMs, grant.expiresAt)
    })
    this.limiters.set(grant.grantId, new RateLimiter(() => this.now()))
    this.deps.indicator?.grantActive(grant.grantId, grant.agentUserId)
    this.scheduleExpiry(grant)
    this.deps.audit.record({ decision: 'admitted', grantId: grant.grantId, tool: 'grant', capabilities: admission.effectiveScopes })

    return { type: 'GrantAck', body: { grantId: grant.grantId, accepted: true, effectiveScopes: admission.effectiveScopes } }
  }

  private scheduleExpiry(grant: DeviceGrant): void {
    const ms = Math.max(0, grant.expiresAt - this.now())

    const setTimer =
      this.deps.setTimer ??
      ((callback: () => void, delay: number) => {
        const timer = setTimeout(callback, delay)
        timer.unref?.()

        return timer
      })

    this.expiry.set(grant.grantId, setTimer(() => this.endGrant(grant.grantId), ms))
  }

  private endGrant(grantId: string): void {
    const grant = this.grants.get(grantId)

    if (!grant) {
      return
    }

    this.grants.stop(grantId)
    this.deps.executor.releaseGrant?.(grantId)
    const timer = this.expiry.get(grantId)

    if (timer !== undefined) {
      ;(this.deps.clearTimer ?? (value => clearTimeout(value as ReturnType<typeof setTimeout>)))(timer)
      this.expiry.delete(grantId)
    }

    this.acted.delete(grantId)
    this.limiters.delete(grantId)
    this.deps.indicator?.grantEnded(grantId)
  }

  private renew(frame: DeviceInboundFrameFacts): void {
    const grantId = typeof frame.body.grantId === 'string' ? frame.body.grantId : ''
    const until = frame.body.until
    const grant = this.grants.get(grantId)

    if (!grant || frame.verdict !== 'ok' || !Number.isSafeInteger(until)) {
      return
    }

    const evaluation = evaluateRenew({
      receivedAt: this.wallAtReceipt(frame.receivedAt),
      grant: { status: grant.status, expiresAt: grant.body.expiresAt },
      until: until as number,
      kidPinned: true
    })

    if (evaluation.outcome === 'extended') {
      this.grants.extendAuthority(grantId, evaluation.authorityUntil)
    }
  }

  private cancel(frame: DeviceInboundFrameFacts): void {
    if (frame.verdict !== 'ok') {
      return
    }

    const grantId = typeof frame.body.grantId === 'string' ? frame.body.grantId : ''
    const commandId = typeof frame.body.commandId === 'string' ? frame.body.commandId : null

    if (commandId === null && this.collectingGrantId === grantId) {this.approvalGeneration += 1}

    for (const [id, command] of this.inflight) {
      if (command.grantId === grantId && (commandId === null || id === commandId)) {
        command.controller.abort(new Error('device_cancelled'))
      }
    }

    if (commandId === null) {
      this.endGrant(grantId)
    }
  }

  // ---------------------------------------------------------------- Execute

  private refusedReceipt(commandId: string, commandHash: string, seq: number, refusal: DeviceRefusal): DeviceOutboundFrameFacts {
    return { type: 'Receipt', body: { commandId, commandHash, seq, state: 'refused', refusal, artifacts: [] } }
  }

  private async execute(frame: DeviceInboundFrameFacts, session: DeviceSessionFacts): Promise<DeviceOutboundFrameFacts[]> {
    const raw = frame.body

    if (!UUID.test(String(raw.commandId)) || !Number.isSafeInteger(raw.seq)) {
      this.log('dropped an Execute with no command id or seq')

      return []
    }

    const commandId = raw.commandId as string
    const seq = raw.seq as number
    const commandHash = deviceMessageHash('Execute', raw)
    const body = parseExecute(raw)
    const identity = this.deps.identity()

    const refuse = (refusal: DeviceRefusal, record = false): DeviceOutboundFrameFacts[] => {
      if (record && frame.verdict === 'ok' && RECORDED_REFUSALS.has(refusal) && !this.deps.ledger.get(commandId)) {
        try {
          this.deps.ledger.refuse({ commandId, commandHash, grantId: String(raw.grantId), seq, refusal })
        } catch {
          // Not durable: the refusal is still the answer; a re-send is judged afresh.
        }
      }

      this.deps.audit.record({ decision: 'refused', commandHash, grantId: String(raw.grantId), tool: String(raw.tool), summary: refusal })

      return [this.refusedReceipt(commandId, commandHash, seq, refusal)]
    }

    if (this.collecting) {return refuse('paused')}

    if (!body) {
      return refuse('scope')
    }

    if (!identity || !identity.signedIn) {
      return refuse('signed_out')
    }

    const grant = this.grants.get(body.grantId)

    if (!grant || this.fenced.has(session.connectionId) || this.fenced.has(grant.body.connectionId)) {
      // A command for a grant this Mac does not hold, or one a Stop already ended.
      return refuse('stopped', Boolean(grant))
    }

    const limiter = this.limiters.get(body.grantId)

    if (limiter && !limiter.admitExecuteRate()) {
      return refuse('rate_limited', true)
    }

    const seenRecord = this.deps.ledger.get(commandId)
    const standingGrants = this.deps.standingGrants.list().filter(each => each.agent === grant.body.agentUserId)

    const contractAdmission = admitExecute({
      device: {
        deviceServiceId: session.deviceServiceId,
        enrollmentEpoch: session.enrollmentEpoch,
        accountEpoch: this.deps.accountEpoch?.() ?? session.accountEpoch,
        connectionId: session.connectionId,
        connectionEpoch: session.connectionEpoch,
        signedIn: identity.signedIn,
        paused: this.paused(),
        receivedAt: this.wallAtReceipt(frame.receivedAt)
      },
      grant,
      agentUserId: grant.body.agentUserId,
      execute: body,
      commandHash,
      facts: {
        signatureValid: frame.verdict === 'ok',
        kidPinned: frame.verdict !== 'unpinned_controller_key',
        argsHash: argsHash(body.args)
      },
      seen: seenRecord ? [{ commandId, commandHash: seenRecord.commandHash }] : [],
      originLog: this.deps.originLog(),
      standingGrants,
      drive: this.deps.drive?.()
    })

    // The contract admission above stays exactly as device-service/1 specifies it (a protected need with
    // no standing grant is `needs_approval`); how this Mac satisfies that is local policy, decided here.
    const admission =
      contractAdmission.outcome === 'needs_approval'
        ? this.localApprovalPolicy(contractAdmission.capabilities, body, grant, commandHash)
        : contractAdmission

    if (admission.outcome === 'duplicate') {
      this.deps.audit.record({ decision: 'duplicate', commandHash, grantId: body.grantId, tool: body.tool })

      return seenRecord ? [{ type: 'Receipt', body: receiptOfRecord(seenRecord) }] : []
    }

    if (admission.outcome === 'refused') {
      return refuse(admission.refusal, admission.refusal !== 'replayed')
    }

    // From here the command consumed its seq, whatever happens to it.
    this.grants.advanceSeq(body.grantId, body.seq)

    if (admission.outcome === 'needs_approval') {
      if (limiter?.deniedOut()) {
        return refuse('approval_denied', true)
      }

      try {
        this.deps.ledger.begin({ commandId, commandHash, grantId: body.grantId, seq: body.seq })
      } catch {
        return refuse('rate_limited')
      }

      void this.approveThenRun(body, commandHash, grant, admission.capabilities)

      return []
    }

    try {
      this.deps.ledger.begin({ commandId, commandHash, grantId: body.grantId, seq: body.seq })
    } catch {
      return refuse('rate_limited')
    }

    void this.run(body, commandHash, grant.body, admission.relax, admission.approvalHash)

    return []
  }

  /**
   * Local approval policy over the contract's `needs_approval` (owner decision 2026-10-20, overriding the
   * G0 "every protected action asks" design). Capabilities in `SILENT_CAPABILITIES` never prompt; the rest
   * prompt once per agent per task window. Both stay classified (the sandbox lifts them only for a command
   * that names them), audited, and subject to Stop.
   */
  private localApprovalPolicy(
    capabilities: readonly DeviceProtectedCapability[],
    body: ExecuteBody,
    grant: AdmittedGrant,
    commandHash: string
  ): ExecuteAdmission {
    const agent = grant.body.agentUserId
    const silent = capabilities.filter(capability => SILENT_CAPABILITIES.has(capability))
    const remaining: DeviceProtectedCapability[] = []
    const windowed: DeviceProtectedCapability[] = []
    let windowHash: string | undefined

    for (const capability of capabilities) {
      if (SILENT_CAPABILITIES.has(capability)) {
        continue
      }

      const covered = this.approvalWindow.covers(agent, capability)

      if (covered) {
        windowHash ??= covered
        windowed.push(capability)
      } else {
        remaining.push(capability)
      }
    }

    if (remaining.length) {
      return { outcome: 'needs_approval', capabilities: remaining }
    }

    if (silent.length) {
      this.deps.audit.record({ decision: 'approved', commandHash, grantId: body.grantId, tool: body.tool, summary: 'policy_silent', capabilities: silent })
    }

    if (windowed.length) {
      this.deps.audit.record({ decision: 'approved', commandHash, grantId: body.grantId, tool: body.tool, summary: 'task_window', capabilities: windowed })
    }

    return {
      outcome: 'admitted',
      relax: [...classifyExecute({ tool: body.tool, args: body.args, needs: body.needs, proposedEffect: body.proposedEffect }, this.deps.drive?.())],
      ...(windowHash ? { approvalHash: windowHash } : {})
    }
  }

  /** Ask once per uncovered capability (one Touch ID covers the agent's task window), then re-check and run, or refuse. */
  private async approveThenRun(
    body: ExecuteBody,
    commandHash: string,
    grant: AdmittedGrant,
    capabilities: DeviceProtectedCapability[]
  ): Promise<void> {
    const controller = new AbortController()
    const command: InflightCommand = { grantId: body.grantId, controller, approvalGeneration: this.approvalGeneration }
    this.inflight.set(body.commandId, command)
    let approvalHash: string | undefined
    let refusal: DeviceRefusal | null = null
    const agent = grant.body.agentUserId
    const limiter = this.limiters.get(body.grantId)

    try {
      for (const capability of capabilities) {
        this.deps.audit.record({ decision: 'needs_approval', commandHash, grantId: body.grantId, tool: body.tool, capabilities: [capability] })

        // The prompt budget counts sheets actually raised: a command that joins a sheet already up, or is
        // covered by the window, costs none. Checked and taken synchronously with `obtain` below.
        const raisesSheet =
          !this.approvalWindow.covers(agent, capability) &&
          !this.approvalWindow.asking(agent, capability) &&
          !this.approvalWindow.away(agent, capability)

        if (raisesSheet && limiter && !limiter.admitPrompt()) {
          refusal = 'rate_limited'

          break
        }

        const outcome = await this.approvalWindow.obtain(agent, capability, () =>
          this.deps.approve({
            commandHash,
            capability,
            target: commandTarget(body),
            agentUserId: agent
          })
        )

        if (controller.signal.aborted || command.approvalGeneration !== this.approvalGeneration) {
          refusal = 'stopped'

          break
        }

        if (outcome.outcome !== 'approved') {
          // Only a refusal counts toward the turn's auto-refuse floor: an owner who was not at the Mac
          // has refused nothing, and must not lock the agent out of asking again when they are back.
          if (outcome.leader && outcome.reason !== 'approval_timeout') {
            limiter?.recordDenial()
          }

          refusal =
            outcome.reason === 'approval_timeout'
              ? 'approval_timeout'
              : outcome.reason === 'unavailable'
                ? 'protected_needs_approval'
                : 'approval_denied'
          this.deps.audit.record({ decision: refusal === 'approval_timeout' ? 'approval_timeout' : 'approval_denied', commandHash, grantId: body.grantId, capabilities: [capability] })

          break
        }

        approvalHash ??= outcome.approvalHash
        this.deps.audit.record({ decision: 'approved', commandHash, grantId: body.grantId, capabilities: [capability], ...(outcome.fromWindow ? { summary: 'task_window' } : {}) })
      }

    // Authority may have moved while the sheet was up: re-check everything but the delivery window.
      const current = this.grants.get(body.grantId)

      if (!refusal && (!current || current.status !== 'live' || this.fenced.has(current.body.connectionId))) {
        refusal = 'stopped'
      }

      if (!refusal && current && current.authorityUntil < this.now()) {
        refusal = 'expired'
      }

      if (!refusal && !this.deps.identity()?.signedIn) {
        refusal = 'signed_out'
      }
    } finally {
      this.inflight.delete(body.commandId)
    }

    if (refusal) {
      this.finishRefused(body, commandHash, refusal)

      return
    }

    // Every capability the command touches is now covered (standing grant or this approval).
    const relax = [...classifyExecute({ tool: body.tool, args: body.args, needs: body.needs, proposedEffect: body.proposedEffect }, this.deps.drive?.())]
    await this.run(body, commandHash, grant.body, relax, approvalHash)
  }

  private finishRefused(body: ExecuteBody, commandHash: string, refusal: DeviceRefusal): void {
    let record: LedgerRecord | undefined

    try {
      record = this.deps.ledger.finish(body.commandId, { state: 'refused', refusal, endedAt: this.now() })
    } catch {
      record = undefined
    }

    const receipt = record
      ? receiptOfRecord(record)
      : { commandId: body.commandId, commandHash, seq: body.seq, state: 'refused', refusal, artifacts: [] }

    void this.deps.send('Receipt', receipt).catch(() => false)
  }

  /** Intent → spawn → terminal state → artifacts → Receipt, with the abort wired to the fence. */
  private async run(
    body: ExecuteBody,
    commandHash: string,
    grant: DeviceGrant,
    relax: DeviceProtectedCapability[],
    approvalHash?: string
  ): Promise<void> {
    const startedAt = this.now()

    try {
      this.deps.ledger.start(body.commandId, { ...(approvalHash ? { approvalHash } : {}), startedAt })
    } catch {
      // Not durable: never spawn. Report no effect (and try to record it).
      let record: LedgerRecord | undefined

      try {
        record = this.deps.ledger.finish(body.commandId, { state: 'failed_no_effect', endedAt: this.now() })
      } catch {
        record = undefined
      }

      void this.deps
        .send('Receipt', record ? receiptOfRecord(record) : { commandId: body.commandId, commandHash, seq: body.seq, state: 'failed_no_effect', artifacts: [] })
        .catch(() => false)

      return
    }

    const controller = new AbortController()
    this.inflight.set(body.commandId, { grantId: body.grantId, controller, approvalGeneration: this.approvalGeneration })

    if (!this.acted.has(body.grantId)) {
      this.acted.add(body.grantId)
      this.deps.indicator?.firstAction(body.grantId, grant.agentUserId)
    }

    this.deps.audit.record({ decision: 'admitted', commandHash, grantId: body.grantId, tool: body.tool, capabilities: relax })

    const watchdog = setTimeout(() => controller.abort(new Error('device_timeout')), body.timeoutMs + WATCHDOG_GRACE_MS)
    watchdog.unref?.()

    let state: DeviceLedgerState = 'unknown'
    let result: { exitCode?: number; output?: string; data?: unknown } = {}
    let artifacts: DeviceArtifact[] = []

    try {
      for await (const step of this.deps.executor.run(
        {
          commandId: body.commandId,
          grantId: body.grantId,
          seq: body.seq,
          tool: body.tool,
          args: body.args,
          argsHash: body.argsHash,
          inputManifestHash: body.inputManifestHash,
          needs: relax,
          proposedEffect: body.proposedEffect,
          timeoutMs: body.timeoutMs
        },
        { grant, paused: () => this.paused(), signal: controller.signal }
      )) {
        if (step.kind === 'receipt') {
          state = step.state
          result = step.result ?? {}
          artifacts = step.artifacts
        }
      }
    } catch {
      state = 'unknown'
    } finally {
      clearTimeout(watchdog)
      this.inflight.delete(body.commandId)
    }

    // A command stopped while it ran may have had part of its effect.
    if (controller.signal.aborted && state === 'completed') {
      state = 'unknown'
    }

    if (state !== 'completed' && state !== 'failed_no_effect' && state !== 'unknown') {
      state = 'unknown'
    }

    const terminal = state as 'completed' | 'failed_no_effect' | 'unknown'
    const ledgerArtifacts = artifacts.map(each => ({ name: each.name, size: each.size, sha256: each.sha256 }))
    let record: LedgerRecord | undefined

    try {
      record = this.deps.ledger.finish(body.commandId, { state: terminal, result, artifacts: ledgerArtifacts, endedAt: this.now() })
    } catch {
      // The Receipt still tells the truth; after a crash the record reconciles to `unknown`.
      record = undefined
    }

    try {
      if (terminal === 'completed') {
        for (const artifact of artifacts) {
          if (!(await this.deps.sendArtifact?.(body.commandId, artifact))) {
            break
          }
        }
      }

      const receipt = record
        ? receiptOfRecord(record)
        : {
            commandId: body.commandId,
            commandHash,
            seq: body.seq,
            state: terminal,
            ...(Object.keys(result).length ? { result } : {}),
            artifacts: ledgerArtifacts,
            ...(approvalHash ? { approvalHash } : {}),
            startedAt,
            endedAt: this.now()
          }

      await this.deps.send('Receipt', receipt).catch(() => false)
    } finally {
      for (const artifact of artifacts) {
        this.deps.discardArtifact?.(artifact)
      }
    }
  }
}
