/**
 * One agent's runtime on this Mac ( §2.1): its
 * SDK host role, its Hermes executor and its start guard, its answering lease, its turn
 * lock, local-turn engine and listener, its scheduled posts, and what the UI shows for it.
 *
 * The default agent's runtime uses the host role `agent` and the vault keys that shipped,
 * so nothing it already stored moves (default-agent-identity.test.ts). Shared state (the
 * window, the human and app hosts, the account and vault, the model proxy's socket) stays
 * in main.
 */
import type { AtumAssistantMark } from '../../shared/atum-agent-portability'
import type { MatrixIdentity, MatrixSnapshot } from '../../shared/matrix'
import type { MatrixGroupMode } from '../../shared/matrix-group-room'
import type { MatrixConnectedModel, MatrixEffort, MatrixModelId } from '../../shared/matrix-models'
import type { EncryptedStore } from '../encrypted-store'

import type { MatrixAgentHire } from './agent-definition'
import type { MatrixAgentSignals } from './agent-signals'
import type { MatrixContinuousListening } from './continuous-listening'
import type { MatrixCronDelivery } from './cron-delivery'
import type { MatrixHermesExecutor } from './hermes-executor'
import type { MatrixHermesListener } from './hermes-listener'
import type { MatrixHermesPrompts } from './hermes-prompts'
import type { MatrixExecutorLease } from './lease'
import type { MatrixLocalTurns } from './local-turn'
import type { MatrixReadinessMonitor } from './readiness'
import type { MatrixHostRole } from './sdk-host'
import type { MatrixStoreScheduleGateway } from './store-schedules'
import { MatrixHermesTurnLock } from './turn-lock'

/** What an agent is doing right now: a turn, a model check or a recovery. The default
 * agent's slot also holds app turns, so the default agent and apps never run together, as
 * before several agents. */
export interface MatrixTurnSlot {
  abort: AbortController
  pending: Promise<unknown>
  prompts?: MatrixHermesPrompts
  roomId?: string
  /** Platform dispatch fence, used when another Mac holds the answering lease. */
  invocationId?: string
  /** Exact lease-session signal captured when this room turn was admitted. */
  leaseSignal?: AbortSignal
  /** Stable server instruction context for this entire Hermes session. */
  storeTask?: {
    taskId: string
    assistantId: string
    executorId: string
    conversationId: string
    leaseToken?: string
    invocationId?: string
  }
  activity?: MatrixSnapshot['hermesActivity']
  app?: { slug: string; id: string }
  /** The model this Hermes turn runs on; the loopback proxy applies it. */
  model?: MatrixModelId
  /** The thinking level chosen for it, if any; the proxy sends it with Atum's model. */
  effort?: MatrixEffort
  /** A model check or the person's own Hermes setup: it only configures this agent's Hermes
   * on this Mac and never reads or posts through a Matrix host, so a host that is starting
   * or offline does not end it (matrixTurnsNeedingHost). An authority stop or expiry still does;
   * a replaceable SDK renderer crash does not own this main-process slot. */
  setup?: true
  /** The person pressed Stop on this turn: whatever ends it afterwards is final (turn-failure.ts
   * MATRIX_TURN_STOPPED), never queued again and never reported as unconfirmed. */
  stopRequested?: true
  /** A turn in a group the agent is in (owner-only, group-turns.ts), not in its own chat: the
   * private room's checks and its listening are not about it. */
  group?: true
  /** That group turn's mode when it began: a private meeting's turn ends as soon as anyone
   * else is in the group (group-turns.ts matrixGroupTurnInvalidated). */
  groupMode?: MatrixGroupMode
}

/** Where an agent other than the default keeps its vault entries: every one of them, so
 * retiring it removes exactly its own ( §2.7). */
export const matrixAgentScope = (principal: string) => `${MATRIX_AGENT_SCOPES}${principal}:`

/** What every agent scope starts with: the default agent's removal keeps them all. */
export const MATRIX_AGENT_SCOPES = 'agent:'

/** A ready model is not answering demand. Setup/model probes have no room. A check-in's
 * claim (check-ins.ts) is, for the moment it takes, and so is the owner's message to it in a
 * group while this Mac asks to answer it (group-turns.ts), or a paid assistant’s
 * scheduled run (store-schedules.ts). */
export function matrixAgentLeaseDemand(agent: MatrixAgentRuntime): boolean {
  return Boolean(
    agent.continuous?.wantsLease ||
    agent.listener.snapshot()?.state === 'listening' ||
    (agent.listeningConsent && !agent.listeningConsent.signal.aborted) ||
    agent.localTurns?.executionPending ||
    agent.invocation?.roomId ||
    agent.checkInDemand > 0 ||
    agent.groupDemand > 0 ||
    agent.backgroundDemand > 0
  )
}

/** A room turn belongs to the lease session that is still held now, never a successor term. */
export function matrixTurnOwnsHeldLease(
  turn: Pick<MatrixTurnSlot, 'roomId' | 'leaseSignal'> | undefined,
  held: { signal: AbortSignal } | null | undefined
): boolean {
  return Boolean(turn?.roomId && turn.leaseSignal && held && turn.leaseSignal === held.signal && !held.signal.aborted)
}

/** Lifecycle reconciliation only; the lease remains the sole execution authority. */
export function reconcileMatrixAgentLease(agent: MatrixAgentRuntime, executorId: string, protocol?: 2): void {
  if (matrixAgentLeaseDemand(agent)) {
    agent.lease?.start(executorId, protocol)
  } else {
    void agent.lease?.release()
  }
}

export class MatrixAgentRuntime {
  /** This agent's vault: the root for the default agent (its keys unchanged), a scope of
   * it (matrixAgentScope) for every other agent. */
  store!: EncryptedStore
  /** What this agent is doing right now (see MatrixTurnSlot). */
  invocation?: MatrixTurnSlot
  /** Set while this agent's own operation runs (a send, a consent, a picker, its enrollment).
   * It holds up this agent's turns and the account-wide operations, never another agent's. */
  operation = false
  /** Stopped for good (retired, or signed out): nothing starts for it again. */
  closed = false
  /** The Hermes backend's executor for this agent, while one is running. */
  executor?: MatrixHermesExecutor
  /** Set while the backend is starting, so two starts never race. */
  starting?: Promise<boolean>
  /** One answering executor per agent, leased once per session. */
  lease?: MatrixExecutorLease
  /** The last lease state written to the log, so renewals do not repeat it. */
  leaseLogged?: string
  /** The last line saying it no longer holds the cold start (main's logLaunchExclusion), so
   * its gate's retries of the same stop do not repeat it. */
  launchExclusionLogged?: string
  /** One Hermes turn at a time for this agent, across the local and server paths. */
  readonly lock = new MatrixHermesTurnLock()
  /** The local path's engine for this agent. */
  localTurns?: MatrixLocalTurns
  /** Its read receipt and typing in its own chat (agent-turns v1.1 Presentation signals). */
  signals?: MatrixAgentSignals
  /** The server path's room watch for this agent. */
  listener!: MatrixHermesListener
  continuous?: MatrixContinuousListening
  listeningConsent?: AbortController
  /** Posts this agent's scheduled results into its room. */
  cron?: MatrixCronDelivery
  /** Stops answering scheduled posts on the previous backend's connection. */
  cronListening?: () => void
  /** Stops answering check-in ticks on the previous backend's connection (check-ins.ts). */
  checkInListening?: () => void
  /** Check-in claims waiting for or holding the answering lease on this Mac. */
  checkInDemand = 0
  /** Group messages to this agent waiting for this Mac to hold its answering lease. */
  groupDemand = 0
  /** When this agent host's group watch began (src/matrix/group-turns.ts): no earlier message
   * is offered, and main refuses one older than this too. */
  groupWatchSince?: number
  /** Background work waiting for or holding the answering lease on this Mac: a check-in's
   * claim, or a paid assistant's scheduled run (store-schedules.ts). */
  backgroundDemand = 0
  /** The running backend's connection, for the Store jobs and hire skills of a paid
   * assistant (store-schedules.ts). */
  storeGateway?: MatrixStoreScheduleGateway
  /** The room the running backend was started with as its Hermes home room. */
  homeRoom?: string
  /** Ends with the running backend, set only while that backend was launched with its cron ticker on
   * (cron-hold.ts). A backend launched with the ticker off has none to hold. */
  cronTicker?: AbortSignal
  /** The running ticker's hold could not be written, so it is un-held. The backend is restarted with
   * the ticker off (main's `refreshUnheldCronTicker`); a hold that succeeds again clears it. */
  cronTickerUnheld = false
  /** The plan wants this Mac's ticker firing (it answers and runs jobs) but the running backend was
   * launched without one (cron-hold.ts `matrixJobsTickerMissing`); main restarts it with the ticker on. */
  cronTickerMissing = false
  /** Another agent's Hermes home for its current executor, once its host start settled it
   * (agent-home.ts); read on every publish without the vault. */
  hermesHome?: { executorId: string; profiles: string; home: string }
  /** Whether this Mac is the agent's home device (created or imported here; agent-home.ts),
   * settled per executor so typed messages are routed without reading the disk. */
  hosted?: { executorId: string; hosted: boolean }
  /** The person brought their own model for this agent: Atum's picker does not apply. */
  ownModel = false
  /** The connected model when `ownModel` and it is known (display, and the turn-boundary
   * switch in hermes-turn.ts). */
  connectedModel?: MatrixConnectedModel
  promptNotice: MatrixSnapshot['hermesPromptNotice']
  /** Non-secret enrollment metadata, kept across host failure or expiry, cleared on revoke. */
  identity?: MatrixIdentity
  /** The agent principal it answers for, for display: another agent's own principal, the
   * default agent's from its enrollment when its host starts. */
  agentPrincipal?: string
  /** This agent's gate and watch. */
  readiness?: MatrixReadinessMonitor
  /** Another agent's setup in flight, and how its last one ended (see setUpAgent in main). */
  setup?: Promise<void>
  setupState?: MatrixSnapshot['assistantSetup']
  /** Set when the platform asked this agent's enrollment to wait (a 429's Retry-After, 0150):
   * its gate waits until then instead of reporting a failure. */
  setupRetryAt?: number
  /** Its executor being replaced here, while that runs (agent-reenroll.ts). */
  reenrolling?: Promise<unknown>
  /** Its last model check found the person's own plan (e.g. their ChatGPT plan) selected but
   * unusable: its readiness says `plan_sign_in` (main's configureManagedModelLocked). */
  planSignIn = false
  /** Plan sign-ins the person is approving on its running backend (pages-providers.ts): while
   * any is, nothing optional stops that backend (`holdsSignIn`). */
  signIns = 0
  /** Its executor needs the person's Reconnect: today's automatic replacements are used up
   * (`capped`), or one could not finish (`failed`). Cleared when a replacement starts. */
  reconnectRequired?: 'capped' | 'failed'
  /** The default agent's Hermes home before its executor was replaced: its next host start
   * moves it to the new executor's name (agent-reenroll.ts `carryMatrixHermesHome`). */
  carryHome?: string
  /** Another agent's roster entry: its assistant ID (for retire), name and Matrix user. */
  assistantId?: string
  name?: string
  title?: string
  mark?: AtumAssistantMark
  /** Its hire (atum.agent-hire/1) from the roster: absent when free; `paused` when a renewal failed. */
  hire?: MatrixAgentHire
  /** Canonical owner-scoped assistant photo; Matrix profile media is not agent identity authority. */
  avatarUrl: string | null = null
  matrixUser?: string

  /** `principal` is undefined for the default agent, whose enrollment is the account's own. */
  constructor(
    readonly role: MatrixHostRole,
    readonly principal?: string
  ) {
    this.agentPrincipal = principal
  }

  /** Its Matrix user: from its enrollment, else from the roster before it is enrolled here. */
  get userId(): string | undefined {
    return this.identity?.userId ?? this.matrixUser
  }

  /**
   * Its running backend holds a plan sign-in the person is approving: Hermes saves the tokens
   * only in that process, once they approve in the browser. Until the sign-in ends nothing
   * optional stops it (a restart for a new jobs room or Google tools, a model check, a model
   * switch); those wait and run after. Custody still stops it at once (sign-out, an expired or
   * failed agent host, quit). A backend that has already exited holds no sign-in, so replacing
   * it is never held.
   */
  get holdsSignIn(): boolean {
    return this.signIns > 0 && Boolean(this.executor?.usable)
  }

  /** Its running backend was launched with the cron ticker on, and that backend is still up. */
  get cronTickerRunning(): boolean {
    return Boolean(this.cronTicker && !this.cronTicker.aborted)
  }
}

/** An optional restart of the agent's backend (its jobs room became known, its Google tools
 * changed) may stop it now: it is running and idle, and holds no sign-in. Otherwise the restart
 * waits; main tries again at its next publish. */
export function matrixBackendRestartable(agent: MatrixAgentRuntime, app: { busy: boolean; closing: boolean }): boolean {
  return (
    Boolean(agent.executor?.usable) &&
    !agent.starting &&
    !agent.invocation &&
    !agent.operation &&
    !app.busy &&
    !app.closing &&
    !agent.holdsSignIn
  )
}

/**
 * An un-held cron ticker (its hold could not be written; cron-hold.ts) may be taken off its backend
 * now. Not an optional restart like `matrixBackendRestartable`: a ticker that fires on a Mac that
 * must not is a job that runs twice, so only what must not be cut waits. That is a reply in progress
 * (the Mac still holds the term then, so nothing else fires), a plan sign-in being approved on this
 * very backend (it lives only in that process), and a start already under way (its end publishes
 * and asks again). The restart's launch applies the hold again and, if it still cannot be written,
 * starts without a ticker.
 */
export function matrixUnheldTickerRestartable(agent: MatrixAgentRuntime, app: { closing: boolean }): boolean {
  return (
    agent.cronTickerUnheld &&
    agent.cronTickerRunning &&
    !app.closing &&
    !agent.closed &&
    !agent.starting &&
    !agent.invocation &&
    !agent.holdsSignIn
  )
}

/**
 * A running backend with no cron ticker (its agent's plan wants one firing now: cron-hold.ts
 * `matrixJobsTickerMissing`) may be restarted with the ticker on. Unlike the un-held ticker this is
 * not urgent (a job that waits is recoverable, nothing runs twice), and the restart cuts the
 * person's work in flight, so it waits like an optional restart: an idle backend, no sign-in, no
 * start under way. Main tries again at every publish.
 */
export function matrixMissingTickerRestartable(
  agent: MatrixAgentRuntime,
  app: { busy: boolean; closing: boolean }
): boolean {
  return agent.cronTickerMissing && !agent.cronTickerRunning && matrixBackendRestartable(agent, app)
}

/**
 * Nothing of this agent's own is writing its home right now, apart from what the turn lock says: no turn, task, local
 * question or start under way, no claim waiting for the lease (a check-in, a group message, a scheduled run), no operation
 * of its own or the account's, no conversation change, and the app not closing. The facts a checkpoint's barrier asks once it
 * holds the turn lock itself (agent-home-placement/at-rest.ts `agentHoldWrites`), where the lock being held is its own.
 *
 * It is not `matrixBackendRestartable`: a capture does not touch the backend, so a plan sign-in being approved on it
 * (`holdsSignIn`, which lives only in that process) does not matter here.
 */
export function matrixAgentQuiet(
  agent: MatrixAgentRuntime,
  app: { busy: boolean; closing: boolean; conversationPending: boolean }
): boolean {
  return (
    !app.busy &&
    !app.closing &&
    !app.conversationPending &&
    !agent.closed &&
    !agent.starting &&
    !agent.invocation &&
    !agent.operation &&
    !agent.localTurns?.executionPending &&
    agent.groupDemand === 0 &&
    agent.backgroundDemand === 0 &&
    agent.checkInDemand === 0
  )
}

/**
 * Quiet, and nobody holds the turn lock or waits for it: a good moment for the placement model's checkpoint cadence to start
 * one (agent-home-placement/cadence.ts). It stops nothing and holds nothing, so asking is free: this only chooses the moment.
 * The writers are held still afterwards, for the moment the snapshot takes, by the barrier (`matrixAgentQuiet` plus the lock).
 */
export function matrixAgentAtRest(
  agent: MatrixAgentRuntime,
  app: { busy: boolean; closing: boolean; conversationPending: boolean }
): boolean {
  return matrixAgentQuiet(agent, app) && !agent.lock.holder && !agent.lock.waiting
}
