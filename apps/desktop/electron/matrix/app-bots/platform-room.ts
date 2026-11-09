import type { MatrixSdkCommand } from '../../../shared/matrix'
import {
  type AppBotDmOpened,
  isCanonicalMatrixRoomId,
  isCanonicalMatrixUserId,
  parseAppBotDmFound,
  parseAppBotDmLeft,
  parseAppBotDmMade,
  parseAppBotDmOpened
} from '../../../shared/matrix-app-bot-dm'
import type { AppBotFailureCode } from '../../../shared/matrix-app-bot-failure'

import { type AppChatTarget, logSlug, type ResolveAppChatRoom } from './open-chat'

/** What one POST to the platform's `bot/start` route says, read. */
type Answer =
  /** A canonical room exists: open it. */
  | { kind: 'ready'; roomId: string; botUserId: string }
  /** None exists: make a plain one-to-one chat with the bot and offer it. */
  | { kind: 'create'; botUserId: string }
  | { kind: 'unavailable'; reason: string }
  /** 404: a Shell that does not have the route yet. */
  | { kind: 'absent' }
  /** 400, 403 or 409: the platform will not take this request as sent. */
  | { kind: 'refused'; status: number }
  /** Nothing is known: no answer, 401, 429, 5xx, or an answer that is not one. */
  | { kind: 'later' }

/** The strict body of the route: nothing but the attempt, a hint and the room offered. */
export interface PlatformStartRequest {
  requestId: string
  appVersion?: string
  roomId?: string
}

export interface PlatformRoomPort {
  /** `account.appBotStart`: one POST, answered as read. It throws when the call itself failed, and
   * with `matrix_not_ready` when the account changed meanwhile. */
  start(slug: string, request: PlatformStartRequest): Promise<{ status: number; body?: unknown }>
  /** The human SDK's commands: `findAppBotDm`, `makeAppBotDm`, `openAppBotRoom`, `leaveAppBotDm`. */
  command(command: MatrixSdkCommand): Promise<unknown>
  /** What opens the chat when the platform cannot name its room: a Shell without the route (404), a
   * platform that cannot be asked while this device already has a chat, or a room it names that
   * this device cannot open as the bot's chat. Today's rule (`localAppChatRoom`). */
  fallback: ResolveAppChatRoom
  /** A fresh UUID for one start attempt. */
  requestId(): string
  /** This Atum's version, as the route's compatibility hint. It grants nothing. */
  appVersion?: string
  /** False once the account this started for is gone. */
  current(): boolean
  log?(line: string): void
}

/** The route's closed reasons for an app whose chat cannot start, as the closed codes the window
 * explains (shared/matrix-app-bot-failure.ts). A reason this client does not know is `unavailable`. */
const UNAVAILABLE: Readonly<Record<string, AppBotFailureCode>> = {
  app_unavailable: 'matrix_app_bot_unavailable',
  bot_unavailable: 'matrix_app_bot_resting',
  not_published: 'matrix_app_bot_unavailable'
}

/** Refusals that are no moment's trouble and are never asked again: the account changed, or this
 * client built a request the route cannot take. */
const FINAL = new Set(['matrix_not_ready', 'matrix_app_invalid'])

/** The room the platform named cannot be opened here as the bot's chat (SDK `openAppBotRoom`). */
const UNUSABLE_ROOM = /\bmatrix_app_bot_dm_(?:encrypted|invalid)\b/u

function row(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** The route's 200 answer. What gives it meaning is read and checked; a field this client does not
 * know is ignored, so the platform can add one without an older Atum failing. */
function readStart(body: unknown): Answer | null {
  const value = row(body)

  if (value?.state === 'ready' && isCanonicalMatrixRoomId(value.roomId) && isCanonicalMatrixUserId(value.botUserId)) {
    return { kind: 'ready', roomId: value.roomId, botUserId: value.botUserId }
  }

  if (value?.state === 'create' && isCanonicalMatrixUserId(value.botUserId)) {
    return { kind: 'create', botUserId: value.botUserId }
  }

  if (value?.state === 'unavailable' && typeof value.reason === 'string') {
    return { kind: 'unavailable', reason: value.reason }
  }

  return null
}

function read({ status, body }: { status: number; body?: unknown }): Answer {
  if (status === 404) {
    return { kind: 'absent' }
  }

  if (status === 200) {
    return readStart(body) ?? { kind: 'later' }
  }

  return status === 400 || status === 403 || status === 409 ? { kind: 'refused', status } : { kind: 'later' }
}

/** main.log's line for one answer of the route: the app, the step, and closed words only. */
export function appBotStartLogLine(slug: string, step: 'first' | 'second', answer: Answer): string {
  const detail =
    answer.kind === 'unavailable'
      ? ` reason=${Object.hasOwn(UNAVAILABLE, answer.reason) ? answer.reason : 'unknown'}`
      : answer.kind === 'refused'
        ? ` status=${answer.status}`
        : ''

  return `[Matrix] app bot start app=${logSlug(slug)} step=${step} answer=${answer.kind}${detail}`
}

const unavailable = (reason: string) =>
  new Error(Object.hasOwn(UNAVAILABLE, reason) ? UNAVAILABLE[reason] : 'matrix_app_bot_unavailable')

/**
 * The resolver for an app's chat when the platform decides which room it is (`POST
 * /api/matrix/v1/apps/{slug}/bot/start`, spec/canonical-room/v1.1). Two devices of one person starting
 * at once cannot both pick, so the server records one room per owner and app, and every device opens
 * that one. This device does only what the server cannot: it looks for a chat to offer, makes one when
 * told to, opens the room it is given, and leaves one that lost. The plaintext preference is the local
 * rule's (SDK `findAppBotDm`, `makeAppBotDm`, `openAppBotRoom`): only a plain chat is offered, made or
 * opened.
 *
 * One attempt, with one `requestId` (a fresh UUID; reused for every retry of that attempt):
 * 1. `findAppBotDm`: the plain chat this device already has, if any, is sent as `roomId` on the first
 *    call, so the server can record it (adopt) instead of a second chat being made.
 * 2. The route answers `ready` (open that room), `create`, or `unavailable{reason}` (refuse with the
 *    closed code the window explains).
 * 3. `create`: `makeAppBotDm`, then the same call again with the same `requestId` and the new
 *    `roomId`. The server answers `ready` with the winner. If that is another room, this device opens
 *    it and leaves its own, only while nobody has written in it.
 *
 * Requests carry no owner, bot or app authority; those come from the bearer and the catalog. The
 * route's answers are checked against the catalog's bot, so a bot that changed under the start is
 * `matrix_app_bot_changed`.
 *
 * Opening a room ends by the SDK waiting for it to reach its store (src/matrix/app-bot-room-wait.ts):
 * a room this device just made, or one another device made, may not have synced here yet, and the
 * window draws only rooms the store holds. When sync does not bring it in time the open fails with
 * `matrix_app_bot_syncing` and nothing else changes: the candidate this device made stays (the next
 * start offers it again), the platform's record stands, and a retry opens the same room.
 *
 * When the platform cannot decide, the local rule does, as before the route existed:
 * - a signed `bot_api` descriptor: use the ordinary direct-room path immediately. Bot API owns
 *   first contact through the canonical DM and the platform injects its synthetic `/start`; the
 *   legacy consent/link `bot/start` route must not run;
 * - 404: a Shell without the route (an older deployment);
 * - the platform cannot be asked (no answer, 429, 5xx) and this device already has a plain chat with
 *   the bot: that chat opens. With none, nothing is made: a second chat could be the one that loses;
 * - the room the platform names is encrypted (a chat from before 0.20), or is not the bot's
 *   one-to-one chat here: the local rule moves out of it and makes a plain one.
 */
export function platformAppChatRoom(port: PlatformRoomPort): ResolveAppChatRoom {
  const live = () => {
    if (!port.current()) {
      throw new Error('matrix_not_ready')
    }
  }

  const sdk = async <T>(command: MatrixSdkCommand, parse: (value: unknown) => T | null): Promise<T> => {
    live()

    const value = parse(await port.command(command))

    live()

    if (value === null) {
      throw new Error('matrix_app_bot_dm_invalid')
    }

    return value
  }

  const request = (requestId: string, roomId: string | undefined): PlatformStartRequest => ({
    requestId,
    ...(port.appVersion && /^[!-~]{1,100}$/u.test(port.appVersion) ? { appVersion: port.appVersion } : {}),
    ...(roomId ? { roomId } : {})
  })

  /** One call, asked again once with the same body when the network failed or the server did: the
   * route is idempotent on `requestId`, so the second ask cannot make a second room. */
  const ask = async (app: AppChatTarget, step: 'first' | 'second', body: PlatformStartRequest): Promise<Answer> => {
    let answer: Answer = { kind: 'later' }

    for (let tries = 0; tries < 2; tries++) {
      live()

      let reply: { status: number; body?: unknown }

      try {
        reply = await port.start(app.app, body)
      } catch (error) {
        if (error instanceof Error && FINAL.has(error.message)) {
          throw error
        }

        continue
      }

      live()
      answer = read(reply)

      if (reply.status < 500) {
        break
      }
    }

    port.log?.(appBotStartLogLine(app.app, step, answer))

    return answer
  }

  const sameBot = (app: AppChatTarget, botUserId: string) => {
    if (botUserId !== app.bot.user_id) {
      throw new Error('matrix_app_bot_changed')
    }
  }

  const open = async (
    app: AppChatTarget,
    roomId: string,
    selection: number,
    outcome?: AppBotDmOpened['outcome']
  ): Promise<AppBotDmOpened> => {
    try {
      const opened = await sdk(
        { kind: 'openAppBotRoom', appId: app.app_id, botUserId: app.bot.user_id, roomId, selection },
        parseAppBotDmOpened
      )

      return outcome ? { ...opened, outcome } : opened
    } catch (error) {
      if (error instanceof Error && UNUSABLE_ROOM.test(error.message)) {
        port.log?.(`[Matrix] app bot start app=${logSlug(app.app)} step=open answer=local`)

        return port.fallback(app)
      }

      throw error
    }
  }

  /** Leave a chat the platform will not keep, while nobody has written in it (the SDK checks the
   * server, and never leaves the chat the account points at). A failure keeps it. */
  const leave = async (app: AppChatTarget, roomId: string) => {
    await sdk({ kind: 'leaveAppBotDm', appId: app.app_id, botUserId: app.bot.user_id, roomId }, parseAppBotDmLeft).catch(
      () => {}
    )
  }

  /** A chat that lost to the room now open. Not when the open chat is this one: the local rule
   * (`fallback`) may have chosen it. */
  const leaveLoser = async (app: AppChatTarget, roomId: string, opened: AppBotDmOpened) => {
    if (opened.roomId !== roomId) {
      await leave(app, roomId)
    }
  }

  /** The platform said `create`: make a chat, offer it under the same `requestId`, and open the
   * room the platform keeps. */
  const create = async (app: AppChatTarget, requestId: string, selection: number): Promise<AppBotDmOpened> => {
    const made = await sdk({ kind: 'makeAppBotDm', appId: app.app_id, botUserId: app.bot.user_id }, parseAppBotDmMade)
    const second = await ask(app, 'second', request(requestId, made.roomId))

    if (second.kind === 'ready') {
      sameBot(app, second.botUserId)

      if (second.roomId === made.roomId) {
        return open(app, made.roomId, selection, made.moved ? 'moved' : undefined)
      }

      // Another device's room was kept first: open it, then leave ours.
      const opened = await open(app, second.roomId, selection)
      await leaveLoser(app, made.roomId, opened)

      return opened
    }

    if (second.kind === 'unavailable') {
      // The candidate stays: the next start offers it.
      throw unavailable(second.reason)
    }

    if (second.kind === 'create' || (second.kind === 'refused' && second.status === 403)) {
      // The platform will not keep it (and names no other): it is not the chat.
      await leave(app, made.roomId)

      throw new Error('matrix_app_bot_unavailable')
    }

    // No answer, or one that cannot be used: unknown. Kept, and offered by the next start.
    throw new Error('matrix_app_bot_resting')
  }

  return async app => {
    if (app.bot.transport_mode === 'bot_api') {
      return port.fallback(app)
    }

    const found = await sdk({ kind: 'findAppBotDm', appId: app.app_id, botUserId: app.bot.user_id }, parseAppBotDmFound)
    let offered = found.roomId ?? undefined

    for (let attempt = 0; attempt < 2; attempt++) {
      const requestId = port.requestId()
      const first = await ask(app, 'first', request(requestId, offered))

      if (first.kind === 'absent') {
        return port.fallback(app)
      }

      if (first.kind === 'later') {
        if (found.roomId) {
          return port.fallback(app)
        }

        throw new Error('matrix_app_bot_resting')
      }

      if (first.kind === 'refused') {
        // A room the platform will not keep (403) is asked again without it, and an id it saw with
        // other input (409) under a new one. A request it calls malformed (400) is never asked again.
        if (attempt === 0 && ((first.status === 403 && offered) || first.status === 409)) {
          offered = first.status === 403 ? undefined : offered

          continue
        }

        throw new Error('matrix_app_bot_unavailable')
      }

      if (first.kind === 'unavailable') {
        throw unavailable(first.reason)
      }

      sameBot(app, first.botUserId)

      if (first.kind === 'create') {
        return create(app, requestId, found.selection)
      }

      const opened = await open(app, first.roomId, found.selection)

      // The chat this device offered lost to another device's.
      if (offered) {
        await leaveLoser(app, offered, opened)
      }

      return opened
    }

    throw new Error('matrix_app_bot_unavailable')
  }
}
