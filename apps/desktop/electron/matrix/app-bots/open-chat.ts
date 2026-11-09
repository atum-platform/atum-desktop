import type { AppBotDescriptor, AppDescriptor } from '../../../shared/app-catalog'
import type { MatrixSdkCommand } from '../../../shared/matrix'
import { type AppBotDmOpened, parseAppBotDmHidden, parseAppBotDmOpened } from '../../../shared/matrix-app-bot-dm'
import { appBotOpenRefusal } from '../../../shared/matrix-app-bot-failure'
import { matrixRoomLogHash } from '../undecryptable-log'

/** A catalog app whose bot is open to a chat: the app, and the bot the catalog names for it. */
export type AppChatTarget = AppDescriptor & { bot: AppBotDescriptor }

/**
 * The one step of starting an app chat that depends on who decides which room it is: find or make
 * the person's chat with the app's bot, open it, and say what was done (`AppBotDmOpened`). It
 * refuses with a closed `matrix_*` code (shared/matrix-app-bot-failure.ts), never free text.
 */
export type ResolveAppChatRoom = (app: AppChatTarget) => Promise<AppBotDmOpened>

interface StartAppChatPort {
  descriptor(): AppDescriptor
  current(): boolean
  /** Names the room the chat opens in. Main passes `platformAppChatRoom` (platform-room.ts): the
   * platform decides which room it is, and `localAppChatRoom` is what it falls back to. */
  resolveRoom: ResolveAppChatRoom
  /** The app's catalog slug ("moon"), for the log line even when its descriptor is refused. */
  slug?: string
  /** True once the account this open was for is gone (signed out, or another signed in). An open
   * waits for its room to sync and holds nothing else up, so the person can sign out meanwhile; the
   * open then ends with nothing selected and no error, since the window has moved on and an error
   * about a chat it no longer shows would only land on the sign-in screen. */
  ended?(): boolean
  log?(line: string): void
}

/** A refusal's closed code, as it crosses from the SDK host; never raw error text. */
function failureCode(error: unknown): string {
  const text = error instanceof Error ? error.message : ''

  return /^matrix_[a-z_]{1,64}$/u.test(text) ? text : 'matrix_operation_failed'
}

/** A catalog slug ("moon"), never an id, in a log line. */
export function logSlug(value: string | undefined): string {
  return value && /^[a-z][a-z0-9_-]{0,31}$/u.test(value) ? value : 'unknown'
}

/** main.log's line for an open that did not open: the app and the closed code only. */
export function appBotOpenFailedLine(slug: string | undefined, error: unknown): string {
  return `[Matrix] app bot open app=${logSlug(slug)} outcome=failed code=${failureCode(error)}`
}

/** The failures that have their line already, so a failure is never written twice (it passes
 * `startAppChat`, then the request handler's own catch). Keyed by the error itself. */
const logged = new WeakSet<object>()

function logOpenFailure(log: ((line: string) => void) | undefined, slug: string | undefined, error: unknown) {
  if (typeof error === 'object' && error !== null) {
    if (logged.has(error)) {
      return
    }

    logged.add(error)
  }

  log?.(appBotOpenFailedLine(slug, error))
}

/**
 * The window's request handler, with one promise kept for an app's chat: an `appChat` request that
 * fails anywhere in main leaves one `app bot open … outcome=failed code=…` line, with the app's
 * slug (`unknown` when main has no such app) and the closed code. That includes the failures that
 * never reach `startAppChat`: an id that is not an app's, a catalog without the app, a window
 * that is not ready. Every other request passes untouched, and the failure is rethrown as it was.
 */
export function logAppChatFailures<Sender, Req extends { kind?: string; appId?: unknown }, Result>(
  handler: (event: Sender, request: Req) => Promise<Result>,
  port: { slug(appId: string): string | undefined; log(line: string): void }
): (event: Sender, request: Req) => Promise<Result> {
  return async (event, request) => {
    try {
      return await handler(event, request)
    } catch (error) {
      if (request?.kind === 'appChat') {
        let slug: string | undefined

        try {
          slug = typeof request.appId === 'string' ? port.slug(request.appId) : undefined
        } catch {
          // The line is a record, not a reason to hide the failure it records.
        }

        logOpenFailure(port.log, slug, error)
      }

      throw error
    }
  }
}

/**
 * The local resolver: this device decides, through the human SDK (`openAppBotDm`, whose rule is
 * `chooseAppBotDm` in src/matrix/app-bot-dm.ts). It reuses the plain chat the account already has with
 * the bot, recovers or rejoins one, and makes a new plain one-to-one chat only when none works; an
 * encrypted chat from before 0.20 is moved out of, never reused. That plaintext preference is the rule
 * any other resolver keeps. No device is pinned first: the chat is plain, so no room keys go to the
 * bot's device (a send into an encrypted chat still pins, in main).
 *
 * Alone it cannot make two devices of one person agree on one chat; the platform can
 * (`platformAppChatRoom`, platform-room.ts). This is what that resolver falls back to: a Shell that
 * does not have the route yet, a platform that cannot be asked, or a room it names that cannot be
 * opened here as the bot's plain chat.
 */
export function localAppChatRoom(command: (command: MatrixSdkCommand) => Promise<unknown>): ResolveAppChatRoom {
  return async ({ app_id: appId, bot }) => {
    const opened = parseAppBotDmOpened(await command({ kind: 'openAppBotDm', appId, botUserId: bot.user_id }))

    if (!opened) {
      throw new Error('matrix_app_bot_dm_invalid')
    }

    return opened
  }
}

/**
 * Start the person's chat with a catalog app's bot: the one action every way in goes through (the
 * roster row, the start menu, Discover's Open, a notice's Start). Setup uses the human SDK; a local
 * assistant turn does not own this chat. Every refusal is a closed code the window can explain
 * (shared/matrix-app-bot-failure.ts). Nothing here names an app: the catalog entry decides.
 *
 * The steps are fixed: the account is current; the app is open to a chat (its bot active, with a
 * published device); `port.resolveRoom` names and opens the room; one line is written. Only the
 * resolver differs: for a signed `bot_api` descriptor, `platformAppChatRoom` uses the ordinary
 * local direct-room path and never calls the legacy Start/consent/link route. Otherwise it asks
 * the platform first
 * (`POST /api/matrix/v1/apps/{slug}/bot/start`, spec/canonical-room/v1.1), which answers `ready`
 * (open that room), `create` (make a plain, unencrypted one-to-one `is_direct` chat, invite the bot,
 * ask again with the same `requestId` and the room, and open the room the server names, leaving
 * ours if it names another) or `unavailable` (refuse with a closed `matrix_app_bot_*` code); the
 * local rule above is its fallback.
 *
 * Every open writes one line to main.log: `[Matrix] app bot open app=<slug> outcome=<reused |
 * recovered | rejoined | created | rejoin_impossible | moved> reason=<code> room=<hash> joined=<n>
 * left=<n> pointer=<kept | written | write_failed> shown=<none | shown | failed>`
 * (shared/matrix-app-bot-dm.ts), or `outcome=failed code=<code>` when it
 * did not open. The room is a short hash, the same for the same room on every line; never its id.
 * A failure that never gets here (`logAppChatFailures`) leaves the same failed line.
 *
 * It answers the room's id, or null when the account it was for was gone before it opened (`ended`).
 */
export async function startAppChat(port: StartAppChatPort): Promise<string | null> {
  try {
    return await startChat(port)
  } catch (error) {
    logOpenFailure(port.log, port.slug, error)

    // Still one line for it, with its closed code: an open that did not open. Only the window is spared.
    if (port.ended?.()) {
      return null
    }

    throw error
  }
}

async function startChat(port: StartAppChatPort): Promise<string> {
  if (!port.current()) {
    throw new Error('matrix_not_ready')
  }

  const app = port.descriptor()
  const bot = app.bot

  if (!bot) {
    throw new Error('matrix_app_bot_unavailable')
  }

  const refusal = appBotOpenRefusal(bot)

  // A bot with no device yet is still starting: it could not answer in any chat.
  if (refusal || !bot.device) {
    throw new Error(refusal ?? 'matrix_app_bot_starting')
  }

  const opened = await port.resolveRoom({ ...app, bot })

  port.log?.(
    `[Matrix] app bot open app=${logSlug(port.slug ?? app.app)} outcome=${opened.outcome} reason=${opened.reason} room=${matrixRoomLogHash(opened.roomId)} joined=${opened.joined} left=${opened.left} pointer=${opened.pointer} shown=${opened.shown}`
  )

  return opened.roomId
}

/** main.log's line for Delete chat on an official bot's chat, which keeps the room out of sight
 * instead of leaving it; null for any other answer to Delete chat. */
export function appBotChatHiddenLine(
  answer: unknown,
  roomId: string,
  slugOf: (appId: string) => string | undefined
): string | null {
  const hidden = parseAppBotDmHidden(answer)

  return hidden ? `[Matrix] app bot chat hidden app=${logSlug(slugOf(hidden.appId))} room=${matrixRoomLogHash(roomId)}` : null
}

/** main.log's line when Delete chat on an official bot's chat failed to keep it out of sight:
 * the app and the closed code only; null when the chat was not a bot's (main's display copy of
 * the room says so, which is enough for a log line). */
export function appBotChatHideFailedLine(
  appBot: { appId: string } | undefined,
  slugOf: (appId: string) => string | undefined,
  error: unknown
): string | null {
  return appBot ? `[Matrix] app bot chat hide failed app=${logSlug(slugOf(appBot.appId))} code=${failureCode(error)}` : null
}

/** main.log's line when a bot's chat is opened as a plain chat (its roster row while the bot
 * cannot be opened, or ⌘K): the app, the bot's state then, and the room hash; null for any other
 * chat. Reading only: main still checks the bot before a send. */
export function appBotChatSelectedLine(
  appBot: { appId: string } | undefined,
  roomId: string,
  app: (appId: string) => { slug?: string; bot?: string } | undefined
): string | null {
  if (!appBot) {
    return null
  }

  const known = app(appBot.appId)
  const bot = known?.bot && /^[a-z_]{1,32}$/u.test(known.bot) ? known.bot : 'unknown'

  return `[Matrix] app bot chat selected app=${logSlug(known?.slug)} bot=${bot} room=${matrixRoomLogHash(roomId)}`
}
