import type { AppBotDescriptor, AppDescriptor } from './app-catalog'
import { appChatCopy } from './matrix-app-chat-copy'

/**
 * Why an official bot's chat could not open, or a message to it could not go, by what the
 * person can do about it (atum-app-bots v1 §2.6 and §7.1 `state`). Main refuses with one of
 * these closed codes; the window says the matching sentence with the bot's name instead of
 * "that didn't work" whenever the reason is known.
 */
export const APP_BOT_FAILURES = {
  /** Provisioning, no published device yet, or an acceptance not yet open to this person. */
  matrix_app_bot_starting: 'starting',
  /** The operator paused the bot. */
  matrix_app_bot_paused: 'paused',
  /** The bot's host lease is stale or its session is reconciling (`unavailable`). */
  matrix_app_bot_resting: 'resting',
  /** The catalog's device could not be pinned here (§2.6): this Mac fails closed. */
  matrix_app_bot_untrusted: 'untrusted',
  /** The app or the bot's device changed while the chat was opening: a retry uses the new one. */
  matrix_app_bot_changed: 'changed',
  /** The chat's room was made (or named) but this device's sync has not brought it yet: a retry
   * opens that same room (src/matrix/app-bot-room-wait.ts). */
  matrix_app_bot_syncing: 'syncing',
  /** Anything else that keeps the bot from this person now (no bot, app unavailable, not set up). */
  matrix_app_bot_unavailable: 'unavailable'
} as const

export type AppBotFailureCode = keyof typeof APP_BOT_FAILURES
export type AppBotFailure = (typeof APP_BOT_FAILURES)[AppBotFailureCode]

/** What keeps this bot's chat from opening now, from its catalog state; null when it can. */
export function appBotOpenRefusal(bot: AppBotDescriptor): AppBotFailureCode | null {
  if (bot.state === 'paused') {
    return 'matrix_app_bot_paused'
  }

  if (bot.state === 'unavailable') {
    return 'matrix_app_bot_resting'
  }

  return bot.state === 'active' && bot.device ? null : 'matrix_app_bot_starting'
}

/** What keeps a turn for this bot (a message, a group, an invitation) from going now. Turns
 * also need the person's consent and an authority: a linked account, or a fresh guest status.
 * A group needs a bot that joins it, so a guest turn is never a group grant. */
export function appBotTurnRefusal(
  app: AppDescriptor,
  group = false,
  guestReady = false
): AppBotFailureCode | null {
  const bot = app.bot

  if (!bot) {
    return 'matrix_app_bot_unavailable'
  }

  const openRefusal = appBotOpenRefusal(bot)

  if (openRefusal || bot.consent !== 'accepted') {
    return openRefusal ?? 'matrix_app_bot_unavailable'
  }

  if (app.link.state === 'linked') {
    return group && !bot.groups ? 'matrix_app_bot_unavailable' : null
  }

  return !group && bot.guest_enabled && bot.direct_profile === 'atum.turn-memory/2' && guestReady
    ? null
    : 'matrix_app_bot_unavailable'
}

/** The closed code inside a refusal as it crosses IPC (`Error invoking remote method …: Error:
 * matrix_app_bot_paused`), or null when the refusal is not about an official bot. */
export function appBotFailure(cause: unknown): AppBotFailure | null {
  const text = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  const code = /\bmatrix_app_bot_[a-z_]+/.exec(text)?.[0]

  return code && Object.hasOwn(APP_BOT_FAILURES, code) ? APP_BOT_FAILURES[code as AppBotFailureCode] : null
}

/** The sentence for an official bot's failure in the window's language. `app` is the bot's
 * display name; without one the sentence names "this app". */
export function appBotFailureCopy(failure: AppBotFailure, locale: string, app?: string): string {
  const copy = appChatCopy(locale)
  const name = app?.trim() || copy.botFallbackName

  return {
    starting: copy.botFailedStarting,
    paused: copy.botFailedPaused,
    resting: copy.botFailedResting,
    untrusted: copy.botUntrusted,
    changed: copy.botFailedChanged,
    syncing: copy.botFailedSyncing,
    unavailable: copy.botFailedUnavailable
  }[failure](name)
}
