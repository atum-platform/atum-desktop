import type { AppBotDescriptor } from '../../../shared/app-catalog'
import { type GroupMentionRecipient, groupTypedMentions } from '../../../shared/room-participation/mentions'

export const APP_BOT_GROUP_TEXT_LIMIT = 4_000

export interface AppBotQuote {
  v: 1
  event_id: string
}

export interface AppBotGroupRecipient {
  appId: string
  userId: string
  displayName: string
  handle: string
}

/** A recipient choice from an older build must not keep a group composer
 * locked after official bots stop being selectable app modes. */
export function clearStoredAppBotRecipient(value: string, botAppIds: readonly string[]): string {
  return botAppIds.includes(value) ? '' : value
}

/** Official bots are addressed exactly like people in a room: by a typed
 * `@Name` / `@handle`, or by replying to one of their messages.  Ambiguous
 * display names grant no authority; a unique handle still works. */
export function addressedAppBotRecipients<T extends AppBotGroupRecipient>(
  body: string,
  replySender: string | undefined,
  recipients: readonly T[],
  roomRecipients: readonly GroupMentionRecipient[] = []
): T[] {
  const mentioned = new Set(
    groupTypedMentions(
      body,
      [
        ...recipients.flatMap(recipient => [
          { userId: recipient.userId, name: recipient.displayName },
          { userId: recipient.userId, name: recipient.handle.replace(/^@/, '') }
        ]),
        ...roomRecipients
      ]
    )
  )

  if (replySender && recipients.some(recipient => recipient.userId === replySender)) {
    mentioned.add(replySender)
  }

  return recipients.filter(recipient => mentioned.has(recipient.userId))
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) {
        return true
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

export function appBotGroupMessageError(input: { body: string; attachment: boolean; edited: boolean; decryptable: boolean }): 'message_too_long' | 'unsupported_content' | 'cannot_read' | null {
  if (input.attachment) {
    return 'unsupported_content'
  }
  if (!input.decryptable || input.edited || hasUnpairedSurrogate(input.body)) {
    return 'cannot_read'
  }
  return input.body.length > APP_BOT_GROUP_TEXT_LIMIT ? 'message_too_long' : null
}

/** An explicit quote is selected from the actual, readable Matrix source event. */
export function isEligibleAppBotQuote(input: {
  body: string
  attachment: boolean
  edited: boolean
  decryptable: boolean
  redacted: boolean
}): boolean {
  return !input.redacted && !appBotGroupMessageError(input) && input.body.trim().length > 0
}

/** A quote is valid only when it is visibly the standard rich-reply target. */
export function appBotGroupContent(
  body: string,
  bot: Pick<AppBotDescriptor, 'user_id'>,
  replyTo?: string,
  quote?: string
): Record<string, unknown> {
  if (appBotGroupMessageError({ body, attachment: false, edited: false, decryptable: true })) {
    throw new Error('app_bot_message_too_long')
  }
  if (!body.trim()) {
    throw new Error('app_bot_message_empty')
  }
  if (quote && quote !== replyTo) {
    throw new Error('app_bot_quote_invalid')
  }

  return {
    msgtype: 'm.text', body,
    'm.mentions': { user_ids: [bot.user_id] },
    ...(replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyTo } } } : {}),
    ...(quote ? { 'io.atum.app_bot.quote': { v: 1, event_id: quote } satisfies AppBotQuote } : {})
  }
}
