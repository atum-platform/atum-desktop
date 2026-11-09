import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  preventCloseButtonAutoFocus
} from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ArrowLeft, Check, Photo, X } from '@/lib/icons'

import type { MatrixAgentView } from '../../../shared/matrix'
import type {
  MatrixStoreEntitlement,
  MatrixStoreItem,
  MatrixStoreKind,
  MatrixStoreResult
} from '../../../shared/matrix-store'
import type { MatrixWalletState } from '../../../shared/matrix-wallet'
import { matrixRosterAgentName } from '../roster-model'
import { microProtons, wholeProtons } from '../wallet-ui'

import { type DiscoverCheckout, MatrixCheckoutPane } from './checkout'
import { CompanyStoreDetailContent, type StoreCompanyMode } from './company-store-detail'
import { isHatchListing, type MatrixStoreListing } from './hatch-listing'
import { hubSkillInstalled, hubSkillRequest, isHubSkill } from './hub-skill'
import { storePetPreview } from './pet-previews'
import { localizedStoreText, StoreArt, StorePriceText, storePriceText } from './store-card'
import { type MatrixStoreCopy, matrixStoreCopy, storeRequirements } from './store-copy'
import { itemOwnedForAssistant, itemStoreOwnership } from './store-ownership'
import { $matrixStoreHubRequest } from './top-up'

export type StoreAcquireOutcome = MatrixStoreResult | { outcome: 'uncertain' }

/** The action that tries an item in its assistant's chat, or null when there is no chat to try it in. */
export type StoreTryItem = (item: MatrixStoreItem, assistantId: string | undefined) => (() => void) | null

/**
 * The Hatch card's way in: opens the companion's hatch panel, which quotes the hatch and
 * charges it only when the person hatches (or uses a credit they hold). Null when there is
 * no companion to open, and the card sells the hatch credit instead.
 */
export type StoreHatchPet = (mode?: 'describe' | 'photo') => (() => void) | null

/** An assistant's skill list (the names its definition carries), or null when it can't be read. */
export type StoreReadSkills = (agentPrincipal: string) => Promise<readonly string[] | null>

type AssistantAgent = MatrixAgentView & { assistantId: string }

function isOwned(item: MatrixStoreItem, entitlements: MatrixStoreEntitlement[], assistantId: string | null) {
  const ownership = itemStoreOwnership(item, entitlements)
  return item.kind === 'skill'
    ? itemOwnedForAssistant(item, entitlements, assistantId ?? undefined)
    : ownership.state === 'owned'
}

/**
 * What a purchase outcome means, in the person's words. A refusal is definite (nothing was
 * charged) and says so; only an uncertain outcome, which can still complete, points to
 * Purchased. `kind` names what did not happen ("the hire"); without it, "the purchase".
 */
export function storeOutcomeCopy(outcome: StoreAcquireOutcome | null, copy: MatrixStoreCopy, kind?: MatrixStoreKind) {
  if (!outcome) {
    return null
  }

  if (outcome.outcome === 'purchased') {
    return outcome.purchase.state === 'delivery_pending' ? copy.purchasePending : copy.purchaseCompleted
  }

  if (outcome.outcome === 'already_owned') {
    return copy.alreadyOwned
  }

  if (outcome.outcome === 'offer_changed') {
    return copy.offerChanged
  }

  if (outcome.outcome === 'uncertain') {
    return copy.purchaseUncertain
  }

  return outcome.code === 'insufficient_protons' ? copy.refusedShort(kind) : copy.refused(kind)
}

/** A purchase that left the item ready to use (a pending delivery is not, yet). */
function ready(outcome: StoreAcquireOutcome | null) {
  return (
    outcome?.outcome === 'already_owned' ||
    (outcome?.outcome === 'purchased' && outcome.purchase.state !== 'delivery_pending')
  )
}

interface StoreDetailProps {
  item: MatrixStoreListing | null
  agents: MatrixAgentView[]
  entitlements: MatrixStoreEntitlement[]
  /** The person's Protons: the balance under the price, and why a top-up is offered. */
  wallet?: MatrixWalletState
  /** The Store's own checkout: a short balance opens its packs right here, beside the item. */
  checkout?: DiscoverCheckout
  onAcquire?: (item: MatrixStoreItem, assistantId?: string, consentRenewal?: true) => Promise<StoreAcquireOutcome>
  /** Only without an in-app checkout: Atum's payments page. */
  onTopUp?: () => void
  tryItem?: StoreTryItem
  hatchPet?: StoreHatchPet
  /** A free Hub skill is "Installed" once the chosen assistant's skill list has it. */
  readSkills?: StoreReadSkills
  /** The assistant the person was using before opening the Store. */
  preferredAssistantId?: string
  onOpenChange(open: boolean): void
}

/**
 * The company's sheet: the same item, art and facts, hired into the company and paid from its
 * wallet. None of the personal props (assistants, wallet, checkout, acquire) reach it.
 */
interface CompanyStoreDetailProps {
  item: MatrixStoreItem | null
  company: StoreCompanyMode
  onOpenChange(open: boolean): void
}

export function StoreDetail(props: StoreDetailProps | CompanyStoreDetailProps) {
  if (!props.item) {
    return null
  }

  return (
    <Dialog onOpenChange={props.onOpenChange} open>
      {/* Keyed by item: a new item starts fresh; a snapshot refresh keeps the outcome on screen. */}
      {'company' in props ? (
        <CompanyStoreDetailContent
          closeButton={<StoreCloseButton />}
          company={props.company}
          facts={<StoreDetailFacts item={props.item} />}
          item={props.item}
          key={props.item.itemId}
          onOpenChange={props.onOpenChange}
        />
      ) : (
        <StoreDetailContent key={props.item.itemId} {...props} item={props.item} />
      )}
    </Dialog>
  )
}

function StoreCloseButton() {
  const { locale } = useI18n()
  const copy = matrixStoreCopy(locale)

  return (
    <Tip label={copy.close}>
      <DialogClose asChild>
        <button aria-label={copy.close} className="atum-store-close" data-store-close type="button">
          <X aria-hidden className="size-4" />
        </button>
      </DialogClose>
    </Tip>
  )
}

/** What an item uses and what to try saying: the same in a person's sheet and a company's. */
function StoreDetailFacts({ item }: { item: MatrixStoreItem }) {
  const { locale } = useI18n()
  const copy = matrixStoreCopy(locale)
  const requirements = storeRequirements(item.needs, copy)
  const example = localizedStoreText(item.tryPrompt, locale)

  return (
    <>
      {requirements.length > 0 && (
        <section aria-label={copy.whatItUses} className="mt-5 grid gap-2" data-store-data-use>
          <h3 className="[font:var(--ak-t-caption)] text-(--ak-ink-3)">{copy.whatItUses}</h3>
          {requirements.map(requirement => (
            <p className="flex items-center gap-2.5 [font:var(--ak-t-body)] text-(--ak-ink)" key={requirement}>
              <Check aria-hidden className="ak-icon ak-icon--sm shrink-0" />
              <span>{requirement}</span>
            </p>
          ))}
        </section>
      )}
      {example && (
        <section aria-label={copy.trySaying} className="mt-5 grid gap-2" data-store-try-prompt>
          <h3 className="[font:var(--ak-t-caption)] text-(--ak-ink-3)">{copy.trySaying}</h3>
          <p className="rounded-(--ak-r-lg) bg-(--ak-ground) px-3.5 py-3 [font:var(--ak-t-body)] text-(--ak-ink)">
            “{example}”
          </p>
        </section>
      )}
    </>
  )
}

function StoreDetailContent({
  item,
  agents,
  entitlements,
  wallet,
  checkout,
  onAcquire,
  onTopUp,
  tryItem,
  hatchPet,
  readSkills,
  preferredAssistantId,
  onOpenChange
}: StoreDetailProps & { item: MatrixStoreListing }) {
  const { locale, t } = useI18n()
  const copy = matrixStoreCopy(locale)
  const consentBox = useRef<HTMLInputElement>(null)

  // Paid content reaches the model only through Atum's AI, so a cloud item is taught only to
  // an assistant answering with it: with its own model the buyer would pay and get nothing.
  const atumOnly = Boolean(item.offer) && item.offer?.delivery !== 'bundled'

  const assistants = useMemo(
    () => agents.filter((agent): agent is AssistantAgent => Boolean(agent.assistantId)),
    [agents]
  )

  const availableAgents = useMemo(
    () => assistants.filter(agent => !atumOnly || agent.atumModel),
    [assistants, atumOnly]
  )

  const ownModelLeftOut = availableAgents.length < assistants.length

  // A skill opens on the first assistant that does not have it yet.
  const [chosenAssistant, setChosenAssistant] = useState<string>(() => {
    const preferred = availableAgents.find(agent => agent.assistantId === preferredAssistantId)

    return (
      (
        preferred ??
        availableAgents.find(agent => !isOwned(item, entitlements, agent.assistantId)) ??
        availableAgents[0]
      )?.assistantId ?? ''
    )
  })

  const [choosingAssistant, setChoosingAssistant] = useState(false)

  const assistantId = availableAgents.some(agent => agent.assistantId === chosenAssistant)
    ? chosenAssistant
    : (availableAgents[0]?.assistantId ?? '')

  const [renewalConsent, setRenewalConsent] = useState(false)
  const [consentNeeded, setConsentNeeded] = useState(false)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<StoreAcquireOutcome | null>(null)
  const [view, setView] = useState<'item' | 'topup'>('item')

  const scopedSkill = item.kind === 'skill' && item.offer?.scope === 'agent'
  // A free Hub skill is installed per assistant too, by that assistant's Skills Hub.
  const hub = isHubSkill(item) ? item.install : null
  const perAssistant = scopedSkill || Boolean(hub)
  const monthlyHire = item.kind === 'agent' && item.offer?.billingInterval === 'month'
  const hubPrincipal = hub ? availableAgents.find(agent => agent.assistantId === assistantId)?.principal : undefined
  const [skillLists, setSkillLists] = useState<Record<string, readonly string[] | null>>({})
  const hubSkills = hubPrincipal ? skillLists[hubPrincipal] : undefined
  const installed = Boolean(hub && hubSkills && hubSkillInstalled(hub, hubSkills))

  // The chosen assistant's skills, read as it is chosen. Until (or unless) they arrive the
  // Hub is offered: the Hub shows what is installed and never installs twice.
  useEffect(() => {
    if (!hubPrincipal || !readSkills) {
      return
    }

    let live = true

    void readSkills(hubPrincipal)
      .catch(() => null)
      .then(skills => {
        if (live) {
          setSkillLists(lists => ({ ...lists, [hubPrincipal]: skills }))
        }
      })

    return () => {
      live = false
    }
  }, [hubPrincipal, readSkills])

  const owned = installed || isOwned(item, entitlements, scopedSkill ? assistantId || null : null)
  const ownership = itemStoreOwnership(item, entitlements)
  const ownedLabel = installed ? copy.installed : ownership.source === 'gift' ? copy.gift : copy.owned
  const done = owned || ready(outcome)
  const canTopUp = Boolean(checkout || onTopUp)
  const canAcquire = Boolean(onAcquire) && Boolean(item.offer) && !owned && (!scopedSkill || Boolean(assistantId))
  const balance = wallet?.state === 'ready' ? wallet.wallet.balances.available : null
  const refusedShort = outcome?.outcome === 'refused' && outcome.code === 'insufficient_protons'
  const priced = Boolean(item.offer && item.offer.priceMicroProtons > 0)
  const hatchListing = isHatchListing(item)
  // The Hatch card makes a pet in the companion's hatch panel. The panel quotes the server's
  // hatch offer and charges it only when the person hatches a draft, or uses a credit they
  // already hold, so the Store buys nothing for it and a held credit opens the panel too.
  const hatchPanel = hatchListing ? (hatchPet?.('describe') ?? null) : null
  const hatchPhoto = hatchListing ? (hatchPet?.('photo') ?? null) : null
  // The panel spends a held hatch credit before any offer, as the Shell's pet catalog funds it:
  // any active `pet/hatch-first` or `pet/hatch` credit. The card's own projection is per row,
  // so a first-hatch credit can be held while the regular row reads available.
  const hatchCredit =
    owned || entitlements.some(row => isHatchListing(row) && row.kind === 'pet' && row.state === 'active')

  // Who has the item now: the chosen assistant for a skill, the hired assistant for a hire,
  // the default assistant (no id) for a pet.
  const tryAssistant =
    item.kind === 'skill'
      ? assistantId || undefined
      : item.kind === 'agent'
        ? ((outcome?.outcome === 'purchased' || outcome?.outcome === 'already_owned'
            ? outcome.entitlement?.assistantId
            : undefined) ??
          ownership.assistantIds[0] ??
          undefined)
        : undefined

  const tryNow = done && tryItem ? tryItem(item, tryAssistant ?? undefined) : null

  // "Get · [mark] 8,000": the button's name still says "Get · 8,000 Protons".
  const getAction =
    item.offer && item.offer.priceMicroProtons > 0 ? (
      <StorePriceText copy={copy} locale={locale} offer={item.offer} text={copy.getFor(storePriceText(item.offer, copy, locale))} />
    ) : (
      copy.get
    )

  const notice = storeOutcomeCopy(outcome, copy, item.kind)

  const acquire = () => {
    if (!onAcquire || !canAcquire || pending) {
      return
    }

    // The renewal box is asked about once it matters: pressing Hire without it.
    if (monthlyHire && !renewalConsent) {
      setConsentNeeded(true)
      consentBox.current?.focus()

      return
    }

    setPending(true)
    setOutcome(null)

    const acquisition = monthlyHire
      ? onAcquire(item, scopedSkill ? assistantId : undefined, true)
      : onAcquire(item, scopedSkill ? assistantId : undefined)

    void acquisition
      .then(result => {
        setOutcome(result)
      })
      .catch(() => setOutcome({ outcome: 'uncertain' }))
      .finally(() => setPending(false))
  }

  // The chosen assistant's Skills page opens on the Hub at this skill; the Store installs nothing.
  const openHub = () => {
    if (hub && hubPrincipal) {
      $matrixStoreHubRequest.set(hubSkillRequest(hub, hubPrincipal))
    }
  }

  const topUp = () => {
    if (checkout) {
      setView('topup')
    } else {
      onTopUp?.()
    }
  }

  const closeButton = <StoreCloseButton />

  if (view === 'topup' && checkout) {
    return (
      <DialogContent
        className="atum-store-sheet"
        data-store-detail={item.itemId}
        data-store-detail-view="topup"
        onOpenAutoFocus={preventCloseButtonAutoFocus}
        showCloseButton={false}
      >
        {closeButton}
        <div className="flex items-center gap-3 pe-8">
          <StoreArt item={item} size="tile" />
          <div className="min-w-0">
            <DialogTitle className="truncate">{localizedStoreText(item.title, locale)}</DialogTitle>
            <DialogDescription className="mt-0.5">
              {balance === null ? copy.topUp : copy.balance(formatWhole(balance, locale))}
            </DialogDescription>
          </div>
        </div>
        <h3 className="atum-store-heading mt-6">{copy.topUp}</h3>
        <MatrixCheckoutPane
          checkout={checkout}
          copy={copy}
          doneLabel={copy.continue}
          onDone={() => {
            setOutcome(null)
            setView('item')
          }}
          wallet={wallet}
        />
        <div className="mt-5 flex">
          <Button data-store-topup-back onClick={() => setView('item')} size="sm" variant="text">
            <ArrowLeft aria-hidden className="size-3.5" />
            {copy.back}
          </Button>
        </div>
      </DialogContent>
    )
  }

  const portrait = Boolean(storePetPreview(item.itemId))
  const description = localizedStoreText(item.description, locale)
  const targetAgent = availableAgents.find(agent => agent.assistantId === assistantId)

  return (
    <DialogContent
      className="atum-store-sheet"
      data-owned={done || undefined}
      data-store-detail={item.itemId}
      onOpenAutoFocus={preventCloseButtonAutoFocus}
      showCloseButton={false}
    >
      {/* A pet shows its portrait across the sheet; anything else wears its app tile beside its
          name, as a Mac app's info sheet does (Atum Kit 0.1). */}
      {portrait && <StoreArt item={item} size="panel" />}
      {closeButton}
      <div className={`${portrait ? 'mt-5' : 'pe-8'} flex items-center gap-4`}>
        {!portrait && <StoreArt item={item} size="tile" />}
        <div className="min-w-0 flex-1">
          <DialogTitle>{localizedStoreText(item.title, locale)}</DialogTitle>
          <DialogDescription className="mt-0.5">{copy.itemByAtum(copy.kind[item.kind])}</DialogDescription>
        </div>
      </div>
      {description && (
        <p className="mt-5 [font:var(--ak-t-body)] text-(--ak-ink)" data-store-description>
          {description}
        </p>
      )}
      {item.ownership?.state === 'visiting' && (
        <p className="mt-3 [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-store-visiting>
          {copy.visiting}
        </p>
      )}
      {done && hatchPanel && (
        <p className="mt-3 [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-owned>
          {ownedLabel}
        </p>
      )}
      {hatchListing && !hatchPanel && (
        <p className="mt-3 [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-store-hatch-how>
          {copy.hatchHow}
        </p>
      )}
      {item.regularOffer && !done && (
        <p className="mt-3 [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-store-first-hatch-note>
          {copy.firstHatchNote} {copy.regularPrice}: {storePriceText(item.regularOffer, copy, locale)}
        </p>
      )}
      <StoreDetailFacts item={item} />
      {hatchPanel && (
        <p className="mt-1 text-(length:--atum-t-control) text-(--atum-ink-muted)" data-store-hatch-charge>
          {hatchCredit ? copy.hatchCreditReady : copy.hatchChargedOnHatch}
        </p>
      )}
      {perAssistant &&
        (availableAgents.length > 0 ? (
          <div className="mt-5 grid gap-2 [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-store-target-agent>
            <p>
              {copy.addsTo(matrixRosterAgentName(targetAgent!, t.matrixShell.assistantName))}
              {availableAgents.length > 1 && !choosingAssistant && (
                <button
                  className="ms-1 font-semibold text-(--ak-ink)"
                  onClick={() => setChoosingAssistant(true)}
                  type="button"
                >
                  {t.common.change}
                </button>
              )}
            </p>
            {choosingAssistant && (
              <select
                aria-label={copy.targetAgent}
                className="ak-select"
                disabled={pending}
                onChange={event => {
                  setChosenAssistant(event.target.value)
                  setOutcome(null)
                  setChoosingAssistant(false)
                }}
                value={assistantId}
              >
                {availableAgents.map(agent => (
                  <option key={agent.assistantId} value={agent.assistantId}>
                    {matrixRosterAgentName(agent, t.matrixShell.assistantName)}
                  </option>
                ))}
              </select>
            )}
          </div>
        ) : (
          <p className="mt-4 text-(length:--atum-t-control) text-(--atum-ink-muted)" data-store-no-assistant>
            {ownModelLeftOut ? copy.needsAtumAi : copy.noTargetAgent}
          </p>
        ))}
      {scopedSkill && ownModelLeftOut && availableAgents.length > 0 && (
        <p className="mt-1 text-(length:--atum-t-control) text-(--atum-ink-muted)" data-store-needs-atum-ai>
          {copy.needsAtumAi}
        </p>
      )}
      {monthlyHire && !done && item.offer?.renewalPriceMicroProtons !== undefined && (
        <div className="mt-4 grid gap-2 text-(length:--atum-t-control) text-(--atum-ink-soft)" data-store-hire-renewal>
          <label className="flex items-start gap-2 font-medium">
            <input
              aria-invalid={consentNeeded && !renewalConsent ? true : undefined}
              checked={renewalConsent}
              onChange={event => {
                setRenewalConsent(event.target.checked)
                setConsentNeeded(false)
              }}
              ref={consentBox}
              type="checkbox"
            />
            <span>
              {copy.hireRenewalConsent(`${microProtons(item.offer.renewalPriceMicroProtons, locale)} ${copy.protons}`)}
            </span>
          </label>
          {consentNeeded && !renewalConsent && (
            <p className="text-(--atum-danger)" role="alert">
              {copy.hireConsentRequired}
            </p>
          )}
        </div>
      )}
      {notice && (
        <NoticeBand
          className="mt-4"
          role="status"
          tone={
            outcome?.outcome === 'purchased' || outcome?.outcome === 'already_owned' || refusedShort
              ? 'notice'
              : 'failure'
          }
        >
          {notice}
        </NoticeBand>
      )}
      {/* A long price wraps the button onto its own line rather than crushing the balance. */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-[1_1_8rem] text-(length:--atum-t-control)">
          <p className="text-(--atum-ink-muted)" data-store-balance>
            {balance !== null && priced && !done ? copy.balance(formatWhole(balance, locale)) : null}
          </p>
        </div>
        {hatchPanel ? (
          <div className="flex items-center gap-2">
            {hatchPhoto && (
              <Button
                className="atum-store-action"
                data-store-hatch-photo
                onClick={() => {
                  onOpenChange(false)
                  hatchPhoto()
                }}
              >
                <Photo aria-hidden className="size-4" />
                {copy.hatchChoosePhoto}
              </Button>
            )}
            <Button
              data-store-hatch
              onClick={() => {
                onOpenChange(false)
                hatchPanel()
              }}
              size="sm"
              variant="secondary"
            >
              {copy.hatchDescribe}
            </Button>
          </div>
        ) : done ? (
          tryNow ? (
            <Button className="atum-store-action" data-store-try onClick={tryNow}>
              {copy.tryNow}
            </Button>
          ) : outcome ? (
            <Button className="atum-store-action" onClick={() => onOpenChange(false)} variant="secondary">
              {copy.close}
            </Button>
          ) : (
            <Button className="atum-store-action" data-owned disabled>
              {ownedLabel}
            </Button>
          )
        ) : hub ? (
          // The Hub, not the Store, installs it: its own scan and confirmation come first.
          <Button className="atum-store-action" data-store-hub-install disabled={!hubPrincipal} onClick={openHub}>
            {copy.get}
          </Button>
        ) : refusedShort && canTopUp ? (
          <Button className="atum-store-action" data-store-topup onClick={topUp}>
            {copy.topUp}
          </Button>
        ) : (
          <Button
            aria-busy={pending || undefined}
            className="atum-store-action"
            data-store-acquire
            disabled={!canAcquire || pending}
            onClick={acquire}
          >
            {getAction}
          </Button>
        )}
      </div>
    </DialogContent>
  )
}

function formatWhole(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(wholeProtons(value))
}
