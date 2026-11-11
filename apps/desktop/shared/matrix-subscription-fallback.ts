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

interface FoldLine {
  id: string
  sender: string
  own: boolean
  replyTo?: string
  subscriptionFallback?: MatrixSubscriptionFallback
  /** Set on the answer a fallback notice names. */
  answeredByFallback?: MatrixSubscriptionFallback
}

/**
 * What a transcript shows of fallback notices: none as rows of their own. Each one marks the answer
 * it replies to (same sender, already in view), which draws the line; a notice whose answer is not
 * in view shows nothing. Order is kept.
 */
export function matrixFoldSubscriptionFallbacks<T extends FoldLine>(messages: readonly T[]): T[] {
  const notices = new Map<string, MatrixSubscriptionFallback>()

  for (const message of messages) {
    if (!message.own && message.subscriptionFallback && message.replyTo) {
      notices.set(`${message.sender}\n${message.replyTo}`, message.subscriptionFallback)
    }
  }

  if (!notices.size) {
    return [...messages]
  }

  return messages.flatMap(message => {
    if (!message.own && message.subscriptionFallback) {
      return []
    }

    const fallback = message.own ? undefined : notices.get(`${message.sender}\n${message.id}`)

    return [fallback ? { ...message, answeredByFallback: fallback } : message]
  })
}
