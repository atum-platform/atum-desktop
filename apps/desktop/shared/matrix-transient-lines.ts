import type { MatrixMessage } from './matrix'
import { matrixCompanyTurnKey } from './matrix-company-presentation'
import { matrixStatusLineCopy } from './matrix-status-line-copy'

/**
 * The client side of `atum.agent-turns/1.4` §3: a working line (the agent's `io.atum.progress`
 * notice) lives only while its turn works. A client hides it once the turn has ended, even before
 * the publisher's redaction lands, so a history of old turns never shows "Waiting for your Mac".
 * Pure and dependency-free: web, desktop and phone apply the same rule.
 */

/** The fixed "waiting/waited for your Mac" status lines older builds posted as ordinary notices
 * (no marker). They are working text, so they are transient too. */
const RETIRED_WAIT_LINES: readonly string[] = [
  'Waiting for your Mac.', 'Đang chờ máy Mac của bạn.', 'Macを待っています。', '正在等待你的 Mac。',
  'Waited for your Mac.', 'Đã chờ máy Mac của bạn.', 'Macを待ちました。', '已等待你的 Mac。'
]

const RETIRED = new Set<string>([
  ...RETIRED_WAIT_LINES,
  ...Object.values(matrixStatusLineCopy).flatMap(copy => [copy.waiting, copy.waited])
])

type Line = Pick<
  MatrixMessage,
  'body' | 'decryptionFailed' | 'failed' | 'interim' | 'notice' | 'own' | 'pending' | 'progress' | 'redacted' | 'sender'
> &
  Partial<Pick<MatrixMessage, 'company'>>

/** A progress line, or one of the retired fixed wait lines, sent by an agent. */
export function isMatrixTransientLine(message: Line, agents: ReadonlySet<string>): boolean {
  if (message.own || !agents.has(message.sender) || !message.notice || message.redacted) {
    return false
  }

  return message.progress !== undefined || RETIRED.has(message.body.trim())
}

/**
 * The one working line a chat shows under the typing bubble right now, from what
 * `matrixHideEndedTransientLines` kept: the newest agent line that still lives (of `sender`, when
 * given). A line whose turn ended is already gone, so this is only what the turn is doing at this
 * moment (or the fixed "waiting" line a legacy build posted). One pass; nothing is filtered again.
 */
export function matrixLiveWorkingLine<T extends Line>(
  kept: readonly T[],
  agents: ReadonlySet<string>,
  sender?: string
): T | undefined {
  for (let index = kept.length - 1; index >= 0; index--) {
    const message = kept[index]!

    if (isMatrixTransientLine(message, agents) && (!sender || message.sender === sender)) {
      return message
    }
  }

  return undefined
}

/** `matrixLiveWorkingLine` of the raw timeline (it hides ended lines first). */
export function matrixWorkingLine<T extends Line>(
  messages: readonly T[],
  agents: ReadonlySet<string>,
  sender?: string
): T | undefined {
  return matrixLiveWorkingLine(matrixHideEndedTransientLines(messages, agents), agents, sender)
}

/**
 * What a chat shows of `messages` (in timeline order), in one pass from the newest:
 * - an agent's redacted message shows nothing, not a "deleted" tombstone (the agent removes only its
 *   own working lines and a duplicated interim remark);
 * - an agent's working line is hidden once the turn has ended: its marker says `settled`, or the same
 *   agent posted a later message that is neither a working line nor an interim remark (the answer,
 *   an outcome notice). A line that is still the newest thing the agent said stays.
 * - a company agent's working line (agent-turns/1.6) ends only by its exact turn identity (company,
 *   agent, audience, room, thread root, task, invocation): settled (a fence the projection already
 *   keeps irreversible), or redacted by its publisher. A later message of the agent never ends it,
 *   so an answer to another task or thread never hides active work. Any settled line of an identity
 *   fences every line of that identity.
 */
export function matrixHideEndedTransientLines<T extends Line>(messages: readonly T[], agents: ReadonlySet<string>): T[] {
  const ended = new Set<string>()
  const fenced = new Set<string>()
  const keyed = new Map<T, string>()

  for (const message of messages) {
    if (message.company && message.progress && !message.redacted) {
      const key = matrixCompanyTurnKey(message.company)

      keyed.set(message, key)

      if (message.progress.phase === 'settled') {
        fenced.add(key)
      }
    }
  }

  const kept: T[] = []

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!

    if (message.own || !agents.has(message.sender)) {
      kept.push(message)

      continue
    }

    if (message.redacted) {
      continue
    }

    if (isMatrixTransientLine(message, agents)) {
      const key = keyed.get(message)

      if (message.progress?.phase === 'settled' || (key !== undefined ? fenced.has(key) : ended.has(message.sender))) {
        continue
      }
    } else if (!message.interim && !message.pending && !message.failed && !message.decryptionFailed) {
      ended.add(message.sender)
    }

    kept.push(message)
  }

  return kept.reverse()
}
