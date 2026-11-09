import { closeActiveTerminal } from '@/app/right-sidebar/terminal/terminals'
import { closeWorkspaceTab } from '@/components/pane-shell/tree/store'
import { isFocusWithin } from '@/lib/keybinds/combo'
import { FOCUSED_LOCAL_TAB_CLOSE_EVENT } from '@/lib/local-tab-close'
import { closeSessionTile, nextSessionTileForWorkspace } from '@/store/session-states'

export { FOCUSED_LOCAL_TAB_CLOSE_EVENT } from '@/lib/local-tab-close'

function closeFocusedLocalTab(): boolean {
  const target = document.activeElement

  if (!(target instanceof Element)) {
    return false
  }

  const event = new CustomEvent(FOCUSED_LOCAL_TAB_CLOSE_EVENT, { bubbles: true, cancelable: true })
  target.dispatchEvent(event)

  return event.defaultPrevented
}

/**
 * ⌘W — close the tab of the context you're in, by precedence:
 *   1. a focused terminal → its active terminal tab,
 *   2. the MAIN zone → its active tab (including typed resource panes),
 *   3. the MAIN (workspace) tab itself, when session tabs are stacked with it:
 *      the workspace can't close, so ⌘W shifts the NEXT session tab into main
 *      (loads it as the primary + drops its now-redundant tile).
 * Returns false when nothing closes, so ⌘W is a no-op — it never closes the
 * window (a bare workspace stays put). Shared by the keyboard path (Win/Linux)
 * and the macOS menu-accelerator IPC.
 *
 * `loadSessionIntoWorkspace` carries the app's route-based "load this session
 * into main" (the two call sites have router access); omitting it disables the
 * step-4 promotion (⌘W stays the pre-existing no-op on the main tab).
 */
export function closeActiveTab(loadSessionIntoWorkspace?: (storedSessionId: string) => void): boolean {
  // Native macOS menu accelerators do not reach React's keydown handler. Give
  // the focused local tab strip first refusal through a bounded DOM event so
  // the same ⌘W behavior works on every platform.
  if (closeFocusedLocalTab()) {
    return true
  }

  if (isFocusWithin('[data-terminal]')) {
    closeActiveTerminal()

    return true
  }

  // A closeable main-zone tab (a session tile that's the active tab) closes
  // outright; the uncloseable workspace tab returns false and falls through.
  if (closeWorkspaceTab()) {
    return true
  }

  // The main (workspace) tab is active and can't be closed — but if session
  // tabs are stacked with it, ⌘W shifts the next one into the main tab: drop
  // its tile (the session stays alive, no busy-close prompt) and load it into
  // main. Order matters — close the tile FIRST so the selection homes to the
  // workspace instead of re-fronting the tile.
  if (loadSessionIntoWorkspace) {
    const next = nextSessionTileForWorkspace()

    if (next) {
      closeSessionTile(next)
      loadSessionIntoWorkspace(next)

      return true
    }
  }

  return false
}
