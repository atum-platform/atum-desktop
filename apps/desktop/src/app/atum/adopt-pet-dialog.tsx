// RETIRED legacy Store (pre-Matrix app): the platform switched its wallet spending off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { type AtumStoreOffer, storeCopy } from '@/lib/atum-store-items'
import { Loader2 } from '@/lib/icons'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import { $atumStoreCatalog } from '@/store/atum-store-catalog'
import { recoverStorePurchase, runStorePurchase, type StorePurchaseOutcome } from '@/store/atum-store-purchase'
import { $petInfoByAgent, petInfoFor, petProfile } from '@/store/pet'
import { adoptPetFor, type StorePetRow } from '@/store/pet-gallery'

import { $atumAgents } from './agents'
import { AtumAssistantAvatar } from './assistant-avatar'
import { StoreOfferCard } from './store-offer-card'

type PurchaseNotice = 'changed' | 'failed' | 'insufficient' | 'unavailable' | 'uncertain'

/**
 * "Give this pet to…" — the question Discover has to ask that the skills
 * section never does.
 *
 * A skill can be added to several assistants at once; a pet is one assistant's
 * face, so this is a single choice. The assistant in front is preselected
 * because that is the likeliest answer, and each row says which pet that
 * assistant has now, so replacing one is a decision rather than a surprise.
 *
 * When the store catalog prices the pet, buying happens here first (plan
 * 2026-09-10-atum-store.md, W5.4): the authoritative offer and its version and
 * the wallet's available Protons, exactly as main returned them; confirm mints
 * the idempotency key once and a retry reuses it. A pet the account already
 * owns skips the price — one adoption action adopts it. A completed purchase
 * followed by a failed adoption is "Owned · Retry install", never a second
 * purchase.
 *
 * Adoption goes through `adoptPetFor`, addressed to the chosen assistant's
 * profile — `pet.select` installs before it activates, so an assistant that
 * has never had a pet gets one in a single call, without switching to it.
 */
export function AdoptPetDialog({
  onAdopted,
  onOpenChange,
  pet
}: {
  /** The store plays its celebration on this; Discover shows the line inline. */
  onAdopted?: (agentId: string, pet: StorePetRow) => void
  onOpenChange: (open: boolean) => void
  pet: StorePetRow | null
}) {
  const { locale, t } = useI18n()
  const copy = t.atum.discover
  const { requestGateway } = useGatewayRequest()
  const agents = useStore($atumAgents)
  // Re-render when any assistant's pet changes, so the rows' "has X" lines and
  // the adopted state follow the live info rather than a stale snapshot.
  useStore($petInfoByAgent)
  const accountId = useStore($atumAccountScopeId)
  const storeView = useStore($atumStoreCatalog)
  const [target, setTarget] = useState(petProfile())
  const [busy, setBusy] = useState(false)
  const [adoptedFor, setAdoptedFor] = useState<null | string>(null)
  const [failed, setFailed] = useState(false)
  const [phase, setPhase] = useState<'choose' | 'purchase'>('choose')
  const [overrideOffer, setOverrideOffer] = useState<AtumStoreOffer | null>(null)
  const [purchased, setPurchased] = useState(false)
  const [purchaseBusy, setPurchaseBusy] = useState(false)
  const [notice, setNotice] = useState<PurchaseNotice | null>(null)

  // Every open starts from the assistant in front, with nothing adopted yet.
  useEffect(() => {
    if (pet) {
      setTarget(petProfile())
      setAdoptedFor(null)
      setFailed(false)
      setBusy(false)
      setPhase('choose')
      setOverrideOffer(null)
      setPurchased(false)
      setPurchaseBusy(false)
      setNotice(null)
    }
  }, [pet?.slug, pet])

  const nameOf = (id: string) => agents.find(agent => agent.id === id)?.title || t.atum.roster.assistant

  const offer = overrideOffer ?? pet?.storeOffer ?? null
  const entitled = Boolean(pet?.owned || purchased)
  // No catalog row, no free price: the catalog has not answered, so adoption
  // stays closed until it does (the pill that opens this dialog is already
  // disabled for such rows; this is the dialog's own gate).
  const priceUnknown = Boolean(pet && !entitled && !pet.storeItemId && pet.price.kind !== 'free')
  const availableProtons = storeView.catalog?.available_protons ?? null
  const catalogItem = pet?.storeItemId ? storeView.catalog?.items.find(item => item.id === pet.storeItemId) : undefined
  const offerDescription = catalogItem ? storeCopy(catalogItem.summary, locale) : null

  const adoptNow = async () => {
    if (!pet) {return}

    setBusy(true)
    setFailed(false)
    const ok = await adoptPetFor(requestGateway, pet.slug, target, copy.adoptFailed)
    setBusy(false)

    if (ok) {
      setAdoptedFor(target)
      onAdopted?.(target, pet)
    } else {
      setFailed(true)
    }
  }

  /** One translation of a purchase outcome into what the person sees. */
  const settle = (outcome: StorePurchaseOutcome) => {
    switch (outcome.kind) {
      case 'completed':

      case 'already_owned':
        setPurchased(true)
        setPhase('choose')
        void adoptNow()

        break

      case 'offer_changed':
        setOverrideOffer(outcome.offer)
        setNotice('changed')
        setPhase('purchase')

        break

      case 'insufficient_protons':
        setNotice('insufficient')

        break

      case 'unavailable':
        setNotice('unavailable')

        break

      case 'uncertain':
        setNotice('uncertain')

        break

      case 'failed':
        setNotice('failed')

        break
    }
  }

  const buy = async (targetOffer: AtumStoreOffer) => {
    if (!pet?.storeItemId || !accountId || purchaseBusy) {return}

    setPurchaseBusy(true)
    setNotice(null)

    const outcome = await runStorePurchase({ accountId, itemId: pet.storeItemId, kind: 'pet', offer: targetOffer })

    setPurchaseBusy(false)
    settle(outcome)
  }

  const recover = async () => {
    if (!pet?.storeItemId || !accountId || purchaseBusy) {return}

    setPurchaseBusy(true)
    setNotice(null)

    const outcome = await recoverStorePurchase({ accountId, itemId: pet.storeItemId, kind: 'pet' })

    setPurchaseBusy(false)
    settle(outcome)
  }

  const adopt = async () => {
    if (!pet || busy) {
      return
    }

    // Free adoption is for a pet no catalog row claims (free by source class)
    // or one this account already owns — the entitlement is the purchase. An
    // UNKNOWN price (the catalog has not answered) is never a free adoption.
    if (entitled || (!pet.storeItemId && pet.price.kind === 'free')) {
      void adoptNow()

      return
    }

    if (!offer) {return}

    if (offer.priceProtons > 0) {
      setPhase('purchase')

      return
    }

    // A free acquisition is an offer at price 0 and writes an entitlement too.
    void buy(offer)
  }

  const purchaseNotice = notice && (
    <NoticeBand className={notice === 'insufficient' ? 'mb-3' : 'mt-2'} role={notice === 'changed' ? 'status' : 'alert'}>
      <span>
        {notice === 'changed' ? copy.offerChanged
          : notice === 'insufficient' ? copy.insufficientProtons
          : notice === 'unavailable' ? copy.purchaseUnavailable
          : notice === 'uncertain' ? copy.purchaseUncertain
          : copy.purchaseFailed}
      </span>
      {notice === 'uncertain' && (
        <button className="ml-2 underline underline-offset-2" data-atum-store-recover onClick={() => void recover()} type="button">{copy.checkPurchase}</button>
      )}
    </NoticeBand>
  )

  return (
    <Dialog onOpenChange={onOpenChange} open={pet !== null}>
      <DialogContent className="max-w-[27.5rem] border-(--atum-line) bg-(--atum-card) text-(--atum-ink)" data-atum-adopt-pet>
        <DialogHeader>
          <DialogTitle className="text-(--atum-ink)">{copy.adoptTitle(pet?.displayName ?? '')}</DialogTitle>
          <DialogDescription className="text-(--atum-ink-muted)">{copy.adoptFor}</DialogDescription>
        </DialogHeader>

        {phase === 'purchase' && offer ? (
          <>
            {/* The authoritative offer, exactly as returned: price, version,
                and the available balance, as a product card whose buy button
                is the only way to charge. */}
            <StoreOfferCard
              availableProtons={availableProtons}
              busy={purchaseBusy}
              description={offerDescription}
              disabled={!accountId}
              offer={offer}
              onBuy={() => void buy(offer)}
              title={pet?.displayName ?? ''}
            >
              {purchaseNotice}
            </StoreOfferCard>
            <DialogFooter>
              <button
                className="rounded-full px-4 py-2 text-(length:--atum-t-control) font-medium text-(--atum-ink-muted) hover:bg-(--atum-hover)"
                disabled={purchaseBusy}
                onClick={() => setPhase('choose')}
                type="button"
              >
                {t.common.back}
              </button>
            </DialogFooter>
          </>
        ) : (
          <>
        <div className="flex flex-col gap-1.5" role="radiogroup">
          {agents.map(agent => {
            const current = petInfoFor(agent.id)
            const name = nameOf(agent.id)

            return (
              <label className="atum-row flex min-h-12 items-center gap-3 rounded-[var(--atum-r-row)] px-2.5 py-2" key={agent.id}>
                <input
                  checked={target === agent.id}
                  className="accent-(--atum-ink)"
                  disabled={busy || adoptedFor !== null}
                  name="atum-adopt-pet-target"
                  onChange={() => setTarget(agent.id)}
                  type="radio"
                />
                <AtumAssistantAvatar avatarUrl={agent.avatarUrl} className="size-(--atum-avatar-sm) shrink-0 rounded-full" id={agent.id} name={name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-(length:--atum-t-body) font-medium">{name}</span>
                  {current.enabled && current.displayName && (
                    <span className="block truncate text-(length:--atum-t-caption) text-(--atum-ink-muted)">{current.displayName}</span>
                  )}
                </span>
              </label>
            )
          })}
        </div>

        {failed && entitled && (
          <NoticeBand role="alert">
            <span>{copy.adoptFailed} </span>
            {/* Owned already: the retry installs again, never buys again. */}
            <button className="underline underline-offset-2" data-atum-owned-retry onClick={() => void adoptNow()} type="button">
              {copy.ownedRetryInstall}
            </button>
          </NoticeBand>
        )}
        {failed && !entitled && <NoticeBand role="alert">{copy.adoptFailed}</NoticeBand>}
        {purchaseNotice}
        {adoptedFor && (
          <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)" data-atum-adopt-pet-done>
            {copy.adoptedFor(nameOf(adoptedFor))}
          </p>
        )}

        <DialogFooter>
          <button
            className="rounded-full px-4 py-2 text-(length:--atum-t-control) font-medium text-(--atum-ink-muted) hover:bg-(--atum-hover)"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            {adoptedFor ? t.common.done : t.common.cancel}
          </button>
          {!adoptedFor && (
            <button
              aria-busy={busy || purchaseBusy || undefined}
              className="rounded-full bg-(--atum-ink) px-4 py-2 text-(length:--atum-t-control) font-medium text-(--atum-on-accent) disabled:opacity-50"
              data-atum-adopt-pet-confirm
              disabled={busy || purchaseBusy || priceUnknown}
              onClick={() => void adopt()}
              type="button"
            >
              {busy || purchaseBusy ? <><Loader2 aria-hidden className="mx-auto size-4 animate-spin" /><span className="sr-only">{copy.adopt}</span></> : copy.adopt}
            </button>
          )}
        </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
