import { createHash } from 'node:crypto'

import {
  DEFAULT_DESKTOP_LOCALE,
  type DesktopLocale,
  desktopLocaleFor,
  isDesktopLocale
} from '../../shared/desktop-locale'
import {
  MATRIX_MAX_FILE_BYTES,
  MATRIX_MEDIA_TIMEOUT_MS,
  MATRIX_PROMPT_MAX,
  type MatrixAppBinding,
  type MatrixAppEnrollmentIdentity,
  matrixAttachmentMsgtype,
  type MatrixEnrollmentIdentity,
  type MatrixHermesAttachment,
  type MatrixIdentity,
  type MatrixInvocationMessage,
  type MatrixInvocationResult,
  type MatrixInvocationWatch,
  matrixOwnerWireType,
  type MatrixReplyQuoteRead,
  matrixRoomTextTooLong,
  type MatrixSdkCommand
} from '../../shared/matrix'
import { matrixActionCopy } from '../../shared/matrix-action-copy'
import { type MatrixAgentStatusCode, matrixAgentStatusText, matrixCheckingLine } from '../../shared/matrix-agent-status-copy'
import { matrixAnswerParts, matrixAnswerPartTransaction } from '../../shared/matrix-answer-parts'
import { matrixLocalDay } from '../../shared/matrix-device-trust'
import type { MatrixGroupMode } from '../../shared/matrix-group-room'
import { type MatrixPetIntentEnvelope, matrixPetIntentEnvelope } from '../../shared/matrix-pet-intent'
import type { MatrixSeenProof } from '../../shared/matrix-presentation-signals'
import { matrixReplyWords, matrixTurnQuote } from '../../shared/matrix-turn-intake'
import {
  classifyGroupTrigger,
  DAILY_TURNS_DEFAULT,
  GROUP_FRESHNESS_MS,
  isGroupFresh
} from '../../shared/room-participation'
import type { GroupRecentRead } from '../../shared/room-participation/recent'
import type { GroupParticipation } from '../../shared/room-participation/runtime'
import type { EncryptedStore } from '../encrypted-store'

import type { MatrixAgentWork } from './agent-signals'
import { type MatrixClaimHeartbeat, startMatrixClaimHeartbeat } from './claim-heartbeat'
import { withoutMatrixExpiry } from './enrollment'
import { type MatrixGroupQuote } from './group-turns'
import { groupChainSender } from './groups/chain'
import { matrixGroupRecentPrompt } from './groups/recent'
import {
  MATRIX_DEFERRED_RETRY_MS,
  MATRIX_DEFERRED_START_MARGIN_MS,
  type MatrixTurnLine,
  type MatrixTurnOutcome
} from './hermes-listener'
import { matrixLateAnswerCopy } from './late-answer-copy'
import { LOCAL_TURN_LIMIT_MS, type LocalInvocationRecords } from './local-authority'
import { matrixTurnPrompt } from './local-turn'
import type { MatrixPreparedConversation } from './prepared-conversation'
import {
  matrixResumePrompt,
  matrixStatusTransaction,
  matrixToolNames,
  type MatrixTurnEffect,
  MatrixTurnEffects,
  type MatrixTurnEvidence,
  matrixTurnEvidenceWith,
  type MatrixTurnKnownEffect,
  type MatrixTurnResume,
  matrixTurnResume,
  matrixTurnSettlement
} from './turn-effects'
import { matrixFailureRpc, matrixTurnFailure, matrixTurnStopped } from './turn-failure'
import type { MatrixWordRequest } from './word-document'

interface Context {
  human: MatrixIdentity
  agent: MatrixEnrollmentIdentity
}

/** The result the window reads. A deferral (only a listener offers a turn again) is unavailable,
 * as any refusal before dispatch has always been; a failure is an unknown outcome. */
export function matrixInvocationResult(outcome: MatrixTurnOutcome): MatrixInvocationResult {
  if (outcome.state === 'deferred') {
    throw new Error('matrix_invocation_unavailable')
  }

  return 'failed' in outcome ? { state: 'unknown' } : outcome
}

/** The least of its initial claim a turn needs left to reach dispatch and its first heartbeat. */
export const MATRIX_DISPATCH_CLAIM_MARGIN_MS = 15_000

/** Automatic answering's window: how long after it was sent a phone message may still start (owner
 * decision 2026-10-20, was 15 minutes: a message sent while this Mac slept or was locked is still
 * answered when it is back, not dropped as stale). */
export const MATRIX_AUTOMATIC_WINDOW_MS = 6 * 60 * 60_000

/**
 * A message the ledger records as dispatched, that no answer followed, is settled (R3, "resume
 * instead of refuse"): queued again when this Mac can show that running it again repeats nothing,
 * run again with the facts when something may have run, and otherwise said once to the owner.
 * Another Mac's dispatch is given this long, counted from the message, to settle itself before
 * this Mac says anything: the Mac that dispatched it is the only one that knows how far it got.
 */
export const MATRIX_SETTLE_GRACE_MS = 90_000
/** How often a Mac waiting out that grace looks at the record again. */
export const MATRIX_SETTLE_POLL_MS = 5_000
/** Pauses between the attempts to queue a failed run again (a lost response or a brief outage). */
export const MATRIX_SETTLE_RETRY_MS: readonly number[] = [1_500, 4_000]

/**
 * What this Mac durably knows of a run it dispatched, beside the outcome record: `dispatched`
 * (nothing was submitted yet, which survives a crash and proves nothing ran), `submitted` (Hermes
 * may have done anything since: after a crash that is "unknown"), `failed` (the verdict of a run
 * that ended without an answer, kept until the platform has been told) and `stopped` (the owner
 * pressed Stop: nothing resumes it, nothing is said).
 */
interface MatrixEffectsRecord {
  v: 1
  invocationId: string
  phase: 'dispatched' | 'submitted' | 'failed' | 'stopped'
  effect?: MatrixTurnEffect
  tools?: string[]
}

/** Runs of this process between their dispatch and the end of their settlement, by vault and
 * outcome key: a message offered again while its run is still going is never mistaken for an
 * abandoned one. */
const inFlightRuns = new WeakMap<object, Set<string>>()

function inFlight(store: object): Set<string> {
  let runs = inFlightRuns.get(store)

  if (!runs) {
    runs = new Set()
    inFlightRuns.set(store, runs)
  }

  return runs
}

const UUID_LIKE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

/**
 * The end of a phone message's window for this attempt (automatic answering). The message's own
 * 6 hours, plus the time it has waited in this Mac's line behind the agent's other turns
 * (`line`, hermes-listener.ts: the listener's queue and the Hermes turn lock), so one that
 * reached this Mac's watch in time is still answered when its turn comes, however long the turns
 * ahead of it took. A message already older than its window when the watch received it gains
 * nothing. A retry starts from the end an earlier attempt reported and adds only its own wait.
 * Without a line, the message's own 6 hours.
 */
export function matrixAutomaticWindowEnd(timestamp: number, line: MatrixTurnLine | undefined, now: number): number {
  const reported = line?.windowEnd

  const base = Math.max(
    timestamp + MATRIX_AUTOMATIC_WINDOW_MS,
    typeof reported === 'number' && Number.isFinite(reported) ? reported : -Infinity
  )

  // Waiting starts no earlier than the message itself (a clock ahead of this Mac's).
  const waitingSince = line && Number.isFinite(line.queuedAt) ? Math.max(line.queuedAt, timestamp) : now

  return base + Math.max(0, now - waitingSince)
}

/** Reads that failed on the way (a slow or dropped link), never a refusal of the turn itself. */
const MATRIX_TRANSIENT_READS: ReadonlySet<string> = new Set([
  'matrix_operation_failed',
  'matrix_operation_timeout',
  'matrix_turn_timeout',
  'matrix_device_query_unavailable'
])

/**
 * The closed code of a read that failed only on the way, before anything was claimed: such a turn
 * is offered again (a listener's `deferred`) rather than stopping the listening it came from.
 * Anything else, undefined: refused as before.
 */
export function matrixTransientReadFailure(error: unknown): string | undefined {
  const { code } = matrixTurnFailure(error)

  return MATRIX_TRANSIENT_READS.has(code) ? code : undefined
}

/** Refusals that hold however often the turn is offered: never deferred, refused as before. */
const MATRIX_TURN_REFUSALS: ReadonlySet<string> = new Set([
  'matrix_earlier_conversation',
  'matrix_group_changed',
  'matrix_invocation_untrusted',
  'matrix_model_choice_unavailable',
  'matrix_hermes_conversation_invalid'
])

/** Owner-device trust belongs to the human SDK; replies belong to the agent SDK.
 * Neither SDK inherits the other's private keys or manual verification list. The message a
 * reply quotes is read by the human SDK too, like the reply itself. */
export function matrixHermesReader(human: Dependencies['read'], agent: Dependencies['read']): Dependencies['read'] {
  return (command, timeoutMs) =>
    (['readInvocation', 'readReplyQuote', 'readRoomPolicy', 'readGroupSettled', 'writeRoomUsage'].includes(command.kind)
      ? human
      : agent)(command, timeoutMs)
}

/** How a reply's quote is read before its turn: a few quick attempts while the quoted message
 * may still be decrypting. Still unreadable, the reply is not answered (never half-answered). */
export const MATRIX_REPLY_QUOTE_READ = { attempts: 3, retryMs: 1_000, timeoutMs: 8_000 } as const

/** A message that may start a turn on this path: a new message, or a pure reply (the
 * agent-room contract, shared/matrix-turn-intake.ts). Any other relation never does. */
function newMessage(message: MatrixInvocationMessage): boolean {
  return message.related === false || (message.related === true && typeof message.content?.replyTo === 'string')
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()

    const stop = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, ms)

    signal.addEventListener('abort', stop, { once: true })
  })
}

/**
 * The words a reply quotes, bounded the way the typed path bounds them (`matrixTurnQuote`).
 * Read by the owner's SDK from the reply's own room, from the owner or the room's agent only;
 * anything else, or a message that is still unreadable after a few attempts, gives no quote,
 * and the caller then refuses the reply. `live` still stops a cancelled turn.
 *
 * In a group (`anyMember`) the quote may be anyone's message there, and says whose it is and
 * whether it came from a verified device: only the owner's or this agent's own, verified,
 * passes as theirs; anyone else's is handed over as someone else's words (group-turns.ts).
 */
async function matrixReplyQuoteRead(
  read: Dependencies['read'],
  target: { roomId: string; eventId: string; ownerId: string; agentId: string; anyMember?: true },
  live: () => void,
  signal: AbortSignal
): Promise<MatrixGroupQuote | undefined> {
  for (let attempt = 1; ; attempt++) {
    let value: MatrixReplyQuoteRead | undefined

    try {
      value = (await read({ kind: 'readReplyQuote', ...target }, MATRIX_REPLY_QUOTE_READ.timeoutMs)) as
        | MatrixReplyQuoteRead
        | undefined
    } catch {
      value = { state: 'pending' }
    }

    live()

    if (value?.state === 'message') {
      const own = value.sender === target.ownerId || value.sender === target.agentId

      const quote =
        value.eventId === target.eventId &&
        (own || target.anyMember) &&
        typeof value.sender === 'string' &&
        typeof value.text === 'string' &&
        !matrixRoomTextTooLong(value.text)
          ? matrixTurnQuote(value.text)
          : ''

      return quote
        ? {
            text: quote,
            sender: value.sender,
            trusted: own && (!target.anyMember || value.verified === true),
            verified: value.verified === true
          }
        : undefined
    }

    if (value?.state !== 'pending' || attempt >= MATRIX_REPLY_QUOTE_READ.attempts) {
      return undefined
    }

    await pause(MATRIX_REPLY_QUOTE_READ.retryMs, signal)
    live()
  }
}

async function matrixReplyQuote(
  read: Dependencies['read'],
  target: { roomId: string; eventId: string; ownerId: string; agentId: string },
  live: () => void,
  signal: AbortSignal
): Promise<string | undefined> {
  return (await matrixReplyQuoteRead(read, target, live, signal))?.text
}

/** How long the assistant's line about a held reply may take to post. */
const HELD_REPLY_NOTICE_MS = 15_000

/**
 * The language of the assistant's line about a held reply: the one the window shows (an
 * explicit run passes it), else the one the owner chose, else the Mac's own languages, else
 * Vietnamese — the order the window itself follows.
 */
export function matrixHeldReplyLocale(
  shown: unknown,
  chosen: unknown,
  system: readonly string[] | undefined
): DesktopLocale {
  if (isDesktopLocale(shown)) {
    return shown
  }

  if (isDesktopLocale(chosen)) {
    return chosen
  }

  return desktopLocaleFor(system) ?? DEFAULT_DESKTOP_LOCALE
}

/**
 * A held reply is not met with silence: the assistant says once, in its own chat, that it
 * couldn't read the message the reply answers and asks for it again — otherwise the owner, on
 * the phone, waits for an answer that is not coming. The line is fixed copy in the owner's
 * language, never words from either message, posted by the agent the way its answers are, as
 * an `m.notice` (`publishNotice`): nothing takes it for a question, an answer or part of the
 * conversation the assistant resumes. The vault records it before it is posted, so it is said
 * at most once per message however often the message is offered again (a second hint, a
 * recovery scan, a restart); a vault that can't record it says nothing, and a failed post is
 * not retried. The reply itself stays unclaimed: once its quote can be read, it is answered.
 */
async function noticeHeldReply(
  deps: Pick<Dependencies, 'ownerLocale' | 'read' | 'store'>,
  context: Context,
  target: { roomId: string; eventId: string },
  live: () => void,
  line: 'replyQuoteUnreadable' | 'groupStale' | 'groupMissed' | 'deviceUnverified' | 'lateSeen' = 'replyQuoteUnreadable',
  /** Said at most once a day for this device (`deviceUnverified`), rather than once per message. */
  daily?: { deviceId: string }
): Promise<void> {
  const locale = deps.ownerLocale?.()

  if (!locale) {
    return
  }

  const key = daily
    ? `matrix-device-unverified-${createHash('sha256')
        .update(
          JSON.stringify([
            context.agent.issuer,
            context.agent.principal,
            context.agent.agentPrincipal,
            context.human.userId,
            daily.deviceId
          ])
        )
        .digest('hex')}`
    : `${line === 'lateSeen' ? 'matrix-late-seen' : 'matrix-reply-held'}-${createHash('sha256')
        .update(
          JSON.stringify([
            context.agent.issuer,
            context.agent.principal,
            context.agent.agentPrincipal,
            target.roomId,
            target.eventId
          ])
        )
        .digest('hex')}`

  const today = matrixLocalDay(Date.now())
  const said = deps.store.getItem(key)

  if ((daily ? said === today : said !== null) || deps.store.failureCode()) {
    return
  }

  live()

  try {
    deps.store.setItem(key, daily ? today : String(Date.now()))
  } catch {
    return
  }

  const copyLocale = isDesktopLocale(locale) ? locale : DEFAULT_DESKTOP_LOCALE
  const body = line === 'lateSeen' ? matrixLateAnswerCopy[copyLocale] : matrixActionCopy[copyLocale][line]

  await deps.read({ kind: 'publishNotice', ...target, body }, HELD_REPLY_NOTICE_MS).catch(() => undefined)
}

/** A group turn's message that names this agent outright (`m.mentions`), from the owner's
 * verified device (checked before this is asked): the only kind the assistant says a line about
 * when it can't answer. A reply without a mention is not: whose message it answers is read
 * later, and a line is never said for a message that might not be addressed to it. */
function groupNamed(
  deps: Pick<Dependencies, 'group'>,
  context: Context,
  message: MatrixInvocationMessage,
  outcome: unknown,
  app: unknown
): boolean {
  return Boolean(
    deps.group &&
    !app &&
    !outcome &&
    message.content.msgtype === 'm.text' &&
    message.content.turn === undefined &&
    !message.content.invalidMentions &&
    message.content.mentionedUserIds?.includes(context.agent.userId)
  )
}

/** A device in a log line: a short one-way hash, never its ID. */
export function matrixDeviceLogHash(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('hex').slice(0, 8)
}

/**
 * The owner's own message, from one of their devices this Mac's owner SDK does not trust (owner
 * finding 1a, 2026-10-06: the phone's session was never verified). Refused exactly as any
 * untrusted message is; this only picks it out for the log line and the owner's notice.
 */
function fromUnverifiedOwnerDevice(
  message: MatrixInvocationMessage | undefined,
  context: Context,
  target: { roomId: string; eventId: string }
): message is MatrixInvocationMessage & { senderDevice: string } {
  return Boolean(
    message &&
    message.wireType === 'm.room.encrypted' &&
    message.sender === context.human.userId &&
    typeof message.senderDevice === 'string' &&
    message.senderDevice.length > 0 &&
    message.senderDevice.length <= 255 &&
    message.senderVerified !== true &&
    message.roomId === target.roomId &&
    message.eventId === target.eventId
  )
}

/**
 * Whether this Mac is the one that would answer the owner's message from another of their
 * devices, by the rule a verified one meets below: a live listening watch, and the automatic
 * lease, or this Mac's answering lease from before the message was sent, while the message is
 * still fresh. Every other host (another Mac, an expired watch, an explicit Run) says nothing.
 */
function answersOwnerDevice(
  deps: Pick<Dependencies, 'watch' | 'automatic' | 'local' | 'line'>,
  context: Context,
  message: MatrixInvocationMessage
): boolean {
  const at = message.timestamp
  const now = Date.now()

  if (
    !deps.watch ||
    message.senderDevice === context.human.deviceId ||
    !newMessage(message) ||
    !(message.content?.msgtype === 'm.text' || matrixAttachmentMsgtype(message.content?.msgtype)) ||
    typeof at !== 'number' ||
    !Number.isFinite(at) ||
    at > now
  ) {
    return false
  }

  if (deps.automatic && deps.watch.automatic) {
    // Lateness is not distrust (LB9): a phone message past its 15 minutes is still answered.
    return at >= deps.watch.automatic.windowStart
  }

  const lease = deps.local?.lease

  return Boolean(deps.local?.records && lease && at >= lease.notBefore && at > deps.watch.since && now - at <= 120_000)
}

/**
 * The owner wrote from a device they haven't verified, and it is refused (unchanged). Main hears
 * once, as one sanitized line (`reason=sender_unverified` and a short device hash), and the
 * window's reminder to verify that device reads the device list again. The Mac that would have
 * answered also says why in the assistant's own chat, at most once a day for that device
 * (`deviceUnverified`): Element X shows the line on the phone as a message held for an
 * unverified device, which is itself the hint; the owner's Macs read its words. Never in a group,
 * never for an app, never from a second host.
 */
async function refuseUnverifiedOwnerDevice(
  deps: Pick<
    Dependencies,
    'log' | 'ownerDeviceDenied' | 'ownerLocale' | 'read' | 'store' | 'watch' | 'automatic' | 'local' | 'line' | 'group'
  >,
  context: Context,
  target: { roomId: string; eventId: string },
  message: MatrixInvocationMessage & { senderDevice: string },
  live: () => void,
  app: boolean
): Promise<void> {
  try {
    deps.log?.(
      `[Matrix] invocation denied reason=sender_unverified device=${matrixDeviceLogHash(message.senderDevice)}`
    )
    deps.ownerDeviceDenied?.(message.senderDevice)

    if (!app && !deps.group && answersOwnerDevice(deps, context, message)) {
      await noticeHeldReply(deps, context, target, live, 'deviceUnverified', { deviceId: message.senderDevice })
    }
  } catch {
    // The refusal stands whatever happens to its notice.
  }
}

export function matrixInvocationRequestHash(message: MatrixInvocationMessage): string {
  const file = message.content.attachment

  if (message.content.chain) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          'group-chain-v1',
          message.content.body,
          message.content.chain,
          message.content.mentionedUserIds ?? [],
          message.content.replyTo
        ])
      )
      .digest('hex')
  }

  return createHash('sha256')
    .update(file ? JSON.stringify([message.content.msgtype, message.content.body, file.name, file.fingerprint]) : message.content.body)
    .digest('hex')
}

/** One Hermes conversation per room for this owner, device pair and executor, shared by the
 * server path and the local path so a room keeps one continuous session. A group's turns run
 * in that group's own conversation, one per mode (`group`): never the agent's private one, and
 * never one whose tools change under it when someone joins or leaves the group. A shared
 * group's conversation is also one per audience (matrixGroupAudience): what was said there in
 * front of some people is never resumed in front of someone who joined later. */
export function matrixConversationKey(
  agent: Pick<MatrixEnrollmentIdentity, 'issuer' | 'principal' | 'agentPrincipal' | 'executorId' | 'deviceId'>,
  human: MatrixIdentity,
  roomId: string,
  storeTaskId?: string,
  group?: MatrixGroupMode | { mode: MatrixGroupMode; audience?: readonly string[]; chain?: unknown },
  petSurface = false,
  profile?: 'first_learning'
): string {
  const turn = typeof group === 'string' ? { mode: group } : group
  const audience = turn?.mode === 'shared' && turn.audience ? [...new Set(turn.audience)].sort() : undefined

  return `matrix-conversation-${createHash('sha256')
    .update(
      JSON.stringify([
        agent.issuer,
        agent.principal,
        agent.agentPrincipal,
        agent.executorId,
        agent.deviceId,
        human.userId,
        human.deviceId,
        roomId,
        ...(storeTaskId ? [storeTaskId] : []),
        ...(petSurface && !turn && !storeTaskId ? [{ petSurface: true }] : []),
        ...(profile ? [{ profile }] : []),
        ...(turn
          ? [
              audience ? { group: turn.mode, audience } : { group: turn.mode },
              ...('chain' in turn && turn.chain ? [{ replyOnly: true }] : [])
            ]
          : [])
      ])
    )
    .digest('hex')}`
}

export interface MatrixGrant {
  invocationId: string
  state: 'claimed' | 'dispatched' | 'completed'
  expiresAt: number
  transactionId?: string
  publishedEvent?: string
  /** Set when the message was queued again after a run that ended without an answer: how many
   * times, and what the earlier run was known to have done (turn-effects.ts). */
  resume?: MatrixTurnResume
}

/** Validates a platform (or local-record) grant against the exact binding it was asked for. */
export function matrixGrant(
  value: unknown,
  expected: {
    agent: Pick<MatrixEnrollmentIdentity, 'principal' | 'agentPrincipal' | 'deviceId'>
    binding: Record<string, unknown>
    capability: 'app-turn' | 'local-hermes-turn'
    appBinding?: MatrixAppBinding
    invocationId?: string
  }
): MatrixGrant {
  const grant = value as MatrixGrant & Record<string, unknown>

  if (
    grant?.owner !== expected.agent.principal ||
    grant.payer !== expected.agent.principal ||
    grant.capability !== expected.capability ||
    (expected.appBinding && Object.entries(expected.appBinding).some(([key, want]) => grant[key] !== want)) ||
    grant.agentPrincipal !== expected.agent.agentPrincipal ||
    grant.agentDevice !== expected.agent.deviceId ||
    Object.entries(expected.binding).some(([key, want]) => grant[key] !== want) ||
    typeof grant.invocationId !== 'string' ||
    !/^[\da-f-]{36}$/i.test(grant.invocationId) ||
    (expected.invocationId !== undefined && grant.invocationId !== expected.invocationId) ||
    !['claimed', 'dispatched', 'completed'].includes(grant.state) ||
    !Number.isFinite(grant.expiresAt) ||
    (grant.transactionId != null && !/^[\da-f-]{36}$/i.test(grant.transactionId)) ||
    (grant.publishedEvent != null &&
      (typeof grant.publishedEvent !== 'string' || !grant.publishedEvent.startsWith('$')))
  ) {
    throw new Error('matrix_invocation_invalid')
  }

  // The facts of an earlier run only ever add care to a run: a malformed record reads as none.
  grant.resume = matrixTurnResume(grant.resume)

  return grant
}

type Grant = MatrixGrant
interface Outcome {
  pet?: MatrixPetIntentEnvelope
  invocationId: string
  text: string
  storedSession?: string
  /** The answer's event once all of it is posted: its one message, or a split answer's last part. */
  publishedEvent?: string
  /** An answer too long for one message (matrix-answer-parts.ts): its parts already posted, in order. */
  publishedParts?: string[]
}
interface Dependencies {
  /** Main-owned capability read before this session starts; not renderer/model authority. */
  petSurface?: boolean
  /**
   * The event ID of an owner message that main itself sent from this Mac (the owner's SDK here
   * returned it). A message from a room without encryption names no device, so this is what
   * tells one typed on this Mac from one typed on the phone. Ignored for an encrypted message.
   */
  sentHere?: string
  publicationOnly?: boolean
  watch?: MatrixInvocationWatch
  /** The message's place in the listener's line (matrixAutomaticWindowEnd): the time it waited
   * behind the agent's other turns does not count against an automatic turn's window. */
  line?: MatrixTurnLine
  /** Automatic phone work always uses the shared ledger, not this device's records. */
  automatic?: { leaseToken: string }
  /**
   * This Mac's own exactly-once records (local-authority.ts), used with the answering
   * lease (platform 0145) so a reply needs no platform round trip. Each message keeps
   * the authority it was first handled with. A new message is recorded locally only
   * while the lease is held and when it was sent after the lease session began; any
   * other goes to the platform, which also stays the authority for older history.
   */
  local?: {
    records: LocalInvocationRecords
    lease: { notBefore: number; turnLimitMs: number } | null
  }
  /**
   * A turn in a group the agent is in (owner-only assistants in groups): only the owner's
   * message that names this agent, or replies to its message naming nobody else, runs; its one
   * quote may be anyone's there, handed over as theirs; no room history; and it runs in the
   * group's own conversation for this mode and, when shared, this audience
   * (matrixConversationKey). Main sets it after reading the group, on the Mac that holds the
   * agent's answering lease.
   */
  group?: {
    mode: MatrixGroupMode
    audience?: readonly string[]
    recent?: GroupRecentRead
  } & Partial<GroupParticipation>
  groupRevalidate?: () => Promise<void>
  groupClaimed?: (invocationId: string) => Promise<void>
  groupLease?: { leaseToken: string }
  /**
   * The agent's presentation signals in its own chat (agent-turns v1.1, agent-signals.ts):
   * `seen` once this Mac took the message up (its checks passed and the platform or this Mac's
   * record dispatched it; the lease is checked then) and again once it is answered (`claimed`
   * when this run began under this Mac's answering lease); `work` for its typing, only while
   * this Mac holds the answering lease and only around the run. Group turns use `work` for
   * standard typing but omit `seen`, because a cumulative group receipt would claim messages
   * the agent did not take up.
   */
  signals?: { seen?(eventId: string, proof?: MatrixSeenProof): void; work(): MatrixAgentWork | undefined }
  context(): Context
  read(command: MatrixSdkCommand, timeoutMs?: number): Promise<unknown>
  /**
   * This agent's result for the invocation went through the platform's outbox (atum.agent-home/2.1): the platform's worker
   * records the published event on the ledger itself, so the legacy "published" acknowledgement is not sent for it.
   */
  ledgerPublishes?(invocationId: string): boolean
  /**
   * The owner's language, for the one line the assistant says in its chat when it holds a
   * reply because it can't read the message that reply answers. Without it nothing is said.
   */
  ownerLocale?(): DesktopLocale
  /** Main's log, for the one sanitized line said when the owner's own unverified device is
   * refused (`reason=sender_unverified`, a short device hash, never content). */
  log?(line: string): void
  /** The owner's own device that isn't verified was refused: the window's reminder to verify
   * it reads the device list again (unverified-devices.ts). Changes nothing here. */
  ownerDeviceDenied?(deviceId: string): void
  authorize(input: Record<string, unknown>): Promise<unknown>
  confirm(text: string, attachmentName?: string): Promise<boolean>
  document?(): { name: string; capture(): Promise<MatrixHermesAttachment>; word?: MatrixWordRequest } | undefined
  prepare(input: { owner: string; executorId: string; signal: AbortSignal }): Promise<boolean>
  /**
   * The turn's conversation made ready after the claim and before dispatch: everything that can
   * refuse without Hermes (the room's re-read, the conversation's vault link and history;
   * MatrixHermesExecutor.prepare). A refusal costs no dispatch: the claim stays and the turn comes
   * back `deferred`, for the listener to offer again. What it returns goes to `execute` once.
   */
  conversation?(input: {
    conversationKey: string
    petSurface?: boolean
    signal: AbortSignal
  }): Promise<MatrixPreparedConversation | undefined>
  /**
   * The note for the owner's first words in a new account's primary chat, which answer a welcome
   * the model never saw (first-run-naming.ts). Asked once, for a plain owner turn in the agent's
   * own chat only: never a group, an app or a reply. It follows the person's words in this turn's
   * prompt and is never stored in the room. Best effort: a failure means no note, never a failed turn.
   */
  firstRunNote?(input: { roomId: string; eventId: string; signal: AbortSignal }): Promise<string | undefined>
  execute(input: {
    owner: string
    executorId: string
    invocationId: string
    conversationKey: string
    /** What `conversation` made ready before dispatch, for this run only. */
    conversation?: MatrixPreparedConversation
    petSurface?: boolean
    text: string
    mentionedUserIds?: string[]
    attachments?: MatrixHermesAttachment[]
    onWord?: MatrixWordRequest
    /** The run's typing (see `signals`): it pauses while the run waits on its owner. */
    work?: MatrixAgentWork
    signal: AbortSignal
    deadlineAt: number
    /** Quiet-time cap for this run (reliability plan §6.1 A), passed through to Hermes. */
    inactivityMs?: number
    /** Follows what the run did, for the failure path (turn-effects.ts). */
    effects?: MatrixTurnEffects
    /** Synchronous and durable, immediately before the prompt leaves for Hermes. */
    onSubmit?: () => void
  }): Promise<{ text: string; storedSession: string; pet?: MatrixPetIntentEnvelope }>
  /**
   * Backoff between the attempts to tell the platform a failed run can be queued again
   * (MATRIX_SETTLE_RETRY_MS when absent; tests set none).
   */
  settleRetryMs?: readonly number[]
  /**
   * Whether the owner pressed Stop on the turn this call is running, read while it is settled: a
   * Stop that lands after a run failed (while it is being queued again) is still final.
   */
  stopped?(): boolean
  store: EncryptedStore
}

/** Native → platform only. Verified mentions bind the dispatched hash; platform
 * removes them before external provider delivery. No room/history/keys. */
export interface MatrixAppTurn {
  text: string
  mentionedUserIds: string[]
  invocationId: string
  signal: AbortSignal
  deadlineAt: number
}

interface AppDependencies extends Omit<Dependencies, 'context' | 'document' | 'execute'> {
  context(): { human: MatrixIdentity; agent: MatrixAppEnrollmentIdentity }
  execute(input: MatrixAppTurn): Promise<{ text: string }>
}

export function invokeMatrixApp(
  deps: AppDependencies,
  input: { roomId: string; eventId: string },
  signal: AbortSignal
): Promise<MatrixInvocationResult> {
  // Do not spread deps: a document hook from another caller is not app consent.
  return invokeMatrixParticipant(
    {
      context: deps.context,
      read: deps.read,
      authorize: deps.authorize,
      confirm: deps.confirm,
      prepare: deps.prepare,
      store: deps.store,
      watch: deps.watch,
      publicationOnly: deps.publicationOnly,
      sentHere: deps.sentHere,
      log: deps.log,
      execute: ({ text, mentionedUserIds, invocationId, signal, deadlineAt }) =>
        deps.execute({ text, mentionedUserIds: mentionedUserIds!, invocationId, signal, deadlineAt })
    },
    input,
    signal,
    'app'
  ).then(matrixInvocationResult)
}

/** One owner-authorized turn. A listener requires a current native room opt-in.
 * Server owns the dispatch fence;
 * this device owns its encrypted outcome. A missing result is UNKNOWN, not retry. */
export function invokeMatrixHermes(
  deps: Dependencies,
  input: { roomId: string; eventId: string },
  signal: AbortSignal
): Promise<MatrixTurnOutcome> {
  return invokeMatrixParticipant(deps, input, signal, 'hermes')
}

async function invokeMatrixParticipant(
  deps: Omit<Dependencies, 'execute'> & {
    execute(
      input: Parameters<Dependencies['execute']>[0]
    ): Promise<{ text: string; storedSession?: string; pet?: MatrixPetIntentEnvelope }>
  },
  input: { roomId: string; eventId: string },
  signal: AbortSignal,
  kind: 'hermes' | 'app'
): Promise<MatrixTurnOutcome> {
  // Transport hints must never change authority fields or the outcome key.
  const target = { roomId: input.roomId, eventId: input.eventId }
  const context = structuredClone(deps.context())
  const app = kind === 'app' ? (context.agent as MatrixAppEnrollmentIdentity) : undefined

  /**
   * The instant a group message's freshness is judged at (LB9, plan 6.1 A "queue it"): when this Mac
   * took the message up (the floor's `acceptedAt`), not when a later check happens to run. A group
   * message that was fresh then is not dropped for the time it spends in the room queue, in
   * preparation or behind the agent's other turn. With no floor, this invocation's own start is
   * that instant, snapshotted once so every later check agrees with admission.
   */
  const groupTakenUpAt = deps.group?.floor?.acceptedAt ?? Date.now()

  const appBinding: MatrixAppBinding | undefined = app
    ? {
        appId: app.appId,
        installationId: app.installationId,
        appVersionId: app.appVersionId,
        linkEpoch: app.linkEpoch
      }
    : undefined

  if (
    appBinding &&
    ([appBinding.appId, appBinding.installationId, appBinding.appVersionId].some(
      value => typeof value !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
    ) ||
      !Number.isSafeInteger(appBinding.linkEpoch) ||
      appBinding.linkEpoch < 1 ||
      context.agent.userId === context.human.userId ||
      context.agent.agentPrincipal === context.agent.principal)
  ) {
    throw new Error('matrix_invocation_invalid')
  }

  // A renewal of the agent's credential moves only its expiry (credential-renewal.ts): the
  // same executor, device and session, so a turn it overlaps goes on.
  const stable = (value: Context) => JSON.stringify({ ...value, agent: withoutMatrixExpiry(value.agent) })
  const started = stable(context)

  const live = () => {
    signal.throwIfAborted()
    const current = deps.context()

    if (stable(current) !== started || current.agent.expiresAt <= Date.now()) {
      throw new Error('matrix_invocation_cancelled')
    }

    if (
      deps.watch &&
      (Date.now() >= deps.watch.until ||
        target.roomId !== deps.watch.roomId ||
        context.human.userId !== deps.watch.sender.userId ||
        context.human.deviceId !== deps.watch.sender.deviceId)
    ) {
      throw new Error('matrix_invocation_cancelled')
    }
  }

  live()

  let message: MatrixInvocationMessage

  try {
    message = structuredClone(await deps.read({ kind: 'readInvocation', ...target })) as MatrixInvocationMessage
  } catch (error) {
    // A read that failed on the link, for a turn a listener offered: nothing is claimed yet, so it
    // is offered again rather than stopping the listening. Anything else is refused as before.
    const transient = deps.watch && kind === 'hermes' ? matrixTransientReadFailure(error) : undefined

    if (!transient) {
      throw error
    }

    live()
    deps.log?.(`[Matrix] invocation deferred reason=${transient} before=claim`)

    return { state: 'deferred', reason: transient }
  }

  live()

  // Encrypted, or as sent in a room without encryption: the owner SDK's reader returns
  // `m.room.message` only from such a room, and refuses a plaintext event in an encrypted one.
  const plain = message?.wireType === 'm.room.message'

  if (
    !matrixOwnerWireType(message?.wireType) ||
    // The reader marks `roomPlain` only after its confirmed plain decision; a wire type that
    // disagrees with it is refused (as the controller's `ownerTurnKind` does).
    plain !== (message.roomPlain === true) ||
    (message.sender !== context.human.userId &&
      !(
        deps.group &&
        typeof deps.groupRevalidate === 'function' &&
        groupChainSender(message, { ...deps.group, ownerId: context.human.userId, agentId: context.agent.userId })
      )) ||
    typeof message.senderDevice !== 'string' ||
    !message.senderDevice.length ||
    message.senderDevice.length > 255 ||
    // An app's turn is bound to the owner's sending device, where a device is known: a plain
    // room's message names none (`MATRIX_PLAIN_SENDER_DEVICE`), so the owner's account alone.
    (app && !plain && message.senderDevice !== context.human.deviceId) ||
    message.senderVerified !== true ||
    message.roomId !== target.roomId ||
    message.eventId !== target.eventId ||
    !(message.content?.msgtype === 'm.text' || matrixAttachmentMsgtype(message.content?.msgtype)) ||
    typeof message.content.body !== 'string' ||
    !message.content.body.length ||
    matrixRoomTextTooLong(message.content.body) ||
    (message.content.replyTo !== undefined &&
      (typeof message.content.replyTo !== 'string' ||
        !message.content.replyTo.startsWith('$') ||
        message.content.replyTo.length > 1024 ||
        message.related !== true))
  ) {
    if (fromUnverifiedOwnerDevice(message, context, target)) {
      await refuseUnverifiedOwnerDevice(deps, context, target, message, live, Boolean(app))
    }

    if (plain) {
      deps.log?.('[Matrix] invocation wire=plain outcome=refused reason=untrusted')
    }

    throw new Error('matrix_invocation_untrusted')
  }

  // cloud-task-files/1 is additive and remains default-off on this local path.
  // A promise (including a malformed one) must never be treated as file-free work.
  if (Object.prototype.hasOwnProperty.call(message.content, 'taskFiles') || message.content.invalidTaskFiles === true) {
    return { state: 'ignored' }
  }

  const mentions = message.content.mentionedUserIds

  if (
    app &&
    (message.content.invalidMentions ||
      message.related !== false ||
      message.content.msgtype !== 'm.text' ||
      !mentions?.includes(context.agent.userId))
  ) {
    return { state: 'ignored' }
  }

  const file = message.content.attachment

  if (
    matrixAttachmentMsgtype(message.content.msgtype)
      ? !file ||
        typeof file.name !== 'string' ||
        !file.name.length ||
        file.name.length > 255 ||
        typeof file.fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(file.fingerprint)
      : file !== undefined
  ) {
    throw new Error('matrix_invocation_untrusted')
  }

  // Re-read event freshness at the authority boundary, not just in the SDK hint. A phone
  // message's window leaves out its time in this Mac's line (matrixAutomaticWindowEnd), fixed now
  // for every later check of this attempt.
  const windowEnd =
    deps.watch?.automatic && Number.isFinite(message.timestamp)
      ? matrixAutomaticWindowEnd(message.timestamp!, deps.line, Date.now())
      : undefined

  if (
    deps.watch &&
    (!Number.isFinite(message.timestamp) ||
      message.timestamp! < (deps.watch.automatic?.windowStart ?? deps.watch.since + 1) ||
      message.timestamp! > Date.now() ||
      // An automatic (phone) message that is only late is answered, not refused (see `late`).
      (!deps.watch.automatic &&
        !isGroupFresh({ timestamp: message.timestamp!, now: groupTakenUpAt, floor: deps.group?.floor })) ||
      !newMessage(message))
  ) {
    // A group message from the owner that only waited too long (behind another turn of this
    // agent's) is not met with silence: the assistant asks once for it again. Still nothing is
    // prepared, claimed or run for it.
    if (
      groupNamed(deps, context, message, undefined, app) &&
      newMessage(message) &&
      message.timestamp! >= deps.watch.since + 1 &&
      message.timestamp! <= Date.now()
    ) {
      await noticeHeldReply(deps, context, target, live, 'groupStale')

      return { state: 'expired' }
    }

    throw new Error('matrix_invocation_untrusted')
  }

  // A phone message past its 15 minutes (the window above, plus its time in this Mac's line) is
  // late, not untrusted (LB9, plan 6.1 A): it is answered, with one line that it was just seen
  // (`late-answer-copy.ts`). Rechecked before dispatch, where a slow preparation can make it so.
  let late = windowEnd !== undefined && Date.now() > windowEnd

  // How long a turn refused before dispatch may still be offered again: the window just checked.
  // A late message has none left; its retries are bounded by their count alone.
  let retryBefore = deps.watch
    ? deps.watch.automatic
      ? late
        ? undefined
        : windowEnd!
      : (deps.group?.floor?.acceptedAt ?? message.timestamp!) + GROUP_FRESHNESS_MS
    : undefined

  const binding = {
    ...target,
    executorId: context.agent.executorId,
    senderDevice: message.senderDevice,
    // Preserve existing text bindings and fence the file's exact descriptor too.
    requestHash: app
      ? createHash('sha256')
          .update(JSON.stringify(['app-text-v1', message.content.body, [...new Set(mentions!)].sort()]))
          .digest('hex')
      : matrixInvocationRequestHash(message)
  }

  const key = `matrix-outcome-${createHash('sha256')
    .update(
      JSON.stringify([
        context.agent.issuer,
        context.agent.principal,
        context.agent.agentPrincipal,
        context.agent.deviceId,
        binding,
        ...(appBinding ? [appBinding] : [])
      ])
    )
    .digest('hex')}`

  const raw = deps.store.getItem(key)

  if (deps.store.failureCode()) {
    throw new Error('matrix_vault_unavailable')
  }

  let outcome = raw ? (JSON.parse(raw) as Outcome) : undefined

  // A renderer-supplied retry is delivery of a saved result, never permission
  // to execute an old message (including after re-enrollment changes its key).
  if (deps.publicationOnly && !outcome) {
    return { state: 'ignored' }
  }

  // The fence (plan 2026-09-26-reliable-local-first-chat §4.3). A local-path turn typed on
  // any owner device runs once, through that device's local-turn engine. This path never
  // executes it: not the listening watch, not an explicit Run, not after a restart or a
  // lost lease. Only publication of an outcome this device already holds may proceed.
  // Checked before the remote rule: a message from a room without encryption names no device,
  // so one typed on this Mac counts as remote too, and is ignored here rather than refused.
  if (message.content.turn !== undefined && !outcome) {
    deps.log?.(`[Matrix] invocation wire=${plain ? 'plain' : 'encrypted'} outcome=ignored reason=local_turn`)

    return { state: 'ignored' }
  }

  // A plain message sent from this Mac is local, as an encrypted one from this Mac's device is.
  const plainSentHere =
    plain && message.sender === context.human.userId && deps.sentHere !== undefined && deps.sentHere === target.eventId

  const remote = plainSentHere ? false : message.senderDevice !== context.human.deviceId

  if (plain) {
    deps.log?.(`[Matrix] invocation wire=plain origin=${plainSentHere ? 'here' : 'elsewhere'}`)
  }

  const automatic = !app && Boolean(deps.automatic && deps.watch?.automatic)
  const records = !app && !automatic ? deps.local?.records : undefined
  const route = records?.route(target.roomId, target.eventId) ?? null
  const lease = deps.local?.lease ?? null
  const canonicalGroup = !app && !automatic && Boolean(deps.group)

  if (canonicalGroup && !outcome && (!deps.watch || !lease || !deps.groupLease?.leaseToken)) {
    throw new Error('matrix_group_lease_required')
  }

  // Never convert an old ambiguous local Group claim into new platform work.
  // Saved local results retain their original publication authority.
  if (canonicalGroup && route === 'local' && !outcome) {
    return { state: 'unknown' }
  }

  // Presentation only. Apps never impersonate an agent. A group turn acknowledges the message
  // it was addressed in (or admitted) like a private one; the SDK names only that message
  // (agent-signals.ts, agent-turns/1.3 amendment A1).
  const signals = app ? undefined : deps.signals

  // A verified owner phone may start work only in this Mac's live listening
  // session and answering lease. Never fall back to per-message platform
  // authority for remote work. Existing outcomes remain publishable without a
  // watch/lease, but cannot authorize another execution.
  if (
    remote &&
    !automatic &&
    (outcome
      ? route !== 'local' && !(canonicalGroup && route === 'platform')
      : !deps.watch ||
        !records ||
        !lease ||
        (!canonicalGroup && route === 'platform') ||
        !Number.isFinite(message.timestamp) ||
        (!canonicalGroup && message.timestamp < lease.notBefore))
  ) {
    // In a group the owner hears why, once, instead of silence: this Mac only took up the
    // answering lease for this message, so a message from the phone isn't answered here.
    if (groupNamed(deps, context, message, outcome, app)) {
      await noticeHeldReply(deps, context, target, live, 'groupMissed')

      return { state: 'ignored' }
    }

    throw new Error('matrix_invocation_untrusted')
  }

  // ── R3: a dispatched turn that ended without an answer is settled, not refused ─────────────────
  // Only the listener's private-chat turns (a group's usage counts and a person's explicit Run have
  // no one to run them again). Everything below is inert for any other turn.
  const resumable = kind === 'hermes' && Boolean(deps.watch) && !deps.group
  const effectsKey = key.replace('matrix-outcome-', 'matrix-effects-')
  const noticeKey = key.replace('matrix-outcome-', 'matrix-notice-')
  // The owner's Stop for this message (any run of it), and when this Mac first saw it held by another.
  const stoppedKey = key.replace('matrix-outcome-', 'matrix-stopped-')
  const seenKey = key.replace('matrix-outcome-', 'matrix-seen-')
  const UNKNOWN: MatrixTurnEvidence = { effect: 'unknown', tools: [], blind: false }

  type Ask = (operation: string, invocationId?: string, extra?: Record<string, unknown>) => Promise<unknown>

  /** A ledger call on one authority, with the automatic admission's fields where the turn has them. */
  const makeAsk =
    (send: (input: Record<string, unknown>) => Promise<unknown>): Ask =>
    (operation, invocationId, extra) =>
      send({
        ...binding,
        operation,
        ...(automatic ? { protocol: 2, admission: 'automatic', leaseToken: deps.automatic!.leaseToken } : {}),
        ...(invocationId ? { invocationId } : {}),
        ...extra
      })

  const readRecord = (name: string): unknown => {
    try {
      const raw = deps.store.getItem(name)

      return raw ? JSON.parse(raw) : undefined
    } catch {
      return undefined
    }
  }

  const writeEffects = (record: MatrixEffectsRecord) => deps.store.setItem(effectsKey, JSON.stringify(record))

  const dropRecord = (name: string) => {
    try {
      deps.store.removeItem(name)
    } catch {
      // A record left behind names a fence nobody holds any more; it is never read as anything else.
    }
  }

  const ownerStopped = (): boolean => {
    try {
      return deps.stopped?.() === true
    } catch {
      return false
    }
  }

  /**
   * The owner's Stop is final for the message, not only for the run it ended: kept under the event
   * (a requeue issues a new fence, so a mark by fence would not cover the run that follows) and
   * under the fence this Mac knows, so neither this Mac nor a later sighting runs or reports it.
   */
  const markStopped = (invocationId: string) => {
    try {
      deps.store.setItem(stoppedKey, JSON.stringify({ v: 1 }))
    } catch {
      // Without the mark a later sighting only leaves the message alone for the grace, then says it once.
    }

    try {
      writeEffects({ v: 1, invocationId, phase: 'stopped' })
    } catch {
      // As above.
    }
  }

  /**
   * Whether this message can still be offered again and started: the wait the listener would give
   * its next retry (it is bounded and grows with the retries it has spent) must end, with the start
   * margin to spare, inside the message's window. `slackMs` is time this call will spend first.
   * A message that cannot is never queued again: nobody could run it, and the owner would hear
   * nothing.
   */
  const canStillStart = (slackMs = 0): boolean => {
    const spent = deps.line?.spent ?? 0
    const wait = MATRIX_DEFERRED_RETRY_MS[spent]

    if (wait === undefined) {
      return false
    }

    const at = Date.now() + slackMs + wait

    // The same three tests as the listener's defer(): its window, and on the last retry the claim an
    // earlier attempt carried. A message this allows must not be dropped there, nor the reverse.
    return (
      (retryBefore === undefined || at <= retryBefore - MATRIX_DEFERRED_START_MARGIN_MS) &&
      (spent !== MATRIX_DEFERRED_RETRY_MS.length - 1 ||
        deps.line?.claimUntil === undefined ||
        at <= deps.line.claimUntil - MATRIX_DEFERRED_START_MARGIN_MS)
    )
  }

  /**
   * The notice another Mac may already have posted for this message, found in the room under the
   * transaction every Mac would use. Both words are looked for: a Mac that did not dispatch the
   * message says "could not confirm", the one that did says "failed" when it proved nothing ran,
   * and either may have gone out while this Mac was busy.
   */
  const noticeAlready = async (): Promise<string | undefined> => {
    for (const code of ['couldnt_confirm', 'failed'] as const) {
      const transaction = matrixStatusTransaction({
        agentPrincipal: context.agent.agentPrincipal,
        roomId: target.roomId,
        eventId: target.eventId,
        code
      })

      try {
        const found = (await deps.read({
          kind: 'readResult',
          roomId: target.roomId,
          eventId: target.eventId,
          agentUserId: context.agent.userId,
          agentDevice: context.agent.deviceId,
          invocationId: transaction,
          transactionId: transaction
        })) as { state?: unknown; eventId?: unknown } | undefined

        if (
          (found?.state === 'published' || found?.state === 'unverified') &&
          typeof found.eventId === 'string' &&
          found.eventId.startsWith('$')
        ) {
          deps.store.setItem(noticeKey, JSON.stringify({ eventId: found.eventId, code }))

          return found.eventId
        }
      } catch {
        // Not found is not proof of absence, only of nothing seen: the caller goes on as before.
      }
    }

    return undefined
  }

  const ownerLocale = (): DesktopLocale => {
    try {
      return deps.ownerLocale?.() ?? DEFAULT_DESKTOP_LOCALE
    } catch {
      return DEFAULT_DESKTOP_LOCALE
    }
  }

  /** What this Mac itself proved about the run that holds `invocationId`, if it is the one that ran it. */
  const ownEvidence = (invocationId: string): MatrixTurnEvidence | 'stopped' | undefined => {
    const record = readRecord(effectsKey) as Partial<MatrixEffectsRecord> | undefined

    if (record?.v !== 1 || record.invocationId !== invocationId) {
      return undefined
    }

    // The owner pressed Stop: it stays stopped, however often the message is seen again.
    if (record.phase === 'stopped') {
      return 'stopped'
    }

    // Dispatched and never submitted: nothing reached Hermes, which holds through a crash.
    if (record.phase === 'dispatched') {
      return { effect: 'none', tools: [], blind: false }
    }

    if (
      record.phase === 'failed' &&
      (record.effect === 'none' || record.effect === 'read_only' || record.effect === 'side_effect_possible')
    ) {
      return { effect: record.effect, tools: matrixToolNames(record.tools), blind: false }
    }

    // Submitted and then lost with the process: how far it got is not known.
    return UNKNOWN
  }

  /**
   * Tell the platform a dispatched run can be queued again, and what it is known to have done. A
   * response that never came back may still have been acted on, so the record is looked at before
   * trying again. Never throws; false means it is not queued.
   */
  const requeue = async (
    ask: Ask,
    input: { invocationId: string; effect: MatrixTurnKnownEffect; tools: string[] }
  ): Promise<boolean> => {
    const pauses = deps.settleRetryMs ?? MATRIX_SETTLE_RETRY_MS

    for (let attempt = 0; ; attempt++) {
      try {
        const queued = matrixGrant(await ask('requeue', input.invocationId, { effect: input.effect, tools: input.tools }), {
          agent: context.agent,
          binding,
          capability: 'local-hermes-turn'
        })

        return queued.state === 'claimed'
      } catch (error) {
        if (automatic) {
          try {
            const now = (await deps.authorize({
              operation: 'recover',
              ...target,
              requestHash: binding.requestHash,
              agentPrincipal: context.agent.agentPrincipal
            })) as { state?: unknown; invocationId?: unknown } | undefined

            if (now?.state === 'claimed' && now.invocationId !== input.invocationId) {
              return true
            }
          } catch {
            // The link is down too; the next attempt looks again.
          }
        }

        // A refusal (the record is not dispatched, the fence moved, the reruns are spent) is final;
        // only a link that failed is worth another try.
        const refused = error instanceof Error && ['matrix_denied', 'matrix_invalid'].includes(error.message)

        if (refused || attempt >= pauses.length) {
          deps.log?.(`[Matrix] invocation requeue unavailable reason=${matrixTurnFailure(error).code}`)

          return false
        }

        await new Promise<void>(resolve => setTimeout(resolve, pauses[attempt]))
      }
    }
  }

  /**
   * Say, once, that this message could not be finished. The Mac that dispatched it finishes its
   * record with the notice (so no other Mac ever repeats it); any other posts under a transaction
   * every Mac would use. Either way the vault remembers the event, so a message offered again is
   * answered with the same notice, never a second one.
   */
  const postNotice = async (ask: Ask, invocationId: string, code: MatrixAgentStatusCode): Promise<string> => {
    const marked = readRecord(noticeKey) as { eventId?: unknown } | undefined

    if (typeof marked?.eventId === 'string' && marked.eventId.startsWith('$')) {
      return marked.eventId
    }

    let transaction = matrixStatusTransaction({
      agentPrincipal: context.agent.agentPrincipal,
      roomId: target.roomId,
      eventId: target.eventId,
      code
    })

    let ledgered = false

    try {
      const done = matrixGrant(await ask('complete', invocationId), {
        agent: context.agent,
        binding,
        capability: 'local-hermes-turn',
        invocationId
      })

      if (done.publishedEvent) {
        return done.publishedEvent
      }

      if (done.state === 'completed' && done.transactionId) {
        transaction = done.transactionId
        ledgered = true
      }
    } catch {
      // Another Mac's record, or the link: posted stand-alone.
    }

    const eventId = (await deps.read({
      kind: 'publishResult',
      ...target,
      body: matrixAgentStatusText(code, ownerLocale()),
      invocationId: ledgered ? invocationId : transaction,
      transactionId: transaction,
      status: code,
      // A notice on the platform's ledger can be recorded by the platform's worker (a migrated agent's only way).
      ...(ledgered ? { ledger: true as const } : {})
    })) as string

    if (typeof eventId !== 'string' || !eventId.startsWith('$')) {
      throw new Error('matrix_outcome_invalid')
    }

    deps.store.setItem(noticeKey, JSON.stringify({ eventId, code }))

    // The platform's worker records what it sent; the legacy acknowledgement is for a direct send.
    if (ledgered && !deps.ledgerPublishes?.(invocationId)) {
      try {
        await ask('published', invocationId, { publishedEvent: eventId })
      } catch {
        // The notice is in the room and remembered here; the platform's record is reconciled later.
      }
    }

    return eventId
  }

  /**
   * The one line said when this message goes back for a check after a run that may have acted (`matrixResumeNote`): plain
   * chat text under a transaction fixed per message, so it is said once however many Macs see it. Best effort.
   */
  const announceChecking = async (): Promise<void> => {
    const transactionId = `atum-ck-${createHash('sha256')
      .update(JSON.stringify([context.agent.agentPrincipal, target.roomId, target.eventId]))
      .digest('hex')}`

    await deps
      .read({ kind: 'publishNotice', ...target, body: matrixCheckingLine(ownerLocale()), transactionId }, HELD_REPLY_NOTICE_MS)
      .catch(() => undefined)
  }

  /** When this Mac first found the message held by another Mac's dispatch, kept across restarts. */
  const firstSeen = (invocationId: string): number => {
    const saved = readRecord(seenKey) as { invocationId?: unknown; at?: unknown } | undefined

    if (
      saved?.invocationId === invocationId &&
      typeof saved.at === 'number' &&
      Number.isFinite(saved.at) &&
      saved.at <= Date.now()
    ) {
      return saved.at
    }

    const at = Date.now()

    try {
      deps.store.setItem(seenKey, JSON.stringify({ invocationId, at }))
    } catch {
      // Not kept: a restart only starts the grace again.
    }

    return at
  }

  /**
   * A record the platform (or this Mac's own) shows as dispatched, that no answer followed and that
   * this run did not dispatch. `proceed` means it was queued again and the claim below can take it;
   * otherwise the outcome says what was done: nothing (as before), or the owner told once.
   */
  const resolveStale = async (
    ask: Ask,
    source: 'recover' | 'claim',
    record: { state: string; invocationId?: unknown; resume?: unknown }
  ): Promise<{ proceed: true } | { proceed: false; outcome: MatrixTurnOutcome }> => {
    // Said once in the log, so a message nobody answers is traceable.
    deps.log?.(`[Matrix] invocation ${source} skipped state=${record.state}`)
    const skip = { proceed: false, outcome: { state: 'unknown' } } as const

    const invocationId =
      typeof record.invocationId === 'string' && UUID_LIKE.test(record.invocationId) ? record.invocationId : undefined

    if (!resumable || !invocationId || inFlight(deps.store).has(effectsKey)) {
      return skip
    }

    // This Mac already told the owner (its notice is remembered): the same notice, never a second.
    const marked = readRecord(noticeKey) as { eventId?: unknown } | undefined

    if (typeof marked?.eventId === 'string' && marked.eventId.startsWith('$')) {
      return { proceed: false, outcome: { state: 'published', eventId: marked.eventId } }
    }

    // Completed: an answer exists, in the vault of the Mac that completed it, and that Mac posts it
    // (it is only waiting for its link or its next sighting). Another Mac has nothing to say: a
    // notice here would come before, or instead of, the real answer.
    if (record.state === 'completed') {
      return skip
    }

    if (readRecord(stoppedKey)) {
      return skip
    }

    const own = record.state === 'dispatched' ? ownEvidence(invocationId) : undefined

    if (own === 'stopped') {
      return skip
    }

    const prior = matrixTurnResume(record.resume)

    const plan = matrixTurnSettlement({
      evidence: matrixTurnEvidenceWith(own ?? UNKNOWN, prior),
      reruns: prior?.attempt ?? 0,
      stopped: false,
      timedOut: false,
      ...(prior ? { prior } : {})
    })

    if (plan.kind === 'requeue') {
      // This Mac's saved verdict can outlive a notice another Mac posted while this one was away:
      // queueing the message again then would answer it after it was reported.
      const said = own ? await noticeAlready() : undefined

      if (said) {
        dropRecord(effectsKey)
        dropRecord(seenKey)

        return { proceed: false, outcome: { state: 'published', eventId: said } }
      }

      if (await requeue(ask, { invocationId, effect: plan.effect, tools: plan.tools })) {
        deps.log?.(`[Matrix] invocation requeued effect=${plan.effect} source=${source}`)
        dropRecord(effectsKey)
        dropRecord(seenKey)

        if (plan.effect === 'side_effect_possible') {
          await announceChecking()
        }

        return { proceed: true }
      }
    }

    // A dispatch this Mac cannot vouch for belongs to the Mac that made it: it has the grace to
    // settle it, and is looked at again meanwhile. The grace runs from when THIS Mac first found the
    // message held by another (kept, so a restart does not start it again), never from the message:
    // a run that was going for minutes is old by then, and a grace counted from the message would
    // be spent before this Mac had even looked. It never outlasts the message's window.
    if (!own && automatic) {
      const seen = firstSeen(invocationId)

      const until = Math.min(
        Math.max((Number.isFinite(message.timestamp) ? message.timestamp! : seen) + MATRIX_SETTLE_GRACE_MS, seen + MATRIX_SETTLE_GRACE_MS),
        retryBefore ?? Infinity
      )

      /** What the platform now says of the record, when it is no longer the one this Mac waits on. */
      const lookAgain = async (
        tolerant: boolean
      ): Promise<{ proceed: true } | { proceed: false; outcome: MatrixTurnOutcome } | undefined> => {
        let again: { state?: unknown; publishedEvent?: unknown; invocationId?: unknown } | undefined

        try {
          again = (await deps.authorize({
            operation: 'recover',
            ...target,
            requestHash: binding.requestHash,
            agentPrincipal: context.agent.agentPrincipal
          })) as typeof again
        } catch (error) {
          // The last look before speaking cannot be the reason the owner hears nothing.
          if (!tolerant) {
            throw error
          }

          live()

          return undefined
        }

        live()

        if (typeof again?.publishedEvent === 'string' && again.publishedEvent.startsWith('$')) {
          return { proceed: false, outcome: { state: 'published', eventId: again.publishedEvent } }
        }

        if (again?.state === 'claimed') {
          return { proceed: true }
        }

        // It finished after all: the Mac that ran it has its answer and posts it.
        if (again?.state === 'completed') {
          return skip
        }

        // The record moved on without being queued (another run took it): its holder has it.
        if (typeof again?.invocationId === 'string' && again.invocationId !== invocationId) {
          return skip
        }

        return undefined
      }

      while (Date.now() < until) {
        await pause(Math.min(MATRIX_SETTLE_POLL_MS, until - Date.now()), signal)
        live()

        const settled = await lookAgain(false)

        if (settled) {
          return settled
        }
      }

      // The Mac that ran it may have finished in the moment after the last poll: once more before
      // anything is said, so the grace does not end in a second notice (the check below covers a
      // notice that Mac or another posted without the ledger).
      const settled = await lookAgain(true)

      if (settled) {
        return settled
      }
    }

    // Said by another Mac while this one waited or worked: the same notice, never a second.
    const said = await noticeAlready()

    if (said) {
      deps.log?.(`[Matrix] invocation notice already posted source=${source}`)
      dropRecord(effectsKey)
      dropRecord(seenKey)

      return { proceed: false, outcome: { state: 'published', eventId: said } }
    }

    const code =
      plan.kind === 'notice' ? plan.code : plan.kind === 'requeue' && plan.effect === 'side_effect_possible' ? 'couldnt_confirm' : 'failed'

    try {
      const eventId = await postNotice(ask, invocationId, code)
      deps.log?.(`[Matrix] invocation notice code=${code} source=${source}`)
      dropRecord(effectsKey)
      dropRecord(seenKey)

      return { proceed: false, outcome: { state: 'published', eventId } }
    } catch (error) {
      deps.log?.(`[Matrix] invocation notice unavailable reason=${matrixTurnFailure(error).code}`)

      return skip
    }
  }

  // A message the owner stopped is never run or reported again by this Mac, however it comes back.
  if (resumable && !outcome && readRecord(stoppedKey)) {
    deps.log?.('[Matrix] invocation left alone: the owner stopped it')

    return { state: 'ignored' }
  }

  if (automatic && !outcome) {
    // The same owner/agent ledger already supports cross-executor recovery.
    // A dispatched event is ambiguous even if no answer was published; never
    // use another host's missing local vault entry as permission to repeat it.
    const recovered = (await deps.authorize({
      operation: 'recover',
      ...target,
      requestHash: binding.requestHash,
      agentPrincipal: context.agent.agentPrincipal
    })) as Record<string, unknown>

    live()

    if (recovered?.state !== 'unknown') {
      if (
        recovered?.owner !== context.agent.principal ||
        recovered.roomId !== target.roomId ||
        recovered.eventId !== target.eventId ||
        recovered.requestHash !== binding.requestHash
      ) {
        throw new Error('matrix_outcome_invalid')
      }

      if (recovered.state === 'dispatched' || recovered.state === 'completed') {
        if (typeof recovered.publishedEvent === 'string' && recovered.publishedEvent.startsWith('$')) {
          return { state: 'published', eventId: recovered.publishedEvent }
        }

        // Dispatched before (here or on another Mac) with no answer posted: it may have run. It is
        // queued again only when that is shown to repeat nothing, run again with the facts when
        // something may have run, and otherwise said once to the owner (resolveStale).
        const settled = await resolveStale(makeAsk(deps.authorize), 'recover', {
          state: recovered.state,
          invocationId: recovered.invocationId,
          resume: recovered.resume
        })

        if ('outcome' in settled) {
          return settled.outcome
        }
      } else if (recovered.state !== 'claimed') {
        throw new Error('matrix_outcome_invalid')
      }
    }
  }

  // Older Hermes turns could execute messages with any addressing. Preserve
  // publication-only recovery of their saved results; this grants no new turn.
  if (
    !app &&
    !outcome &&
    (message.content.invalidMentions ||
      Boolean(!deps.group && mentions?.length && !mentions.includes(context.agent.userId)))
  ) {
    return { state: 'ignored' }
  }

  // A group turn: the owner's own text that names this agent, or replies to this agent's own
  // message naming nobody else (the sender was checked above: only the owner, from a verified
  // device). Its quote is read here, before anything is prepared or claimed, so a message that
  // turns out not to address this agent costs nothing and runs nothing.
  const group = !app && !outcome ? deps.group : undefined
  let groupQuote: MatrixGroupQuote | undefined

  if (group) {
    const answers = message.content.replyTo

    if (message.content.msgtype !== 'm.text') {
      return { state: 'ignored' }
    }

    if (answers) {
      groupQuote = await matrixReplyQuoteRead(
        deps.read,
        {
          roomId: target.roomId,
          eventId: answers,
          ownerId: context.human.userId,
          agentId: context.agent.userId,
          anyMember: true
        },
        live,
        signal
      )

      // Asked about a message it can't read: held, never half-answered (as in its own chat).
      if (!groupQuote) {
        await noticeHeldReply(deps, context, target, live)

        return { state: 'ignored' }
      }
    }

    const kind = classifyGroupTrigger({
      ownerUserId: context.human.userId,
      agentUserId: context.agent.userId,
      senderUserId: message.sender,
      senderVerified: message.senderVerified,
      roomMode: group.mode,
      mode:
        group.mode === 'shared' && group.participation === 'joins' ? 'addressed' : (group.participation ?? 'addressed'),
      ownAgentIds: group.ownAgentIds ?? [context.agent.userId],
      mentions: mentions ?? [],
      eventKind: 'text',
      replySenderId: groupQuote?.verified ? groupQuote.sender : undefined
    })

    if (kind === 'none' && !group.chain) {
      return { state: 'ignored' }
    }

    await deps.groupRevalidate?.()
  }

  if (
    !outcome &&
    !(await deps.prepare({ owner: context.agent.principal, executorId: context.agent.executorId, signal }))
  ) {
    live()

    return { state: 'setup_required' }
  }

  live()

  const document = !outcome ? deps.document?.() : undefined

  // Room-wide listening consent never grants ongoing access to a local file.
  if (document && deps.watch) {
    throw new Error('matrix_document_confirmation_required')
  }

  // A reply carries the message it answers as context, the way a typed reply does
  // (matrixTurnPrompt). Read before the claim: a pure read with no authority, so its retries
  // never spend the claim's time before dispatch. A reply whose quote cannot be read and
  // checked is not answered: "yes, do it" without the message it answers would be applied
  // to whatever the assistant asked last (the agent-room contract, matrix-turn-intake.ts).
  // Nothing is claimed for it, so a later recovery scan may offer it again; the owner hears
  // once that it was held (noticeHeldReply).
  const replyTo = app || outcome || group ? undefined : message.content.replyTo

  const quote = replyTo
    ? await matrixReplyQuote(
        deps.read,
        { roomId: target.roomId, eventId: replyTo, ownerId: context.human.userId, agentId: context.agent.userId },
        live,
        signal
      )
    : undefined

  if (replyTo && !quote) {
    await noticeHeldReply(deps, context, target, live)

    return { state: 'ignored' }
  }

  const attachmentNames = [file?.name, document?.name].filter(Boolean).join('\n') || undefined

  if (!outcome && !deps.watch && !(await deps.confirm(message.content.body, attachmentNames))) {
    return { state: 'cancelled' }
  }

  live()

  // The authority for this message, chosen once and then kept (see Dependencies.local);
  // a message without a server time is never assumed new.
  const local =
    records &&
    (!canonicalGroup || (Boolean(outcome) && route === 'local')) &&
    (route === 'local' ||
      (route === null && lease && Number.isFinite(message.timestamp) && message.timestamp! >= lease.notBefore))

  const authorize = local
    ? (input: Record<string, unknown>) => records.authorize(input, lease !== null)
    : (input: Record<string, unknown>) => {
        if (records && route === null) {
          records.markPlatform(target.roomId, target.eventId)
        }

        return deps.authorize(input)
      }

  const request = async (operation: string, invocationId?: string, publishedEvent?: string): Promise<Grant> => {
    live()

    const value = (await authorize({
      ...binding,
      operation,
      ...(canonicalGroup && !local
        ? {
            group: {
              mode: deps.group!.mode,
              dailyTurns: deps.group!.dailyTurns ?? DAILY_TURNS_DEFAULT,
              ...(deps.group!.chain ? { chain: deps.group!.chain } : {})
            }
          }
        : {}),
      ...(automatic || (canonicalGroup && !local)
        ? {
            protocol: 2,
            admission: 'automatic',
            leaseToken: automatic ? deps.automatic!.leaseToken : deps.groupLease!.leaseToken
          }
        : {}),
      ...(invocationId ? { invocationId } : {}),
      ...(publishedEvent ? { publishedEvent } : {})
    })) as Grant & Record<string, unknown>

    live()

    return matrixGrant(value, {
      agent: context.agent,
      binding,
      capability: app ? 'app-turn' : 'local-hermes-turn',
      appBinding,
      invocationId
    })
  }

  /**
   * The run this call dispatched ended without an answer. What it showed (turn-effects.ts) decides:
   * queued again (silently, or with the facts of what may have run), or the owner told once. The
   * verdict is kept before the platform is asked, so a Mac that cannot reach it now settles the
   * message the next time it sees it. Nothing happens for a run the owner stopped.
   */
  const settleFailure = async (
    error: unknown,
    code: string,
    run: { invocationId: string; prior?: MatrixTurnResume; effects: MatrixTurnEffects; timedOut: boolean }
  ): Promise<MatrixTurnOutcome | undefined> => {
    // What this run showed, with what the runs before it were known to have done.
    const evidence = matrixTurnEvidenceWith(run.effects.evidence(), run.prior)

    // Stop is read again wherever the settlement waits on the link: one pressed meanwhile is final.
    const stopped = () => matrixTurnStopped(error) || ownerStopped()

    const settlement = matrixTurnSettlement({
      evidence,
      reruns: run.prior?.attempt ?? 0,
      ...(run.prior ? { prior: run.prior } : {}),
      stopped: stopped(),
      // From the run's own deadline, not from its error: Hermes reports every failure of a turn as
      // the same closed code, so a time limit does not show in the error chain.
      timedOut: run.timedOut
    })

    if (settlement.kind === 'leave') {
      // Remembered: a message the owner stopped is never settled afterwards.
      markStopped(run.invocationId)

      return undefined
    }

    const noticeFor = (effect: MatrixTurnKnownEffect): 'couldnt_confirm' | 'failed' =>
      effect === 'side_effect_possible' ? 'couldnt_confirm' : 'failed'

    // What is to be done: queue it again, or say this.
    let requeuing = settlement.kind === 'requeue' ? settlement : undefined
    let notice: 'couldnt_confirm' | 'failed' | undefined = settlement.kind === 'notice' ? settlement.code : undefined

    // A message whose start window has closed (or is about to) cannot be offered again: queueing it
    // would spend a rerun that nobody can use, and the owner would hear nothing. It is said instead.
    const retryTime = (deps.settleRetryMs ?? MATRIX_SETTLE_RETRY_MS).reduce((total, pause) => total + pause, 0)

    if (requeuing && !canStillStart(retryTime)) {
      deps.log?.('[Matrix] invocation requeue skipped reason=window_closed')
      notice = noticeFor(requeuing.effect)
      requeuing = undefined
    }

    // The check instruction rides on a private chat turn's prompt only (see `runPrompt`): a group or app turn that may have acted
    // is said instead, never run again without it.
    if (requeuing?.effect === 'side_effect_possible' && (group || app)) {
      notice = 'couldnt_confirm'
      requeuing = undefined
    }

    try {
      writeEffects({ v: 1, invocationId: run.invocationId, phase: 'failed', effect: evidence.effect, tools: evidence.tools })
    } catch {
      // The verdict is still used now; only a later sighting loses it.
    }

    const ask = makeAsk(authorize)

    if (requeuing) {
      // A run cut off because the lease moved may have a notice from the Mac that took over; queueing
      // the message again would answer it after it was reported (the next sighting would too).
      const said = signal.aborted ? await noticeAlready() : undefined

      if (said) {
        dropRecord(effectsKey)

        return { state: 'unknown', failed: code }
      }

      if (await requeue(ask, { invocationId: run.invocationId, effect: requeuing.effect, tools: requeuing.tools })) {
        deps.log?.(`[Matrix] invocation requeued effect=${requeuing.effect} source=failure`)
        dropRecord(effectsKey)

        // Stop landed while it was being queued: this Mac never runs it again. (The queued claim
        // cannot be taken back; the mark keeps this Mac from taking it.)
        if (stopped()) {
          markStopped(run.invocationId)

          return undefined
        }

        if (requeuing.effect === 'side_effect_possible') {
          await announceChecking()
        }

        // The run failed: the listener counts it toward this Mac stepping aside (lease-handover.ts),
        // so a Mac that keeps failing hands the queued message to another one.
        return {
          state: 'deferred',
          reason: 'matrix_requeued',
          failed: code,
          ...(retryBefore !== undefined ? { retryBefore } : {}),
          ...(late ? { windowClosed: true as const } : {})
        }
      }

      notice = noticeFor(requeuing.effect)
    }

    if (stopped()) {
      markStopped(run.invocationId)

      return undefined
    }

    // A run that was cut off cannot speak any more (its host is gone): the next sighting settles it.
    // Unless that sighting can no longer happen (the window has closed): then this is the last
    // chance to tell the owner.
    if (signal.aborted && canStillStart()) {
      return undefined
    }

    // The window has closed on a cut-off run: the Mac that took over may have reported already.
    if (signal.aborted && (await noticeAlready())) {
      dropRecord(effectsKey)

      return { state: 'unknown', failed: code }
    }

    try {
      await postNotice(ask, run.invocationId, notice ?? 'failed')
      deps.log?.(`[Matrix] invocation notice code=${notice ?? 'failed'} source=failure`)
      dropRecord(effectsKey)
      signals?.seen?.(target.eventId, automatic || lease ? 'claimed' : 'lease')

      // The owner has been told; the run still ended without an answer, and is counted as such.
      return { state: 'unknown', failed: code }
    } catch (noticeError) {
      deps.log?.(`[Matrix] invocation notice unavailable reason=${matrixTurnFailure(noticeError).code}`)

      return undefined
    }
  }

  let grant = await request('claim')

  if (
    outcome &&
    (outcome.invocationId !== grant.invocationId ||
      typeof outcome.text !== 'string' ||
      !outcome.text ||
      (!app && !outcome.storedSession))
  ) {
    throw new Error('matrix_outcome_invalid')
  }

  if (grant.publishedEvent) {
    signals?.seen?.(target.eventId)

    return { state: 'published', eventId: grant.publishedEvent }
  }

  if (!outcome) {
    if (grant.state !== 'claimed') {
      if (grant.state === 'dispatched' || grant.state === 'completed') {
        // Dispatched before with no answer posted: settled like a recovered one (resolveStale).
        const settled = await resolveStale(makeAsk(authorize), 'claim', grant)

        if ('outcome' in settled) {
          return settled.outcome
        }

        // Queued again: take the fresh claim.
        grant = await request('claim')
      }

      if (grant.state !== 'claimed') {
        deps.log?.(`[Matrix] invocation claim skipped state=${grant.state}`)

        return { state: 'unknown' }
      }
    }

    if (grant.expiresAt <= Date.now()) {
      return { state: 'expired' }
    }

    // Advisory owner-SDK counter only after a canonical claim; failure grants nothing.
    if (canonicalGroup) {
      try {
        await deps.groupClaimed?.(grant.invocationId)
      } catch {
        console.warn('[Matrix] group usage update unavailable')
      }

      live()
    }

    deps.store.assertEncryptionAvailable()
    const attachments: MatrixHermesAttachment[] = []

    if (file) {
      // Only after consent and a fresh claim, never for publication recovery.
      const downloaded = (await deps.read(
        { kind: 'readInvocation', ...target, includeAttachment: true },
        // Media keeps its own time and size caps (MATRIX_MEDIA_TIMEOUT_MS,
        // MATRIX_MAX_FILE_BYTES). Allow the surrounding event/device verification round
        // trips too; dispatch still checks the live grant.
        MATRIX_MEDIA_TIMEOUT_MS + 45_000
      )) as MatrixInvocationMessage

      live()

      if (
        downloaded?.roomId !== message.roomId ||
        downloaded.eventId !== message.eventId ||
        downloaded.wireType !== message.wireType ||
        downloaded.sender !== message.sender ||
        downloaded.senderDevice !== message.senderDevice ||
        downloaded.senderVerified !== true ||
        downloaded.related !== message.related ||
        JSON.stringify(downloaded.content) !== JSON.stringify(message.content) ||
        (deps.watch &&
          (!Number.isFinite(downloaded.timestamp) ||
            (!automatic && groupTakenUpAt - downloaded.timestamp > GROUP_FRESHNESS_MS))) ||
        !(downloaded.attachmentBytes instanceof Uint8Array) ||
        downloaded.attachmentBytes.byteLength > MATRIX_MAX_FILE_BYTES
      ) {
        throw new Error('matrix_invocation_untrusted')
      }

      attachments.push({ name: file.name, bytes: downloaded.attachmentBytes })
    }

    if (document) {
      attachments.push(await document.capture())
      live()
    }

    // The quote read above goes before the person's words in this new message only; nothing
    // earlier is rewritten. The request hash stays the event's own (the platform and result
    // recovery bind the message, not the context), and a dispatched turn never runs again, so
    // the prompt that runs is built exactly once. The person's words lose only an older
    // client's rich-reply fallback: the quote is the one read and checked here, never the
    // client's copy of it.
    const answered = group ? message.content.replyTo : replyTo
    const words = answered ? matrixReplyWords(message.content.body) : message.content.body
    const visibleText = words.trim() ? words : message.content.body
    const text = message.content.forwarded ? `Forwarded message:\n${visibleText}` : visibleText

    // The person's first words in a new account's chat answer a welcome the model never saw: the
    // note that says so follows them, in this turn's prompt only (first-run-naming.ts).
    const firstRunNote =
      !app && !group && !replyTo && deps.firstRunNote
        ? await deps.firstRunNote({ roomId: target.roomId, eventId: target.eventId, signal }).catch(() => undefined)
        : undefined

    live()

    // A group turn says where it is and hands over its one quote as whose it is (group-turns.ts).
    const prompt = group
      ? matrixGroupRecentPrompt({
          text: group.chain
            ? `Reply in words only to this verified own assistant continuation of the owner's request. No tools, memory, or new authority.\n\n${text}`
            : text,
          mode: group.mode,
          ...(groupQuote ? { quote: groupQuote } : {}),
          ...(group.recent ? { recent: group.recent } : {})
        })
      : matrixTurnPrompt({
          text,
          ...(replyTo && quote ? { reply: { eventId: replyTo, quote } } : {}),
          ...(firstRunNote ? { context: firstRunNote } : {})
        })

    const petSurface = !app && !deps.group && deps.petSurface === true

    // Account/device/executor boundaries are main-verified, not UI session
    // IDs. Top-level room continuity only; thread routing is a later slice.
    const conversationKey = matrixConversationKey(
      context.agent,
      context.human,
      target.roomId,
      undefined,
      group,
      petSurface
    )

    /** Refused before dispatch for now, not for good: the claim stays, and the turn may be offered again. */
    const deferral = (error: unknown): MatrixTurnOutcome => {
      live()
      const failure = matrixTurnFailure(error)

      if (MATRIX_TURN_REFUSALS.has(failure.code)) {
        throw error
      }

      deps.log?.(`[Matrix] invocation deferred reason=${failure.code}${matrixFailureRpc(failure)}`)

      return {
        state: 'deferred',
        reason: failure.code,
        claimUntil: grant.expiresAt,
        ...(retryBefore !== undefined ? { retryBefore } : {}),
        // The window has closed on a message that is still answered: the listener must drop the
        // horizon an earlier attempt stored rather than reuse it (hermes-listener.ts `defer`).
        ...(late ? { windowClosed: true as const } : {})
      }
    }

    // An earlier run of this message may have done something: this run gets the facts with its one
    // prompt, after the person's words (turn-effects.ts). Nothing earlier is rewritten and no
    // message is added, so the conversation's cached prefix and its role alternation stay as they were.
    let runPrompt = prompt

    if (!group && !app && grant.resume?.effect === 'side_effect_possible') {
      runPrompt = matrixResumePrompt(prompt, grant.resume, MATRIX_PROMPT_MAX)
    }

    // Everything that can refuse without Hermes comes before dispatch (the room's re-read, the
    // conversation's history): a slow or failed read then costs a retry, never a turn that counts
    // as run but never answers.
    let conversation: MatrixPreparedConversation | undefined

    if (deps.conversation) {
      try {
        conversation = await deps.conversation({ conversationKey, ...(petSurface ? { petSurface } : {}), signal })
      } catch (error) {
        return deferral(error)
      }

      live()
    }

    if (remote) {
      // Preparation and attachment downloads can outlive device revocation,
      // redaction or the live-message window. Re-fetch crypto truth immediately
      // before dispatch; neither the listener hint nor the earlier read is enough.
      // A read that fails (not one that disagrees) is a refusal for now.
      let current: MatrixInvocationMessage

      try {
        current = (await deps.read({ kind: 'readInvocation', ...target })) as MatrixInvocationMessage
      } catch (error) {
        return deferral(error)
      }

      live()

      if (
        current?.roomId !== message.roomId ||
        current.eventId !== message.eventId ||
        current.wireType !== message.wireType ||
        current.sender !== message.sender ||
        current.senderDevice !== message.senderDevice ||
        current.senderVerified !== true ||
        current.related !== message.related ||
        !newMessage(current) ||
        JSON.stringify(current.content) !== JSON.stringify(message.content) ||
        !Number.isFinite(current.timestamp) ||
        current.timestamp < (deps.watch!.automatic?.windowStart ?? deps.watch!.since + 1) ||
        (!automatic && !canonicalGroup && current.timestamp < lease!.notBefore) ||
        current.timestamp > Date.now()
      ) {
        throw new Error('matrix_invocation_untrusted')
      }

      // The same message, only older than its window by now (the steps above ran long): not
      // distrust. A phone message is answered late; a group message nobody could still start
      // is handed back to the listener, which sees its window has passed.
      if (automatic) {
        if (Date.now() - current.timestamp > windowEnd! - message.timestamp!) {
          late = true
          retryBefore = undefined
        }
      } else if (!isGroupFresh({ timestamp: current.timestamp, now: groupTakenUpAt, floor: deps.group?.floor })) {
        return deferral(new Error('matrix_invocation_window_passed'))
      }
    }

    await deps.groupRevalidate?.()

    // The first heartbeat happens only after dispatch. Reach that transition with enough of the
    // initial claim left; otherwise defer without running and take a fresh claim next time.
    if (grant.expiresAt - Date.now() < MATRIX_DISPATCH_CLAIM_MARGIN_MS) {
      return deferral(new Error('matrix_invocation_claim_expiring'))
    }

    // The server's atomic transition precedes ALL model/tool execution. A lost
    // dispatch acknowledgment, failed vault write or process crash never retries.
    // Runs this message has had before this one (the platform counts them), and what they did.
    const prior = grant.resume
    const effects = new MatrixTurnEffects()
    const dispatched = grant.invocationId

    // This Mac's own record of the run, durable before the fence is spent and before anything can be
    // submitted: dispatched and never submitted proves nothing ran, through a crash and through a
    // dispatch whose answer never came back (turn-effects.ts). The fence does not change at dispatch.
    if (resumable) {
      try {
        writeEffects({ v: 1, invocationId: dispatched, phase: 'dispatched' })
      } catch {
        // Only the proof is lost, not the run: a crash now reads as "unknown" instead of "nothing ran".
      }
    }

    grant = await request('dispatch', grant.invocationId)

    if (grant.state !== 'dispatched' || grant.expiresAt <= Date.now()) {
      deps.log?.(`[Matrix] invocation dispatch refused state=${grant.state}`)

      // Recorded as dispatched on a claim that had lapsed: nothing was run, so it is queued again.
      if (resumable && grant.state === 'dispatched') {
        const ask = makeAsk(authorize)

        if (await requeue(ask, { invocationId: grant.invocationId, effect: 'none', tools: [] })) {
          deps.log?.('[Matrix] invocation requeued effect=none source=dispatch')

          return {
            state: 'deferred',
            reason: 'matrix_requeued',
            ...(retryBefore !== undefined ? { retryBefore } : {}),
            ...(late ? { windowClosed: true as const } : {})
          }
        }

        // The platform cannot queue it again (an older one, or its link is down), and the record
        // says dispatched although nothing reached Hermes: the owner must not be left unanswered.
        // While the listener can still offer it, it is offered again: the next sighting queues it
        // if the platform can by then, and otherwise says so from this Mac's own record (nothing
        // ran: "failed, try again"), once. With no offer left it is said now.
        if (canStillStart()) {
          deps.log?.('[Matrix] invocation deferred reason=matrix_dispatch_lapsed')

          return {
            state: 'deferred',
            reason: 'matrix_dispatch_lapsed',
            ...(retryBefore !== undefined ? { retryBefore } : {}),
            ...(late ? { windowClosed: true as const } : {})
          }
        }

        try {
          const eventId = (await noticeAlready()) ?? (await postNotice(ask, grant.invocationId, 'failed'))
          deps.log?.('[Matrix] invocation notice code=failed source=dispatch')
          dropRecord(effectsKey)

          return { state: 'published', eventId }
        } catch (noticeError) {
          deps.log?.(`[Matrix] invocation notice unavailable reason=${matrixTurnFailure(noticeError).code}`)
        }
      }

      return { state: 'unknown' }
    }

    // agent-home/1.5 is additive. A supporting platform re-arms this exact dispatched fence while
    // the automatic turn is alive. An older platform refuses the first heartbeat; retain its old
    // static claim deadline and otherwise run exactly as before.
    let claimHeartbeat: MatrixClaimHeartbeat | undefined

    if (automatic && !local) {
      try {
        claimHeartbeat = await startMatrixClaimHeartbeat(grant.invocationId, async () => {
          const heartbeat = await request('heartbeat', grant.invocationId)

          return {
            invocationId: heartbeat.invocationId,
            state: heartbeat.state,
            expiresAt: heartbeat.expiresAt
          }
        })
      } catch {
        deps.log?.('[Matrix] invocation heartbeat unavailable; using initial claim deadline')
      }
    }

    // Said once, and only now that the platform has taken the dispatch: a phone message answered
    // past its window tells the owner it was only just seen. A dispatch the platform then refuses
    // must not first say it is being worked on and go silent; a later attempt that is taken up
    // still says it once. Never a refusal, and still before anything runs.
    if (late) {
      await noticeHeldReply(deps, context, target, live, 'lateSeen')
    }

    // Taken up: every check passed and the fence admitted it here. Only now does the agent mark
    // it seen, and only the Mac holding the answering lease says it is typing (agent-turns v1.1).
    signals?.seen?.(target.eventId)
    const work = signals && (automatic || lease) ? signals.work() : undefined
    let typing = Boolean(work)

    const stopTyping = () => {
      if (typing) {
        typing = false
        work?.stop()
      }
    }

    const now = Date.now()
    const dispatchedAt = now
    // The credential as it is now: renewed since the turn began, it ends later. Unreadable,
    // the one the turn began with.
    let agentExpiresAt = context.agent.expiresAt

    try {
      agentExpiresAt = deps.context().agent.expiresAt
    } catch {
      /* Kept as it was: the turn's own checks stop it. */
    }

    // An automatic turn (a phone message, answered while this Mac listens) and a listener turn
    // this Mac answers under its answering lease run to their own quiet-time cap, not a wall
    // clock (reliability plan §6.1 A): 30 minutes with no session event ends the run, while an
    // active run may go on. The platform's fixed invocation window (0168/0224) is not the
    // automatic turn's bound: with LA8 the grant becomes a heartbeat-extended lease, so the run
    // ends when the answer does, when the answering lease is lost (its signal), or when the
    // owner presses Stop. The credential and the watch do not cut it at the end they have at
    // dispatch either: the credential is renewed while the turn runs (credential-renewal.ts),
    // the watch's end follows each renewal, and a watch that does end still stops the turn
    // through the listener's signal. Other turns keep every bound as they are. Until LA8 lands,
    // a phone run longer than the platform's grant window can still be refused at
    // `complete`/`published` by the server's fixed window; the ledger calls carry the automatic
    // admission and lease token either way.
    const deadlineAt = Math.min(
      now + (automatic ? LOCAL_TURN_LIMIT_MS : (local || canonicalGroup) && lease ? lease.turnLimitMs : 90_000),
      claimHeartbeat ? Infinity : grant.expiresAt,
      automatic ? Infinity : agentExpiresAt,
      automatic ? Infinity : (deps.watch?.until ?? Infinity)
    )

    // The run's own cap as quiet time where one applies (Hermes's own shape, in
    // runMatrixHermesTurn): no wall-clock signal here, only the listener's own (a watch that
    // ends still stops the turn; Stop goes through it too). A platform grant's claim is the
    // hard bound for every other turn, as its own signal, and a live claim heartbeat keeps
    // its short expiry from ending the run.
    const inactivityMs =
      automatic ? LOCAL_TURN_LIMIT_MS : (local || canonicalGroup) && lease ? lease.turnLimitMs : undefined

    const deadline =
      inactivityMs === undefined
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(Math.max(0, deadlineAt - now)),
            ...(claimHeartbeat ? [claimHeartbeat.signal] : [])
          ])
        : AbortSignal.any([signal, ...(claimHeartbeat ? [claimHeartbeat.signal] : [])])

    // From here to the end of its settlement this run is the one that holds the message.
    if (resumable) {
      inFlight(deps.store).add(effectsKey)
    }

    try {
      const result = await deps.execute({
        owner: context.agent.principal,
        executorId: context.agent.executorId,
        invocationId: grant.invocationId,
        conversationKey,
        ...(conversation ? { conversation } : {}),
        ...(petSurface ? { petSurface: true } : {}),
        text: runPrompt,
        effects,
        ...(resumable
          ? { onSubmit: () => writeEffects({ v: 1, invocationId: dispatched, phase: 'submitted' }) }
          : {}),
        ...(app ? { mentionedUserIds: [...new Set(mentions!)].sort() } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(document?.word ? { onWord: document.word } : {}),
        ...(work ? { work } : {}),
        signal: deadline,
        deadlineAt,
        ...(inactivityMs === undefined ? {} : { inactivityMs })
      })

      // Any length: an answer too long for one message is posted as several below.
      if (
        typeof result?.text !== 'string' ||
        !result.text ||
        (!app && (typeof result.storedSession !== 'string' || !result.storedSession))
      ) {
        throw new Error('matrix_outcome_invalid')
      }

      // Even if account closure raced completion, retain the result under its
      // old owner's encrypted key, but never publish through a new account.
      const pet = petSurface ? matrixPetIntentEnvelope(result.pet) : undefined
      outcome = {
        text: result.text,
        ...(pet ? { pet } : {}),
        ...(!app ? { storedSession: result.storedSession } : {}),
        invocationId: grant.invocationId
      }
      deps.store.setItem(key, JSON.stringify(outcome))
      dropRecord(effectsKey)
    } catch (error) {
      // Dispatched, so it may have run. Said once, as a closed code, how long after dispatch, and
      // Hermes's RPC code if any, so a turn that ends unanswered is traceable.
      const failure = matrixTurnFailure(error)
      deps.log?.(
        `[Matrix] invocation failed after dispatch reason=${failure.code} ms=${Date.now() - dispatchedAt}${matrixFailureRpc(failure)}`
      )

      if (resumable) {
        stopTyping()
        // The time limit, from the clock it runs on: the run's own deadline fired and the caller did not
        // cut it off first.
        const timedOut = !signal.aborted && (deadline.aborted || Date.now() >= deadlineAt)

        const settled = await settleFailure(error, failure.code, {
          invocationId: dispatched,
          prior,
          effects,
          timedOut
        })

        if (settled) {
          return settled
        }
      }

      return { state: 'unknown', failed: failure.code }
    } finally {
      await claimHeartbeat?.stop()
      stopTyping()
      inFlight(deps.store).delete(effectsKey)
    }
  }

  try {
    grant = await request('complete', grant.invocationId)

    if (grant.state !== 'completed' || !grant.transactionId) {
      throw new Error('matrix_outcome_invalid')
    }

    live()
    // Same device, endpoint and transaction only; never reconstruct the result
    // by asking Hermes to run again. Other devices require separate reconciliation.
    // An answer too long for one message goes as several, in order, each under its own fixed
    // transaction, each recorded once posted, so a retry resumes at the next part
    // (matrix-answer-parts.ts). The pet's reply data rides on the last part.
    const parts = matrixAnswerParts(outcome.text)

    while (outcome.publishedEvent === undefined) {
      const index = outcome.publishedParts?.length ?? 0

      // Every part is already posted (a record written by a build that split it otherwise).
      if (index > 0 && index >= parts.length) {
        outcome.publishedEvent = outcome.publishedParts!.at(-1)
        deps.store.setItem(key, JSON.stringify(outcome))

        break
      }

      const last = index >= parts.length - 1
      const pet = last && !app && !deps.group ? matrixPetIntentEnvelope(outcome.pet) : undefined
      // A meeting is handed on once, with the last part (main.ts), to whoever the whole answer names.
      const mentionsFrom = last && parts.length > 1 && deps.group?.mode === 'meeting' ? outcome.text : undefined

      const eventId = (await deps.read({
        kind: 'publishResult',
        ...target,
        body: parts[index]!,
        ...(pet ? { pet } : {}),
        ...(app ? { app: true as const } : {}),
        ...(mentionsFrom !== undefined ? { mentionsFrom } : {}),
        invocationId: grant.invocationId,
        transactionId: grant.transactionId,
        // The invocation is completed on the platform's ledger: for a migrated agent that is where the worker records it.
        ledger: true as const,
        ...(parts.length > 1
          ? {
              part: { index, count: parts.length },
              ...(index > 0 ? { matrixTransactionId: matrixAnswerPartTransaction(grant.transactionId, index) } : {})
            }
          : {})
      })) as string

      if (typeof eventId !== 'string' || !eventId.startsWith('$')) {
        throw new Error('matrix_outcome_invalid')
      }

      if (parts.length > 1) {
        outcome.publishedParts = [...(outcome.publishedParts ?? []), eventId]
      }

      if (last) {
        outcome.publishedEvent = eventId
      }

      deps.store.setItem(key, JSON.stringify(outcome))
      live()
    }

    if (typeof outcome.publishedEvent !== 'string' || !outcome.publishedEvent.startsWith('$')) {
      throw new Error('matrix_outcome_invalid')
    }

    deps.store.setItem(key, JSON.stringify(outcome))
    // Answered: the receipt may now move past it (and anything it was holding back). A turn
    // this run took up under the answering lease stays this executor's to acknowledge.
    signals?.seen?.(target.eventId, automatic || lease ? 'claimed' : 'lease')

    // Sent by the platform's worker, which has recorded the event on the ledger itself: nothing to acknowledge.
    if (!deps.ledgerPublishes?.(grant.invocationId)) {
      await request('published', grant.invocationId, outcome.publishedEvent)
    }

    return { state: 'published', eventId: outcome.publishedEvent }
  } catch (error) {
    const failure = matrixTurnFailure(error)
    deps.log?.(`[Matrix] invocation publication pending reason=${failure.code}${matrixFailureRpc(failure)}`)

    // The platform refused the result for good, or cannot say whether it was sent: that is a failure to say, not a
    // wait that will end, and it is never answered by sending from here.
    if (failure.code === 'matrix_publication_refused' || failure.code === 'matrix_publication_uncertain') {
      return { state: 'unknown', failed: failure.code }
    }

    return { state: 'publication_pending' }
  }
}
