import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import { AppCatalogAvatar } from '@/app/atum/app-catalog-presentation'
import { ProtonAmount } from '@/components/brand/proton-mark'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { VerifiedMark } from '@/components/verified-mark'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import type { AppDescriptor } from '../../../shared/app-catalog'
import { appLocalizedCopy } from '../../../shared/app-catalog'
import type { MatrixAgentView } from '../../../shared/matrix'
import type {
  MatrixStoreEntitlement,
  MatrixStoreItem,
  MatrixStoreResult,
  MatrixStoreSnapshot
} from '../../../shared/matrix-store'
import type { MatrixWalletState } from '../../../shared/matrix-wallet'
import { appVerificationTier } from '../../../shared/verification'
import { matrixRosterAgentName } from '../roster-model'
import { wholeProtons } from '../wallet-ui'

import { type DiscoverCheckout, MatrixCheckoutPane, StoreQuietState } from './checkout'
import { type MatrixStoreListing, storeListingFor, storeListingForOffer, storeListings } from './hatch-listing'
import { isHubSkill } from './hub-skill'
import { localizedStoreText, StoreArt, StoreCard } from './store-card'
import { type MatrixStoreCopy, matrixStoreCopy } from './store-copy'
import {
  type StoreAcquireOutcome,
  StoreDetail,
  type StoreHatchPet,
  storeOutcomeCopy,
  type StoreReadSkills,
  type StoreTryItem
} from './store-detail'
import { itemOwnedForAssistant, itemStoreOwnership } from './store-ownership'
import { $matrixStoreListingRequest, type DiscoverShelf } from './top-up'

export type { DiscoverShelf } from './top-up'

export interface DiscoverStore {
  snapshot: MatrixStoreSnapshot
  onAcquire(item: MatrixStoreItem, assistantId?: string, consentRenewal?: true): Promise<StoreAcquireOutcome>
  onCancel(entitlementId: string): Promise<void>
  onResume(idempotencyKey: string): Promise<MatrixStoreResult | { outcome: 'uncertain' }>
  onRetry(): void
}

export interface DiscoverApps {
  state: 'loading' | 'ready' | 'unavailable'
  items: AppDescriptor[]
  onRetry?: () => void
}

function normalized(value: string) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/gu, 'd').trim().replace(/\s+/gu, ' ')
}

function hasQuery(item: MatrixStoreItem, query: string, locale: string) {
  if (!query) {
    return true
  }

  return normalized(
    [item.kind, localizedStoreText(item.title, locale), localizedStoreText(item.summary, locale)].join(' ')
  ).includes(query)
}

/** Skills and hires belong to a named assistant; pets belong to the account. */
export function ownedForItem(item: MatrixStoreItem, entitlements: MatrixStoreEntitlement[], assistantId?: string) {
  return itemOwnedForAssistant(item, entitlements, assistantId)
}

/**
 * Whether the grid marks an item owned, across every assistant: a skill bought for Moon
 * is owned, and its badge says by whom ("Owned · Moon"). A pet belongs to the account.
 */
export function storeOwnership(
  item: MatrixStoreItem,
  entitlements: MatrixStoreEntitlement[],
  agents: MatrixAgentView[],
  copy: MatrixStoreCopy,
  defaultName: string
): { owned: boolean; label?: string } {
  const ownership = itemStoreOwnership(item, entitlements)

  if (ownership.state !== 'owned') {
    return { owned: false }
  }

  if (ownership.source === 'gift') {
    return { owned: true, label: copy.gift }
  }

  const owners = ownership.assistantIds

  // A hire is its own assistant: its name would only repeat the item's.
  if (item.kind !== 'skill') {
    return { owned: true }
  }

  const names = owners.flatMap(id => {
    const agent = agents.find(value => value.assistantId === id)

    return agent ? [matrixRosterAgentName(agent, defaultName)] : []
  })

  if (!names.length) {
    return { owned: true }
  }

  return {
    owned: true,
    label: copy.ownedBy(names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', '))
  }
}

function bySortOrder(left: MatrixStoreItem, right: MatrixStoreItem) {
  return left.sortOrder - right.sortOrder || left.itemId.localeCompare(right.itemId)
}

function formatWhole(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(wholeProtons(value))
}

/** A purchase checked again from Purchased, with the kind of item it was for when known. */
interface ResumedPurchase {
  result: StoreAcquireOutcome
  kind?: MatrixStoreItem['kind']
}

export function MatrixDiscoverView({
  apps,
  agents = [],
  checkout,
  hatchPet,
  onTopUpPage,
  preferredAssistantId,
  readSkills,
  renderAppActions,
  query,
  shelf,
  onShelfChange,
  store,
  tryItem,
  wallet
}: {
  apps: DiscoverApps
  agents?: MatrixAgentView[]
  checkout?: DiscoverCheckout
  /** The Hatch card's way into the companion's hatch panel, which quotes and charges the hatch itself. */
  hatchPet?: StoreHatchPet
  /** Only without an in-app checkout: Atum's payments page. */
  onTopUpPage?: () => void
  /** The assistant the person was using before opening the Store. */
  preferredAssistantId?: string
  /** An assistant's skill list, so a free Hub skill it already has says "Installed". */
  readSkills?: StoreReadSkills
  renderAppActions?: (app: AppDescriptor) => ReactNode
  /** Roster-owned Store search. */
  query: string
  /** Roster-owned Store category; top-ups are an in-place checkout reached from a real shortfall. */
  shelf: DiscoverShelf
  onShelfChange(shelf: DiscoverShelf): void
  store: DiscoverStore
  /** Opens an owned item in its assistant's chat ("Try it now", Purchased → Open). */
  tryItem?: StoreTryItem
  /** The person's Protons, for the balance in the header and under a price. */
  wallet?: MatrixWalletState
}) {
  const { locale, t } = useI18n()
  const copy = matrixStoreCopy(locale)
  const listingRequest = useStore($matrixStoreListingRequest)
  const [listingMissing, setListingMissing] = useState(false)
  const [open, setOpen] = useState<MatrixStoreListing | null>(null)
  const [resuming, setResuming] = useState<string | null>(null)
  const [resumeOutcome, setResumeOutcome] = useState<ResumedPurchase | null>(null)
  const [canceling, setCanceling] = useState<string | null>(null)
  const [manageError, setManageError] = useState(false)
  // The two hatch rows are one Hatch card, at the first-hatch price while the catalog offers it.
  const items = useMemo(() => storeListings(store.snapshot.items).sort(bySortOrder), [store.snapshot.items])
  useEffect(() => {
    if (!listingRequest || store.snapshot.state === 'loading') {
      return
    }

    const item = items.find(each => each.itemId === listingRequest)
    setListingMissing(!item)
    setOpen(item ?? null)
    $matrixStoreListingRequest.set(null)
  }, [listingRequest, items, store.snapshot.state])
  const balance = wallet?.state === 'ready' ? wallet.wallet.balances.available : null
  const [titleBarHost, setTitleBarHost] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    setTitleBarHost(document.querySelector<HTMLElement>('[data-atum-page-actions]'))
  }, [])
  // Without the in-app checkout, the payments page needs a signed-in wallet to land on.
  const topUpPage = !checkout && wallet ? onTopUpPage : undefined
  const topUpAvailable = Boolean(checkout || topUpPage)

  // The dialog follows the live catalog: a refreshed price replaces the one it opened with.
  const openItem = open ? (items.find(item => item.itemId === open.itemId) ?? open) : null

  // A catalog row without an offer is not an offer this provider can fulfil, except a free
  // Hub skill, which the Skills Hub installs. Keep the rest out of the shop; any
  // already-granted entitlement remains visible in Purchased.
  const visible = useMemo(
    () => items.filter(item => (Boolean(item.offer) || isHubSkill(item)) && hasQuery(item, normalized(query), locale)),
    [items, locale, query]
  )

  const labels: Record<Exclude<DiscoverShelf, 'topups'>, string> = {
    featured: copy.featured,
    agents: copy.agents,
    skills: copy.skills,
    pets: copy.pets,
    apps: copy.apps,
    purchased: copy.purchased
  }

  const pageTitle = shelf === 'topups' ? copy.topUp : shelf === 'featured' ? copy.discover : labels[shelf]

  const openTopUp = () => {
    if (checkout) {
      onShelfChange('topups')
    } else {
      topUpPage?.()
    }
  }

  const unavailable = (
    <StoreQuietState action={copy.retry} onAction={store.onRetry}>
      {copy.storeUnavailable}
    </StoreQuietState>
  )

  const itemGrid = (
    list: MatrixStoreListing[],
    feature = false,
    empty: ReactNode = <p className="atum-store-status">{copy.empty}</p>
  ) => {
    if (!list.length) {
      return query ? <p className="atum-store-status">{copy.searchEmpty}</p> : empty
    }

    return (
      // Every shelf is one calm list (Atum Kit 0.1): a tile, the words and one price per row.
      <div className="atum-store-grid">
        {list.map(item => {
          const ownership = storeOwnership(item, store.snapshot.entitlements, agents, copy, t.matrixShell.assistantName)

          return (
            <StoreCard
              copy={copy}
              item={item}
              key={item.itemId}
              kindLabel={feature ? copy.kind[item.kind] : undefined}
              locale={locale}
              onOpen={() => setOpen(item)}
              owned={ownership.owned}
              variant="row"
            />
          )
        })}
      </div>
    )
  }

  const appGrid = () => {
    if (apps.state === 'unavailable') {
      return (
        <StoreQuietState action={apps.onRetry ? copy.retry : undefined} onAction={apps.onRetry}>
          {copy.appsUnavailable}
        </StoreQuietState>
      )
    }

    if (apps.state === 'loading') {
      return <Loader className="mx-auto my-6 size-8" label={copy.loading} />
    }

    const matches = apps.items.filter(app => {
      const haystack = [
        app.app,
        appLocalizedCopy(app.name, locale, app.app),
        app.subtitle ? appLocalizedCopy(app.subtitle, locale, '') : ''
      ].join(' ')

      return !query || normalized(haystack).includes(normalized(query))
    })

    if (!matches.length) {
      return <p className="atum-store-status">{query ? copy.searchEmpty : copy.empty}</p>
    }

    return (
      <div className="atum-store-grid atum-store-grid--apps">
        {matches.map(app => (
          <article className="atum-store-app" data-store-app={app.app_id} key={app.app_id}>
            <div className={cn('flex min-w-0 items-center gap-3', app.availability !== 'available' && 'opacity-60')}>
              <AppCatalogAvatar app={app} className="size-12 rounded-[0.875rem] text-lg" locale={locale} tile />
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-1 text-[0.9375rem] font-semibold text-(--atum-ink)">
                  <span className="truncate">{appLocalizedCopy(app.name, locale, app.app)}</span>
                  <VerifiedMark subject="app" tier={appVerificationTier(app)} />
                </span>
                {app.subtitle && (
                  <span className="block truncate text-(length:--atum-t-control) text-(--atum-ink-muted)">
                    {appLocalizedCopy(app.subtitle, locale, '')}
                  </span>
                )}
              </span>
            </div>
            {renderAppActions && <div className="atum-store-app-actions">{renderAppActions(app)}</div>}
          </article>
        ))}
      </div>
    )
  }

  const pendingRows = () =>
    store.snapshot.pending.length > 0 && (
      <section aria-label={copy.pendingPurchases} className="grid gap-2.5" data-store-pending>
        <h3 className="atum-store-heading mb-0">{copy.pendingPurchases}</h3>
        {store.snapshot.pending.map(pending => {
          const item = storeListingForOffer(items, pending.offerId)

          const label = item
            ? localizedStoreText(item.title, locale)
            : pending.provision?.name || copy.purchaseInProgress

          return (
            <article className="atum-store-owned" data-store-pending-purchase key={pending.idempotencyKey}>
              {item ? <StoreArt item={item} size="tile" /> : <span aria-hidden className="atum-store-art" />}
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-(--atum-ink)">{label}</p>
                <p className="text-(length:--atum-t-control) text-(--atum-ink-muted)">{copy.purchaseInProgress}</p>
              </div>
              <Button
                disabled={resuming === pending.idempotencyKey}
                onClick={() => {
                  setResuming(pending.idempotencyKey)
                  setManageError(false)
                  setResumeOutcome(null)
                  void store
                    .onResume(pending.idempotencyKey)
                    .then(result => setResumeOutcome({ result, kind: item?.kind }))
                    .catch(() => setManageError(true))
                    .finally(() => setResuming(null))
                }}
                size="sm"
                variant="secondary"
              >
                {copy.checkPurchase}
              </Button>
            </article>
          )
        })}
      </section>
    )

  const purchased = () => {
    const entries = store.snapshot.entitlements
    const gifts = entries.filter(entry => entry.source === 'gift')

    const groups = gifts.length
      ? [
          { label: copy.purchased, entries: entries.filter(entry => entry.source !== 'gift'), gift: false },
          { label: copy.gifts, entries: gifts, gift: true }
        ].filter(group => group.entries.length)
      : [{ label: copy.purchased, entries, gift: false }]

    return (
      <div className="grid gap-5">
        {pendingRows()}
        {store.snapshot.state === 'unavailable'
          ? unavailable
          : !entries.length
            ? !store.snapshot.pending.length && <p className="atum-store-status">{copy.purchasedEmpty}</p>
            : groups.map(group => (
                <section
                  aria-label={group.label}
                  className="grid gap-2.5"
                  data-store-gifts={group.gift || undefined}
                  key={group.label}
                >
                  {gifts.length > 0 && <h3 className="atum-store-heading mb-0">{group.label}</h3>}
                  {group.entries.map(entitlement => {
                    const item = storeListingFor(items, entitlement.itemId)
                    const label = item ? localizedStoreText(item.title, locale) : copy.kind[entitlement.kind]
                    const active = entitlement.state === 'active'

                    const owner =
                      entitlement.kind === 'skill' && entitlement.assistantId
                        ? agents.find(agent => agent.assistantId === entitlement.assistantId)
                        : undefined

                    const date = entitlement.subscription
                      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
                          new Date(entitlement.subscription.renewAt)
                        )
                      : null

                    const status =
                      entitlement.subscription?.state === 'cancelled'
                        ? copy.cancelled
                        : entitlement.subscription?.state === 'lapsed'
                          ? copy.lapsed
                          : !active
                            ? copy.revoked
                            : date
                              ? copy.renews(date)
                              : entitlement.source === 'gift'
                                ? copy.gift
                                : owner
                                  ? copy.ownedBy(matrixRosterAgentName(owner, t.matrixShell.assistantName))
                                  : copy.owned

                    const openAction =
                      active &&
                      item &&
                      entitlement.kind !== 'pet' &&
                      itemOwnedForAssistant(item, entries, entitlement.assistantId ?? undefined)
                        ? (tryItem?.(item, entitlement.assistantId ?? undefined) ?? null)
                        : null

                    const canCancel =
                      active && entitlement.kind === 'agent' && entitlement.subscription?.state === 'active'

                    return (
                      <article
                        className="atum-store-owned"
                        data-store-entitlement={entitlement.id}
                        key={entitlement.id}
                      >
                        {item ? <StoreArt item={item} size="tile" /> : <span aria-hidden className="atum-store-art" />}
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold text-(--atum-ink)">{label}</p>
                          <p className="text-(length:--atum-t-control) text-(--atum-ink-muted)">{status}</p>
                        </div>
                        {(openAction || canCancel) && (
                          <div className="atum-store-owned-actions">
                            {canCancel && (
                              <Button
                                disabled={canceling === entitlement.id}
                                onClick={() => {
                                  setCanceling(entitlement.id)
                                  setManageError(false)
                                  void store
                                    .onCancel(entitlement.id)
                                    .catch(() => setManageError(true))
                                    .finally(() => setCanceling(null))
                                }}
                                size="sm"
                                variant="text"
                              >
                                {canceling === entitlement.id ? copy.cancelling : copy.cancelMonthly}
                              </Button>
                            )}
                            {openAction && (
                              <Button data-store-open onClick={openAction} size="sm" variant="secondary">
                                {copy.open}
                              </Button>
                            )}
                          </div>
                        )}
                      </article>
                    )
                  })}
                </section>
              ))}
        {manageError && (
          <NoticeBand role="status" tone="failure">
            {copy.purchaseFailed}
          </NoticeBand>
        )}
        {resumeOutcome && (
          <NoticeBand
            role="status"
            tone={
              resumeOutcome.result.outcome === 'purchased' || resumeOutcome.result.outcome === 'already_owned'
                ? 'notice'
                : 'failure'
            }
          >
            {storeOutcomeCopy(resumeOutcome.result, copy, resumeOutcome.kind)}
          </NoticeBand>
        )}
      </div>
    )
  }

  const body = () => {
    if (shelf === 'topups' && checkout) {
      return (
        <section aria-label={copy.topUp} data-store-topups>
          <h3 className="atum-store-heading">{copy.topUp}</h3>
          <MatrixCheckoutPane
            checkout={checkout}
            copy={copy}
            onDone={() => onShelfChange('featured')}
            wallet={wallet}
          />
        </section>
      )
    }

    if (shelf === 'apps') {
      return appGrid()
    }

    if (shelf === 'purchased') {
      return purchased()
    }

    // Loading, then the outage notice, then the shelf's own empty state, then its items. The
    // Assistants shelf holds only hireable assistants from the Store catalog: Moon and Andy
    // are apps and live on Apps. While none is on sale it says so plainly.
    if (store.snapshot.state === 'loading' && !items.length) {
      return (
        <div aria-busy className="atum-store-grid" role="status">
          <span className="sr-only">{copy.loading}</span>
          {[0, 1, 2, 3].map(index => (
            <span aria-hidden className="atum-store-skeleton" key={index} />
          ))}
        </div>
      )
    }

    if (store.snapshot.state === 'unavailable') {
      return unavailable
    }

    if (shelf === 'featured') {
      return itemGrid(
        visible.filter(item => item.featured),
        true
      )
    }

    if (shelf === 'agents') {
      return itemGrid(
        visible.filter(item => item.kind === 'agent'),
        false,
        <div className="atum-store-quiet" data-store-agents-soon role="status">
          <div className="grid gap-1">
            <p className="font-semibold text-(--atum-ink)">{copy.agentsSoon}</p>
            <p>{copy.agentsSoonNote}</p>
          </div>
        </div>
      )
    }

    return itemGrid(visible.filter(item => item.kind === shelf.slice(0, -1)))
  }

  const walletButton =
    balance !== null ? (
      <div className="atum-store-wallet" data-store-wallet>
        <button
          aria-label={copy.balance(formatWhole(balance, locale))}
          aria-pressed={checkout ? shelf === 'topups' : undefined}
          className="ak-btn ak-btn--plain ak-btn--sm"
          data-store-balance
          data-store-open-topup
          disabled={!topUpAvailable}
          onClick={openTopUp}
          title={copy.balanceLabel}
          type="button"
        >
          {/* The mark stands for the word, as a currency sign does; the name keeps the sentence. */}
          <ProtonAmount amount={formatWhole(balance, locale)} spoken={`${formatWhole(balance, locale)} ${copy.protons}`} />
        </button>
      </div>
    ) : null

  return (
    <section aria-label={copy.title} className="min-h-0 flex-1 overflow-y-auto" data-matrix-discover>
      {/* The balance sits once, in the title bar (Atum Kit, FlowStore); without a title bar (a
          test or a story) it stays at the page's head. */}
      {titleBarHost ? walletButton && createPortal(walletButton, titleBarHost) : null}
      <div className="mx-auto flex w-full max-w-[47.5rem] flex-col px-8 pt-8 pb-12">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h2 className="[font:var(--ak-t-display)] text-(--ak-ink)">{pageTitle}</h2>
            <p className="mt-(--ak-s1) [font:var(--ak-t-callout)] text-(--ak-ink-2)">{copy.subtitle}</p>
          </div>
          {!titleBarHost && walletButton}
        </div>
        <div className="mt-7">
          {listingMissing && (
            <p className="atum-store-status mb-3" role="status">
              {copy.listingMissing}
            </p>
          )}
          {store.snapshot.state === 'stale' && shelf !== 'topups' && shelf !== 'apps' && (
            <p className="atum-store-status mb-3">{copy.stale}</p>
          )}
          {body()}
        </div>
      </div>
      <StoreDetail
        agents={agents}
        checkout={checkout}
        entitlements={store.snapshot.entitlements}
        hatchPet={hatchPet}
        item={openItem}
        onAcquire={store.onAcquire}
        onOpenChange={value => !value && setOpen(null)}
        onTopUp={topUpPage}
        preferredAssistantId={preferredAssistantId}
        readSkills={readSkills}
        tryItem={tryItem}
        wallet={wallet}
      />
    </section>
  )
}
