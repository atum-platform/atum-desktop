/*
 * Adapted from Block Buzz at c2210b45bb6f539f1d236d18b284c16566e70602:
 * ResizableSidebar, ResizeHandle, SidebarFrame, SidebarList, SidebarSection,
 * ChannelSidebarRow and FadingLabel. Apache-2.0.
 *
 * Atum changes: Matrix/company-neutral props, Atum primitives/tokens, scoped
 * local presentation storage, and no Buzz relay, Tauri, plugin or Cordis state.
 */

import {
  type ComponentProps,
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'

import { Button } from '@/components/ui/button'
import { ChevronDown, Plus } from '@/lib/icons'

import styles from './team-space-sidebar.module.css'

export const TEAM_SPACE_SIDEBAR_DEFAULT_WIDTH = 268
export const TEAM_SPACE_SIDEBAR_MIN_WIDTH = 220
export const TEAM_SPACE_SIDEBAR_MAX_WIDTH = 420

function clampWidth(width: number): number {
  return Math.min(TEAM_SPACE_SIDEBAR_MAX_WIDTH, Math.max(TEAM_SPACE_SIDEBAR_MIN_WIDTH, Math.round(width)))
}

function storageKey(scope: string): string {
  return `atum.team-space.sidebar-width:${scope}`
}

function readWidth(scope: string): number {
  try {
    const value = Number.parseFloat(window.localStorage.getItem(storageKey(scope)) ?? '')

    return Number.isFinite(value) ? clampWidth(value) : TEAM_SPACE_SIDEBAR_DEFAULT_WIDTH
  } catch {
    return TEAM_SPACE_SIDEBAR_DEFAULT_WIDTH
  }
}

function saveWidth(scope: string, width: number): void {
  try {
    window.localStorage.setItem(storageKey(scope), String(clampWidth(width)))
  } catch {
    // Resizing remains available for this mounted window when persistence fails.
  }
}

export function TeamSpaceSidebar({ children, compactFull = false, footer, header, hidden = false, label, resizeLabel, scope }: {
  children: ReactNode
  compactFull?: boolean
  footer?: ReactNode
  /** Slack's workspace header: pinned over the sections, never scrolled away with them. */
  header?: ReactNode
  hidden?: boolean
  label: string
  resizeLabel: string
  scope: string
}) {
  const frame = useRef<HTMLElement>(null)
  const [view, setView] = useState(() => ({ scope, width: readWidth(scope) }))

  useEffect(() => {
    if (view.scope !== scope) {setView({ scope, width: readWidth(scope) })}
  }, [scope, view.scope])

  const width = view.scope === scope ? view.width : readWidth(scope)

  const resize = useCallback((next: number) => {
    const value = clampWidth(next)
    saveWidth(scope, value)
    setView({ scope, width: value })
  }, [scope])

  // Atum Kit frame (FlowTeamSpace): this sidebar is the roster panel, so the title bar's name and
  // the main card start past it, as they start past the chat roster. Its width is the user's.
  const besideCard = !hidden && !compactFull

  useLayoutEffect(() => {
    const main = frame.current?.closest<HTMLElement>('[data-atum-main]')

    if (!main || !besideCard) {return}

    main.style.setProperty('--atum-team-roster', `${width}px`)
    main.dataset.atumTeamRoster = ''

    return () => {
      main.style.removeProperty('--atum-team-roster')
      delete main.dataset.atumTeamRoster
    }
  }, [besideCard, width])

  return (
    <>
      <aside aria-label={label} className={styles.frame} data-compact-full={compactFull || undefined}
        data-matrix-company-sidebar hidden={hidden} ref={frame} style={{ width }}>
        {header && <div className={styles.header} data-team-space-sidebar-header>{header}</div>}
        <div className={styles.body}>
          <nav className={styles.list}>{children}</nav>
        </div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </aside>
      <TeamSpaceResizeHandle hidden={hidden || compactFull} label={resizeLabel} panel={frame}
        reset={() => resize(TEAM_SPACE_SIDEBAR_DEFAULT_WIDTH)} setWidth={resize} width={width} />
    </>
  )
}

function TeamSpaceResizeHandle({ hidden, label, panel, reset, setWidth, width }: {
  hidden: boolean
  label: string
  panel: React.RefObject<HTMLElement | null>
  reset(): void
  setWidth(width: number): void
  width: number
}) {
  const handle = useRef<HTMLHRElement>(null)
  const [renderedWidth, setRenderedWidth] = useState(width)

  const drag = useRef<{
    frame?: number
    moved: boolean
    next: number
    pointerId: number
    startWidth: number
    startX: number
  } | undefined>(undefined)

  const measure = useCallback(() => {
    const next = Math.round(panel.current?.getBoundingClientRect().width ?? width)
    setRenderedWidth(current => current === next ? current : next)
  }, [panel, width])

  useLayoutEffect(() => {
    const element = panel.current

    if (!element || typeof ResizeObserver === 'undefined') {return}

    const observer = new ResizeObserver(measure)
    observer.observe(element)

    return () => observer.disconnect()
  }, [measure, panel])

  const move = useCallback((event: PointerEvent) => {
    const active = drag.current

    if (!active || active.pointerId !== event.pointerId) {return}

    event.preventDefault()
    active.moved ||= event.clientX !== active.startX
    active.next = clampWidth(active.startWidth + event.clientX - active.startX)
    active.frame ??= requestAnimationFrame(() => {
      active.frame = undefined
      panel.current?.style.setProperty('width', `${active.next}px`)
      setRenderedWidth(active.next)
    })
  }, [panel])

  const finish = useCallback((event?: Event) => {
    const active = drag.current

    if (!active || (event && 'pointerId' in event && event.pointerId !== active.pointerId)) {return}

    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    window.removeEventListener('blur', finish)

    if (active.frame !== undefined) {cancelAnimationFrame(active.frame)}

    const committed = event?.type === 'pointerup' && active.moved ? active.next : width
    panel.current?.style.setProperty('width', `${committed}px`)

    if (event?.type === 'pointerup' && active.moved) {setWidth(active.next)}

    drag.current = undefined
    handle.current?.removeAttribute('data-resizing')
    document.documentElement.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
  }, [move, panel, setWidth, width])

  useEffect(() => () => finish(), [finish])

  return (
    <hr aria-label={label} aria-orientation="vertical" aria-valuemax={TEAM_SPACE_SIDEBAR_MAX_WIDTH}
      aria-valuemin={TEAM_SPACE_SIDEBAR_MIN_WIDTH} aria-valuenow={renderedWidth} className={styles.handle}
      hidden={hidden} onDoubleClick={reset} onKeyDown={event => {
        const step = event.shiftKey ? 48 : 16

        if (event.key === 'ArrowLeft') {setWidth(renderedWidth - step)}
        else if (event.key === 'ArrowRight') {setWidth(renderedWidth + step)}
        else if (event.key === 'Home') {setWidth(TEAM_SPACE_SIDEBAR_MIN_WIDTH)}
        else if (event.key === 'End') {setWidth(TEAM_SPACE_SIDEBAR_MAX_WIDTH)}
        else {return}

        event.preventDefault()
      }} onPointerDown={event => {
        if (event.button !== 0 || drag.current || !panel.current) {return}

        event.preventDefault()
        const startWidth = panel.current.getBoundingClientRect().width
        drag.current = { moved: false, next: startWidth, pointerId: event.pointerId, startWidth, startX: event.clientX }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
        window.addEventListener('blur', finish)
        event.currentTarget.setAttribute('data-resizing', '')
        document.documentElement.style.cursor = 'ew-resize'
        document.body.style.userSelect = 'none'
      }} ref={handle} role="separator" tabIndex={0} />
  )
}

export function TeamSpaceSidebarSection({ action, children, defaultOpen = true, title }: {
  action?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  title: string
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className={styles.section} data-team-space-sidebar-section>
      <div className={styles.sectionHeader}>
        <button aria-expanded={open} className={styles.sectionToggle} onClick={() => setOpen(value => !value)}
          type="button">
          <ChevronDown aria-hidden className={styles.sectionChevron} />
          <FadingLabel>{title}</FadingLabel>
        </button>
        {action && <span className={styles.sectionAction} data-team-space-section-action>{action}</span>}
      </div>
      {open && <div className={styles.sectionContent}>{children}</div>}
    </section>
  )
}

export function TeamSpaceSidebarRow({ ariaLabel, disabled = false, icon, label, onPrepare, onSelect, selected = false,
    trailing, unread = false }: {
  ariaLabel?: string
  disabled?: boolean
  icon?: ReactNode
  label: string
  onPrepare?: () => void
  onSelect(): void
  selected?: boolean
  trailing?: ReactNode
  /** Something is waiting here: the label is bold, as in the personal chat list. */
  unread?: boolean
}) {
  return (
    <div className={styles.row} data-selected={selected || undefined} data-team-space-sidebar-row
      data-unread={unread || undefined}>
      <Button aria-current={selected ? 'page' : undefined} aria-label={ariaLabel} className={styles.rowButton} disabled={disabled}
        onClick={onSelect} onFocus={onPrepare} onPointerEnter={onPrepare} size="sm" variant="ghost">
        <span aria-hidden className={styles.rowIcon}>{icon}</span>
        <FadingLabel className={styles.rowLabel}>{label}</FadingLabel>
        {trailing && <span className={styles.rowTrailing}>{trailing}</span>}
      </Button>
    </div>
  )
}

/** Slack's last row of a section ("+ Add channels", "+ Add teammates"): a bare plus, muted words (Atum Kit 0.1). */
export const TeamSpaceSidebarAddRow = forwardRef<HTMLButtonElement, ComponentProps<'button'> & { label: string }>(
  function TeamSpaceSidebarAddRow({ label, ...props }, ref) {
    return (
      <div className={styles.row} data-team-space-sidebar-add-row>
        <button className={styles.addRow} ref={ref} type="button" {...props}>
          <span aria-hidden className={styles.addTile}><Plus /></span>
          <FadingLabel className={styles.rowLabel}>{label}</FadingLabel>
        </button>
      </div>
    )
  }
)

export function FadingLabel({ children, className }: { children: ReactNode; className?: string }) {
  const label = useRef<HTMLSpanElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const element = label.current

    if (!element) {return}

    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth)
    measure()
    const mutations = new MutationObserver(measure)
    mutations.observe(element, { characterData: true, childList: true, subtree: true })
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)

    return () => {
      mutations.disconnect()
      observer?.disconnect()
    }
  }, [])

  return <span className={className} data-overflowing={overflowing || undefined} ref={label}>{children}</span>
}
