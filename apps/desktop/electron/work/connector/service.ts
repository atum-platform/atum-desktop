import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { type Answer, type Caller, type Result, validQuestion, type WorkQuestion } from './contract'

interface Receipt {
  request: WorkQuestion
  thread: string
  room: string
  agent: string
  transaction: string
  deadline: number
  event?: string
}
export interface ConnectorPorts {
  current(): boolean
  resolve(agent: string): Promise<{ room: string; agent: string } | undefined>
  send(receipt: Receipt): Promise<string>
  read(receipt: Receipt): Promise<Answer | undefined>
  /** Revalidate native session and route, then durably protect the transcript before returning true. */
  release(caller: Caller, protectedData: boolean): Promise<boolean>
}
export class ConnectorService {
  private readonly receipts: Map<string, Receipt>
  private readonly active = new Map<string, Promise<void>>()
  private readonly stop = new AbortController()
  constructor(
    private readonly file: string,
    private readonly ports: ConnectorPorts
  ) {
    try {
      this.receipts = new Map(JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }

      this.receipts = new Map()
    }
  }
  cancel(): void {
    this.stop.abort()
  }
  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    writeFileSync(`${this.file}.tmp`, JSON.stringify([...this.receipts]), { mode: 0o600 })
    renameSync(`${this.file}.tmp`, this.file)
  }
  async ask(caller: Caller, input: unknown, waitMs = 45_000): Promise<Result> {
    if (!validQuestion(input)) {
      throw new Error('invalid_work_question')
    }

    const q = input

    const result = (state: Result['state'], r?: Receipt): Result => ({
      state,
      request_id: q.request_id,
      ...(r?.event ? { question_event_id: r.event } : {})
    })

    const current = () => !this.stop.signal.aborted && this.ports.current()

    if (!current()) {
      return result('cancelled')
    }

    if (!(await this.ports.release(caller, false))) {
      return result('unavailable')
    }

    let r = this.receipts.get(q.request_id)

    if (
      r &&
      (r.thread !== caller.threadId ||
        r.request.agent !== q.agent ||
        (q.question !== undefined && r.request.question !== q.question))
    ) {
      throw new Error('work_request_conflict')
    }

    if (!r) {
      if (!q.question) {
        return result('unavailable')
      }

      // Reserve before the first await so concurrent invocations cannot send twice.
      const pending = this.active.get(q.request_id)

      if (pending) {
        await pending

        return this.ask(caller, q, waitMs)
      }

      let finish!: () => void
      this.active.set(
        q.request_id,
        new Promise<void>(resolve => {
          finish = resolve
        })
      )

      try {
        const target = await this.ports.resolve(q.agent)

        if (!current()) {
          return result('cancelled')
        }

        if (!target) {
          return result('unavailable')
        }

        r = {
          request: q,
          thread: caller.threadId,
          ...target,
          transaction: `work-${createHash('sha256').update(q.request_id).digest('hex')}`,
          deadline: Date.now() + 300_000
        }
        this.receipts.set(q.request_id, r)
        this.persist()

        // A lost acknowledgement is retried only with the same Matrix transaction ID.
        try {
          r.event = await this.ports.send(r)
          this.persist()
        } catch {
          return result('unavailable', r)
        }
      } finally {
        this.active.delete(q.request_id)
        finish()
      }
    }

    if (!current()) {
      return result('cancelled', r)
    }

    if (Date.now() >= r.deadline) {
      return result('timed_out', r)
    }

    if (!r.event) {
      const pending = this.active.get(q.request_id)

      if (pending) {
        await pending

        return this.ask(caller, q, waitMs)
      }

      try {
        r.event = await this.ports.send(r)
        this.persist()
      } catch {
        return result('unavailable', r)
      }
    }

    const until = Math.min(r.deadline, Date.now() + Math.max(0, Math.min(waitMs, 45_000)))

    do {
      let answer: Answer | undefined

      try {
        answer = await this.ports.read(r)
      } catch {
        /* Decryption and reconnect may recover on the next read. */
      }

      if (!current()) {
        return result('cancelled', r)
      }

      if (answer) {
        const allowed = await this.ports.release(caller, answer.dataClass !== 'non_google')

        if (!current()) {
          return result('cancelled', r)
        }

        if (!allowed) {
          return result(answer.dataClass === 'non_google' ? 'unavailable' : 'google_requires_atum', r)
        }

        return { ...result('answered', r), answer: answer.body, provenance: answer.dataClass }
      }

      if (Date.now() >= until) {
        break
      }

      try {
        await delay(Math.min(1000, until - Date.now()), undefined, { signal: this.stop.signal })
      } catch {
        return result('cancelled', r)
      }
    } while (current())

    return result(Date.now() >= r.deadline ? 'timed_out' : 'waiting', r)
  }
}
