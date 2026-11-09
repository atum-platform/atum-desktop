/**
 * The task approval window (owner decision 2026-10-20, overriding the G0 "reuse window 0" design).
 *
 * The owner's Touch ID covers a capability for one agent for the rest of the task — never one prompt per
 * command. The window is keyed by agent + capability, lasts at most 30 minutes from the approval, and is
 * cleared by every Stop fence (stop, sign-out, account switch, sleep). Simultaneous commands that need
 * the same capability share ONE pending prompt instead of each raising a sheet.
 *
 * It lives only in memory on this Mac. It is never sent on the wire, so no controller or model can
 * extend it; the approval that opens it is still the Secure Enclave signature (`approvals.ts`).
 */
import type { ApprovalAnswer } from './approvals'
import type { DeviceProtectedCapability } from './contracts'

export const APPROVAL_WINDOW_MS = 30 * 60_000

/**
 * After a sheet timed out with nobody there, the same agent asking for the same capability is told so
 * at once for this long, instead of raising a new 10-minute sheet for every retry while the owner is
 * away. A real approval, a Stop or the end of this period lets the next ask raise a sheet again.
 */
export const OWNER_AWAY_MS = 10 * 60_000

interface Entry {
  readonly expiresAt: number
  readonly approvalHash: string
}

export type WindowOutcome =
  | { readonly outcome: 'approved'; readonly approvalHash: string; readonly leader: boolean; readonly fromWindow: boolean }
  | {
      readonly outcome: 'denied'
      readonly reason: 'approval_denied' | 'approval_timeout' | 'unavailable'
      readonly leader: boolean
    }

function outcomeOf(result: ApprovalAnswer, leader: boolean): WindowOutcome {
  return result.outcome === 'approved'
    ? { outcome: 'approved', approvalHash: result.approvalHash, leader, fromWindow: false }
    : { outcome: 'denied', reason: result.reason, leader }
}

export class ApprovalWindow {
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, Promise<ApprovalAnswer>>()
  private readonly awayUntil = new Map<string, number>()
  private generation = 0

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly windowMs: number = APPROVAL_WINDOW_MS
  ) {}

  private static key(agent: string, capability: DeviceProtectedCapability): string {
    return `${agent}\0${capability}`
  }

  /** The approval hash that opened a still-live window for this agent and capability, or null. */
  covers(agent: string, capability: DeviceProtectedCapability): string | null {
    const key = ApprovalWindow.key(agent, capability)
    const entry = this.entries.get(key)

    if (!entry) {
      return null
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)

      return null
    }

    return entry.approvalHash
  }

  /** Whether a prompt for this agent and capability is already up (a second command joins it). */
  asking(agent: string, capability: DeviceProtectedCapability): boolean {
    return this.pending.has(ApprovalWindow.key(agent, capability))
  }

  /** Whether the last sheet for this agent and capability timed out unanswered, recently enough that
   * asking again now would only raise another sheet nobody is there to see. */
  away(agent: string, capability: DeviceProtectedCapability): boolean {
    const key = ApprovalWindow.key(agent, capability)
    const until = this.awayUntil.get(key)

    if (until === undefined) {
      return false
    }

    if (until <= this.now()) {
      this.awayUntil.delete(key)

      return false
    }

    return true
  }

  /**
   * Ask once for a capability. A live window answers without asking; a prompt already up is joined;
   * otherwise `ask` runs and an approval opens the window. `leader` is true for the one caller whose
   * `ask` actually ran, so a denial is counted once however many commands were waiting on it.
   */
  async obtain(
    agent: string,
    capability: DeviceProtectedCapability,
    ask: () => Promise<ApprovalAnswer>
  ): Promise<WindowOutcome> {
    const key = ApprovalWindow.key(agent, capability)
    const covered = this.covers(agent, capability)

    if (covered) {
      return { outcome: 'approved', approvalHash: covered, leader: false, fromWindow: true }
    }

    const joined = this.pending.get(key)

    if (joined) {
      return outcomeOf(await joined, false)
    }

    if (this.away(agent, capability)) {
      return { outcome: 'denied', reason: 'approval_timeout', leader: false }
    }

    const generation = this.generation

    const run = ask().then(result => {
      if (generation === this.generation) {
        if (result.outcome === 'approved') {
          this.awayUntil.delete(key)
          this.entries.set(key, { expiresAt: this.now() + this.windowMs, approvalHash: result.approvalHash })
        } else if (result.reason === 'approval_timeout') {
          this.awayUntil.set(key, this.now() + OWNER_AWAY_MS)
        }
      }

      return result
    })

    this.pending.set(key, run)

    try {
      return outcomeOf(await run, true)
    } finally {
      if (this.pending.get(key) === run) {
        this.pending.delete(key)
      }
    }
  }

  /** Forget every window and every prompt in flight (the Stop fence). */
  clear(): void {
    this.generation += 1
    this.entries.clear()
    this.pending.clear()
    this.awayUntil.clear()
  }
}
