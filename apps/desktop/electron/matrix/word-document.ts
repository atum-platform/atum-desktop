import { randomUUID } from 'node:crypto'

import type { WordCompanionCapture, WordDocumentRequest, WordDocumentRequestRef } from '../../shared/word-companion'
import { WordCompanionController, type WordCompanionDependencies } from '../word-companion'

export type MatrixWordRequest = (
  ref: WordDocumentRequestRef,
  resolve: () => Promise<WordDocumentRequest>,
  signal: AbortSignal
) => Promise<WordCompanionCapture>

/** A room's explicit Word link. Reuses the native Word controller's window,
 * stale-content and write-once protections; no renderer paths or tool edits. */
export class MatrixWordDocument {
  private readonly id = randomUUID()
  private readonly controller: WordCompanionController
  private disposed = false
  private pending?: { ref: WordDocumentRequestRef; resolve: () => Promise<WordDocumentRequest>; signal: AbortSignal }

  constructor(private readonly owner: string, deps: Omit<WordCompanionDependencies, 'resolveRequest'>) {
    this.controller = new WordCompanionController({
      ...deps,
      authority: () => {
        this.assertLive()
        this.pending?.signal.throwIfAborted()

        return deps.authority()
      },
      resolveRequest: async ref => {
        const pending = this.pending

        if (!pending || JSON.stringify(pending.ref) !== JSON.stringify(ref)) {
          throw new Error('WORD_TURN_UNAVAILABLE')
        }

        pending.signal.throwIfAborted()
        const request = await pending.resolve()
        pending.signal.throwIfAborted()
        this.assertLive()

        return request
      }
    })
  }

  async open(path: string): Promise<void> {
    await this.controller.open(this.owner, path, this.id)
    this.assertLive()
    // Content ownership outlives the explicitly requested window arrangement.
    await this.controller.bind(this.owner, { requestId: this.id, path })
    this.assertLive()
  }

  private assertLive() {
    if (this.disposed) {throw new Error('WORD_DOCUMENT_UNAVAILABLE')}
  }

  async capture(): Promise<WordCompanionCapture> {
    this.assertLive()

    return this.controller.capture(this.owner, this.id)
  }

  async show(): Promise<void> {
    this.assertLive()
    await this.controller.showBeside(this.owner, this.id)
  }

  hide(): Promise<void> {
    return this.controller.clearArrangement()
  }

  refresh(): Promise<void> {
    return this.controller.refresh()
  }

  async execute(ref: WordDocumentRequestRef, resolve: () => Promise<WordDocumentRequest>, signal: AbortSignal) {
    this.assertLive()
    signal.throwIfAborted()

    if (this.pending) {throw new Error('WORD_TURN_UNAVAILABLE')}
    const pending = { ref, resolve, signal }
    this.pending = pending

    try {
      return await this.controller.execute(this.owner, this.id, ref)
    } finally {
      if (this.pending === pending) {this.pending = undefined}
    }
  }

  dispose(): Promise<void> {
    // Invalidate synchronously; late Apple Event replies never revive custody.
    this.disposed = true

    return this.controller.clear()
  }
}
