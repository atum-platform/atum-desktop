import { useStore } from '@nanostores/react'

import { useMediaQuery } from '@/hooks/use-media-query'
import { useI18n } from '@/i18n'
import {
  $railDestination,
  $rosterDrawerOpen,
  $rosterShownOnDiscover,
  $sidebarOpen,
  $workspaceExpanded,
  $workspaceOpen,
  ATUM_COMPACT_BREAKPOINT_PX,
  ATUM_WORKSPACE_DRAWER_BREAKPOINT_PX,
  setRosterDrawerOpen,
  setSidebarOpen,
  setWorkspaceExpanded
} from '@/store/atum-shell'
import { $nativeApps, endNativeApp } from '@/store/native-apps'
import { $connection } from '@/store/session'
import { $wordCompanion, $wordCompanionOpening, endWordCompanion } from '@/store/word-companion'

/**
 * The shell's presentation facts, derived in ONE place from the stores and the
 * window's width.
 *
 * Every column of the shell owns a top row of the same height, and exactly one
 * of them — the leftmost visible one — renders the window controls (the native
 * traffic-light reservation and the sidebar toggle). Which row that is depends
 * on the same facts the shell root uses to lay the columns out, so the root and
 * the controls read them from here rather than each deriving its own copy:
 * two derivations is how a control ends up on a row the layout has already
 * hidden.
 */
export function useAtumShellLayout() {
  const { t } = useI18n()
  const companion = useStore($wordCompanion)
  const companionOpening = useStore($wordCompanionOpening)
  const nativeApp = useStore($nativeApps)
  const nativeVisible = nativeApp.result?.status === 'beside'
  const companionVisible = Boolean(companion || companionOpening || nativeVisible)
  const sidebarPreference = useStore($sidebarOpen)
  const sidebarOpen = sidebarPreference && !companionVisible
  const railDestination = useStore($railDestination)
  const workspacePreference = useStore($workspaceOpen)
  const workspaceOpen = workspacePreference && !companionVisible
  const workspaceExpanded = useStore($workspaceExpanded)
  const rosterDrawerOpen = useStore($rosterDrawerOpen)
  const rosterShownOnDiscover = useStore($rosterShownOnDiscover)
  const connection = useStore($connection)

  const compact = useMediaQuery(`(max-width: ${ATUM_COMPACT_BREAKPOINT_PX - 1}px)`)
  const workspaceIsDrawer = useMediaQuery(`(max-width: ${ATUM_WORKSPACE_DRAWER_BREAKPOINT_PX - 1}px)`)

  // Discover is a place you go to add something to Atum, not a conversation
  // with a side panel. Leaving the workspace up beside it strands whatever tool
  // was last open next to a surface that has nothing to do with it. Suppress it
  // while Discover is the destination — presentation only, so `$workspaceOpen`
  // still remembers what the user had when they go back to chat.
  const workspaceSuppressed = railDestination === 'discover' || companionVisible
  // Discover collapses the roster on arrival for the same reason it suppresses
  // the workspace: it is a surface for adding things to Atum, not a
  // conversation with a contact list beside it. A default, not a lock — asking
  // for the sidebar while on Discover shows it, and the next arrival collapses
  // again. `$sidebarOpen` is untouched, so chat gets back exactly what it had.
  const rosterSuppressed = railDestination === 'discover' && !rosterShownOnDiscover
  // "Phóng to" (SPEC §1a): the workspace leaves the split and takes the whole
  // frame — the sidebar slides away and the chat stays mounted underneath. A
  // narrow window is already full-frame, so the flag only means something
  // above the drawer breakpoint.
  const workspaceFullFrame = workspaceOpen && workspaceExpanded && !workspaceIsDrawer && !workspaceSuppressed
  // The workspace covering the chat column, for either reason.
  const workspaceOverFrame = workspaceOpen && !workspaceSuppressed && (workspaceFullFrame || workspaceIsDrawer)
  // The workspace beside the chat, in the split.
  const workspaceInSplit = workspaceOpen && !workspaceSuppressed && !workspaceFullFrame && !workspaceIsDrawer

  const sidebarShowing = compact ? rosterDrawerOpen : sidebarOpen && !workspaceFullFrame && !rosterSuppressed

  // The native traffic lights are drawn by the OS on macOS; a row only
  // reserves their room. Windows/Linux keep their overlay on the right and
  // fullscreen hides the lights entirely.
  const reserveLights = connection?.windowButtonPosition !== null && !connection?.isFullscreen

  const sidebarLabel = companionVisible && !compact
    ? t.atum.workspace.wordExit
    : compact
    ? sidebarShowing
      ? t.atum.chat.closeRoster
      : t.atum.chat.openRoster
    : sidebarShowing
      ? t.atum.chat.closeSidebar
      : t.atum.chat.openSidebar

  const toggleSidebar = () => {
    if (companionVisible && !compact) {
      if (nativeVisible) {void endNativeApp()} else {void endWordCompanion()}

      return
    }

    // While the workspace fills the frame the sidebar is hidden, not closed, so
    // the control means "give me the sidebar back": leave full frame, and show
    // the sidebar the person just asked for.
    if (workspaceFullFrame) {
      setWorkspaceExpanded(false)
      setSidebarOpen(true)

      return
    }

    if (compact) {
      setRosterDrawerOpen(!rosterDrawerOpen)

      return
    }

    // On Discover the roster is collapsed by presentation, so a toggle that
    // wrote `$sidebarOpen` would look broken: the preference is already true.
    // Record the ask against Discover instead, and leave the chat preference
    // exactly as the person left it.
    if (rosterSuppressed) {
      $rosterShownOnDiscover.set(true)

      return
    }

    if (railDestination === 'discover' && rosterShownOnDiscover) {
      $rosterShownOnDiscover.set(false)

      return
    }

    setSidebarOpen(!sidebarOpen)
  }

  return {
    compact,
    reserveLights,
    rosterDrawerOpen,
    sidebarLabel,
    sidebarOpen,
    rosterSuppressed,
    sidebarShowing,
    toggleSidebar,
    workspaceFullFrame,
    workspaceInSplit,
    workspaceIsDrawer,
    workspaceOpen,
    workspaceOverFrame,
    workspaceSuppressed
  }
}
