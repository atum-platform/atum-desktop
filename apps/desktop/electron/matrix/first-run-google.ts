import type { DesktopLocale } from '../../shared/desktop-locale'

/** Legacy platform route name; the one-shot now owns the whole first-learning run. */
export interface FirstRunGoogleAuthority {
  request(
    action: 'admit' | 'cancel',
    locale: DesktopLocale
  ): Promise<{ state: 'created' | 'existing' | 'cancelled' | 'in_flight'; routineId?: string }>
}

export type MatrixFirstLearningClaim = 'run_here' | 'remote' | 'done' | 'unavailable'

interface ClaimInput {
  locale: DesktopLocale
  scope(): { accountKey: string; generation: number } | null | undefined
  authority(): FirstRunGoogleAuthority | undefined
  owner(): object | undefined
  eligible(): boolean
  /** True only while this Mac can run the primary assistant under its held local lease. */
  local(): boolean
}

/**
 * Native lifecycle fence around the platform's durable, per-assistant one-shot.
 *
 * A cloud/remote home keeps the new platform occurrence. Only the Mac that currently holds a
 * local assistant's answering lease cancels that fallback and runs an internal context turn.
 * Neither path creates an owner-authored Matrix event. A cancellation tombstone means another
 * device already owns or finished the handoff (`done`).
 */
export class MatrixFirstRunGoogleValue {
  private epoch = 0
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: { log(line: string): void }) {}

  claim(input: ClaimInput): Promise<MatrixFirstLearningClaim> {
    const scope = input.scope()
    const authority = input.authority()
    const owner = input.owner()
    const epoch = this.epoch

    if (!scope || !authority || !owner || !input.eligible()) {
      return Promise.resolve('unavailable')
    }

    const live = () =>
      epoch === this.epoch &&
      input.eligible() &&
      input.owner() === owner &&
      input.scope()?.accountKey === scope.accountKey &&
      input.scope()?.generation === scope.generation

    const work = this.pending.then(async (): Promise<MatrixFirstLearningClaim> => {
      if (!live()) {
        return 'unavailable'
      }

      try {
        const admitted = await authority.request('admit', input.locale)

        if (!live()) {
          await authority.request('cancel', input.locale)

          return 'unavailable'
        }

        if (admitted.state === 'cancelled') {
          return 'done'
        }

        if (admitted.state !== 'created' || !input.local()) {
          return 'remote'
        }

        const cancelled = await authority.request('cancel', input.locale)

        if (!live()) {
          return 'unavailable'
        }

        return cancelled.state === 'cancelled' ? 'run_here' : 'remote'
      } catch {
        this.deps.log('[Matrix] first-learning admission unavailable')

        return 'unavailable'
      }
    })

    this.pending = work

    return work
  }

  /** A cancellation tombstone also wins when an admission response was lost. No promise of unsend. */
  async cancel(authority?: FirstRunGoogleAuthority): Promise<boolean> {
    this.epoch += 1

    if (!authority) {
      return false
    }

    try {
      const result = await authority.request('cancel', 'en')

      return result.state === 'cancelled'
    } catch {
      this.deps.log('[Matrix] first-learning cancellation unconfirmed')

      return false
    }
  }
}
