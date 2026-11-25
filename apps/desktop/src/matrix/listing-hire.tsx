import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import type { MatrixAgentView, MatrixOpenAgentListing } from '../../shared/matrix'
import { checkAssistantName } from '../../shared/matrix-assistant-name'

import { noteMatrixAgentHandleSheetClaim } from './agent-handle-backfill'
import { claimMatrixAgentHandle } from './agent-handle-claim'
import { matrixAgentHandleCandidates } from './handle-rules'
import { useRosterCreateCopy } from './roster-create-copy'
import { StoreArt } from './store/store-card'

/**
 * Hiring an open listing from the new-assistant sheet (owner D9, 2026-11-22). The sheet shows the
 * listings above "make your own"; picking one gives the sheet one focus at a time: the price once
 * when this is the third+ assistant, then hiring, then done. The platform seeds the persona and
 * skills, so nothing here writes a definition, and the new assistant simply appears in the chats.
 */

/** The text a listing shows in this locale: its own, then English, then its catalog name. */
export function listingText(text: Record<string, string> | undefined, locale: string, fallback = ''): string {
  return text?.[locale] ?? text?.[locale.split('-')[0]!] ?? text?.en ?? fallback
}

/** The name the hired assistant goes by: the listing's title in this locale, numbered when the
 * owner already has an assistant (or an app) called that, so the hire is never refused for it. */
export function listingAssistantName(
  listing: MatrixOpenAgentListing,
  locale: string,
  agents: readonly Pick<MatrixAgentView, 'principal' | 'name'>[] = [],
  apps: readonly string[] = []
): string {
  const base = listingText(listing.title, locale, listing.displayName).trim()
  const others = agents.map(each => ({ principal: each.principal, name: each.name }))

  for (const candidate of [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map(number => `${base} ${number}`)]) {
    const checked = checkAssistantName(candidate, { primary: false, principal: '', others, apps })

    if (checked.ok) {
      return checked.name
    }
  }

  return listing.displayName
}

/** The listings this person can hire, read each time the sheet opens. None (or an older native
 * host) hides the shelf: the sheet is then exactly today's. */
export function useOpenListings(open: boolean): readonly MatrixOpenAgentListing[] {
  const [listings, setListings] = useState<readonly MatrixOpenAgentListing[]>([])

  useEffect(() => {
    const read = window.atumMatrix?.openAgents

    if (!open || !read) {
      return
    }

    let current = true

    void Promise.resolve()
      .then(() => read())
      .catch(() => [])
      .then(rows => {
        if (current) {
          setListings(Array.isArray(rows) ? rows : [])
        }
      })

    return () => {
      current = false
    }
  }, [open])

  return listings
}

export type ListingHirePhase =
  | { kind: 'confirm'; price: number }
  | { kind: 'hiring' }
  | { kind: 'done' }
  | { kind: 'short'; price: number }
  | { kind: 'failed'; refused?: 'name' | 'limit' | 'account' }

export interface ListingHireState {
  listing: MatrixOpenAgentListing
  name: string
  phase: ListingHirePhase
  hireConfirmed: boolean
}

/** One hire at a time: the phase it is in, and the moves between phases. Kept by the sheet's
 * owner, outside the dialog's content, so dismissing the sheet mid-hire never drops it; main
 * resumes an unfinished hire of the same listing under the same request either way. */
export function useListingHire(onHired?: () => void) {
  const [hire, setHire] = useState<ListingHireState>()
  const lifetime = useRef(true)

  useEffect(() => {
    lifetime.current = true

    return () => {
      lifetime.current = false
    }
  }, [])

  const update = (phase: ListingHirePhase, hireConfirmed?: boolean) =>
    setHire(current =>
      current ? { ...current, phase, hireConfirmed: hireConfirmed ?? current.hireConfirmed } : current
    )

  const start = (target: ListingHireState, hireConfirmed: boolean) => {
    const run = window.atumMatrix?.hireAgent

    if (!run) {
      update({ kind: 'failed' })

      return
    }

    update({ kind: 'hiring' }, hireConfirmed)

    void Promise.resolve()
      .then(() =>
        hireConfirmed ? run(target.name, target.listing.listingId, true) : run(target.name, target.listing.listingId)
      )
      .then(result => {
        if (!lifetime.current) {
          return
        }

        if ('refused' in result) {
          const reason = result.refused

          if (typeof reason === 'object') {
            update({ kind: 'confirm', price: reason.hire })
          } else if (reason === 'short') {
            update({ kind: 'short', price: target.listing.seatPriceProtons })
          } else {
            update({ kind: 'failed', refused: reason })
          }

          return
        }

        update({ kind: 'done' })
        onHired?.()
        claimHandle(result.assistantId, target.name)
      })
      .catch(() => {
        if (lifetime.current) {
          update({ kind: 'failed' })
        }
      })
  }

  return {
    hire,
    /** The person chose a listing: the price first when it costs, else straight to hiring. */
    pick(listing: MatrixOpenAgentListing, name: string) {
      const next: ListingHireState = {
        listing,
        name,
        phase: listing.hireRequired ? { kind: 'confirm', price: listing.seatPriceProtons } : { kind: 'hiring' },
        hireConfirmed: false
      }

      setHire(next)

      if (!listing.hireRequired) {
        start(next, false)
      }
    },
    confirm() {
      if (hire && hire.phase.kind === 'confirm') {
        start(hire, true)
      }
    },
    retry() {
      if (hire && hire.phase.kind === 'failed' && !hire.phase.refused) {
        start(hire, hire.hireConfirmed)
      }
    },
    /** Top-up opens in the browser; coming back, the same price is one Hire away. */
    topUp() {
      if (hire && hire.phase.kind === 'short') {
        void window.atumMatrix.openTopUp()
        update({ kind: 'confirm', price: hire.phase.price })
      }
    },
    reset() {
      setHire(undefined)
    }
  }
}

/** A hired assistant gets its handle as a made one does; any failure leaves it to the card. */
function claimHandle(assistantId: string | undefined, name: string) {
  const aliases = window.atumMatrix?.aliases

  if (!aliases || !assistantId) {
    return
  }

  noteMatrixAgentHandleSheetClaim(assistantId)
  void claimMatrixAgentHandle(aliases, assistantId, matrixAgentHandleCandidates(name, Math.random)).catch(() => {})
}

/** The kit's small section label (caption, semibold, muted), as the sheet's own labels sit. */
export const LISTING_SECTION = 'text-(length:--atum-t-caption) font-semibold text-(--atum-ink-muted)'

/** The listings, above "make your own": a face, the title, one line and Hire. */
export function ListingShelf({
  comingSoon,
  disabled,
  listings,
  onPick
}: {
  /** Hires wait for beta accounts (owner, 2026-11-25): the listings show, their button says this. */
  comingSoon?: string
  disabled?: boolean
  listings: readonly MatrixOpenAgentListing[]
  onPick(listing: MatrixOpenAgentListing): void
}) {
  const { locale, t } = useI18n()
  const copy = useRosterCreateCopy()

  if (!listings.length) {
    return null
  }

  return (
    <section aria-labelledby="matrix-listing-shelf-label" data-atum-listing-shelf>
      <h3 className={cn(LISTING_SECTION, 'mb-1.5')} id="matrix-listing-shelf-label">
        {copy.readyToHire}
      </h3>
      <ul className="space-y-1.5">
        {listings.map(listing => {
          const title = listingText(listing.title, locale, listing.displayName)
          const summary = listingText(listing.summary, locale)

          return (
            <li
              className="flex items-center gap-3 rounded-(--ak-r-lg) bg-(--atum-sunk) p-2.5"
              data-atum-listing={listing.listingId}
              key={listing.listingId}
            >
              <StoreArt face item={{ kind: 'agent', glyph: listing.glyph }} size="tile" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-(length:--atum-t-body) font-medium text-(--atum-ink)">{title}</p>
                {summary && (
                  <p className="truncate text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
                    {summary}
                  </p>
                )}
              </div>
              <Button
                aria-label={`${comingSoon ?? t.matrixShell.agentHireConfirm} ${title}`}
                data-atum-listing-coming-soon={comingSoon ? true : undefined}
                disabled={disabled || Boolean(comingSoon)}
                onClick={() => onPick(listing)}
                size="sm"
                type="button"
                variant="secondary"
              >
                {comingSoon ?? t.matrixShell.agentHireConfirm}
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** The sheet while one listing has its focus: its face and name, one line, its one action. */
export function ListingHireView({
  hire,
  onBack,
  onConfirm,
  onDone,
  onRetry,
  onTopUp
}: {
  hire: ListingHireState
  onBack(): void
  onConfirm(): void
  onDone(): void
  onRetry(): void
  onTopUp(): void
}) {
  const { locale, t } = useI18n()
  const shell = t.matrixShell
  const copy = useRosterCreateCopy()
  const { listing, name, phase } = hire
  const summary = listingText(listing.summary, locale)
  const line = 'text-(length:--atum-t-body) text-(--atum-ink-muted)'

  const refusal = {
    account: shell.agentAccountRefused,
    limit: shell.agentLimitRefused,
    name: shell.agentNameRefused
  }

  return (
    <div className="space-y-4" data-atum-listing-hire={phase.kind}>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <StoreArt face item={{ kind: 'agent', glyph: listing.glyph }} size="tile" />
          <div className="min-w-0 space-y-0.5">
            <DialogTitle className="truncate">{name}</DialogTitle>
            {/* The one line the sheet says about it; the done state says where it went instead. */}
            <DialogDescription className="truncate">{summary || listing.displayName}</DialogDescription>
          </div>
        </div>
      </DialogHeader>
      {phase.kind === 'confirm' && (
        <p className="text-(length:--atum-t-body) font-medium text-(--atum-ink)" data-atum-listing-price>
          {copy.hirePrice(new Intl.NumberFormat(locale).format(phase.price))}
        </p>
      )}
      {phase.kind === 'hiring' && (
        <p className={line} role="status">
          {copy.hiring(name)}
        </p>
      )}
      {phase.kind === 'done' && (
        <p className={line} role="status">
          {copy.hired(name)}
        </p>
      )}
      {phase.kind === 'short' && (
        <NoticeBand role="alert" tone="failure">
          {shell.agentHireShort}
        </NoticeBand>
      )}
      {phase.kind === 'failed' && (
        <NoticeBand role="alert" tone="failure">
          {phase.refused ? refusal[phase.refused] : copy.hireFailed(name)}
        </NoticeBand>
      )}
      <DialogFooter>
        {phase.kind === 'done' ? (
          <Button autoFocus onClick={onDone} type="button">
            {t.common.done}
          </Button>
        ) : (
          <>
            <Button disabled={phase.kind === 'hiring'} onClick={onBack} type="button" variant="ghost">
              {t.common.back}
            </Button>
            {phase.kind === 'short' ? (
              <Button onClick={onTopUp} type="button">
                {t.atum.discover.topUp}
              </Button>
            ) : phase.kind === 'failed' && !phase.refused ? (
              <Button onClick={onRetry} type="button">
                {t.common.retry}
              </Button>
            ) : phase.kind === 'failed' ? null : (
              <Button disabled={phase.kind === 'hiring'} onClick={onConfirm} type="button">
                {shell.agentHireConfirm}
              </Button>
            )}
          </>
        )}
      </DialogFooter>
    </div>
  )
}
