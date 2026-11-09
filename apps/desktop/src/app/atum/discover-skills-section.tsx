// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { isAcquirable } from '@/lib/atum-price'
import { type AtumStoreSkillEntry, storeCopy } from '@/lib/atum-store-items'
import { Loader2 } from '@/lib/icons'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import { $railDestination } from '@/store/atum-shell'
import { $atumStoreCatalog, refreshAtumStoreCatalog } from '@/store/atum-store-catalog'

import { SKILLS_ROUTE } from '../routes'

import { AddSkillDialog } from './add-skill-dialog'
import { $atumAgents } from './agents'
import { PriceTag } from './price-tag'
import { SkillDetailDialog } from './skill-detail-dialog'
import {
  $atumSkillRefresh,
  $atumSkillRows,
  refreshAtumSkills,
  tryAtumSkill
} from './skills'

/** Featured keeps the two-card hero grid: the catalog marks the picks, the
 *  layout caps them. */
const FEATURED_CAP = 2

function SkillPill({ onClick, row }: { onClick: () => void; row: ReturnType<typeof $atumSkillRows.get>[number] }) {
  const { locale, t } = useI18n()
  const copy = t.atum.discover
  const installing = row.assistants.some(assistant => assistant.action === 'installing')
  const removing = row.assistants.some(assistant => assistant.action === 'removing')
  const failed = row.installedFor.length === 0 && row.assistants.some(assistant => assistant.action === 'failed')
  const busy = installing || removing
  const installed = row.installedFor.length > 0
  const formatAmount = (amount: number) => new Intl.NumberFormat(locale).format(amount)
  // A price this build cannot read, or a row with no active offer, is not an
  // invitation. Owned rows always are: the entitlement is the acquisition.
  const offerable = installed || row.entry.owned || isAcquirable(row.entry.price)

  return (
    <button
      aria-busy={busy || undefined}
      className={`shrink-0 rounded-full px-3.5 py-[7px] text-(length:--atum-t-control) font-medium disabled:opacity-60 ${installed ? 'bg-(--atum-hover) text-(--atum-ink) hover:bg-(--atum-pressed)' : 'bg-(--atum-ink) text-(--atum-on-accent)'}`}
      disabled={busy || !offerable}
      onClick={event => { event.stopPropagation(); onClick() }}
      type="button"
    >
      {busy ? <><Loader2 aria-hidden className="size-4 animate-spin" /><span className="sr-only">{installed ? copy.try : copy.add}</span></> : failed ? copy.tryAgain : installed ? copy.try : row.entry.owned ? copy.add : <PriceTag copy={copy} formatAmount={formatAmount} price={row.entry.price} />}
    </button>
  )
}

export interface DiscoverSkillsSectionProps {
  /** Which shelf body this instance renders: `featured` is the cross-catalog
   *  picks; `skills` is the full store catalog. The storefront mounts one at a
   *  time; the dialogs travel with either. */
  part: 'featured' | 'skills'
}

export function DiscoverSkillsSection({ part }: DiscoverSkillsSectionProps) {
  const { locale, t } = useI18n()
  const navigate = useNavigate()
  const agents = useStore($atumAgents)
  const rows = useStore($atumSkillRows)
  const refresh = useStore($atumSkillRefresh)
  const accountId = useStore($atumAccountScopeId)
  const storeView = useStore($atumStoreCatalog)
  const [detailEntry, setDetailEntry] = useState<AtumStoreSkillEntry | null>(null)
  const [addEntry, setAddEntry] = useState<AtumStoreSkillEntry | null>(null)
  const [addTryOnly, setAddTryOnly] = useState(false)
  const [preselect, setPreselect] = useState<string | null>(null)
  const [ownedOnly, setOwnedOnly] = useState(false)
  const copy = t.atum.discover

  // Keyed on the assistants' identities, not their count: replacing one
  // assistant with another must fetch the newcomer's installed map too.
  const agentKey = agents.map(agent => agent.id).join('\n')

  useEffect(() => {
    // Catalog first, then the probe of what THIS build can fulfil reads it.
    // The hub refresh does not wait on the store: installed maps are local.
    void refreshAtumStoreCatalog()
      .catch(() => null)
      .then(() => refreshAtumSkills())
  }, [accountId, agentKey])

  const featured = useMemo(() => rows.filter(row => row.entry.featured).slice(0, FEATURED_CAP), [rows])
  const listed = ownedOnly ? rows.filter(row => row.entry.owned) : rows

  const act = (row: typeof rows[number]) => {
    const failed = row.assistants.find(assistant => assistant.action === 'failed')

    if (row.installedFor.length === 1) {
      tryAtumSkill(storeCopy(row.entry.tryPrompt, locale), row.installedFor[0]!, row.entry)
    } else {
      setAddTryOnly(row.installedFor.length > 1)
      setPreselect(failed?.agentId ?? null)
      setAddEntry(row.entry)
    }
  }

  const agentTitle = (id: string) => agents.find(agent => agent.id === id)?.title || 'Atum'

  const installedLine = (row: typeof rows[number]) => {
    if (row.installedFor.length === 0) {return null}
    const first = agents.find(agent => agent.id === row.installedFor[0])?.title || 'Atum'

    return row.installedFor.length === 1 ? copy.addedFor(first) : copy.addedForOthers(first, row.installedFor.length - 1)
  }

  return (
    <>
      {part === 'featured' && (
      <div data-testid="discover-featured">
        <div className="mb-3.5 text-(length:--atum-t-label) font-semibold uppercase tracking-[0.06em] text-(--atum-ink-faint)">{copy.featuredSection}</div>
        <div className="grid grid-cols-2 gap-3.5">
          {featured.map(row => {
            const entry = row.entry

            return (
              <article className="atum-glass-card flex flex-col gap-3.5 rounded-[var(--atum-r-group)] p-[1.125rem]" data-featured-skill={entry.identifier} key={entry.id}>
                <button className="text-left" onClick={() => setDetailEntry(entry)} type="button">
                  <span className="grid min-h-36 place-items-center rounded-[var(--atum-r-group)] text-[2.5rem]" style={{ background: `linear-gradient(145deg, color-mix(in srgb, ${entry.accent} 34%, var(--atum-card)), var(--atum-card))` }}>{entry.glyph}</span>
                  <span className="mt-3 block text-(length:--atum-t-label) font-semibold uppercase tracking-[0.06em] text-(--atum-ink-faint)">{copy.featuredSection}</span>
                  <span className="mt-1 block text-[0.9375rem] font-semibold text-(--atum-ink)">{storeCopy(entry.name, locale)}</span>
                  <span className="mt-1 block text-(length:--atum-t-control) leading-[1.45] text-(--atum-ink-muted)">{storeCopy(entry.after, locale)}</span>
                </button>
                <span className="mt-auto flex items-center justify-end gap-2">
                  {entry.owned && <span className="text-(length:--atum-t-caption) text-(--atum-ink-faint)" data-atum-owned-badge>{copy.trained}</span>}
                  <SkillPill onClick={() => act(row)} row={row} />
                </span>
              </article>
            )
          })}
        </div>
      </div>
      )}

      {part === 'skills' && (
      <div data-testid="discover-skills">
        <div className="mb-3.5 flex items-center justify-between gap-3">
          <div className="text-(length:--atum-t-label) font-semibold uppercase tracking-[0.06em] text-(--atum-ink-faint)">{copy.skillsSection}</div>
          {/* The library is a filter on the shelf, not a page: Owned means an
              entitlement exists, and the chip narrows the shelf to exactly that. */}
          <button
            aria-pressed={ownedOnly}
            className={`rounded-full px-3.5 py-[7px] text-(length:--atum-t-control) font-medium transition-colors ${ownedOnly ? 'bg-(--atum-ink) text-(--atum-on-accent)' : 'bg-(--atum-hover) text-(--atum-ink) hover:bg-(--atum-pressed)'}`}
            data-atum-owned-filter
            onClick={() => setOwnedOnly(current => !current)}
            type="button"
          >
            {copy.trained}
          </button>
        </div>
        {refresh.state === 'failed' && (
          <NoticeBand className="mb-3" role="status">
            <span>{copy.refreshFailed} </span>
            <button className="underline underline-offset-2" onClick={() => void refreshAtumSkills()} type="button">{t.common.retry}</button>
          </NoticeBand>
        )}
        {!accountId && (
          <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)" role="status">{copy.storeSignedOut}</p>
        )}
        {accountId && storeView.state === 'error' && (
          <NoticeBand className="mb-3" role="alert">
            <span>{copy.storeUnavailable} </span>
            <button className="underline underline-offset-2" onClick={() => void refreshAtumStoreCatalog(true).catch(() => null)} type="button">{t.common.retry}</button>
          </NoticeBand>
        )}
        {accountId && storeView.state === 'loading' && (
          <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)" role="status">{copy.catalogLoading}</p>
        )}
        {accountId && storeView.state === 'stale' && (
          <p className="mb-2 text-(length:--atum-t-body) text-(--atum-ink-muted)" role="status">{copy.catalogStale}</p>
        )}
        {ownedOnly && listed.length === 0 && storeView.state === 'ready' && (
          <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.trainedEmpty}</p>
        )}
        <div className="grid grid-cols-1 gap-3.5 min-[40rem]:grid-cols-2">
          {listed.map(row => {
            const failed = row.installedFor.length === 0 ? row.assistants.find(assistant => assistant.action === 'failed') : undefined

            return (
              <article className="atum-glass-card rounded-[var(--atum-r-group)] p-[1.125rem]" data-skill-row={row.entry.identifier} key={row.entry.id}>
                <div className="flex items-center gap-3">
                  <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setDetailEntry(row.entry)} type="button">
                    <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-[var(--atum-r-card)] text-[1.375rem]" style={{ background: row.entry.accent }}>{row.entry.glyph}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[0.9375rem] font-semibold text-(--atum-ink)">
                        {storeCopy(row.entry.name, locale)}
                        {row.entry.owned && <span className="ml-2 text-(length:--atum-t-caption) font-normal text-(--atum-ink-faint)" data-atum-owned-badge>{copy.trained}</span>}
                      </span>
                      <span className="mt-[3px] block text-(length:--atum-t-control) leading-[1.45] text-(--atum-ink-muted)">{storeCopy(row.entry.after, locale)}</span>
                      {installedLine(row) && <span className="mt-1 block text-(length:--atum-t-caption) text-(--atum-ink-faint)">{installedLine(row)}</span>}
                    </span>
                  </button>
                  <SkillPill onClick={() => act(row)} row={row} />
                </div>
                {failed && (
                  <NoticeBand className="mt-2" role="status">
                    <span className="block">{copy.installFailedFor(agentTitle(failed.agentId))}</span>
                    {/* The backend's last line is English and technical; it stays
                        visible for support, under a sentence the person can read. */}
                    {failed.lastLogLine && (
                      <span className="mt-0.5 block text-(length:--atum-t-caption) text-(--atum-ink-faint)">{failed.lastLogLine}</span>
                    )}
                  </NoticeBand>
                )}
              </article>
            )
          })}
        </div>
        {/* Acquiring lives here; managing stays in Capabilities — a page, not
            a shelf, so deep-linking it in would recreate the ambiguity this
            removes. Rail first, navigate second (the ordering rule): Discover
            suppresses the workspace while it is the destination. */}
        <div className="mt-3.5 flex justify-end">
          <button
            className="text-(length:--atum-t-control) text-(--atum-ink-muted) underline underline-offset-2 hover:text-(--atum-ink)"
            data-atum-manage-skills
            onClick={() => {
              $railDestination.set('chat')
              navigate(SKILLS_ROUTE)
            }}
            type="button"
          >
            {copy.manageInstalled}
          </button>
        </div>
      </div>
      )}

      <AddSkillDialog entry={addEntry} onOpenChange={open => { if (!open) {setAddEntry(null)} }} open={addEntry !== null} preselect={preselect} tryOnly={addTryOnly} />
      <SkillDetailDialog entry={detailEntry} onAdd={entry => { setAddTryOnly(false); setPreselect(null); setAddEntry(entry) }} onOpenChange={open => { if (!open) {setDetailEntry(null)} }} open={detailEntry !== null} />
    </>
  )
}
