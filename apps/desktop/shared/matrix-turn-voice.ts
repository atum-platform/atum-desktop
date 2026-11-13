import type { MatrixInterimMessages } from './matrix-interim-messages'
import type { MatrixHermesProgressEvent, MatrixProgressLine } from './matrix-progress-line'
import { type matrixProgressCopy, matrixToolActivity } from './matrix-status-line-copy'

/**
 * What the owner sees while one agent turn works (`atum.agent-turns/1.4`), shared by the cloud
 * controller, a Mac answering from the room and a Mac-typed turn so all three behave the same:
 * Hermes's remarks become real messages, the todo list and a started tool's category become one
 * transient working line, and when the turn ends the line is removed and any remark that repeats the
 * answer is taken back. Atum never speaks in the agent's place: a model that starts work without a
 * word gets typing and the working line, never a fixed opener. Presentation only.
 */
export class MatrixTurnVoice {
  constructor(
    readonly line: MatrixProgressLine,
    readonly interim: MatrixInterimMessages,
    private readonly locale: keyof typeof matrixProgressCopy
  ) {}

  /**
   * One Hermes event while the turn works (already redacted by Hermes, names only for tools).
   *
   * Boundary invariant: `MatrixHermesProgressEvent` values come only from `matrixHermesProgressEvent`,
   * which builds a `narration` from Hermes's `redacted_text` and never from the raw `text`. So only
   * redacted text reaches `interim.offer()`, which publishes it as a real chat message. Do not feed
   * this method an event built any other way.
   *
   * A tool or a todo list only moves the working line; it never publishes words of its own.
   */
  event(event: MatrixHermesProgressEvent): void {
    if (event.kind === 'narration') {
      this.interim.offer(event.text)

      return
    }

    // The first-run card consumes this structured event separately. It is data, not a chat line.
    if (event.kind === 'learning') {
      return
    }

    if (event.kind === 'plan') {
      this.line.plan(event.todos)
    } else {
      const activity = matrixToolActivity(this.locale, event.name)

      if (activity) {
        this.line.activity(activity)
      }
    }
  }

  /** The turn has ended. Await before publishing the answer, which is a new message. */
  async end(answer?: string): Promise<void> {
    await Promise.all([this.line.end(), this.interim.end(answer)])
  }
}
