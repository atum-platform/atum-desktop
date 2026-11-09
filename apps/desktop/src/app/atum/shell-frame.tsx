import { FocusScope } from '@radix-ui/react-focus-scope'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { prefersReducedMotion } from '@/hooks/use-reduced-motion'
import { ATUM_DESTINATION_RAIL_WIDTH, ATUM_ROSTER_WIDTH } from '@/lib/atum-shell-geometry'

type MotionPhase = 'entering' | 'open' | 'exiting'

export interface AtumShellFrameMotion {
  finishExit(): void
  phase: MotionPhase
  rendered: boolean
}

export interface AtumShellFrameProps {
  /** Root-owned state; this frame only turns it into geometry. */
  compact: boolean
  sidebarShowing: boolean
  rosterDrawerOpen: boolean
  workspaceOpen: boolean
  workspaceInSplit: boolean
  workspaceOverFrame: boolean
  workspacePercent: number
  /** One stable subtree: visibility/layout changes must not reset in-flight UI. */
  roster: ReactNode
  /** Caller supplies local app-view protection while its drawer is modal. */
  drawerOverlay?: ReactNode
  /** Chat/Discover slot; it stays mounted beneath a full-frame workspace. */
  main: (workspaceMotion: AtumShellFrameMotion) => ReactNode
  /** The native workspace or an app-specific replacement. */
  workspace?: (workspaceMotion: AtumShellFrameMotion) => ReactNode
  /** Persistent destination rail. It stays available beside roster, chat and workspace. */
  navigation?: ReactNode
  /** Presentation-only overlay, such as the departing auth surface. */
  overlay?: ReactNode
  rosterDrawerCloseLabel: string
  rosterDrawerLabel: string
  onCloseRosterDrawer(): void
  className?: string
}

function useMotionPresence(open: boolean, exitMs: number): AtumShellFrameMotion {
  const [rendered, setRendered] = useState(open)
  const [phase, setPhase] = useState<MotionPhase>('open')
  const frame = useRef(0)

  useEffect(() => {
    window.cancelAnimationFrame(frame.current)

    if (open) {
      setRendered(true)
      setPhase('entering')
      frame.current = window.requestAnimationFrame(() => setPhase('open'))

      return () => window.cancelAnimationFrame(frame.current)
    }

    if (!rendered) {
      return
    }

    if (prefersReducedMotion()) {
      setRendered(false)

      return
    }

    setPhase('exiting')
    const timeout = window.setTimeout(() => setRendered(false), exitMs)

    return () => window.clearTimeout(timeout)
  }, [exitMs, open, rendered])

  return {
    finishExit: () => {
      if (!open && phase === 'exiting') {
        setRendered(false)
      }
    },
    phase,
    rendered
  }
}

/**
 * Pure product-shell presentation: persistent destination rail, a same-level
 * 268px roster and main columns, compact roster drawer, and an optional split/full-frame
 * workspace. It owns no account, auth, gateway, or application state.
 */
export function AtumShellFrame({
  className,
  compact,
  drawerOverlay,
  main,
  navigation,
  onCloseRosterDrawer,
  overlay,
  roster,
  rosterDrawerCloseLabel,
  rosterDrawerLabel,
  rosterDrawerOpen,
  sidebarShowing,
  workspace,
  workspaceInSplit,
  workspaceOpen,
  workspaceOverFrame,
  workspacePercent
}: AtumShellFrameProps) {
  const sidebarMotion = useMotionPresence(!compact && sidebarShowing, 280)
  const rosterDrawerMotion = useMotionPresence(compact && rosterDrawerOpen, 280)
  const workspaceMotion = useMotionPresence(workspaceOpen, 280)
  const [workspaceMounted, setWorkspaceMounted] = useState(workspaceOpen)

  useEffect(() => {
    if (workspaceOpen) {
      setWorkspaceMounted(true)
    }
  }, [workspaceOpen])

  const drawerOpen = compact && rosterDrawerOpen
  const rosterInFlow = !compact && sidebarShowing
  // The roster occupies the row until its exit motion ends; only then does the
  // main panel become the first panel after the rail (rounded corner, rail edge).
  const rosterOccupiesRow = !compact && sidebarMotion.rendered
  const rosterMotion = compact ? rosterDrawerMotion : sidebarMotion
  const rosterRef = useRef<HTMLDivElement>(null)

  // The roster stays mounted across breakpoints. Radix owns trapping, tab
  // looping and nested focus scopes; entry/return follows drawer visibility,
  // not subtree mount/unmount (which would discard pending roster work).
  useEffect(() => {
    if (!drawerOpen || !rosterMotion.rendered) {
      return
    }

    const previous = document.activeElement
    const node = rosterRef.current
    node?.focus({ preventScroll: true })

    return () => {
      const active = document.activeElement

      // Widening keeps the roster interactive. Closing may also deliberately
      // focus a destination; only recover focus lost inside a now-hidden roster.
      if (
        node?.isConnected &&
        node.hasAttribute('inert') &&
        (active === document.body || node.contains(active)) &&
        previous instanceof HTMLElement &&
        previous.isConnected &&
        !previous.closest('[inert]')
      ) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [drawerOpen, rosterMotion.rendered])

  return (
    <main
      // Preserve user-visible identity, state and recovery behavior across connection changes.
      // root `no-drag` reached every layer under it, and a transparent full-window layer (a pet's
      // stroll) painted over the title strip then cancelled the headers' drag. Only the title rows
      // drag; their controls and the rail opt out.
      className={`atum-shell relative flex h-dvh min-h-[520px] overflow-hidden text-(--atum-ink) ${className ?? ''}`}
      data-atum-rail={navigation ? true : undefined}
      data-atum-roster-flow={rosterOccupiesRow ? true : undefined}
      data-atum-shell
    >
      {navigation && (
        <div
          className="atum-destination-rail relative z-30 flex shrink-0 flex-col [-webkit-app-region:no-drag]"
          data-atum-destination-rail
          inert={drawerOpen ? true : undefined}
          style={{ width: ATUM_DESTINATION_RAIL_WIDTH }}
        >
          {navigation}
        </div>
      )}

      <FocusScope
        asChild
        loop={drawerOpen}
        onMountAutoFocus={event => event.preventDefault()}
        onUnmountAutoFocus={event => event.preventDefault()}
        trapped={drawerOpen}
      >
        <div
          aria-label={drawerOpen ? rosterDrawerLabel : undefined}
          aria-modal={drawerOpen ? true : undefined}
          className={compact ? 'absolute inset-y-0 left-0 z-50 flex' : 'flex min-h-0 shrink-0 overflow-hidden'}
          data-atum-motion={rosterMotion.phase}
          data-atum-roster-drawer={compact ? true : undefined}
          data-atum-roster-slot={!compact ? true : undefined}
          inert={!rosterInFlow && !drawerOpen ? true : undefined}
          onKeyDown={event => {
            if (drawerOpen && event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing) {
              event.preventDefault()
              onCloseRosterDrawer()
            }
          }}
          onTransitionEnd={event => {
            // The wide host animates width; the compact roster child animates
            // transform. Ignore bubbled transitions from controls inside it.
            const target = compact
              ? event.currentTarget.querySelector(':scope > [data-atum-roster]')
              : event.currentTarget

            if (event.target === target && event.propertyName === (compact ? 'transform' : 'width')) {
              rosterMotion.finishExit()
            }
          }}
          ref={rosterRef}
          role={drawerOpen ? 'dialog' : undefined}
          style={{
            display: rosterMotion.rendered ? undefined : 'none',
            width: compact ? undefined : rosterMotion.phase === 'open' ? ATUM_ROSTER_WIDTH : 0
          }}
        >
          {roster}
        </div>
      </FocusScope>

      <div
        className="atum-main-column relative flex min-w-0 flex-1 flex-col"
        data-atum-main
        data-atum-workspace-over-frame={workspaceOverFrame ? true : undefined}
        inert={drawerOpen ? true : undefined}
      >
        {/* The whole top strip moves and zooms the window, the gaps between the cards too: a drag
            band behind the columns, whose own title rows sit over it. Not while the compact roster
            drawer covers this column, so the drawer's buttons stay pressable. */}
        {!drawerOpen && (
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 -z-10 h-(--atum-l-header) [-webkit-app-region:drag]"
            data-atum-titlebar-drag
          />
        )}
        <div
          className="relative grid min-h-0 flex-1"
          data-atum-main-split
          data-pet-stage-root
          style={{
            gridTemplateColumns:
              workspaceInSplit && workspaceMotion.rendered
                ? `minmax(0, ${100 - workspacePercent}fr) minmax(0, ${workspacePercent}fr)`
                : 'minmax(0, 1fr) minmax(0, 0fr)'
          }}
        >
          {main(workspaceMotion)}
          {workspaceMounted && workspace?.(workspaceMotion)}
        </div>
      </div>

      {compact && rosterDrawerMotion.rendered && (
        <>
          {drawerOverlay}
          <button
            aria-label={rosterDrawerCloseLabel}
            className="atum-drawer-scrim absolute inset-0 z-40"
            data-atum-motion={rosterDrawerMotion.phase}
            inert={rosterDrawerMotion.phase === 'exiting' ? true : undefined}
            onClick={onCloseRosterDrawer}
            type="button"
          />
        </>
      )}

      {overlay}
    </main>
  )
}
