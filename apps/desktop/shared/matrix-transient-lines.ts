import type { MatrixMessage } from './matrix'
import {
  MATRIX_COMPANY_PROGRESS_EXPIRY_MS,
  matrixCompanyTurnKey,
  type MatrixCompanyTurnMemory
} from './matrix-company-presentation'
import { matrixStatusLineCopy } from './matrix-status-line-copy'

/**
 * The client side of `atum.agent-turns/1.4` §3: a working line (the agent's `io.atum.progress`
 * notice) lives only while its turn works. A client hides it once the turn has ended, even before
 * the publisher's redaction lands, so a history of old turns never shows "Waiting for your Mac".
 * Pure and dependency-free: web, desktop and phone apply the same rule.
 */

/**
 * The redaction reason a publisher sets when it removes its own working line because the turn
 * ended (agent-turns/1.4 §3). The Hermes Matrix presentation plugin
 * (`plugins/platforms/matrix/presentation.py`, `Outbox.remove`) and this app's progress line
 * (`publish-result.ts`) both send it. A redaction keeps its own `reason` while the line's content
 * (and its `io.atum.progress` marker) is gone, so this is the one signal that survives a reload.
 */
export const MATRIX_TRANSIENT_REDACTION_REASON = 'Turn ended'

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
  | 'body'
  | 'decryptionFailed'
  | 'failed'
  | 'interim'
  | 'notice'
  | 'own'
  | 'pending'
  | 'progress'
  | 'redacted'
  | 'sender'
  | 'transientRemoved'
> &
  Partial<Pick<MatrixMessage, 'company' | 'id'>>

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

/** How a chat reads company lines (agent-turns/1.6): the session's turn memory and the clock for expiry. */
export interface MatrixCompanyLineRules {
  /** What this client has seen of company turns (`matrixCompanyTurnMemory`); read and extended. */
  memory?: MatrixCompanyTurnMemory
  /** Now, in ms: a company progress line older than `MATRIX_COMPANY_PROGRESS_EXPIRY_MS` is hidden. */
  now?: number
}

const companyLine = (message: Line) => message.company !== undefined && message.progress !== undefined

/** Each live company turn's newest accepted revision time, and the turns that have ended. */
function companyTurns(messages: readonly Line[], memory: MatrixCompanyTurnMemory | undefined) {
  const ended = memory?.ended ?? new Set<string>()
  const lines = memory?.lines ?? new Map<string, string>()
  const newest = new Map<string, number>()

  for (const message of messages) {
    const known = message.id ? lines.get(message.id) : undefined

    // A line this client drew, now redacted: its exact tuple has ended, for good.
    if (message.redacted) {
      if (known !== undefined) {
        ended.add(known)
      }

      continue
    }

    if (!companyLine(message)) {
      continue
    }

    const key = matrixCompanyTurnKey(message.company!)

    if (message.id) {
      lines.set(message.id, key)
    }

    if (message.progress!.phase === 'settled') {
      ended.add(key)
    }

    const at = message.company!.revisedAt

    if (at !== undefined) {
      newest.set(key, Math.max(newest.get(key) ?? at, at))
    }
  }

  return { ended, newest }
}

/**
 * When the next live company progress line expires (ms), so a chat re-renders exactly then; nothing
 * when none is live. A timer, not polling: the caller sets one timeout for this instant. Reads only:
 * `endedTurns` (the turn memory's ended tuples) is never extended here.
 */
export function matrixCompanyLineExpiresAt(
  messages: readonly Line[],
  now: number,
  endedTurns: ReadonlySet<string> = new Set()
): number | undefined {
  const { ended, newest } = companyTurns(messages, { ended: new Set(endedTurns), lines: new Map() })
  let next: number | undefined

  for (const [key, at] of newest) {
    const expires = at + MATRIX_COMPANY_PROGRESS_EXPIRY_MS + 1

    if (!ended.has(key) && expires > now && (next === undefined || expires < next)) {
      next = expires
    }
  }

  return next
}

/**
 * What a chat shows of `messages` (in timeline order), in one pass from the newest:
 * - an agent's redacted message shows nothing, not a "deleted" tombstone (the agent removes only its
 *   own working lines and a duplicated interim remark); nor does any working line its sender removed
 *   when the turn ended (`transientRemoved`), even from a sender this chat does not know as an agent;
 * - an agent's working line is hidden once the turn has ended: its marker says `settled`, or the same
 *   agent posted a later message that is neither a working line nor an interim remark (the answer,
 *   an outcome notice). A line that is still the newest thing the agent said stays.
 * - a company agent's working line (agent-turns/1.6) ends only by its exact turn identity (company,
 *   agent, audience, room, thread root, task, invocation): seen settled, or a line of it seen redacted.
 *   That terminal fact is kept (`rules.memory`), so redacting the settling edit later never brings the
 *   line back. A later message of the agent never ends it, so an answer to another task or thread never
 *   hides active work. Any settled line of an identity fences every line of that identity.
 * - a company progress line whose newest accepted revision is older than three quiet heartbeats
 *   (`rules.now`) is hidden: presentation expiry, which is not an end (nothing is recorded, and a newer
 *   revision shows the line again).
 */
export function matrixHideEndedTransientLines<T extends Line>(
  messages: readonly T[],
  agents: ReadonlySet<string>,
  rules: MatrixCompanyLineRules = {}
): T[] {
  const ended = new Set<string>()
  const turns = companyTurns(messages, rules.memory)
  const kept: T[] = []

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!

    if (message.redacted && message.transientRemoved && !message.own) {
      continue
    }

    if (message.own || !agents.has(message.sender)) {
      kept.push(message)

      continue
    }

    if (message.redacted) {
      continue
    }

    if (isMatrixTransientLine(message, agents)) {
      if (message.progress?.phase === 'settled') {
        continue
      }

      if (companyLine(message)) {
        const key = matrixCompanyTurnKey(message.company!)
        const at = turns.newest.get(key)

        if (
          turns.ended.has(key) ||
          (rules.now !== undefined && at !== undefined && rules.now - at > MATRIX_COMPANY_PROGRESS_EXPIRY_MS)
        ) {
          continue
        }
      } else if (ended.has(message.sender)) {
        continue
      }
    } else if (!message.interim && !message.pending && !message.failed && !message.decryptionFailed) {
      ended.add(message.sender)
    }

    kept.push(message)
  }

  return kept.reverse()
}
