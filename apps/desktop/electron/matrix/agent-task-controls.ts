import { type AgentTaskEvent, agentTaskEventId } from '../../shared/agent-task'
import type { EncryptedStore } from '../encrypted-store'

const CONTROL_KEY = 'matrix-agent-task-controls-v1'
const MAX_STEER_RECEIPTS = 512
const MAX_RECEIPT_JSON_CHARS = 1_000_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

interface ControlReceipt {
  eventId: string
  taskId: string
  kind: 'stop' | 'steer'
  expiresAt: number
}

interface ActiveTask {
  abort: AbortController
  steer(text: string): Promise<boolean>
}

interface PendingSteer {
  eventId: string
  text: string
  expiresAt: number
}

/** Durable control-event dedupe plus the one live task for an agent runtime. */
export class MatrixAgentTaskControls {
  private readonly seen = new Map<string, ControlReceipt>()
  private readonly starts = new Set<string>()
  private readonly stopped = new Set<string>()
  private readonly steers = new Map<string, PendingSteer[]>()
  private readonly flushing = new Set<string>()
  private readonly flushAgain = new Set<string>()
  private active?: { taskId: string; task: ActiveTask }

  constructor(private readonly store: EncryptedStore) {
    try {
      const raw = store.getItem(CONTROL_KEY)
      if (raw === null || raw.length > MAX_RECEIPT_JSON_CHARS) {return}
      const values = JSON.parse(raw)
      const ids = new Set<string>()

      if (Array.isArray(values) && values.every(value =>
        value && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).every(key => ['eventId', 'taskId', 'kind', 'expiresAt'].includes(key)) &&
        Object.keys(value).length === 4 &&
        agentTaskEventId(value.eventId) && !ids.has(value.eventId) && ids.add(value.eventId) &&
        typeof value.taskId === 'string' && UUID.test(value.taskId) &&
        Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0 &&
        (value.kind === 'stop' || value.kind === 'steer'))) {
        for (const value of values as ControlReceipt[]) {
          if (value.expiresAt <= Date.now()) {continue}
          this.seen.set(value.eventId, value)
          if (value.kind === 'stop') {this.stopped.add(value.taskId)}
        }
        if (this.seen.size !== values.length) {this.persist()}
      }
    } catch {
      // A damaged optional receipt cache grants nothing; the task room is re-read.
    }
  }

  admitStart(eventId: string): boolean {
    // Only suppress in-flight hints: saved results must be recoverable later. The platform's
    // invocation state machine, not this transient set, prevents a second dispatch/charge.
    if (this.starts.has(eventId)) {return false}
    this.starts.add(eventId)

    return true
  }

  finishStart(eventId: string): void {
    this.starts.delete(eventId)
  }

  /** Stop is idempotent. Steer is recorded only after Hermes confirms it queued. */
  offer(event: AgentTaskEvent, expiresAt: number): void {
    const now = Date.now()
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {return}
    this.prune(now)
    if (this.seen.has(event.eventId)) {return}

    if (event.kind === 'stop') {
      if (this.stopped.has(event.taskId)) {return}
      this.stopped.add(event.taskId)
      this.remember({ eventId: event.eventId, taskId: event.taskId, kind: 'stop', expiresAt })

      if (this.active?.taskId === event.taskId) {this.active.task.abort.abort({ reason: 'stopped' })}
      return
    }

    if (event.kind !== 'steer') {return}
    const pending = this.steers.get(event.taskId) ?? []
    if (pending.some(item => item.eventId === event.eventId)) {
      this.requestFlush(event.taskId)
      return
    }
    pending.push({ eventId: event.eventId, text: event.body, expiresAt })
    this.steers.set(event.taskId, pending)
    this.requestFlush(event.taskId)
  }

  begin(taskId: string, task: ActiveTask): { stopped(): boolean; finish(): void } {
    this.prune(Date.now())
    if (this.active) {throw new Error('matrix_agent_task_busy')}
    this.active = { taskId, task }

    if (this.stopped.has(taskId)) {task.abort.abort({ reason: 'stopped' })}
    this.requestFlush(taskId)

    return {
      stopped: () => this.stopped.has(taskId),
      finish: () => {
        if (this.active?.task === task) {this.active = undefined}
        this.steers.delete(taskId)
      }
    }
  }

  /** Retry queued direction after the Hermes session for this task becomes steerable. */
  retry(taskId: string): void {
    this.requestFlush(taskId)
  }

  private requestFlush(taskId: string): void {
    if (this.flushing.has(taskId)) {
      this.flushAgain.add(taskId)
      return
    }
    this.flushing.add(taskId)
    void this.flush(taskId).finally(() => {
      this.flushing.delete(taskId)
      if (this.flushAgain.delete(taskId)) {this.requestFlush(taskId)}
    })
  }

  private async flush(taskId: string): Promise<void> {
    const active = this.active
    const pending = this.steers.get(taskId)

    if (!active || active.taskId !== taskId || !pending?.length || active.task.abort.signal.aborted) {return}

    while (pending.length && this.active === active && !active.task.abort.signal.aborted) {
      const next = pending[0]!
      if (next.expiresAt <= Date.now()) {
        pending.shift()
        continue
      }
      if (!(await active.task.steer(next.text))) {return}
      pending.shift()
      this.remember({ eventId: next.eventId, taskId, kind: 'steer', expiresAt: next.expiresAt })
    }

    if (!pending.length) {this.steers.delete(taskId)}
  }

  private remember(receipt: ControlReceipt): void {
    this.prune(Date.now(), false)
    this.seen.delete(receipt.eventId)
    this.seen.set(receipt.eventId, receipt)
    if (receipt.kind === 'stop') {this.stopped.add(receipt.taskId)}

    while ([...this.seen.values()].filter(value => value.kind === 'steer').length > MAX_STEER_RECEIPTS) {
      const oldestSteer = [...this.seen.values()].find(value => value.kind === 'steer')
      if (!oldestSteer) {break}
      this.seen.delete(oldestSteer.eventId)
    }

    this.persist()
  }

  private prune(now: number, save = true): void {
    let changed = false
    for (const [eventId, receipt] of this.seen) {
      if (receipt.expiresAt <= now) {
        this.seen.delete(eventId)
        changed = true
      }
    }
    this.stopped.clear()
    for (const receipt of this.seen.values()) {
      if (receipt.kind === 'stop') {this.stopped.add(receipt.taskId)}
    }
    for (const [taskId, pending] of this.steers) {
      const active = pending.filter(receipt => receipt.expiresAt > now)
      if (active.length === 0) {this.steers.delete(taskId)}
      else if (active.length !== pending.length) {this.steers.set(taskId, active)}
    }
    if (changed && save) {this.persist()}
  }

  private persist(): void {
    try {
      this.store.setItem(CONTROL_KEY, JSON.stringify([...this.seen.values()]))
    } catch {
      // Failure only loses a dedupe receipt; it never fabricates control authority.
    }
  }
}
