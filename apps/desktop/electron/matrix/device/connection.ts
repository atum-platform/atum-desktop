/**
 * The device service's one outbound connection to the controller's device hub (S1 WS-3b; contract
 * `atum.device-service/1`: envelopes, the connection state machine, timings).
 *
 *   closed → hello_sent → challenged → ready → status_exchanged
 *
 * - **Hello** (identity-signed): this service, its enrollment and account epochs, this boot, a
 *   fresh connection nonce, the policy and app versions, the Matrix device, and what this Mac can
 *   do right now.
 * - **Challenge** (controller-signed, pinned key): echoes `helloHash`. **Proof** (identity-signed)
 *   answers it. **Ready** (controller-signed) names the connection and its epoch.
 * - **Status first:** the controller's first frame on a new connection is `StatusQuery`, which the
 *   device answers from its ledger before anything else. Nothing is ever replayed: a command the
 *   hub sends before that exchange is never handed on, and the connection is dropped.
 * - Every later controller frame is checked here against the pinned controller keys and handed,
 *   with its verdict, to the device service's admission order (WS-4, `DeviceFrameSink`). `Revoke`
 *   is applied to the enrollment here.
 * - **Sleep** (`suspend`) bumps the local generation synchronously and closes the socket: grants on
 *   the old connection are dead, and the next connection exchanges statuses first. **Stop**,
 *   sign-out and account switch close it for good until started again.
 * - **Dead links:** while a grant is live, 30 s without a controller frame (Renew comes every 5 s)
 *   ends the connection. An idle link carries no frames, so it ends only when its socket closes or
 *   errors (the hub terminates a link that misses its pings); idle silence is never a reason.
 * - **Changed facts:** the hub knows what this Mac can do only from its Hello, so an idle link whose
 *   Hello facts changed (the device runtime came up, the computer-use driver was installed) closes
 *   and dials once with the new ones when `start()` is next called; never while a grant is live.
 * - Reconnects back off from 1 s to 30 s. Production builds dial only
 *   `wss://devices.atumplatform.com/v1`; a build compiled with a loopback hub (the local tunnel
 *   fallback, before the tunnel exists) may dial `ws://127.0.0.1:<port>/v1`.
 *
 * The controller signs Ed25519; the device signs ES256 through the Secure Enclave. Signatures prove
 * where a frame came from, not what the owner wants: authority stays with the device's own
 * admission order and the owner's approvals.
 */
import { randomBytes } from 'node:crypto'

import { parseFrame } from '../../../../../packages/device-protocol'
import { helloSourceStatus, type MacSourceStatus } from '../../../../../packages/device-protocol/messages'

import {
  b64u,
  canonicalJson,
  deviceMessageHash,
  deviceSignedBytes,
  type DeviceSigner,
  verifyControllerSignature
} from './device-key'
import type { DeviceEnrollmentRecord, RevokeOutcome } from './enrollment'
import type { DeviceEpochs } from './epochs'
import type { OriginReceiptBody } from './origin'

const OPEN = 1
/** A repeating Secure Enclave failure is logged this often (the first one always is). */
const KEY_FAILURE_LOG_EVERY = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RAND32 = /^[A-Za-z0-9_-]{43}$/

export const DEVICE_HUB_URL = 'wss://devices.atumplatform.com/v1'

export const DEVICE_CONNECTION = {
  preauthMs: 10_000,
  heartbeatMs: 5_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
  /**
   * A live grant is renewed every 5 s; this long without any frame means the link is dead. Only
   * a live grant is watched this way: while idle the controller sends no frames at all (its
   * liveness check is a WebSocket ping, which the socket answers without surfacing it), so an
   * idle link stays up until the socket itself closes or errors. Redialling an idle link would
   * need a Secure Enclave signature, which a locked Mac cannot give.
   */
  grantSilenceMs: 30_000,
  maxFrameBytes: 1_048_576,
  receiptsPerFlush: 32,
  /** A StatusQuery names at most this many commands (`status_max_commands`). */
  statusMaxCommands: 256,
  /** `artifact_max_bytes` (the chat attachment limit) and `artifacts_max`. */
  artifactMaxBytes: 8_388_608,
  artifactsMax: 16,
  /** The largest chunk `artifact_chunk.header.size` allows. */
  artifactChunkMaxBytes: 1_048_000
} as const

/** Room left in a frame for the envelope around a body (`v`, `type`, `kid`, `sig`, punctuation). */
export const DEVICE_ENVELOPE_HEADROOM_BYTES = 4096

/** The largest body (UTF-8 JSON) a device text frame carries and still fits the hub's 1 MiB. */
export const DEVICE_FRAME_BODY_MAX_BYTES = DEVICE_CONNECTION.maxFrameBytes - DEVICE_ENVELOPE_HEADROOM_BYTES

const frameBodyBytes = (body: unknown): number => Buffer.byteLength(JSON.stringify(body), 'utf8')

/** A receipt without its result's `output` and `data` (unchanged when it has neither). */
function withoutOutput(receipt: Record<string, unknown>): Record<string, unknown> {
  const result = receipt.result as Record<string, unknown> | undefined

  if (!result || typeof result !== 'object' || (result.output === undefined && result.data === undefined)) {
    return receipt
  }

  const { output: _output, data: _data, ...rest } = result

  return { ...receipt, result: rest }
}

export interface DeviceStatusPlan {
  /** Sent first: every receipt the ledger gave, in order, trimmed until the frame fits. */
  status: { receipts: Record<string, unknown>[] }
  /** Sent right after, one Receipt frame each: the whole receipts the Status trimmed. */
  followUps: Record<string, unknown>[]
}

/**
 * The answer to a StatusQuery that always fits one frame. A command the Status leaves out counts as
 * never received (the controller may retry it, and an effect could repeat), so no receipt is ever
 * dropped: the largest lose their `output` and `data` (state, hash, seq, exit code and artifacts
 * stay) until the body fits, and each trimmed receipt follows whole as its own Receipt frame.
 */
export function deviceStatusPlan(
  receipts: readonly Record<string, unknown>[],
  maxBodyBytes = DEVICE_FRAME_BODY_MAX_BYTES
): DeviceStatusPlan {
  // A receipt too large for any frame on its own travels without its output, even as a follow-up.
  const whole = receipts.map(receipt => (frameBodyBytes(receipt) <= maxBodyBytes ? receipt : withoutOutput(receipt)))
  const fitted = [...whole]
  const sizes = fitted.map(frameBodyBytes)
  // JSON of an array is its elements' JSON joined by commas, so each change below is exact.
  let size = frameBodyBytes({ receipts: fitted })
  const followUps: Record<string, unknown>[] = []

  for (const index of fitted.map((_, at) => at).sort((a, b) => sizes[b]! - sizes[a]!)) {
    if (size <= maxBodyBytes) {
      break
    }

    const lean = withoutOutput(whole[index]!)

    if (lean === whole[index]) {
      continue
    }

    size -= sizes[index]! - frameBodyBytes(lean)
    fitted[index] = lean
    followUps.push(whole[index]!)
  }

  return { status: { receipts: fitted }, followUps }
}

/**
 * The binary frames that carry one artifact of a Receipt (`device_send_file`): big-endian
 * `u16 headerLength || utf8(canonicalJson({commandId, name, offset, size})) || bytes`, each within
 * the hub's 1 MiB. Chunks are unsigned; the controller accepts the bytes only when their size and
 * SHA-256 equal the artifact this Mac signs in the Receipt that follows them. An empty file has no
 * chunks.
 */
export function deviceArtifactFrames(commandId: string, name: string, bytes: Uint8Array): Uint8Array[] {
  if (
    !UUID.test(commandId) ||
    typeof name !== 'string' ||
    !name ||
    Array.from(name).length > 255 ||
    bytes.byteLength > DEVICE_CONNECTION.artifactMaxBytes
  ) {
    throw new Error('device_artifact_invalid')
  }

  const header = (offset: number, size: number) => Buffer.from(canonicalJson({ commandId, name, offset, size }), 'utf8')

  // The largest header this artifact can have, so every frame fits.
  const overhead = 2 + header(DEVICE_CONNECTION.artifactMaxBytes, DEVICE_CONNECTION.artifactChunkMaxBytes).length

  const chunk = Math.max(
    1,
    Math.min(DEVICE_CONNECTION.artifactChunkMaxBytes, DEVICE_CONNECTION.maxFrameBytes - overhead)
  )

  const frames: Uint8Array[] = []

  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    const slice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunk))
    const encoded = header(offset, slice.byteLength)

    if (encoded.length > 0xffff) {
      throw new Error('device_artifact_invalid')
    }

    frames.push(Buffer.concat([Buffer.from([encoded.length >> 8, encoded.length & 0xff]), encoded, slice]))
  }

  return frames
}

/**
 * The hub this build dials. `compiled` is the URL baked in at build time (`ATUM_DEVICE_HUB_URL`);
 * only a loopback `ws://127.0.0.1:<port>/v1` (or `localhost`) is honoured, for the SSM
 * port-forward. Anything else, and every production build, dials the production hub.
 */
export function deviceHubUrl(compiled?: string): string {
  if (compiled) {
    try {
      const url = new URL(compiled)

      if (
        url.protocol === 'ws:' &&
        (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
        url.port &&
        url.pathname === '/v1' &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password
      ) {
        return url.href
      }
    } catch {
      // Not a URL: the production hub.
    }
  }

  return DEVICE_HUB_URL
}

export type DeviceConnectionState = 'closed' | 'hello_sent' | 'challenged' | 'ready' | 'status_exchanged'

export type DeviceCloseReason =
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

/** How a controller frame's signature checked out against the pinned keys. */
export type FrameVerdict = 'ok' | 'bad_signature' | 'unpinned_controller_key'

/** The status-exchanged connection a frame arrived on. */
export interface DeviceSession {
  sourceProtocol?: 1
  workspaceProtocol?: 1
  connectionId: string
  connectionEpoch: number
  /** The local generation it was made under (sleep makes it stale). */
  localGeneration: number
  deviceServiceId: string
  enrollmentEpoch: number
  accountEpoch: number
}

export interface DeviceInboundFrame {
  type: 'TurnGrant' | 'Execute' | 'Renew' | 'Cancel' | 'WorkspaceFinalize' | 'WorkspaceConfirm'
  body: Record<string, unknown>
  kid: string
  verdict: FrameVerdict
  /** Monotonic receipt time (ms), for `admitBy` (admission step 8). */
  receivedAt: number
}

export type DeviceOutboundType = 'GrantAck' | 'Receipt' | 'Status' | 'Stop' | 'OriginReceipt' | 'WorkspaceResult' | 'WorkspaceRefused'

export interface DeviceOutboundFrame {
  type: DeviceOutboundType
  body: Record<string, unknown>
}

export interface DeviceStatusAnswer {
  receipts: Record<string, unknown>[]
  artifacts?: { commandId: string; name: string; bytes: Uint8Array }[]
}

/**
 * The device service (WS-4) behind the connection: the §3.3 admission order, the ledger, the
 * grants. `frame` must return quickly (admission, not execution); a command's Receipt goes out
 * later through `DeviceConnection.send`.
 */
export interface DeviceFrameSink {
  frame(
    frame: DeviceInboundFrame,
    session: DeviceSession
  ): DeviceOutboundFrame[] | void | Promise<DeviceOutboundFrame[] | void>
  /**
   * The ledger's receipts for a reconnect's StatusQuery (the connection trims them to fit a frame).
   * `artifacts`: the bytes of a `device_send_file` receipt in it, sent again after the Status (the
   * controller restarts an artifact at offset 0, as after any reconnect).
   */
  status(query: { commandIds: string[] }, session: DeviceSession): DeviceStatusAnswer | Promise<DeviceStatusAnswer>
  /** The connection's authority ended: every grant on it is dead. */
  closed(session: DeviceSession, reason: DeviceCloseReason): void
  /** Whether a grant is live (the controller then renews every 5 s). */
  liveGrants?(): boolean
  /** The live grants a device `Stop` names (sleep, sign-out, account switch, local Stop). */
  liveGrantIds?(): string[]
}

/**
 * Until the device runtime (WS-4) is attached, this Mac offers nothing: every grant and every
 * command is refused, definitively, so the controller never waits on it.
 */
export const refusingDeviceSink: DeviceFrameSink = {
  frame(frame) {
    if (frame.type === 'TurnGrant' && typeof frame.body.grantId === 'string') {
      return [
        {
          type: 'GrantAck',
          body: { grantId: frame.body.grantId, accepted: false, refusal: 'scope', effectiveScopes: [] }
        }
      ]
    }

    if (frame.type === 'Execute' && typeof frame.body.commandId === 'string' && Number.isSafeInteger(frame.body.seq)) {
      return [
        {
          type: 'Receipt',
          body: {
            commandId: frame.body.commandId,
            commandHash: deviceMessageHash('Execute', frame.body),
            seq: frame.body.seq as number,
            state: 'refused',
            refusal: frame.verdict === 'ok' ? 'scope' : frame.verdict,
            artifacts: []
          }
        }
      ]
    }
  },
  status: () => ({ receipts: [] }),
  closed: () => {}
}

/** The WHATWG WebSocket subset the connection uses (Electron main's global `WebSocket`). */
export interface DeviceSocket {
  readonly readyState: number
  readonly bufferedAmount?: number
  /** Text frames carry envelopes; binary frames carry only artifact chunks. */
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type DeviceSocketFactory = (url: string) => DeviceSocket

/** The device `Stop` reason for each local close; other closes send none. */
const STOP_REASONS: Partial<Record<DeviceCloseReason, 'local_stop' | 'sign_out' | 'account_switch' | 'sleep'>> = {
  stop: 'local_stop',
  sign_out: 'sign_out',
  account_switch: 'account_switch',
  sleep: 'sleep'
}

function close(socket: DeviceSocket, reason: string): void {
  try {
    socket.close(1000, reason)
  } catch {
    // Already closed.
  }
}

/** The WebSocket close code of a close event, as a closed code (never the peer's reason text). */
function socketCloseCode(event: unknown): string {
  const code = (event as { code?: unknown } | null)?.code

  return Number.isInteger(code) && (code as number) >= 1000 && (code as number) <= 4999 ? `close_${code}` : 'close'
}

/**
 * The Hello facts as one comparable string. Built field by field (not canonical JSON) because the
 * facts may carry `undefined` (no workspace protocol yet), and it is compared, never sent.
 */
function helloFactsKey(facts: DeviceHelloFacts): string {
  const { terminal, files, computer } = facts.capabilities

  return JSON.stringify([
    facts.workspaceProtocol === 1 ? 1 : 0,
    facts.sourceProtocol ?? null,
    facts.sources ? [facts.sources.messages, facts.sources.browser, facts.sources.location, facts.sources.folders] : null,
    facts.policyVersion,
    facts.appVersion,
    Boolean(terminal),
    Boolean(files),
    Boolean(computer.available),
    computer.reason ?? null
  ])
}

const CONTROLLER_TYPES = new Set([
  'Challenge',
  'Ready',
  'TurnGrant',
  'Execute',
  'Renew',
  'StatusQuery',
  'Cancel',
  'Revoke',
  'WorkspaceFinalize',
  'WorkspaceConfirm',
])

export interface DeviceHelloFacts {
  sourceProtocol?: 1
  sources?: MacSourceStatus
  workspaceProtocol?: 1
  policyVersion: number
  appVersion: string
  capabilities: { terminal: boolean; files: boolean; computer: { available: boolean; reason?: string } }
}

export interface DeviceConnectionDeps {
  url: string
  socket?: DeviceSocketFactory
  enrollment: {
    current(): DeviceEnrollmentRecord | null
    controllerKey(kid: string): string | null
    applyRevoke(body: { deviceServiceId: string; enrollmentEpoch: number; revokeSeq: number }): RevokeOutcome
  }
  signer: Pick<DeviceSigner, 'signIdentity'>
  epochs: Pick<DeviceEpochs, 'accountEpoch' | 'bootId' | 'localGeneration' | 'bumpLocalGeneration'>
  hello(): DeviceHelloFacts
  sink?: DeviceFrameSink
  origin?: { unreceipted(limit?: number): OriginReceiptBody[]; receipted(receipts: OriginReceiptBody[]): void }
  now?(): number
  monotonic?(): number
  random?(): number
  setTimer?(callback: () => void, ms: number): unknown
  clearTimer?(timer: unknown): void
  log?(line: string): void
}

interface Attempt {
  sourceOffered?: boolean
  workspaceOffered?: boolean
  /** What this Mac said it can do in this attempt's Hello (`helloFactsKey`). */
  factsKey?: string
  socket: DeviceSocket
  generation: number
  record: DeviceEnrollmentRecord
  helloHash?: string
  connectionId?: string
  session?: DeviceSession
}

export class DeviceConnection {
  private helloFallback?: { factsKey: string; until: number; source: boolean; workspace: boolean }
  private current?: Attempt
  private connectionState: DeviceConnectionState = 'closed'
  private wanted = false
  private suspended = false
  private failures = 0
  private keyFailures = 0
  private lastKeyFailure = ''
  private generation = 0
  private sink: DeviceFrameSink
  private processing: Promise<void> = Promise.resolve()
  private readonly timers = new Map<'retry' | 'preauth' | 'silence' | 'helloFallback', unknown>()
  private readonly listeners = new Set<(state: DeviceConnectionState, reason?: DeviceCloseReason) => void>()
  private lastClose?: DeviceCloseReason

  constructor(private readonly deps: DeviceConnectionDeps) {
    this.sink = deps.sink ?? refusingDeviceSink
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private monotonic(): number {
    return this.deps.monotonic?.() ?? performance.now()
  }

  private log(line: string): void {
    this.deps.log?.(`[Device] ${line}`)
  }

  private timer(name: 'retry' | 'preauth' | 'silence' | 'helloFallback', ms: number | null, callback?: () => void): void {
    const existing = this.timers.get(name)

    if (existing !== undefined) {
      ;(this.deps.clearTimer ?? (value => clearTimeout(value as ReturnType<typeof setTimeout>)))(existing)
      this.timers.delete(name)
    }

    if (ms !== null && callback) {
      const handle = (
        this.deps.setTimer ??
        ((fn, delay) => {
          const value = setTimeout(fn, delay)
          value.unref?.()

          return value
        })
      )(callback, ms)

      this.timers.set(name, handle)
    }
  }

  state(): DeviceConnectionState {
    return this.connectionState
  }

  /** The status-exchanged connection, or null. */
  session(): DeviceSession | null {
    return this.connectionState === 'status_exchanged' ? (this.current?.session ?? null) : null
  }

  /** Why the last connection closed (for presence and diagnostics). */
  closeReason(): DeviceCloseReason | undefined {
    return this.lastClose
  }

  onState(listener: (state: DeviceConnectionState, reason?: DeviceCloseReason) => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  private enter(state: DeviceConnectionState, reason?: DeviceCloseReason): void {
    this.connectionState = state

    for (const listener of [...this.listeners]) {
      try {
        listener(state, reason)
      } catch {
        // A listener's failure never changes the connection.
      }
    }
  }

  /** WS-4's device service takes over admission from the refusing default. */
  attach(sink: DeviceFrameSink): void {
    this.sink = sink
  }

  /**
   * Dial (and keep dialling) while enrolled. On a link that is already up, re-announce this Mac
   * once if what it can do changed since its Hello (`refreshHello`); callers run this when the
   * device runtime comes up and every minute while a cloud agent needs the link.
   */
  start(): void {
    this.wanted = true
    this.suspended = false

    if (!this.current && this.timers.get('retry') === undefined) {
      this.dial()

      return
    }

    // In frame order: a TurnGrant already received is admitted (and so keeps the link) first.
    const attempt = this.current

    if (attempt) {
      this.queue(attempt, async () => this.refreshHello(attempt))
    }
  }

  /**
   * The hub learns what this Mac can do (terminal, files, computer, workspace) only from a Hello.
   * An idle link that came up before the device runtime was ready, or before the computer-use
   * driver was installed, would otherwise keep telling cloud agents the old answer for as long as
   * it lives. So an idle, status-exchanged link whose facts changed closes and dials once with the
   * new ones. Never while a grant is live: that turn keeps its link, and the next call after it
   * ends does the redial.
   */
  private refreshHello(attempt: Attempt): void {
    if (
      this.current !== attempt ||
      this.connectionState !== 'status_exchanged' ||
      attempt.factsKey === undefined ||
      this.grantsLive()
    ) {
      return
    }

    let key: string

    try {
      key = helloFactsKey(this.deps.hello())
    } catch {
      return
    }

    if (key === attempt.factsKey) {
      return
    }

    this.logClose('drop', 'hello_changed')
    this.teardown('drop')
    this.failures = 0
    this.timer('retry', null)
    this.dial()
  }

  /**
   * Stop, sign-out, account switch or revocation: closed now, synchronously, until started again.
   * For a local Stop, sign-out or account switch the controller is told with a signed `Stop`
   * (best effort, after the fence: nothing more is received or admitted on this connection).
   */
  stop(reason: DeviceCloseReason = 'stop'): void {
    this.wanted = false
    this.timer('retry', null)
    this.logClose(reason)
    this.teardown(reason)
  }

  /** Sleep: the local generation moves on before anything else, then the connection closes. */
  suspend(): void {
    this.deps.epochs.bumpLocalGeneration()
    this.suspended = true
    this.timer('retry', null)
    this.logClose('sleep')
    this.teardown('sleep')
  }

  /** One closed-code line for a teardown that has no detail of its own (fail() logs its own). */
  private logClose(reason: DeviceCloseReason, code?: string): void {
    if (this.current) {
      this.log(`connection closed (${reason})${code ? `: ${code}` : ''}`)
    }
  }

  /** Wake: dial now; the new connection exchanges statuses before any command. */
  resume(): void {
    this.suspended = false
    this.failures = 0

    if (this.wanted && !this.current) {
      this.timer('retry', null)
      this.dial()
    }
  }

  /**
   * Sends one device-signed frame on the status-exchanged connection (Stop also while `ready`).
   * False when there is no such connection or it changed while signing.
   */
  async send(type: DeviceOutboundType, body: Record<string, unknown>): Promise<boolean> {
    const attempt = this.current

    if (
      !attempt ||
      !(this.connectionState === 'status_exchanged' || (type === 'Stop' && this.connectionState === 'ready'))
    ) {
      return false
    }

    if (type.startsWith('Workspace') && attempt.session?.workspaceProtocol !== 1) {return false}


    return this.sendOn(attempt, type, body)
  }

  /** Bound to the session that accepted the offer; a reconnect cannot receive its old bytes. */

  /**
   * Sends one artifact's bytes as binary chunk frames on the status-exchanged connection, before
   * the Receipt that names it (`device_send_file`). False when there is no such connection; throws
   * for an artifact the contract refuses (over 8 MiB, a bad name).
   */
  sendArtifact(commandId: string, name: string, bytes: Uint8Array): boolean {
    const frames = deviceArtifactFrames(commandId, name, bytes)
    const attempt = this.current

    if (!attempt || this.connectionState !== 'status_exchanged' || attempt.socket.readyState !== OPEN) {
      return false
    }

    for (const frame of frames) {
      attempt.socket.send(frame)
    }

    return true
  }

  /** Offers the controller every origin receipt it has not had yet (best effort). */
  async flushOriginReceipts(): Promise<void> {
    const receipts = this.deps.origin?.unreceipted(DEVICE_CONNECTION.receiptsPerFlush) ?? []
    const sent: OriginReceiptBody[] = []

    for (const receipt of receipts) {
      if (!(await this.send('OriginReceipt', { ...receipt }))) {
        break
      }

      sent.push(receipt)
    }

    this.deps.origin?.receipted(sent)
  }

  private async sendOn(attempt: Attempt, type: string, given: Record<string, unknown>): Promise<boolean> {
    // A Receipt too large for a frame goes without its output and data (the controller then has
    // the state and its hash, not the words) rather than not at all, which would stall the turn.
    const body =
      type === 'Receipt' && frameBodyBytes(given) > DEVICE_FRAME_BODY_MAX_BYTES ? withoutOutput(given) : given

    if (body !== given) {
      this.log('a receipt went without its output: over 1 MiB')
    }

    const bytes = deviceSignedBytes(type, body)
    const signature = await this.deps.signer.signIdentity(bytes)

    if (this.current !== attempt || attempt.generation !== this.generation || attempt.socket.readyState !== OPEN) {
      return false
    }

    if (signature.kid !== attempt.record.identityKid) {
      this.log(`refused to send ${type}: the identity key changed`)

      return false
    }

    const frame = JSON.stringify({ v: 1, type, body, kid: signature.kid, sig: signature.sig })

    // The hub closes a connection on an oversized frame (1009), and the Mac would only send it again.
    if (Buffer.byteLength(frame, 'utf8') > DEVICE_CONNECTION.maxFrameBytes) {
      this.log(`refused to send ${type}: over 1 MiB`)

      return false
    }

    attempt.socket.send(frame)

    return true
  }

  private dial(): void {
    if (!this.wanted || this.suspended || this.current) {
      return
    }

    const record = this.deps.enrollment.current()

    if (!record || record.state !== 'active') {
      this.lastClose = 'unenrolled'

      return
    }

    let socket: DeviceSocket

    try {
      socket = (this.deps.socket ?? (url => new globalThis.WebSocket(url) as unknown as DeviceSocket))(this.deps.url)
    } catch {
      this.scheduleRetry()

      return
    }

    const attempt: Attempt = { socket, generation: ++this.generation, record }
    this.current = attempt
    this.timer('preauth', DEVICE_CONNECTION.preauthMs, () =>
      this.fail(attempt, 'protocol', 'not ready before the pre-auth deadline')
    )

    socket.onopen = () => {
      if (this.current === attempt) {
        this.queue(attempt, () => this.hello(attempt))
      }
    }

    socket.onmessage = event => {
      if (this.current !== attempt) {
        return
      }

      // Only text frames carry envelopes; the controller never sends binary.
      if (typeof event.data !== 'string') {
        return
      }

      if (event.data.length > DEVICE_CONNECTION.maxFrameBytes) {
        this.fail(attempt, 'protocol', 'frame over 1 MiB')

        return
      }

      const raw = event.data
      const receivedAt = this.monotonic()
      this.queue(attempt, () => this.receive(attempt, raw, receivedAt))
    }

    socket.onclose = event => {
      if (this.current === attempt) {
        // Only an explicit schema rejection can identify an incompatible Hello.
        if (socketCloseCode(event) === 'close_4400' && this.connectionState === 'hello_sent' &&
          (attempt.sourceOffered || attempt.workspaceOffered) && attempt.factsKey) {
          this.helloFallback = { factsKey: attempt.factsKey, until: this.monotonic() + 300_000,
            source: true, workspace: !attempt.sourceOffered }
          this.timer('helloFallback', 300_000, () => { this.helloFallback = undefined })
        }

        this.logClose('drop', socketCloseCode(event))
        this.teardown('drop')
        this.scheduleRetry()
      }
    }

    socket.onerror = () => {
      if (this.current === attempt) {
        this.logClose('drop', 'socket_error')
        this.teardown('drop')
        this.scheduleRetry()
      }
    }
  }

  /** Frames are handled one at a time, in order; work for a closed attempt is dropped. */
  private queue(attempt: Attempt, work: () => Promise<void>): void {
    this.processing = this.processing.then(async () => {
      if (this.current !== attempt || attempt.generation !== this.generation) {
        return
      }

      try {
        await work()
      } catch (error) {
        this.fail(attempt, 'protocol', this.failureText(error))
      }
    })
  }

  /**
   * What a failed frame handler logs. A Secure Enclave failure used to read only `device_key_failed`;
   * it now carries the helper's own cause (`DeviceKeyError.detail`), and the same cause repeating
   * (a locked Mac retries every few seconds for hours) is logged on the first occurrence and then
   * every {@link KEY_FAILURE_LOG_EVERY}th, with its count.
   */
  private failureText(error: unknown): string {
    if (!(error instanceof Error)) {
      return 'unexpected'
    }

    const detail = (error as { detail?: unknown }).detail

    if (typeof detail !== 'string' || !detail) {
      return error.message
    }

    const text = `${error.message} [${detail}]`

    this.keyFailures = text === this.lastKeyFailure ? this.keyFailures + 1 : 1
    this.lastKeyFailure = text

    return this.keyFailures === 1 || this.keyFailures % KEY_FAILURE_LOG_EVERY === 0
      ? `${text}${this.keyFailures > 1 ? ` (x${this.keyFailures})` : ''}`
      : ''
  }

  private async hello(attempt: Attempt): Promise<void> {
    const facts = this.deps.hello()

    // The facts as given, not as offered: a legacy hub's narrower Hello is not a change to redial for.
    attempt.factsKey = helloFactsKey(facts)

    if (this.helloFallback && (this.helloFallback.factsKey !== attempt.factsKey ||
      this.monotonic() >= this.helloFallback.until)) {
      this.helloFallback = undefined
      this.timer('helloFallback', null)
    }

    attempt.workspaceOffered = facts.workspaceProtocol === 1 && !this.helloFallback?.workspace
    attempt.sourceOffered = facts.sourceProtocol === 1 && Boolean(helloSourceStatus(facts)) && !this.helloFallback?.source

    const body = {
      ...(attempt.workspaceOffered && facts.workspaceProtocol === 1 ? { workspaceProtocol: 1 as const } : {}),
      ...(attempt.sourceOffered ? { sourceProtocol: 1 as const, sources: facts.sources } : {}),
      deviceServiceId: attempt.record.deviceServiceId,
      enrollmentEpoch: attempt.record.enrollmentEpoch,
      accountEpoch: this.deps.epochs.accountEpoch(),
      bootId: this.deps.epochs.bootId(),
      connectionNonce: b64u(randomBytes(32)),
      policyVersion: facts.policyVersion,
      appVersion: facts.appVersion,
      matrixDeviceId: attempt.record.matrixDeviceId,
      capabilities: facts.capabilities,
      sentAt: this.now()
    }

    attempt.helloHash = deviceMessageHash('Hello', body)

    if (await this.sendOn(attempt, 'Hello', body)) {
      this.enter('hello_sent')
    }
  }

  private verdict(
    attempt: Attempt,
    type: string,
    body: Record<string, unknown>,
    kid: string,
    sig: string
  ): FrameVerdict {
    if (!attempt.record.pinnedControllerKeys.includes(kid)) {
      return 'unpinned_controller_key'
    }

    const key = this.deps.enrollment.controllerKey(kid)

    if (!key) {
      return 'unpinned_controller_key'
    }

    return verifyControllerSignature(key, deviceSignedBytes(type, body), sig) ? 'ok' : 'bad_signature'
  }

  private async receive(attempt: Attempt, raw: string, receivedAt: number): Promise<void> {
    let envelope: { v?: unknown; type?: unknown; body?: unknown; kid?: unknown; sig?: unknown }

    try {
      envelope = JSON.parse(raw)
    } catch {
      return this.fail(attempt, 'protocol', 'frame is not JSON')
    }

    const { v, type, body, kid, sig } = envelope ?? {}

    if (
      v !== 1 ||
      typeof type !== 'string' ||
      !CONTROLLER_TYPES.has(type) ||
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof kid !== 'string' ||
      typeof sig !== 'string'
    ) {
      return this.fail(
        attempt,
        'protocol',
        `not a controller envelope (${typeof type === 'string' ? type.slice(0, 32) : 'no type'})`
      )
    }

    if (type.startsWith('Workspace') ||
      (type === 'Ready' && ((body as Record<string, unknown>).workspaceProtocol !== undefined || (body as Record<string, unknown>).sourceProtocol !== undefined))) {
      try {parseFrame(raw, 'controller_to_device')} catch {return this.fail(attempt, 'protocol', 'invalid extension frame')}
    }

    const frame = body as Record<string, unknown>
    const verdict = this.verdict(attempt, type, frame, kid, sig)
    this.armSilence(attempt)

    switch (this.connectionState) {
      case 'hello_sent':
        return this.challenge(attempt, type, frame, verdict)

      case 'challenged':
        return this.ready(attempt, type, frame, verdict)

      case 'ready':
        if (type === 'Revoke') {
          return this.revoke(frame, verdict)
        }

        if (type !== 'StatusQuery') {
          // A command before the status exchange is never drained: drop the connection.
          return this.fail(attempt, 'protocol', `${type} before the status exchange`)
        }

        return this.status(attempt, frame, verdict)

      case 'status_exchanged':

        if (type.startsWith('Workspace') && attempt.session?.workspaceProtocol !== 1) {
          return this.fail(attempt, 'protocol', 'workspace was not negotiated')
        }

        if (type === 'StatusQuery') {
          return this.status(attempt, frame, verdict)
        }

        if (type === 'Revoke') {
          return this.revoke(frame, verdict)
        }

        if (type === 'Challenge' || type === 'Ready') {
          return this.fail(attempt, 'protocol', `${type} on an established connection`)
        }

        await this.deliver(attempt, {
          type: type as DeviceInboundFrame['type'],
          body: frame,
          kid,
          verdict,
          receivedAt
        })

        // A TurnGrant that just went live (or a Cancel that ended the last one) changes whether
        // silence on this link means anything.
        if (this.current === attempt) {
          this.armSilence(attempt)
        }

        return

      default:
        return this.fail(attempt, 'protocol', `${type} before Hello`)
    }
  }

  private async challenge(
    attempt: Attempt,
    type: string,
    body: Record<string, unknown>,
    verdict: FrameVerdict
  ): Promise<void> {
    if (type !== 'Challenge') {
      return this.fail(attempt, 'protocol', `${type} instead of Challenge`)
    }

    if (verdict !== 'ok') {
      return this.fail(
        attempt,
        verdict === 'unpinned_controller_key' ? 'unpinned' : 'protocol',
        `Challenge: ${verdict}`
      )
    }

    if (
      typeof body.connectionId !== 'string' ||
      !UUID.test(body.connectionId) ||
      typeof body.challenge !== 'string' ||
      !RAND32.test(body.challenge) ||
      body.helloHash !== attempt.helloHash ||
      !Number.isSafeInteger(body.issuedAt)
    ) {
      return this.fail(attempt, 'protocol', 'Challenge does not answer this Hello')
    }

    attempt.connectionId = body.connectionId
    const proof = { connectionId: body.connectionId, challenge: body.challenge, helloHash: attempt.helloHash! }

    if (await this.sendOn(attempt, 'Proof', proof)) {
      this.enter('challenged')
    }
  }

  private async ready(
    attempt: Attempt,
    type: string,
    body: Record<string, unknown>,
    verdict: FrameVerdict
  ): Promise<void> {
    if (type !== 'Ready' || verdict !== 'ok') {
      return this.fail(
        attempt,
        verdict === 'unpinned_controller_key' ? 'unpinned' : 'protocol',
        `${type} instead of a valid Ready`
      )
    }

    if (
      body.connectionId !== attempt.connectionId ||
      body.heartbeatMs !== DEVICE_CONNECTION.heartbeatMs ||
      !Number.isSafeInteger(body.connectionEpoch) ||
      (body.connectionEpoch as number) < 1 ||
      !Number.isSafeInteger(body.serverTime)
    ) {
      return this.fail(attempt, 'protocol', 'Ready does not match this connection')
    }

    if (body.sourceProtocol !== undefined && (!attempt.sourceOffered || body.sourceProtocol !== 1)) {
      return this.fail(attempt, 'protocol', 'sources were not negotiated')
    }

    if (body.workspaceProtocol !== undefined && (!attempt.workspaceOffered || body.workspaceProtocol !== 1)) {
      return this.fail(attempt, 'protocol', 'Ready did not negotiate this workspace version')
    }

    attempt.session = {
      ...(body.workspaceProtocol === 1 ? { workspaceProtocol: 1 as const } : {}),
      ...(body.sourceProtocol === 1 ? { sourceProtocol: 1 as const } : {}),
      connectionId: attempt.connectionId!,
      connectionEpoch: body.connectionEpoch as number,
      localGeneration: this.deps.epochs.localGeneration(),
      deviceServiceId: attempt.record.deviceServiceId,
      enrollmentEpoch: attempt.record.enrollmentEpoch,
      accountEpoch: this.deps.epochs.accountEpoch()
    }

    this.timer('preauth', null)
    this.enter('ready')
  }

  private async status(attempt: Attempt, body: Record<string, unknown>, verdict: FrameVerdict): Promise<void> {
    if (verdict !== 'ok') {
      return this.fail(
        attempt,
        verdict === 'unpinned_controller_key' ? 'unpinned' : 'protocol',
        `StatusQuery: ${verdict}`
      )
    }

    const ids = body.commandIds

    if (!Array.isArray(ids) || ids.length > 256 || !ids.every(id => typeof id === 'string' && UUID.test(id))) {
      return this.fail(attempt, 'protocol', 'StatusQuery is malformed')
    }

    const status = await this.sink.status({ commandIds: ids as string[] }, attempt.session!)
    // Every receipt the ledger holds, trimmed to fit one frame; the trimmed ones follow whole.
    const plan = deviceStatusPlan(status.receipts.slice(0, DEVICE_CONNECTION.statusMaxCommands))

    if (await this.sendOn(attempt, 'Status', plan.status)) {
      const first = this.connectionState === 'ready'
      this.enter('status_exchanged')

      for (const receipt of plan.followUps) {
        if (!(await this.sendOn(attempt, 'Receipt', receipt))) {
          break
        }
      }

      for (const artifact of status.artifacts ?? []) {
        try {
          if (this.current !== attempt || !this.sendArtifact(artifact.commandId, artifact.name, artifact.bytes)) {
            break
          }
        } catch {
          this.log('an artifact named in the status was not sent: refused by the contract')
        }
      }

      if (first) {
        this.failures = 0

        if (this.keyFailures) {
          this.log(`device key usable again after ${this.keyFailures} failed attempts`)
          this.keyFailures = 0
          this.lastKeyFailure = ''
        }

        this.log(`connected ${attempt.session!.connectionId.slice(0, 8)} epoch ${attempt.session!.connectionEpoch}`)
        void this.flushOriginReceipts()
      }
    }
  }

  private async revoke(body: Record<string, unknown>, verdict: FrameVerdict): Promise<void> {
    if (verdict !== 'ok') {
      this.log(`ignored a Revoke: ${verdict}`)

      return
    }

    if (
      typeof body.deviceServiceId !== 'string' ||
      !Number.isSafeInteger(body.enrollmentEpoch) ||
      !Number.isSafeInteger(body.revokeSeq)
    ) {
      this.log('ignored a malformed Revoke')

      return
    }

    const outcome = this.deps.enrollment.applyRevoke({
      deviceServiceId: body.deviceServiceId,
      enrollmentEpoch: body.enrollmentEpoch as number,
      revokeSeq: body.revokeSeq as number
    })

    if (outcome.outcome === 'applied') {
      this.stop('revoked')
    } else {
      this.log(`ignored a Revoke: ${outcome.reason}`)
    }
  }

  private async deliver(attempt: Attempt, frame: DeviceInboundFrame): Promise<void> {
    const outbound = (await this.sink.frame(frame, attempt.session!)) as DeviceOutboundFrame[] | undefined

    for (const each of outbound ?? []) {
      if (!(await this.sendOn(attempt, each.type, each.body))) {
        return
      }
    }
  }

  /**
   * Watches for silence only while a grant is live (the controller renews it every 5 s). An idle
   * link carries no frames, so idle silence is not evidence of anything; a dead idle link ends
   * with its socket's close or error.
   */
  private armSilence(attempt: Attempt): void {
    if (!this.grantsLive()) {
      this.timer('silence', null)

      return
    }

    this.timer('silence', DEVICE_CONNECTION.grantSilenceMs, () => {
      this.timers.delete('silence')

      // The grants ended without a frame (expiry): the link is idle again, not dead.
      if (this.current !== attempt || !this.grantsLive()) {
        return
      }

      this.logClose('silence', 'grant_silence')
      this.teardown('silence')
      this.failures = 0
      this.scheduleRetry()
    })
  }

  private grantsLive(): boolean {
    try {
      return Boolean(this.sink.liveGrants?.())
    } catch {
      return false
    }
  }

  private fail(attempt: Attempt, reason: DeviceCloseReason, detail: string): void {
    if (this.current !== attempt) {
      return
    }

    if (detail) {
      this.log(`connection closed (${reason}): ${detail}`)
    }

    this.teardown(reason)

    // A controller that is not pinned cannot be trusted by dialling again; it needs the owner.
    if (reason === 'unpinned') {
      this.wanted = false

      return
    }

    this.scheduleRetry()
  }

  /** Closes the current attempt synchronously: later frames and sends for it are dropped. */
  private teardown(reason: DeviceCloseReason): void {
    const attempt = this.current
    this.current = undefined
    this.generation += 1
    this.timer('preauth', null)
    this.timer('silence', null)
    this.lastClose = reason

    if (attempt) {
      const { socket } = attempt
      const stopReason = STOP_REASONS[reason]
      const grantIds = attempt.session && stopReason ? this.liveGrantIds() : []
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null

      if (attempt.session) {
        try {
          this.sink.closed(attempt.session, reason)
        } catch {
          // The sink's failure never keeps a dead connection alive.
        }
      }

      if (attempt.session && stopReason && socket.readyState === OPEN) {
        void this.finalStop(attempt, {
          reason: stopReason,
          accountEpoch: this.accountEpochOr(attempt.session.accountEpoch),
          grantIds
        })
      } else {
        close(socket, reason)
      }
    }

    if (this.connectionState !== 'closed' || attempt) {
      this.enter('closed', reason)
    }
  }

  private liveGrantIds(): string[] {
    try {
      return (this.sink.liveGrantIds?.() ?? []).filter(id => UUID.test(id)).slice(0, 64)
    } catch {
      return []
    }
  }

  private accountEpochOr(fallback: number): number {
    try {
      return this.deps.epochs.accountEpoch()
    } catch {
      return fallback
    }
  }

  /** The signed `Stop` on a connection that is already fenced, then the close. */
  private async finalStop(
    attempt: Attempt,
    body: { reason: string; accountEpoch: number; grantIds: string[] }
  ): Promise<void> {
    try {
      const signature = await this.deps.signer.signIdentity(deviceSignedBytes('Stop', body))

      if (signature.kid === attempt.record.identityKid && attempt.socket.readyState === OPEN) {
        attempt.socket.send(JSON.stringify({ v: 1, type: 'Stop', body, kid: signature.kid, sig: signature.sig }))
      }
    } catch {
      // Best effort: the controller also sees the socket close.
    } finally {
      close(attempt.socket, body.reason)
    }
  }

  private scheduleRetry(): void {
    if (!this.wanted || this.suspended || this.current) {
      return
    }

    const exponent = Math.min(this.failures, 5)
    this.failures += 1
    const base = Math.min(DEVICE_CONNECTION.backoffMaxMs, DEVICE_CONNECTION.backoffMinMs * 2 ** exponent)
    const jitter = 0.8 + 0.4 * (this.deps.random?.() ?? Math.random())

    const delay = Math.max(
      DEVICE_CONNECTION.backoffMinMs,
      Math.min(DEVICE_CONNECTION.backoffMaxMs, Math.round(base * jitter))
    )

    this.timer('retry', delay, () => {
      this.timers.delete('retry')
      this.dial()
    })
  }
}
