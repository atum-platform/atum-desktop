import { createHash, randomUUID } from 'node:crypto'

import {
  MATRIX_PROMPT_MAX,
  MATRIX_TURN_QUOTE_MAX,
  type MatrixIdentity,
  type MatrixLocalTurnNotice,
  type MatrixLocalTurnState,
  type MatrixLocalTurnView,
  type MatrixMessage,
  matrixMessageTooLong,
  type MatrixSdkCommand,
  type MatrixTurnLookup,
  type MatrixTurnReply
} from '../../shared/matrix'
import { type MatrixAnswerPart, matrixAnswerParts, matrixAnswerPartTransaction } from '../../shared/matrix-answer-parts'
import type { MatrixHermesActivitySnapshot } from '../../shared/matrix-hermes-activity'
import type { MatrixEffort, MatrixModelId } from '../../shared/matrix-models'
import { type MatrixPetIntentEnvelope, matrixPetIntentEnvelope } from '../../shared/matrix-pet-intent'
import type { MatrixSeenProof } from '../../shared/matrix-presentation-signals'
import type { MatrixHermesProgressEvent } from '../../shared/matrix-progress-line'
import { matrixAnswerTransaction, matrixQuestionTransaction } from '../../shared/matrix-turn'
import type { EncryptedStore } from '../encrypted-store'

import type { MatrixAgentWork } from './agent-signals'
import type { MatrixGrant } from './invocation'
import { LOCAL_TURN_LIMIT_MS } from './local-authority'
import type { MatrixPreparedConversation } from './prepared-conversation'
import {
  MATRIX_RESUME_NOTE_MAX,
  matrixResumePrompt,
  MatrixTurnEffects,
  matrixTurnEvidenceWith,
  type MatrixTurnKnownEffect,
  matrixTurnSettlement
} from './turn-effects'
import { matrixFailureRpc, matrixTurnFailure, matrixTurnStopped } from './turn-failure'

/**
 * The local path (plan  §4.1–4.4).
 *
 * A message typed in this app on the Mac that runs this assistant goes straight to the
 * local Hermes. One durable record per message is written before anything runs; the
 * question and the answer are posted to the room for every other device, idempotently
 * and in order. This engine is the only retry owner for both.
 *
 * Exactly once: `submitted` is recorded durably immediately before Hermes receives the
 * prompt. A turn that failed before that goes back to waiting (nothing ran); after it, the
 * turn is interrupted and is never re-run automatically. A retired turn (Try again made a
 * new one) is terminal: nothing runs, sends or posts for it, ever.
 */
export interface MatrixLocalTurn {
  v: 1
  owner: string
  turnId: string
  roomId: string
  /** The single body main received: used for the run and for the send. */
  text: string
  /** The message this question replies to: its event (the question's `m.in_reply_to`) and
   * its words, which the run receives as context before the text (`matrixTurnPrompt`). */
  reply?: MatrixTurnReply
  /** What only the assistant sees with this turn, after its text: first-learning direction
   * (first-run.ts). Never posted to the room or shown in the window; kept with the
   * record so a retry or a restart runs with the same context. */
  context?: string
  /** Native-owned turn posture. First learning keeps the normal funded run and narrows only writes. */
  profile?: 'first_learning'
  /** The conversation's model when the person sent it; the run uses it even if they
   * switch while it waits. Absent in records from before the lineup. */
  model?: MatrixModelId
  /** The conversation's thinking level when the person sent it, if they chose one. */
  effort?: MatrixEffort
  createdAt: number
  state: MatrixLocalTurnState
  submitted: boolean
  questionTxnId: string
  questionEventId?: string
  questionAttempts: number
  answerText?: string
  /** Cosmetic reply data retained before any publication attempt or restart. */
  answerPet?: MatrixPetIntentEnvelope
  storedSession?: string
  answerTxnId: string
  /** The answer's event, once all of it is in the room: its only message, or the last part of
   * an answer too long for one (`answerParts`). Set only then: the turn is answered as a whole. */
  answerEventId?: string
  /** An answer posted as several messages (matrix-answer-parts.ts): the events of its parts
   * already in the room, in order. The next part is the one at this length. */
  answerParts?: string[]
  /** Attempts at the answer's next message (for a split answer, at its next part). */
  answerAttempts: number
  authority?: 'lease' | 'platform'
  /** `home`: another Mac answers this agent here as it answers the phone (a guest copy on this
   * Mac, ): the question goes to the room with the
   * handoff marker and nothing runs here unless the person asks (`answerHere`). Fixed before
   * the question is first sent, so a re-send and its read-back use the same marker.
   * `cloud`: the agent answers in the cloud (S1, atum.cloud-answering/1): the question goes to the
   * room the same way, signed with this Mac's origin, and it never runs here, not even on request. */
  route?: 'home' | 'cloud'
  /** When the question reached the room for the other Mac; `quiet` once it has had the
   * bounded time to answer without an answer seen here. */
  handoff?: { at: number; quiet?: boolean }
  /** The person asked this Mac to answer a handed-off question (once, fenced on the platform). */
  answerHere?: boolean
  platformInvocationId?: string
  platformTransactionId?: string
  platformPublished?: boolean
  /** Times this turn has been queued again after a run that ended without an answer (turn-effects.ts):
   * silently when nothing that matters ran, with the facts when something may have. */
  reruns?: number
  /** What the earlier run is known to have done, for the next run's prompt when it may have changed something. */
  resume?: { effect: MatrixTurnKnownEffect; tools: string[] }
  /** The turn ended without an answer and cannot be run again: what the assistant says in the room,
   * once (a status notice posted in place of the answer; its event is `answerEventId`). */
  notice?: 'couldnt_confirm' | 'failed'
  waitingSince: number
  /** While it waits, the last time it was seen in line behind the agent's other work (`busy`),
   * saved at most every MATRIX_LOCAL_TURN.inLineSaveMs: after a restart its wait counts from here,
   * not from when it began waiting, so a turn queued behind a long answer keeps its place. */
  inLineAt?: number
  /** Observability without content (§4.8). */
  times: {
    accepted: number
    running?: number
    firstToken?: number
    answered?: number
    questionSynced?: number
    answerSynced?: number
    /** When the wait ran out and it became `not_sent`. */
    notSent?: number
  }
}

export interface MatrixLocalTurnScope {
  human: MatrixIdentity
  agentUserId: string
  agentPrincipal: string
}

export type MatrixLocalAuthority =
  | { kind: 'lease'; signal: AbortSignal }
  | { kind: 'platform' }
  /** Another Mac is answering this agent now and this Mac holds a guest copy: hand off. */
  | { kind: 'home' }
  /** The agent answers in the cloud: every question goes to the room for it; none runs here. */
  | { kind: 'cloud' }
  | { kind: 'unavailable' }

/** What main made ready before a platform dispatch (`prepare`): the conversation and what it is for. */
export interface MatrixLocalTurnPrepared {
  conversation: MatrixPreparedConversation
  conversationKey: string
  petSurface: boolean
}

export interface MatrixLocalTurnExecution {
  invocationId: string
  /** What `prepare` made ready before the platform's dispatch, for this run only. */
  prepared?: MatrixLocalTurnPrepared
  signal: AbortSignal
  deadlineAt: number
  timeoutMs: number
  /** The run's own cap as quiet time (reliability plan §6.1 A): no session event for this
   * long ends it, while an active run may go on. The lease, Stop, and the command's own
   * signal still end it sooner. */
  inactivityMs?: number
  /** Synchronous and durable, immediately before prompt.submit. */
  onSubmit(): void
  /** Follows what the run did, for the failure path (turn-effects.ts). */
  effects: MatrixTurnEffects
  onActivity(activity: MatrixHermesActivitySnapshot): void
  /** Hermes's redacted remarks, todo list and started tools while the run works, for the owner's
   * interim messages and one working line (agent-turns/1.4). Present only when `deps.progress` made
   * a voice for this run. */
  onProgress?(event: MatrixHermesProgressEvent): void
  /** The owner hears this run narrated, so the agent is asked to speak up (the shared turn style).
   * Present with `onProgress`, except for a turn with scripted words of its own (hidden `context`). */
  turnStyle?: true
  /** The agent's typing while this run works on the lease (paused while it waits on its owner). */
  work?: MatrixAgentWork
}

export interface MatrixLocalTurnDeps {
  /** The agent's own vault: the root for the default agent, its scope for any other
   * ( §2.4), so each agent's index and turns
   * stay apart. */
  store: EncryptedStore
  scope(): MatrixLocalTurnScope | null
  /** Readiness is `ready` (§4.5): only then does a waiting turn start. */
  runnable(): boolean
  /**
   * The agent's Hermes is at work now (its turn lock is held: this engine's run, a phone message's
   * turn, a model change): a turn waiting behind it is in line, not stuck, and its retries do not
   * slow down (MATRIX_LOCAL_TURN.slowRetryAfterMs). Absent, only this engine's own running turn counts.
   */
  busy?(): boolean
  authority(): MatrixLocalAuthority
  /** The Hermes turn lock shared with the server path (turn-lock.ts). */
  lock(roomId: string, signal: AbortSignal): Promise<() => void>
  /** The conversation's current model, recorded on a new turn (accept and Try again). */
  model?(roomId: string): MatrixModelId
  /** The conversation's thinking level, if chosen, recorded beside the model. */
  effort?(roomId: string): MatrixEffort | undefined
  execute(
    turn: Readonly<MatrixLocalTurn>,
    input: MatrixLocalTurnExecution
  ): Promise<{ text: string; storedSession: string; pet?: MatrixPetIntentEnvelope }>
  /**
   * What can refuse a turn without Hermes (the room's re-read, the conversation's history;
   * MatrixHermesExecutor.prepare), made ready before the platform dispatches it: a refusal leaves
   * the turn waiting, since nothing was dispatched, instead of interrupting a turn that never
   * ran. What it returns goes to the one `execute` that follows.
   */
  prepare?(
    turn: Readonly<MatrixLocalTurn>,
    input: { invocationId: string; signal: AbortSignal }
  ): Promise<MatrixLocalTurnPrepared | undefined>
  /** Per-message platform grant for a question this device sent (authority `platform`). */
  platform(
    operation: 'claim' | 'dispatch' | 'complete' | 'published' | 'requeue',
    turn: Readonly<MatrixLocalTurn>,
    extra: { invocationId?: string; publishedEvent?: string; effect?: MatrixTurnKnownEffect; tools?: string[] }
  ): Promise<MatrixGrant>
  sendQuestion(turn: Readonly<MatrixLocalTurn>): Promise<string>
  findQuestion(turn: Readonly<MatrixLocalTurn>): Promise<MatrixTurnLookup>
  /** Posts the answer, or one part of an answer too long for one message (`part`: its words,
   * its position and its fixed Matrix transaction), each under its own transaction. */
  publishAnswer(
    turn: Readonly<MatrixLocalTurn>,
    input: {
      /** Absent only for first learning, whose assistant result is an unprompted run message. */
      questionEventId?: string
      invocationId: string
      transactionId: string
      part?: MatrixAnswerPart & { body: string; matrixTransactionId: string }
      /** A status notice in place of an answer (`notice`): main writes it in the owner's language. */
      status?: 'couldnt_confirm' | 'failed'
    }
  ): Promise<string>
  /**
   * The answer of this platform invocation went through the platform's outbox (atum.agent-home/2.1): the platform's
   * worker records the event on the ledger itself, so the legacy "published" acknowledgement is not sent for it.
   */
  ledgerPublishes?(invocationId: string): boolean
  /** Read-back of the answer, or of one part of a split answer (`part`: its index). */
  findAnswer(turn: Readonly<MatrixLocalTurn>, part?: number): Promise<MatrixTurnLookup>
  /** Says, once, in the room that an interrupted turn goes back for a check (`matrixCheckingLine`). Best effort. */
  checking?(turn: Readonly<MatrixLocalTurn>): Promise<void>
  /** What an interrupted turn most likely hit (offline, AI down, out of Protons). */
  diagnose?(): Promise<MatrixLocalTurnNotice | undefined>
  /**
   * The agent's presentation signals in its chat (agent-turns v1.1, agent-signals.ts). `seen`:
   * its read receipt on the turn's question, once the question is in the room and Hermes has
   * it (this Mac took it up; `lease`, checked then), and again once its answer is posted
   * (`claimed` when this Mac ran it under its lease: the lease is released as soon as the run
   * ends, before the answer is posted). `work`: its typing, only while a turn runs under this
   * Mac's answering lease; the engine stops it when the run ends.
   */
  seen?(turn: Readonly<MatrixLocalTurn>, proof: MatrixSeenProof): void
  work?(turn: Readonly<MatrixLocalTurn>): MatrixAgentWork | undefined
  /**
   * What the owner sees while this run works (agent-turns/1.4 "acknowledge, keep working"): Hermes's
   * interim remarks as real messages and one transient working line, both in the agent's private
   * chat. The engine feeds it, holds its first publication until the question's event id exists
   * (`questionEventId` waits for the question to be synced), and ends it before the answer is posted.
   */
  progress?(
    turn: Readonly<MatrixLocalTurn>,
    input: { invocationId: string; signal: AbortSignal; questionEventId(): Promise<string> }
  ): MatrixLocalTurnVoice | undefined
  changed(): void
  log(line: string): void
  now?(): number
}

/** The owner-facing presence of one Mac-typed run: remarks and the working line, then gone. */
export interface MatrixLocalTurnVoice {
  event(event: MatrixHermesProgressEvent): void
  /** Await before the answer is posted: removes the working line; `answer` drops a repeating remark. */
  end(answer?: string): Promise<void>
}

/** The wait after which a turn used to become `not_sent` (removed, LB9): dates the failure of a
 * record kept from before `times.notSent`. */
const LEGACY_WAIT_LIMIT_MS = 15 * 60_000

/** Named bounds (§4.2, §4.6). */
export const MATRIX_LOCAL_TURN = {
  /**
   * A waiting turn never runs out (LB9, plan 6.1 A): one whose agent's runtime is not ready (offline,
   * restarting, no answering authority) stays queued and shown waiting until it starts, across a
   * restart too; it was `not_sent` after 15 minutes. A turn waiting its turn behind another one
   * (the agent is answering something, its Hermes is busy) likewise waits in order, however long the
   * turn ahead takes (`inLineAt`); that turn is bounded by its own limit, the lease and Stop. What
   * the 15 minutes still sets is the pace: a turn whose own attempts keep failing before submission
   * (a Hermes that never comes up) retries every `restartBackoffMs` for this long, then every
   * `slowRetryMs`, so a queue that cannot start is not a loop. There is deliberately no depth or
   * age cap on that line (LB9, plan 6.1 A; Atum is never less capable than plain Hermes): a
   * waiting turn is not dropped for how many wait or how long it waits.
   */
  /** How long the progress line waits for its question to be synced before giving up for this run. */
  progressQuestionWaitMs: 60_000,
  slowRetryAfterMs: 15 * 60_000,
  slowRetryMs: 60_000,
  /** How often a turn waiting behind the agent's other work saves that it still is (`inLineAt`):
   * a restart costs it at most this much of its next wait. */
  inLineSaveMs: 60_000,
  /** The local run's own cap, as quiet time (LOCAL_TURN_LIMIT_MS): 30 minutes without a
   * session event ends it, while an active run may go on. The lease, Stop and a platform
   * grant's own signal end it sooner; it is also the first horizon for prompts. */
  runLimitMs: LOCAL_TURN_LIMIT_MS,
  /** No token or tool event for this long: "Still waiting for Atum's AI…". */
  watchdogMs: 20_000,
  /** A question or answer not in the room this long gets the "not synced yet" mark. */
  notSyncedMs: 30_000,
  /** A handed-off question without an answer seen here this long offers to answer here. */
  handoffQuietMs: 60_000,
  /** A cloud question without an answer seen here this long stops showing the agent typing and
   * says "No reply yet." (no offer: this Mac never runs a cloud agent's question). Generous: a
   * long cloud task still answers in time; a cloud that never does no longer looks busy for a day. */
  cloudQuietMs: 10 * 60_000,
  /** Sync retries back off; a failed pre-submission start waits before retrying. */
  syncBackoffMs: [2_000, 5_000, 10_000, 30_000, 60_000],
  restartBackoffMs: 5_000,
  /** Terminal turns leave the view and the vault after a day. */
  retainMs: 24 * 60 * 60_000,
  pumpMs: 1_000
} as const

export const MATRIX_LOCAL_TURNS_INDEX = 'matrix-local-turns'

/**
 * The room's full server read refused the turn for good: the room is an earlier conversation of
 * this agent (one conversation per agent). The person's message is kept the moment it is sent
 * (it shows at once) and checked after; a refusal makes it not sent right away, never two
 * minutes of typing first. Nothing ran and nothing reached the room.
 */
function refusedRoom(error: unknown): boolean {
  return error instanceof Error && error.message === 'matrix_earlier_conversation'
}

const recordKey = (turnId: string) => `matrix-local-turn-${turnId}`
const TERMINAL: ReadonlySet<MatrixLocalTurnState> = new Set(['done', 'interrupted', 'not_sent', 'retried'])

/** The longest prompt a turn may hand Hermes (its run refuses longer ones). */
const PROMPT_MAX = MATRIX_PROMPT_MAX
/** The longest hidden context a turn may carry (the first run's folder review). */
export const MATRIX_TURN_CONTEXT_MAX = 14000

/** Every character a reader may take for a new line, not only `\n`: a quoted line split by
 * any other would leave the rest of it outside the quote marks. */
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/

/**
 * What the assistant receives for a turn: its text, after the message it replies to as a
 * quote (the reply contract: context only, append-only). The quote gives way to the text:
 * it is cut, never the person's words. A record whose reply is malformed runs as plain text.
 * A turn with hidden context (the first run's folder review) has it after its text instead.
 */
export function matrixTurnPrompt(turn: Pick<MatrixLocalTurn, 'text' | 'reply' | 'context' | 'resume'>): string {
  // A run that follows one which may have changed something gets the facts with its one prompt,
  // after the person's words, so it checks before it redoes anything (turn-effects.ts). The quote
  // and the hidden context give way to the note before it does, as they do to the text.
  if (turn.resume?.effect === 'side_effect_possible') {
    const prompt = matrixTurnBasePrompt(turn, PROMPT_MAX - MATRIX_RESUME_NOTE_MAX - 2)

    return matrixResumePrompt(prompt, turn.resume, PROMPT_MAX)
  }

  return matrixTurnBasePrompt(turn, PROMPT_MAX)
}

function matrixTurnBasePrompt(turn: Pick<MatrixLocalTurn, 'text' | 'reply' | 'context'>, max: number): string {
  const context = typeof turn.context === 'string' ? turn.context.trim() : ''

  // A turn's hidden context follows its words, cut to what fits beside them.
  if (context) {
    const room = max - turn.text.length - 2

    return room > 0 ? `${turn.text}\n\n${context.slice(0, room)}` : turn.text
  }

  const quote = typeof turn.reply?.quote === 'string' ? turn.reply.quote.trim() : ''

  if (!quote) {
    return turn.text
  }

  // Whole quoted lines, from the top, while they fit beside the text. Each line, however it
  // was broken, starts with the quote mark: quoted words never pass for the person's.
  const budget = max - turn.text.length - 2
  let quoted = ''

  for (const line of [...quote].slice(0, MATRIX_TURN_QUOTE_MAX).join('').split(LINE_BREAK)) {
    const next = quoted ? `${quoted}\n> ${line}` : `> ${line}`

    if (next.length > budget) {
      break
    }

    quoted = next
  }

  return quoted ? `${quoted}\n\n${turn.text}` : turn.text
}

/**
 * The SDK command that posts a local turn's question: the turn marker and, for a reply, its
 * standard relation; a question handed to the Mac that answers this agent carries the handoff
 * marker instead, and no relation (that Mac admits only plain new messages,
 * matrix-turn-intake.ts). A cloud agent's question carries the handoff marker and keeps its
 * reply: the cloud brain passes the quoted words as context (S1, the reply contract §2.1). The
 * same command on every attempt, under the turn's transaction.
 */
export function matrixTurnQuestion(turn: Readonly<MatrixLocalTurn>): Extract<MatrixSdkCommand, { kind: 'sendTurn' }> {
  return {
    kind: 'sendTurn',
    roomId: turn.roomId,
    body: turn.text,
    turnId: turn.turnId,
    transactionId: turn.questionTxnId,
    ...(turn.route === 'home' ? { handoff: true as const } : {}),
    ...(turn.route === 'cloud' ? { handoff: true as const, cloud: true as const } : {}),
    ...(turn.reply && turn.route !== 'home' ? { replyTo: turn.reply.eventId } : {})
  }
}

export function matrixLocalTurnOwner(scope: MatrixLocalTurnScope): string {
  return createHash('sha256')
    .update(JSON.stringify([scope.human.userId, scope.human.deviceId, scope.agentPrincipal]))
    .digest('hex')
}

export class MatrixLocalTurns {
  private readonly turns = new Map<string, MatrixLocalTurn>()
  private order: string[] = []
  private loaded = false
  private readonly running = new Map<string, AbortController>()
  private readonly syncing = new Set<string>()
  private readonly syncNotBefore = new Map<string, number>()
  private readonly syncAttempts = new Map<string, number>()
  private readonly startNotBefore = new Map<string, number>()
  private readonly notices = new Map<string, MatrixLocalTurnNotice>()
  private readonly checkingDue = new Set<string>()
  private readonly activity = new Map<string, { at: number; tool: boolean }>()
  /** Per waiting turn, the last time it was seen behind the agent's other work (`busy`): its wait
   * for a runtime that is not ready counts from then, or from when it began waiting if later. The
   * record keeps a copy saved now and then (`inLineAt`) for after a restart. */
  private readonly lastBusy = new Map<string, number>()
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false

  private readonly index = MATRIX_LOCAL_TURNS_INDEX

  constructor(private readonly deps: MatrixLocalTurnDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Main accepts a send: the record is written before anything runs. `reply`: the message
   * it answers, kept with the record so a retry or a restart runs with the same context.
   * `context`: what only the assistant sees with it (main's own, never the window's). */
  accept(
    roomId: string,
    text: string,
    reply?: MatrixTurnReply,
    context?: string,
    profile?: MatrixLocalTurn['profile']
  ): string {
    this.load()
    const turn = this.create(roomId, text, reply, context, profile)

    // The record and the index in one write: a crash leaves either both or neither.
    this.deps.store.setItems({
      [recordKey(turn.turnId)]: JSON.stringify(turn),
      [this.index]: JSON.stringify([...this.order, turn.turnId])
    })
    this.turns.set(turn.turnId, turn)
    this.order.push(turn.turnId)
    this.deps.log(`[Matrix] turn ${turn.turnId.slice(0, 8)} accepted`)
    this.deps.changed()
    this.kick()

    return turn.turnId
  }

  private create(
    roomId: string,
    text: string,
    reply?: MatrixTurnReply,
    context?: string,
    profile?: MatrixLocalTurn['profile']
  ): MatrixLocalTurn {
    const scope = this.deps.scope()

    if (!scope || typeof text !== 'string' || !text.trim() || !/^!.+/.test(roomId)) {
      throw new Error('matrix_not_ready')
    }

    // The question is posted to the room as one encrypted event (MATRIX_MESSAGE_MAX_BYTES).
    if (matrixMessageTooLong(text)) {
      throw new Error('matrix_message_too_long')
    }

    if (
      context !== undefined &&
      (typeof context !== 'string' || !context.trim() || context.length > MATRIX_TURN_CONTEXT_MAX || reply !== undefined)
    ) {
      throw new Error('matrix_command_invalid')
    }

    if (
      reply !== undefined &&
      (typeof reply?.eventId !== 'string' ||
        !reply.eventId.startsWith('$') ||
        reply.eventId.length > 1024 ||
        typeof reply.quote !== 'string' ||
        !reply.quote.trim() ||
        reply.quote.length > MATRIX_TURN_QUOTE_MAX)
    ) {
      throw new Error('matrix_command_invalid')
    }

    const now = this.now()
    const turnId = randomUUID()

    return {
      v: 1,
      owner: matrixLocalTurnOwner(scope),
      turnId,
      roomId,
      text,
      ...(reply ? { reply: { eventId: reply.eventId, quote: reply.quote } } : {}),
      ...(context ? { context } : {}),
      ...(profile ? { profile } : {}),
      model: this.deps.model?.(roomId),
      ...(this.deps.effort?.(roomId) ? { effort: this.deps.effort(roomId) } : {}),
      createdAt: now,
      state: 'waiting',
      submitted: false,
      questionTxnId: matrixQuestionTransaction(turnId),
      questionAttempts: 0,
      answerTxnId: matrixAnswerTransaction(turnId),
      answerAttempts: 0,
      waitingSince: now,
      times: { accepted: now }
    }
  }

  /** Try again: a new turn with the same text; the old one is retired, terminally. */
  retry(turnId: string): string {
    this.load()
    const old = this.turns.get(turnId)
    const scope = this.deps.scope()

    if (
      !old ||
      !scope ||
      old.owner !== matrixLocalTurnOwner(scope) ||
      (old.state !== 'interrupted' && old.state !== 'not_sent')
    ) {
      throw new Error('matrix_turn_unavailable')
    }

    // Retiring the old turn and creating its successor is one write: never one without the other.
    const retired = { ...old, state: 'retried' as const }
    const turn = this.create(old.roomId, old.text, old.reply, old.context, old.profile)

    this.deps.store.setItems({
      [recordKey(turnId)]: JSON.stringify(retired),
      [recordKey(turn.turnId)]: JSON.stringify(turn),
      [this.index]: JSON.stringify([...this.order, turn.turnId])
    })
    this.turns.set(turnId, retired)
    this.turns.set(turn.turnId, turn)
    this.order.push(turn.turnId)
    this.notices.delete(turnId)
    this.deps.log(`[Matrix] turn ${turnId.slice(0, 8)} retried as ${turn.turnId.slice(0, 8)}`)
    this.deps.changed()
    this.kick()

    return turn.turnId
  }

  /**
   * Answer on this Mac: a handed-off question the other Mac has not answered (yet). It runs
   * here once, through the platform's per-message grant for the question already in the
   * room, so it never runs on both Macs: if the other Mac took it meanwhile, the grant is
   * refused and the turn goes back to waiting for that answer.
   */
  answerHere(turnId: string): string {
    this.load()
    const turn = this.turns.get(turnId)
    const scope = this.deps.scope()

    // A cloud agent's question is answered in the cloud only: this Mac's copy is fenced (0179).
    if (
      !turn ||
      !scope ||
      turn.owner !== matrixLocalTurnOwner(scope) ||
      turn.state !== 'handed_off' ||
      turn.route === 'cloud'
    ) {
      throw new Error('matrix_turn_unavailable')
    }

    this.update(turn, { state: 'waiting', answerHere: true, waitingSince: this.now() })
    this.notices.delete(turnId)
    this.startNotBefore.delete(turnId)
    this.deps.log(`[Matrix] turn ${turnId.slice(0, 8)} answered here at the person's request`)
    this.deps.changed()
    this.kick()

    return turnId
  }

  /** Restart recovery (§4.2 table). Safe to call again: running turns are left alone. */
  recover(): void {
    this.loaded = false
    this.load()
    const now = this.now()
    const scope = this.deps.scope()
    // Only this engine's own turns change state, as in `view` and `pump`.
    const owner = scope ? matrixLocalTurnOwner(scope) : undefined
    let purged = false

    for (const turnId of [...this.order]) {
      const turn = this.turns.get(turnId)!

      if (TERMINAL.has(turn.state) && turn.state !== 'done' && now - turn.createdAt > MATRIX_LOCAL_TURN.retainMs) {
        this.forget(turnId)
        purged = true

        continue
      }

      if (
        ((turn.state === 'done' && turn.answerEventId) || turn.state === 'handed_off') &&
        now - turn.createdAt > MATRIX_LOCAL_TURN.retainMs
      ) {
        this.forget(turnId)
        purged = true

        continue
      }

      if (this.running.has(turnId) || turn.state !== 'running' || turn.owner !== owner) {
        continue
      }

      if (turn.submitted) {
        // After a restart nothing shows how far Hermes got: not run again, and said once in the room.
        this.update(turn, { state: 'interrupted', notice: 'couldnt_confirm' })
        this.deps.log(`[Matrix] turn ${turnId.slice(0, 8)} interrupted by restart after submission`)
      } else {
        // Nothing reached Hermes: safe to wait again, with a fresh window to start.
        this.update(turn, { state: 'waiting', waitingSince: now })
      }
    }

    if (purged) {
      this.writeIndex()
    }

    this.deps.changed()
    this.kick()
  }

  /** Only current-owner work that can still execute needs answering ownership. */
  get executionPending(): boolean {
    const scope = this.deps.scope()

    if (this.stopped || !scope) {
      return false
    }

    this.load()
    const owner = matrixLocalTurnOwner(scope)

    return [...this.turns.values()].some(
      turn => turn.owner === owner && (turn.state === 'waiting' || turn.state === 'running')
    )
  }

  /** Readiness, the lease or the lock changed: look again now. */
  kick(): void {
    if (this.stopped) {
      return
    }

    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.pump(), 0)
    this.timer.unref?.()
  }

  /** Sign-out: stop everything this engine runs; the vault is cleared by the caller. */
  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)

    for (const abort of this.running.values()) {
      abort.abort()
    }

    this.turns.clear()
    this.order = []
    this.loaded = false
    this.notices.clear()
    this.lastBusy.clear()
  }

  /** Signed in again (a new scope): resume after `stop`. */
  resume(): void {
    this.stopped = false
    this.recover()
  }

  /** The renderer's projection for one room, merged with its timeline (§5 merge rule). */
  view(roomId: string, messages: readonly MatrixMessage[]): MatrixLocalTurnView[] {
    const scope = this.deps.scope()

    if (!scope) {
      return []
    }

    this.load()
    const owner = matrixLocalTurnOwner(scope)
    const now = this.now()
    const present = new Map<string, { question: boolean; answer: boolean }>()

    for (const message of messages) {
      if (message.turn && !message.pending && !message.failed) {
        const entry = present.get(message.turn) ?? { question: false, answer: false }

        if (message.sender === scope.human.userId) {
          entry.question = true
        } else if (message.sender === scope.agentUserId) {
          entry.answer = true
        }

        present.set(message.turn, entry)
      }
    }

    // The other Mac's answer to a handed-off question: a reply to that question event.
    const repliedTo = new Set(
      messages
        .filter(message => message.sender === scope.agentUserId && !message.pending && !message.failed)
        .map(message => message.resultFor)
        .filter((value): value is string => typeof value === 'string')
    )

    return this.order
      .map(turnId => this.turns.get(turnId)!)
      // First learning is a native context turn. Its assistant messages are in the timeline, but
      // the internal initiating record must never project as words authored by the owner.
      .filter(turn => turn.profile !== 'first_learning')
      .filter(turn => turn.owner === owner && turn.roomId === roomId && turn.state !== 'retried')
      .filter(turn => {
        const seen = present.get(turn.turnId)

        if (turn.state === 'done' && seen?.question && seen.answer) {
          return false
        }

        // Answered from the other Mac: the room's question and answer show on their own.
        if (turn.state === 'handed_off' && turn.questionEventId && repliedTo.has(turn.questionEventId)) {
          return false
        }

        return !(
          (TERMINAL.has(turn.state) || turn.state === 'handed_off') &&
          now - turn.createdAt > MATRIX_LOCAL_TURN.retainMs
        )
      })
      .map(turn => ({
        turnId: turn.turnId,
        roomId: turn.roomId,
        text: turn.text,
        createdAt: turn.createdAt,
        state: turn.state,
        ...(turn.reply ? { replyTo: turn.reply.eventId } : {}),
        ...(turn.route === 'cloud' ? { route: 'cloud' as const } : {}),
        // A record from before `times.notSent` failed when its wait ran out (LEGACY_WAIT_LIMIT_MS).
        ...(turn.state === 'not_sent'
          ? { failedAt: turn.times.notSent ?? turn.waitingSince + LEGACY_WAIT_LIMIT_MS }
          : {}),
        synced: { question: Boolean(turn.questionEventId), answer: Boolean(turn.answerEventId) },
        ...(turn.answerText && (turn.state === 'answered' || turn.state === 'done') ? { answer: turn.answerText } : {}),
        ...(turn.state === 'handed_off' && turn.handoff?.quiet && !this.notices.has(turn.turnId)
          ? { notice: 'home_quiet' as const }
          : this.notices.has(turn.turnId)
            ? { notice: this.notices.get(turn.turnId) }
            : {})
      }))
  }

  /** The turn record, for tests and diagnostics. */
  get(turnId: string): Readonly<MatrixLocalTurn> | undefined {
    this.load()

    return this.turns.get(turnId)
  }

  private load(): void {
    if (this.loaded) {
      return
    }

    this.turns.clear()
    const raw = this.deps.store.getItem(this.index)

    if (this.deps.store.failureCode()) {
      throw new Error('matrix_vault_unavailable')
    }

    const ids = raw ? (JSON.parse(raw) as unknown) : []
    this.order = []

    for (const turnId of Array.isArray(ids) ? ids : []) {
      if (typeof turnId !== 'string') {
        continue
      }

      const value = this.deps.store.getItem(recordKey(turnId))

      try {
        const turn = value ? (JSON.parse(value) as MatrixLocalTurn) : undefined

        if (turn?.v === 1 && turn.turnId === turnId) {
          this.turns.set(turnId, turn)
          this.order.push(turnId)
        }
      } catch {
        // An unreadable record is dropped from the index, never guessed at.
      }
    }

    this.loaded = true
  }

  private write(turn: MatrixLocalTurn): void {
    this.deps.store.setItem(recordKey(turn.turnId), JSON.stringify(turn))
    this.turns.set(turn.turnId, turn)
  }

  private writeIndex(): void {
    this.deps.store.setItem(this.index, JSON.stringify(this.order))
  }

  private forget(turnId: string): void {
    this.deps.store.removeItem(recordKey(turnId))
    this.lastBusy.delete(turnId)
    this.turns.delete(turnId)
    this.order = this.order.filter(id => id !== turnId)
  }

  /** Durable first, then memory: a failed vault write never leaves a phantom state. */
  private update(
    turn: MatrixLocalTurn,
    patch: Partial<Omit<MatrixLocalTurn, 'times'>> & { times?: Partial<MatrixLocalTurn['times']> }
  ): MatrixLocalTurn {
    const next = { ...turn, ...patch, times: { ...turn.times, ...(patch.times ?? {}) } }
    this.write(next)

    return next
  }

  private current(turnId: string): MatrixLocalTurn | undefined {
    return this.turns.get(turnId)
  }

  private pump(): void {
    if (this.stopped) {
      return
    }

    let pending = false

    try {
      const scope = this.deps.scope()

      if (!scope) {
        return
      }

      this.load()
      const owner = matrixLocalTurnOwner(scope)
      const now = this.now()
      let started = this.running.size > 0
      const authority = this.deps.authority().kind

      // The agent is answering something (here or for a phone message) or its Hermes is otherwise
      // at work: every turn waiting behind it is in line, and its wait starts afresh.
      const busy =
        [...this.running.keys()].some(turnId => this.turns.get(turnId)?.state === 'running') ||
        this.deps.busy?.() === true

      for (const turnId of this.order) {
        let turn = this.turns.get(turnId)!

        if (turn.owner !== owner) {
          continue
        }

        // Only work ahead of a waiting turn keeps it in line, never its own run: a turn is
        // `running` for as long as its run holds the lock, so one whose own attempts keep
        // failing before submission still slows down (restartBackoff).
        if (busy && turn.state === 'waiting') {
          this.lastBusy.set(turnId, now)

          if (now - (turn.inLineAt ?? 0) >= MATRIX_LOCAL_TURN.inLineSaveMs) {
            turn = this.update(turn, { inLineAt: now })
          }
        }

        if (turn.state === 'waiting') {
          pending = true
          // A hidden first-learning turn is local by construction. If this Mac temporarily loses
          // its held lease, wait for it; never turn the internal trigger into a handoff question.
          if (turn.profile === 'first_learning' && authority !== 'lease') {
            continue
          }
          // Another Mac answers this agent now and this one holds a guest copy: the question
          // goes to the room for that Mac, decided once, before it is first sent. A question
          // already sent as a local turn stays one (the other Mac never answers those).
          let routed = turn

          if (
            (authority === 'home' || authority === 'cloud') &&
            !turn.answerHere &&
            !turn.route &&
            !turn.questionEventId &&
            turn.questionAttempts === 0
          ) {
            routed = this.update(turn, { route: authority })
            this.deps.log(
              `[Matrix] turn ${turnId.slice(0, 8)} goes to ${authority === 'cloud' ? 'the cloud' : 'the Mac that answers this agent'}`
            )
          }

          if ((routed.route === 'home' || routed.route === 'cloud') && !routed.answerHere) {
            if (routed.questionEventId) {
              this.update(routed, { state: 'handed_off', handoff: { at: now } })
              this.notices.delete(turnId)
              this.deps.log(`[Matrix] turn ${turnId.slice(0, 8)} handed off`)
              this.deps.changed()
            } else {
              // Through the person's own chat connection: this Mac's copy need not be ready.
              this.markNotSynced(routed, now)

              if (!this.syncing.has(turnId) && now >= (this.syncNotBefore.get(turnId) ?? 0)) {
                void this.sync(turnId)
              }
            }

            // Never run here while the other Mac has it.
            continue
          }

          // Another Mac holds the lease: the platform grants this message, which needs its
          // event first. It is sent now, while the turn waits, outside the Hermes lock.
          const questionFirst = (authority === 'platform' || authority === 'home') && !turn.questionEventId

          if (questionFirst && this.deps.runnable()) {
            this.markNotSynced(turn, now)

            if (!this.syncing.has(turnId) && now >= (this.syncNotBefore.get(turnId) ?? 0)) {
              void this.sync(turnId)
            }
          }

          // One run at a time from this engine keeps each room in order; the lock does the rest.
          if (!questionFirst && !started && now >= (this.startNotBefore.get(turnId) ?? 0) && this.deps.runnable()) {
            started = true
            void this.run(turnId)
          }
        }

        if (turn.state === 'running') {
          pending = true
          this.watchdog(turn, now)
        }

        // Handed off: after the bounded time without an answer seen here, offer to answer here.
        // For the cloud (this Mac may never run it) only after a longer time, and only to stop
        // showing it typing: its line then says there is no reply yet.
        if (turn.state === 'handed_off' && turn.handoff && !turn.handoff.quiet) {
          pending = true

          const quietMs = turn.route === 'cloud' ? MATRIX_LOCAL_TURN.cloudQuietMs : MATRIX_LOCAL_TURN.handoffQuietMs

          if (now - turn.handoff.at >= quietMs) {
            this.update(turn, { handoff: { ...turn.handoff, quiet: true } })
            this.deps.changed()
          }
        }

        if (this.needsSync(turn)) {
          pending = true
          this.markNotSynced(turn, now)

          if (!this.syncing.has(turnId) && now >= (this.syncNotBefore.get(turnId) ?? 0)) {
            void this.sync(turnId)
          }
        }
      }
    } catch (error) {
      this.deps.log(`[Matrix] local turns pump failed: ${error instanceof Error ? error.message : 'unexpected'}`)
      pending = true
    } finally {
      if (pending && !this.stopped) {
        clearTimeout(this.timer)
        this.timer = setTimeout(() => this.pump(), MATRIX_LOCAL_TURN.pumpMs)
        this.timer.unref?.()
      }
    }
  }

  /** How long a turn that failed before submission waits before it is tried again: the back-off,
   * slowed once it has been trying for MATRIX_LOCAL_TURN.slowRetryAfterMs (it is kept, not dropped). */
  private restartBackoff(turn: MatrixLocalTurn): number {
    // Counted from when it began waiting or was last seen behind other work: time in line is not trying.
    const since = Math.max(turn.waitingSince, turn.inLineAt ?? 0, this.lastBusy.get(turn.turnId) ?? 0)

    return this.now() - since >= MATRIX_LOCAL_TURN.slowRetryAfterMs
      ? MATRIX_LOCAL_TURN.slowRetryMs
      : MATRIX_LOCAL_TURN.restartBackoffMs
  }

  private needsSync(turn: MatrixLocalTurn): boolean {
    if (turn.profile === 'first_learning') {
      return turn.state === 'answered' && !turn.answerEventId
    }

    if (
      turn.state === 'retried' ||
      turn.state === 'not_sent' ||
      turn.state === 'waiting' ||
      turn.state === 'handed_off'
    ) {
      return false
    }

    // The question is sent once the turn ran (in parallel on the lease); an interrupted
    // turn still gets its question into the room, so other devices see what was asked.
    if (!turn.questionEventId) {
      // A waiting turn's question is sent from the pump only when another Mac holds the lease.
      return turn.state !== 'running' || turn.authority === 'lease'
    }

    return (turn.state === 'answered' || (turn.state === 'interrupted' && Boolean(turn.notice))) && !turn.answerEventId
  }

  private markNotSynced(turn: MatrixLocalTurn, now: number): void {
    const since = !turn.questionEventId ? (turn.times.running ?? turn.createdAt) : (turn.times.answered ?? now)

    if (now - since > MATRIX_LOCAL_TURN.notSyncedMs && !this.notices.has(turn.turnId)) {
      this.notices.set(turn.turnId, 'not_synced')
      this.deps.changed()
    }
  }

  private watchdog(turn: MatrixLocalTurn, now: number): void {
    const seen = this.activity.get(turn.turnId)

    if (!seen || seen.tool || now - seen.at < MATRIX_LOCAL_TURN.watchdogMs) {
      return
    }

    if (this.notices.get(turn.turnId) !== 'still_waiting') {
      this.notices.set(turn.turnId, 'still_waiting')
      this.deps.changed()
    }
  }

  private async run(turnId: string): Promise<void> {
    const abort = new AbortController()
    this.running.set(turnId, abort)
    let release: (() => void) | undefined
    let work: MatrixAgentWork | undefined
    // Whether this attempt started the turn. One that could not start (no authority yet,
    // readiness changed) retries on the pump's cadence, never in a tight loop.
    let ran = false
    // What this run does, as far as this Mac sees it: the failure path settles from it.
    const effects = new MatrixTurnEffects()
    // When the run being made must end (set where it starts): a failure at or after it is the time
    // limit, whatever Hermes reported (turn-failure.ts: every failure of its turn is the same code).
    let deadlineAt: number | undefined

    try {
      const waited = this.now()
      release = await this.deps.lock(this.current(turnId)!.roomId, abort.signal)
      const lockMs = this.now() - waited

      if (lockMs > 50) {
        this.deps.log(`[Matrix] turn ${turnId.slice(0, 8)} waited ${lockMs}ms for the Hermes lock`)
      }

      let turn = this.current(turnId)

      // Retired, bounded out or recovered while waiting for the lock: never run.
      if (!turn || turn.state !== 'waiting' || this.stopped || !this.deps.runnable()) {
        return
      }

      const offered = this.deps.authority()

      // A question routed to the other Mac runs here only when the person asked (answerHere); a
      // cloud agent's never does.
      if ((turn.route === 'home' && !turn.answerHere) || turn.route === 'cloud' || offered.kind === 'cloud') {
        return
      }

      // Here, the other Mac answering only means its lease: this message needs a platform grant.
      const authority: Exclude<MatrixLocalAuthority, { kind: 'home' } | { kind: 'cloud' }> =
        offered.kind === 'home' ? { kind: 'platform' } : offered

      if (authority.kind === 'unavailable' || (authority.kind === 'platform' && !turn.questionEventId)) {
        return
      }

      ran = true
      turn = this.update(turn, {
        state: 'running',
        authority: authority.kind,
        submitted: false,
        times: { running: this.now() }
      })
      this.notices.delete(turnId)
      this.activity.set(turnId, { at: this.now(), tool: false })
      this.deps.changed()
      this.deps.log(`[Matrix] turn ${turnId.slice(0, 8)} running authority=${authority.kind}`)

      let result: { text: string; storedSession: string; pet?: MatrixPetIntentEnvelope }

      if (authority.kind === 'lease') {
        // The question is posted in parallel (pump → sync); the chat server is off the critical path.
        this.kick()
        // Only the Mac holding the answering lease says the agent is typing, and only while it runs.
        work = this.deps.work?.(turn)
        // Quiet time, not a wall clock (plan §6.1 A): the run ends after 30 minutes with no
        // session event; the lease's signal, Stop and the answer end it sooner.
        deadlineAt = this.now() + MATRIX_LOCAL_TURN.runLimitMs
        result = await this.execute(
          turn,
          turnId,
          AbortSignal.any([abort.signal, authority.signal]),
          deadlineAt,
          effects,
          work,
          undefined,
          MATRIX_LOCAL_TURN.runLimitMs
        )
      } else {
        // Another Mac holds the lease: the platform grants this message against its event,
        // sent while the turn waited (pump). Slower, still no dialog and no agent read.
        let grant = await this.deps.platform('claim', turn, {})
        turn = this.update(turn, { platformInvocationId: grant.invocationId })

        // Handed off and answered here on request: the other Mac took it meanwhile. Nothing
        // ran here; wait for that answer again.
        if (turn.route === 'home' && (grant.state !== 'claimed' || grant.expiresAt <= this.now())) {
          this.update(turn, { state: 'handed_off', answerHere: false, handoff: { at: this.now(), quiet: true } })
          this.notices.set(turnId, 'answered_elsewhere')
          this.deps.log(`[Matrix] turn ${turnId.slice(0, 8)} is already being answered by the other Mac`)

          return
        }

        if (grant.state !== 'claimed' || grant.expiresAt <= this.now()) {
          // Already dispatched elsewhere or expired: the platform fence says it may have run.
          turn = this.update(turn, { submitted: true })
          throw new Error('matrix_invocation_fenced')
        }

        // Everything that can refuse without Hermes comes before the dispatch: a refusal here
        // sends the turn back to waiting (nothing was dispatched), never to interrupted.
        const prepared = await this.deps.prepare?.(turn, { invocationId: grant.invocationId, signal: abort.signal })
        const latest = this.current(turnId)

        // Retired or bounded out while it was made ready: nothing is dispatched for it.
        if (latest?.state !== 'running') {
          return
        }

        turn = latest

        // From the platform's dispatch on, the message counts as run: never again.
        turn = this.update(turn, { submitted: true })
        grant = await this.deps.platform('dispatch', turn, { invocationId: grant.invocationId })

        if (grant.state !== 'dispatched') {
          throw new Error('matrix_invocation_fenced')
        }

        // The platform's own claim is the hard bound here (the message is dispatched against
        // it); quiet time still ends a silent run (plan §6.1 A).
        deadlineAt = grant.expiresAt
        result = await this.execute(
          turn,
          grant.invocationId,
          AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(0, grant.expiresAt - this.now()))]),
          deadlineAt,
          effects,
          undefined,
          prepared,
          MATRIX_LOCAL_TURN.runLimitMs
        )
      }

      turn = this.current(turnId)!

      if (turn.state !== 'running') {
        return
      }

      this.update(turn, {
        state: 'answered',
        answerText: result.text,
        answerPet: matrixPetIntentEnvelope(result.pet),
        storedSession: result.storedSession,
        times: { answered: this.now() }
      })
      this.notices.delete(turnId)
      this.deps.log(`[Matrix] turn ${turnId.slice(0, 8)} answered`)
    } catch (error) {
      const turn = this.current(turnId)

      // The room check before the run (the lock) refused it: nothing ran.
      if (turn?.state === 'waiting' && refusedRoom(error)) {
        this.refuse(turn)

        return
      }

      if (!turn || turn.state !== 'running') {
        return
      }

      const failure = matrixTurnFailure(error)

      if (!turn.submitted) {
        // Nothing reached Hermes: wait again. Its own run never kept it in line, so its wait
        // still counts from when it last waited behind other work, or began waiting.
        this.update(turn, { state: 'waiting' })
        this.startNotBefore.set(turnId, this.now() + this.restartBackoff(turn))
        this.deps.log(
          `[Matrix] turn ${turnId.slice(0, 8)} back to waiting before submission reason=${failure.code}${matrixFailureRpc(failure)}`
        )
      } else {
        // Submitted, so it may have run. What the run showed decides (turn-effects.ts): queued again
        // (silently when nothing that matters ran, with the facts when something may have), left
        // alone when the person stopped it, and otherwise not run again and said once in the room.
        const plan = matrixTurnSettlement({
          // What this run showed, with what the runs before it were known to have done.
          evidence: matrixTurnEvidenceWith(effects.evidence(), turn.resume),
          reruns: turn.reruns ?? 0,
          ...(turn.resume ? { prior: turn.resume } : {}),
          // The person's Stop, or the fence saying another run has this message: this run never
          // started it, so it neither runs it again nor says anything about it.
          stopped: matrixTurnStopped(error) || failure.code === 'matrix_invocation_fenced',
          // From the run's own deadline, not from its error: the chain does not carry the time limit.
          timedOut: !abort.signal.aborted && deadlineAt !== undefined && this.now() >= deadlineAt
        })

        if (plan.kind === 'requeue' && (await this.requeue(turn, plan.effect, plan.tools))) {
          this.deps.log(
            `[Matrix] turn ${turnId.slice(0, 8)} queued again effect=${plan.effect} after: ${failure.code}${matrixFailureRpc(failure)}`
          )

          return
        }

        // Signed out while the platform was being asked: nothing is written for it.
        if (this.current(turnId)?.state !== 'running') {
          return
        }

        const say =
          plan.kind === 'notice'
            ? plan.code
            : plan.kind === 'requeue'
              ? plan.effect === 'side_effect_possible'
                ? 'couldnt_confirm'
                : 'failed'
              : undefined

        this.update(this.current(turnId) ?? turn, { state: 'interrupted', ...(say ? { notice: say } : {}) })
        this.deps.log(
          `[Matrix] turn ${turnId.slice(0, 8)} interrupted after submission: ${failure.code}${matrixFailureRpc(failure)}`
        )

        const notice = await this.deps.diagnose?.().catch(() => undefined)

        if (notice) {
          this.notices.set(turnId, notice)
        } else {
          this.notices.delete(turnId)
        }
      }
    } finally {
      work?.stop()
      release?.()
      this.running.delete(turnId)
      this.activity.delete(turnId)

      if (ran) {
        this.deps.changed()
        this.kick()
      } else {
        this.startNotBefore.set(
          turnId,
          Math.max(this.startNotBefore.get(turnId) ?? 0, this.now() + MATRIX_LOCAL_TURN.pumpMs)
        )
      }
    }
  }

  /**
   * Queue a turn that was submitted and ended without an answer to run again: its authority is told
   * where it keeps a record (a platform grant is spent by the dispatch), and the turn goes back to
   * waiting as if it had never been submitted, with the facts if something may have run. False when
   * the platform could not be told: the turn is not run again then, and its owner hears so.
   */
  /** The one line that a turn is going back for a check, said once its question is in the room (best effort, not kept across a restart). */
  private sayChecking(turnId: string): void {
    const turn = this.current(turnId)

    if (turn?.questionEventId && this.checkingDue.delete(turnId)) {
      void this.deps.checking?.(turn).catch(() => undefined)
    }
  }

  private async requeue(turn: MatrixLocalTurn, effect: MatrixTurnKnownEffect, tools: string[]): Promise<boolean> {
    try {
      if (turn.authority === 'platform') {
        if (!turn.platformInvocationId) {
          return false
        }

        const queued = await this.deps.platform('requeue', turn, {
          invocationId: turn.platformInvocationId,
          effect,
          tools
        })

        if (queued.state !== 'claimed') {
          return false
        }
      }

      const now = this.now()
      const latest = this.current(turn.turnId)

      // Signed out (or otherwise moved on) while the platform was being asked: nothing is written.
      if (latest?.state !== 'running') {
        return false
      }

      this.update(latest, {
        state: 'waiting',
        submitted: false,
        reruns: (latest.reruns ?? 0) + 1,
        resume: { effect, tools },
        platformInvocationId: undefined,
        platformTransactionId: undefined,
        waitingSince: now
      })
      this.startNotBefore.set(turn.turnId, now + MATRIX_LOCAL_TURN.restartBackoffMs)
      this.notices.delete(turn.turnId)

      if (effect === 'side_effect_possible') {
        this.checkingDue.add(turn.turnId)
        this.sayChecking(turn.turnId)
      }

      return true
    } catch (error) {
      this.deps.log(
        `[Matrix] turn ${turn.turnId.slice(0, 8)} could not be queued again: ${error instanceof Error ? error.message : 'unexpected'}`
      )

      return false
    }
  }

  private async execute(
    turn: MatrixLocalTurn,
    invocationId: string,
    signal: AbortSignal,
    deadlineAt: number,
    effects: MatrixTurnEffects,
    work?: MatrixAgentWork,
    prepared?: MatrixLocalTurnPrepared,
    inactivityMs?: number
  ): Promise<{ text: string; storedSession: string; pet?: MatrixPetIntentEnvelope }> {
    const timeoutMs = Math.max(0, deadlineAt - this.now())
    const turnId = turn.turnId

    const voice = this.deps.progress?.(turn, {
      invocationId,
      signal,
      questionEventId: () => this.questionEvent(turnId, signal)
    })

    try {
      const result = await this.executeWith(
        turn,
        invocationId,
        signal,
        deadlineAt,
        timeoutMs,
        effects,
        work,
        prepared,
        voice,
        inactivityMs
      )

      // The working line is removed before the answer is posted (a new message, after execute returns).
      await voice?.end(result.text)

      return result
    } catch (error) {
      await voice?.end()
      throw error
    }
  }

  /** The question's event id, once it is in the room (this Mac sent it, or synced it back). */
  private async questionEvent(turnId: string, signal: AbortSignal): Promise<string> {
    const deadline = this.now() + MATRIX_LOCAL_TURN.progressQuestionWaitMs

    for (;;) {
      signal.throwIfAborted()
      const eventId = this.current(turnId)?.questionEventId

      if (eventId) {
        return eventId
      }

      if (this.now() >= deadline) {
        throw new Error('matrix_progress_question_unavailable')
      }

      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  private executeWith(
    turn: MatrixLocalTurn,
    invocationId: string,
    signal: AbortSignal,
    deadlineAt: number,
    timeoutMs: number,
    effects: MatrixTurnEffects,
    work?: MatrixAgentWork,
    prepared?: MatrixLocalTurnPrepared,
    voice?: MatrixLocalTurnVoice,
    inactivityMs?: number
  ): Promise<{ text: string; storedSession: string; pet?: MatrixPetIntentEnvelope }> {
    const turnId = turn.turnId

    // Every wall-clock bound is already in `signal` (a platform grant, the lease, Stop); the
    // run's own cap is quiet time (inactivityMs, plan §6.1 A).
    return this.deps.execute(turn, {
      invocationId,
      ...(voice ? { onProgress: (event: MatrixHermesProgressEvent) => voice.event(event) } : {}),
      // First learning explicitly uses the ordinary narration/progressive-message behavior.
      ...(voice && (!turn.context || turn.profile === 'first_learning') ? { turnStyle: true as const } : {}),
      ...(prepared ? { prepared } : {}),
      signal,
      deadlineAt,
      timeoutMs,
      ...(inactivityMs === undefined ? {} : { inactivityMs }),
      effects,
      ...(work ? { work } : {}),
      onSubmit: () => {
        const current = this.current(turnId)

        // A retired or bounded-out turn must not reach Hermes.
        if (!current || current.state !== 'running') {
          throw new Error('matrix_turn_retired')
        }

        this.update(current, { submitted: true })
        this.acknowledge(turnId)
      },
      onActivity: activity => {
        const current = this.current(turnId)
        const now = this.now()

        if (current && !current.times.firstToken && (activity.text || activity.reasoning || activity.tools.length)) {
          this.update(current, { times: { firstToken: now } })
        }

        this.activity.set(turnId, { at: now, tool: activity.tools.some(tool => tool.state === 'running') })

        if (this.notices.get(turnId) === 'still_waiting') {
          this.notices.delete(turnId)
          this.deps.changed()
        }
      }
    })
  }

  private async sync(turnId: string): Promise<void> {
    if (this.syncing.has(turnId)) {
      return
    }

    this.syncing.add(turnId)

    try {
      let turn = this.current(turnId)

      if (!turn || turn.state === 'retried') {
        return
      }

      if (!turn.questionEventId && turn.profile !== 'first_learning') {
        await this.syncQuestion(turn)
        turn = this.current(turnId)!
        this.sayChecking(turnId)
      }

      // Ordinary answers follow their question. First learning is an assistant-initiated run.
      if (
        turn.state === 'answered' &&
        (turn.questionEventId || turn.profile === 'first_learning') &&
        !turn.answerEventId
      ) {
        await this.syncAnswer(turn)
        turn = this.current(turnId)!
      }

      // A turn that cannot be run again says so, once, after its question (`notice`).
      if (turn.state === 'interrupted' && turn.notice && turn.questionEventId && !turn.answerEventId) {
        await this.syncNotice(turn)
        turn = this.current(turnId)!
      }

      if (
        turn.state === 'answered' &&
        (turn.questionEventId || turn.profile === 'first_learning') &&
        turn.answerEventId
      ) {
        this.update(turn, { state: 'done' })
        this.syncAttempts.delete(turnId)
        this.notices.delete(turnId)
        const t = turn.times
        this.deps.log(
          `[Matrix] turn ${turnId.slice(0, 8)} done authority=${turn.authority} ` +
            `running=${(t.running ?? 0) - t.accepted}ms first_token=${t.firstToken ? t.firstToken - t.accepted : -1}ms ` +
            `answered=${(t.answered ?? 0) - t.accepted}ms question_synced=${t.questionSynced ? t.questionSynced - t.accepted : -1}ms ` +
            `answer_synced=${t.answerSynced ? t.answerSynced - t.accepted : -1}ms`
        )
      }

      if (!this.needsSync(this.current(turnId)!)) {
        this.syncAttempts.delete(turnId)
        this.syncNotBefore.delete(turnId)

        if (this.notices.get(turnId) === 'not_synced') {
          this.notices.delete(turnId)
        }
      }
    } catch (error) {
      this.deps.log(
        `[Matrix] turn ${turnId.slice(0, 8)} sync failed: ${error instanceof Error ? error.message : 'unexpected'}`
      )
      this.backoff(turnId)
    } finally {
      this.syncing.delete(turnId)
      this.deps.changed()
    }
  }

  private backoff(turnId: string): void {
    const attempts = this.syncAttempts.get(turnId) ?? 0
    const steps = MATRIX_LOCAL_TURN.syncBackoffMs
    this.syncAttempts.set(turnId, attempts + 1)
    this.syncNotBefore.set(turnId, this.now() + steps[Math.min(attempts, steps.length - 1)]!)
  }

  private async syncQuestion(turn: MatrixLocalTurn): Promise<void> {
    if (turn.state === 'retried') {
      return
    }

    if (turn.questionAttempts > 0) {
      // A previous attempt may have reached the server: only proven absence re-sends.
      const lookup = await this.deps.findQuestion(turn)
      this.deps.log(`[Matrix] turn ${turn.turnId.slice(0, 8)} findTurn question=${lookup.state}`)

      if (lookup.state === 'found') {
        this.update(turn, { questionEventId: lookup.eventId, times: { questionSynced: this.now() } })
        this.acknowledge(turn.turnId)

        return
      }

      if (lookup.state === 'unknown') {
        this.backoff(turn.turnId)

        return
      }
    }

    const current = this.update(turn, { questionAttempts: turn.questionAttempts + 1 })

    try {
      const eventId = await this.deps.sendQuestion(current)
      const latest = this.current(turn.turnId)!
      this.update(latest, { questionEventId: eventId, times: { questionSynced: this.now() } })
      this.acknowledge(turn.turnId)
    } catch (error) {
      const latest = this.current(turn.turnId)

      // A question for another Mac or the cloud, refused by the room check before it is posted.
      if (latest?.state === 'waiting' && refusedRoom(error)) {
        this.refuse(latest)

        return
      }

      this.backoff(turn.turnId)
    }
  }

  private refuse(turn: MatrixLocalTurn): void {
    const now = this.now()
    this.update(turn, { state: 'not_sent', times: { notSent: now } })
    this.notices.delete(turn.turnId)
    this.lastBusy.delete(turn.turnId)
    this.deps.log(`[Matrix] turn ${turn.turnId.slice(0, 8)} not_sent: the room is an earlier conversation`)
    this.deps.changed()
  }

  private async syncAnswer(turn: MatrixLocalTurn): Promise<void> {
    if (
      turn.state !== 'answered' ||
      (!turn.questionEventId && turn.profile !== 'first_learning') ||
      !turn.answerText
    ) {
      return
    }

    const answerText = turn.answerText

    let invocationId = turn.turnId
    let transactionId = turn.answerTxnId

    if (turn.authority === 'platform') {
      if (!turn.platformInvocationId) {
        throw new Error('matrix_invocation_invalid')
      }

      if (!turn.platformTransactionId) {
        const grant = await this.deps.platform('complete', turn, { invocationId: turn.platformInvocationId })

        if (grant.state !== 'completed' || !grant.transactionId) {
          throw new Error('matrix_outcome_invalid')
        }

        turn = this.update(turn, { platformTransactionId: grant.transactionId })
      }

      invocationId = turn.platformInvocationId!
      transactionId = turn.platformTransactionId!
    }

    // One message, or an answer too long for one as several, in order (matrix-answer-parts.ts).
    // The same text always splits the same way, so a retry or a restart posts the same parts, each
    // under its own fixed transaction, each re-sent only once proven absent. The turn is answered
    // once its last part is in.
    // First learning promises a compact finish and publishes under one deterministic run marker;
    // never split it into several events that would share that marker's transaction.
    const parts = turn.profile === 'first_learning' ? [answerText] : matrixAnswerParts(answerText)

    for (;;) {
      const index = turn.answerParts?.length ?? 0

      // Every part is already in (a record written by a build that split this answer otherwise):
      // the answer is whole.
      if (index > 0 && index >= parts.length) {
        turn = this.update(turn, { answerEventId: turn.answerParts!.at(-1), times: { answerSynced: this.now() } })
        this.acknowledge(turn.turnId)
        await this.published(turn)

        return
      }

      const last = index >= parts.length - 1

      const part =
        parts.length > 1
          ? {
              index,
              count: parts.length,
              body: parts[index]!,
              matrixTransactionId: matrixAnswerPartTransaction(turn.answerTxnId, index)
            }
          : undefined

      let eventId: string | undefined

      if (turn.answerAttempts > 0 && turn.profile !== 'first_learning') {
        const lookup = await this.deps.findAnswer(turn, part?.index)
        this.deps.log(
          `[Matrix] turn ${turn.turnId.slice(0, 8)} findTurn answer${part ? ` part=${index + 1}/${parts.length}` : ''}=${lookup.state}`
        )

        if (lookup.state === 'unknown') {
          this.backoff(turn.turnId)

          return
        }

        if (lookup.state === 'found') {
          eventId = lookup.eventId
        }
      }

      if (eventId === undefined) {
        turn = this.update(turn, { answerAttempts: turn.answerAttempts + 1 })

        try {
          eventId = await this.deps.publishAnswer(turn, {
            ...(turn.questionEventId ? { questionEventId: turn.questionEventId } : {}),
            invocationId,
            transactionId,
            ...(part ? { part } : {})
          })
        } catch {
          this.backoff(turn.turnId)

          return
        }
      }

      turn = this.current(turn.turnId)!

      if (!last) {
        // A part is in: the next one starts its own attempts.
        turn = this.update(turn, { answerParts: [...(turn.answerParts ?? []), eventId], answerAttempts: 0 })

        continue
      }

      turn = this.update(turn, {
        answerEventId: eventId,
        ...(part ? { answerParts: [...(turn.answerParts ?? []), eventId] } : {}),
        times: { answerSynced: this.now() }
      })
      this.acknowledge(turn.turnId)
      await this.published(turn)

      return
    }
  }

  /**
   * The status notice of a turn that ended without an answer and cannot be run again, posted in
   * the answer's place under its fixed transaction, read back before any re-send, and recorded in
   * the platform when the platform holds the turn. Once: an attempt that may have reached the
   * room is found, never repeated.
   */
  private async syncNotice(turn: MatrixLocalTurn): Promise<void> {
    if (turn.state !== 'interrupted' || !turn.notice || !turn.questionEventId || turn.answerEventId) {
      return
    }

    // Kept before `turn` is replaced below: TypeScript forgets the checks above on reassignment.
    const questionEventId = turn.questionEventId
    let invocationId = turn.turnId
    let transactionId = turn.answerTxnId

    if (turn.authority === 'platform' && turn.platformInvocationId) {
      const platformInvocationId = turn.platformInvocationId
      if (!turn.platformTransactionId) {
        try {
          const grant = await this.deps.platform('complete', turn, { invocationId: turn.platformInvocationId })

          if (grant.state === 'completed' && grant.transactionId) {
            turn = this.update(turn, { platformTransactionId: grant.transactionId })
          }
        } catch {
          // Posted under the turn's own transaction; the platform's record is reconciled by recovery.
        }
      }

      if (turn.platformTransactionId) {
        invocationId = platformInvocationId
        transactionId = turn.platformTransactionId
      }
    }

    let eventId: string | undefined

    if (turn.answerAttempts > 0) {
      const lookup = await this.deps.findAnswer(turn)
      this.deps.log(`[Matrix] turn ${turn.turnId.slice(0, 8)} findTurn notice=${lookup.state}`)

      if (lookup.state === 'unknown') {
        this.backoff(turn.turnId)

        return
      }

      if (lookup.state === 'found') {
        eventId = lookup.eventId
      }
    }

    if (eventId === undefined) {
      turn = this.update(turn, { answerAttempts: turn.answerAttempts + 1 })

      try {
        eventId = await this.deps.publishAnswer(turn, {
          questionEventId,
          invocationId,
          transactionId,
          status: turn.notice
        })
      } catch {
        this.backoff(turn.turnId)

        return
      }
    }

    turn = this.update(this.current(turn.turnId)!, { answerEventId: eventId, times: { answerSynced: this.now() } })
    this.acknowledge(turn.turnId)
    await this.published(turn)
  }

  /**
   * The agent's read receipt on a turn's question (agent-turns v1.1): only once the question is
   * in the room and this Mac took it up (Hermes has it), or once its answer is posted. A turn
   * fenced elsewhere, handed off or never started is never acknowledged from here. Best effort.
   *
   * Taking it up needs the answering lease at that moment. Once the answer of a turn this Mac
   * ran under its lease is posted, the turn's own record is the proof: the lease went idle when
   * the run ended (nothing left to execute), a moment before the answer reached the room.
   */
  private acknowledge(turnId: string): void {
    const turn = this.current(turnId)

    if (!turn?.questionEventId || turn.state === 'retried' || !(turn.submitted || turn.answerEventId)) {
      return
    }

    try {
      this.deps.seen?.(turn, turn.answerEventId && turn.authority === 'lease' ? 'claimed' : 'lease')
    } catch {
      // Presentation only: a receipt that can't be asked for changes nothing about the turn.
    }
  }

  /** The platform learns where its answer went (authority `platform`, best effort). */
  private async published(turn: MatrixLocalTurn): Promise<void> {
    if (turn.authority !== 'platform' || turn.platformPublished || !turn.answerEventId) {
      return
    }

    // The platform's worker sent it and recorded the event on the ledger: there is nothing to tell the platform.
    if (turn.platformInvocationId && this.deps.ledgerPublishes?.(turn.platformInvocationId)) {
      this.update(this.current(turn.turnId)!, { platformPublished: true })

      return
    }

    try {
      await this.deps.platform('published', turn, {
        invocationId: turn.platformInvocationId,
        publishedEvent: turn.answerEventId
      })
      this.update(this.current(turn.turnId)!, { platformPublished: true })
    } catch {
      // The answer is in the room; the platform's record is reconciled by recovery.
    }
  }
}
