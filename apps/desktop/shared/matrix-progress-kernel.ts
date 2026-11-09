/**
 * Dependency-free agent-turns/1.3 progress kernel. Hosts own Matrix I/O, clocks,
 * locale and execution fences; this module only decides when and what may be shown.
 */
export const MATRIX_PROGRESS_LIMITS = {
  minEditMs: 3_000,
  heartbeatMs: 180_000,
  maxEdits: 48,
  bodyMaxChars: 1_000
} as const

export type MatrixProgressKind = 'interim' | 'todo' | 'heartbeat' | 'device' | 'touch_id' | 'settled'
export type MatrixProgressPhase = 'working' | 'waiting' | 'settled'

export interface MatrixProgressTodoItem {
  text: string
  state: 'pending' | 'active' | 'done'
}

export interface MatrixProgressUpdate {
  kind: Exclude<MatrixProgressKind, 'heartbeat' | 'settled'>
  text: string
  phase?: Exclude<MatrixProgressPhase, 'settled'>
  todo?: readonly MatrixProgressTodoItem[]
  device?: string
}

export interface MatrixProgressFrame {
  profile: 'atum.agent-turns/1.3'
  scope: 'owner_private'
  body: string
  kind: MatrixProgressKind
  phase: MatrixProgressPhase
  revision: number
  heartbeat?: true
  device?: string
}

export type MatrixProgressDecision =
  | { action: 'publish' | 'edit'; frame: MatrixProgressFrame }
  | { action: 'hold' | 'drop' }

export interface MatrixProgressKernelOptions {
  privateChat: boolean
  redact(text: string): string
  heartbeatText(elapsedMinutes: number): string
  settledFallback: string
}

function boundedText(value: string): string {
  const clean = value
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim()

  return [...clean].slice(0, MATRIX_PROGRESS_LIMITS.bodyMaxChars).join('')
}

function lastLine(value: string): string {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1) ?? ''
}

function render(update: MatrixProgressUpdate): string {
  const rows = [update.text]

  for (const item of update.todo ?? []) {
    rows.push(`${item.state === 'done' ? '✓' : '•'} ${item.text}`)
  }

  return rows.join('\n')
}

/**
 * One turn owns one kernel. A host publishes `publish`, edits the existing root for
 * `edit`, retries `hold` after its clock advances, and ignores `drop`.
 */
export class MatrixProgressKernel {
  private revision = -1
  private lastPublishedAt = Number.NEGATIVE_INFINITY
  private lastActivityAt = Number.NEGATIVE_INFINITY
  private lastBody = ''
  private pending?: { update: MatrixProgressUpdate; body: string }
  private ended = false

  constructor(private readonly options: MatrixProgressKernelOptions) {}

  offer(update: MatrixProgressUpdate, now: number): MatrixProgressDecision {
    if (this.ended || !this.options.privateChat || !Number.isFinite(now)) {
      return { action: 'drop' }
    }

    const body = boundedText(this.options.redact(render(update)))

    if (!body) {
      return { action: 'drop' }
    }

    if (this.revision < 0) {
      this.pending = undefined
      this.lastActivityAt = now

      return this.emit('publish', update, body, now)
    }

    if (body === this.lastBody) {
      this.pending = undefined
      return { action: 'drop' }
    }

    this.lastActivityAt = now
    this.pending = { update, body }

    // Reserve the final revision for settlement before the final answer.
    if (this.revision >= MATRIX_PROGRESS_LIMITS.maxEdits - 1) {
      return { action: 'hold' }
    }

    if (now - this.lastPublishedAt < MATRIX_PROGRESS_LIMITS.minEditMs) {
      return { action: 'hold' }
    }

    return this.flush(now)
  }

  flush(now: number): MatrixProgressDecision {
    if (
      this.ended ||
      !this.options.privateChat ||
      !this.pending ||
      this.revision >= MATRIX_PROGRESS_LIMITS.maxEdits - 1 ||
      now - this.lastPublishedAt < MATRIX_PROGRESS_LIMITS.minEditMs
    ) {
      return { action: this.pending && !this.ended ? 'hold' : 'drop' }
    }

    const { update, body } = this.pending
    this.pending = undefined

    return this.emit('edit', update, body, now)
  }

  heartbeat(now: number): MatrixProgressDecision {
    if (
      this.ended ||
      !this.options.privateChat ||
      this.revision < 0 ||
      this.revision >= MATRIX_PROGRESS_LIMITS.maxEdits - 1 ||
      now - this.lastActivityAt < MATRIX_PROGRESS_LIMITS.heartbeatMs
    ) {
      return { action: this.ended || !this.options.privateChat ? 'drop' : 'hold' }
    }

    const minutes = Math.max(1, Math.floor((now - this.lastActivityAt) / 60_000))
    const body = boundedText(this.options.redact(this.options.heartbeatText(minutes)))

    if (!body || body === this.lastBody) {
      return { action: 'hold' }
    }

    this.pending = undefined
    this.lastActivityAt = now

    return this.emit('edit', { kind: 'interim', text: body }, body, now, {
      kind: 'heartbeat',
      heartbeat: true
    })
  }

  /** Drain the newest held update into the collapsed last line, then reject every later edit. */
  settle(now: number, finalAnswer?: string): MatrixProgressDecision {
    if (this.ended || !this.options.privateChat) {
      return { action: 'drop' }
    }

    this.ended = true

    if (this.revision < 0 || this.revision >= MATRIX_PROGRESS_LIMITS.maxEdits) {
      this.pending = undefined

      return { action: 'drop' }
    }

    const newest = this.pending?.body ?? this.lastBody
    this.pending = undefined
    const answer = boundedText(finalAnswer ?? '')
    let body = boundedText(lastLine(newest))

    if (!body || body === answer) {
      body = boundedText(this.options.settledFallback)
    }

    if (!body || body === answer) {
      return { action: 'drop' }
    }

    this.revision++
    this.lastPublishedAt = now
    this.lastBody = body

    return {
      action: 'edit',
      frame: {
        profile: 'atum.agent-turns/1.3',
        scope: 'owner_private',
        body,
        kind: 'settled',
        phase: 'settled',
        revision: this.revision
      }
    }
  }

  private emit(
    action: 'publish' | 'edit',
    update: MatrixProgressUpdate,
    body: string,
    now: number,
    override: Partial<Pick<MatrixProgressFrame, 'kind' | 'heartbeat'>> = {}
  ): MatrixProgressDecision {
    this.revision++
    this.lastPublishedAt = now
    this.lastBody = body

    return {
      action,
      frame: {
        profile: 'atum.agent-turns/1.3',
        scope: 'owner_private',
        body,
        kind: override.kind ?? update.kind,
        phase: update.phase ?? 'working',
        revision: this.revision,
        ...(override.heartbeat ? { heartbeat: true } : {}),
        ...(update.device ? { device: [...boundedText(update.device)].slice(0, 80).join('') } : {})
      }
    }
  }
}
