import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { GatewayRpcError } from '../../../shared/src/json-rpc-gateway'
import type { TurnObservation } from '../../shared/atum-observability'
import {
  MATRIX_MAX_FILE_BYTES,
  MATRIX_PROMPT_MAX,
  type MatrixHermesAttachment,
  type MatrixHermesPromptContent,
  type MatrixHermesPromptNotice
} from '../../shared/matrix'
import type { MatrixHistorySeed } from '../../shared/matrix-continuity'
import type {
  MatrixHermesActivityCallback,
  MatrixHermesActivitySnapshot,
  MatrixHermesActivityTool
} from '../../shared/matrix-hermes-activity'
import { type MatrixConnectedModel, type MatrixEffort, matrixSessionModelSwitch } from '../../shared/matrix-models'
import { matrixPetCompletionIntents, type MatrixPetIntentEnvelope } from '../../shared/matrix-pet-intent'
import { type MatrixHermesProgressEvent, matrixHermesProgressEvent } from '../../shared/matrix-progress-line'
import type { TerminalReadOptions, TerminalReadResult } from '../../shared/matrix-terminal'
import { macOwnerFacts, matrixTurnStyledPrompt } from '../../shared/matrix-turn-style'
import type { MatrixWebPreviewTarget } from '../../shared/matrix-workbench-preview'
import type { WordDocumentRequest } from '../../shared/word-companion'

import { validHistorySeed } from './continuity'
import { type MatrixHermesAsk, readMatrixHermesPrompt } from './hermes-prompts'
import { matrixJustInTimeFolderDenied } from './just-in-time-folders'
import { applyMatrixSessionEffort, matrixSessionEffortParams } from './model-session'
import type { MatrixTurnEffects } from './turn-effects'
import type { MatrixWordRequest } from './word-document'
import { matrixWebPreviewTarget } from './workbench-preview'
import { rebaseLegacySessionCwd } from './workspace-rebase'

/** Internal only: the domain dispatch fence is still consumed. This permits
 * keeping a healthy runtime, never retrying the fenced invocation. */
export class MatrixHermesPreSubmissionError extends Error {
  constructor(
    reason:
      | 'input_invalid'
      | 'conversation_invalid'
      | 'vault_unavailable'
      | 'session_rejected'
      | 'session_invalid'
      | 'continuity_unavailable',
    readonly rpcCode?: number
  ) {
    super(`matrix_hermes_${reason}`)
  }
}

/** Structural port implemented by the existing shared JsonRpcGatewayClient. */
interface Gateway {
  request<T>(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<T>
  onAny(handler: (event: { type: string; session_id?: string; payload?: unknown }) => void): () => void
  onState(handler: (state: string) => void): () => void
}

type MatrixHermesTurnObserver = (observation: TurnObservation) => void

const MAX_ACTIVITY_TEXT = 16_000
const MAX_ACTIVITY_DELTA_CHARS = 4_000
const MAX_ACTIVITY_TOOLS = 12
const MAX_ACTIVITY_NAME_CHARS = 128
const MAX_ACTIVITY_DETAIL_CHARS = 160
const ACTIVITY_TEXT_INTERVAL_MS = 100
const MAX_ATUM_CHATS_RESPONSE_BYTES = 24_576
const MAX_ATUM_MAC_RESPONSE_BYTES = 96 * 1_024

/** Only stable, product-supported tool labels may cross into the activity row.
 * Unknown/plugin names are intentionally omitted rather than becoming a new
 * arbitrary event tunnel. */
const PUBLIC_TOOL_LABELS: Readonly<Record<string, string>> = {
  atum_google: 'Google',
  browser_click: 'Browse',
  browser_navigate: 'Browse',
  browser_search: 'Browse',
  clarify: 'Ask question',
  delegate_task: 'Delegate task',
  execute_code: 'Run code',
  image_gen: 'Generate image',
  patch: 'Edit file',
  read_file: 'Read file',
  search_files: 'Search files',
  terminal: 'Terminal',
  todo: 'Plan task',
  web_extract: 'Read web',
  web_search: 'Search web',
  write_file: 'Write file',
  word_document: 'Word'
}

/**
 * Narrows Hermes's rich gateway event stream to the small public display model
 * the Matrix shell owns. It has no authority over the turn and never forwards
 * a raw event/payload to its observer.
 */
class MatrixHermesActivityProjection {
  private text = ''
  private reasoning = ''
  private tools: MatrixHermesActivityTool[] = []
  private state: MatrixHermesActivitySnapshot['state'] = 'running'
  private pendingText: ReturnType<typeof setTimeout> | undefined
  private sealed = false
  private published = false

  constructor(
    private readonly invocationId: string,
    private readonly observe?: MatrixHermesActivityCallback
  ) {}

  delta(payload: unknown) {
    if (this.sealed) {
      return
    }

    const text = this.publicText((payload as { text?: unknown } | undefined)?.text, MAX_ACTIVITY_DELTA_CHARS)

    if (!text || this.text.length >= MAX_ACTIVITY_TEXT) {
      return
    }

    this.text += text.slice(0, MAX_ACTIVITY_TEXT - this.text.length)
    this.schedule()
  }

  private schedule() {
    if (!this.published) {
      this.publish()

      return
    }

    // Batch cosmetic token noise; tool and terminal signals flush immediately.
    // Bound the rate, not the lifetime event count: long turns must keep updating.
    if (!this.pendingText) {
      this.pendingText = setTimeout(() => {
        this.pendingText = undefined
        this.publish()
      }, ACTIVITY_TEXT_INTERVAL_MS)
    }
  }

  /** Reasoning text, like the old app's "thinking" block; batched like the answer. */
  reasoningDelta(payload: unknown) {
    if (this.sealed) {
      return
    }

    const text = this.publicText((payload as { text?: unknown } | undefined)?.text, MAX_ACTIVITY_DELTA_CHARS)

    if (!text || this.reasoning.length >= MAX_ACTIVITY_TEXT) {
      return
    }

    this.reasoning += text.slice(0, MAX_ACTIVITY_TEXT - this.reasoning.length)
    this.schedule()
  }

  /** A complete reasoning block (Hermes sends one with the text that accompanies a tool
   * call). As in the old app it replaces the thinking shown so far, until the answer starts. */
  reasoningAvailable(payload: unknown) {
    if (this.sealed || this.text) {
      return
    }

    const text = this.publicText((payload as { text?: unknown } | undefined)?.text, MAX_ACTIVITY_DELTA_CHARS)

    if (!text) {
      return
    }

    this.reasoning = text
    this.schedule()
  }

  toolStart(payload: unknown) {
    if (this.sealed || this.tools.length >= MAX_ACTIVITY_TOOLS) {
      return
    }

    const value = payload as { name?: unknown; context?: unknown } | undefined
    const name = this.toolName(value?.name)

    if (!name) {
      return
    }

    // Hermes's own one-line context, flattened and bounded; never the raw arguments.
    const detail =
      typeof value?.context === 'string'
        ? value.context.replace(/\s+/g, ' ').trim().slice(0, MAX_ACTIVITY_DETAIL_CHARS)
        : ''

    this.tools.push({ name, state: 'running', summary: 'Running', ...(detail ? { detail } : {}) })
    this.publish()
  }

  toolComplete(payload: unknown) {
    if (this.sealed) {
      return
    }

    const name = this.toolName((payload as { name?: unknown } | undefined)?.name)

    if (!name) {
      return
    }

    const tool = [...this.tools].reverse().find(item => item.name === name && item.state === 'running')

    if (tool) {
      tool.state = 'complete'
      tool.summary = 'Completed'
    } else if (this.tools.length < MAX_ACTIVITY_TOOLS) {
      this.tools.push({ name, state: 'complete', summary: 'Completed' })
    } else {
      return
    }

    this.publish()
  }

  complete(payload: unknown) {
    if (this.sealed) {
      return
    }

    const value = payload as { status?: unknown; text?: unknown } | undefined

    if (value?.status !== 'complete') {
      return
    }

    const text = this.publicText(value.text, MAX_ACTIVITY_TEXT)

    if (text) {
      this.text = text
    }

    this.state = 'complete'
    this.sealed = true
    this.publish()
  }

  stop() {
    if (this.sealed) {
      return
    }

    this.state = 'stopped'
    this.sealed = true
    this.publish()
  }

  private publicText(value: unknown, limit: number) {
    return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : ''
  }

  private toolName(value: unknown) {
    if (typeof value !== 'string' || value.length > MAX_ACTIVITY_NAME_CHARS) {
      return ''
    }

    return PUBLIC_TOOL_LABELS[value] ?? ''
  }

  private publish() {
    clearTimeout(this.pendingText)
    this.pendingText = undefined

    // A failed turn with no public activity has nothing to retract or display.
    if (this.state === 'stopped' && !this.published) {
      return
    }

    const snapshot: MatrixHermesActivitySnapshot = {
      invocationId: this.invocationId,
      state: this.state,
      text: this.text,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      tools: this.tools.map(tool => ({ ...tool }))
    }

    this.published = true

    try {
      this.observe?.(snapshot)
    } catch {
      // Activity is cosmetic. A renderer/observer failure cannot alter the turn.
    }
  }
}

/**
 * Bring a resumed conversation's Hermes session to the person's current choice before its
 * turn. A model change uses upstream's `config.set model` for this session (`--session`, so
 * the profile's default is untouched): Hermes keeps the conversation's history and tool state
 * and records the switch for the model.
 *
 * This switch never confirms an expensive model: only the person's own choice in the picker
 * may (pages-providers.ts asks them). When Hermes answers that the switch needs that
 * confirmation, it has not switched, and the turn goes on with the conversation's model; a
 * new conversation starts on the profile's model. A refusal is logged the same way; nothing
 * here may fail the model switch. Effort is authoritative: a failed session effort write
 * stops before submission rather than answering at a different thinking level.
 */
export async function applyMatrixSessionChoice(
  gateway: Pick<Gateway, 'request'>,
  sessionId: string,
  info: { model?: unknown; provider?: unknown; reasoning_effort?: unknown } | undefined,
  choice: { effort?: MatrixEffort; sessionModel?: MatrixConnectedModel },
  signal: AbortSignal
): Promise<void> {
  const change = choice.sessionModel ? matrixSessionModelSwitch(info, choice.sessionModel) : undefined

  if (change) {
    try {
      const answer = await gateway.request<{ confirm_required?: unknown } | null>(
        'config.set',
        { key: 'model', value: change, session_id: sessionId },
        60_000,
        signal
      )

      if (answer?.confirm_required === true) {
        // No model name or Hermes's message: the line only says the switch waited.
        console.warn('[Matrix] conversation model switch not applied: confirmation_required')
      }
    } catch (error) {
      signal.throwIfAborted()
      console.warn(
        '[Matrix] conversation model switch not applied:',
        error instanceof GatewayRpcError ? error.code : 'unavailable'
      )
    }
  }

  try {
    await applyMatrixSessionEffort(gateway, sessionId, info, choice.effort, signal)
  } catch {
    signal.throwIfAborted()
    throw new MatrixHermesPreSubmissionError('session_invalid')
  }
}

/** Main-only transport. Caller must durably authorize/fence BEFORE calling.
 * This is not an authority API and is deliberately absent from the UI bridge.
 * Reuse Hermes's stored session/lineage, never a new agent loop or chat ledger.
 * Any failure after submission is an UNKNOWN outcome: callers must not retry.
 */
export async function runMatrixHermesTurn(
  gateway: Gateway,
  input: {
    invocationId: string
    /** The room this turn answers in: Hermes binds it as the turn's chat, so a job the
     * agent schedules delivers back into this room (readiness plan §4.5). */
    roomId?: string
    text: string
    attachments?: MatrixHermesAttachment[]
    workspace: string
    /** The opened native connection's old default; never a room/renderer fact. */
    legacyWorkspace?: string
    signal?: AbortSignal
    timeoutMs?: number
    deadlineAt?: number
    /**
     * The turn's own cap as quiet time, not a wall clock (reliability plan §6.1 A): the run
     * ends after this long with no event from its Hermes session — no stream token, no tool
     * call, no API response. An active run may go as long as it stays active; Stop, the
     * caller's signal and its lease still end it sooner. Hermes's own `agent.gateway_timeout`
     * is the same shape (gateway/run.py, default 1800 s). `deadlineAt`/`timeoutMs` remain the
     * first horizon for prompts and the timeout report; a caller that passes a bounded signal
     * of its own (a platform grant) keeps that bound.
     */
    inactivityMs?: number
    ask?: MatrixHermesAsk
    onPromptNotice?: (reason: MatrixHermesPromptNotice) => void
    onActivity?: MatrixHermesActivityCallback
    /** Hermes's redacted narration (`message.interim`) and `todo` list while the turn works, for
     * the owner's one progress line (agent-turns/1.3). Presentation only: it never fails the turn. */
    onProgress?: (event: MatrixHermesProgressEvent) => void
    /** Ask the agent to speak up while it works: the owner's chat will show what it says
     * (`onProgress` reaches a private chat's `MatrixTurnVoice`), so the shared turn style
     * (matrix-turn-style.ts, the cloud's own line) goes after the words and anything attached. */
    turnStyle?: boolean
    /** Main-only: each tool the turn starts, by its Hermes name (bounded), so defense-in-depth
     * policy can stop a session whose immutable schema was unexpectedly widened. Never displayed. */
    onToolStart?: (name: string) => void
    /** Native-only permission signal; raw tool arguments/results never leave this module. */
    onProtectedFolderDenied?: () => void
    onWebPreview?: (value: MatrixWebPreviewTarget) => void
    onTerminalRead?: (options: TerminalReadOptions, signal: AbortSignal) => Promise<TerminalReadResult | null>
    onWord?: MatrixWordRequest
    onStoreDiscovery?: (payload: unknown, signal: AbortSignal) => Promise<unknown>
    onAppsDiscovery?: (event: string, payload: unknown, signal: AbortSignal) => Promise<unknown>
    onAgentProfile?: (payload: unknown, signal: AbortSignal) => Promise<unknown>
    onAgentTask?: (payload: unknown, signal: AbortSignal) => Promise<unknown>
    onChats?: (payload: unknown, signal: AbortSignal) => Promise<string>
    onMacSources?: (payload: unknown, signal: AbortSignal) => Promise<string>
    /** Main-only product facts. This callback never receives Matrix, prompt or tool payloads. */
    observe?: MatrixHermesTurnObserver
    /** Called synchronously immediately before prompt.submit: the caller records, durably,
     * that from here on the turn may have run. A throw aborts before submission. */
    onSubmit?: () => void
    /** Follows what this run did, for a caller that must decide what to do if it ends without an
     * answer (turn-effects.ts): attached from the start, marked at submission, told of every tool
     * and of a connection lost after submission. Never changes the run. */
    effects?: MatrixTurnEffects
    /** A group turn with other people present: Hermes builds this session without memory,
     * skills, Google, scheduled jobs or messaging tools, on create and on every resume
     * (`shared_room`, tui_gateway/server.py). The agent's private session never carries it. */
    replyOnly?: boolean
    sharedRoom?: boolean
    /** The immutable comprehensive read-only first-learning tool profile. */
    firstLearning?: boolean
    /** Native host capability fixed at create and checked at resume. */
    petSurface?: boolean
    /** The conversation's thinking level, if the person chose one: the session's own level. */
    effort?: MatrixEffort
    /** The model this agent's profile answers with now: a resumed conversation still on
     * another one is switched before this turn (`matrixSessionModelSwitch`). */
    sessionModel?: MatrixConnectedModel
    conversation?: {
      storedSession?: string
      unsubmittedInvocation?: string
      seed?: MatrixHistorySeed
      /** The room's history read afresh, for replacing a stored session Hermes no longer has
       * (4007). Absent, such a link stays refused, as before. */
      reseed?(): Promise<MatrixHistorySeed>
      opened?(sessionId: string): Promise<void>
      remember(storedSession: string, unsubmittedInvocation?: string, completed?: boolean): void
    }
  }
): Promise<{ text: string; storedSession: string; pet?: MatrixPetIntentEnvelope }> {
  if (
    !input.invocationId ||
    !input.text ||
    input.text.length > MATRIX_PROMPT_MAX ||
    !input.workspace ||
    (input.conversation?.seed !== undefined && !validHistorySeed(input.conversation.seed)) ||
    (input.attachments &&
      (!Array.isArray(input.attachments) ||
        input.attachments.length > 2 ||
        input.attachments.some(
          attachment =>
            !(attachment.bytes instanceof Uint8Array) ||
            attachment.bytes.byteLength > MATRIX_MAX_FILE_BYTES ||
            typeof attachment.name !== 'string' ||
            !attachment.name.length ||
            attachment.name.length > 255
        )))
  ) {
    throw new MatrixHermesPreSubmissionError('input_invalid')
  }

  const cancelled = new AbortController()
  const now = Date.now()

  const inactivityMs =
    typeof input.inactivityMs === 'number' && Number.isFinite(input.inactivityMs) && input.inactivityMs > 0
      ? input.inactivityMs
      : undefined

  // The caller's own bound: its deadline, its timeout, or the lesser of both. The 90 s default
  // is only for a caller that names neither; a caller with a deadline (a phone message's
  // turn, invocation.ts) runs to it, not 90 s. With `inactivityMs` the deadline is only the
  // first horizon for prompts and the timeout report: quiet time, not this clock, ends the run.
  const deadlineAt =
    input.timeoutMs === undefined && input.deadlineAt === undefined && inactivityMs === undefined
      ? now + 90_000
      : Math.min(
          input.timeoutMs === undefined ? Infinity : now + input.timeoutMs,
          input.deadlineAt ?? Infinity,
          inactivityMs === undefined ? Infinity : now + inactivityMs
        )

  const inactive = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  /** Every event of this run's session counts, as Hermes's own tracker counts them. */
  const touch = () => {
    if (inactivityMs === undefined) {
      return
    }

    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      inactive.abort(new DOMException('matrix_turn_inactivity', 'TimeoutError'))
    }, inactivityMs)
    idleTimer.unref?.()
  }

  touch()

  const signal = AbortSignal.any([
    cancelled.signal,
    ...(inactivityMs === undefined
      ? [AbortSignal.timeout(Math.max(0, deadlineAt - now))]
      : [inactive.signal]),
    ...(input.signal ? [input.signal] : [])
  ])

  let sessionId: string | undefined
  let pet: MatrixPetIntentEnvelope | undefined
  const petSurface = input.petSurface === true && !input.sharedRoom && !input.replyOnly

  let unsubscribe = () => {}

  let unsubscribeState = () => {}

  let unsubscribeEffects = () => {}

  let abort = () => {}
  let completed = false
  let created = false
  let submitted = false
  let firstToken = false
  let toolOrdinal = 0

  const observationKey = input.observe ? randomUUID() : undefined

  const observe = (observation: Omit<TurnObservation, 'key'>) => {
    if (!observationKey) {
      return
    }

    try {
      input.observe?.({ key: observationKey, ...observation })
    } catch {
      // Observation is intentionally isolated from the native execution path.
    }
  }

  const activity = new MatrixHermesActivityProjection(input.invocationId, input.onActivity)

  // From here on a failure before submission ran nothing.
  input.effects?.attach()

  try {
    signal.throwIfAborted()

    const requestSession = async (storedSession?: string, seed = input.conversation?.seed) => {
      try {
        const resumed = await gateway.request<{
          session_id: string
          stored_session_id?: string
          session_key?: string
          running?: boolean
          async_delivery?: boolean
          info?: { model?: unknown; provider?: unknown; reasoning_effort?: unknown; cwd?: unknown }
        }>(
          storedSession ? 'session.resume' : 'session.create',
          storedSession
            ? {
                session_id: storedSession,
                source: 'matrix',
                async_delivery: false,
                ...(input.sharedRoom ? { shared_room: true } : {}),
                ...(input.replyOnly ? { reply_only: true } : {}),
                ...(petSurface ? { pet_surface: true } : {}),
                ...(input.firstLearning ? { first_learning: true } : {})
              }
            : {
                source: 'matrix',
                title: `Atum conversation ${input.invocationId}`,
                cwd: input.workspace,
                ...(seed ? { messages: seed } : {}),
                // A new conversation starts at the chosen level (session-scoped upstream).
                ...matrixSessionEffortParams(input.effort),
                async_delivery: false,
                ...(input.sharedRoom ? { shared_room: true } : {}),
                ...(input.replyOnly ? { reply_only: true } : {}),
                ...(petSurface ? { pet_surface: true } : {}),
                ...(input.firstLearning ? { first_learning: true } : {})
              },
          15_000,
          signal
        )

        if (storedSession) {
          await rebaseLegacySessionCwd({
            cwd: resumed.info?.cwd,
            legacy: input.legacyWorkspace ?? path.join(os.homedir(), 'Atum'),
            workspace: input.workspace,
            sessionId: resumed.session_id,
            gateway,
            signal
          })
        }

        return resumed
      } catch (error) {
        if (error instanceof GatewayRpcError && !signal.aborted) {
          throw new MatrixHermesPreSubmissionError('session_rejected', error.code)
        }

        throw error
      }
    }

    let session

    try {
      session = await requestSession(input.conversation?.storedSession)
      created = !input.conversation?.storedSession
    } catch (error) {
      const conversation = input.conversation

      if (
        !(error instanceof MatrixHermesPreSubmissionError) ||
        error.rpcCode !== 4007 ||
        !conversation?.storedSession ||
        conversation.unsubmittedInvocation === input.invocationId ||
        (!conversation.unsubmittedInvocation && !conversation.reseed)
      ) {
        throw error
      }

      signal.throwIfAborted()

      if (conversation.unsubmittedInvocation) {
        // Only an allocation durably known to precede ANY submission can be
        // replaced, and only for a different, already-authorized invocation.
        session = await requestSession()
      } else {
        // Hermes has no such session in this home: it writes a session's row at its first
        // prompt.submit, so none was ever sent to it here (a draft whose turn failed before
        // sending, or a home that moved). This invocation has sent nothing yet and is never
        // retried, so a new session cannot run it twice; it starts from the room's history,
        // as a new or migrated conversation does, instead of failing every later message.
        const seed = await conversation.reseed!()
        signal.throwIfAborted()

        if (!validHistorySeed(seed)) {
          throw new MatrixHermesPreSubmissionError('continuity_unavailable')
        }

        console.warn(
          `[Matrix] conversation session replaced reason=stored_session_missing seed=${seed.length ? 'room' : 'empty'}`
        )
        session = await requestSession(undefined, seed)
      }

      created = true
    }

    let storedSession = session?.stored_session_id ?? session?.session_key

    if (
      typeof session?.session_id !== 'string' ||
      !session.session_id ||
      typeof storedSession !== 'string' ||
      !storedSession
    ) {
      throw new Error('matrix_hermes_session_invalid')
    }

    sessionId = session.session_id

    if (input.effects) {
      // Its own listeners, kept past the turn's failure: a tool that starts while the turn is being
      // interrupted still counts, and a connection lost after submission is the end of what this
      // Mac can know. The turn's own handlers below ignore events once it has failed.
      const effects = input.effects
      const effectsSession = session.session_id

      const offTools = gateway.onAny(event => {
        if ((event.type === 'tool.start' || event.type === 'tool.complete') && event.session_id === undefined) {
          effects.blind()

          return
        }

        if (event.session_id !== effectsSession) {
          return
        }

        if (event.type === 'tool.start') {
          const tool = (event.payload as { name?: unknown } | undefined)?.name
          effects.toolStarted(typeof tool === 'string' && tool.length <= 128 ? tool : '')
        }
      })

      const offState = gateway.onState(state => {
        if (state !== 'open') {
          effects.blind()
        }
      })

      unsubscribeEffects = () => {
        offTools()
        offState()
      }
    }

    if (session.running || session.async_delivery !== false) {
      throw new MatrixHermesPreSubmissionError('session_invalid')
    }

    await input.conversation?.opened?.(sessionId)

    try {
      if (created) {
        input.conversation?.remember(storedSession, input.invocationId)
      }

      // Remove the allocation marker durably BEFORE sending. A crash after
      // this write stays fail-closed even if the request never reached Hermes.
      input.conversation?.remember(storedSession)
    } catch {
      throw new MatrixHermesPreSubmissionError('vault_unavailable')
    }

    signal.throwIfAborted()

    // The person's model and thinking level, at the turn's boundary (MP-1, MP-5): upstream's
    // session-scoped switches, never a new session and never mid-turn. A new session already
    // starts on the profile's model and the chosen level.
    if (!created) {
      await applyMatrixSessionChoice(gateway, sessionId, session.info, input, signal)
    }

    let promptText = input.text

    for (const attachment of input.attachments ?? []) {
      // Hermes owns staging, filename safety and @file context resolution.
      // Never supply `path`: Matrix metadata cannot name a local file to read.
      const attached = await gateway
        .request<{ attached?: boolean; ref_text?: string }>(
          'file.attach',
          {
            session_id: sessionId,
            name: attachment.name,
            data_url: `data:application/octet-stream;base64,${Buffer.from(attachment.bytes).toString('base64')}`
          },
          30_000,
          signal
        )
        .catch(error => {
          if (error instanceof GatewayRpcError && !signal.aborted) {
            // A known rejection precedes prompt.submit. Our unused new draft
            // will close below; retain allocation-only recovery for a NEW turn.
            if (created) {
              input.conversation?.remember(storedSession, input.invocationId)
            }

            throw new MatrixHermesPreSubmissionError('session_rejected', error.code)
          }

          throw error
        })

      signal.throwIfAborted()

      if (
        attached?.attached !== true ||
        typeof attached.ref_text !== 'string' ||
        !attached.ref_text.startsWith('@file:') ||
        attached.ref_text.length > 4096
      ) {
        throw new Error('matrix_attachment_unavailable')
      }

      promptText += `\n\n${attached.ref_text}`
    }

    // Per turn, last, in the owner's new message: the cached prefix and the role alternation are untouched.
    if (input.turnStyle) {
      promptText = matrixTurnStyledPrompt(promptText, MATRIX_PROMPT_MAX, macOwnerFacts())
    }

    const outcome = new Promise<string>((resolve, reject) => {
      let answer: string | undefined
      let failed = false
      let backendTurn: string | undefined

      const prompts = new Map<
        string,
        {
          kind: MatrixHermesPromptContent['kind']
          abort: AbortController
          awaitingUser: boolean
          expireClarification: () => void
        }
      >()

      const responses = new Set<Promise<void>>()
      const terminalReads = new Set<string>()
      const wordRequests = new Set<string>()
      const storeRequests = new Set<string>()
      const spentBoundRequests = new Set<string>()
      const boundRequests = new Map<string, AbortController>()

      const fail = () => {
        for (const request of boundRequests.values()) {
          request.abort()
        }
        boundRequests.clear()
        failed = true
        reject(new Error('matrix_hermes_outcome_unknown'))
      }

      abort = () => {
        if (prompts.size && (signal.reason?.name === 'TimeoutError' || Date.now() >= deadlineAt)) {
          input.onPromptNotice?.('deadline_expired')
        }

        fail()
      }

      signal.addEventListener('abort', abort, { once: true })
      unsubscribe = gateway.onAny(event => {
        if (event.session_id !== sessionId) {
          return
        }

        touch()

        if (failed) {
          return
        }

        if (input.onProgress && submitted && !signal.aborted && answer === undefined) {
          const progress = matrixHermesProgressEvent(event.type, event.payload)

          if (progress) {
            try {
              input.onProgress(progress)
            } catch {
              // A progress line cannot fail the turn.
            }
          }
        }

        if (event.type === 'message.start' && submitted && !signal.aborted && answer === undefined) {
          const turnId = (event.payload as { turn_id?: unknown } | undefined)?.turn_id

          if (!backendTurn && typeof turnId === 'string' && turnId.length > 0 && turnId.length <= 512) {
            backendTurn = turnId
          }
        } else if (event.type === 'preview.open' && submitted && !signal.aborted && answer === undefined) {
          const payload = event.payload as { turn_id?: unknown } | undefined
          const target = backendTurn && payload?.turn_id === backendTurn ? matrixWebPreviewTarget(payload) : undefined

          if (target) {
            try {
              input.onWebPreview?.(target)
            } catch {
              // A preview cannot fail the answer.
            }
          }
        } else if (event.type === 'terminal.read.request' && submitted && !signal.aborted && answer === undefined) {
          const payload = event.payload as
            | { request_id?: unknown; turn_id?: unknown; start?: unknown; count?: unknown }
            | undefined

          if (
            backendTurn &&
            payload?.turn_id === backendTurn &&
            typeof payload.request_id === 'string' &&
            payload.request_id.length > 0 &&
            payload.request_id.length <= 512 &&
            !terminalReads.has(payload.request_id)
          ) {
            terminalReads.add(payload.request_id)

            const options = {
              ...(Number.isSafeInteger(payload.start) ? { start: payload.start as number } : {}),
              ...(Number.isSafeInteger(payload.count) ? { count: payload.count as number } : {})
            }

            const responding = Promise.resolve()
              .then(() => input.onTerminalRead?.(options, signal))
              .catch(() => null)
              .then(result => {
                signal.throwIfAborted()

                return gateway
                  .request(
                    'terminal.read.respond',
                    {
                      request_id: payload.request_id,
                      session_id: sessionId,
                      turn_id: backendTurn,
                      text: JSON.stringify(result ?? { error: 'No in-app terminal is open.' })
                    },
                    2_000,
                    signal
                  )
                  .then(() => {})
              })
              .catch(() => {})
              .finally(() => responses.delete(responding))

            responses.add(responding)
          }
        } else if (event.type === 'word.document.request' && submitted && !signal.aborted && answer === undefined) {
          const payload = event.payload as { request_id?: unknown; turn_id?: unknown } | undefined

          if (
            backendTurn &&
            payload?.turn_id === backendTurn &&
            typeof payload.request_id === 'string' &&
            payload.request_id.length > 0 &&
            payload.request_id.length <= 256 &&
            !wordRequests.has(payload.request_id)
          ) {
            wordRequests.add(payload.request_id)
            const ref = {
              profile: 'matrix',
              request_id: payload.request_id,
              session_id: sessionId!,
              turn_id: backendTurn
            }

            const resolveRequest = () =>
              gateway.request<WordDocumentRequest>(
                'word.document.resolve',
                {
                  request_id: ref.request_id,
                  session_id: ref.session_id,
                  turn_id: ref.turn_id
                },
                2_000,
                signal
              )

            const responding = Promise.resolve()
              .then(() => {
                signal.throwIfAborted()

                if (!input.onWord) {
                  throw new Error('WORD_DOCUMENT_UNAVAILABLE')
                }

                return input.onWord(ref, resolveRequest, signal)
              })
              .then(result => result as unknown as Record<string, unknown>)
              .catch(error => ({
                error: String(error).match(/\bWORD_[A-Z_]+\b/)?.[0] ?? 'WORD_EDIT_UNCERTAIN'
              }))
              .then(result => {
                signal.throwIfAborted()

                return gateway
                  .request(
                    'word.document.respond',
                    {
                      request_id: ref.request_id,
                      session_id: ref.session_id,
                      turn_id: ref.turn_id,
                      result: JSON.stringify(result)
                    },
                    2_000,
                    signal
                  )
                  .then(() => {})
              })
              .catch(() => {})
              .finally(() => responses.delete(responding))

            responses.add(responding)
          }
        } else if (
          ['atum.store.request', 'atum.apps.list.request', 'atum.apps.open.request'].includes(event.type) &&
          submitted &&
          !signal.aborted &&
          answer === undefined
        ) {
          const payload = event.payload as { request_id?: unknown; turn_id?: unknown } | undefined
          if (
            backendTurn &&
            payload?.turn_id === backendTurn &&
            typeof payload.request_id === 'string' &&
            payload.request_id.length > 0 &&
            payload.request_id.length <= 256 &&
            !storeRequests.has(`${event.type}:${payload.request_id}`)
          ) {
            storeRequests.add(`${event.type}:${payload.request_id}`)
            const responding = Promise.resolve()
              .then(() =>
                event.type === 'atum.store.request'
                  ? input.onStoreDiscovery?.(event.payload, signal)
                  : input.onAppsDiscovery?.(event.type, event.payload, signal)
              )
              .catch(() => ({ error: 'The current catalog is unavailable.' }))
              .then(result => {
                signal.throwIfAborted()
                return gateway
                  .request(
                    event.type.replace(/\.request$/, '.respond'),
                    {
                      request_id: payload.request_id,
                      session_id: sessionId,
                      turn_id: backendTurn,
                      result: JSON.stringify(result ?? { error: 'Catalog discovery is unavailable in this host.' })
                    },
                    2_000,
                    signal
                  )
                  .then(() => {})
              })
              .catch(() => {})
              .finally(() => responses.delete(responding))
            responses.add(responding)
          }
        } else if (
          ['atum.agents.request', 'atum.agent_tasks.request', 'atum.chats.request', 'atum.mac.request'].includes(
            event.type
          ) &&
          submitted &&
          !signal.aborted &&
          answer === undefined
        ) {
          const payload = event.payload as { request_id?: unknown; turn_id?: unknown } | undefined

          if (
            backendTurn &&
            payload?.turn_id === backendTurn &&
            typeof payload.request_id === 'string' &&
            payload.request_id.length > 0 &&
            payload.request_id.length <= 256 &&
            !spentBoundRequests.has(`${event.type}:${payload.request_id}`)
          ) {
            const request = new AbortController()
            const requestKey = `${event.type}:${payload.request_id}`
            spentBoundRequests.add(requestKey)
            boundRequests.set(requestKey, request)
            const requestSignal = AbortSignal.any([signal, request.signal])
            const responding = Promise.resolve()
              .then(() =>
                event.type === 'atum.agents.request'
                  ? input.onAgentProfile?.(event.payload, requestSignal)
                  : event.type === 'atum.agent_tasks.request'
                    ? input.onAgentTask?.(event.payload, requestSignal)
                    : event.type === 'atum.chats.request'
                      ? input.onChats?.(event.payload, requestSignal)
                      : input.onMacSources?.(event.payload, requestSignal)
              )
              .catch(() =>
                ['atum.chats.request', 'atum.mac.request'].includes(event.type)
                  ? '{"error":"unavailable"}'
                  : { error: 'unavailable' }
              )
              .then(result => {
                requestSignal.throwIfAborted()

                const serialized =
                  ['atum.chats.request', 'atum.mac.request'].includes(event.type)
                    ? typeof result === 'string' &&
                      result.length > 0 &&
                      Buffer.byteLength(result, 'utf8') <=
                        (event.type === 'atum.mac.request'
                          ? MAX_ATUM_MAC_RESPONSE_BYTES
                          : MAX_ATUM_CHATS_RESPONSE_BYTES)
                      ? result
                      : '{"error":"unavailable"}'
                    : JSON.stringify(result ?? { error: 'unavailable' })

                return gateway
                  .request(
                    event.type.replace(/\.request$/, '.respond'),
                    {
                      request_id: payload.request_id,
                      session_id: sessionId,
                      turn_id: backendTurn,
                      result: serialized
                    },
                    2_000,
                    requestSignal
                  )
                  .then(() => {})
              })
              .catch(() => {})
              .finally(() => {
                boundRequests.delete(requestKey)
                responses.delete(responding)
              })

            responses.add(responding)
          }
        } else if (event.type === 'message.delta') {
          if (
            !firstToken &&
            typeof (event.payload as { text?: unknown } | undefined)?.text === 'string' &&
            (event.payload as { text: string }).text.length > 0
          ) {
            firstToken = true
            observe({ phase: 'first_token' })
          }

          activity.delta(event.payload)
        } else if (event.type === 'reasoning.delta') {
          // Not thinking.delta: that is the spinner's status line, which the old app ignores too.
          activity.reasoningDelta(event.payload)
        } else if (event.type === 'reasoning.available') {
          activity.reasoningAvailable(event.payload)
        } else if (event.type === 'tool.start') {
          toolOrdinal += 1
          observe({ phase: 'tool', toolKey: String(toolOrdinal) })
          activity.toolStart(event.payload)
          const tool = (event.payload as { name?: unknown } | undefined)?.name

          try {
            input.onToolStart?.(typeof tool === 'string' && tool.length <= 128 ? tool : '')
          } catch {
            // A watcher cannot fail the turn; it stops it through the turn's own signal.
          }
        } else if (event.type === 'tool.complete') {
          activity.toolComplete(event.payload)
          const tool = (event.payload as { name?: unknown } | undefined)?.name

          if (typeof tool === 'string' && matrixJustInTimeFolderDenied(tool, event.payload)) {
            try {
              input.onProtectedFolderDenied?.()
            } catch {
              // Presentation cannot change the turn outcome.
            }
          }
        } else if (
          event.type === 'approval.request' ||
          event.type === 'clarify.request' ||
          // The old app's masked prompts: the Mac's sudo password, a skill's credential.
          // Both go only to this Hermes, in the owner's own window, never to the room.
          event.type === 'sudo.request' ||
          event.type === 'secret.request'
        ) {
          try {
            if (!input.ask || answer !== undefined) {
              throw new Error('prompt unavailable')
            }

            const { requestId, content } = readMatrixHermesPrompt(event.type, event.payload)

            if (prompts.has(requestId) || prompts.size >= 8) {
              throw new Error('ambiguous prompt')
            }

            const expired = new AbortController()
            let expiryReported = false

            const prompt = {
              kind: content.kind,
              abort: expired,
              awaitingUser: true,
              expireClarification: () => {
                if (content.kind === 'clarify' && !expiryReported) {
                  expiryReported = true
                  input.onPromptNotice?.('clarification_expired')
                }
              }
            }

            prompts.set(requestId, prompt)
            const promptSignal = AbortSignal.any([signal, expired.signal])

            const responding = input
              .ask(content, promptSignal, deadlineAt)
              .then(async response => {
                promptSignal.throwIfAborted()

                if (failed || response.kind !== content.kind) {
                  throw new Error('stale response')
                }

                prompt.awaitingUser = false

                // The RPC uses the occurrence id, NOT an allowlist pattern/FIFO.
                if (response.kind === 'approval') {
                  if (
                    response.choice !== 'deny' &&
                    !(response.choice === 'once' && content.kind === 'approval' && content.allowOnce)
                  ) {
                    throw new Error('invalid approval')
                  }

                  const result = await gateway.request<{ resolved?: number }>(
                    'approval.respond',
                    {
                      session_id: sessionId,
                      request_id: requestId,
                      choice: response.choice
                    },
                    15_000,
                    promptSignal
                  )

                  if (result.resolved !== 1) {
                    throw new Error('approval expired')
                  }
                } else if (response.kind === 'sudo' || response.kind === 'secret') {
                  const result = await gateway.request<{ status?: string }>(
                    response.kind === 'sudo' ? 'sudo.respond' : 'secret.respond',
                    response.kind === 'sudo'
                      ? { request_id: requestId, password: response.password }
                      : { request_id: requestId, value: response.value },
                    15_000,
                    promptSignal
                  )

                  if (result.status !== 'ok' && result.status !== 'expired') {
                    throw new Error('prompt answer failed')
                  }
                } else {
                  if (typeof response.answer !== 'string' || response.answer.length > MATRIX_PROMPT_MAX) {
                    throw new Error('invalid answer')
                  }

                  const result = await gateway.request<{ status?: string }>(
                    'clarify.respond',
                    {
                      request_id: requestId,
                      answer: response.answer
                    },
                    15_000,
                    promptSignal
                  )

                  if (result.status !== 'ok' && result.status !== 'expired') {
                    throw new Error('clarification failed')
                  }

                  if (result.status === 'expired' && !signal.aborted) {
                    prompt.expireClarification()
                  }
                }
              })
              .catch(() => {
                if (!expired.signal.aborted) {
                  fail()
                }
              })
              .finally(() => {
                if (prompts.get(requestId) === prompt) {
                  prompts.delete(requestId)
                }

                responses.delete(responding)
              })

            responses.add(responding)
          } catch {
            fail()
          }
        } else if (event.type === 'clarify.expire') {
          const requestId = (event.payload as { request_id?: string })?.request_id

          const prompt = requestId ? prompts.get(requestId) : undefined

          if (requestId && prompt?.kind === 'clarify') {
            prompt.expireClarification()
            prompt.abort.abort()
            prompts.delete(requestId)
          }
        } else if (event.type === 'sudo.expire' || event.type === 'secret.expire') {
          // Hermes gave up waiting (its own timeout): the card goes, the turn continues.
          const requestId = (event.payload as { request_id?: string })?.request_id
          const prompt = requestId ? prompts.get(requestId) : undefined

          if (requestId && prompt && (prompt.kind === 'sudo' || prompt.kind === 'secret')) {
            prompt.abort.abort()
            prompts.delete(requestId)
          }
        } else if (event.type === 'error') {
          // No implicit approval, credential forwarding or renderer callbacks.
          fail()
        } else if (event.type === 'message.complete') {
          for (const prompt of prompts.values()) {
            if (prompt.awaitingUser) {
              prompt.abort.abort()
            }
          }

          const payload = event.payload as { status?: string; text?: string; pet_intents?: unknown }

          // A completed answer is kept whatever its length: the tools already ran and the tokens
          // were spent. One too long for a single message is posted as several (matrix-answer-parts.ts).
          if (payload?.status === 'complete' && typeof payload.text === 'string' && payload.text.length > 0) {
            answer = payload.text
            pet = matrixPetCompletionIntents(payload.pet_intents, petSurface)
            activity.complete(event.payload)
          } else {
            fail()
          }
        } else if (event.type === 'session.info' && answer !== undefined) {
          const payload = event.payload as { running?: boolean; stored_session_id?: string }

          // message.complete precedes the backend's finally/idle transition.
          // Waiting here prevents the next prompt interrupting/queueing behind
          // an old turn and captures Hermes's compression continuation identity.
          if (
            payload?.running === false &&
            typeof payload.stored_session_id === 'string' &&
            payload.stored_session_id
          ) {
            storedSession = payload.stored_session_id
            // A completion can precede a responder ACK on this transport too.
            // Do not publish success while the user's decision is unconfirmed.
            void Promise.all([...responses]).then(() => {
              if (!failed) {
                resolve(answer!)
              }
            })
          }
        }
      })
      unsubscribeState = gateway.onState(state => {
        if (state !== 'open') {
          fail()
        }
      })
    })

    // Observe outcome immediately; it may arrive before prompt.submit's ACK.
    void outcome.catch(() => {})

    if (input.effects) {
      // Whether a tool start would be seen, asked of the live session just before the prompt leaves:
      // a run is only provably read-only if it would (turn-effects.ts). Any failure to ask, or an
      // older Hermes that does not know the question, is the same as "not shown".
      try {
        const progress = await gateway.request<{ value?: unknown }>(
          'config.get',
          { key: 'verbose', session_id: sessionId },
          3_000,
          signal
        )

        input.effects.toolProgress(progress?.value)
      } catch {
        input.effects.toolProgress(undefined)
      }
    }

    signal.throwIfAborted()

    try {
      input.onSubmit?.()
    } catch {
      throw new MatrixHermesPreSubmissionError('vault_unavailable')
    }

    submitted = true
    input.effects?.submit()
    observe({ phase: 'start' })

    const [, text] = await Promise.all([
      gateway
        .request(
          'prompt.submit',
          { session_id: sessionId, text: promptText, ...(input.roomId ? { chat_id: input.roomId } : {}) },
          15_000,
          signal
        )
        .then(ack => {
          if ((ack as { status?: string })?.status !== 'streaming') {
            throw new Error('matrix_hermes_submission_invalid')
          }
        }),
      outcome
    ])

    signal.throwIfAborted()
    input.conversation?.remember(storedSession, undefined, true)
    completed = true
    observe({ phase: 'finish', outcome: 'completed' })

    return { text, storedSession, ...(pet ? { pet } : {}) }
  } catch (error) {
    if (!submitted && !signal.aborted && error instanceof MatrixHermesPreSubmissionError) {
      throw error
    }

    // Neither provider details nor arbitrary tool/event payloads cross this seam.
    throw new Error('matrix_hermes_outcome_unknown')
  } finally {
    if (submitted && !completed) {
      observe({ phase: 'lost' })
    }

    if (!completed) {
      activity.stop()
    }

    unsubscribe()
    unsubscribeState()
    clearTimeout(idleTimer)
    signal.removeEventListener('abort', abort)
    cancelled.abort()

    try {
      if (sessionId && submitted && !completed) {
        await gateway.request('session.interrupt', { session_id: sessionId }, 2_000).catch(() => {})
        await gateway.request('session.close', { session_id: sessionId }, 2_000).catch(() => {})
      } else if (sessionId && created && !submitted) {
        // Discard our unused draft, not a rejected resumed/busy session. If its
        // release is uncertain, the executor must retire the process instead.
        await gateway.request('session.close', { session_id: sessionId }, 2_000).catch(() => {
          throw new Error('matrix_hermes_outcome_unknown')
        })
      }
    } finally {
      // After the interrupt, so a tool that began while Hermes was being stopped is still seen.
      unsubscribeEffects()
    }
  }
}
