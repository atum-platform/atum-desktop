import { type ReactNode, useState } from 'react'

import { ProtonAmount, ProtonText } from '@/components/brand/proton-mark'
import { Button } from '@/components/ui/button'
import { DialogContent, DialogDescription, DialogTitle, preventCloseButtonAutoFocus } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { ArrowLeft } from '@/lib/icons'

import { type MatrixCompanyBoardCopy, matrixCompanyBoardCopy } from '../../../shared/matrix-company-board-copy'
import type { MatrixCompanyStoreActionResult } from '../../../shared/matrix-company-store'
import type { MatrixStoreEntitlement, MatrixStoreItem, MatrixStoreOffer } from '../../../shared/matrix-store'
import { microProtons, wholeProtons } from '../wallet-ui'

import { localizedStoreText, StoreArt, storePriceText } from './store-card'
import { type MatrixStoreCopy, matrixStoreCopy } from './store-copy'
import { itemOwnedForAssistant, itemStoreOwnership } from './store-ownership'

const MICRO = 1_000_000

/**
 * The Store detail sheet in a company: the item is hired into (or added to) the company and paid
 * from the company wallet. There is no personal assistant picker, no personal wallet and no personal
 * checkout here: the only purchase this sheet can start is the company's.
 */
export interface StoreCompanyMode {
  /** Owners and admins act; a member sees one line in place of the action and no balance. */
  canAct: boolean
  /** The company wallet's available micro-Protons, for owners and admins only. */
  balanceMicroProtons?: number
  /** Where a skill goes: the Chief of Staff first, then the company's hired assistants. */
  targets: readonly { id: string; name: string }[]
  entitlements: readonly MatrixStoreEntitlement[]
  /** An unconfirmed purchase of this item. Its only action replays it; a second Hire never starts. */
  pendingKey?: string
  acquire(item: MatrixStoreItem, agentId: string | null): Promise<MatrixCompanyStoreActionResult>
  resume(idempotencyKey: string): Promise<MatrixCompanyStoreActionResult>
  /** The company's fund step, drawn inside the sheet and filled with what is missing (whole Protons). */
  renderFund(input: { shortfallProtons?: number; onDone(): void }): ReactNode
}

/** Whole Protons, rounded up: covering a shortfall must never leave the company one Proton short. */
export function companyShortfallProtons(result: MatrixCompanyStoreActionResult | null): number | undefined {
  return result?.outcome === 'refused' &&
    result.code === 'insufficient_protons' &&
    'shortfallMicroProtons' in result &&
    result.shortfallMicroProtons !== undefined &&
    result.shortfallMicroProtons > 0
    ? Math.ceil(result.shortfallMicroProtons / MICRO)
    : undefined
}

/** What a company purchase outcome means, in one line. */
export function companyOutcomeCopy(
  outcome: MatrixCompanyStoreActionResult | null,
  item: { kind: MatrixStoreItem['kind']; name: string },
  targetName: string | undefined,
  copy: MatrixCompanyBoardCopy,
  storeCopy: MatrixStoreCopy,
  locale: string
): string | null {
  if (!outcome) {
    return null
  }

  switch (outcome.outcome) {
    case 'purchased':
      if (outcome.purchase.state === 'delivery_pending') {
        return storeCopy.purchasePending
      }

      return item.kind === 'agent' || !targetName
        ? copy.marketJoined(item.name)
        : copy.marketSkillAdded(targetName)

    case 'already_owned':
      return copy.marketAlreadyHas

    case 'offer_changed':
      return storeCopy.offerChanged

    case 'uncertain':
      return copy.marketUncertain
    case 'refused': {
      if (outcome.code === 'insufficient_protons') {
        const short = companyShortfallProtons(outcome)

        return short === undefined
          ? copy.marketShortUnknown
          : copy.marketShort(new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(short))
      }

      if (outcome.code === 'denied') {
        return item.kind === 'agent' ? copy.marketMemberHire : copy.marketMemberSkill
      }

      return storeCopy.refused(item.kind)
    }
  }
}

/**
 * The press says what it charges today: "Hire · 8,000 Protons first month" for a hire whose first
 * month is priced apart, "Hire · free first month", otherwise "Hire · 39,000 Protons / month".
 * What every later month costs goes on the line under it (`companyTermsText`).
 */
export function companyActionText(
  offer: MatrixStoreOffer,
  copy: MatrixCompanyBoardCopy,
  storeCopy: MatrixStoreCopy,
  locale: string
): { text: string; amounts: string[] } {
  if (offer.billingInterval === 'month') {
    if (companyFirstMonthOffer(offer)) {
      if (offer.priceMicroProtons === 0) {
        return { text: copy.marketHireFreeFirst, amounts: [] }
      }

      const first = microProtons(offer.priceMicroProtons, locale)

      return { text: copy.marketHire(storeCopy.monthlyFirst(first)), amounts: [first] }
    }

    const amount = microProtons(offer.priceMicroProtons, locale)

    return { text: copy.marketHire(`${amount} ${storeCopy.protons} ${storeCopy.monthly}`), amounts: [amount] }
  }

  if (offer.priceMicroProtons === 0) {
    return { text: storeCopy.get, amounts: [] }
  }

  const amount = microProtons(offer.priceMicroProtons, locale)

  return { text: copy.marketAdd(`${amount} ${storeCopy.protons}`), amounts: [amount] }
}

/** A monthly hire whose first month is priced apart from every month after it. */
function companyFirstMonthOffer(offer: MatrixStoreOffer): offer is MatrixStoreOffer & { renewalPriceMicroProtons: number } {
  return (
    offer.billingInterval === 'month' &&
    offer.renewalPriceMicroProtons !== undefined &&
    offer.renewalPriceMicroProtons !== offer.priceMicroProtons
  )
}

/**
 * The line under the press: the renewal, when the first month was priced apart, then who pays.
 * "then 39,000/mo · Paid from the company wallet. Cancel anytime."
 */
export function companyTermsText(
  offer: MatrixStoreOffer,
  copy: MatrixCompanyBoardCopy,
  storeCopy: MatrixStoreCopy,
  locale: string
): { text: string; amounts: string[] } {
  if (offer.billingInterval !== 'month') {
    return { text: copy.marketPaidOnce, amounts: [] }
  }

  if (!companyFirstMonthOffer(offer)) {
    return { text: copy.marketPaidMonthly, amounts: [] }
  }

  const renewal = microProtons(offer.renewalPriceMicroProtons, locale)

  return { text: `${storeCopy.monthlyThen(renewal)} · ${copy.marketPaidMonthly}`, amounts: [renewal] }
}

function ready(outcome: MatrixCompanyStoreActionResult | null) {
  return (
    outcome?.outcome === 'already_owned' ||
    (outcome?.outcome === 'purchased' && outcome.purchase.state !== 'delivery_pending')
  )
}

export function CompanyStoreDetailContent({
  closeButton,
  company,
  facts,
  item,
  onOpenChange
}: {
  closeButton: ReactNode
  company: StoreCompanyMode
  /** The shared Store facts (what it uses, try saying), as the personal sheet draws them. */
  facts: ReactNode
  item: MatrixStoreItem
  onOpenChange(open: boolean): void
}) {
  const { locale, t } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)
  const storeCopy = matrixStoreCopy(locale)
  const entitlements = [...company.entitlements]
  const skill = item.kind === 'skill'
  const offer = item.offer

  // A skill opens on the first company agent that does not have it yet.
  const [chosen, setChosen] = useState<string>(
    () =>
      (company.targets.find(target => !itemOwnedForAssistant(item, entitlements, target.id)) ?? company.targets[0])?.id ??
      ''
  )

  const [choosing, setChoosing] = useState(false)
  const target = skill ? (company.targets.find(entry => entry.id === chosen) ?? company.targets[0]) : undefined
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<MatrixCompanyStoreActionResult | null>(null)
  const [view, setView] = useState<'item' | 'fund'>('item')

  const owned = skill
    ? Boolean(target && itemOwnedForAssistant(item, entitlements, target.id))
    : itemStoreOwnership(item, entitlements).state === 'owned'

  const done = owned || ready(outcome)
  const shortfall = companyShortfallProtons(outcome)
  const refusedShort = outcome?.outcome === 'refused' && outcome.code === 'insufficient_protons'
  // A free first month is still a priced hire: every month after it is paid.
  const priced = Boolean(offer && (offer.priceMicroProtons > 0 || (offer.renewalPriceMicroProtons ?? 0) > 0))
  const canAcquire = company.canAct && Boolean(offer) && !done && (!skill || Boolean(target))
  const title = localizedStoreText(item.title, locale)
  const notice = companyOutcomeCopy(outcome, { kind: item.kind, name: title }, target?.name, copy, storeCopy, locale)
  const whole = (micro: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(wholeProtons(micro))
  const balance = company.canAct ? company.balanceMicroProtons : undefined

  const run = (action: () => Promise<MatrixCompanyStoreActionResult>) => {
    if (pending) {
      return
    }

    setPending(true)
    setOutcome(null)

    void action()
      .catch((): MatrixCompanyStoreActionResult => ({ outcome: 'uncertain' }))
      .then(result => setOutcome(result))
      .finally(() => setPending(false))
  }

  const acquire = () => {
    if (canAcquire && !company.pendingKey) {
      run(() => company.acquire(item, skill ? (target?.id ?? null) : null))
    }
  }

  if (view === 'fund') {
    return (
      <DialogContent
        className="atum-store-sheet"
        data-company-store-detail={item.itemId}
        data-store-detail-view="fund"
        onOpenAutoFocus={preventCloseButtonAutoFocus}
        showCloseButton={false}
      >
        {closeButton}
        <div className="flex items-center gap-3 pe-8">
          <StoreArt item={item} size="tile" />
          <div className="min-w-0">
            <DialogTitle className="truncate">{title}</DialogTitle>
            <DialogDescription className="mt-0.5">{notice ?? copy.wallet}</DialogDescription>
          </div>
        </div>
        {company.renderFund({
          shortfallProtons: shortfall,
          onDone: () => {
            setOutcome(null)
            setView('item')
          }
        })}
        <div className="mt-5 flex">
          <Button data-company-store-fund-back onClick={() => setView('item')} size="sm" variant="text">
            <ArrowLeft aria-hidden className="size-3.5" />
            {storeCopy.back}
          </Button>
        </div>
      </DialogContent>
    )
  }

  const action = offer ? companyActionText(offer, copy, storeCopy, locale) : null
  // Under the Hire press only: what it renews at and who pays. Check again and Add Protons need none.
  const terms =
    offer && priced && company.canAct && !done && !refusedShort && !company.pendingKey
      ? companyTermsText(offer, copy, storeCopy, locale)
      : null
  const tone = outcome?.outcome === 'purchased' || outcome?.outcome === 'already_owned' || refusedShort ? 'notice' : 'failure'

  return (
    <DialogContent
      className="atum-store-sheet"
      data-company-store-detail={item.itemId}
      data-owned={done || undefined}
      onOpenAutoFocus={preventCloseButtonAutoFocus}
      showCloseButton={false}
    >
      {closeButton}
      <div className="flex items-center gap-4 pe-8">
        <StoreArt item={item} size="tile" />
        <div className="min-w-0 flex-1">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="mt-0.5">{copy.marketKindForCompany(storeCopy.kind[item.kind])}</DialogDescription>
        </div>
      </div>
      {localizedStoreText(item.description, locale) && (
        <p className="mt-5 [font:var(--ak-t-body)] text-(--ak-ink)" data-store-description>
          {localizedStoreText(item.description, locale)}
        </p>
      )}
      {facts}
      {skill && target && (
        <div className="mt-5 grid gap-2 [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-company-store-target>
          <p>
            {storeCopy.addsTo(target.name)}
            {company.canAct && company.targets.length > 1 && !choosing && !done && (
              <button className="ms-1 font-semibold text-(--ak-ink)" onClick={() => setChoosing(true)} type="button">
                {t.common.change}
              </button>
            )}
          </p>
          {choosing && (
            <select
              aria-label={storeCopy.targetAgent}
              className="ak-select"
              disabled={pending}
              onChange={event => {
                setChosen(event.target.value)
                setOutcome(null)
                setChoosing(false)
              }}
              value={target.id}
            >
              {company.targets.map(entry => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {/* A member has no press to read the price from: the whole price is written here. */}
      {offer && !done && !company.canAct && priced && (
        <p className="mt-4 [font:var(--ak-t-callout)] text-(--ak-ink)" data-company-store-price>
          <ProtonText
            amounts={[offer.priceMicroProtons, offer.renewalPriceMicroProtons ?? 0]
              .filter(value => value > 0)
              .map(value => microProtons(value, locale))}
            text={storePriceText(offer, storeCopy, locale)}
            unit={storeCopy.protons}
          />
        </p>
      )}
      {(notice || company.pendingKey) && (
        <NoticeBand className="mt-4" role="status" tone={company.pendingKey && !outcome ? 'notice' : tone}>
          {notice ?? copy.marketUncertain}
        </NoticeBand>
      )}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-[1_1_8rem] text-(length:--atum-t-control) text-(--atum-ink-muted)">
          {balance !== undefined && priced && !done && (
            <span className="inline-flex items-center gap-1.5" data-company-store-balance>
              {copy.wallet}
              <ProtonAmount amount={whole(balance)} spoken={`${whole(balance)} ${storeCopy.protons}`} />
            </span>
          )}
        </div>
        {!company.canAct ? (
          <p className="text-(length:--atum-t-control) text-(--atum-ink-muted)" data-company-store-member>
            {done ? storeCopy.owned : skill ? copy.marketMemberSkill : copy.marketMemberHire}
          </p>
        ) : company.pendingKey && !ready(outcome) ? (
          <Button
            aria-busy={pending || undefined}
            className="atum-store-action"
            data-company-store-resume
            disabled={pending}
            onClick={() => run(() => company.resume(company.pendingKey!))}
          >
            {copy.fundRetry}
          </Button>
        ) : done ? (
          <Button
            className="atum-store-action"
            data-owned={outcome ? undefined : true}
            disabled={!outcome}
            onClick={() => onOpenChange(false)}
            variant={outcome ? 'secondary' : undefined}
          >
            {outcome ? storeCopy.close : storeCopy.owned}
          </Button>
        ) : refusedShort ? (
          <Button className="atum-store-action" data-company-store-fund onClick={() => setView('fund')}>
            {copy.marketAddProtons}
          </Button>
        ) : (
          <Button
            aria-busy={pending || undefined}
            className="atum-store-action"
            data-company-store-acquire
            disabled={!canAcquire || pending}
            onClick={acquire}
          >
            {action && action.amounts.length > 0 ? (
              <ProtonText amounts={action.amounts} text={action.text} unit={storeCopy.protons} />
            ) : (
              (action?.text ?? storeCopy.get)
            )}
          </Button>
        )}
      </div>
      {terms && (
        <p className="mt-2 text-end [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-company-store-terms>
          {terms.amounts.length > 0 ? (
            <ProtonText amounts={terms.amounts} text={terms.text} unit={storeCopy.protons} />
          ) : (
            terms.text
          )}
        </p>
      )}
    </DialogContent>
  )
}
