import type { MatrixProgressLine } from './matrix-progress-line'
import type { MatrixStatusLine } from './matrix-status-line'

/** Wrap the real prompt/typing adapter after admission. Publishing never delays
 * an approval/secret/question or changes its answer. A wait posts the line; when the last
 * overlapping wait ends, typing resumes and the line says the wait is over (no working word, and
 * no stale "waiting" above the answer).
 * With `transient` (the owner's private chat, agent-turns/1.4) the wait is shown in the turn's one
 * working line instead, and simply goes when the last wait ends: no separate status line, and nothing
 * saying it waited.
 * The native host must close/await the line before any normal outcome publication.
 */
export function matrixStatusAsk<Args extends unknown[], Answer>(
  ask: (...args: Args) => Promise<Answer>,
  line: MatrixStatusLine | undefined,
  copy: { waiting: string; waited: string },
  log: (line: string) => void,
  transient?: MatrixProgressLine
): (...args: Args) => Promise<Answer> {
  if (!line && !transient) {
    return ask
  }

  let waits = 0

  const update = (body: string) => {
    void line?.update(body).catch(() => log('[matrix-status] publication_failed'))
  }

  return async (...args) => {
    waits++

    if (transient) {
      transient.wait(copy.waiting, { kind: 'device' })
    } else {
      update(copy.waiting)
    }

    try {
      return await ask(...args)
    } finally {
      if (--waits === 0) {
        if (transient) {
          transient.endWait()
        } else {
          update(copy.waited)
        }
      }
    }
  }
}
