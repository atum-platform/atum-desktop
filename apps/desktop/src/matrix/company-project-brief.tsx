import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader } from '@/components/ui/loader'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'

import { matrixCompanyBoardCopy } from '../../shared/matrix-company-board-copy'

import {
  type CompanyCitationContext,
  companyCitationSource,
  companyCitationTimestamp
} from './company-citation'
import {
  type CompanyAICitation,
  companyDesktopAdapter,
  type CompanyProjectBrainEvidenceItem,
  type CompanyProjectBrainV4
} from './company-desktop-adapter'

export interface CompanyProjectBriefProps {
  companyId: string
  projectId: string
  onClose(): void
  onOpenTask(cardId: string): void
  citationChannels?: Readonly<Record<string, string>>
  citationContext?: CompanyCitationContext
}

export function CompanyProjectBrief({
  citationChannels,
  citationContext,
  companyId,
  onClose,
  onOpenTask,
  projectId
}: CompanyProjectBriefProps) {
  const { locale } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)
  const [value, setValue] = useState<CompanyProjectBrainV4>()
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [correcting, setCorrecting] = useState<CompanyProjectBrainEvidenceItem>()
  const [correction, setCorrection] = useState('')
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    const adapter = companyDesktopAdapter()
    const request = ++generation.current
    setLoading(true)
    setFailed(false)
    setValue(undefined)

    if (!adapter) {
      setLoading(false)
      setFailed(true)

      return
    }

    void adapter
      .readProjectBrain(companyId, projectId)
      .then(next => {
        if (generation.current === request && next.companyId === companyId && next.projectId === projectId) {
          setValue(next)
        }
      })
      .catch(() => {
        if (generation.current === request) {
          setFailed(true)
        }
      })
      .finally(() => {
        if (generation.current === request) {
          setLoading(false)
        }
      })

    return () => {
      generation.current += 1
    }
  }, [attempt, companyId, projectId])

  const context: CompanyCitationContext = {
    channelName: channelId => citationChannels?.[channelId] ?? citationContext?.channelName?.(channelId),
    senderName: citationContext?.senderName
  }

  const openCitation = (citation: CompanyAICitation) => {
    const adapter = companyDesktopAdapter()

    if (adapter) {
      void adapter.openCitation(companyId, citation).catch(() => setFailed(true))
    }
  }

  const submitCorrection = async () => {
    const adapter = companyDesktopAdapter()

    if (!adapter || !correcting || !value?.brief || !correction.trim()) {
      return
    }

    setSaving(true)
    setFailed(false)

    try {
      const next = await adapter.correctProjectBrain(companyId, projectId, {
        schemaVersion: 4,
        requestId: globalThis.crypto.randomUUID(),
        expectedBriefVersion: value.brief.version,
        expectedBoardRevision: value.boardRevision,
        expectedSourceGeneration: value.sourceGeneration,
        targetKind: value.brief.decisions.some(item => item.itemId === correcting.itemId)
          ? 'decision'
          : 'open_question',
        targetItemId: correcting.itemId,
        text: correction.trim()
      })

      setValue(next)
      setCorrecting(undefined)
      setCorrection('')
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const current = value?.coverage.state === 'live' || value?.coverage.state === 'partial'
  const brief = current ? value?.brief : undefined

  const asOf = brief
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(brief.asOf))
    : null

  const evidence = (title: string, rows: CompanyProjectBrainEvidenceItem[]) => (
    <section className="grid gap-2" data-company-brief-section>
      <h3 className="text-xs font-semibold text-(--atum-ink-muted)">{title}</h3>
      {rows.map(item => (
        <div className="grid gap-1.5 py-1" key={item.itemId}>
          <p className="text-sm text-(--atum-ink)">{item.excerpt}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-(--atum-ink-muted)">
            <Tip
              label={(() => {
                const timestamp = companyCitationTimestamp(item.citation, locale)

                return timestamp ? `${copy.openSource} · ${timestamp}` : copy.openSource
              })()}
            >
              <Button
                className="justify-start text-start underline decoration-current"
                onClick={() => openCitation(item.citation)}
                size="inline"
                variant="link"
              >
                {companyCitationSource(item.citation, locale, context, copy.citedMessage).label}
              </Button>
            </Tip>
            <Button
              onClick={() => {
                setCorrecting(item)
                setCorrection('')
              }}
              size="inline"
              variant="text"
            >
              {copy.correct}
            </Button>
          </div>
          {correcting?.itemId === item.itemId && (
            <form
              className="flex items-end gap-2"
              onSubmit={event => {
                event.preventDefault()
                void submitCorrection()
              }}
            >
              <Input
                aria-label={copy.correctionLabel}
                autoFocus
                maxLength={500}
                onChange={event => setCorrection(event.target.value)}
                value={correction}
              />
              <Button disabled={saving || !correction.trim()} size="sm" type="submit">
                {copy.saveCorrection}
              </Button>
            </form>
          )}
        </div>
      ))}
    </section>
  )

  return (
    <aside
      aria-label={copy.projectBrief}
      className="absolute inset-y-0 end-0 z-20 flex w-[min(30rem,100%)] flex-col border-s border-(--atum-panel-line) bg-(--atum-main-bg) shadow-nous"
      data-company-project-brief
    >
      <header className="flex h-(--atum-l-header) shrink-0 items-center justify-between gap-3 border-b border-(--atum-panel-line) px-5">
        <h2 className="text-sm font-semibold text-(--atum-ink)">{copy.projectBrief}</h2>
        <Button onClick={onClose} size="sm" variant="text">
          {copy.close}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading && <Loader className="mx-auto my-10 size-7" label={copy.checking} />}
        {!loading && failed && !value && (
          <div className="grid justify-items-start gap-2 py-8">
            <p className="text-sm text-(--atum-ink-muted)">{copy.briefUnavailable}</p>
            <Button onClick={() => setAttempt(value => value + 1)} size="sm" variant="secondary">
              {copy.retry}
            </Button>
          </div>
        )}
        {!loading && value && !brief && (
          <p className="py-8 text-sm text-(--atum-ink-muted)" role="status">
            {value.coverage.state === 'stale' ? copy.checking : copy.noProjectUpdates}
          </p>
        )}
        {brief && (
          <div className="grid gap-6">
            <section className="grid gap-1">
              <h3 className="text-lg font-semibold text-(--atum-ink)">{brief.goal.displayName}</h3>
              {brief.goal.text && <p className="text-sm text-(--atum-ink-muted)">{brief.goal.text}</p>}
              {asOf && (
                <p className="text-xs text-(--atum-ink-faint)">
                  {copy.answerFresh} {asOf}
                </p>
              )}
            </section>
            <section className="grid gap-2" data-company-brief-progress>
              <h3 className="text-xs font-semibold text-(--atum-ink-muted)">{copy.progress}</h3>
              {[...brief.tasks.accepted, ...brief.tasks.suggested].map(task => (
                <div className="flex items-center justify-between gap-3 py-1" key={task.cardId}>
                  <span className="min-w-0 truncate text-sm text-(--atum-ink)">{task.title}</span>
                  <Button onClick={() => onOpenTask(task.cardId)} size="inline" variant="text">
                    {copy.openTask}
                  </Button>
                </div>
              ))}
              {brief.tasks.accepted.length === 0 && brief.tasks.suggested.length === 0 && (
                <p className="text-sm text-(--atum-ink-muted)">{copy.noProjectUpdates}</p>
              )}
            </section>
            {brief.decisions.length > 0 && evidence(copy.decisions, brief.decisions)}
            {brief.openQuestions.length > 0 && evidence(copy.openQuestions, brief.openQuestions)}
          </div>
        )}
      </div>
    </aside>
  )
}
