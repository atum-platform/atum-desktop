/**
 * The first evaluation of an account's welcome (the conversational first run). The welcome and its
 * inline connector card belong to a new account, never to one that already talks to its assistant, and
 * "no folder answer yet" is not a sign of a new account: every cloud-first account that signed up
 * before the welcome existed has none. So the first time this app sees an account with no welcome
 * record, it asks `matrixFirstRunEligibility` (shared with the tests: a folder answer, or dialogue
 * with the primary, means the account already exists) and writes the verdict once, into the
 * account's own data (`io.atum.onboarding.first_run.v2`, src/matrix/first-run-onboarding.ts):
 * `open` for a new account, so every device agrees whether the greeting may open,
 * `done` for one that is not, so the welcome never appears above its history.
 *
 * Nothing is written while the verdict is unknown (offline, not synced, no primary yet, a chat whose
 * loaded history cannot say), and a record that is already there, from any device, stands. A failed
 * write is tried again after a pause; the evaluation is free for every account whose record exists.
 */
import type { MatrixIdentity, MatrixSnapshot } from '../../shared/matrix'
import { matrixFirstRunEligibility } from '../../shared/matrix-first-run-eligibility'

/** How long a failed write waits before the next snapshot may try it again. */
const RETRY_MS = 30_000

export interface MatrixFirstRunWelcomeDeps {
  /** Writes the record through the account's own SDK; it never replaces one already there. */
  write(identity: MatrixIdentity, state: 'open' | 'done'): Promise<void>
  log(line: string): void
  now?(): number
}

export class MatrixFirstRunWelcome {
  private inFlight?: string
  private failed?: { key: string; retryAt: number }

  constructor(private readonly deps: MatrixFirstRunWelcomeDeps) {}

  /** Asked with every published snapshot; does nothing unless this account has no welcome record yet. */
  observe(snapshot: MatrixSnapshot): void {
    const identity = snapshot.identity

    if (!identity || snapshot.firstRunWelcome !== 'unseen') {
      return
    }

    const key = `${identity.userId}\n${identity.deviceId}`
    const now = this.deps.now?.() ?? Date.now()

    if (this.inFlight === key || (this.failed?.key === key && now < this.failed.retryAt)) {
      return
    }

    const verdict = matrixFirstRunEligibility(snapshot)

    if (verdict === 'unknown') {
      return
    }

    this.inFlight = key
    const state = verdict === 'new' ? 'open' : 'done'

    void this.deps
      .write(identity, state)
      .then(() => {
        this.failed = undefined
        this.deps.log(
          `[Matrix] first run: the welcome is ${state === 'open' ? 'open for a new account' : 'not offered: the account already exists'}`
        )
      })
      .catch(() => {
        this.failed = { key, retryAt: (this.deps.now?.() ?? Date.now()) + RETRY_MS }
        this.deps.log('[Matrix] first run: the welcome could not be evaluated yet; trying again shortly')
      })
      .finally(() => {
        if (this.inFlight === key) {
          this.inFlight = undefined
        }
      })
  }

  /** Signed out or another account: nothing carries over. */
  reset(): void {
    this.inFlight = undefined
    this.failed = undefined
  }
}
