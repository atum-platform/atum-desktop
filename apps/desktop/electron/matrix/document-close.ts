import { randomUUID } from 'node:crypto'

/** A single trusted UI acknowledges its existing document checkpoint before shutdown. */
export class MatrixDocumentClose {
  private pending: { id: string; resolve(ok: boolean): void; promise: Promise<void> } | null = null

  prepare(send: (id: string) => void, current: () => boolean, timeoutMs = 10_000): Promise<void> {
    if (this.pending) {return this.pending.promise}
    const id = randomUUID()
    let acknowledge!: (ok: boolean) => void
    const acknowledged = new Promise<boolean>(resolve => {acknowledge = resolve})
    const timer = setTimeout(() => acknowledge(false), timeoutMs)

    const promise = acknowledged.then(ok => {
      if (!ok || !current()) {throw new Error('MATRIX_DOCUMENT_CLOSE_REFUSED')}
    }).finally(() => {
      clearTimeout(timer)

      if (this.pending?.id === id) {this.pending = null}
    })

    this.pending = { id, resolve: acknowledge, promise }

    try {send(id)} catch {acknowledge(false)}

    return promise
  }

  acknowledge(id: unknown, ok: unknown): void {
    if (typeof id === 'string' && typeof ok === 'boolean' && this.pending?.id === id) {
      this.pending.resolve(ok)
    }
  }
}
