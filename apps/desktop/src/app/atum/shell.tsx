import { useStore } from '@nanostores/react'
import { lazy, Suspense, useEffect, useState } from 'react'

import { AtumPermissionPrePrompt } from '@/components/permission-preprompt'
import { useI18n } from '@/i18n'
import { $atumAccountStatus, initializeAtumMessaging } from '@/store/atum-messaging'
import {
  $railDestination,
  $rosterDrawerOpen,
  $rosterQuery,
  $workspaceExpanded,
  $workspaceOpen,
  $workspacePercent,
  setRosterDrawerOpen,
  setRosterQuery,
  setWorkspaceExpanded,
  setWorkspaceOpen
} from '@/store/atum-shell'
import { $desktopBoot } from '@/store/boot'
import { startConversationContextLinks } from '@/store/conversation-context-links'
import { AppViewOverlayHold } from '@/store/use-app-view-overlay'
import { startWordCompanionLifecycle } from '@/store/word-companion'

import { observeAgentSync } from './agent-sync'
import { startAtumAssistantDirectory } from './assistant-directory'
import { AtumAuthView } from './auth-view'
import { AtumChatPanel } from './chat-panel'
import { AtumDiscoverPanel } from './discover-panel'
import { AtumNavSwitch } from './nav-switch'
import { startAtumAgentRegistration } from './register-agents'
import { AtumRosterPanel } from './roster-panel'
import { AtumShellFrame } from './shell-frame'
import { useAtumShellLayout } from './shell-layout'
import { useAtumWorkspace } from './use-workspace'
import { AtumUsernameGate } from './username-gate'
import { AtumWindowControls } from './window-controls'

// The workspace pulls in the real preview rail and file tree. The shell keeps
// its geometry while this on-demand chunk resolves, so first paint does not
// jump from a full-width transcript to a split layout.
const AtumWorkspacePanel = lazy(async () => ({ default: (await import('./workspace-panel')).AtumWorkspacePanel }))

/**
 * What stands in for the workspace while its chunk loads. A panel that owns
 * the frame still has to own its top row: the chat header has already stood
 * its controls down the moment the layout said the workspace covers it, so
 * the placeholder paints the ground and hosts the controls at the same
 * geometry the real tab bar takes over — otherwise the window has no toggle
 * for as long as the import takes. In the split, the placeholder is only the
 * column's width, so first paint does not jump.
 */
export function AtumWorkspacePlaceholder({ overFrame }: { overFrame: boolean }) {
  if (!overFrame) {
    return <div aria-hidden className="min-w-0" data-atum-workspace-loading />
  }

  return (
    <div className="absolute inset-0 z-30 atum-window-ground" data-atum-workspace-loading>
      <div className="flex h-(--atum-l-header) items-center ps-3 [-webkit-app-region:drag]">
        <AtumWindowControls />
      </div>
    </div>
  )
}

/**
 * The Atum product shell.
 *
 * Two same-level columns on one window: the sidebar (268px, tinted glass,
 * flush with the window's edges) and the main column, which paints the
 * window ground and holds the chat or Discover beside the workspace. There is
 * no title bar. Each column owns a top row of the same height
 * (`--atum-l-header`): the sidebar's carries the native traffic lights and the
 * collapse control, the chat's carries the conversation's identity, the
 * workspace's IS its tab bar. One token gives them one baseline; the leftmost
 * visible row renders the window controls (`window-controls.tsx`), so they
 * never move when the sidebar goes away.
 *
 * Collapsing the sidebar removes its column and nothing else; under 1024px it
 * is a drawer over an ink scrim and the workspace goes full-frame. Expanding
 * the workspace ("phóng to") puts a wide window in that same full-frame
 * picture: the sidebar slides away, the panel takes the frame, and the chat
 * waits underneath. The nav switch on the top row, beside the toggle, is the
 * shell's meta-navigation between Home and Discover (`nav-switch.tsx`).
 *
 * This component is mounted INSIDE `ContribWiring`, so contributions, keybinds,
 * terminal host, and every boot surface are untouched by the branch. The full
 * Hermes engine — plugins, skills, providers, browser and computer control,
 * tool cards, approvals — is alive underneath; only the chrome differs.
 */
export function AtumShellRoot() {
  const { t } = useI18n()
  const account = useStore($atumAccountStatus)
  const boot = useStore($desktopBoot)
  const railDestination = useStore($railDestination)
  const workspacePercent = useStore($workspacePercent)
  const rosterDrawerOpen = useStore($rosterDrawerOpen)

  // Main may require an account before the renderer has loaded account status.
  // Keep cached workspace content hidden during that first status read.
  const gated =
    (boot.phase === 'renderer.account' && !account.configured) ||
    (account.configured && account.state !== 'signed_in' && account.state !== 'refreshing')

  const workspace = useAtumWorkspace(!gated)
  const [authVisible, setAuthVisible] = useState(gated)
  const [authExiting, setAuthExiting] = useState(false)

  const {
    compact,
    sidebarShowing,
    workspaceOpen,
    workspaceFullFrame,
    workspaceInSplit,
    workspaceIsDrawer,
    workspaceOverFrame,
    workspaceSuppressed
  } = useAtumShellLayout()

  // Tell the plane which assistants this person has, whenever that changes
  // while they are signed in. Best-effort: a failure now is a retry later.
  useEffect(() => startAtumAgentRegistration(), [])
  // Identity and sync serve Discover and training too. Roster visibility must
  // not control this account-wide subscription.
  useEffect(() => observeAgentSync(), [])
  useEffect(() => startWordCompanionLifecycle(), [])
  useEffect(() => startConversationContextLinks(), [])
  useEffect(() => startAtumAssistantDirectory(), [])

  useEffect(() => {
    void initializeAtumMessaging()
  }, [])

  useEffect(() => {
    if (gated) {
      setAuthVisible(true)
      setAuthExiting(false)

      return
    }

    if (!authVisible) {
      return
    }

    setAuthExiting(true)

    const timeout = window.setTimeout(() => {
      setAuthVisible(false)
      setAuthExiting(false)
    }, 150)

    return () => window.clearTimeout(timeout)
  }, [authVisible, gated])

  // A configured account stays inside the full-window auth flow until it is
  // genuinely usable. In particular, `signing_in` and `error` must not flash
  // the product shell between submitting credentials and reaching a terminal
  // result. `configured: false` remains a different fact — the local assistant
  // still works, while hosted DMs simply do not exist.
  // One cancel gesture does exactly one thing, resolved topmost-first: close
  // the roster drawer, else close the workspace drawer, else clear a non-empty
  // search. Never two at once. (The nav launcher's fan closes itself first,
  // in the capture phase, and marks the event handled.)
  useEffect(() => {
    if (gated) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) {
        return
      }

      if ($rosterDrawerOpen.get()) {
        event.preventDefault()
        setRosterDrawerOpen(false)
      } else if (!workspaceSuppressed && workspaceIsDrawer && $workspaceOpen.get()) {
        event.preventDefault()
        setWorkspaceOpen(false)
      } else if (!workspaceSuppressed && $workspaceExpanded.get() && $workspaceOpen.get()) {
        // Leave full frame before anything else: it is the surface in front.
        event.preventDefault()
        setWorkspaceExpanded(false)
      } else if ($rosterQuery.get()) {
        event.preventDefault()
        setRosterQuery('')
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [gated, workspaceIsDrawer, workspaceSuppressed])

  // Breakpoints change PRESENTATION only. Crossing into compact closes the
  // transient roster drawer (it has no inline meaning) but never touches
  // `$workspaceOpen`, so widening the window restores what the user had.
  useEffect(() => {
    if (!compact) {
      setRosterDrawerOpen(false)
    }
  }, [compact])

  if (gated || (authVisible && !authExiting)) {
    return <AtumAuthView />
  }

  return (
    <>
      <AtumShellFrame
        className={authExiting ? 'atum-shell-auth-entrance' : undefined}
        compact={compact}
        drawerOverlay={<AppViewOverlayHold />}
        main={workspaceMotion =>
          railDestination === 'discover' ? (
            <AtumDiscoverPanel />
          ) : (
            <AtumChatPanel covered={workspaceMotion.rendered && (workspaceFullFrame || workspaceIsDrawer)} />
          )
        }
        navigation={<AtumNavSwitch tray />}
        onCloseRosterDrawer={() => setRosterDrawerOpen(false)}
        overlay={
          authExiting ? (
            <div className="absolute inset-0 z-50">
              <AtumAuthView exiting />
            </div>
          ) : undefined
        }
        roster={<AtumRosterPanel
          drawer={compact}
          onNavigated={() => compact && setRosterDrawerOpen(false)}
          visible={compact ? rosterDrawerOpen : sidebarShowing}
        />}
        rosterDrawerCloseLabel={t.atum.chat.closeRoster}
        rosterDrawerLabel={t.atum.roster.title}
        rosterDrawerOpen={rosterDrawerOpen}
        sidebarShowing={sidebarShowing}
        workspace={workspaceMotion => (
          <Suspense fallback={<AtumWorkspacePlaceholder overFrame={workspaceIsDrawer || workspaceFullFrame} />}>
            <AtumWorkspacePanel
              drawer={workspaceIsDrawer}
              fullFrame={workspaceFullFrame}
              hidden={workspaceSuppressed || !workspaceMotion.rendered}
              motionPhase={workspaceMotion.phase}
              onMotionEnd={workspaceMotion.finishExit}
              workspace={workspace}
            />
          </Suspense>
        )}
        workspaceInSplit={workspaceInSplit}
        workspaceOpen={workspaceOpen}
        workspaceOverFrame={workspaceOverFrame}
        workspacePercent={workspacePercent}
      />
      <AtumPermissionPrePrompt />
      <AtumUsernameGate />
    </>
  )
}
