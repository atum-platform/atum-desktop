import {
  MATRIX_FIRST_LEARNING_SOURCES,
  type MatrixFirstLearningSource,
  type MatrixFirstLearningSourceState
} from './matrix-first-learning'
import type { MatrixNoticeEdit } from './matrix-notice-edit'
import {
  MATRIX_PROGRESS_LIMITS,
  type MatrixProgressDecision,
  type MatrixProgressFrame,
  MatrixProgressKernel,
  type MatrixProgressTodoItem
} from './matrix-progress-kernel'
import { matrixProgressMarkerOf } from './matrix-progress-marker'

/**
 * The agent's one transient working line for a turn (`atum.agent-turns/1.4` §3, reliability program
 * §9.1): what it is doing (tool activity by category, the `todo` checklist) and any wait ("Waiting for
 * the MacBook…"), published as ONE `m.notice` in the owner's private chat and edited in place
 * (`m.replace`). When the turn ends the line is REMOVED (a redaction of its own event, Hermes's
 * `cleanup_progress`), never kept: a client also hides a line whose turn has ended before the
 * redaction lands. The agent's own words (`message.interim`) are not here: they are real messages
 * (`matrix-interim-messages.ts`). Throttling, the edit cap and bounded text are the kernel's; this
 * class is the Matrix-facing host: it serialises publication, holds the first edit until the root's
 * event id exists, and flushes held updates when the throttle opens.
 *
 * Presentation only. It never decides an outcome and never blocks the turn: a failed publication
 * is logged and the turn goes on. The caller supplies already-redacted text.
 */

export interface MatrixProgressLinePort {
  /** The real native account/host/admission/lease/cancellation fence, never a presentation fact. */
  current(): boolean
  /** Publish the original (no `replaces`), one edit, or the removal (`redact`); resolves the event id. */
  publish(command: MatrixNoticeEdit): Promise<string>
  now(): number
  /** One-shot timer; returns its cancellation. */
  after(milliseconds: number, run: () => void): () => void
  log?(line: string): void
}

export interface MatrixProgressLineOptions {
  /** Progress lines exist in the owner's private chat only; a group gets receipt and typing. */
  privateChat: boolean
  heartbeatText(elapsedMinutes: number): string
  /** The original's deterministic transaction for a generation (stable across ambiguous retries). */
  transactionFor?(generation: number): string
}

/** The words of the line above the step list; the list itself is bounded separately. */
export const MATRIX_PROGRESS_HEADER_MAX = 400
const TODO_ITEMS_MAX = 12
const TODO_ITEM_CHARS_MAX = 80
const HEARTBEAT_CHECK_MS = 30_000
const REDACT_RETRY_MS = 1_000
/** A line removed mid-turn (a wait that ended with nothing to return to) may come back this often. */
const MAX_GENERATIONS = 3

function clip(value: string, max: number): string {
  const chars = [...value.replace(/\s+/g, ' ').trim()]

  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`
}

/** The owner message the line replies to. A Mac-typed turn may not know its question's event id
 * until the question is synced: a function resolves it, and the first publication waits for it. */
export interface MatrixProgressTarget {
  roomId: string
  eventId: string | (() => Promise<string>)
}

export interface MatrixProgressWait {
  /** The Mac the agent is waiting for, by its owner-visible name. */
  device?: string
  /** `touch_id` for a Touch ID prompt; otherwise a device or person wait. */
  kind?: 'device' | 'touch_id'
}

/** One original and its edits. A removed line is replaced by a new one under the next generation. */
interface Line {
  generation: number
  root?: string
}

export class MatrixProgressLine {
  private kernel!: MatrixProgressKernel
  private line: Line = { generation: 0 }
  private question?: string
  private tail: Promise<void> = Promise.resolve()
  private header = ''
  private todos: readonly MatrixProgressTodoItem[] = []
  private waiting?: { text: string } & MatrixProgressWait
  private revision = -1
  private lastPublishedAt = Number.NEGATIVE_INFINITY
  private cancelFlush?: () => void
  private cancelHeartbeat?: () => void
  private ended = false
  private dead = false

  constructor(
    private readonly target: MatrixProgressTarget,
    private readonly port: MatrixProgressLinePort,
    private readonly options: MatrixProgressLineOptions
  ) {
    this.resetKernel()
  }

  /** What Hermes is doing now (a tool category's fixed words); the newest replaces the last. */
  activity(text: string): void {
    const header = clip(text, MATRIX_PROGRESS_HEADER_MAX)

    if (!header || header === this.header) {
      return
    }

    this.header = header
    this.offer()
  }

  /** Hermes's `todo` list changed (redacted); shown as checkmarks under the activity. */
  plan(todos: readonly MatrixProgressTodoItem[]): void {
    this.todos = todos.slice(0, TODO_ITEMS_MAX).map(item => ({
      text: clip(item.text, TODO_ITEM_CHARS_MAX),
      state: item.state
    }))

    this.offer()
  }

  /** A wait (a slow Mac step, an approval at this Mac) replaces the line's text until `endWait`. */
  wait(text: string, wait: MatrixProgressWait = {}): void {
    const shown = clip(text, MATRIX_PROGRESS_HEADER_MAX)

    if (!shown) {
      return
    }

    this.waiting = { text: shown, ...wait }
    this.offer()
  }

  /** The wait is over, however it ended: back to the activity, or gone if there is none. Never "waited". */
  endWait(): void {
    if (!this.waiting) {
      return
    }

    this.waiting = undefined
    this.offer()
  }

  /**
   * The turn has ended: drop everything queued, let a publication in flight finish, and REMOVE the
   * line (agent-turns/1.4 A7). Await before publishing the final answer, which is a new message.
   * Safe to call more than once, and when nothing was ever shown.
   */
  async end(): Promise<void> {
    if (this.ended) {
      await this.tail.catch(() => undefined)

      return
    }

    this.ended = true
    this.cancelTimers()
    this.remove(this.line)

    await this.tail.catch(() => undefined)
  }

  private offer(): void {
    if (this.ended || this.dead || !this.port.current()) {
      return
    }

    const waiting = this.waiting

    if (!waiting && !this.header && !this.todos.length) {
      // Nothing left to say: the line goes (it is not replaced by a "working" word).
      this.clear()

      return
    }

    this.handle(
      this.kernel.offer(
        waiting
          ? {
              kind: waiting.kind ?? 'device',
              phase: 'waiting',
              text: waiting.text,
              ...(waiting.device ? { device: waiting.device } : {})
            }
          : { kind: 'todo', text: this.header, ...(this.todos.length ? { todo: this.todos } : {}) },
        this.port.now()
      )
    )
  }

  /** Remove the line now and let a later update start a new one. */
  private clear(): void {
    if (this.revision < 0) {
      return
    }

    const old = this.line

    this.cancelTimers()
    this.line = { generation: old.generation + 1 }

    if (this.line.generation >= MAX_GENERATIONS) {
      this.dead = true
    }

    this.resetKernel()
    this.remove(old)
  }

  private resetKernel(): void {
    this.revision = -1
    this.lastPublishedAt = Number.NEGATIVE_INFINITY
    this.kernel = new MatrixProgressKernel({
      privateChat: this.options.privateChat,
      redact: text => text,
      heartbeatText: this.options.heartbeatText,
      settledFallback: ''
    })
  }

  private handle(decision: MatrixProgressDecision): void {
    if (decision.action === 'publish' || decision.action === 'edit') {
      this.enqueue(decision.frame)

      return
    }

    if (decision.action === 'hold') {
      this.scheduleFlush()
    }
  }

  private enqueue(frame: MatrixProgressFrame): void {
    const line = this.line

    this.revision = frame.revision
    this.lastPublishedAt = this.port.now()

    this.tail = this.tail
      .catch(() => undefined)
      .then(() => this.publish(frame, line))

    if (!this.cancelHeartbeat && !this.ended) {
      this.armHeartbeat()
    }
  }

  private async publish(frame: MatrixProgressFrame, line: Line): Promise<void> {
    if (this.dead || !this.port.current()) {
      return
    }

    const progress = matrixProgressMarkerOf(frame)

    try {
      // Held here, in order: no edit can overtake the original or its question.
      this.question ??= typeof this.target.eventId === 'string' ? this.target.eventId : await this.target.eventId()

      if (!this.port.current()) {
        return
      }

      const target = { roomId: this.target.roomId, eventId: this.question }

      if (!line.root) {
        const transactionId = this.options.transactionFor?.(line.generation)

        const id = await this.port.publish({
          ...target,
          body: frame.body,
          statusLine: true,
          progress,
          ...(transactionId ? { transactionId } : {})
        })

        if (typeof id !== 'string' || !id.startsWith('$')) {
          throw new Error('matrix_send_failed')
        }

        line.root = id

        return
      }

      await this.port.publish({
        ...target,
        body: frame.body,
        statusLine: true,
        progress,
        replaces: line.root,
        revision: frame.revision
      })
    } catch (error) {
      // The turn never waits on, or fails with, its progress line. A root that could not be
      // published leaves nothing to edit: the line stays off for this turn.
      if (!line.root) {
        this.dead = true
      }

      this.port.log?.(`[Matrix] progress line not published: ${error instanceof Error ? error.message : 'failed'}`)
    }
  }

  /** Queue the removal of `line` behind everything already queued for it. */
  private remove(line: Line): void {
    this.tail = this.tail
      .catch(() => undefined)
      .then(() => this.redact(line))
  }

  private async redact(line: Line): Promise<void> {
    if (!line.root || !this.question || !this.port.current()) {
      return
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.port.publish({
          roomId: this.target.roomId,
          eventId: this.question,
          body: '',
          redact: true,
          replaces: line.root
        })

        return
      } catch (error) {
        this.port.log?.(`[Matrix] progress line not removed: ${error instanceof Error ? error.message : 'failed'}`)

        if (attempt === 0) {
          await new Promise<void>(resolve => this.port.after(REDACT_RETRY_MS, resolve))
        }
      }
    }
  }

  private scheduleFlush(): void {
    if (this.cancelFlush || this.ended || this.revision >= MATRIX_PROGRESS_LIMITS.maxEdits - 1) {
      return
    }

    const wait = Math.max(0, MATRIX_PROGRESS_LIMITS.minEditMs - (this.port.now() - this.lastPublishedAt))

    this.cancelFlush = this.port.after(wait + 1, () => {
      this.cancelFlush = undefined

      if (!this.ended && !this.dead && this.port.current()) {
        this.handle(this.kernel.flush(this.port.now()))
      }
    })
  }

  private armHeartbeat(): void {
    this.cancelHeartbeat = this.port.after(HEARTBEAT_CHECK_MS, () => {
      this.cancelHeartbeat = undefined

      if (this.ended || this.dead) {
        return
      }

      if (this.port.current()) {
        const beat = this.kernel.heartbeat(this.port.now())

        if (beat.action === 'edit') {
          this.enqueue(beat.frame)
        }
      }

      this.armHeartbeat()
    })
  }

  private cancelTimers(): void {
    this.cancelFlush?.()
    this.cancelFlush = undefined
    this.cancelHeartbeat?.()
    this.cancelHeartbeat = undefined
  }
}

export type MatrixHermesProgressEvent =
  /** Hermes's own remark (`message.interim`, redacted): a real message, never the working line. */
  | { kind: 'narration'; text: string }
  | { kind: 'plan'; todos: MatrixProgressTodoItem[] }
  /** A tool started, by its Hermes name only (never arguments or results). */
  | { kind: 'tool'; name: string }
  /** First learning's source tile transition; contains no source data. */
  | {
      kind: 'learning'
      source: MatrixFirstLearningSource
      state: MatrixFirstLearningSourceState
    }

const TOOL_NAME = /^[A-Za-z0-9_.:/-]{1,64}$/
const LEARNING_SOURCES = new Set<string>(MATRIX_FIRST_LEARNING_SOURCES)
const LEARNING_STATES = new Set(['reading', 'done', 'skipped', 'unavailable'])

const TODO_STATE: Record<string, MatrixProgressTodoItem['state'] | undefined> = {
  completed: 'done',
  in_progress: 'active',
  pending: 'pending'
}

/**
 * What a Hermes gateway event adds to the progress line, or nothing. `message.interim` is read
 * only from `redacted_text` and the todo list only from `redacted_todos`: both are Hermes's own
 * redaction (tui_gateway/server.py), so an older Hermes that lacks them shows no progress rather
 * than unredacted words. A cancelled step is left out; tool arguments and results are never read
 * (`tool.start` is read for its name only).
 */
export function matrixHermesProgressEvent(type: string, payload: unknown): MatrixHermesProgressEvent | undefined {
  const body = payload as Record<string, unknown> | null | undefined

  if (type === 'message.interim') {
    return typeof body?.redacted_text === 'string' && body.redacted_text.trim()
      ? { kind: 'narration', text: body.redacted_text }
      : undefined
  }

  if (
    type === 'learning.progress' &&
    typeof body?.source === 'string' &&
    LEARNING_SOURCES.has(body.source) &&
    typeof body.state === 'string' &&
    LEARNING_STATES.has(body.state)
  ) {
    return {
      kind: 'learning',
      source: body.source as Extract<MatrixHermesProgressEvent, { kind: 'learning' }>['source'],
      state: body.state as Extract<MatrixHermesProgressEvent, { kind: 'learning' }>['state']
    }
  }

  if (type === 'tool.start' && typeof body?.name === 'string' && body.name !== 'todo' && TOOL_NAME.test(body.name)) {
    return { kind: 'tool', name: body.name }
  }

  if (type === 'tool.complete' && body?.name === 'todo' && Array.isArray(body.redacted_todos)) {
    const todos: MatrixProgressTodoItem[] = []

    for (const item of body.redacted_todos as unknown[]) {
      const entry = item as Record<string, unknown> | null
      const state = typeof entry?.status === 'string' ? TODO_STATE[entry.status] : undefined

      if (state && typeof entry?.content === 'string' && entry.content.trim()) {
        todos.push({ text: entry.content, state })
      }
    }

    return todos.length ? { kind: 'plan', todos } : undefined
  }

  return undefined
}
