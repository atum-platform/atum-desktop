import type { MatrixSnapshot } from '../../../shared/matrix'
import { aboutAppBot } from '../chat-error'

/** An official bot's display name in the signed catalog, for the sentences that name it. */
export function appBotName(snapshot: Pick<MatrixSnapshot, 'apps'>, appId: string): string | undefined {
  return snapshot.apps?.apps.find(app => app.app_id === appId)?.bot?.display_name
}

/**
 * Opens an official bot's chat through main (`startAppChat`, electron/matrix/app-bots/open-chat.ts:
 * the one action, whatever the app and wherever the person picked it). It settles once the chat
 * is open on the window, or fails: a refusal reaches `fail` naming the bot, so the window says why
 * ("Moon is starting up…") rather than "that didn't work", and carrying `retry`, which the failure
 * band offers as its Retry. By default retrying is this same call again; a surface that shows the
 * chat opening (the roster row) passes its own, so the retry shows it too. Nothing here names an
 * app, and there is no way out of it that says nothing.
 */
export function openAppBotChat(
  snapshot: Pick<MatrixSnapshot, 'apps'>,
  appId: string,
  locale: string,
  fail: (cause?: unknown) => void,
  retry: () => void = () => void openAppBotChat(snapshot, appId, locale, fail)
): Promise<void> {
  const bridge = window.atumMatrix.apps
  const failed = (cause: unknown) => fail(aboutAppBot(cause, appBotName(snapshot, appId), retry))

  if (!bridge) {
    // This window has nothing to open a chat with: say so, rather than a pick that does nothing.
    failed(new Error('matrix_app_bot_unavailable'))

    return Promise.resolve()
  }

  return bridge.chat(appId, locale).then(() => undefined, failed)
}
