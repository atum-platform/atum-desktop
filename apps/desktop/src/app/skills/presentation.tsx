import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CodeEditorSurface } from '@/components/chat/code-editor-surface'
import { PageLoader } from '@/components/page-loader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useI18n } from '@/i18n'
import { isDesktopToolsetVisible, toolNames, toolsetDisplayLabel } from '@/lib/desktop-toolsets'
import { compactNumber } from '@/lib/format'
import { asText, includesQuery, normalize, prettyName } from '@/lib/text'
import { notifyError } from '@/store/notifications'
import type { SkillInfo, ToolsetInfo } from '@/types/hermes'

import { CapRow, DetailColumn, DetailPane, ListColumn, MasterDetail, ToolChip } from '../master-detail'
import { PanelEmpty, PanelPill } from '../overlays/panel'
import { PageSearchShell } from '../page-search-shell'

/**
 * The complete capability boundary for the embedded Matrix page. The legacy
 * desktop adapter supplies these same four Hermes calls without exposing its
 * gateway, profile, config, installation, or secret authorities to Matrix.
 */
export interface SkillsPageClient {
  archiveLearnedSkill?: (name: string) => Promise<{ message: string; ok: boolean }>
  editLearnedSkill?: (name: string, content: string) => Promise<{ message: string; ok: boolean }>
  getLearnedSkill?: (name: string) => Promise<{ content: string; id: string; kind: string; label: string; ok: boolean }>
  getSkills: () => Promise<SkillInfo[]>
  getToolsets: () => Promise<ToolsetInfo[]>
  toggleSkill: (name: string, enabled: boolean) => Promise<unknown>
  toggleToolset: (name: string, enabled: boolean) => Promise<unknown>
}

interface LearnedSkillClient {
  archiveLearnedSkill: (name: string) => Promise<{ message: string; ok: boolean }>
  editLearnedSkill: (name: string, content: string) => Promise<{ message: string; ok: boolean }>
  getLearnedSkill: (name: string) => Promise<{ content: string; id: string; kind: string; label: string; ok: boolean }>
}

function learnedSkillClient(client: SkillsPageClient): LearnedSkillClient | null {
  if (
    typeof client.getLearnedSkill !== 'function' ||
    typeof client.editLearnedSkill !== 'function' ||
    typeof client.archiveLearnedSkill !== 'function'
  ) {
    return null
  }

  return client as LearnedSkillClient
}

function responseError(message: string, fallback: string): Error {
  return new Error(message || fallback)
}

export interface SkillsPresentationProps extends React.ComponentProps<'section'> {
  /** Matrix owns its explicit page appearance; legacy callers may keep the dark default. */
  appearance?: 'dark' | 'light'
  client: SkillsPageClient
  /** Optional scoped Hub supplied by the host, never a legacy global import. */
  renderHub?: (query: string, refreshInstalled: () => void) => React.ReactNode
  /** Open on the Hub, searching for one skill (the Store sent the person here). */
  initialHubQuery?: string
  /** Provided by the native pages host; the legacy route has no close affordance here. */
  onClose?: () => void
}

const MODES = ['skills', 'toolsets', 'hub'] as const
type Mode = (typeof MODES)[number]

const categoryFor = (skill: SkillInfo): string => asText(skill.category) || 'general'

const skillMatches = (skill: SkillInfo, query: string): boolean =>
  !query ||
  includesQuery(skill.name, query) ||
  includesQuery(skill.description, query) ||
  includesQuery(skill.category, query)

const toolsetMatches = (toolset: ToolsetInfo, query: string): boolean =>
  !query ||
  includesQuery(toolset.name, query) ||
  includesQuery(toolset.label, query) ||
  includesQuery(toolset.description, query) ||
  toolNames(toolset).some(name => includesQuery(name, query))

function DetailHeader({
  description,
  pills,
  title
}: {
  description: React.ReactNode
  pills?: React.ReactNode
  title: string
}) {
  return (
    <header>
      <div className="flex min-h-6 flex-wrap items-center gap-2">
        <h3 className="min-w-0 truncate text-[0.9375rem] font-semibold tracking-tight">{title}</h3>
        {pills}
      </div>
      <p className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
        {description}
      </p>
    </header>
  )
}

/** Shared by Matrix and the legacy desktop inspector; controls slot in after this metadata. */
export function SkillMetadataDetail({ skill }: { skill: SkillInfo }) {
  const { t } = useI18n()

  return (
    <DetailHeader
      description={asText(skill.description) || t.skills.noDescription}
      pills={
        <>
          <PanelPill>{prettyName(categoryFor(skill))}</PanelPill>
          {skill.provenance && skill.provenance !== 'bundled' && (
            <PanelPill tone={skill.provenance === 'agent' ? 'good' : 'muted'}>
              {t.skills.provenance[skill.provenance]}
            </PanelPill>
          )}
        </>
      }
      title={skill.name}
    />
  )
}

/** Shared by Matrix and the legacy desktop inspector; legacy-only config lives after it. */
export function ToolsetMetadataDetail({
  toolCalls = {},
  toolset
}: {
  toolCalls?: Record<string, number>
  toolset: ToolsetInfo
}) {
  const { t } = useI18n()
  const tools = toolNames(toolset)

  return (
    <>
      <DetailHeader
        description={asText(toolset.description) || t.skills.noDescription}
        pills={!toolset.configured && <PanelPill tone="warn">{t.skills.needsKeys}</PanelPill>}
        title={toolsetDisplayLabel(toolset)}
      />
      {tools.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tools.map(name => (
            <ToolChip key={name}>
              {name}
              {(toolCalls[name] ?? 0) > 0 && (
                <span className="ml-1 text-(--ui-text-quaternary)">×{compactNumber(toolCalls[name])}</span>
              )}
            </ToolChip>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * A deliberately small installed-capabilities view. It has no config cache:
 * each native pages mount is bound to one agent and owns its own request epoch.
 */
export function SkillsPresentation({
  appearance = 'dark',
  client,
  initialHubQuery,
  onClose,
  renderHub,
  ...props
}: SkillsPresentationProps) {
  const { t } = useI18n()
  const learnedClient = learnedSkillClient(client)
  const [mode, setMode] = useState<Mode>(renderHub && initialHubQuery ? 'hub' : 'skills')
  const [query, setQuery] = useState(renderHub ? (initialHubQuery ?? '') : '')
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [toolsets, setToolsets] = useState<ToolsetInfo[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)
  const [selectedToolset, setSelectedToolset] = useState<string | null>(null)
  const [busyRows, setBusyRows] = useState<ReadonlySet<string>>(() => new Set())
  const [skillEditor, setSkillEditor] = useState<null | { content: string; name: string }>(null)
  const [skillDraft, setSkillDraft] = useState('')
  const [skillEditorLoading, setSkillEditorLoading] = useState<null | string>(null)
  const [skillEditorError, setSkillEditorError] = useState<null | { message: string; name: string }>(null)
  const [skillSaving, setSkillSaving] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<null | string>(null)
  const loadEpoch = useRef(0)
  const learnedSkillEpoch = useRef(0)
  const mounted = useRef(true)
  const busyRowKeys = useRef(new Set<string>())
  const mutationQueue = useRef(Promise.resolve())

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
      // A late load cannot paint a later page mount; writes continue in their
      // own queue, but their UI results are intentionally ignored after close.
      loadEpoch.current += 1
      learnedSkillEpoch.current += 1
    }
  }, [])

  const refresh = useCallback(async (): Promise<boolean> => {
    const epoch = loadEpoch.current + 1
    loadEpoch.current = epoch
    setLoading(true)
    setError(null)

    try {
      const [nextSkills, nextToolsets] = await Promise.all([client.getSkills(), client.getToolsets()])

      if (!mounted.current || loadEpoch.current !== epoch) {
        return false
      }

      setSkills(nextSkills)
      setToolsets(nextToolsets.filter(toolset => isDesktopToolsetVisible(toolset.name)))

      return true
    } catch (err) {
      if (!mounted.current || loadEpoch.current !== epoch) {
        return false
      }

      setError(err)

      return false
    } finally {
      if (mounted.current && loadEpoch.current === epoch) {
        setLoading(false)
      }
    }
  }, [client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const visibleSkills = useMemo(() => {
    const normalized = normalize(query)

    return (skills ?? []).filter(skill => skillMatches(skill, normalized)).sort((a, b) => a.name.localeCompare(b.name))
  }, [query, skills])

  const visibleToolsets = useMemo(() => {
    const normalized = normalize(query)

    return (toolsets ?? [])
      .filter(toolset => toolsetMatches(toolset, normalized))
      .sort((a, b) => toolsetDisplayLabel(a).localeCompare(toolsetDisplayLabel(b)))
  }, [query, toolsets])

  const activeSkill = visibleSkills.find(skill => skill.name === selectedSkill) ?? visibleSkills[0] ?? null
  const activeToolset = visibleToolsets.find(toolset => toolset.name === selectedToolset) ?? visibleToolsets[0] ?? null

  const clearLearnedSkillInteraction = useCallback(() => {
    learnedSkillEpoch.current += 1
    setArchiveTarget(null)
    setSkillEditor(null)
    setSkillEditorError(null)
    setSkillEditorLoading(null)
    setSkillSaving(false)
    setSkillDraft('')
  }, [])

  const openSkillEditor = useCallback(
    async (name: string) => {
      if (!learnedClient) {
        return
      }

      const epoch = learnedSkillEpoch.current + 1
      learnedSkillEpoch.current = epoch
      setArchiveTarget(null)
      setSkillEditor(null)
      setSkillEditorError(null)
      setSkillEditorLoading(name)
      setSkillSaving(false)

      try {
        const node = await learnedClient.getLearnedSkill(name)

        if (!mounted.current || learnedSkillEpoch.current !== epoch) {
          return
        }

        if (!node.ok || node.kind !== 'skill') {
          throw responseError('', t.errors.genericFailure)
        }

        setSkillEditor({ content: node.content, name })
        setSkillDraft(node.content)
      } catch (err) {
        if (mounted.current && learnedSkillEpoch.current === epoch) {
          setSkillEditorError({ message: err instanceof Error ? err.message : t.errors.genericFailure, name })
        }
      } finally {
        if (mounted.current && learnedSkillEpoch.current === epoch) {
          setSkillEditorLoading(null)
        }
      }
    },
    [learnedClient, t.errors.genericFailure]
  )

  const saveSkillEdit = useCallback(async () => {
    if (!learnedClient || !skillEditor || skillSaving) {
      return
    }

    const { name } = skillEditor
    const epoch = learnedSkillEpoch.current
    setSkillEditorError(null)
    setSkillSaving(true)

    try {
      const result = await learnedClient.editLearnedSkill(name, skillDraft)

      if (!result.ok) {
        throw responseError(result.message, t.errors.genericFailure)
      }

      if (!mounted.current || learnedSkillEpoch.current !== epoch) {
        return
      }

      const refreshed = await refresh()

      if (!mounted.current || learnedSkillEpoch.current !== epoch) {
        return
      }

      setSkillEditor(null)
      setSkillDraft('')

      if (!refreshed) {
        setSkillEditorError({ message: t.skills.skillsLoadFailed, name })
      }
    } catch (err) {
      if (mounted.current && learnedSkillEpoch.current === epoch) {
        setSkillEditorError({ message: err instanceof Error ? err.message : t.errors.genericFailure, name })
      }
    } finally {
      if (mounted.current && learnedSkillEpoch.current === epoch) {
        setSkillSaving(false)
      }
    }
  }, [learnedClient, refresh, skillDraft, skillEditor, skillSaving, t.errors.genericFailure, t.skills.skillsLoadFailed])

  const learnedSkillEditor = skillEditor && (
    <DetailPane
      actions={
        <Button disabled={skillSaving} onClick={() => void saveSkillEdit()} size="xs">
          {skillSaving ? t.common.saving : t.common.save}
        </Button>
      }
      id="matrix-learned-skill-editor"
      onClose={clearLearnedSkillInteraction}
      title={<span className="text-[0.68rem] font-normal text-muted-foreground/60">{skillEditor.name}/SKILL.md</span>}
    >
      <div className="flex h-full min-h-0 flex-col">
        {skillEditorError?.name === skillEditor.name && (
          <p
            className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            {skillEditorError.message}
          </p>
        )}
        <CodeEditorSurface
          disabled={skillSaving}
          filePath="SKILL.md"
          initialValue={skillEditor.content}
          key={skillEditor.name}
          onCancel={clearLearnedSkillInteraction}
          onChange={setSkillDraft}
          onSave={() => void saveSkillEdit()}
          resolvedMode={appearance}
        />
      </div>
    </DetailPane>
  )

  const enqueueToggle = useCallback(
    (kind: 'skill' | 'toolset', name: string, enabled: boolean) => {
      const busyKey = `${kind}:${name}`

      // State updates are visible on the following render; the ref also closes
      // the same-event gap before the Switch becomes disabled.
      if (busyRowKeys.current.has(busyKey)) {
        return
      }

      busyRowKeys.current.add(busyKey)
      setBusyRows(current => new Set(current).add(busyKey))

      if (kind === 'skill') {
        setSkills(current => current?.map(row => (row.name === name ? { ...row, enabled } : row)) ?? current)
      } else {
        setToolsets(current => current?.map(row => (row.name === name ? { ...row, enabled } : row)) ?? current)
      }

      const operation = async () => {
        try {
          if (kind === 'skill') {
            await client.toggleSkill(name, enabled)
          } else {
            await client.toggleToolset(name, enabled)
          }
        } catch (err) {
          if (mounted.current) {
            if (kind === 'skill') {
              setSkills(
                current => current?.map(row => (row.name === name ? { ...row, enabled: !enabled } : row)) ?? current
              )
            } else {
              setToolsets(
                current => current?.map(row => (row.name === name ? { ...row, enabled: !enabled } : row)) ?? current
              )
            }

            notifyError(err, t.skills.failedToUpdate(name))
          }
        } finally {
          busyRowKeys.current.delete(busyKey)

          if (mounted.current) {
            setBusyRows(current => {
              const next = new Set(current)
              next.delete(busyKey)

              return next
            })
          }
        }
      }

      // Hermes saves disabled lists through config read-modify-write. Keep all
      // rows in one FIFO even though only the active row gets a busy affordance.
      mutationQueue.current = mutationQueue.current.then(operation, operation)
    },
    [client, t]
  )

  const empty = (noun: string) => {
    const q = query.trim()

    return (
      <div className="flex h-full min-h-0 flex-1">
        <PanelEmpty
          description={q ? t.skills.emptyNothingMatches(q) : t.skills.emptyNoneAvailable(noun)}
          icon="search"
          title={t.skills.emptyNoneFound(noun)}
        />
      </div>
    )
  }

  const closePage = () => {
    loadEpoch.current += 1
    clearLearnedSkillInteraction()
    onClose?.()
  }

  return (
    <PageSearchShell
      {...props}
      activeTab={mode}
      onSearchChange={setQuery}
      onTabChange={id => {
        if (id !== mode) {
          clearLearnedSkillInteraction()
        }

        setMode(id as Mode)

        if (id === 'skills') {
          void refresh()
        }
      }}
      searchPlaceholder={
        mode === 'hub'
          ? t.skills.hub.searchPlaceholder
          : mode === 'toolsets'
            ? t.skills.searchToolsets
            : t.skills.searchSkills
      }
      searchTrailingAction={
        onClose ? (
          <Button onClick={closePage} size="sm" variant="ghost">
            {t.common.close}
          </Button>
        ) : undefined
      }
      searchValue={query}
      tabs={[
        { id: 'skills', label: t.skills.tabSkills, meta: skills?.length ?? null },
        { id: 'toolsets', label: t.skills.tabToolsets, meta: toolsets?.length ?? null },
        ...(renderHub ? [{ id: 'hub', label: t.skills.tabHub }] : [])
      ]}
    >
      {mode === 'hub' && renderHub ? (
        renderHub(query, () => void refresh())
      ) : loading && !skills && !toolsets ? (
        <PageLoader label={t.skills.loading} />
      ) : error && (!skills || !toolsets) ? (
        <PanelEmpty
          action={
            <Button onClick={() => void refresh()} size="sm">
              {t.skills.refresh}
            </Button>
          }
          description={error instanceof Error ? error.message : undefined}
          icon="error"
          title={t.skills.skillsLoadFailed}
        />
      ) : mode === 'skills' ? (
        visibleSkills.length === 0 ? (
          empty('skills')
        ) : (
          <MasterDetail pane={learnedSkillEditor} split="wide">
            <ListColumn>
              {visibleSkills.map(skill => (
                <CapRow
                  active={activeSkill?.name === skill.name}
                  busy={busyRows.has(`skill:${skill.name}`)}
                  enabled={skill.enabled}
                  key={skill.name}
                  meta={typeof skill.usage === 'number' && skill.usage > 0 ? `×${skill.usage}` : undefined}
                  onSelect={() => {
                    if (activeSkill?.name !== skill.name) {
                      clearLearnedSkillInteraction()
                    }

                    setSelectedSkill(skill.name)
                  }}
                  onToggle={enabled => enqueueToggle('skill', skill.name, enabled)}
                  subtitle={
                    <>
                      <span className="truncate">{prettyName(categoryFor(skill))}</span>
                      {skill.provenance === 'agent' && (
                        <Badge className="shrink-0 normal-case" variant="default">
                          learned
                        </Badge>
                      )}
                      {skill.provenance === 'hub' && (
                        <Badge className="shrink-0 normal-case" variant="muted">
                          hub
                        </Badge>
                      )}
                    </>
                  }
                  title={skill.name}
                  toggleLabel={skill.name}
                />
              ))}
            </ListColumn>
            <DetailColumn footer={t.skills.changesApplyNewSessions}>
              {activeSkill && (
                <>
                  <SkillMetadataDetail skill={activeSkill} />
                  {learnedClient && activeSkill.provenance === 'agent' && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Button
                          disabled={skillEditorLoading === activeSkill.name || skillSaving}
                          onClick={() => void openSkillEditor(activeSkill.name)}
                          size="xs"
                          variant="text"
                        >
                          {t.skills.edit}
                        </Button>
                        <Button
                          className="text-destructive hover:text-destructive"
                          disabled={skillEditorLoading === activeSkill.name || skillSaving}
                          onClick={() => {
                            setSkillEditorError(null)
                            setArchiveTarget(activeSkill.name)
                          }}
                          size="xs"
                          variant="text"
                        >
                          {t.skills.archive}
                        </Button>
                      </div>
                      {skillEditorLoading === activeSkill.name && (
                        <p className="text-xs text-muted-foreground" role="status">
                          {t.skills.loading}
                        </p>
                      )}
                      {skillEditorError?.name === activeSkill.name && !skillEditor && (
                        <div className="flex items-center gap-2 text-xs text-destructive" role="alert">
                          <span>{skillEditorError.message}</span>
                          <Button onClick={() => void openSkillEditor(activeSkill.name)} size="xs" variant="text">
                            {t.common.retry}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </DetailColumn>
          </MasterDetail>
        )
      ) : visibleToolsets.length === 0 ? (
        empty('tools')
      ) : (
        <MasterDetail split="wide">
          <ListColumn>
            {visibleToolsets.map(toolset => {
              const label = toolsetDisplayLabel(toolset)

              return (
                <CapRow
                  active={activeToolset?.name === toolset.name}
                  busy={busyRows.has(`toolset:${toolset.name}`)}
                  enabled={toolset.enabled}
                  key={toolset.name}
                  meta={toolNames(toolset).length ? `${toolNames(toolset).length} tools` : undefined}
                  onSelect={() => setSelectedToolset(toolset.name)}
                  onToggle={enabled => enqueueToggle('toolset', toolset.name, enabled)}
                  subtitle={asText(toolset.description)}
                  title={label}
                  toggleLabel={t.skills.toggleToolset(label)}
                />
              )
            })}
          </ListColumn>
          <DetailColumn footer={t.skills.changesApplyNewSessions}>
            {activeToolset && <ToolsetMetadataDetail toolset={activeToolset} />}
          </DetailColumn>
        </MasterDetail>
      )}
      {archiveTarget && learnedClient && (
        <ConfirmDialog
          confirmLabel={t.skills.archive}
          description={t.skills.skillArchivedMessage}
          destructive
          onClose={() => setArchiveTarget(null)}
          onConfirm={async () => {
            const name = archiveTarget
            const epoch = learnedSkillEpoch.current
            const result = await learnedClient.archiveLearnedSkill(name)

            if (!result.ok) {
              throw responseError(result.message, t.errors.genericFailure)
            }

            if (!mounted.current || learnedSkillEpoch.current !== epoch) {
              return
            }

            const refreshed = await refresh()

            if (!mounted.current || learnedSkillEpoch.current !== epoch) {
              return
            }

            setArchiveTarget(null)
            setSkillEditor(null)
            setSkillDraft('')

            setSkillEditorError(refreshed ? null : { message: t.skills.skillsLoadFailed, name })
          }}
          open
          title={`${t.skills.archive} ${archiveTarget}?`}
        />
      )}
    </PageSearchShell>
  )
}
