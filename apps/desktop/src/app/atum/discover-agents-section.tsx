// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { type AtumStoreItemWire, storeCopy } from '@/lib/atum-store-items'
import { $atumHireIntent, $atumHiring, cancelAtumHire, refreshAtumHiring } from '@/store/atum-hiring'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import { $railDestination } from '@/store/atum-shell'
import { $atumStoreCatalog, refreshAtumStoreCatalog } from '@/store/atum-store-catalog'

import { NEW_CHAT_ROUTE } from '../routes'

import { $atumAgents } from './agents'
import { completeAtumHire, confirmAtumHire, openAtumHire } from './hiring-actions'
import { hiringCopy, hiringError } from './hiring-copy'

export function DiscoverAgentsSection() {
  const { locale, t } = useI18n()
  const copy = hiringCopy(locale)
  const accountId = useStore($atumAccountScopeId)
  const view = useStore($atumHiring)
  const catalog = useStore($atumStoreCatalog)
  const agents = useStore($atumAgents)
  const intent = useStore($atumHireIntent)
  const navigate = useNavigate()
  const [checkout, setCheckout] = useState<{ item: AtumStoreItemWire; assistantId: string | null; active: boolean } | null>(null)
  const [name, setName] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = () => void Promise.allSettled([refreshAtumHiring(), refreshAtumStoreCatalog(true)])
  useEffect(() => { refresh(); setCheckout(null); setError(null) }, [accountId])
  const ready = Boolean(accountId) && view.accountId === accountId && view.state === 'ready' && catalog.state === 'ready'
  const rows = catalog.accountId === accountId ? catalog.catalog?.items.filter(row => row.kind === 'agent' && row.source?.type === 'cloud_agent') ?? [] : []
  const hires = view.accountId === accountId ? view.hires : []
  const price = (amount: number) => `${new Intl.NumberFormat(locale).format(amount)} Protons / ${copy.month}`

  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setConsent(false)

    try { await action() } catch (failure) { setError(hiringError(failure, copy)) } finally { setBusy(false) }
  }

  const begin = (item: AtumStoreItemWire, assistantId: string | null = null, active = false) => {
    setName(assistantId ? agents.find(agent => agent.hostedId === assistantId)?.title ?? storeCopy(item.title, locale) : storeCopy(item.title, locale))
    setConsent(false); setError(null); setCheckout({ item, assistantId, active })
  }

  const submit = () => act(async () => {
    if (!checkout || !consent) { return }
    const chosen = checkout
    setCheckout(null)
    await confirmAtumHire(chosen.item, name, locale, chosen.assistantId)
  })

  return <section className="flex flex-col gap-4" data-testid="discover-agents">
    <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.intro}</p>
    {!accountId && <p role="status">{t.atum.discover.storeSignedOut}</p>}
    {accountId && (view.state === 'loading' || view.state === 'idle' || catalog.state === 'loading') && <p role="status">{t.atum.discover.catalogLoading}</p>}
    {accountId && (view.state === 'error' || catalog.state === 'error' || catalog.state === 'stale') && <NoticeBand role="alert">
      {copy.unavailable} <button className="underline" onClick={refresh} type="button">{t.common.retry}</button>
    </NoticeBand>}
    {error && <NoticeBand role="alert">{error}</NoticeBand>}
    {intent?.accountId === accountId && <NoticeBand role="status">
      <p>{copy.pending} {intent.name} · {price(intent.priceProtons)}</p>
      {intent.needsConsent && <label className="my-2 flex items-start gap-2"><input checked={consent} onChange={event => setConsent(event.target.checked)} type="checkbox" />{copy.consent}</label>}
      <Button disabled={busy || Boolean(intent.needsConsent && !consent)} onClick={() => void act(() => completeAtumHire(consent))}>{busy ? copy.confirming : copy.continue}</Button>
    </NoticeBand>}
    {hires.length > 0 && <h2 className="font-semibold">{copy.mine}</h2>}
    {hires.map(hire => {
      const agent = agents.find(row => row.hostedId === hire.assistant_id)
      const item = rows.find(row => row.id === hire.item_id)
      const renewable = item?.offer?.billing_interval === 'month' && item.offer.id === hire.offer_id
      const active = hire.state === 'active' && Date.parse(hire.period_end) > Date.now()

      return <article className="atum-glass-card rounded-[var(--atum-r-group)] p-4" data-agent-hire={hire.id} key={hire.id}>
        <h3 className="font-semibold">{agent?.title ?? (item ? storeCopy(item.title, locale) : hire.item_id)}</h3>
        <p className="text-(--atum-ink-muted)">{price(hire.price_protons)}</p>
        <p className="text-(--atum-ink-muted)">{active ? hire.renewal_enabled && (!ready || renewable) ? copy.renews : copy.ends : copy.paused} {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(hire.period_end))}</p>
        {ready && !renewable && <p className="text-(--atum-ink-muted)">{copy.retired}</p>}
        {!hire.renewal_enabled && <p className="text-(--atum-ink-muted)">{copy.cancelNote}</p>}
        <div className="mt-3 flex gap-2">
          <Button disabled={busy || !agent} onClick={() => void act(async () => {
            await openAtumHire(hire.assistant_id); $railDestination.set('chat'); navigate(NEW_CHAT_ROUTE)
          })}>{copy.open}</Button>
          {hire.renewal_enabled && <Button disabled={busy || view.state !== 'ready'} onClick={() => void act(() => cancelAtumHire(hire.id))} variant="outline">{copy.cancel}</Button>}
          {(!active || !hire.renewal_enabled) && renewable && item && <Button disabled={busy || !ready || Boolean(intent)} onClick={() => begin(item, hire.assistant_id, active)} variant="outline">{active ? copy.resume : copy.rehire}</Button>}
        </div>
      </article>
    })}
    {ready && rows.length === 0 && <p role="status">{copy.empty}</p>}
    <div className="grid grid-cols-1 gap-3.5 min-[40rem]:grid-cols-2">
      {rows.map(item => <article className="atum-glass-card rounded-[var(--atum-r-group)] p-4" data-agent-offer={item.id} key={item.id}>
        <span aria-hidden className="text-3xl">{item.glyph}</span>
        <h3 className="mt-2 font-semibold">{storeCopy(item.title, locale)}</h3>
        <p className="my-2 text-(--atum-ink-muted)">{storeCopy(item.summary, locale)}</p>
        <p className="text-(--atum-ink-muted)">{item.offer?.billing_interval === 'month' ? price(item.offer.price_protons) : t.atum.discover.unavailable}</p>
        <Button className="mt-3" disabled={!ready || busy || Boolean(intent) || item.offer?.billing_interval !== 'month'} onClick={() => begin(item)}>{copy.hire}</Button>
      </article>)}
    </div>
    <Dialog onOpenChange={open => { if (!open && !busy) { setCheckout(null) } }} open={Boolean(checkout)}>
      <DialogContent>
        <DialogHeader><DialogTitle>{copy.hire} {checkout && storeCopy(checkout.item.title, locale)}</DialogTitle>
          <DialogDescription>{checkout?.item.offer && price(checkout.item.offer.price_protons)} · {copy.separate}</DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-2">{copy.name}<input className="rounded border px-3 py-2" disabled={Boolean(checkout?.assistantId)} maxLength={40} onChange={event => setName(event.target.value)} value={name} /></label>
        <label className="flex items-start gap-2 text-sm"><input checked={consent} onChange={event => setConsent(event.target.checked)} type="checkbox" />{checkout?.active ? copy.consentResume : copy.consent}</label>
        <DialogFooter><Button disabled={!consent || !name.trim() || busy} onClick={() => void submit()}>{copy.hire}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
}
