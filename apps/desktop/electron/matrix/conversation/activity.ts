import { ConversationUnavailableError } from '../../../shared/agent-conversation'
import type { MatrixConversationView } from '../../../shared/agent-conversation/view'

/** Serialize migration requests, reserving the turn barrier only for actual changes. */
export class ConversationRequestActivity {
  busy = false
  changing = false
  #settled: Promise<void> = Promise.resolve()

  constructor(private readonly ports: { hold(active: boolean): void; release(): Promise<void> }) {}

  async run<T>(mode: 'preview' | 'change', request: () => Promise<T>): Promise<T> {
    if (this.busy) {
      throw new Error('matrix_conversation_busy')
    }
    this.busy = true
    this.changing = mode === 'change'
    let settled!: () => void
    this.#settled = new Promise<void>(resolve => { settled = resolve })
    if (this.changing) {
      this.ports.hold(true)
    }
    try {
      return await request()
    } finally {
      try {
        if (this.changing) {
          await this.ports.release()
        }
      } finally {
        if (this.changing) {
          this.ports.hold(false)
        }
        this.changing = false
        this.busy = false
        settled()
      }
    }
  }

  /** Cloud's persistent writer hold forbids new changes before it drains this one. */
  settled(): Promise<void> {
    return this.changing ? this.#settled : Promise.resolve()
  }
}

/** A home export must not carry job origins from an unfinished conversation journal. */
export async function requireConversationSnapshot(
  activity: ConversationRequestActivity | undefined, pending: () => boolean
): Promise<void> {
  await activity?.settled()
  if (pending()) {
    throw new ConversationUnavailableError()
  }
}

/** Background reads do not acquire a change scope unless markers/jobs/home need work. */
export function conversationNeedsReconciliation(
  view: MatrixConversationView, homeRoom?: string, convergedMain?: string
): boolean {
  if (view.reason || view.jobs === null || (view.state !== 'legacy' && view.state !== 'marked')) {
    return false
  }
  if (!view.main) {
    // Marked rooms, none of them main (two Macs' moves crossed): the preview found the plain main
    // the markers name, and the reconcile restores it. Any other rooms with no main are picked
    // automatically: the owner's most recent conversation, with no prompt.
    if (view.earlier.length && view.replaceable === true) {
      return true
    }

    return view.candidates.length > 0
  }

  // 0.20: an encrypted main the preview found ready to move to a plain room.
  if (view.replaceable === true) {
    return true
  }
  return view.jobs > 0 || (homeRoom ? homeRoom !== view.main : convergedMain !== view.main) ||
    view.candidates.some(room => room !== view.main && !view.earlier.includes(room) && !view.skipped.includes(room))
}

/**
 * What main's minute pass does after its read-only preview: `resume` a move whose markers are
 * written but whose effects did not settle (it refuses every turn on this Mac until they do),
 * `reconcile` when markers, jobs or home need work, or nothing.
 */
export function conversationBackgroundAction(
  view: MatrixConversationView, homeRoom?: string, convergedMain?: string
): 'resume' | 'reconcile' | undefined {
  if (view.state === 'retry' && view.reason === 'effects_pending') {
    return 'resume'
  }

  return conversationNeedsReconciliation(view, homeRoom, convergedMain) ? 'reconcile' : undefined
}
