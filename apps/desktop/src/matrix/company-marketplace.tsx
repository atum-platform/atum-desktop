import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { ProtonAmount } from '@/components/brand/proton-mark'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'

import { matrixCompanyBoardCopy } from '../../shared/matrix-company-board-copy'
import type {
  MatrixCompanyStoreActionResult,
  MatrixCompanyStoreAgent,
  MatrixCompanyStorePending,
  MatrixCompanyStoreSnapshot
} from '../../shared/matrix-company-store'
import type { MatrixStoreEntitlement, MatrixStoreItem } from '../../shared/matrix-store'

import { CompanyAIAvatar } from './company-ai-status'
import {
  $companyMarketplaces,
  cancelCompanyEntitlement,
  purchaseCompanyItem,
  refreshCompanyMarketplace,
  resumeCompanyPurchase
} from './company-marketplace-store'
import { CompanyWalletDrawer, useCompanyWallet } from './company-wallet'
import { CompanyWalletFund } from './company-wallet-fund'
import { companyOutcomeCopy, companyShortfallProtons, type StoreCompanyMode } from './store/company-store-detail'
import { localizedStoreText, StoreCard } from './store/store-card'
import { matrixStoreCopy } from './store/store-copy'
import { StoreDetail } from './store/store-detail'
import { itemStoreOwnership } from './store/store-ownership'

/** The company's Chief of Staff as the workspace knows it: comes with the company, listed first. */
export interface CompanyMarketplaceChief {
  principal: string
  name: string
  ready: boolean
}

export interface CompanyMarketplaceProps {
  scope: string
  companyId: string
  chief?: CompanyMarketplaceChief
}

/** What a company can get: assistants and skills it can use now (never an undeliverable listing). */
function companyListings(snapshot: MatrixCompanyStoreSnapshot) {
  return snapshot.items.filter(
    item =>
      (item.kind === 'agent' || item.kind === 'skill') &&
      item.deliverable !== false
  )
}

function agentEntitlement(agent: MatrixCompanyStoreAgent, entitlements: readonly MatrixStoreEntitlement[]) {
  return entitlements.find(row => row.kind === 'agent' && row.assistantId === agent.agentId && row.state === 'active')
}

function pendingFor(item: MatrixStoreItem, pending: readonly MatrixCompanyStorePending[]) {
  return item.offer ? pending.find(row => row.offerId === item.offer!.id) : undefined
}

/**
 * Team Space's third title page (Chat · Board · Marketplace). Owners and admins hire assistants and add
 * skills, paid from the company wallet; members browse and see who may hire. Every price and balance
 * carries the Proton mark. The page draws only what native's company Store returns: an item the
 * company could not use yet is never listed, so there is no dead Hire.
 */
export function CompanyMarketplace({ chief, companyId, scope }: CompanyMarketplaceProps) {
  const { locale } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)
  const storeCopy = matrixStoreCopy(locale)
  const snapshot = useStore($companyMarketplaces)[scope]
  const canAct = snapshot?.viewer.canAct ?? false
  // Members never read the wallet: the server refuses them, and the page shows no balance.
  const wallet = useCompanyWallet(companyId, canAct)
  const [open, setOpen] = useState<MatrixStoreItem | null>(null)
  const [fund, setFund] = useState<{ prefillProtons?: number } | null>(null)
  const balance = canAct ? wallet.wallet?.balances.available : undefined
  const whole = (micro: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(micro / 1_000_000)

  if (!snapshot || (snapshot.state === 'loading' && snapshot.items.length === 0)) {
    return <Loader className="m-auto size-6" label={storeCopy.loading} />
  }

  if (snapshot.state === 'unavailable' && snapshot.items.length === 0 && snapshot.agents.length === 0) {
    return (
      <div className="m-auto grid justify-items-center gap-3" data-company-marketplace-unavailable>
        <p className="text-sm text-(--atum-ink-muted)">{copy.marketUnavailable}</p>
        <Button onClick={() => void refreshCompanyMarketplace(scope, companyId)} size="sm" variant="secondary">
          {copy.retry}
        </Button>
      </div>
    )
  }

  const listings = companyListings(snapshot)
  // A hired assistant lives under Your team; the shelf offers only the ones the company can still hire.
  const assistants = listings.filter(
    item => item.kind === 'agent' && itemStoreOwnership(item, snapshot.entitlements).state !== 'owned'
  )
  const skills = listings.filter(item => item.kind === 'skill')
  const items = new Map(snapshot.items.map(item => [item.itemId, item]))

  // A skill goes to the Chief of Staff or a hired assistant that is working; never a personal one.
  const targets = [
    ...(chief?.ready ? [{ id: chief.principal, name: chief.name }] : []),
    ...snapshot.agents.filter(agent => agent.state === 'ready').map(agent => ({ id: agent.agentId, name: agent.name }))
  ]

  const done = (result: MatrixCompanyStoreActionResult) => {
    wallet.reload()

    return result
  }

  const company = (item: MatrixStoreItem): StoreCompanyMode => ({
    canAct,
    balanceMicroProtons: balance,
    targets,
    entitlements: snapshot.entitlements,
    pendingKey: pendingFor(item, snapshot.pending)?.idempotencyKey,
    acquire: async (listing, agentId) => {
      const offer = listing.offer!

      return done(
        await purchaseCompanyItem(scope, companyId, {
          offerId: offer.id,
          offerVersion: offer.version,
          target: listing.kind === 'agent' || !agentId ? { hire: {} } : { agentId },
          ...(offer.billingInterval === 'month' ? { consentRenewal: true as const } : {})
        })
      )
    },
    resume: async key => done(await resumeCompanyPurchase(scope, companyId, key)),
    renderFund: ({ onDone, shortfallProtons }) => (
      <CompanyWalletFund
        companyId={companyId}
        onFunded={() => {
          wallet.reload()
          onDone()
        }}
        prefillProtons={shortfallProtons}
      />
    )
  })

  const shelf = (heading: string, list: MatrixStoreItem[], id: string) => (
    <section aria-label={heading} className="grid" data-company-marketplace-section={id}>
      <h2 className="atum-store-heading">{heading}</h2>
      {list.length > 0 ? (
        <div className="atum-store-grid">
          {list.map(item => (
            <StoreCard
              copy={storeCopy}
              item={item}
              key={item.itemId}
              locale={locale}
              onOpen={() => setOpen(item)}
              owned={false}
            />
          ))}
        </div>
      ) : (
        <p className="atum-store-status">{copy.marketEmpty}</p>
      )}
    </section>
  )

  const looseRows = snapshot.pending.filter(row => !('agentId' in row.target))

  return (
    <section
      aria-label={copy.marketplace}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      data-company-marketplace
      data-company-marketplace-viewer={canAct ? 'manager' : 'member'}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[47.5rem] grid-cols-[minmax(0,1fr)] gap-8 px-8 py-8">
          {(canAct || snapshot.state === 'stale') && (
            <div className="flex min-h-8 flex-wrap items-center justify-end gap-3" data-company-marketplace-toolbar>
              {snapshot.state === 'stale' && (
                <span className="me-auto text-(length:--atum-t-control) text-(--atum-ink-muted)" role="status">
                  {copy.boardStale}
                </span>
              )}
              {canAct && balance !== undefined && (
                <span
                  className="inline-flex items-center gap-1.5 text-(length:--atum-t-control) text-(--atum-ink-muted)"
                  data-company-marketplace-balance
                >
                  {copy.wallet}
                  <span className="font-semibold text-(--atum-ink)">
                    <ProtonAmount amount={whole(balance)} spoken={`${whole(balance)} ${storeCopy.protons}`} />
                  </span>
                </span>
              )}
              {canAct && (
                <Button data-company-marketplace-add-protons onClick={() => setFund({})} size="sm" variant="secondary">
                  {copy.marketAddProtons}
                </Button>
              )}
            </div>
          )}
          <section aria-label={copy.marketTeam} className="grid" data-company-marketplace-section="team">
            <h2 className="atum-store-heading">{copy.marketTeam}</h2>
            <ul className="grid">
              {chief && (
                <li className="atum-store-card cursor-default" data-company-marketplace-agent="chief">
                  <CompanyAIAvatar className="size-10 shrink-0 text-sm" name={chief.name} principal={chief.principal} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.9375rem] font-semibold text-(--atum-ink)">{chief.name}</span>
                    <span className="block text-(length:--atum-t-control) text-(--atum-ink-muted)">
                      {copy.marketIncluded}
                    </span>
                  </span>
                </li>
              )}
              {snapshot.agents.map(agent => (
                <CompanyTeamRow
                  agent={agent}
                  canAct={canAct}
                  companyId={companyId}
                  entitlement={agentEntitlement(agent, snapshot.entitlements)}
                  item={items.get(agent.itemId)}
                  key={agent.agentId}
                  onFund={prefillProtons => setFund({ prefillProtons })}
                  onPurchased={() => wallet.reload()}
                  pending={snapshot.pending.find(row => 'agentId' in row.target && row.target.agentId === agent.agentId)}
                  scope={scope}
                />
              ))}
            </ul>
          </section>
          {looseRows.length > 0 && (
            <section aria-label={storeCopy.pendingPurchases} className="grid gap-1" data-company-marketplace-pending>
              <h2 className="atum-store-heading">{storeCopy.pendingPurchases}</h2>
              {looseRows.map(row => {
                const item = snapshot.items.find(entry => entry.offer?.id === row.offerId)

                return (
                  <CompanyPendingRow
                    canAct={canAct}
                    key={row.idempotencyKey}
                    onResume={async () => done(await resumeCompanyPurchase(scope, companyId, row.idempotencyKey))}
                    title={item ? localizedStoreText(item.title, locale) : storeCopy.purchaseInProgress}
                  />
                )
              })}
            </section>
          )}
          {shelf(copy.marketAssistants, assistants, 'assistants')}
          {shelf(copy.marketSkills, skills, 'skills')}
        </div>
      </div>
      {open && (
        <StoreDetail
          company={company(open)}
          item={open}
          onOpenChange={next => {
            if (!next) {
              setOpen(null)
            }
          }}
        />
      )}
      {fund && canAct && (
        <CompanyWalletDrawer
          companyId={companyId}
          onClose={() => setFund(null)}
          onWalletChange={() => wallet.reload()}
          prefillProtons={fund.prefillProtons}
        />
      )}
    </section>
  )
}

function CompanyPendingRow({ canAct, onResume, title }: { canAct: boolean; onResume(): Promise<unknown>; title: string }) {
  const { locale } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)
  const [busy, setBusy] = useState(false)

  return (
    <div className="flex items-center justify-between gap-3 py-1.5" data-company-marketplace-pending-row>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-(--atum-ink)">{title}</span>
        <span className="block text-(length:--atum-t-control) text-(--atum-ink-muted)">{copy.marketNotConfirmed}</span>
      </span>
      {canAct && (
        <Button
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void onResume().finally(() => setBusy(false))
          }}
          size="sm"
          variant="secondary"
        >
          {copy.fundRetry}
        </Button>
      )}
    </div>
  )
}

/**
 * One hired assistant: its state in a few words, and for owners and admins the one thing to do now
 * (stop renewing, renew after a pause, or check an unconfirmed renewal).
 */
function CompanyTeamRow({
  agent,
  canAct,
  companyId,
  entitlement,
  item,
  onFund,
  onPurchased,
  pending,
  scope
}: {
  agent: MatrixCompanyStoreAgent
  canAct: boolean
  companyId: string
  entitlement?: MatrixStoreEntitlement
  item?: MatrixStoreItem
  onFund(prefillProtons?: number): void
  onPurchased(): void
  pending?: MatrixCompanyStorePending
  scope: string
}) {
  const { locale } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)
  const storeCopy = matrixStoreCopy(locale)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<MatrixCompanyStoreActionResult | null>(null)
  const [cancelFailed, setCancelFailed] = useState(false)
  const renewAt = agent.renewAt ?? entitlement?.subscription?.renewAt ?? null
  const date = renewAt ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(renewAt)) : null
  const renewing = entitlement?.subscription?.state === 'active'
  const lapsed = agent.state === 'paused' || entitlement?.subscription?.state === 'lapsed'

  const status =
    agent.state === 'preparing'
      ? copy.marketPreparing
      : lapsed
        ? copy.marketPaused
        : agent.state === 'ending' || entitlement?.subscription?.state === 'cancelled'
          ? date
            ? copy.marketEnds(date)
            : null
          : date
            ? copy.marketRenews(date)
            : null

  const run = (action: () => Promise<MatrixCompanyStoreActionResult>) => {
    setBusy(true)
    setOutcome(null)
    void action()
      .then(result => {
        setOutcome(result)
        onPurchased()
      })
      .finally(() => setBusy(false))
  }

  const renew = () => {
    const offer = item?.offer

    if (!offer) {
      return
    }

    run(() =>
      purchaseCompanyItem(scope, companyId, {
        offerId: offer.id,
        offerVersion: offer.version,
        target: { agentId: agent.agentId },
        ...(offer.billingInterval === 'month' ? { consentRenewal: true as const } : {})
      })
    )
  }

  const stop = () => {
    if (!entitlement) {
      return
    }

    setBusy(true)
    setCancelFailed(false)
    void cancelCompanyEntitlement(scope, companyId, entitlement.id)
      .then(ok => {
        setCancelFailed(!ok)
        setConfirming(!ok)
      })
      .finally(() => setBusy(false))
  }

  const short = companyShortfallProtons(outcome)
  const refusedShort = outcome?.outcome === 'refused' && outcome.code === 'insufficient_protons'

  const line =
    outcome && outcome.outcome !== 'purchased'
      ? companyOutcomeCopy(outcome, { kind: 'agent', name: agent.name }, agent.name, copy, storeCopy, locale)
      : confirming && date
        ? copy.marketStopLine(agent.name, date)
        : null

  return (
    <li className="atum-store-card cursor-default" data-company-marketplace-agent={agent.agentId} data-state={agent.state}>
      <CompanyAIAvatar className="size-10 shrink-0 text-sm" name={agent.name} principal={agent.agentId} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.9375rem] font-semibold text-(--atum-ink)">{agent.name}</span>
        <span className="block text-(length:--atum-t-control) text-(--atum-ink-muted)">
          {pending ? copy.marketNotConfirmed : status}
        </span>
        {(line || cancelFailed) && (
          <span
            className="mt-0.5 block text-(length:--atum-t-control) text-(--atum-ink-soft)"
            data-company-marketplace-agent-line
            role="status"
          >
            {cancelFailed ? storeCopy.purchaseFailed : line}
          </span>
        )}
      </span>
      {canAct && (
        <span className="flex shrink-0 items-center gap-1.5">
          {pending ? (
            <Button
              aria-busy={busy || undefined}
              data-company-marketplace-resume
              disabled={busy}
              onClick={() => run(() => resumeCompanyPurchase(scope, companyId, pending.idempotencyKey))}
              size="sm"
              variant="secondary"
            >
              {copy.fundRetry}
            </Button>
          ) : refusedShort ? (
            <Button data-company-marketplace-fund onClick={() => onFund(short)} size="sm">
              {copy.marketAddProtons}
            </Button>
          ) : lapsed && item?.offer ? (
            <Button aria-busy={busy || undefined} data-company-marketplace-renew disabled={busy} onClick={renew} size="sm">
              {copy.marketRenew}
            </Button>
          ) : confirming ? (
            <>
              <Button disabled={busy} onClick={() => setConfirming(false)} size="sm" variant="text">
                {copy.marketKeep}
              </Button>
              <Button
                aria-busy={busy || undefined}
                data-company-marketplace-stop-confirm
                disabled={busy}
                onClick={stop}
                size="sm"
                variant="secondary"
              >
                {copy.marketStopRenewing}
              </Button>
            </>
          ) : renewing && entitlement ? (
            <Button data-company-marketplace-stop onClick={() => setConfirming(true)} size="sm" variant="text">
              {copy.marketStopRenewing}
            </Button>
          ) : null}
        </span>
      )}
    </li>
  )
}
