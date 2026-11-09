import type { MatrixInterimMessages } from './matrix-interim-messages'
import type { MatrixHermesProgressEvent, MatrixProgressLine } from './matrix-progress-line'
import { matrixAcknowledgementCopy, type matrixProgressCopy, matrixToolActivity } from './matrix-status-line-copy'

export interface MatrixTurnVoiceOptions {
  /**
   * Say a short acknowledgement when the turn starts working before Hermes has said anything (default).
   * A rare native-scripted turn may turn it off. First learning deliberately leaves it on.
   */
  acknowledge?: boolean
}

/**
 * What the owner sees while one agent turn works (`atum.agent-turns/1.4`), shared by the cloud
 * controller, a Mac answering from the room and a Mac-typed turn so all three behave the same:
 * Hermes's remarks become real messages (the first is the acknowledgement), the todo list and a
 * started tool's category become one transient working line, and when the turn ends the line is
 * removed and any remark that repeats the answer is taken back. A model that starts work without
 * a word is acknowledged here instead (`event`), so the promise does not depend on the model
 * following the turn's style line (`matrix-turn-style.ts`). Presentation only.
 */
export class MatrixTurnVoice {
  private readonly acknowledges: boolean

  constructor(
    readonly line: MatrixProgressLine,
    readonly interim: MatrixInterimMessages,
    private readonly locale: keyof typeof matrixProgressCopy,
    options: MatrixTurnVoiceOptions = {}
  ) {
    this.acknowledges = options.acknowledge !== false
  }

  /**
   * One Hermes event while the turn works (already redacted by Hermes, names only for tools).
   *
   * Boundary invariant: `MatrixHermesProgressEvent` values come only from `matrixHermesProgressEvent`,
   * which builds a `narration` from Hermes's `redacted_text` and never from the raw `text`. So only
   * redacted text reaches `interim.offer()`, which publishes it as a real chat message. Do not feed
   * this method an event built any other way.
   *
   * Hermes says what it is about to do before it starts the tools of that step (`message.interim`
   * precedes `tool.start`), so a tool or a todo list arriving while no remark has been published
   * means the model went to work without a word: the acknowledgement goes out ahead of the working
   * line, once. A turn that answers without a tool never gets one.
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

    if (this.acknowledges) {
      this.interim.acknowledge(matrixAcknowledgementCopy[this.locale])
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
