import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { NoticeBand } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { Brain, FileText, iconSize, MessageCircle } from '@/lib/icons'

import { canOpenAwarenessCitation, selectAwarenessView } from './model'
import type { AwarenessEvidence, AwarenessPanelProps, AwarenessSnapshot, AwarenessSourceKind } from './types'

const SOURCE_ICONS: Record<AwarenessSourceKind, typeof Brain> = {
  assistant_chat: MessageCircle,
  human_dm: MessageCircle,
  human_group: MessageCircle,
  app_exchange: MessageCircle,
  drive_file: FileText,
  native_memory: Brain,
  owner_statement: MessageCircle
}

function CitationAction({
  snapshot,
  evidence,
  onOpenCitation
}: Pick<AwarenessPanelProps, 'onOpenCitation'> & { snapshot: AwarenessSnapshot; evidence: AwarenessEvidence }) {
  const { t } = useI18n()
  const copy = t.atum.awareness
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const busy = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  const open = async () => {
    if (!onOpenCitation || busy.current || !canOpenAwarenessCitation(snapshot, evidence, Date.now())) {
      return
    }

    busy.current = true
    setPending(true)
    setFailed(false)

    try {
      // A descriptor, never a URL. RT must recheck current access before navigation.
      await onOpenCitation({
        scopeKey: snapshot.scopeKey,
        snapshotId: snapshot.snapshotId,
        evidenceId: evidence.evidenceId,
        citation: evidence.citation
      })
    } catch {
      if (mounted.current) {
        setFailed(true)
      }
    } finally {
      busy.current = false

      if (mounted.current) {
        setPending(false)
      }
    }
  }

  if (!onOpenCitation || !canOpenAwarenessCitation(snapshot, evidence, Date.now())) {
    return <span className="text-xs text-(--atum-ink-muted)">{copy.citationUnavailable}</span>
  }

  return (
    <div className="grid justify-items-start gap-2">
      <Button
        aria-label={`${copy.openCitation} · ${evidence.sourceLabel || copy.sourceKinds[evidence.sourceKind]}`}
        disabled={pending}
        onClick={() => void open()}
        size="inline"
        variant="textStrong"
      >
        {pending ? copy.openingCitation : copy.openCitation}
      </Button>
      {failed && (
        <NoticeBand role="status" tone="failure">
          {copy.citationFailed}
        </NoticeBand>
      )}
    </div>
  )
}

function SnapshotBody({
  snapshot,
  onOpenCitation
}: Pick<AwarenessPanelProps, 'onOpenCitation'> & {
  snapshot: AwarenessSnapshot
}) {
  const { locale, t } = useI18n()
  const copy = t.atum.awareness

  const date = (value: number) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(value)

  return (
    <>
      {(snapshot.freshness === 'stale' || snapshot.status === 'degraded') && (
        <div className="grid gap-3">
          {snapshot.freshness === 'stale' && <NoticeBand tone="notice">{copy.stale}</NoticeBand>}
          {snapshot.status === 'degraded' && <NoticeBand tone="notice">{copy.degraded}</NoticeBand>}
        </div>
      )}
      <div className="grid min-w-0 gap-8 @min-[42rem]:grid-cols-[16rem_minmax(0,1fr)]">
        <section aria-label={copy.sources} className="min-w-0">
          <h3 className="mb-4 text-sm font-semibold">{copy.sources}</h3>
          {snapshot.sources.length === 0 ? (
            <EmptyState description={copy.noSourcesDescription} title={copy.noSources} />
          ) : (
            <ul className="grid gap-5">
              {snapshot.sources.map(source => {
                const Glyph = SOURCE_ICONS[source.kind]

                return (
                  <li className="flex min-w-0 items-start gap-3" key={source.key}>
                    <Glyph aria-hidden className={`${iconSize.sm} mt-0.5 shrink-0 text-(--atum-ink-muted)`} />
                    <div className="min-w-0 text-xs leading-5">
                      <div className="break-words text-sm font-medium">
                        {source.label || copy.sourceKinds[source.kind]}
                      </div>
                      <p className="font-medium text-(--atum-ink-soft)">{copy.states[source.state]}</p>
                      {source.reasons.map(reason => (
                        <p className="text-(--atum-ink-muted)" key={reason}>
                          {copy.reasons[reason]}
                        </p>
                      ))}
                      <p className="text-(--atum-ink-faint)">{copy.asOf(date(source.asOf))}</p>
                      {source.processedThrough !== undefined && (
                        <p className="text-(--atum-ink-faint)">
                          {copy.processedThrough(date(source.processedThrough))}
                        </p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        <section aria-label={copy.evidence} className="min-w-0">
          <h3 className="mb-4 text-sm font-semibold">{copy.evidence}</h3>
          {snapshot.status === 'unavailable' ? (
            <EmptyState description={copy.unavailableDescription} title={copy.unavailable} />
          ) : snapshot.evidence.length === 0 ? (
            <EmptyState description={copy.noEvidenceDescription} title={copy.noEvidence} />
          ) : (
            <>
              <p className="mb-5 text-xs leading-5 text-(--atum-ink-muted)">{copy.untrusted}</p>
              <ul className="grid gap-7">
                {snapshot.evidence.map(evidence => (
                  <li className="grid min-w-0 gap-2" key={evidence.evidenceId}>
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="break-words text-sm font-medium">
                        {evidence.sourceLabel || copy.sourceKinds[evidence.sourceKind]}
                      </span>
                      <span className="text-xs text-(--atum-ink-muted)">{copy.epistemic[evidence.epistemic]}</span>
                    </div>
                    {/* Evidence is untrusted quoted text, not a second Markdown/tool renderer. */}
                    <blockquote className="whitespace-pre-wrap break-words text-sm leading-6 text-(--atum-ink-soft)">
                      {evidence.content}
                    </blockquote>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-(--atum-ink-faint)">
                      <span>{copy.occurredAt(date(evidence.eventTime))}</span>
                      <span>{copy.citationKinds[evidence.citation.kind]}</span>
                      {evidence.citation.kind === 'drive_file' && (
                        <span className="break-all">{copy.fileVersion(evidence.citation.version)}</span>
                      )}
                      {evidence.citation.kind === 'memory' && (
                        <span>{copy.memoryRevision(String(evidence.citation.revision))}</span>
                      )}
                    </div>
                    <CitationAction evidence={evidence} onOpenCitation={onOpenCitation} snapshot={snapshot} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </>
  )
}

/** Read-only private owner presentation; transport and authorization remain native. */
export function AwarenessPanel({ currentScopeKey, data, onOpenCitation }: AwarenessPanelProps) {
  const { t } = useI18n()
  const copy = t.atum.awareness
  const [now, setNow] = useState(Date.now)
  const view = selectAwarenessView(currentScopeKey, data, Math.max(now, Date.now()))

  // Remove expiring evidence even if no newer native snapshot arrives. No polling.
  useEffect(() => {
    if (data.state !== 'ready' || data.snapshot.scopeKey !== currentScopeKey) {
      return
    }

    const expiry = data.snapshot.evidence
      .map(item => item.expiresAt)
      .filter((value): value is number => value !== undefined && value > Date.now())
      .sort((a, b) => a - b)[0]

    if (expiry === undefined) {
      return
    }

    const timer = setTimeout(() => setNow(Date.now()), Math.min(expiry - Date.now(), 2_147_483_647))

    return () => clearTimeout(timer)
  }, [currentScopeKey, data, now])

  return (
    <section aria-label={copy.title} className="@container grid min-w-0 gap-6">
      <header className="grid gap-2">
        <h2 className="text-xl font-semibold tracking-tight">{copy.title}</h2>
        <p className="max-w-prose text-sm leading-6 text-(--atum-ink-soft)">{copy.subtitle}</p>
        <p className="text-xs text-(--atum-ink-muted)">{copy.privateOnly}</p>
      </header>
      {view.state === 'ready' ? (
        <SnapshotBody
          key={JSON.stringify([view.snapshot.scopeKey, view.snapshot.snapshotId])}
          onOpenCitation={onOpenCitation}
          snapshot={view.snapshot}
        />
      ) : view.state === 'loading' ? (
        <Loader className="mx-auto" label={copy.loading} />
      ) : (
        <EmptyState description={copy.unavailableDescription} title={copy.unavailable} />
      )}
    </section>
  )
}
