import { useCallback, useRef, useState } from 'react'

import type { AppDescriptor } from '../../../shared/app-catalog'
import type { MatrixSnapshot } from '../../../shared/matrix'
import { runMatrixCommand } from '../text-document-actions'

import { openAppBotChat } from './open'

/**
 * How a catalog app opens when the person picks it from the roster's row or the start menu. An
 * app with an official bot is a chat first: the pick opens (or makes) the person's one chat with
 * its bot, where its setup card, "+" menu and panel live, whatever the app is called. Any other
 * app opens on its page. A refusal reaches `fail` naming the bot (open.ts), with a Retry that is
 * this same pick again. Bots open one at a time: a pick while one is opening is ignored, and
 * `openingApp` says which is, until its chat is on the window or the failure says why it is not.
 */
export function useOpenApp(
  snapshot: Pick<MatrixSnapshot, 'apps'>,
  locale: string,
  fail: (cause?: unknown) => void
) {
  const [openingApp, setOpeningApp] = useState<string | null>(null)
  const opening = useRef(false)
  // The Retry of a failure is the latest pick, not the one the failure was made with.
  const again = useRef<(app: AppDescriptor) => void>(() => {})

  const openApp = useCallback(
    (app: AppDescriptor) => {
      if (!app.bot) {
        void runMatrixCommand({ kind: 'selectApp', appId: app.app_id }).catch(fail)

        return
      }

      if (opening.current) {
        return
      }

      opening.current = true
      setOpeningApp(app.app_id)
      void openAppBotChat(snapshot, app.app_id, locale, fail, () => again.current(app)).finally(() => {
        opening.current = false
        setOpeningApp(null)
      })
    },
    [fail, locale, snapshot]
  )

  again.current = openApp

  return { openApp, openingApp }
}
