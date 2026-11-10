import { MATRIX_INTERIM_BODY_MAX } from './matrix-interim-marker'
import type { MatrixNoticeEdit } from './matrix-notice-edit'
import type { MatrixProgressTarget } from './matrix-progress-line'

/**
 * The agent's interim remarks as REAL messages (`atum.agent-turns/1.4` §1, Hermes
 * `display.interim_assistant_messages`): the first remark of a turn is the acknowledgement ("Để mình
 * xem video này rồi tóm tắt nhé."), later ones say something to the person at most once per
 * `MATRIX_INTERIM_MIN_GAP_MS`. Redacted text only (Hermes projects native `text` at the JSON-RPC boundary;
 * the caller also accepts legacy `redacted_text`), private chat only, never a repeat of the answer, never the answer. A turn
 * that starts work without a remark is acknowledged with one fixed line instead (`acknowledge`).
 *
 * Presentation only. A failed publication is logged and the turn goes on.
 */

export const MATRIX_INTERIM_MIN_GAP_MS = 20_000

export type MatrixInterimDecision = 'publish' | 'hold' | 'drop'

export interface MatrixInterimInput {
  private: boolean
  /** The text came from Hermes's own redaction. */
  redacted: boolean
  /** No interim message has been published for this turn yet. */
  first: boolean
  sinceLastMs: number
  /** The remark repeats, or is contained in, the answer. */
  duplicatesAnswer: boolean
}

/** The pack's `interim_vectors` policy (spec/agent-turns/v1.4). */
export function matrixInterimDecision(input: MatrixInterimInput): MatrixInterimDecision {
  if (!input.private || !input.redacted || input.duplicatesAnswer) {
    return 'drop'
  }

  if (input.first) {
    return 'publish'
  }

  return input.sinceLastMs >= MATRIX_INTERIM_MIN_GAP_MS ? 'publish' : 'hold'
}

export interface MatrixInterimPort {
  /** The real native account/host/admission/lease/cancellation fence, never a presentation fact. */
  current(): boolean
  /** Publish one remark (`interim`) or remove one (`redact`); resolves the event id. */
  publish(command: MatrixNoticeEdit): Promise<string>
  now(): number
  /** One-shot timer; returns its cancellation. */
  after(milliseconds: number, run: () => void): () => void
  log?(line: string): void
}

export interface MatrixInterimOptions {
  /** Interim remarks exist in the owner's private chat only. */
  privateChat: boolean
  /** The remark's deterministic transaction (stable across ambiguous retries). */
  transactionFor(sequence: number): string
}

/** Runs of space and blank lines go; line breaks stay (a remark may have two sentences). */
function clipLines(value: string, max: number): string {
  const text = value
    .split('\n')
    .map(line => line.replace(/[ \t\r]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')

  const chars = [...text]

  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

function words(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim()
}

/** A remark that only restates the answer: the same words, or contained in them (a real sentence). */
export function matrixRepeatsAnswer(remark: string, answer: string | undefined): boolean {
  const shown = words(remark)
  const given = words(answer ?? '')

  return given !== '' && shown !== '' && (shown === given || (shown.length >= 12 && given.includes(shown)))
}

export class MatrixInterimMessages {
  private question?: string
  private tail: Promise<void> = Promise.resolve()
  private sequence = 0
  private lastPublishedAt = Number.NEGATIVE_INFINITY
  private lastText = ''
  private held?: string
  private cancelHold?: () => void
  private readonly published: Array<{ id: string; text: string }> = []
  private ended = false

  constructor(
    private readonly target: MatrixProgressTarget,
    private readonly port: MatrixInterimPort,
    private readonly options: MatrixInterimOptions
  ) {}

  /** Hermes remarked on what it is doing (`message.interim`, already redacted). */
  offer(text: string): void {
    if (this.ended || !this.port.current()) {
      return
    }

    const remark = clipLines(text, MATRIX_INTERIM_BODY_MAX)

    if (!remark || remark === this.lastText || remark === this.held) {
      return
    }

    const now = this.port.now()

    const decision = matrixInterimDecision({
      private: this.options.privateChat,
      redacted: true,
      first: this.sequence === 0,
      sinceLastMs: now - this.lastPublishedAt,
      duplicatesAnswer: false
    })

    if (decision === 'publish') {
      this.held = undefined
      this.cancelHold?.()
      this.cancelHold = undefined
      this.send(remark, now)

      return
    }

    if (decision === 'hold') {
      // The newest held remark goes out when the gap opens; an older one is not worth saying late.
      this.held = remark

      if (!this.cancelHold) {
        const wait = Math.max(0, MATRIX_INTERIM_MIN_GAP_MS - (now - this.lastPublishedAt))

        this.cancelHold = this.port.after(wait + 1, () => {
          this.cancelHold = undefined

          const next = this.held
          this.held = undefined

          if (next && !this.ended && this.port.current()) {
            this.send(next, this.port.now())
          }
        })
      }
    }
  }

  /**
   * The turn started working before Hermes said anything (a tool began and no remark has gone out):
   * the owner is told so, once, with one of `lines` as the turn's first remark (the acknowledgement
   * the product promises). Never once a remark has been published (a model that spoke is not
   * repeated), never outside the private chat, never after the turn has ended. It is an ordinary
   * remark in every other respect: the same message, transaction and removal at the end.
   */
  acknowledge(lines: readonly string[]): void {
    if (this.ended || this.sequence > 0 || !lines.length || !this.port.current()) {
      return
    }

    // The same policy as any first remark; the words are fixed copy, so nothing here came from Hermes unredacted.
    const decision = matrixInterimDecision({
      private: this.options.privateChat,
      redacted: true,
      first: true,
      sinceLastMs: Number.POSITIVE_INFINITY,
      duplicatesAnswer: false
    })

    if (decision !== 'publish') {
      return
    }

    // The turn's own first transaction picks the wording, so a retried publication says the same thing.
    const seed = Number.parseInt(this.options.transactionFor(0).slice(-8), 16)
    const remark = clipLines(lines[Number.isSafeInteger(seed) ? seed % lines.length : 0]!, MATRIX_INTERIM_BODY_MAX)

    if (remark) {
      this.send(remark, this.port.now())
    }
  }

  /**
   * The turn has ended: a held remark is dropped, one still being published finishes, and a remark
   * that turns out to repeat the answer is removed. Await before publishing the answer.
   */
  async end(answer?: string): Promise<void> {
    if (!this.ended) {
      this.ended = true
      this.cancelHold?.()
      this.cancelHold = undefined
      this.held = undefined
    }

    await this.tail.catch(() => undefined)

    const question = this.question

    if (!question || !this.port.current()) {
      return
    }

    for (const remark of this.published.splice(0)) {
      if (!matrixRepeatsAnswer(remark.text, answer)) {
        continue
      }

      try {
        await this.port.publish({ roomId: this.target.roomId, eventId: question, body: '', redact: true, replaces: remark.id })
      } catch (error) {
        this.port.log?.(`[Matrix] interim message not removed: ${error instanceof Error ? error.message : 'failed'}`)
      }
    }
  }

  private send(remark: string, now: number): void {
    const sequence = this.sequence++

    this.lastPublishedAt = now
    this.lastText = remark

    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        if (!this.port.current()) {
          return
        }

        try {
          // Held here, in order: the remark is a message of its own, but its transaction names the question.
          this.question ??= typeof this.target.eventId === 'string' ? this.target.eventId : await this.target.eventId()

          if (!this.port.current()) {
            return
          }

          const id = await this.port.publish({
            roomId: this.target.roomId,
            eventId: this.question,
            body: remark,
            interim: true,
            transactionId: this.options.transactionFor(sequence)
          })

          if (typeof id !== 'string' || !id.startsWith('$')) {
            throw new Error('matrix_send_failed')
          }

          this.published.push({ id, text: remark })
        } catch (error) {
          this.port.log?.(`[Matrix] interim message not published: ${error instanceof Error ? error.message : 'failed'}`)
        }
      })
  }
}
