/**
 * The standing fallback line of `atum.agent-turns/1.7`: when a plan (ChatGPT through the owner's
 * Mac, or OpenCode Go) could not answer a cloud turn, the agent posts one `m.notice` with an empty
 * body that replies to the answer and carries `io.atum.presentation`
 * `{ version: 1, code: "subscription_fallback", args: { plan, reason, servedBy } }`.
 *
 * The descriptor carries no authored text and no price, and a client never shows one: the reader's
 * own words say only that the answer came from a fallback. Strict, dependency-free, and read only
 * from the agent's own notice; it confers no authority.
 */

export const MATRIX_PRESENTATION_KEY = 'io.atum.presentation'

export type MatrixSubscriptionFallbackPlan = 'chatgpt' | 'opencode_go'

export type MatrixSubscriptionFallbackReason =
  | 'offline'
  | 'refused'
  | 'rate_limited'
  | 'timeout'
  | 'grant_invalid'
  | 'unattended'

export interface MatrixSubscriptionFallback {
  plan: MatrixSubscriptionFallbackPlan
  reason: MatrixSubscriptionFallbackReason
  /** The model alias that answered instead. Display correlation only. */
  servedBy: string
}

const PLANS = new Set<string>(['chatgpt', 'opencode_go'])
const REASONS = new Set<string>(['offline', 'refused', 'rate_limited', 'timeout', 'grant_invalid', 'unattended'])
const SERVED_BY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u
const EVENT_ID = /^\$[^\s]{1,254}$/u

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)

  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

/** The descriptor of a fallback notice, or undefined for anything else. */
export function matrixSubscriptionFallback(content: unknown): MatrixSubscriptionFallback | undefined {
  if (!record(content) || content.msgtype !== 'm.notice' || content.body !== '') {
    return undefined
  }

  const relation = content['m.relates_to']
  const reply = record(relation) ? relation['m.in_reply_to'] : undefined

  if (!record(reply) || typeof reply.event_id !== 'string' || !EVENT_ID.test(reply.event_id)) {
    return undefined
  }

  const descriptor = content[MATRIX_PRESENTATION_KEY]

  if (!record(descriptor) || !exactKeys(descriptor, ['version', 'code', 'args'])) {
    return undefined
  }

  const args = descriptor.args

  if (
    descriptor.version !== 1 ||
    descriptor.code !== 'subscription_fallback' ||
    !record(args) ||
    !exactKeys(args, ['plan', 'reason', 'servedBy']) ||
    typeof args.plan !== 'string' ||
    !PLANS.has(args.plan) ||
    typeof args.reason !== 'string' ||
    !REASONS.has(args.reason) ||
    typeof args.servedBy !== 'string' ||
    !SERVED_BY.test(args.servedBy)
  ) {
    return undefined
  }

  return {
    plan: args.plan as MatrixSubscriptionFallbackPlan,
    reason: args.reason as MatrixSubscriptionFallbackReason,
    servedBy: args.servedBy
  }
}

/**
 * The once-per-conversation Google switch line (S2, owner 2026-11-14): when Google content enters a
 * conversation, the agent moves it to the approved Atum model and posts one `m.notice` carrying
 * `io.atum.presentation` `{ version: 1, code: "google_route_switched", args: { servedBy } }`.
 * The body is the host's own line for older clients; this client draws its own quiet words instead.
 */
export interface MatrixGoogleRouteSwitch {
  /** The model alias that answers from now on. Display only. */
  servedBy: string
}

/** The descriptor of a Google switch notice, or undefined for anything else. */
export function matrixGoogleRouteSwitch(content: unknown): MatrixGoogleRouteSwitch | undefined {
  if (!record(content) || content.msgtype !== 'm.notice' || typeof content.body !== 'string') {
    return undefined
  }

  const descriptor = content[MATRIX_PRESENTATION_KEY]

  if (!record(descriptor) || !exactKeys(descriptor, ['version', 'code', 'args'])) {
    return undefined
  }

  const args = descriptor.args

  if (
    descriptor.version !== 1 ||
    descriptor.code !== 'google_route_switched' ||
    !record(args) ||
    !exactKeys(args, ['servedBy']) ||
    typeof args.servedBy !== 'string' ||
    !SERVED_BY.test(args.servedBy)
  ) {
    return undefined
  }

  return { servedBy: args.servedBy }
}

interface FoldLine {
  id: string
  sender: string
  own: boolean
  replyTo?: string
  subscriptionFallback?: MatrixSubscriptionFallback
  /** Set on the answer a fallback notice names. */
  answeredByFallback?: MatrixSubscriptionFallback
  googleSwitch?: MatrixGoogleRouteSwitch
}

/**
 * What a transcript shows of the agent's presentation notices. A fallback notice is never a row of
 * its own: each one marks the answer it replies to (same sender, already in view), which draws the
 * line; a notice whose answer is not in view shows nothing. A Google switch line shows once: the
 * first in view stays, any later one is dropped. With `agents`, a switch line from anyone else is
 * not one (it stays an ordinary message). Order is kept.
 */
export function matrixFoldSubscriptionFallbacks<T extends FoldLine>(
  messages: readonly T[],
  agents?: ReadonlySet<string>
): T[] {
  const notices = new Map<string, MatrixSubscriptionFallback>()

  for (const message of messages) {
    if (!message.own && message.subscriptionFallback && message.replyTo) {
      notices.set(`${message.sender}\n${message.replyTo}`, message.subscriptionFallback)
    }
  }

  const switches = messages.some(message => message.googleSwitch)

  if (!notices.size && !switches) {
    return [...messages]
  }

  let switchShown = false

  return messages.flatMap(message => {
    if (!message.own && message.subscriptionFallback) {
      return []
    }

    if (message.googleSwitch) {
      if (message.own || (agents && !agents.has(message.sender))) {
        const { googleSwitch: _ignored, ...plain } = message

        return [plain as T]
      }

      if (switchShown) {
        return []
      }

      switchShown = true

      return [message]
    }

    const fallback = message.own ? undefined : notices.get(`${message.sender}\n${message.id}`)

    return [fallback ? { ...message, answeredByFallback: fallback } : message]
  })
}

/**
 * The fallback that answered the agent's latest reply, for the composer's chip: undefined once a
 * later reply came from the chosen plan. Reads the raw transcript (the notice follows its answer)
 * or a folded one (the answer carries `answeredByFallback`). Working lines and switch lines are not
 * replies and are skipped.
 */
export function matrixLatestAnswerFallback(
  messages: readonly (FoldLine & { progress?: unknown; transientRemoved?: unknown; redacted?: unknown })[],
  agent: string | undefined
): MatrixSubscriptionFallback | undefined {
  if (!agent) {
    return undefined
  }

  // Scanning back from the end, a notice is seen before the answer it replies to.
  const notices = new Map<string, MatrixSubscriptionFallback>()

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!

    if (message.own || message.sender !== agent) {
      continue
    }

    if (message.subscriptionFallback) {
      if (message.replyTo && !notices.has(message.replyTo)) {
        notices.set(message.replyTo, message.subscriptionFallback)
      }

      continue
    }

    if (message.googleSwitch || message.progress || message.transientRemoved || message.redacted) {
      continue
    }

    return message.answeredByFallback ?? notices.get(message.id)
  }

  return undefined
}
