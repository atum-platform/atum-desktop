import { useStore } from '@nanostores/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useMediaQuery } from '@/hooks/use-media-query'
import { useI18n } from '@/i18n'

import { matrixCompanyBoardCopy } from '../../shared/matrix-company-board-copy'

import { $companyMarketplaces, companySpaceTabIds, effectiveCompanySpaceTab } from './company-marketplace-store'
import {
  $companySpacePreferences,
  companySpacePreferences,
  type CompanySpaceTab,
  patchCompanySpacePreferences
} from './company-space-store'

export interface CompanySpaceTabsProps {
  scope: string
  /**
   * `titlebar` mounts the tabs in the window's title-bar row (the shell's
   * `[data-atum-main-header]`), centred like Buzz. `inline` keeps them in the
   * surrounding flow, for stories and focused tests. `auto` uses the title bar
   * when it is present.
   */
  placement?: 'auto' | 'titlebar' | 'inline'
}

/**
 * Buzz-derived page navigation semantics: one declared page list, roving arrow
 * focus and a measured compact control. Styling and authority are Atum's. In the
 * product the tabs live in the title bar itself, between the channel identity
 * and the window actions, never as a second row under it.
 */
export function CompanySpaceTabs({ placement = 'auto', scope }: CompanySpaceTabsProps) {
  const { locale } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)
  const all = useStore($companySpacePreferences)
  // Marketplace is a page only while the company can hire from it (`atum.company-store/1` with something
  // deliverable, or hires to look after): never a catalog with no action, never a personal checkout.
  const marketplace = useStore($companyMarketplaces)[scope]
  const TAB_IDS = companySpaceTabIds(marketplace)
  const active = effectiveCompanySpaceTab((all[scope] ?? companySpacePreferences(scope)).tab, marketplace)
  const compact = useMediaQuery('(max-width: 780px)')
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const [host, setHost] = useState<HTMLElement | null>(null)

  const labels: Record<CompanySpaceTab, string> = {
    chat: copy.chat,
    board: copy.board,
    marketplace: copy.marketplace
  }

  const select = (tab: CompanySpaceTab) => patchCompanySpacePreferences(scope, { tab })

  // The shell draws the title bar; the workspace owns the pages. Find it before
  // paint so the tabs never flash as a second row.
  useLayoutEffect(() => {
    if (placement === 'inline' || typeof document === 'undefined') {
      setHost(null)

      return
    }

    setHost(document.querySelector<HTMLElement>('[data-atum-main-header]'))
  }, [placement])

  // The header owns the drag region; an absolutely positioned child needs a
  // positioned ancestor. Restore whatever the shell had when the tabs go.
  useLayoutEffect(() => {
    if (!host) {
      return
    }

    const previous = host.style.position
    const identity = host.querySelector<HTMLElement>('[data-matrix-header-identity]')
    const previousMaxWidth = identity?.style.maxWidth
    const previousFlex = identity?.style.flex

    if (window.getComputedStyle(host).position === 'static') {
      host.style.position = 'relative'
    }

    if (identity) {
      const wideIdentity = 'calc(50% - var(--ak-s12) - var(--ak-s12) - var(--ak-s6))'
      identity.style.maxWidth = compact ? '' : wideIdentity
      identity.style.flex = compact ? '' : `0 1 ${wideIdentity}`
    }

    return () => {
      host.style.position = previous
      if (identity) {
        identity.style.maxWidth = previousMaxWidth ?? ''
        identity.style.flex = previousFlex ?? ''
      }
    }
  }, [compact, host])

  // The tabs sit at the title bar's centre, over nothing: the channel's name and topic stop
  // short of them instead of running underneath (measured, since both sides vary).
  const centre = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const box = centre.current

    if (!host || !box) {
      return
    }

    const identity = () => host.querySelector<HTMLElement>('[data-matrix-header-identity]')

    const fit = () => {
      const title = identity()

      if (!title) {
        return
      }

      title.style.maxWidth = ''
      const room = box.getBoundingClientRect().left - title.getBoundingClientRect().left - 16
      title.style.maxWidth = `${Math.max(0, room)}px`
    }

    fit()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    observer?.observe(host)
    observer?.observe(box)

    return () => {
      observer?.disconnect()
      const title = identity()

      if (title) {
        title.style.maxWidth = ''
      }
    }
  }, [host, compact])

  const tabs = compact ? (
    <label className="flex h-(--atum-l-header) items-center" data-company-tabs-compact>
      <span className="sr-only">{copy.sectionsMenu}</span>
      <select
        aria-label={copy.sectionsMenu}
        className="atum-input h-8 w-32 text-sm"
        onChange={event => select(event.target.value as CompanySpaceTab)}
        value={active}
      >
        {TAB_IDS.map(tab => (
          <option key={tab} value={tab}>
            {labels[tab]}
          </option>
        ))}
      </select>
    </label>
  ) : (
    <div
      aria-label={copy.tabs}
      className="ak-seg ak-seg--sm"
      data-company-tabs
      role="tablist"
    >
      {TAB_IDS.map((tab, index) => (
        <button
          aria-controls={`company-page-${tab}`}
          aria-selected={active === tab}
          className={active === tab ? 'is-selected' : undefined}
          id={`company-tab-${tab}`}
          key={tab}
          onClick={() => select(tab)}
          onKeyDown={event => {
            const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0

            if (!delta) {
              return
            }

            event.preventDefault()
            const next = (index + delta + TAB_IDS.length) % TAB_IDS.length
            const tabId = TAB_IDS[next]!
            select(tabId)
            refs.current[next]?.focus({ preventScroll: true })
          }}
          ref={node => {
            refs.current[index] = node
          }}
          role="tab"
          tabIndex={active === tab ? 0 : -1}
          type="button"
        >
          {labels[tab]}
        </button>
      ))}
    </div>
  )

  if (!host) {
    return tabs
  }

  const actionHost = compact
    ? host.querySelector<HTMLElement>('[data-atum-page-actions]')
    : null

  if (actionHost) {
    return createPortal(tabs, actionHost)
  }

  return createPortal(
    <div
      className="absolute top-0 left-1/2 z-10 flex h-(--atum-l-header) -translate-x-1/2 items-center [-webkit-app-region:no-drag]"
      data-company-title-tabs
      ref={centre}
    >
      {tabs}
    </div>,
    host
  )
}
