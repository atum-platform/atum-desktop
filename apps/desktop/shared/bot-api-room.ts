import type { AppDescriptor } from './app-catalog'
import type { MatrixBotApiMessage, MatrixMessage, MatrixRoom } from './matrix'

export interface BotApiRoomContext {
  room: Pick<MatrixRoom, 'direct' | 'membership' | 'participants'>
  ownUserId: string | undefined
}

/** The exact joined one-to-one room for this owner and this catalog bot. */
export function isDirectAppBotRoom(
  app: AppDescriptor | undefined,
  context: BotApiRoomContext | undefined
): boolean {
  const bot = app?.bot

  if (!bot || !context?.ownUserId || !context.room.direct || context.room.membership !== 'join') {
    return false
  }

  const members =
    context.room.participants?.filter(member => member.membership === 'join' || member.membership === 'invite') ?? []

  return (
    members.some(member => member.userId === context.ownUserId) &&
    members.some(member => member.userId === bot.user_id) &&
    members.every(member => member.userId === context.ownUserId || member.userId === bot.user_id)
  )
}

/**
 * The versioned Bot API transport is room evidence, not an app-name convention. A plain room's
 * homeserver sender is sufficient; an encrypted room must also carry the native pinned-device
 * evidence produced by H1.
 */
export function authorizedBotApi(
  app: AppDescriptor | undefined,
  message: MatrixMessage,
  roomEncrypted: boolean
): MatrixBotApiMessage | undefined {
  if (!app?.bot || !message.botApi || message.own || app.bot.user_id !== message.sender) {
    return undefined
  }

  if (roomEncrypted && !(message.appBot?.authenticated === true && message.appBot.appId === app.app_id)) {
    return undefined
  }

  return message.botApi
}

/**
 * Whether this room uses Bot API for this exact catalog app. Authenticated message metadata
 * remains sufficient in every room. Before the first reply, only the signed `bot_api` mode in
 * the app's exact direct room can select the transport; it grants no group, rendering or device
 * authority.
 */
export function isBotApiRoomForApp(
  messages: readonly MatrixMessage[],
  app: AppDescriptor | undefined,
  roomEncrypted: boolean,
  context?: BotApiRoomContext
): boolean {
  return Boolean(
    app &&
      ((app.bot?.transport_mode === 'bot_api' && isDirectAppBotRoom(app, context)) ||
        messages.some(message => authorizedBotApi(app, message, roomEncrypted) !== undefined))
  )
}
