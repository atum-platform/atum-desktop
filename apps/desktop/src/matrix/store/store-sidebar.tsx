import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { ProtonMark } from '@/components/brand/proton-mark'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { CheckCircle2, Compass, Monitor, PawPrint, Settings, Sparkles, UserCircle } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { MatrixPanelSearch, MatrixPanelSearchRow } from '../panel-search'
import { plusMenuCopy } from '../plus-menu'

import { matrixStoreCopy } from './store-copy'
import { $matrixStoreShelfRequest, type DiscoverShelf } from './top-up'

const STORE_SIDEBAR_SHELVES = [
  { id: 'featured', Icon: Compass },
  { id: 'skills', Icon: Sparkles },
  { id: 'agents', Icon: UserCircle },
  { id: 'apps', Icon: Monitor },
  { id: 'pets', Icon: PawPrint },
  { id: 'purchased', Icon: CheckCircle2 }
] as const satisfies ReadonlyArray<{ id: Exclude<DiscoverShelf, 'topups'>; Icon: typeof Compass }>

export interface MatrixStoreNavigation {
  query: string
  shelf: DiscoverShelf
  onQueryChange(query: string): void
  onShelfChange(shelf: DiscoverShelf): void
}

/**
 * The shell owns Store presentation state because both its roster and content consume it.
 * An external request is spent only once the Store is really visible, so a failed destination
 * change cannot lose a requested shelf or top-up.
 */
export function useMatrixStoreNavigation({
  active,
  appsAvailable,
  checkoutAvailable,
  storeUnavailable
}: {
  active: boolean
  appsAvailable: boolean
  checkoutAvailable: boolean
  storeUnavailable: boolean
}): MatrixStoreNavigation {
  const request = useStore($matrixStoreShelfRequest)
  const [shelf, setShelf] = useState<DiscoverShelf>('featured')
  const [query, setQuery] = useState('')
  const wasOpen = useRef(false)

  useEffect(() => {
    const entering = active && !wasOpen.current
    wasOpen.current = active

    if (!active) {
      return
    }

    if (request) {
      if (request !== 'topups' || checkoutAvailable) {
        setShelf(request)
      }

      $matrixStoreShelfRequest.set(null)

      return
    }

    if (entering) {
      setQuery('')
      setShelf(storeUnavailable && appsAvailable ? 'apps' : 'featured')
    }
  }, [active, appsAvailable, checkoutAvailable, request, storeUnavailable])

  return { onQueryChange: setQuery, onShelfChange: setShelf, query, shelf }
}

interface MatrixStoreSidebarProps extends MatrixStoreNavigation {
  compact?: boolean
  /** The foot's Top up (the same top-up Settings → Protons opens). No balance is shown. */
  onTopUp?(): void
  /** The foot's gear. */
  onOpenSettings?(): void
  /** The title bar's ← →, while this column leads the window's row. */
  titleBarAction?: ReactNode
  windowControls?: ReactNode
}

/** Store navigation replaces the conversation roster while the Store is the active destination. */
export function MatrixStoreSidebar({
  compact = false,
  onOpenSettings,
  onQueryChange,
  onTopUp,
  onShelfChange,
  query,
  shelf,
  titleBarAction,
  windowControls
}: MatrixStoreSidebarProps) {
  const { locale } = useI18n()
  const copy = matrixStoreCopy(locale)
  const foot = plusMenuCopy(locale)

  const labels: Record<Exclude<DiscoverShelf, 'topups'>, string> = {
    featured: copy.discover,
    agents: copy.agents,
    skills: copy.skills,
    pets: copy.pets,
    apps: copy.apps,
    purchased: copy.purchased
  }

  return (
    <aside
      aria-label={copy.title}
      className="atum-sidebar relative flex h-full w-(--atum-l-roster) shrink-0 flex-col overflow-hidden [-webkit-app-region:no-drag]"
      data-atum-drawer={compact ? 'true' : undefined}
      data-atum-roster
      data-matrix-store-sidebar
    >
      <div
        className="flex h-(--atum-l-header) shrink-0 items-center px-3 [-webkit-app-region:drag]"
        data-atum-roster-header
      >
        {windowControls}
        <span className="flex-1" />
        {titleBarAction}
      </div>
      <MatrixPanelSearchRow>
        <MatrixPanelSearch label={copy.search} onValueChange={onQueryChange} type="search" value={query} />
        {/* No plus here: you create nothing in the Store (layout r2 §5, owner 2026-11-24). */}
      </MatrixPanelSearchRow>
      {/* Atum Kit Store board: the shelves sit on the roster panel itself, a hairline between rows,
          never inside a card of their own. */}
      <nav aria-label={copy.title} className="mx-2 flex flex-col" data-matrix-store-shelves>
        {STORE_SIDEBAR_SHELVES.map(({ id, Icon }) => (
          <button
            aria-current={shelf === id ? 'page' : undefined}
            className={cn('ak-row w-full text-left', shelf === id && 'is-selected')}
            data-store-shelf={id}
            key={id}
            onClick={() => onShelfChange(id)}
            type="button"
          >
            <Icon aria-hidden className="ak-icon ak-icon--sm" />
            <span className="min-w-0 flex-1 truncate">{labels[id]}</span>
          </button>
        ))}
      </nav>
      <span className="flex-1" />
      {/* The left panel's foot (layout r2 E, owner 2026-11-24): Top up, then the gear. Never the balance:
          it shows inside the top-up. */}
      {(onTopUp || onOpenSettings) && (
        <div className="atum-panel-foot" data-matrix-store-foot>
          {onTopUp ? (
            <button className="atum-panel-foot-action" data-matrix-store-topup onClick={onTopUp} type="button">
              <ProtonMark />
              {foot.topUp}
            </button>
          ) : (
            <span className="flex-1" />
          )}
          {onOpenSettings && (
            <Tip label={foot.settings}>
              <button
                aria-label={foot.settings}
                className="ak-iconbtn ak-iconbtn--sm"
                data-matrix-store-settings
                onClick={onOpenSettings}
                type="button"
              >
                <Settings aria-hidden className="ak-icon" />
              </button>
            </Tip>
          )}
        </div>
      )}
    </aside>
  )
}
