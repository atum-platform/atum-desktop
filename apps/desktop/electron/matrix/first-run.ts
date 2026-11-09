/**
 * The primary assistant's first-learning run.
 *
 * The renderer offers Google or a quiet skip. Either path enters here once. The platform's
 * per-assistant one-shot decides whether this Mac may create an internal local context turn or the
 * durable platform occurrence owns the run. Neither path creates or displays an owner message. The
 * assistant's first progressive message opens the run. Only the explicit read-only safety policy
 * is narrower than a normal funded turn.
 */
import type { DesktopLocale } from '../../shared/desktop-locale'
import type { MatrixSnapshot } from '../../shared/matrix'
import { matrixFirstLearningPrompt, matrixFirstLearningRequest } from '../../shared/matrix-first-learning'

import type { MatrixFirstLearningClaim } from './first-run-google'

/** Kept as a function for the local executor and focused policy tests. */
export { matrixFirstLearningToolAllowed as matrixFirstRunToolAllowed } from '../../shared/matrix-first-learning'

export function matrixFirstRunOpen(input: {
  identity: boolean
  primary: boolean
  marker: MatrixSnapshot['firstRunMarker']
  welcome: MatrixSnapshot['firstRunWelcome']
}): boolean {
  return input.identity && input.primary && input.marker === 'unseen' && input.welcome === 'open'
}

/** The first-learning state is account-wide; placement changes only where the ordinary turn runs. */
export function matrixFirstRunAvailable(input: {
  identity: boolean
  primary: boolean
  assistantPath: 'local' | 'server'
  cloudOnly: boolean
  marker: MatrixSnapshot['firstRunMarker']
  welcome: MatrixSnapshot['firstRunWelcome']
}): boolean {
  return matrixFirstRunOpen(input)
}

type Phase = 'idle' | 'working' | 'done'

export interface MatrixFirstRunDeps {
  room(preferred?: string): string | undefined
  /** Platform-unique claim: run hidden here, let its durable occurrence run, or it already ran. */
  claim(locale: DesktopLocale): Promise<MatrixFirstLearningClaim>
  /** Durable internal turn: its text/context reach Hermes, never the owner's Matrix timeline. */
  acceptHidden(roomId: string, text: string, context: string, profile: 'first_learning'): void
  answer(folders: 'allowed' | 'declined', welcome: 'done' | 'dismissed'): Promise<void>
  /** The folders the owner shared or kept closed (display paths), for the learning turn. */
  folders?(): { shared: string[]; skipped: string[] }
  changed(): void
  log(line: string): void
}

export class MatrixFirstRun {
  private phase: Phase = 'idle'
  private pending?: Promise<void>

  constructor(private readonly deps: MatrixFirstRunDeps) {}

  view(marker: MatrixSnapshot['firstRunMarker']): MatrixSnapshot['firstRun'] {
    if (marker !== 'unseen' || this.phase === 'done') {
      return undefined
    }

    return this.phase === 'working' ? 'working' : 'offer'
  }

  start(input: {
    roomId?: string
    locale: DesktopLocale
    ending: 'done' | 'dismissed'
  }): Promise<void> {
    if (this.phase === 'done') {
      return Promise.resolve()
    }

    if (this.pending) {
      return this.pending
    }

    this.phase = 'working'
    this.deps.changed()
    this.pending = this.run(input).finally(() => {
      this.pending = undefined
    })

    return this.pending
  }

  private async run(input: { roomId?: string; locale: DesktopLocale; ending: 'done' | 'dismissed' }): Promise<void> {
    const roomId = this.deps.room(input.roomId)

    if (!roomId) {
      this.phase = 'idle'
      this.deps.changed()
      throw new Error('matrix_first_learning_unavailable')
    }

    const claim = await this.deps.claim(input.locale)

    if (claim === 'unavailable') {
      this.phase = 'idle'
      this.deps.changed()
      throw new Error('matrix_first_learning_unavailable')
    }

    if (claim === 'run_here') {
      this.deps.acceptHidden(
        roomId,
        matrixFirstLearningRequest(input.locale),
        matrixFirstLearningPrompt(input.locale, this.folders()),
        'first_learning'
      )
      this.deps.log('[Matrix] first learning: durable hidden local turn accepted')
    } else {
      this.deps.log(`[Matrix] first learning: platform one-shot outcome=${claim}`)
    }

    // The hidden turn or platform occurrence owns the learning now. Closing the welcome cannot
    // create a duplicate: every later start sees the same platform tombstone/record.
    this.phase = 'done'
    this.deps.changed()

    try {
      await this.deps.answer('declined', input.ending)
    } catch {
      this.deps.log('[Matrix] first learning: welcome completion unavailable')
    }
  }

  private folders(): { shared: string[]; skipped: string[] } | undefined {
    try {
      return this.deps.folders?.()
    } catch {
      return undefined
    }
  }

  /** Compatibility for 0.20.19 renderers. */
  allow(input: { roomId?: string; locale: DesktopLocale }): Promise<void> {
    return this.start({ ...input, ending: 'done' })
  }

  /** Compatibility end state for an older first-run surface. */
  decline(): Promise<void> {
    return this.end('dismissed')
  }

  /** Compatibility end state for an older first-run surface. */
  finish(): Promise<void> {
    return this.end('done')
  }

  private async end(welcome: 'done' | 'dismissed'): Promise<void> {
    this.phase = 'done'
    this.deps.changed()
    await this.deps.answer('declined', welcome)
  }

  reset(): void {
    this.phase = 'idle'
    this.pending = undefined
  }
}
