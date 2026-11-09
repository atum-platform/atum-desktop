/**
 * What other people see an assistant called .
 * The platform record holds the name the owner chose; the assistant's own Matrix profile is
 * what everyone else's client shows. Each Mac that holds an assistant's Matrix session brings
 * the profile to the record once the record has been quiet for a while, so a rename and its
 * Undo never reach anyone's chats. Comparing first makes it idempotent: a Mac that was off
 * during a rename catches up on its next roster sync, and a name already shown is never sent.
 */

import { checkAssistantName } from '../../shared/matrix-assistant-name'

/** What the primary is published as when its record holds a name the rules refuse. */
const PRIMARY_FALLBACK_NAME = 'Atum'

/** One assistant whose Matrix session this Mac holds. */
export interface MatrixAssistantNameEntry {
  principal: string
  /** The record's name (what the owner chose). */
  wanted: string
  /** The session's current display name, once known. */
  shown?: string
}

/** What main knows about one assistant runtime on this Mac and the Matrix session it holds. */
export interface MatrixAssistantNameCandidate {
  closed?: boolean
  /** The owner's primary assistant (its name may be locked: owner decision D1). */
  primary: boolean
  principal?: string
  /** The record's name. */
  name?: string
  /** The assistant's Matrix account. */
  userId?: string
  /** The session this Mac holds for it, if any. */
  host?: { ready: boolean; profile?: { userId: string; displayName?: string } }
}

/**
 * Which assistants this Mac brings the public name of: open, with a record name, whose
 * session here is ready and is the assistant's own account (never the person's), and whose
 * name may change at all (`nameLocked`, owner decision D1, for the primary).
 *
 * The record's name is checked again before it is published: other writers (the Shell's
 * naming route, an older client, an operator) may have stored a name these rules refuse.
 * Such a name is never published; the primary shows "Atum" instead, and any other assistant
 * keeps the public name it has.
 */
export function matrixAssistantNameEntries(
  candidates: readonly MatrixAssistantNameCandidate[],
  nameLocked: (candidate: { isDefault: boolean }) => boolean
): MatrixAssistantNameEntry[] {
  return candidates.flatMap(each => {
    const host = each.host

    if (
      each.closed ||
      nameLocked({ isDefault: each.primary }) ||
      !each.principal ||
      !each.name ||
      !each.userId ||
      !host?.ready ||
      !host.profile ||
      host.profile.userId !== each.userId
    ) {
      return []
    }

    const checked = checkAssistantName(each.name, { primary: each.primary, principal: each.principal, others: [] })
    const wanted = checked.ok ? checked.name : each.primary ? PRIMARY_FALLBACK_NAME : undefined

    if (!wanted) {
      return []
    }

    return [{ principal: each.principal, wanted, shown: host.profile.displayName }]
  })
}

interface Pending {
  wanted: string
  /** When the record first said `wanted` (or when a failed attempt may be retried). */
  since: number
  applying?: boolean
  /** Sent and confirmed: nothing more until the record changes again. */
  applied?: boolean
}

export interface MatrixAssistantNameSyncOptions {
  apply(principal: string, name: string): Promise<void>
  /** The record must hold still this long before the public name follows (default 10 s). */
  quietMs?: number
  /** After a failed attempt, the next one waits this long (default 60 s). */
  retryMs?: number
  now?(): number
  setTimer?(run: () => void, ms: number): unknown
  clearTimer?(timer: unknown): void
  log?(line: string): void
}

export const MATRIX_ASSISTANT_NAME_QUIET_MS = 10_000

export class MatrixAssistantNameSync {
  private readonly pending = new Map<string, Pending>()
  private timer?: unknown

  constructor(private readonly options: MatrixAssistantNameSyncOptions) {}

  private now() {
    return this.options.now?.() ?? Date.now()
  }

  private get quiet() {
    return this.options.quietMs ?? MATRIX_ASSISTANT_NAME_QUIET_MS
  }

  /** The full set of assistants this Mac holds now; anyone left out is forgotten. */
  observe(entries: readonly MatrixAssistantNameEntry[]): void {
    const seen = new Set<string>()

    for (const entry of entries) {
      const wanted = entry.wanted.trim()
      seen.add(entry.principal)

      if (!wanted || entry.shown === undefined || entry.shown === wanted) {
        // Unknown yet, or already shown: nothing to send. An attempt in flight finishes.
        if (!this.pending.get(entry.principal)?.applying) {
          this.pending.delete(entry.principal)
        }

        continue
      }

      const current = this.pending.get(entry.principal)

      if (!current || current.wanted !== wanted) {
        this.pending.set(entry.principal, { wanted, since: this.now() })
      }
    }

    for (const principal of [...this.pending.keys()]) {
      if (!seen.has(principal)) {
        this.pending.delete(principal)
      }
    }

    this.schedule()
  }

  /** Stops every timer (sign-out, quit). */
  stop(): void {
    this.pending.clear()

    if (this.timer !== undefined) {
      ;(this.options.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>)
      this.timer = undefined
    }
  }

  private schedule() {
    if (this.timer !== undefined) {
      ;(this.options.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>)
      this.timer = undefined
    }

    const due = [...this.pending.values()]
      .filter(each => !each.applying && !each.applied)
      .map(each => each.since + this.quiet)

    if (!due.length) {
      return
    }

    const wait = Math.max(0, Math.min(...due) - this.now())

    this.timer = (this.options.setTimer ?? ((run, ms) => setTimeout(run, ms)))(() => {
      this.timer = undefined
      this.flush()
    }, wait)
  }

  /** Sends every name whose record has been quiet long enough. */
  flush(): void {
    const now = this.now()

    for (const [principal, each] of this.pending) {
      if (each.applying || each.applied || now < each.since + this.quiet) {
        continue
      }

      each.applying = true
      const wanted = each.wanted

      void this.options.apply(principal, wanted).then(
        () => {
          const current = this.pending.get(principal)

          if (current === each) {
            each.applying = false
            each.applied = true
          }
        },
        error => {
          const current = this.pending.get(principal)
          this.options.log?.(`[Matrix] assistant ${principal.slice(0, 8)} public name not updated yet: ${String(error)}`)

          if (current === each) {
            each.applying = false
            each.since = this.now() + (this.options.retryMs ?? 60_000) - this.quiet
          }

          this.schedule()
        }
      )
    }

    this.schedule()
  }
}
