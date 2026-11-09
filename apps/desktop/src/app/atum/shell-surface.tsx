import { Fragment, type ReactNode } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { ATUM_TITLEBAR_LIGHTS_CONTENT_RESERVATION } from '@/lib/atum-shell-geometry'
import { Briefcase, Compass, Folder, LayoutSidebar, MessageCircle } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { type SurfaceId, type SurfaceSet, type SurfaceState } from '@/store/surfaces'

export type AtumShellDestination = 'chat' | 'discover' | 'workplace' | 'drive'

export interface AtumMainHeaderSurfaceProps extends React.ComponentProps<'div'> {
  actions?: ReactNode
  leadsRow: boolean
  reserveOverlay: boolean
  windowControls?: ReactNode
}

/** Layout-only header leaf for product shells that do not use Atum state. */
export function AtumMainHeaderSurface({
  actions,
  children,
  className,
  leadsRow,
  reserveOverlay,
  windowControls,
  ...props
}: AtumMainHeaderSurfaceProps) {
  return (
    <div
      className={cn(
        'flex h-(--atum-l-header) shrink-0 items-center gap-3 ps-3 [-webkit-app-region:drag]',
        reserveOverlay ? 'pe-[max(0.75rem,var(--titlebar-tools-right,0.75rem))]' : 'pe-3',
        className
      )}
      data-atum-main-header
      {...props}
    >
      {leadsRow && <div className="flex shrink-0 items-center">{windowControls}</div>}
      <div className="flex min-w-0 flex-1 items-center justify-start">
        {children}
        {/* A page's status beside its name (Drive: "Up to date"). */}
        <div className="ms-2 flex min-w-0 items-center empty:hidden" data-atum-page-status />
      </div>
      <div className="flex min-w-0 items-center justify-end gap-0.5 [-webkit-app-region:no-drag]">
        {/* A page's own title-bar controls (the Store's balance) mount here (Atum Kit: the title
            bar belongs to the page). */}
        <div className="flex items-center empty:hidden" data-atum-page-actions />
        {actions}
      </div>
    </div>
  )
}

export interface AtumWindowControlsSurfaceProps {
  reserveLights: boolean
  sidebarLabel: string
  onToggleSidebar(): void
  showSidebarToggle?: boolean
  className?: string
}

/** Layout-only native-control reservation and sidebar-toggle leaf. */
export function AtumWindowControlsSurface({
  className,
  onToggleSidebar,
  reserveLights,
  sidebarLabel,
  showSidebarToggle = true
}: AtumWindowControlsSurfaceProps) {
  return (
    <div className={cn('flex shrink-0 items-center gap-2', className)} data-atum-window-controls>
      {reserveLights && (
        <span
          aria-hidden
          className="block h-3.5 shrink-0"
          data-atum-traffic-lights
          style={{ width: ATUM_TITLEBAR_LIGHTS_CONTENT_RESERVATION }}
        />
      )}
      {/* Stay in the titlebar band: a bottom tip overlaps native document
          content when Escape returns focus from the compact roster. */}
      {showSidebarToggle && (
        <Tip label={sidebarLabel} side="right">
          <button
            aria-label={sidebarLabel}
            className="atum-icon-btn relative size-7 shrink-0 after:absolute after:-inset-1 [-webkit-app-region:no-drag]"
            data-atum-sidebar-toggle
            data-icon-only
            onClick={onToggleSidebar}
            type="button"
          >
            <LayoutSidebar aria-hidden className="size-[1.125rem]" />
          </button>
        </Tip>
      )}
    </div>
  )
}

export interface SurfaceStatusCopy {
  comingSoon: string
  comingSoonHelp: string
  needsSetup: string
  needsUpdate: string
  needsUpdateHelp: string
}

export interface AtumNavSwitchSurfaceProps {
  /** Matrix's complete projection. Other shells retain their explicit presentation props. */
  surfaces?: SurfaceSet
  surfaceCopy?: SurfaceStatusCopy
  ariaLabel: string
  destination: AtumShellDestination
  homeLabel: string
  discoverLabel: string
  /** Canonical shells opt in to the integrated Drive destination. */
  driveLabel?: string
  /** When present, Discover remains visible but cannot become an active destination. */
  disabledDiscoverLabel?: string
  /**
   * A shell that passes this keeps Workplace (the Team space) as a visible, coming-soon
   * future destination. Without it an unavailable Workplace is not drawn at all, so a
   * shell that hides it has to say so by leaving this out.
   */
  workplaceSoonLabel?: string
  workplaceLabel?: string
  workplaceAvailable?: boolean
  /** Something waits in Workplace: a count of mentions, else a dot. `label` names it for assistive tech. */
  workplaceBadge?: { mentions: number; label: string }
  onDestinationChange(destination: AtumShellDestination): void
  tray?: boolean
}

const NAV_PLACES = {
  home: { destination: 'chat', Icon: MessageCircle, marker: 'data-atum-nav-home' },
  drive: { destination: 'drive', Icon: Folder, marker: 'data-atum-nav-drive' },
  discover: { destination: 'discover', Icon: Compass, marker: 'data-atum-nav-discover' },
  teamSpace: { destination: 'workplace', Icon: Briefcase, marker: 'data-atum-nav-workplace' }
} as const

/** The rail's order (Atum Kit mockups): Chats, Store, Drive, then Team space after the divider.
 *  SURFACE_IDS keeps the platform's order; only the drawing follows this one. */
const RAIL_ORDER: readonly SurfaceId[] = ['home', 'discover', 'drive', 'teamSpace']

/** Presentation-only destination switch for a shell with its own navigation state. */
export function AtumNavSwitchSurface({
  ariaLabel,
  destination,
  disabledDiscoverLabel,
  discoverLabel,
  driveLabel,
  homeLabel,
  onDestinationChange,
  surfaceCopy = {
    comingSoon: 'Coming soon',
    comingSoonHelp: 'This place is not ready yet.',
    needsSetup: 'Set up',
    needsUpdate: 'Update required',
    needsUpdateHelp: 'Update Atum to open this place.'
  },
  surfaces,
  tray = false,
  workplaceAvailable = false,
  workplaceBadge,
  workplaceLabel,
  workplaceSoonLabel
}: AtumNavSwitchSurfaceProps) {
  const labels: Record<SurfaceId, string> = {
    home: homeLabel,
    drive: driveLabel ?? 'Drive',
    discover: discoverLabel,
    teamSpace: workplaceLabel ?? 'Workplace'
  }

  const legacyStates: Record<SurfaceId, SurfaceState> = {
    home: 'on',
    drive: driveLabel ? 'on' : 'hidden',
    discover: disabledDiscoverLabel ? 'coming_soon' : 'on',
    teamSpace: workplaceAvailable ? 'on' : workplaceSoonLabel ? 'coming_soon' : 'hidden'
  }

  const item = (id: SurfaceId, state: SurfaceState) => {
    const { destination: target, Icon, marker } = NAV_PLACES[id]
    const unavailable = state === 'coming_soon' || state === 'needs_update'

    const status =
      state === 'coming_soon'
        ? surfaceCopy.comingSoon
        : state === 'needs_update'
          ? surfaceCopy.needsUpdate
          : state === 'needs_setup'
            ? surfaceCopy.needsSetup
            : ''

    const badge = id === 'teamSpace' && !unavailable ? workplaceBadge : undefined

    const label = badge
      ? `${labels[id]} · ${badge.label}${badge.mentions > 0 ? `: ${badge.mentions}` : ''}`
      : state === 'coming_soon' && id === 'teamSpace' && workplaceSoonLabel
        ? workplaceSoonLabel
        : state === 'coming_soon' && id === 'discover' && disabledDiscoverLabel
          ? disabledDiscoverLabel
          : status
            ? `${labels[id]} · ${status}`
            : labels[id]

    const current = destination === target && !unavailable

    const button = (
      <button
        aria-current={current ? 'page' : undefined}
        aria-disabled={unavailable ? 'true' : undefined}
        aria-label={label}
        className="atum-nav-item relative"
        data-icon-only
        data-surface-state={state}
        onClick={() => {
          if (!unavailable) {
            onDestinationChange(target)
          }
        }}
        type="button"
        {...{ [marker]: true }}
      >
        {/* The place you are in draws its glyph solid (Phosphor Fill), as in the mockups. */}
        <Icon aria-hidden className={cn('size-4', current && 'fill-current')} />
        {badge && (
          <span
            aria-hidden
            className={cn(
              'absolute grid place-items-center rounded-full text-[0.5625rem] leading-none font-semibold text-(--atum-on-accent)',
              badge.mentions > 0
                ? 'top-0 right-0 h-3.5 min-w-3.5 bg-(--atum-danger) px-1'
                : 'top-1 right-1 size-2 bg-(--atum-ink)'
            )}
            data-atum-nav-badge={badge.mentions > 0 ? 'mention' : 'unread'}
          >
            {badge.mentions > 0 ? (badge.mentions > 99 ? '99+' : badge.mentions) : null}
          </span>
        )}
      </button>
    )

    return unavailable ? (
      <Popover>
        <Tip label={label} side="right" sideOffset={8}>
          <PopoverTrigger asChild>{button}</PopoverTrigger>
        </Tip>
        <PopoverContent
          className="atum-popover w-60"
          onOpenAutoFocus={event => event.preventDefault()}
          side="right"
          sideOffset={8}
        >
          <p className="text-sm font-medium">{status}</p>
          <p className="mt-1 text-sm text-(--atum-ink-muted)">
            {state === 'coming_soon' ? surfaceCopy.comingSoonHelp : surfaceCopy.needsUpdateHelp}
          </p>
        </PopoverContent>
      </Popover>
    ) : (
      <Tip label={label} side="right" sideOffset={8}>
        {button}
      </Tip>
    )
  }

  return (
    <nav
      aria-label={ariaLabel}
      className={`${tray ? 'atum-nav-tray' : 'atum-nav-switch'} [-webkit-app-region:no-drag]`}
      data-atum-nav-switch
      data-atum-nav-tray={tray ? true : undefined}
    >
      {RAIL_ORDER.map(id => {
        const state = surfaces?.[id].state ?? legacyStates[id]

        return state === 'hidden' ? null : (
          <Fragment key={id}>
            {id === 'teamSpace' && <span aria-hidden className="atum-nav-divider" />}
            {item(id, state)}
          </Fragment>
        )
      })}
    </nav>
  )
}
