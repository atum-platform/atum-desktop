import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useRef } from 'react'

/**
 * Team Space has one right-hand detail pane. A thread, the pinned list, channel or company info, search
 * results and a task's details all live there, and opening one replaces whichever was open. Each owner keeps
 * its own state (the thread view in the chat window, the members panel in the workspace, the card in the
 * board) and only announces here that it holds the pane; the others step aside.
 */
export type TeamSpaceDetailPane = 'thread' | 'pins' | 'info' | 'search' | 'task'

export const $teamSpaceDetailPane = atom<TeamSpaceDetailPane | null>(null)

/** The pane's one geometry, so whichever owner holds it, the transcript beside it keeps the same width. */
export const TEAM_SPACE_DETAIL_PANE_CLASS =
  'absolute inset-y-0 end-0 z-30 flex w-[min(26rem,100%)] flex-col border-s border-(--atum-panel-line) bg-(--atum-main-bg) shadow-nous'

/** Pure rule for tests: an owner that is open must close when another kind now holds the pane. */
export function detailPaneDisplaced(kind: TeamSpaceDetailPane, open: boolean, holder: TeamSpaceDetailPane | null): boolean {
  return open && holder !== null && holder !== kind
}

/**
 * Binds one owner to the shared pane: opening claims it, another kind's claim closes this one, and closing
 * releases it only when this kind still holds it.
 */
export function useTeamSpaceDetailPane(kind: TeamSpaceDetailPane, open: boolean, close: () => void) {
  const holder = useStore($teamSpaceDetailPane)
  const closeRef = useRef(close)
  closeRef.current = close
  const wasOpen = useRef(false)

  useEffect(() => {
    if (open && !wasOpen.current) {
      $teamSpaceDetailPane.set(kind)
    } else if (!open && wasOpen.current && $teamSpaceDetailPane.get() === kind) {
      $teamSpaceDetailPane.set(null)
    }

    wasOpen.current = open
  }, [kind, open])

  // Read the live value, not the render's: this owner may have claimed the pane a moment ago in this commit.
  useEffect(() => {
    if (detailPaneDisplaced(kind, open, $teamSpaceDetailPane.get()) && wasOpen.current) {
      closeRef.current()
    }
  }, [holder, kind, open])

  useEffect(() => () => {
    if (wasOpen.current && $teamSpaceDetailPane.get() === kind) {
      $teamSpaceDetailPane.set(null)
    }
  }, [kind])
}
