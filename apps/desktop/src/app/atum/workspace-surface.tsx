import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ATUM_WORKSPACE_MAX_PERCENT, ATUM_WORKSPACE_MIN_PERCENT } from '@/lib/atum-shell-geometry'
import { ArrowsDiagonal, ArrowsDiagonalMinimize, LayoutSidebarRight, Plus, X } from '@/lib/icons'
import { FOCUSED_LOCAL_TAB_CLOSE_EVENT } from '@/lib/local-tab-close'
import { cn } from '@/lib/utils'
import { holdAppViewOverlay } from '@/store/app-view-overlay'

export interface WorkspaceSurfaceTab {
  id: string
  title: string
  icon: ReactNode
  indicator?: ReactNode
  pinned?: boolean
}

/** Shared visual workbench. Account, tabs and file authority belong to its caller. */
export function AtumWorkspaceSurface({
  tabs,
  activeId,
  panelId,
  children,
  percent,
  onPercentChange,
  onActivate,
  onCloseTab,
  onAdd,
  onClose,
  onExpand,
  windowControls,
  hidden = false,
  drawer = false,
  fullFrame = false,
  motionPhase = 'open',
  onMotionEnd
}: {
  tabs: WorkspaceSurfaceTab[]
  activeId?: string
  panelId: string
  children: ReactNode
  percent: number
  onPercentChange(value: number): void
  onActivate(id: string): void
  onCloseTab(id: string): void
  onAdd?(): void
  onClose(): void
  onExpand(value: boolean): void
  windowControls?: ReactNode
  hidden?: boolean
  drawer?: boolean
  fullFrame?: boolean
  motionPhase?: 'entering' | 'open' | 'exiting'
  onMotionEnd?(): void
}) {
  const { t } = useI18n()
  const asideRef = useRef<HTMLElement>(null)
  const tablistRef = useRef<HTMLDivElement>(null)
  const resizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => resizeCleanup.current?.(), [])
  const active = tabs.find(tab => tab.id === activeId)
  const overFrame = drawer || fullFrame
  // A native app view sits above the DOM and cannot follow a CSS transform,
  // so it is detached while the drawer slides in or out. It must attach again
  // once the drawer has settled: at drawer widths this panel *is* where an
  // app view lives, and holding for as long as the drawer is mounted left
  // every app view permanently detached — a blank tab body, because the view
  // paints the content and the DOM has nothing to show in its place.
  // A layout effect, so the hold is taken before the drawer's transform
  // paints: a passive effect can leave one frame where the native view sits
  // still over a moving drawer.
  useLayoutEffect(
    () => (hidden || (drawer && motionPhase !== 'open') ? holdAppViewOverlay() : undefined),
    [hidden, drawer, motionPhase]
  )

  useEffect(() => {
    if (!drawer || hidden) {
      return
    }

    const previous = document.activeElement as HTMLElement | null
    asideRef.current?.focus()

    return () => previous?.focus()
  }, [drawer, hidden])

  useEffect(() => {
    const node = tablistRef.current

    if (!node) {
      return
    }

    const onClose = (event: Event) => {
      if (active && !active.pinned) {
        event.preventDefault()
        onCloseTab(active.id)
      }
    }

    node.addEventListener(FOCUSED_LOCAL_TAB_CLOSE_EVENT, onClose)

    return () => node.removeEventListener(FOCUSED_LOCAL_TAB_CLOSE_EVENT, onClose)
  }, [active, onCloseTab])

  const onTabsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
    const index = tabs.indexOf(event.target as HTMLButtonElement)
    const modifier = event.metaKey || event.ctrlKey

    if (modifier && !event.shiftKey && event.key.toLowerCase() === 't' && onAdd) {
      event.preventDefault()
      onAdd()

      return
    }

    if (modifier && !event.shiftKey && event.key.toLowerCase() === 'w' && active && !active.pinned) {
      event.preventDefault()
      onCloseTab(active.id)

      return
    }

    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return
    }

    event.preventDefault()

    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowLeft'
            ? (index - 1 + tabs.length) % tabs.length
            : (index + 1) % tabs.length

    tabs[next]?.focus()
    tabs[next]?.click()
  }

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeCleanup.current?.()
    const startX = event.clientX
    const startPercent = percent
    // The split is the whole main region: the sidebar column beside it has no
    // gutter any more, so nothing is subtracted from the measured width.
    const splitWidth = Math.max(1, asideRef.current?.parentElement?.getBoundingClientRect().width ?? 1)

    const onMove = (move: PointerEvent) =>
      onPercentChange(
        Math.max(
          ATUM_WORKSPACE_MIN_PERCENT,
          Math.min(ATUM_WORKSPACE_MAX_PERCENT, startPercent + ((startX - move.clientX) / splitWidth) * 100)
        )
      )

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    resizeCleanup.current = onUp
  }

  return (
    <>
      <aside
        aria-label={t.atum.workspace.title}
        className={cn(
          'relative flex shrink-0 flex-col overflow-hidden [-webkit-app-region:no-drag]',
          // Full-frame over the chat: narrow (mock 2g), or expanded by hand.
          hidden && '!hidden',
          overFrame && 'absolute inset-0 z-30'
        )}
        data-atum-drawer={drawer ? 'true' : 'false'}
        data-atum-full-frame={fullFrame ? 'true' : 'false'}
        data-atum-motion={motionPhase}
        data-atum-workspace
        // Covering the chat means covering its composer. Without this marker
        // type-to-focus, soft `/` and Enter keep reaching a composer nobody can
        // see, so keystrokes meant for the document land in the chat box.
        data-overlay-surface={overFrame ? '' : undefined}
        hidden={hidden}
        inert={hidden || undefined}
        onTransitionEnd={onMotionEnd}
        ref={asideRef}
        tabIndex={-1}
      >
        {!overFrame && (
          <div
            aria-label={t.atum.workspace.resize}
            aria-orientation="vertical"
            aria-valuemax={ATUM_WORKSPACE_MAX_PERCENT}
            aria-valuemin={ATUM_WORKSPACE_MIN_PERCENT}
            aria-valuenow={percent}
            className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize"
            onKeyDown={event => {
              const change = event.key === 'ArrowLeft' ? 2 : event.key === 'ArrowRight' ? -2 : 0

              if (change) {
                event.preventDefault()
                onPercentChange(
                  Math.max(ATUM_WORKSPACE_MIN_PERCENT, Math.min(ATUM_WORKSPACE_MAX_PERCENT, percent + change))
                )
              }
            }}
            onPointerDown={startResize}
            role="separator"
            tabIndex={0}
          />
        )}
        {/* The tab bar IS this column's top row, at the shell's one row height
            (`--atum-l-header`): tab 30 r9 13px muted, the active tab a glass
            chip with × inside, "+" opens the launcher; right cluster: expand,
            close panel. When the panel owns the frame (narrow, or expanded) it
            is the leftmost column, so the window controls lead it. The right
            padding reserves the native window-control overlay on Windows and
            Linux — this column is always the rightmost while it shows. */}
        <div
          className="flex h-(--atum-l-header) shrink-0 items-center gap-1.5 ps-3 pe-[max(0.625rem,var(--titlebar-tools-right,0.625rem))] [-webkit-app-region:drag]"
          data-atum-workspace-tabbar
          data-local-keybinds={`${tabs.length ? 'ctrl+w mod+w ' : ''}${onAdd ? 'ctrl+t mod+t' : ''}`.trim()}
          onKeyDown={onTabsKeyDown}
        >
          {overFrame && windowControls}
          <div
            aria-label={t.dm.artifact.tabsAria}
            // Preserve user-visible identity, state and recovery behavior across connection changes.
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]"
            ref={tablistRef}
            role="tablist"
          >
            {tabs.map(tab => {
              const title = tab.title
              const selected = tab.id === active?.id

              return (
                <div
                  className={cn(
                    'flex h-[1.875rem] max-w-52 shrink-0 items-center rounded-[var(--atum-r-tab)] text-[0.8125rem] [-webkit-app-region:no-drag]',
                    selected
                      ? 'atum-tab-active font-medium text-(--atum-ink)'
                      : 'text-(--atum-ink-muted) hover:bg-(--atum-sunk)'
                  )}
                  key={tab.id}
                >
                  <button
                    aria-controls={panelId}
                    aria-selected={selected}
                    className={cn(
                      'flex h-full min-w-0 items-center gap-2 ps-3',
                      selected && !tab.pinned ? 'pe-1' : 'pe-3'
                    )}
                    onClick={() => onActivate(tab.id)}
                    role="tab"
                    type="button"
                  >
                    {tab.icon}
                    <span className="truncate">{title}</span>
                    {tab.indicator}
                  </button>
                  {selected && !tab.pinned && (
                    <Tip label={`${t.atum.workspace.close}: ${title}`}>
                      <button
                        aria-label={`${t.atum.workspace.close}: ${title}`}
                        className="me-2 grid size-4 shrink-0 place-items-center rounded-full text-(--atum-ink-faint) hover:text-(--atum-ink)"
                        data-icon-only
                        onClick={() => onCloseTab(tab.id)}
                        type="button"
                      >
                        <X className="size-3" />
                      </button>
                    </Tip>
                  )}
                </div>
              )
            })}
            {onAdd && (
              <Tip label={t.atum.workspace.launcherAdd}>
                <button
                  aria-label={t.atum.workspace.launcherAdd}
                  className="atum-icon-btn relative size-7 shrink-0 after:absolute after:-inset-1"
                  data-atum-workspace-add
                  data-icon-only
                  onClick={onAdd}
                  type="button"
                >
                  <Plus className="size-4" />
                </button>
              </Tip>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
            {/* A narrow window is already full-frame and has no split to go back
                to, so the control is only offered where it means something. */}
            {!drawer && (
              <Tip label={fullFrame ? t.atum.workspace.collapse : t.atum.workspace.expand}>
                <button
                  aria-label={fullFrame ? t.atum.workspace.collapse : t.atum.workspace.expand}
                  aria-pressed={fullFrame}
                  className="atum-icon-btn relative size-7 after:absolute after:-inset-1"
                  data-atum-workspace-expand
                  data-icon-only
                  onClick={() => onExpand(!fullFrame)}
                  type="button"
                >
                  {fullFrame ? <ArrowsDiagonalMinimize className="size-4" /> : <ArrowsDiagonal className="size-4" />}
                </button>
              </Tip>
            )}
            <Tip label={t.atum.workspace.close}>
              <button
                aria-label={t.atum.workspace.close}
                className="atum-icon-btn relative size-7 after:absolute after:-inset-1"
                data-icon-only
                data-testid="atum-workspace-close"
                onClick={() => onClose()}
                type="button"
              >
                <LayoutSidebarRight className="size-[1.125rem]" />
              </button>
            </Tip>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden" id={panelId} role={active ? 'tabpanel' : 'region'}>
          {children}
        </div>
      </aside>
      {drawer && !hidden && (
        <button
          aria-label={t.atum.workspace.close}
          className="atum-drawer-scrim absolute inset-0 z-20"
          data-atum-motion={motionPhase}
          onClick={onClose}
          type="button"
        />
      )}
    </>
  )
}
