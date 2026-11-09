import { randomUUID } from 'node:crypto'

import type {
  MatrixHermesTerminalEvent,
  MatrixTerminalChunk,
  MatrixTerminalData,
  MatrixTerminalReadRequest,
  MatrixTerminalTab,
  TerminalReadOptions,
  TerminalReadResult
} from '../../shared/matrix-terminal'

const BUFFER = 64_000
const MAX_TERMINALS = 8

interface Entry {
  scope: string
  processId: string
  tab: MatrixTerminalTab
  output: string
  sequence: number
  alive(): boolean
}

/** Read-only views of existing Hermes processes. Closing a view never stops a
 * process; native retains a bounded backlog for an explicit reopen. */
export class MatrixTerminals {
  private readonly entries = new Map<string, Entry>()
  private ordinal = 0
  private pending?: {
    scope: string
    request: MatrixTerminalReadRequest
    alive(): boolean
    finish(result: TerminalReadResult | null, notify?: boolean): void
  }

  constructor(
    private readonly changed: () => void,
    private readonly streamed: (value: MatrixTerminalChunk) => void
  ) {}

  receive(scope: string, event: MatrixHermesTerminalEvent, alive: () => boolean): void {
    this.prune()

    if (!scope || !alive() || !/^[\w-]{1,128}$/.test(event.processId)) {
      return
    }

    let entry = [...this.entries.values()].find(each => each.scope === scope && each.processId === event.processId)

    if (event.kind === 'close') {
      if (entry?.tab.open) {
        entry.tab.open = false
        this.changed()
      }

      return
    }

    if (typeof event.chunk !== 'string' || !event.chunk) {
      return
    }

    const created = !entry

    if (!entry) {
      if (this.entries.size >= MAX_TERMINALS) {
        const closed = [...this.entries.values()].find(each => !each.tab.open)

        if (!closed) {
          return
        }

        this.entries.delete(closed.tab.id)
      }

      entry = { scope, processId: event.processId, tab: { id: randomUUID(), ordinal: ++this.ordinal, open: false },
        output: '', sequence: 0, alive }
      this.entries.set(entry.tab.id, entry)
    }

    const chunk = event.chunk.slice(-BUFFER)
    entry.output = (entry.output + chunk).slice(-BUFFER)
    entry.sequence += 1

    if (created) { this.changed() }
    this.streamed({ id: entry.tab.id, scope, sequence: entry.sequence, chunk })
  }

  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (!entry.alive()) {
        this.entries.delete(id)
      }
    }
  }

  view(scope: string): MatrixTerminalTab[] {
    this.prune()

    return [...this.entries.values()].filter(entry => entry.scope === scope).map(entry => ({ ...entry.tab }))
  }

  private entry(scope: string, id: unknown): Entry {
    this.prune()
    const entry = typeof id === 'string' ? this.entries.get(id) : undefined

    if (!entry || !scope || entry.scope !== scope) {
      throw new Error('matrix_terminal_unavailable')
    }

    return entry
  }

  read(scope: string, id: unknown): MatrixTerminalData {
    const entry = this.entry(scope, id)

    return { id: entry.tab.id, scope, sequence: entry.sequence, output: entry.output }
  }

  open(scope: string, id: unknown): void {
    this.entry(scope, id).tab.open = true
    this.changed()
  }

  close(scope: string, id: unknown): void {
    this.entry(scope, id).tab.open = false
    this.changed()
  }

  /** Read the original foreground xterm, not another room's process output. */
  readPane(scope: string, options: TerminalReadOptions, alive: () => boolean, signal: AbortSignal): Promise<TerminalReadResult | null> {
    if (!scope || !alive() || signal.aborted || this.pending || !this.view(scope).some(tab => tab.open)) {
      return Promise.resolve(null)
    }

    return new Promise(resolve => {
      const abort = () => finish(null)
      const timer = setTimeout(abort, 2_000)

      const finish = (result: TerminalReadResult | null, notify = true) => {
        if (this.pending?.request.id !== id) {
          return
        }

        this.pending = undefined
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        resolve(result)

        if (notify) {
          this.changed()
        }
      }

      const id = randomUUID()
      this.pending = {
        scope, alive, finish,
        request: { id,
          ...(Number.isSafeInteger(options.start) ? { start: Math.max(0, Math.min(10_000, options.start!)) } : {}),
          ...(Number.isSafeInteger(options.count) ? { count: Math.max(1, Math.min(1_000, options.count!)) } : {}) }
      }
      signal.addEventListener('abort', abort, { once: true })
      this.changed()
    })
  }

  readRequest(scope: string): MatrixTerminalReadRequest | undefined {
    if (this.pending && (this.pending.scope !== scope || !this.pending.alive())) {
      this.pending.finish(null, false)
    }

    return this.pending ? { ...this.pending.request } : undefined
  }

  respond(scope: string, id: unknown, value: unknown): void {
    const pending = this.pending

    if (!pending || pending.scope !== scope || pending.request.id !== id || !pending.alive()) {
      throw new Error('matrix_terminal_unavailable')
    }

    if (value === null) {
      pending.finish(null)

      return
    }

    const result = value as TerminalReadResult | undefined
    const fields = ['total_lines', 'start', 'end', 'viewport_rows', 'cursor_row'] as const

    if (!result || fields.some(key => !Number.isSafeInteger(result[key]) || result[key] < 0 || result[key] > 10_000) ||
      typeof result.text !== 'string' || result.text.length > BUFFER || result.start > result.end ||
      result.end > result.total_lines || result.cursor_row >= result.total_lines ||
      result.end - result.start > (pending.request.count ?? 1_000) || result.viewport_rows < 1) {
      throw new Error('matrix_terminal_invalid')
    }

    pending.finish({ total_lines: result.total_lines, start: result.start, end: result.end,
      viewport_rows: result.viewport_rows, cursor_row: result.cursor_row, text: result.text })
  }
}
