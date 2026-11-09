import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { Loader } from '@/components/ui/loader'
import { useMediaQuery } from '@/hooks/use-media-query'
import { type Locale, useI18n } from '@/i18n'
import {
  ArrowLeft,
  ChevronRight,
  Clock,
  Cloud,
  Compass,
  Cpu,
  FolderOpen,
  type IconComponent,
  LayoutDashboard,
  Link,
  Starmap,
  Wrench
} from '@/lib/icons'

import type { MatrixAgentView, MatrixSnapshot } from '../../shared/matrix'
import { matrixCommandCenterCopy } from '../../shared/matrix-command-center-copy'
import { type MatrixAppearanceMode, matrixDisplayMode } from '../../shared/matrix-display-preferences'
import type { MatrixPageId, MatrixPagesBridge, MatrixPagesResult, MatrixPagesState } from '../../shared/matrix-pages'
import { matrixStarmapCopy } from '../../shared/matrix-starmap-copy'

import { MainAgentBadge } from './main-agent-badge'
import { MatrixProfileAvatar } from './profile-avatar'
import { primaryAgent } from './room-agent'
import { matrixRosterAgentName } from './roster-model'
import { type WorkplaceCopy, workplaceCopy } from './workplace-copy'
import {
  isDeveloperWorkplacePage,
  WORKPLACE_DEVELOPER_PAGES,
  WORKPLACE_SURFACES,
  type WorkplaceSurfaceId
} from './workplace-nav'

const PAGE_ICONS: Record<MatrixPageId, IconComponent> = {
  scheduled: Clock,
  artifacts: FolderOpen,
  skills: Wrench,
  connections: Link,
  runtime: Cpu,
  providers: Cloud,
  'command-center': LayoutDashboard,
  starmap: Starmap,
  mcp: Link
}

function pageText(page: MatrixPageId, c: WorkplaceCopy, locale: Locale): { title: string; help: string } {
  switch (page) {
    case 'scheduled':
      return { title: c.scheduled, help: c.scheduledHelp }

    case 'artifacts':
      return { title: c.artifacts, help: c.artifactsHelp }

    case 'skills':
      return { title: c.skills, help: c.skillsHelp }

    case 'runtime':
      return { title: c.runtime, help: c.runtimeHelp }

    case 'providers':
      return { title: c.providers, help: c.providersHelp }

    case 'connections':
      return { title: c.connections, help: c.connectionsHelp }

    case 'command-center':
      return { title: matrixCommandCenterCopy[locale].title, help: c.commandCenterHelp }

    case 'starmap':
      return { title: matrixStarmapCopy[locale].title, help: c.starmapHelp }

    case 'mcp':
      return { title: c.mcp, help: c.mcpHelp }
  }
}

/** A page's title and its one line of help, as Workplace and Settings › Advanced list it. */
export function workplacePageText(page: MatrixPageId, locale: Locale): { title: string; help: string } {
  return pageText(page, workplaceCopy[locale], locale)
}

/** The everyday places, as a card each: the icon, and the words that name them and say what they hold. */
const SURFACE_CARDS: Record<
  WorkplaceSurfaceId,
  { Icon: IconComponent; title: (c: WorkplaceCopy) => string; help: (c: WorkplaceCopy) => string }
> = {
  routines: { Icon: Clock, title: c => c.routines, help: c => c.routinesHelp },
  drive: { Icon: FolderOpen, title: c => c.drive, help: c => c.driveHelp },
  store: { Icon: Compass, title: c => c.store, help: c => c.storeHelp }
}

function errorOf<T>(result: MatrixPagesResult<T>): result is { error: string } {
  return typeof result === 'object' && result !== null && 'error' in result
}

export function workplaceAgent(snapshot: MatrixSnapshot, principal?: string): MatrixAgentView | undefined {
  return principal ? snapshot.agents?.find(agent => agent.principal === principal) : primaryAgent(snapshot)
}

/**
 * Chat owns only bounds, visibility and the current local agent. The native pages
 * view owns page loading and presentation above this DOM slot.
 */
function MatrixNativePagesHost({
  accountKey,
  agent,
  bridge,
  hub,
  onClose,
  obstructed,
  page,
  preference
}: {
  accountKey: string
  agent: MatrixAgentView
  bridge: MatrixPagesBridge | undefined
  /** Skills only: the official Hub skill the Store sent the person to. */
  hub?: string
  onClose: () => void
  obstructed: boolean
  page: MatrixPageId
  preference?: MatrixAppearanceMode
}) {
  const { locale } = useI18n()
  const dark = useMediaQuery('(prefers-color-scheme: dark)')
  const appearance = matrixDisplayMode(preference, dark)
  const [state, setState] = useState<MatrixPagesState['status']>('loading')
  const [error, setError] = useState<string | undefined>(undefined)
  const [openedId, setOpenedId] = useState<string | undefined>(undefined)
  // Try again re-opens the same page; the failure code stays out of the sentence.
  const [attempt, setAttempt] = useState(0)
  const slot = useRef<HTMLDivElement>(null)
  const viewId = useRef<string | undefined>(undefined)
  const intent = useRef(0)
  const c = workplaceCopy[locale]
  const cloudOnly = error === 'pages_agent_cloud'
  const cloudHostUnavailable =
    error === 'pages_agent_not_running' ||
    (error === 'pages_agent_unavailable' && agent.answering === 'cloud' && agent.macRole !== 'answering')
  const expectedUnavailable = cloudOnly || cloudHostUnavailable

  useEffect(() => {
    if (!bridge) {
      setState('error')
      setError('matrix_pages_unavailable')

      return
    }

    let live = true
    const request = ++intent.current
    viewId.current = undefined
    setOpenedId(undefined)
    setState('loading')
    setError(undefined)

    void bridge
      .open({ page, agentPrincipal: agent.principal, locale, appearance, ...(hub ? { hub } : {}) })
      .then(result => {
        if (errorOf(result)) {
          if (live && request === intent.current) {
            setState('error')
            setError(result.error)
          }

          return
        }

        const opened = result.viewId

        if (!live || request !== intent.current) {
          void bridge.close(opened).catch(() => {})

          return
        }

        viewId.current = opened
        setOpenedId(opened)
        // Native open resolves only after the local document loaded. Its ready
        // event can arrive before we know this opaque id, so use the reply too.
        setState('ready')
      })
      .catch(() => {
        if (live && request === intent.current) {
          setState('error')
          setError('matrix_pages_unavailable')
        }
      })

    return () => {
      live = false
      intent.current = request + 1
      const opened = viewId.current
      viewId.current = undefined
      setOpenedId(undefined)

      if (opened) {
        void bridge.close(opened).catch(() => {})
      }
    }
  }, [accountKey, agent.principal, appearance, attempt, bridge, hub, locale, page])

  useEffect(() => {
    if (!bridge) {
      return
    }

    return bridge.onState(next => {
      if (next.viewId !== viewId.current) {
        return
      }

      if (next.status === 'destroyed') {
        onClose()

        return
      }

      setState(next.status)
      setError(next.error)
    })
  }, [bridge, onClose])

  useLayoutEffect(() => {
    if (!bridge) {
      return
    }

    const report = () => {
      const opened = viewId.current
      const bounds = slot.current?.getBoundingClientRect()

      if (!opened || !bounds || bounds.width <= 0 || bounds.height <= 0) {
        return
      }

      void bridge
        .setBounds({
          viewId: opened,
          bounds: {
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height)
          }
        })
        .catch(() => {})
    }

    report()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(report)

    if (slot.current) {
      observer?.observe(slot.current)
    }

    window.addEventListener('resize', report)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [bridge, openedId])

  useEffect(() => {
    const opened = viewId.current

    if (bridge && opened) {
      void bridge.setVisibility({ viewId: opened, visible: !obstructed, overlayActive: obstructed }).catch(() => {})
    }
  }, [bridge, obstructed, openedId])

  useEffect(() => {
    const opened = viewId.current

    if (bridge && opened && state === 'ready' && !obstructed) {
      void bridge.focus(opened).catch(() => {})
    }
  }, [bridge, obstructed, openedId, state])

  return (
    <div className="relative flex min-h-0 flex-1" data-matrix-pages-host ref={slot}>
      {state === 'error' ? (
        <div
          className="m-auto flex flex-col items-center gap-3 text-sm text-(--atum-ink-muted)"
          data-matrix-pages-error={error ?? 'unknown'}
          role="status"
        >
          <p>{cloudOnly ? c.everywhere : cloudHostUnavailable ? c.hostUnavailable : c.failed}</p>
          {bridge && !expectedUnavailable && (
            <Button onClick={() => setAttempt(value => value + 1)} size="sm" variant="secondary">
              {c.retry}
            </Button>
          )}
        </div>
      ) : (
        state !== 'ready' && <Loader className="m-auto size-8" label={c.opening} />
      )}
    </div>
  )
}

function AgentChip({
  agent,
  name,
  onSelect,
  scopeKey,
  selected
}: {
  agent: MatrixAgentView
  name: string
  onSelect(): void
  scopeKey: string
  selected: boolean
}) {
  return (
    <button
      aria-pressed={selected}
      className={`flex h-8 items-center gap-2 rounded-full ps-1 pe-3 text-(length:--atum-t-control) transition-colors ${
        selected
          ? 'bg-(--atum-card) font-medium text-(--atum-ink) shadow-(--atum-glass-edge)'
          : 'text-(--atum-ink-muted) hover:bg-(--atum-hover) hover:text-(--atum-ink)'
      }`}
      onClick={onSelect}
      type="button"
    >
      <MatrixProfileAvatar
        avatarUrl={agent.avatarUrl}
        brand={agent.isDefault}
        className="size-6 shrink-0 rounded-full text-[0.625rem]"
        id={agent.principal}
        mark={agent.mark}
        name={name}
        profile={agent.profile}
        scopeKey={scopeKey}
        target={{ kind: 'agent', principal: agent.principal }}
      />
      <span className="truncate">{name}</span>
      {agent.isDefault && <MainAgentBadge />}
    </button>
  )
}

export function MatrixWorkplace({
  exitTo = 'chat',
  header,
  initialHub,
  initialPage,
  obstructed,
  onExit,
  onOpenDrive,
  onOpenRoutines,
  onOpenStore,
  preferredAgentPrincipal,
  snapshot
}: {
  /** Drawn above the list (the Personal | Company switch); a page shows its breadcrumb instead. */
  header?: ReactNode
  /** Open straight on one page (the model picker's Advanced options), not on the list. */
  initialPage?: MatrixPageId
  /** With `initialPage` 'skills': the Hub skill a Store listing opens on. */
  initialHub?: string
  obstructed: boolean
  /**
   * Present when there is no Workplace on the rail to go back to: leaving the page (its back
   * control, or the page dismissing itself) returns to the chat it was opened from.
   */
  onExit?: () => void
  /** Where `onExit` leads, which its back control names: the chat (default), Settings or the Store. */
  exitTo?: 'chat' | 'settings' | 'store'
  /**
   * The everyday list is Atum's own places: Drive (only when this build has it), Routines for the
   * chosen assistant, and the Store. A place with no way in is simply not listed; the Hermes page
   * it stands in for is under For developers either way.
   */
  onOpenDrive?: () => void
  onOpenRoutines?: (agentPrincipal: string) => void
  onOpenStore?: () => void
  preferredAgentPrincipal?: string
  snapshot: MatrixSnapshot
}) {
  const { locale, t } = useI18n()
  const c = workplaceCopy[locale]
  const agents = snapshot.agents ?? []
  const preferred = workplaceAgent(snapshot, preferredAgentPrincipal)
  const [principal, setPrincipal] = useState<string | undefined>(preferred?.principal)
  const [page, setPage] = useState<MatrixPageId | undefined>(initialPage)
  // Collapsed for a person who never asked for it; open when they came from (or return to) a page.
  const [developersOpen, setDevelopersOpen] = useState(isDeveloperWorkplacePage(initialPage))
  const developersId = useId()

  useEffect(() => {
    setPrincipal(preferred?.principal)
  }, [preferred?.principal])

  const selected = useMemo(() => (principal ? workplaceAgent(snapshot, principal) : undefined), [principal, snapshot])
  const accountKey = snapshot.identity ? `${snapshot.identity.userId}:${snapshot.identity.deviceId}` : 'signed-out'
  const scopeKey = `${snapshot.identity?.userId}/${snapshot.identity?.deviceId}`
  const agentName = (agent: MatrixAgentView) => matrixRosterAgentName(agent, t.matrixShell.assistantName)

  // A side trip (from the chat, or from Settings) goes back where it came from, by name.
  const { label: exitLabel, aria: exitAria } = {
    chat: { label: c.chat, aria: c.backToChat },
    settings: { label: c.settings, aria: c.backToSettings },
    store: { label: c.store, aria: c.backToStore }
  }[exitTo]

  const breadcrumb = (title: string, leave: () => void) => (
    <nav
      aria-label={onExit ? title : c.title}
      className="flex h-11 shrink-0 items-center gap-1.5 border-b border-(--atum-line) px-4 text-(length:--atum-t-control)"
      data-matrix-workplace-breadcrumb
    >
      <button
        aria-label={onExit ? exitAria : c.back}
        className="flex h-7 items-center gap-1.5 rounded-(--atum-r-control) px-2 text-(--atum-ink-muted) transition-colors hover:bg-(--atum-hover) hover:text-(--atum-ink)"
        onClick={leave}
        type="button"
      >
        <ArrowLeft aria-hidden className="size-4" strokeWidth={1.8} />
        <span>{onExit ? exitLabel : c.title}</span>
      </button>
      <ChevronRight aria-hidden className="size-3.5 text-(--atum-ink-faint)" />
      <h1 aria-current="page" className="min-w-0 truncate font-medium text-(--atum-ink)">
        {title}
      </h1>
      {selected && agents.length > 1 && (
        <span className="ms-auto flex min-w-0 items-center gap-2 text-(--atum-ink-muted)">
          <MatrixProfileAvatar
            avatarUrl={selected.avatarUrl}
            brand={selected.isDefault}
            className="size-5 shrink-0 rounded-full text-[0.5625rem]"
            id={selected.principal}
            mark={selected.mark}
            name={agentName(selected)}
            profile={selected.profile}
            scopeKey={scopeKey}
            target={{ kind: 'agent', principal: selected.principal }}
          />
          <span className="truncate">{agentName(selected)}</span>
          {selected.isDefault && <MainAgentBadge />}
        </span>
      )}
    </nav>
  )

  if (!selected) {
    // Opened as a side trip, the way back stays on screen even when the assistant is gone.
    if (onExit) {
      return (
        <section className="flex min-h-0 flex-1 flex-col" data-matrix-workplace data-matrix-workplace-page={page}>
          {breadcrumb(page ? pageText(page, c, locale).title : c.title, onExit)}
          <p className="m-auto text-sm text-(--atum-ink-muted)" role="status">
            {c.unavailable}
          </p>
        </section>
      )
    }

    return (
      <section className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6" data-matrix-workplace>
        <div className="w-full max-w-3xl">
          {header}
          <h1 className="sr-only">{c.title}</h1>
          <p className="mt-4 text-sm text-(--atum-ink-muted)" role="status">
            {c.unavailable}
          </p>
        </div>
      </section>
    )
  }

  if (page) {
    const current = pageText(page, c, locale)
    const leave = onExit ?? (() => setPage(undefined))

    return (
      <section className="flex min-h-0 flex-1 flex-col" data-matrix-workplace data-matrix-workplace-page={page}>
        {breadcrumb(current.title, leave)}
        <MatrixNativePagesHost
          accountKey={accountKey}
          agent={selected}
          bridge={window.atumMatrix.pages}
          hub={page === 'skills' && page === initialPage ? initialHub : undefined}
          obstructed={obstructed}
          onClose={leave}
          page={page}
          preference={snapshot.displayPreferences?.appearance.value}
        />
      </section>
    )
  }

  const opens: Record<WorkplaceSurfaceId, (() => void) | undefined> = {
    routines: onOpenRoutines ? () => onOpenRoutines(selected.principal) : undefined,
    drive: onOpenDrive,
    store: onOpenStore
  }

  const everyday = WORKPLACE_SURFACES.flatMap(surface => {
    const open = opens[surface.id]

    return open ? [{ id: surface.id, open }] : []
  })

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-8 py-6" data-matrix-workplace>
      <div className="w-full max-w-3xl">
        {header}
        {/* The titlebar already names the page; the heading stays for assistive tech. */}
        <h1 className="sr-only">{c.title}</h1>
        <p className={`${header ? 'mt-5' : ''} text-(length:--atum-t-ui) text-(--atum-ink-muted)`}>{c.intro}</p>
        {agents.length > 1 && (
          <div aria-label={c.chooseAgent} className="mt-4 flex flex-wrap gap-1.5" role="group">
            {agents.map(agent => (
              <AgentChip
                agent={agent}
                key={agent.principal}
                name={agentName(agent)}
                onSelect={() => setPrincipal(agent.principal)}
                scopeKey={scopeKey}
                selected={agent.principal === selected.principal}
              />
            ))}
          </div>
        )}
        {everyday.length > 0 && (
          <div className="mt-6 grid gap-3 sm:grid-cols-3" data-matrix-workplace-everyday>
            {everyday.map(({ id, open }) => {
              const { Icon, title, help } = SURFACE_CARDS[id]

              return (
                <button
                  aria-describedby={`${developersId}-${id}-help`}
                  aria-labelledby={`${developersId}-${id}-title`}
                  className="flex flex-col rounded-(--atum-r-card) bg-(--atum-card) p-4 text-start shadow-(--atum-glass-edge) transition-colors hover:bg-[color-mix(in_srgb,var(--atum-card),var(--atum-ink)_3%)]"
                  data-matrix-workplace-surface={id}
                  key={id}
                  onClick={open}
                  type="button"
                >
                  <span
                    aria-hidden
                    className="grid size-9 place-items-center rounded-[0.625rem] bg-(--atum-sunk) text-(--atum-ink-soft)"
                  >
                    <Icon className="size-[1.125rem]" strokeWidth={1.7} />
                  </span>
                  <span
                    className="mt-3 text-(length:--atum-t-title) font-semibold text-(--atum-ink)"
                    id={`${developersId}-${id}-title`}
                  >
                    {title(c)}
                  </span>
                  <span
                    className="mt-1 text-(length:--atum-t-body) leading-snug text-(--atum-ink-muted)"
                    id={`${developersId}-${id}-help`}
                  >
                    {help(c)}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        <section className={everyday.length > 0 ? 'mt-8' : 'mt-6'} data-matrix-workplace-developers>
          <button
            aria-controls={developersId}
            aria-expanded={developersOpen}
            className="flex items-center gap-1.5 text-(length:--atum-t-control) font-medium text-(--atum-ink-soft) transition-colors hover:text-(--atum-ink)"
            onClick={() => setDevelopersOpen(open => !open)}
            type="button"
          >
            <DisclosureCaret open={developersOpen} />
            {c.forDevelopers}
          </button>
          {developersOpen && (
            <ul
              className="mt-3 overflow-hidden rounded-(--atum-r-card) bg-(--atum-card) shadow-(--atum-glass-edge)"
              id={developersId}
            >
              {WORKPLACE_DEVELOPER_PAGES.map((id, index) => {
                const { title, help } = pageText(id, c, locale)
                const Icon = PAGE_ICONS[id]

                return (
                  <li className={index > 0 ? 'border-t border-(--atum-line)' : undefined} key={id}>
                    <button
                      aria-describedby={`${developersId}-${id}-help`}
                      aria-labelledby={`${developersId}-${id}-title`}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors hover:bg-(--atum-sunk)"
                      data-matrix-workplace-page-row={id}
                      onClick={() => setPage(id)}
                      type="button"
                    >
                      <Icon aria-hidden className="size-4 shrink-0 text-(--atum-ink-muted)" strokeWidth={1.7} />
                      <span className="min-w-0 flex-1">
                        <span
                          className="block text-(length:--atum-t-control) text-(--atum-ink)"
                          id={`${developersId}-${id}-title`}
                        >
                          {title}
                        </span>
                        <span
                          className="block text-(length:--atum-t-caption) text-(--atum-ink-muted)"
                          id={`${developersId}-${id}-help`}
                        >
                          {help}
                        </span>
                      </span>
                      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-(--atum-ink-faint)" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </section>
  )
}
