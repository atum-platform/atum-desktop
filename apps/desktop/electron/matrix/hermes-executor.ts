import type { TurnObservation } from '../../shared/atum-observability'
import type { MatrixHermesAttachment, MatrixHermesPromptNotice } from '../../shared/matrix'
import {
  MATRIX_CONTINUITY,
  type MatrixContinuityRead,
  type MatrixConversationWitness,
  type MatrixHistorySeed
} from '../../shared/matrix-continuity'
import type { MatrixHermesActivityCallback } from '../../shared/matrix-hermes-activity'
import type { MatrixConnectedModel, MatrixEffort } from '../../shared/matrix-models'
import type { MatrixHermesProgressEvent } from '../../shared/matrix-progress-line'
import type { MatrixHermesTerminalEvent, TerminalReadOptions, TerminalReadResult } from '../../shared/matrix-terminal'
import type { MatrixWebPreviewTarget } from '../../shared/matrix-workbench-preview'
import type { EncryptedStore } from '../encrypted-store'

import { canResumeConversation, conversationAnchor, conversationSeed, conversationWitness } from './continuity'
import type { DisclosedAudience } from './groups/disclosure'
import type { MatrixHermesAsk } from './hermes-prompts'
import type { MatrixHermesConnection } from './hermes-runtime'
import { MatrixHermesPreSubmissionError, runMatrixHermesTurn } from './hermes-turn'
import type { MatrixPreparedConversation } from './prepared-conversation'
import type { MatrixTurnEffects } from './turn-effects'
import type { MatrixWordRequest } from './word-document'

interface ConversationLink {
  version: 1 | 2
  storedSession: string
  unsubmittedInvocation?: string
  continuity?: MatrixConversationWitness
  /** A group's session with other people in it: Hermes keeps it restricted for its whole
   * life (no memory, skills, Google, scheduled jobs or messaging tools). */
  replyOnly?: true
  sharedRoom?: true
  petSurface?: true
  firstLearning?: true
  disclosedAudience?: DisclosedAudience
}

/** The room's history, read through the owner's SDK (main's conversationContinuity). A `bounded`
 * read only seeds a new session: short of time it keeps the newest dialogue (`clipped`). */
export interface MatrixConversationHistory {
  read(stopAt?: string, options?: { bounded?: boolean }): Promise<MatrixContinuityRead>
}

export type { MatrixPreparedConversation } from './prepared-conversation'

interface PreparedState {
  record?: ConversationLink
  witness?: MatrixConversationWitness
  seed?: MatrixHistorySeed
  petSurface: boolean
  sharedRoom: boolean
  replyOnly: boolean
  firstLearning: boolean
}

interface PrepareInput {
  conversationKey: string
  signal: AbortSignal
  continuity?: MatrixConversationHistory
  replyOnly?: boolean
  sharedRoom?: boolean
  petSurface?: boolean
  firstLearning?: boolean
}

export interface MatrixHermesTurnLifecycle {
  /** Capture the revision/text the turn begins from, after every native preflight passed. */
  beforeTurn(): Promise<unknown>
  /** Called only after Hermes accepted the prompt; failures never rewrite the turn outcome. */
  afterTurn(start: unknown): Promise<void>
}

/** A seed taken from a read that ran out of time says so once: a closed code and a count, never
 * words or IDs. */
function logClipped(read: MatrixContinuityRead) {
  if (read.clipped) {
    console.warn(`[Matrix] conversation seeded reason=history_clipped entries=${read.entries.length}`)
  }
}

/** One native-owned enrollment lifetime, not a runtime pool or an agent engine.
 * Main closes it before renewing/revoking an enrollment or cleaning credentials.
 * Hermes owns context and compression; the vault stores only the scoped link.
 */
export class MatrixHermesExecutor {
  private readonly lifetime = new AbortController()
  private opening?: Promise<MatrixHermesConnection>
  private connection?: MatrixHermesConnection
  private stopping?: Promise<void>
  private busy = false
  private activeConversation?: string
  private readonly sessions = new Map<string, string>()
  /** Each prepared conversation, until the one run that uses it. */
  private readonly prepared = new WeakMap<MatrixPreparedConversation, PreparedState>()
  private readonly terminalSessions = new Map<string, (value: MatrixHermesTerminalEvent) => boolean | void>()
  private terminalUnsubscribe?: () => void

  constructor(
    private readonly open: (signal: AbortSignal) => Promise<MatrixHermesConnection>,
    private readonly store: EncryptedStore,
    private readonly observe?: (observation: TurnObservation) => void,
    private readonly lifecycle?: MatrixHermesTurnLifecycle
  ) {}

  get usable() {
    return !this.lifetime.signal.aborted && !this.connection?.signal.aborted
  }

  /** Management reads share the existing backend, not a page-owned runtime.
   * Closing/cancelling a page must never cancel an unrelated agent turn. */
  get connected(): MatrixHermesConnection | undefined {
    return this.usable ? this.connection : undefined
  }

  /** Add direction to this executor's one running turn. A queued receipt is not completion. */
  async steer(conversationKey: string, text: string): Promise<boolean> {
    const value = text.trim()

    if (
      !this.busy ||
      this.activeConversation !== conversationKey ||
      !value ||
      new TextEncoder().encode(value).byteLength > 65_536
    ) {
      return false
    }

    const until = Date.now() + 15_000
    let sessionId = this.sessions.get(conversationKey)
    let connection = this.connected

    while (this.busy && this.activeConversation === conversationKey && !sessionId && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 50))
      sessionId = this.sessions.get(conversationKey)
      connection = this.connected
    }

    if (
      !this.busy ||
      this.activeConversation !== conversationKey ||
      this.sessions.get(conversationKey) !== sessionId ||
      !connection ||
      !sessionId
    ) {
      return false
    }

    try {
      const result = await connection.gateway.request<{ status?: unknown }>(
        'session.steer',
        { session_id: sessionId, text: value },
        5_000,
        this.lifetime.signal
      )

      return (
        this.busy &&
        this.activeConversation === conversationKey &&
        this.sessions.get(conversationKey) === sessionId &&
        result?.status === 'queued'
      )
    } catch {
      return false
    }
  }

  async connect(signal: AbortSignal): Promise<MatrixHermesConnection> {
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    this.opening ??= this.open(this.lifetime.signal)

    const stop = () => {
      void this.close()
    }

    signal.addEventListener('abort', stop, { once: true })

    try {
      this.connection = await this.opening
      signal.throwIfAborted()
      this.lifetime.signal.throwIfAborted()
      this.connection.signal.throwIfAborted()

      this.terminalUnsubscribe ??= this.connection.gateway.onAny(event => {
        const receive = event.session_id ? this.terminalSessions.get(event.session_id) : undefined
        const payload = event.payload as { process_id?: unknown; chunk?: unknown } | undefined

        if (
          !this.usable ||
          !receive ||
          typeof payload?.process_id !== 'string' ||
          !/^[\w-]{1,128}$/.test(payload.process_id)
        ) {
          return
        }

        try {
          if (event.type === 'agent.terminal.output' && typeof payload.chunk === 'string' && payload.chunk.length > 0) {
            if (
              receive({ kind: 'output', processId: payload.process_id, chunk: payload.chunk.slice(-64_000) }) === false
            ) {
              this.terminalSessions.delete(event.session_id!)
            }
          } else if (event.type === 'terminal.close') {
            receive({ kind: 'close', processId: payload.process_id })
          }
        } catch {
          // Display cannot alter a process or an agent turn.
        }
      })

      return this.connection
    } catch {
      await this.close()
      throw new Error('matrix_hermes_runtime_stopped')
    } finally {
      signal.removeEventListener('abort', stop)
    }
  }

  /**
   * Everything that can refuse a turn without Hermes: the conversation's vault link and, with the
   * room at hand, its history (resumed, or a new session's seed). Main does this before it
   * dispatches the turn, so a slow or failed read refuses nothing that already counts as run; the
   * listener offers the turn again (hermes-listener.ts). With no stored link, a read short of
   * time seeds from the newest dialogue it read rather than refusing (owner rule: the agent
   * answers with what it has, invisibly); a stored session is resumed only on a complete read.
   */
  async prepare(input: PrepareInput): Promise<MatrixPreparedConversation> {
    const state = await this.conversation(input)
    const prepared: MatrixPreparedConversation = Object.freeze({ conversationKey: input.conversationKey })
    this.prepared.set(prepared, state)

    return prepared
  }

  /** Whether this executor made `prepared` and no run has used it yet. */
  owns(prepared: MatrixPreparedConversation): boolean {
    return this.prepared.has(prepared)
  }

  private async conversation(input: PrepareInput): Promise<PreparedState> {
    const petSurface = input.petSurface === true && !input.sharedRoom && !input.replyOnly

    if (!/^matrix-conversation-[a-f0-9]{64}$/.test(input.conversationKey)) {
      throw new MatrixHermesPreSubmissionError('conversation_invalid')
    }

    let record: ConversationLink | undefined

    try {
      const raw = this.store.getItem(input.conversationKey)

      if (this.store.failureCode()) {
        throw new Error('vault unavailable')
      }

      record = raw === null ? undefined : (JSON.parse(raw) as ConversationLink)

      if (
        raw !== null &&
        (!record ||
          ![1, 2].includes(record.version) ||
          typeof record.storedSession !== 'string' ||
          !record.storedSession ||
          (record.unsubmittedInvocation !== undefined &&
            (record.version !== 2 ||
              typeof record.unsubmittedInvocation !== 'string' ||
              !record.unsubmittedInvocation)) ||
          // A session is restricted or not for its whole life: never the other kind's.
          (record.sharedRoom === true) !== (input.sharedRoom === true) ||
          (record.replyOnly === true) !== (input.replyOnly === true) ||
          (record.petSurface === true) !== petSurface ||
          (record.firstLearning === true) !== (input.firstLearning === true))
      ) {
        throw new MatrixHermesPreSubmissionError('conversation_invalid')
      }

      this.store.assertEncryptionAvailable()
    } catch (error) {
      throw error instanceof MatrixHermesPreSubmissionError
        ? error
        : new MatrixHermesPreSubmissionError('vault_unavailable')
    }

    let witness = conversationWitness(record?.continuity)
    let seed: MatrixHistorySeed | undefined

    if (input.continuity) {
      const history = input.continuity

      try {
        if (!record || record.unsubmittedInvocation || !witness) {
          // A new session either way: the full read, or within its time the newest dialogue.
          const read = await history.read(undefined, { bounded: true })
          input.signal.throwIfAborted()
          logClipped(read)
          seed = conversationSeed(read)
          witness = { anchor: conversationAnchor(read), ours: [] }
        } else {
          let read = await history.read(witness.anchor)
          input.signal.throwIfAborted()

          if (!canResumeConversation(witness, read)) {
            if (witness.anchor) {
              read = await history.read(undefined, { bounded: true })
              input.signal.throwIfAborted()
              logClipped(read)
            }

            seed = conversationSeed(read)
            witness = { anchor: conversationAnchor(read), ours: [] }
          } else {
            witness = { anchor: conversationAnchor(read) ?? witness.anchor, ours: witness.ours }
          }
        }
      } catch {
        input.signal.throwIfAborted()
        throw new MatrixHermesPreSubmissionError('continuity_unavailable')
      }
    }

    return {
      record,
      witness,
      seed,
      petSurface,
      sharedRoom: input.sharedRoom === true,
      replyOnly: input.replyOnly === true,
      firstLearning: input.firstLearning === true
    }
  }

  async run(input: {
    conversationKey: string
    invocationId: string
    /** The Matrix room the turn answers in; Hermes records it as a scheduled job's origin. */
    roomId?: string
    text: string
    attachments?: MatrixHermesAttachment[]
    signal: AbortSignal
    deadlineAt?: number
    ask?: MatrixHermesAsk
    onPromptNotice?: (reason: MatrixHermesPromptNotice) => void
    onActivity?: MatrixHermesActivityCallback
    /** Redacted narration and todo list for the owner's progress line (runMatrixHermesTurn). */
    onProgress?: (event: MatrixHermesProgressEvent) => void
    /** The owner's chat hears this turn narrated: the shared turn style goes with the prompt (runMatrixHermesTurn). */
    turnStyle?: boolean
    /** Each tool the turn starts, by its Hermes name (runMatrixHermesTurn). */
    onToolStart?: (name: string) => void
    /** One renderer-safe signal when macOS refuses a protected home folder. */
    onProtectedFolderDenied?: () => void
    onWebPreview?: (value: MatrixWebPreviewTarget) => void
    onTerminal?: (value: MatrixHermesTerminalEvent) => boolean | void
    onTerminalRead?: (options: TerminalReadOptions, signal: AbortSignal) => Promise<TerminalReadResult | null>
    onWord?: MatrixWordRequest
    onStoreDiscovery?: (payload: unknown, signal: AbortSignal) => Promise<unknown>
    onAppsDiscovery?: (event: string, payload: unknown, signal: AbortSignal) => Promise<unknown>
    onAgentProfile?: (payload: unknown, signal: AbortSignal) => Promise<unknown>
    onAgentTask?: (payload: unknown, signal: AbortSignal) => Promise<unknown>
    onChats?: (payload: unknown, signal: AbortSignal) => Promise<string>
    onMacSources?: (payload: unknown, signal: AbortSignal) => Promise<string>
    onSubmit?: () => void
    /** Follows what the run did (turn-effects.ts); taken over here, before anything can refuse. */
    effects?: MatrixTurnEffects
    /** The local path's cap (bounded by the lease). Without it or `deadlineAt`, 90 s. */
    timeoutMs?: number
    /** Quiet-time cap passed through to `runMatrixHermesTurn` (reliability plan §6.1 A). */
    inactivityMs?: number
    /** Native-bound read from the human SDK, never arbitrary renderer history. */
    continuity?: MatrixConversationHistory
    /** The conversation as made ready before dispatch (`prepare`), used here once. Without it,
     * this run reads the vault and the history itself. */
    prepared?: MatrixPreparedConversation
    /** A group turn with other people present (shared/matrix-group-room.ts): its own
     * restricted Hermes session, created and resumed so, never the agent's private one. */
    replyOnly?: boolean
    sharedRoom?: boolean
    /** Immutable first-learning session: approved reads plus memory, no side-effect tools. */
    firstLearning?: boolean
    /** Native host capability, immutable for the stored conversation. */
    petSurface?: boolean
    /** The conversation's thinking level, if chosen (runMatrixHermesTurn). */
    effort?: MatrixEffort
    /** The model the profile answers with now (runMatrixHermesTurn). */
    sessionModel?: MatrixConnectedModel
  }) {
    // From here to the prompt, a refusal or an abort ran nothing in Hermes.
    input.effects?.attach()

    // Main already serializes UI operations. Retain this boundary for listener
    // integration: two requests must never share a live session concurrently.
    if (this.busy) {
      throw new Error('matrix_hermes_busy')
    }

    this.busy = true
    this.activeConversation = input.conversationKey
    let lifecycleStart: unknown
    let submitted = false
    const preparedState = input.prepared ? this.prepared.get(input.prepared) : undefined

    if (input.prepared) {
      // Used once: a second run with the same preparation is refused before anything opens.
      this.prepared.delete(input.prepared)
    }

    try {
      if (
        input.prepared &&
        (!preparedState ||
          input.prepared.conversationKey !== input.conversationKey ||
          preparedState.sharedRoom !== (input.sharedRoom === true) ||
          preparedState.replyOnly !== (input.replyOnly === true) ||
          preparedState.petSurface !== (input.petSurface === true && !input.sharedRoom && !input.replyOnly) ||
          preparedState.firstLearning !== (input.firstLearning === true))
      ) {
        throw new MatrixHermesPreSubmissionError('conversation_invalid')
      }

      const { record, seed, petSurface, ...ready } = preparedState ?? (await this.conversation(input))
      let witness = ready.witness

      if (this.lifecycle) {
        lifecycleStart = await this.lifecycle.beforeTurn().catch(() => undefined)
      }

      const connection = await this.connect(input.signal)
      const continuity = input.continuity

      return await runMatrixHermesTurn(connection.gateway, {
        ...input,
        onSubmit: () => {
          submitted = true
          input.onSubmit?.()
        },
        replyOnly: input.replyOnly === true,
        sharedRoom: input.sharedRoom === true,
        petSurface,
        firstLearning: input.firstLearning === true,
        observe: this.observe,
        workspace: connection.workspace,
        legacyWorkspace: connection.legacyWorkspace,
        signal: AbortSignal.any([input.signal, this.lifetime.signal, connection.signal]),
        conversation: {
          storedSession: seed === undefined ? record?.storedSession : undefined,
          unsubmittedInvocation: seed === undefined ? record?.unsubmittedInvocation : undefined,
          seed,
          // The stored session is missing from this Hermes home: a new session seeded the way
          // any re-seeded conversation is (above), with a fresh witness.
          ...(continuity
            ? {
                reseed: async () => {
                  try {
                    const read = await continuity.read(undefined, { bounded: true })
                    input.signal.throwIfAborted()
                    logClipped(read)
                    witness = { anchor: conversationAnchor(read), ours: [] }

                    return conversationSeed(read)
                  } catch {
                    input.signal.throwIfAborted()
                    throw new MatrixHermesPreSubmissionError('continuity_unavailable')
                  }
                }
              }
            : {}),
          opened: async sessionId => {
            const previous = this.sessions.get(input.conversationKey)
            this.sessions.set(input.conversationKey, sessionId)

            if (input.onTerminal) {
              this.terminalSessions.set(sessionId, input.onTerminal)
            } else {
              this.terminalSessions.delete(sessionId)
            }

            // Only this executor's own idle live session is closed. Stored
            // Hermes history remains intact; other profiles/agents are untouched.
            if (previous && previous !== sessionId) {
              this.terminalSessions.delete(previous)
              await connection.gateway.request('session.close', { session_id: previous }, 2_000).catch(() => {
                console.warn('[Matrix] previous idle conversation session could not be closed')
              })
            }
          },
          remember: (storedSession, unsubmittedInvocation, completed) => {
            if (witness && completed) {
              witness = {
                ...witness,
                ours: [...witness.ours.filter(id => id !== input.invocationId), input.invocationId].slice(
                  -MATRIX_CONTINUITY.ours
                )
              }
            }

            this.store.setItem(
              input.conversationKey,
              JSON.stringify({
                version: 2,
                storedSession,
                unsubmittedInvocation,
                ...(witness ? { continuity: witness } : {}),
                ...(input.sharedRoom ? { sharedRoom: true } : {}),
                ...(input.replyOnly ? { replyOnly: true } : {}),
                ...(petSurface ? { petSurface: true } : {}),
                ...(input.firstLearning ? { firstLearning: true } : {}),
                ...(record?.disclosedAudience ? { disclosedAudience: record.disclosedAudience } : {})
              })
            )
          }
        }
      })
    } catch (error) {
      if (error instanceof MatrixHermesPreSubmissionError && !input.signal.aborted && this.usable) {
        throw error
      }

      // Interrupt ACK is not proof an active tool stopped. Reap only when one may still be
      // running (or the caller did not attach the effects tracker); a model-only or pre-submit
      // abort keeps the resident runtime and avoids a 14–21 s cold restart.
      if (!input.effects || input.effects.runtimeMayHaveActiveTool) {
        await this.close()
      }
      // The cause stays attached for the caller's closed-code log line (invocation.ts).
      throw new Error('matrix_hermes_outcome_unknown', { cause: error })
    } finally {
      if (submitted && lifecycleStart !== undefined && this.lifecycle) {
        await this.lifecycle.afterTurn(lifecycleStart).catch(() => {
          console.warn('[Matrix] assistant instructions were not written back')
        })
      }
      this.activeConversation = undefined
      this.busy = false
    }
  }

  close(): Promise<void> {
    this.lifetime.abort()
    this.sessions.clear()
    this.terminalSessions.clear()
    this.terminalUnsubscribe?.()
    this.terminalUnsubscribe = undefined

    return (this.stopping ??= (async () => {
      const connection = await this.opening?.catch(() => undefined)
      await connection?.close()
    })())
  }
}
