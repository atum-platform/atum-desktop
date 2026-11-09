import { useQueries, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useDebounced } from '@/app/hooks/use-debounced'
import { DetailPane } from '@/app/master-detail'
import { LogTail } from '@/components/chat/log-tail'
import { PageLoader } from '@/components/page-loader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ErrorBanner, ErrorState } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { stripAnsi } from '@/lib/ansi'
import { Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type {
  SkillHubPreview,
  SkillHubResult,
  SkillHubScanResult,
  SkillHubSearchResponse,
  SkillHubSourcesResponse
} from '@/types/hermes'

const TRUST_RANK: Record<string, number> = { builtin: 2, trusted: 1, community: 0 }

export type HubQueryKeyPrefix = readonly unknown[]

/**
 * The presentation only needs browse and preview transport. Installation and
 * action polling stay with the embedding surface, where authority lives.
 */
export interface HubClient {
  getSources: () => Promise<SkillHubSourcesResponse>
  preview: (identifier: string) => Promise<SkillHubPreview>
  search: (query: string, source: string) => Promise<SkillHubSearchResponse>
}

/** The deliberately small action view shared by legacy and native hosts. */
export interface HubAction {
  exitCode?: null | number
  kind?: string
  lines: string[]
  running: boolean
}

/** Optional only for the legacy adapter, whose established cache keys predate this presentation. */
export interface HubQueryKeys {
  preview: (identifier: string) => readonly unknown[]
  search: (query: string, source: string) => readonly unknown[]
  sources: readonly unknown[]
}

export interface HubPresentationProps {
  actions: Record<string, HubAction | undefined>
  activeLogKey?: null | string
  client: HubClient
  /** Legacy Hub closed its preview as an install action started. */
  closeDetailOnInstall?: boolean
  installedOverrides: Record<string, boolean | undefined>
  /** A skill to open the detail of once a search lists it (the Store sent the person here).
   * It only opens the detail: installing still takes the person's click. */
  focusIdentifier?: string
  /** Native hosts receive isolated keys; legacy supplies HubQueryKeys to retain its cache contract. */
  queryKeyPrefix: HubQueryKeyPrefix
  query: string
  onActionError?: (error: unknown) => void
  onCloseLog?: () => void
  onInstall: (identifier: string, name: string) => Promise<void>
  onScan?: (identifier: string) => Promise<SkillHubScanResult>
  onUninstall?: (identifier: string, installedName: string) => Promise<void>
  onUpdate?: (identifier: string, installedName: string) => Promise<void>
  onUpdateAll?: () => Promise<void>
  maintenanceNote?: string
  queryKeys?: HubQueryKeys
  updateActionKey?: string
  uninstallLabel?: string
  uninstallingLabel?: string
}

function trustTone(level: string): string {
  switch (level) {
    case 'builtin':
      return 'bg-(--ui-bg-tertiary) text-(--ui-text-secondary)'

    case 'trusted':
      return 'bg-emerald-500/15 text-emerald-400'

    default:
      return 'bg-amber-500/15 text-amber-400'
  }
}

function verdictTone(policy: string): string {
  switch (policy) {
    case 'allow':
      return 'text-emerald-400'

    case 'block':
      return 'text-destructive'

    default:
      return 'text-amber-400'
  }
}

function actionErrorMessage(error: unknown): string | null {
  // A cancelled native confirmation is not a failed installation.
  if (error instanceof DOMException && error.name === 'AbortError') {
    return null
  }

  if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
    return null
  }

  return error instanceof Error && error.message ? error.message : null
}

function HubSkillRow({
  action,
  installed,
  installedName,
  onInstall,
  onPreview,
  onUninstall,
  onUpdate,
  uninstallLabel,
  uninstallingLabel,
  skill
}: {
  action?: HubAction
  installed: boolean
  installedName: null | string
  onInstall: () => void
  onPreview: (skill: SkillHubResult) => void
  onUninstall?: () => void
  onUpdate?: () => void
  uninstallLabel?: string
  uninstallingLabel?: string
  skill: SkillHubResult
}) {
  const { t } = useI18n()
  const h = t.skills.hub
  const running = action?.running ?? false

  return (
    <div className="row-hover flex items-start gap-3 rounded-md px-2 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[0.78rem] font-medium text-foreground/85">{skill.name}</span>
          <span className={cn('rounded px-1.5 py-0.5 text-[0.6rem]', trustTone(skill.trust_level))}>
            {h.trust[skill.trust_level] ?? skill.trust_level}
          </span>
          {installed && <span className="text-[0.6rem] text-emerald-400">{h.installed}</span>}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[0.68rem] text-muted-foreground/70">{skill.description}</p>
        {action?.exitCode !== undefined && action.exitCode !== null && action.exitCode !== 0 && (
          <p className="mt-1 text-[0.65rem] text-destructive">{h.actionFailed}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button onClick={() => onPreview(skill)} size="xs" variant="text">
          {h.preview}
        </Button>
        {installed ? (
          <>
            {onUpdate && (
              <Button disabled={running} onClick={onUpdate} size="xs" variant="text">
                {running && <Loader2 className="size-3 animate-spin" />}
                {running ? h.updating : h.update}
              </Button>
            )}
            {onUninstall && (
              <Button
                className="hover:text-destructive"
                disabled={running}
                onClick={onUninstall}
                size="xs"
                variant="text"
              >
                {running && <Loader2 className="size-3 animate-spin" />}
                {running ? (uninstallingLabel ?? h.uninstalling) : (uninstallLabel ?? h.uninstall)}
              </Button>
            )}
          </>
        ) : !installed ? (
          <Button disabled={running} onClick={onInstall} size="xs" variant="textStrong">
            {running && <Loader2 className="size-3 animate-spin" />}
            {running ? h.installing : h.install}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Transport-free Skills Hub browser. It owns transient presentation state and
 * progressive per-source queries, while the embedding host owns authority for
 * installs, optional maintenance controls, and action lifecycle polling.
 */
export function HubPresentation({
  actions,
  activeLogKey,
  client,
  closeDetailOnInstall = false,
  focusIdentifier,
  installedOverrides,
  onActionError,
  onCloseLog,
  onInstall,
  onScan,
  onUninstall,
  onUpdate,
  onUpdateAll,
  maintenanceNote,
  query,
  queryKeyPrefix,
  queryKeys,
  uninstallLabel,
  uninstallingLabel,
  updateActionKey = '__update_all__'
}: HubPresentationProps) {
  const { t } = useI18n()
  const h = t.skills.hub
  const sourcesKey = queryKeys?.sources ?? [...queryKeyPrefix, 'sources']
  const term = useDebounced(query.trim(), 350)
  const [detail, setDetail] = useState<null | SkillHubResult>(null)
  const [scan, setScan] = useState<null | SkillHubScanResult>(null)
  const [scanning, setScanning] = useState(false)
  const [actionError, setActionError] = useState<null | string>(null)
  const scanState = useRef({ generation: 0, pending: false })

  // Scan is a transient preview, not cached authority. A late response belongs
  // only to the detail and host which requested it, including close/reopen of
  // the same skill. Invalidating observation does not cancel upstream cleanup.
  const resetScan = useCallback(() => {
    scanState.current.generation++
    scanState.current.pending = false
    setScan(null)
    setScanning(false)
  }, [])

  useEffect(() => {
    const state = scanState.current
    resetScan()

    return () => {
      state.generation++
      state.pending = false
    }
  }, [onScan, resetScan])

  const closeDetail = useCallback(() => {
    resetScan()
    setDetail(null)
  }, [resetScan])

  const sourcesQuery = useQuery({
    queryKey: sourcesKey,
    queryFn: client.getSources,
    staleTime: 5 * 60_000
  })

  const searchableSources = useMemo(
    () => (sourcesQuery.data?.sources ?? []).filter(source => source.searchable !== false),
    [sourcesQuery.data]
  )

  const sourceSearches = useQueries({
    queries: searchableSources.map(source => ({
      queryKey: queryKeys?.search(term, source.id) ?? [...queryKeyPrefix, 'search', term, source.id],
      queryFn: () => client.search(term, source.id),
      enabled: term.length > 0,
      staleTime: 60_000
    }))
  })

  const previewQuery = useQuery({
    queryKey: queryKeys?.preview(detail?.identifier ?? '') ?? [...queryKeyPrefix, 'preview', detail?.identifier],
    queryFn: () => client.preview(detail!.identifier),
    enabled: detail !== null,
    staleTime: 5 * 60_000
  })

  const runAction = useCallback(
    (operation: () => Promise<void>) => {
      setActionError(null)
      void operation().catch(error => {
        const message = actionErrorMessage(error)

        if (message) {
          setActionError(message)
        }

        onActionError?.(error)
      })
    },
    [onActionError]
  )

  const runInstall = useCallback(
    (identifier: string, name: string) => {
      if (closeDetailOnInstall) {
        closeDetail()
      }

      runAction(() => onInstall(identifier, name))
    },
    [closeDetail, closeDetailOnInstall, onInstall, runAction]
  )

  const runScan = useCallback(
    (identifier: string) => {
      const state = scanState.current

      if (!onScan || state.pending) {
        return
      }

      const generation = ++state.generation
      const current = () => state.generation === generation
      state.pending = true
      setScanning(true)
      setActionError(null)
      void onScan(identifier)
        .then(result => {
          if (!current()) {
            return
          }

          if (result.identifier !== identifier) {
            throw new Error(h.actionFailed)
          }

          setScan(result)
        })
        .catch(error => {
          if (!current()) {
            return
          }

          const message = actionErrorMessage(error)

          if (message) {
            setActionError(message)
          }

          onActionError?.(error)
        })
        .finally(() => {
          if (current()) {
            state.pending = false
            setScanning(false)
          }
        })
    },
    [h.actionFailed, onActionError, onScan]
  )

  const openDetail = useCallback(
    (skill: SkillHubResult) => {
      resetScan()
      setDetail(skill)
      setActionError(null)
    },
    [resetScan]
  )

  const retrySearches = useCallback(() => {
    for (const result of sourceSearches) {
      if (result.isError) {
        void result.refetch()
      }
    }
  }, [sourceSearches])

  const searchStateById = new Map<string, { failed: boolean; fetching: boolean }>()
  searchableSources.forEach((source, index) => {
    const search = sourceSearches[index]
    searchStateById.set(source.id, { failed: search.isError, fetching: term.length > 0 && search.isFetching })
  })

  const results = useMemo(() => {
    const seen = new Map<string, SkillHubResult>()

    for (const search of sourceSearches) {
      for (const result of search.data?.results ?? []) {
        const previous = seen.get(result.identifier)

        if (!previous || (TRUST_RANK[result.trust_level] ?? 0) > (TRUST_RANK[previous.trust_level] ?? 0)) {
          seen.set(result.identifier, result)
        }
      }
    }

    return [...seen.values()].sort(
      (a, b) => (TRUST_RANK[b.trust_level] ?? 0) - (TRUST_RANK[a.trust_level] ?? 0) || a.name.localeCompare(b.name)
    )
  }, [sourceSearches])

  // Opened once, as soon as the search finds it; closing it leaves the person on the results.
  const focused = useRef(false)
  const focus = focusIdentifier ? results.find(result => result.identifier === focusIdentifier) : undefined

  useEffect(() => {
    if (focus && !focused.current) {
      focused.current = true
      openDetail(focus)
    }
  }, [focus, openDetail])

  const installed = { ...(sourcesQuery.data?.installed ?? {}) }

  for (const search of sourceSearches) {
    Object.assign(installed, search.data?.installed ?? {})
  }

  const isInstalled = (identifier: string) => installedOverrides[identifier] ?? Boolean(installed[identifier])
  const anyFetching = term.length > 0 && sourceSearches.some(search => search.isFetching)
  const searched = term.length > 0 && sourceSearches.length > 0 && sourceSearches.every(search => !search.isFetching)
  const listed = term.length === 0 ? (sourcesQuery.data?.featured ?? []) : results
  const searching = anyFetching && results.length === 0
  const searchFailed = sourceSearches.some(search => search.isError)
  const activeLog = activeLogKey ? actions[activeLogKey] : undefined
  const hasInstalled = Object.keys(installed).length > 0 || Object.values(installedOverrides).some(Boolean)
  const mutationsPending = Object.values(actions).some(action => action?.running)
  const detailInstalledName = detail ? (installed[detail.identifier]?.name ?? null) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-5 pb-8 text-[0.68rem] text-(--ui-text-tertiary)">
        <span className="mb-1.5 block">{h.connectedHubs}</span>
        {sourcesQuery.isError ? (
          <ErrorBanner className="text-[0.68rem]">
            <span>{h.loadFailed}</span>
            <Button className="ml-2" onClick={() => void sourcesQuery.refetch()} size="xs" variant="text">
              {h.search}
            </Button>
          </ErrorBanner>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {sourcesQuery.data?.sources.map(source => {
              const state = searchStateById.get(source.id)
              const degraded = source.available === false || source.rate_limited === true || state?.failed

              return (
                <span
                  className={cn(
                    'relative rounded px-1.5 py-0.5 text-[0.6rem] transition-opacity',
                    degraded ? 'bg-amber-500/15 text-amber-400' : 'bg-(--ui-bg-tertiary) text-(--ui-text-secondary)',
                    term.length > 0 && !state?.fetching && !state?.failed && 'opacity-55'
                  )}
                  key={source.id}
                >
                  <span className={cn(state?.fetching && 'opacity-30')}>{source.label}</span>
                  {state?.fetching && (
                    <span className="absolute inset-0 grid place-items-center">
                      <Loader2 className="size-2.5 animate-spin" />
                    </span>
                  )}
                </span>
              )
            })}
          </div>
        )}
      </div>

      {listed.length > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-1.5 text-[0.68rem] text-(--ui-text-tertiary)">
          <span className="min-w-0 truncate">
            {term.length > 0 ? h.resultCount(results.length, null) : h.featured}
            {anyFetching && results.length > 0 && (
              <span className="ml-2 text-(--ui-text-quaternary)">{h.searching}</span>
            )}
          </span>
          {hasInstalled && onUpdateAll && (
            <Button
              className="shrink-0"
              disabled={mutationsPending}
              onClick={() => runAction(onUpdateAll)}
              size="xs"
              variant="text"
            >
              {actions[updateActionKey]?.running && <Loader2 className="size-3 animate-spin" />}
              {actions[updateActionKey]?.running ? h.updating : h.updateAll}
            </Button>
          )}
        </div>
      )}

      {maintenanceNote && hasInstalled && (onUpdate || onUpdateAll) && (
        <p className="shrink-0 px-4 pb-3 text-[0.65rem] text-(--ui-text-quaternary)">{maintenanceNote}</p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable]">
        {searchFailed && (
          <ErrorBanner className="mb-3 text-[0.68rem]">
            <span>{h.searchFailed}</span>
            <Button className="ml-2" onClick={retrySearches} size="xs" variant="text">
              {h.search}
            </Button>
          </ErrorBanner>
        )}
        {searching ? (
          <div className="grid min-h-40 place-items-center">
            <PageLoader label={h.searching} />
          </div>
        ) : listed.length === 0 ? (
          <div className="grid min-h-40 place-items-center px-6 text-center">
            <p className="max-w-md text-[0.72rem] text-(--ui-text-tertiary)">
              {searched ? h.noResults : h.landingHint}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {listed.map(skill => {
              const installedName = installed[skill.identifier]?.name ?? null

              return (
                <HubSkillRow
                  action={actions[skill.identifier]}
                  installed={isInstalled(skill.identifier)}
                  installedName={installedName}
                  key={skill.identifier}
                  onInstall={() => runInstall(skill.identifier, skill.name)}
                  onPreview={openDetail}
                  onUninstall={
                    onUninstall
                      ? () =>
                          runAction(() =>
                            onUninstall(skill.identifier, installed[skill.identifier]?.name ?? skill.name)
                          )
                      : undefined
                  }
                  onUpdate={
                    onUpdate && installedName
                      ? () => runAction(() => onUpdate(skill.identifier, installedName))
                      : undefined
                  }
                  skill={skill}
                  uninstallingLabel={uninstallingLabel}
                  uninstallLabel={uninstallLabel}
                />
              )
            })}
          </div>
        )}
      </div>

      {activeLogKey && onCloseLog && (
        <DetailPane
          defaultCollapsed
          defaultHeight={176}
          id="hub-action-log"
          onClose={onCloseLog}
          title={
            <span className="flex items-center gap-1.5 text-[0.68rem] font-normal text-muted-foreground/60">
              {h.actionLog}
              {activeLog?.running && <Codicon name="loading" size="0.75rem" spinning />}
            </span>
          }
        >
          <LogTail emptyLabel={h.searching} lines={activeLog?.lines.length ? activeLog.lines.map(stripAnsi) : null} />
        </DetailPane>
      )}

      <Dialog onOpenChange={open => !open && closeDetail()} open={detail !== null}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="truncate">{detail.name}</span>
                  <Badge className={trustTone(detail.trust_level)}>
                    {h.trust[detail.trust_level] ?? detail.trust_level}
                  </Badge>
                </DialogTitle>
                <DialogDescription className="truncate">{detail.identifier}</DialogDescription>
              </DialogHeader>
              <div className="min-h-0 space-y-3 overflow-y-auto">
                {actionError && <ErrorBanner>{actionError}</ErrorBanner>}
                {scan && (
                  <div className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3 text-xs">
                    <div className={cn('font-medium', verdictTone(scan.policy))}>
                      {scan.policy === 'allow' ? h.policyAllow : scan.policy === 'block' ? h.policyBlock : h.policyAsk}
                      {' · '}
                      {scan.verdict === 'safe'
                        ? h.verdictSafe
                        : scan.verdict === 'dangerous'
                          ? h.verdictDangerous
                          : h.verdictCaution}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {scan.findings.length === 0 ? h.noFindings : h.findings(scan.findings.length)}
                    </div>
                    {scan.findings.slice(0, 12).map((finding, index) => (
                      <div className="mt-1.5 font-mono text-[0.65rem] text-(--ui-text-tertiary)" key={index}>
                        [{finding.severity}] {finding.file}
                        {finding.line !== null ? `:${finding.line}` : ''} — {finding.description}
                      </div>
                    ))}
                  </div>
                )}
                {previewQuery.isLoading ? (
                  <PageLoader className="min-h-32" label={h.searching} />
                ) : previewQuery.isError ? (
                  <ErrorState className="py-6" description={h.previewFailed} title={h.previewFailed}>
                    <Button onClick={() => void previewQuery.refetch()} size="sm" variant="secondary">
                      {h.search}
                    </Button>
                  </ErrorState>
                ) : previewQuery.data ? (
                  <>
                    <pre
                      className="max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3 font-mono text-[0.68rem] leading-relaxed"
                      data-selectable-text="true"
                    >
                      {previewQuery.data.skill_md || h.noReadme}
                    </pre>
                    {previewQuery.data.files.length > 0 && (
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium">{h.files}:</span> {previewQuery.data.files.join(', ')}
                      </div>
                    )}
                  </>
                ) : null}
              </div>
              <DialogFooter>
                {onScan && (
                  <Button disabled={scanning} onClick={() => runScan(detail.identifier)} size="sm" variant="text">
                    {scanning ? h.scanning : h.scan}
                  </Button>
                )}
                {isInstalled(detail.identifier) && onUpdate && detailInstalledName && (
                  <Button
                    disabled={mutationsPending}
                    onClick={() => runAction(() => onUpdate(detail.identifier, detailInstalledName))}
                    size="sm"
                    variant="text"
                  >
                    {actions[detail.identifier]?.running ? h.updating : h.update}
                  </Button>
                )}
                <Button
                  disabled={mutationsPending || isInstalled(detail.identifier)}
                  onClick={() => runInstall(detail.identifier, detail.name)}
                  size="sm"
                >
                  {isInstalled(detail.identifier) ? h.installed : h.install}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
