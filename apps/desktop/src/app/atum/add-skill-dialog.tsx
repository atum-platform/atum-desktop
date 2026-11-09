// RETIRED legacy Store (pre-Matrix app): the platform switched its wallet spending off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { type AtumStoreOffer, type AtumStoreSkillEntry, storeCopy } from '@/lib/atum-store-items'
import { Check, Loader2 } from '@/lib/icons'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import { $atumStoreCatalog } from '@/store/atum-store-catalog'
import { recoverStorePurchase, runStorePurchase, type StorePurchaseOutcome } from '@/store/atum-store-purchase'

import { $atumAgents, ATUM_AGENT_ID } from './agents'
import { AtumAssistantAvatar } from './assistant-avatar'
import { skillNeedsCopy } from './skill-detail-dialog'
import { $atumSkillRows, addAtumSkill, tryAtumSkill } from './skills'
import { StoreOfferCard } from './store-offer-card'

type PurchaseNotice = 'activation' | 'changed' | 'failed' | 'insufficient' | 'unavailable' | 'uncertain'

export interface AddSkillDialogProps {
  entry: AtumStoreSkillEntry | null
  onOpenChange: (open: boolean) => void
  open: boolean
  preselect?: null | string
  tryOnly?: boolean
}

/**
 * Add a store skill to assistants — and, when its offer has a price, buy it
 * first, here (plan 2026-09-10-atum-store.md, W5.4).
 *
 * The purchase step shows the authoritative offer and its version and the
 * wallet's available Protons exactly as main returned them — the renderer does
 * no arithmetic and no authorisation on balances. Confirming mints the
 * idempotency key ONCE (the store purchase module owns it): a double-click, a
 * retry or a second window reuses it, and `offer_changed` re-asks at the new
 * price and never charges the old one. A completed purchase followed by a
 * failed install is "Owned · Retry install" — never a second purchase.
 */
export function AddSkillDialog({ entry, onOpenChange, open, preselect = null, tryOnly = false }: AddSkillDialogProps) {
  const { locale, t } = useI18n()
  const agents = useStore($atumAgents)
  const rows = useStore($atumSkillRows)
  const accountId = useStore($atumAccountScopeId)
  const storeView = useStore($atumStoreCatalog)
  const row = entry ? rows.find(candidate => candidate.entry.identifier === entry.identifier) : undefined
  const operationGeneration = useRef(0)
  const [selected, setSelected] = useState<Set<string>>(new Set([ATUM_AGENT_ID]))
  const [submitted, setSubmitted] = useState(false)
  const [chooseTryTarget, setChooseTryTarget] = useState(false)
  const [tryTarget, setTryTarget] = useState<string | null>(null)
  const [phase, setPhase] = useState<'choose' | 'purchase'>('choose')
  const [overrideOffer, setOverrideOffer] = useState<AtumStoreOffer | null>(null)
  const [purchased, setPurchased] = useState(false)
  const [purchaseBusy, setPurchaseBusy] = useState(false)
  const [notice, setNotice] = useState<PurchaseNotice | null>(null)
  const copy = t.atum.discover

  useEffect(() => {
    operationGeneration.current += 1

    if (!open) {return}
    setSelected(new Set([preselect ?? agents.find(agent => agent.hostedId && agent.localProfileId !== null && !entry?.trainedAssistantIds?.includes(agent.hostedId))?.id ?? ATUM_AGENT_ID]))
    setSubmitted(false)
    // Try-only means several assistants already have the skill: the only
    // question left is which one to try with, so open in single-choice.
    setChooseTryTarget(tryOnly)
    setTryTarget(tryOnly ? (row?.installedFor[0] ?? null) : null)
    setPhase('choose')
    setOverrideOffer(null)
    setPurchased(false)
    setPurchaseBusy(false)
    setNotice(null)
    // `row` is read at open time on purpose; re-running on every row change
    // would reset the selection while installs are in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, entry?.identifier, open, preselect, tryOnly])

  const installedIds = row?.installedFor ?? []
  const installing = row?.assistants.some(assistant => assistant.action === 'installing') ?? false
  const completed = !installing && (tryOnly ? installedIds.length > 0 : submitted && [...selected].every(id => installedIds.includes(id)))

  // Cheap enough to derive every render; memoising it would only churn on the
  // fresh array `installedIds` falls back to.
  const selectableIds = [...selected].filter(id => !installedIds.includes(id))

  if (!entry) {return null}

  const prompt = storeCopy(entry.tryPrompt, locale)
  // The offer the person is looking at — the catalog row's, or the
  // authoritative replacement an `offer_changed` answer carried.
  const offer = overrideOffer ?? entry.offer
  const targetAgent = agents.find(agent => selected.has(agent.id))
  const targetAssistantId = targetAgent?.hostedId ?? null
  const entitled = Boolean(targetAssistantId && (entry.trainedAssistantIds?.includes(targetAssistantId) || purchased))
  const availableProtons = storeView.catalog?.available_protons ?? null

  const actTry = () => {
    if (submitted && targetAgent && installedIds.includes(targetAgent.id)) {
      tryAtumSkill(prompt, targetAgent.id, entry)
      onOpenChange(false)

      return
    }

    if (installedIds.length === 1) {
      tryAtumSkill(prompt, installedIds[0]!, entry)
      onOpenChange(false)
    } else if (!chooseTryTarget) {
      setChooseTryTarget(true)
      setTryTarget(installedIds[0] ?? null)
    } else if (tryTarget) {
      tryAtumSkill(prompt, tryTarget, entry)
      onOpenChange(false)
    }
  }

  const install = async () => {
    const generation = operationGeneration.current
    setPhase('choose')
    setSubmitted(true)

    try { await addAtumSkill(entry, selectableIds) } catch {
      if (generation === operationGeneration.current) { setNotice('activation') }
    }
  }

  /** One translation of a purchase outcome into what the person sees. */
  const settle = (outcome: StorePurchaseOutcome) => {
    switch (outcome.kind) {
      case 'completed':

      case 'already_owned':
        setPurchased(true)
        void install()

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
    if (!accountId || !targetAssistantId || purchaseBusy) {return}

    const generation = operationGeneration.current
    setPurchaseBusy(true)
    setNotice(null)

    const outcome = await runStorePurchase({ accountId, assistantId: targetAssistantId, itemId: entry.id, kind: 'skill', offer: targetOffer })

    if ($atumAccountScopeId.get() !== accountId || generation !== operationGeneration.current) { return }
    setPurchaseBusy(false)
    settle(outcome)
  }

  const recover = async () => {
    if (!accountId || !targetAssistantId || purchaseBusy) {return}

    const generation = operationGeneration.current
    setPurchaseBusy(true)
    setNotice(null)

    const outcome = await recoverStorePurchase({ accountId, assistantId: targetAssistantId, itemId: entry.id, kind: 'skill' })

    if ($atumAccountScopeId.get() !== accountId || generation !== operationGeneration.current) { return }
    setPurchaseBusy(false)
    settle(outcome)
  }

  const confirmAdd = () => {
    // No active offer and no entitlement: nothing to acquire through.
    if (!entitled && !offer) {return}

    if (entitled || !offer) {
      void install()

      return
    }

    if (offer.priceProtons > 0) {
      setPhase('purchase')

      return
    }

    // A free acquisition is an offer at price 0 and writes an entitlement too
    // — the same path, with no price screen.
    void buy(offer)
  }

  const purchaseNotice = notice && (
    <NoticeBand className={notice === 'insufficient' ? 'mb-3' : 'mt-2'} role={notice === 'changed' ? 'status' : 'alert'}>
      <span>
        {notice === 'changed' ? copy.offerChanged
          : notice === 'insufficient' ? copy.insufficientProtons
          : notice === 'unavailable' ? copy.purchaseUnavailable
          : notice === 'uncertain' ? copy.purchaseUncertain
          : notice === 'activation' ? copy.trainingRetryActivate
          : copy.purchaseFailed}
      </span>
      {notice === 'uncertain' && (
        <button className="ml-2 underline underline-offset-2" data-atum-store-recover onClick={() => void recover()} type="button">{copy.checkPurchase}</button>
      )}
    </NoticeBand>
  )

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-[27.5rem] border-(--atum-line) bg-(--atum-card) text-(--atum-ink)" data-atum-add-skill>
        <DialogHeader>
          <DialogTitle className="text-(--atum-ink)">{copy.addTitle(storeCopy(entry.name, locale))}</DialogTitle>
          {/* The plain permission line belongs at the moment of consent, not
              only in the detail dialog the person may never have opened. */}
          <DialogDescription className="text-(--atum-ink-muted)">{skillNeedsCopy(entry.needs, copy)}</DialogDescription>
        </DialogHeader>

        {phase === 'purchase' && offer ? (
          <>
            {/* The authoritative offer, exactly as returned: price, version,
                and the available balance, as a product card whose buy button
                is the only way to charge. */}
            <StoreOfferCard
              availableProtons={availableProtons}
              busy={purchaseBusy}
              description={copy.trainingFor(targetAgent?.title || 'Atum')}
              disabled={!accountId || !targetAssistantId}
              offer={offer}
              onBuy={() => void buy(offer)}
              title={storeCopy(entry.name, locale)}
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
            const assistant = row?.assistants.find(candidate => candidate.agentId === agent.id)
            const installed = installedIds.includes(agent.id)
            const busy = assistant?.action === 'installing'
            const failed = assistant?.action === 'failed'
            const checked = chooseTryTarget ? tryTarget === agent.id : selected.has(agent.id)

            if (chooseTryTarget && !installed) {return null}

            return (
              <label
                className="atum-row flex min-h-12 items-center gap-3 rounded-[var(--atum-r-row)] px-2.5 py-2"
                key={agent.id}
              >
                {chooseTryTarget ? (
                  <input
                    checked={checked}
                    className="accent-(--atum-ink)"
                    name="atum-skill-try-target"
                    onChange={() => setTryTarget(agent.id)}
                    type="radio"
                  />
                ) : (
                  <input
                    checked={checked}
                    className="accent-(--atum-ink)"
                    disabled={installed || busy || !agent.hostedId || agent.localProfileId === null}
                    name="atum-skill-training-target"
                    onChange={() => { setSelected(new Set([agent.id])); setPurchased(false); setNotice(null) }}
                    type="radio"
                  />
                )}
                <AtumAssistantAvatar
                  avatarUrl={agent.avatarUrl}
                  brand={agent.id === ATUM_AGENT_ID}
                  className="size-(--atum-avatar-md) shrink-0 rounded-(--atum-r-avatar) text-(length:--atum-t-caption)"
                  id={agent.id}
                  name={agent.title || 'Atum'}
                />
                <span className="min-w-0 flex-1 truncate text-(length:--atum-t-control)">{agent.title || 'Atum'}</span>
                {busy ? (
                  <Loader2 aria-label={copy.add} className="size-4 animate-spin text-(--atum-ink-muted)" />
                ) : failed ? (
                  <button
                    className="text-(length:--atum-t-caption) font-medium text-(--atum-danger)"
                    onClick={event => {
                      event.preventDefault()
                      setSubmitted(true)
                      // An entitled retry is install-only — never a second purchase.
                      void addAtumSkill(entry, [agent.id])
                    }}
                    type="button"
                  >
                    {agent.hostedId && entry.trainedAssistantIds?.includes(agent.hostedId) ? copy.trainingRetryActivate : copy.installFailedRetry}
                  </button>
                ) : installed ? (
                  <span className="flex items-center gap-1 text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                    {submitted && <Check aria-hidden className="size-4" />}
                    {copy.added}
                  </span>
                ) : null}
              </label>
            )
          })}
        </div>

        {!completed && <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.trainingPerAgent}</p>}
        {completed && <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.newChatOnly}</p>}
        {purchaseNotice}

        <DialogFooter>
          <button
            className="rounded-full px-4 py-2 text-(length:--atum-t-control) font-medium text-(--atum-ink-muted) hover:bg-(--atum-hover)"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            {completed ? t.common.done : t.common.cancel}
          </button>
          {completed ? (
            <button
              className="rounded-full bg-(--atum-ink) px-4 py-2 text-(length:--atum-t-control) font-medium text-(--atum-on-accent) disabled:opacity-50"
              disabled={chooseTryTarget && !tryTarget}
              onClick={actTry}
              type="button"
            >
              {copy.try}
            </button>
          ) : (
            <button
              aria-busy={installing || purchaseBusy || undefined}
              className="rounded-full bg-(--atum-ink) px-4 py-2 text-(length:--atum-t-control) font-medium text-(--atum-on-accent) disabled:opacity-50"
              disabled={installing || purchaseBusy || !targetAssistantId || targetAgent?.localProfileId === null || selectableIds.length === 0 || (!entitled && !offer)}
              onClick={confirmAdd}
              type="button"
            >
              {installing || purchaseBusy ? <><Loader2 aria-hidden className="mx-auto size-4 animate-spin" /><span className="sr-only">{copy.add}</span></> : copy.add}
            </button>
          )}
        </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
