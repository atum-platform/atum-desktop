import type { MatrixNoticeEdit } from './matrix-notice-edit'

export interface MatrixStatusLinePort {
  /** Real native account/host/admission/lease/cancellation fence, never a presentation fact. */
  current(): boolean
  publish(command: MatrixNoticeEdit): Promise<string>
}

/** One invocation's original status notice and ordered edits; no execution authority. */
export class MatrixStatusLine {
  private tail: Promise<void> = Promise.resolve()
  private root?: string
  private body?: string
  private revision = 0
  private pending?: MatrixNoticeEdit
  private ended = false

  constructor(
    private readonly target: { roomId: string; eventId: string },
    private readonly port: MatrixStatusLinePort
  ) {}

  update(body: string): Promise<void> {
    if (this.ended) {
      return Promise.resolve()
    }

    const next = this.tail
      .catch(() => undefined)
      .then(async () => {
        if (this.ended || !this.port.current()) {
          return
        }

        // An ambiguous failure retains exactly the same content/revision. Settle it
        // before allocating a later edit, so retries cannot turn into new notices.
        if (this.pending) {
          await this.publishPending()

          if (this.pending) {
            return
          }
        }

        if (this.ended || !this.port.current() || this.body === body) {
          return
        }

        this.pending = {
          ...this.target,
          body,
          statusLine: true,
          ...(this.root ? { replaces: this.root, revision: ++this.revision } : {})
        }
        await this.publishPending()
      })

    this.tail = next

    return next
  }

  /** Call and await before publishing the normal outcome; all later updates are ignored. */
  async end(): Promise<void> {
    this.ended = true
    await this.tail.catch(() => undefined)
    this.pending = undefined
  }

  private async publishPending(): Promise<void> {
    const command = this.pending!

    if (!this.port.current()) {
      return
    }

    const id = await this.port.publish(command)

    if (typeof id !== 'string' || !id.startsWith('$')) {
      throw new Error('matrix_send_failed')
    }

    this.root ??= id
    this.body = command.body
    this.pending = undefined
  }
}
