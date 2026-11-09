/**
 * Why this Mac keeps an agent's local writers off, for the placement model.
 *
 * The app already has one question every starter asks before it brings an agent up (`isMovingAgent` in `main.ts`:
 * the executor, the listener, the answering lease, local turns, scheduled jobs). The placement model answers it
 * with the same promise the move-to-the-cloud flow makes: while a hold is set, nothing here restarts the agent.
 *
 *   drain       a move away is under way: the turn in flight finishes, nothing new is admitted
 *   quiesce     a checkpoint or a restore holds the home's writers still for a moment
 *   model       the saved home-default model is pending or unavailable; turns wait and never fall back to paid Atum;
 *               persisted in the journal like a stand-down, so no restart can start the agent on a model nobody chose
 *   standDown   this Mac is not the home of a managed agent and must not run it; persisted in the journal so a
 *               restart leaves the agent stopped before the platform has been asked
 *
 * Holds are plain facts about this Mac and are lifted only by the step that set them (or by a restart, which
 * rebuilds them from the journal). They never touch the platform and never change what a legacy agent does.
 */
import type { AgentHomeJournal } from './journal'

export type HoldReason = 'drain' | 'quiesce' | 'model' | 'standDown'

export class AgentHomeHolds {
  private readonly held = new Map<string, Set<HoldReason>>()

  constructor(private readonly journal: AgentHomeJournal) {}

  /** Any hold at all: the agent must stay stopped here. */
  has(agent: string): boolean {
    return (this.held.get(agent)?.size ?? 0) > 0
  }

  reasons(agent: string): readonly HoldReason[] {
    return [...(this.held.get(agent) ?? [])]
  }

  /**
   * A drain or a checkpoint, and nothing else, holds the agent: the answering lease stays held and renewing,
   * because it is what signs the drain acknowledgement and the checkpoint. Nothing new is started or claimed.
   * A stood-down agent gives the lease up.
   */
  keepsLease(agent: string): boolean {
    const reasons = this.held.get(agent)

    return Boolean(reasons && reasons.size > 0 && !reasons.has('standDown'))
  }

  add(agent: string, reason: HoldReason): void {
    const reasons = this.held.get(agent) ?? new Set<HoldReason>()
    reasons.add(reason)
    this.held.set(agent, reasons)

    if (reason === 'standDown') {
      this.journal.update(agent, entry => {
        entry.standDown = true
      })
    } else if (reason === 'model' && !this.journal.read(agent).modelHold) {
      this.journal.update(agent, entry => {
        entry.modelHold = true
      })
    }
  }

  remove(agent: string, reason: HoldReason): void {
    const reasons = this.held.get(agent)

    if (!reasons) {
      return
    }

    reasons.delete(reason)

    if (reasons.size === 0) {
      this.held.delete(agent)
    }

    if (reason === 'standDown' && this.journal.read(agent).standDown) {
      this.journal.update(agent, entry => {
        delete entry.standDown
      })
    }

    if (reason === 'model' && this.journal.read(agent).modelHold) {
      this.journal.update(agent, entry => {
        delete entry.modelHold
      })
    }
  }

  /** Forget a hold that is not backed by a journal (an agent that is no longer on this Mac). */
  forget(agent: string): void {
    this.held.delete(agent)
  }

  /**
   * Rebuild the holds a restart must not lose: a stood-down agent stays stopped, an agent this Mac was draining for a
   * move stays quiet until the move's end is read from the platform (`finishSource` lifts it), and an agent held for
   * its saved model stays stopped until that model is applied here.
   */
  seed(agent: string): void {
    const entry = this.journal.read(agent)
    const reasons = new Set<HoldReason>()

    if (entry.standDown) {
      reasons.add('standDown')
    } else if (entry.move?.role === 'source') {
      reasons.add('drain')
    }

    if (entry.modelHold) {
      reasons.add('model')
    }

    if (reasons.size > 0) {
      this.held.set(agent, reasons)
    }
  }
}
