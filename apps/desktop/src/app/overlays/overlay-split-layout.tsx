import { Fragment, type ReactNode } from 'react'

import { TabDropdown } from '@/components/ui/tab-dropdown'
import { useI18n } from '@/i18n'
import type { IconComponent } from '@/lib/icons'
import { ChevronLeft } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { PAGE_INSET_X, PAGE_MAX_W } from '../layout-constants'

// The wide rail and the narrow dropdown swap at exactly the width where
// OverlaySplitLayout drops to a single column, so the rail never stacks.
const RAIL_HIDDEN = 'max-[47.5rem]:hidden'
const BAR_HIDDEN = 'hidden max-[47.5rem]:flex'

interface OverlaySplitLayoutProps {
  children: ReactNode
  className?: string
}

interface OverlaySidebarProps {
  children: ReactNode
  className?: string
}

interface OverlayMainProps {
  children: ReactNode
  className?: string
}

interface OverlayNavItemProps {
  active: boolean
  icon: IconComponent
  label: string
  // Renders as an indented child of another nav item: smaller icon and a
  // lighter active state so it never competes with the boxed parent item.
  nested?: boolean
  onClick: () => void
  trailing?: ReactNode
}

export function OverlaySplitLayout({ children, className }: OverlaySplitLayoutProps) {
  return (
    <div
      className={cn(
        // Narrow: one column, and pin rows to [nav-bar auto | main 1fr] — without
        // an explicit template the grid's default align-content:stretch splits the
        // height evenly across the two rows, shoving the content to mid-screen.
        'grid h-full min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)] overflow-hidden bg-transparent max-[47.5rem]:grid-cols-1 max-[47.5rem]:grid-rows-[auto_minmax(0,1fr)]',
        // Atum shell (mock 2b): the nav is the same 268px same-level glass
        // column as the sidebar, flush with the window's edge.
        'min-[47.5rem]:[[data-atum-overlay]_&]:grid-cols-[16.75rem_minmax(0,1fr)]',
        className
      )}
    >
      {children}
    </div>
  )
}

export function OverlaySidebar({ children, className }: OverlaySidebarProps) {
  return (
    <aside
      className={cn(
        // pt clears the in-card close button (the OverlayView now insets the
        // whole card below the OS titlebar); the bg fills from the card's top
        // edge so there's no surface-colored gap above the sidebar.
        'flex min-h-0 flex-col gap-0.5 overflow-y-auto bg-(--ui-sidebar-surface-background) px-2.5 pb-3 pt-[calc(var(--titlebar-height)/2+1rem)]',
        className
      )}
    >
      {children}
    </aside>
  )
}

export function OverlayMain({ children, className }: OverlayMainProps) {
  return (
    <main
      className={cn(
        // Narrow: the OverlayNav dropdown bar already clears the titlebar, so
        // drop the tall top pad to a normal gap below it.
        'mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-transparent pb-3 pt-[calc(var(--titlebar-height)/2+1rem)] max-[47.5rem]:pt-2',
        PAGE_MAX_W,
        PAGE_INSET_X,
        className
      )}
    >
      {children}
    </main>
  )
}

export function OverlayNavItem({ active, icon: Icon, label, nested, onClick, trailing }: OverlayNavItemProps) {
  return (
    <button
      className={cn(
        'flex h-7 w-full items-center justify-start gap-2 rounded-md border px-2 text-left text-[length:var(--conversation-text-font-size)] font-normal transition-colors',
        nested
          ? active
            ? 'border-transparent bg-(--chrome-action-hover) font-medium text-foreground'
            : 'border-transparent bg-transparent text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
          : active
            ? 'border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary) text-foreground'
            : 'border-transparent bg-transparent text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      )}
      onClick={onClick}
      type="button"
    >
      <Icon
        className={cn(
          'shrink-0',
          nested ? 'size-3.5' : 'size-4',
          active ? 'text-foreground/80' : 'text-muted-foreground/80'
        )}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
}

export interface OverlayNavLink {
  active: boolean
  icon: IconComponent
  id: string
  label: string
  onSelect: () => void
}

export interface OverlayNavGroup extends OverlayNavLink {
  /** Sub-links: expanded under the active group on the rail, always listed
   *  (flattened + indented) in the narrow dropdown. */
  children?: OverlayNavLink[]
  /** Visual break before this group — a spacer on the rail, a separator in
   *  the dropdown. */
  gapBefore?: boolean
}

// Data-driven pane nav: one model renders a persistent left rail on wide
// viewports and a single dropdown bar on narrow ones (matching the tab
// dropdown in PageSearchShell), so every OverlaySplitLayout pane degrades the
// same way instead of stacking its whole sidebar. Drop it in as the first
// child of an OverlaySplitLayout, before OverlayMain.
export interface OverlayNavAtum {
  onBack: () => void
  title: string
}

/**
 * Mock 2b left column: the shell's top row (the native lights live on it),
 * "Quay lại" row 36px, title 20/600, nav rows 36px r10 (current = hover fill),
 * and a visible Advanced destination. Rendered instead of the Hermes
 * rail when `atum` is given. The same-level sidebar material as the shell's
 * own column, so Settings does not float a plate the shell no longer has.
 */
function AtumOverlayNav({ atum, footer, groups }: { atum: OverlayNavAtum; footer?: ReactNode; groups: OverlayNavGroup[] }) {
  const { t } = useI18n()

  return (
    <aside
      className={cn('atum-sidebar flex min-h-0 flex-col overflow-hidden', RAIL_HIDDEN)}
      data-atum-settings-nav
    >
      <div aria-hidden className="h-(--atum-l-header) shrink-0 [-webkit-app-region:drag]" data-atum-traffic-lights />
      <button
        className="atum-row mx-3 mt-1 flex h-9 shrink-0 items-center gap-2 px-0 text-left text-[0.84375rem] font-medium text-(--atum-ink-muted) hover:text-(--atum-ink)"
        data-atum-settings-back
        onClick={atum.onBack}
        type="button"
      >
        <span className="grid size-7 place-items-center">
          <ChevronLeft aria-hidden className="size-[1.125rem]" />
        </span>
        {t.atum.settings.back}
      </button>
      <h2 className="px-5 pb-1.5 pt-4 text-[1.25rem] font-semibold tracking-[-0.02em] text-(--atum-ink)">{atum.title}</h2>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pt-2 text-[0.84375rem]">
        {groups.map(group => (
          <Fragment key={group.id}>
            {group.gapBefore && <div aria-hidden className="h-2" />}
            <button
              aria-current={group.active ? 'page' : undefined}
              className={cn('atum-row flex h-9 w-full shrink-0 items-center gap-2.5 px-2.5 text-left', group.active ? 'font-medium text-(--atum-ink)' : 'text-(--atum-ink-muted)')}
              onClick={group.onSelect}
              type="button"
            >
              <group.icon aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{group.label}</span>
            </button>
            {group.children && group.active && (
              <div className="ms-3.5 flex flex-col gap-0.5 ps-1.5">
                {group.children.map(child => (
                  <button
                    aria-current={child.active ? 'page' : undefined}
                    className={cn('atum-row flex h-8 w-full shrink-0 items-center gap-2.5 px-2.5 text-left text-[0.8125rem]', child.active ? 'font-medium text-(--atum-ink)' : 'text-(--atum-ink-muted)')}
                    key={child.id}
                    onClick={child.onSelect}
                    type="button"
                  >
                    <child.icon aria-hidden className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{child.label}</span>
                  </button>
                ))}
              </div>
            )}
          </Fragment>
        ))}
        {footer && <div className="mt-2 flex items-center gap-1">{footer}</div>}
      </div>
    </aside>
  )
}

export function OverlayNav({ atum, footer, groups }: { atum?: OverlayNavAtum; footer?: ReactNode; groups: OverlayNavGroup[] }) {
  if (atum) {
    return (
      <>
        <AtumOverlayNav atum={atum} footer={footer} groups={groups} />
        <OverlayNavBar footer={footer} groups={groups} />
      </>
    )
  }

  return (
    <>
      <OverlaySidebar className={RAIL_HIDDEN}>
        {groups.map(group => (
          <Fragment key={group.id}>
            {group.gapBefore && <div aria-hidden className="h-2" />}
            <OverlayNavItem active={group.active} icon={group.icon} label={group.label} onClick={group.onSelect} />
            {group.children && group.active && (
              <div className="ml-3.5 flex flex-col gap-0.5 pl-1.5">
                {group.children.map(child => (
                  <OverlayNavItem
                    active={child.active}
                    icon={child.icon}
                    key={child.id}
                    label={child.label}
                    nested
                    onClick={child.onSelect}
                  />
                ))}
              </div>
            )}
          </Fragment>
        ))}
        {footer && <div className="mt-auto flex items-center gap-1 pt-2">{footer}</div>}
      </OverlaySidebar>

      <OverlayNavBar footer={footer} groups={groups} />
    </>
  )
}

function OverlayNavBar({ footer, groups }: { footer?: ReactNode; groups: OverlayNavGroup[] }) {
  return (
    <>
      {/* Narrow: ride the OverlayView titlebar strip so the dropdown shares the
          close button's row instead of taking its own. The bar is
          pointer-events-none (children opt back in) so the floating X underneath
          stays clickable; pr clears it, no-drag beats the strip's drag region,
          and the height matches the strip so the trigger lines up with the X. */}
      <div
        className={cn(
          'pointer-events-none relative z-20 h-[calc(var(--titlebar-height)+0.1875rem)] items-center justify-between gap-2 pl-3 pr-12',
          BAR_HIDDEN
        )}
      >
        <div className="pointer-events-auto min-w-0 [-webkit-app-region:no-drag]">
          <TabDropdown
            align="start"
            items={groups.flatMap(group => [
              {
                active: group.active && !group.children?.some(child => child.active),
                icon: group.icon,
                id: group.id,
                label: group.label,
                onSelect: group.onSelect,
                separatorBefore: group.gapBefore
              },
              ...(group.children ?? []).map(child => ({
                active: child.active,
                icon: child.icon,
                id: child.id,
                indent: true,
                label: child.label,
                onSelect: child.onSelect
              }))
            ])}
          />
        </div>
        {footer && (
          <div className="pointer-events-auto flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
            {footer}
          </div>
        )}
      </div>
    </>
  )
}
