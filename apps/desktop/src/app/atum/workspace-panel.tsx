import { useStore } from '@nanostores/react'
import { useCallback, useId } from 'react'

import { closeWorkbenchRegistration, WorkbenchResourcePane } from '@/app/chat/workbench-resource-pane'
import { useI18n } from '@/i18n'
import { $atumAppCatalog } from '@/lib/atum-app-catalog'
import { appSurfaceIcon } from '@/lib/atum-app-surface-icons'
import type { AppRoute, AppRoutes } from '@/lib/atum-app-surfaces'
import {
  Apps,
  AppWindow,
  ChevronRight,
  FileText,
  Folder,
  Info,
  PencilLine,
  World
} from '@/lib/icons'
import { relativeTime } from '@/lib/time'
import { $actionPanelOwner, panelOwnerKey } from '@/store/action-panel-owner'
import { $reviewsByScope, hasOpenReview } from '@/store/agent-edits'
import {
  $atumAccountScopeId,
  $atumSocialRelationships,
  $atumSortedRoster
} from '@/store/atum-messaging'
import {
  $workspacePercent,
  setSidebarOpen,
  setWorkspaceExpanded,
  setWorkspaceOpen,
  setWorkspacePercent
} from '@/store/atum-shell'
import { ownsActionPanel } from '@/store/windows'
import {
  $activeWorkbenchTabId,
  $workbenchTabs,
  closeWorkbenchTab,
  openWorkbenchAppView,
  openWorkbenchBrowser,
  openWorkbenchSingleton,
  revealWorkbenchTab,
  showWorkbenchStart,
  updateWorkbenchBrowser,
  type WorkbenchTabRegistration
} from '@/store/workbench-tabs'

import { AtumAppView } from './app-view'
import { AtumConsumerBrowser, createConsumerBrowserTab } from './consumer-browser'
import { AtumConsumerFiles } from './consumer-files'
import { presentAtumConversation } from './roster'
import { AtumSkillsLauncher } from './skills-launcher'
import { useAppRoutes } from './use-app-routes'
import type { AtumWorkspaceState } from './use-workspace'
import { AtumWindowControls } from './window-controls'
import { AtumWorkspaceSurface } from './workspace-surface'

interface AtumWorkspacePanelProps {
  /** The traffic-light pill when the panel is full-frame — over a narrow window
   *  (mock 2g), or because the person expanded it on a wide one. */
  hidden?: boolean
  drawer?: boolean
  /** Expanded on a wide window: the panel leaves the split and fills the frame,
   *  in the same presentation the narrow branch already uses. Unlike `drawer`
   *  it is a mode the person chose, so it keeps its own way back (the tab bar's
   *  control, now "exit full frame") and draws no dismiss scrim. */
  fullFrame?: boolean
  motionPhase?: 'entering' | 'open' | 'exiting'
  onMotionEnd?: () => void
  workspace: AtumWorkspaceState
}

/**
 * One glyph per surface, shared by the tabs and the launcher rows so a surface
 * looks the same wherever it is named. Plain Tabler outlines at one stroke:
 * a folder, the world, a page, an app window, the app grid. The old set mixed
 * a chart-dots "starmap" for apps, an alert triangle for details and a wrench
 * for tools — the raw Hermes vocabulary, which is what read as scrappy.
 */
const ICONS = {
  'app-menu': AppWindow,
  'app-view': AppWindow,
  artifact: FileText,
  browser: World,
  details: Info,
  files: Folder,
  preview: FileText,
  tools: Apps
} as const

export function AtumWorkspacePanel(props: AtumWorkspacePanelProps) {
  const { t } = useI18n()

  return ownsActionPanel()
    ? <OwnedWorkspacePanel {...props} />
    : <p className="p-4 text-(--atum-ink-muted)" role="status">{t.atum.workspace.mainWindowOnly}</p>
}

function OwnedWorkspacePanel({
  hidden = false,
  drawer = false,
  fullFrame = false,
  motionPhase = 'open',
  onMotionEnd,
  workspace
}: AtumWorkspacePanelProps) {
  const { locale, t } = useI18n()
  const percent = useStore($workspacePercent)
  const allWorkbenchTabs = useStore($workbenchTabs)
  const accountId = useStore($atumAccountScopeId)
  const catalogState = useStore($atumAppCatalog)
  const catalog = catalogState.accountId === accountId ? catalogState.apps : []
  const panelOwner = useStore($actionPanelOwner)

  const retainedTextTabs = allWorkbenchTabs.filter(tab =>
    (Boolean(panelOwner && tab.scopeKey.startsWith(`atum-chat:${encodeURIComponent(accountId ?? '')}:${encodeURIComponent(panelOwner.connectionId)}:`)) || tab.scopeKey.startsWith(`atum-chat:${panelOwnerKey()}:`)) &&
    tab.surface.kind === 'preview' && Boolean(tab.surface.target.workspaceTextFile || ['text', 'html'].includes(tab.surface.target.previewKind ?? ''))
  )

  const reviewsByScope = useStore($reviewsByScope)
  const activeWorkbenchTabId = useStore($activeWorkbenchTabId)
  // `setWorkbenchScope` intentionally runs in an effect so the shell can
  // reconcile navigation after it commits. Never use that previous global
  // scope for this render: a conversation/account switch must not paint an
  // outgoing owner's tabs or let its launcher actions receive a click.
  const workbenchTabs = allWorkbenchTabs.filter(tab => tab.scopeKey === workspace.scopeKey)
  const panelId = useId()
  const active = workbenchTabs.find(tab => tab.id === activeWorkbenchTabId) ?? null
  // Narrow (2g) and expanded (1a's "phóng to") are the same picture: the panel
  // over the whole frame with its 44px tab bar. Only the way out differs.
  const { pending: appRoutesPending, routes: appRoutes } = useAppRoutes(active?.surface.kind === 'app-menu' ? active.surface.app : null)

  const openBrowser = useCallback(
    (url?: string) => {
      const browser = { ...createConsumerBrowserTab(url), title: t.atum.browser.newTab }
      openWorkbenchBrowser(browser, workspace.scopeKey)
    },
    [t.atum.browser.newTab, workspace.scopeKey]
  )

  const closeTab = useCallback((tab: WorkbenchTabRegistration) => {
    if (tab.surface.kind === 'artifact' || tab.surface.kind === 'preview') {
      closeWorkbenchRegistration(tab)
    } else {
      closeWorkbenchTab(tab.id)
    }
  }, [])

  return (
    <AtumWorkspaceSurface
      activeId={active?.id}
      drawer={drawer}
      fullFrame={fullFrame}
      hidden={hidden}
      motionPhase={motionPhase}
      onActivate={revealWorkbenchTab}
      onAdd={() => showWorkbenchStart(workspace.scopeKey)}
      onClose={() => setWorkspaceOpen(false)}
      onCloseTab={id => {
        const tab = workbenchTabs.find(tab => tab.id === id)

        if (tab) {
          closeTab(tab)
        }
      }}
      onExpand={setWorkspaceExpanded}
      onMotionEnd={onMotionEnd}
      onPercentChange={setWorkspacePercent}
      panelId={panelId}
      percent={percent}
      tabs={workbenchTabs.map(tab => {
        const Icon = ICONS[tab.surface.kind]

        const reviewPath =
          tab.surface.kind === 'preview' ? tab.surface.target.workspaceTextFile?.workspaceRelativePath : undefined

        const edited = reviewPath ? hasOpenReview(reviewsByScope, tab.scopeKey, reviewPath) : false

        return {
          id: tab.id,
          pinned: tab.pinned,
          title:
            tab.surface.kind === 'files'
              ? t.atum.workspace.tabFiles
              : tab.surface.kind === 'tools'
                ? t.atum.workspace.launcherTools
                : tab.surface.kind === 'details'
                  ? t.atum.workspace.tabDetails
                  : tab.title,
          icon: <Icon aria-hidden className="size-3.5 shrink-0" />,
          indicator: edited ? (
            <PencilLine aria-label={t.preview.agentReviewEdited} className="size-3 shrink-0 text-(--atum-ink-faint)" />
          ) : undefined
        }
      })}
      windowControls={<AtumWindowControls className="me-1" />}
    >
      {retainedTextTabs.map(tab => (
        <div className="h-full min-h-0" hidden={active?.id !== tab.id} key={tab.viewKey ?? tab.id}>
          <WorkbenchResourcePane id={tab.id} />
        </div>
      ))}
      {active &&
        !retainedTextTabs.some(tab => tab.id === active.id) &&
        (active.surface.kind === 'artifact' || active.surface.kind === 'preview') && (
          <WorkbenchResourcePane id={active.id} key={active.viewKey ?? active.id} />
        )}
      {workbenchTabs
        .filter(
          (
            tab
          ): tab is WorkbenchTabRegistration & {
            surface: Extract<WorkbenchTabRegistration['surface'], { kind: 'browser' }>
          } => tab.surface.kind === 'browser'
        )
        .map(registration => {
          const tab = registration.surface.browser

          return (
            <AtumConsumerBrowser
              hidden={hidden || active?.id !== registration.id}
              key={registration.id}
              onOpenTab={url => openBrowser(url)}
              onUpdate={browser => updateWorkbenchBrowser(browser, registration.scopeKey)}
              tab={tab}
            />
          )
        })}
      {workbenchTabs
        .filter(
          (
            tab
          ): tab is WorkbenchTabRegistration & {
            surface: Extract<WorkbenchTabRegistration['surface'], { kind: 'app-view' }>
          } => tab.surface.kind === 'app-view'
        )
        .map(registration => (
          <AtumAppView
            app={registration.surface.app}
            hidden={hidden || active?.id !== registration.id}
            key={registration.id}
            routeId={registration.surface.routeId}
          />
        ))}
      {!active && (
        <AtumWorkspaceLauncher
          headingId={`${panelId}-start`}
          onOpenBrowser={openBrowser}
          scopeKey={workspace.scopeKey}
        />
      )}
      {active?.surface.kind === 'app-menu' && appRoutes && (
        <AtumAppMenuLauncher
          onOpen={route =>
            openWorkbenchAppView(
              appRoutes.app,
              route.id,
              locale === 'vi' ? route.label.vi : route.label.en,
              active.scopeKey
            )
          }
          routes={appRoutes}
        />
      )}
      {active?.surface.kind === 'app-menu' &&
        !appRoutes &&
        // Never the generic launcher here: it is the same surface the
        // previous conversation showed, so a slow manifest looked like the
        // panel had not switched at all, and its buttons stayed live.
        (appRoutesPending ? (
          <div
            className="flex h-full items-center justify-center px-6 text-[length:var(--atum-t-ui)] text-(--atum-ink-muted)"
            role="status"
          >
            {t.atum.appView.loading}
          </div>
        ) : (
          <div
            className="flex h-full items-center justify-center px-6 text-center text-[length:var(--atum-t-ui)] text-(--atum-ink-muted)"
            role="alert"
          >
            {t.atum.appView.appUnavailable}
          </div>
        ))}
      {active?.surface.kind === 'files' && (
        <AtumConsumerFiles conversationId={workspace.dmConversationId} scopeKey={workspace.scopeKey} />
      )}
      {active?.surface.kind === 'tools' && <AtumSkillsLauncher scopeKey={workspace.scopeKey} />}
      {active?.surface.kind === 'details' && <AtumConversationDetails conversationId={workspace.dmConversationId} />}
    </AtumWorkspaceSurface>
  )
}

function AtumAppMenuLauncher({
  onOpen,
  routes
}: {
  onOpen: (route: AppRoute) => void
  routes: AppRoutes
}) {
  const { locale } = useI18n()

  return (
    <div className="h-full overflow-y-auto px-4 py-6">
      <div className="mx-auto max-w-[30rem]">
        <h2 className="text-[length:var(--atum-t-section)] leading-(--atum-lh-section) font-semibold text-(--atum-ink)">
          {routes.app}
        </h2>
        <div className="mt-5 overflow-hidden rounded-[var(--atum-r-card)] border border-(--atum-line) bg-(--atum-card)">
          {routes.routes.filter(route => route.placements.includes('menu')).map(route => {
            const Icon = appSurfaceIcon(route.icon)

            return (
              <button
                className="flex h-14 w-full items-center gap-3 border-b border-(--atum-line) px-3.5 text-left text-[length:var(--atum-t-ui)] last:border-b-0 hover:bg-(--atum-hover)"
                data-atum-app-route={route.id}
                key={route.id}
                onClick={() => onOpen(route)}
                type="button"
              >
                <Icon aria-hidden className="size-5 shrink-0 text-(--atum-accent)" />
                <span className="min-w-0 flex-1">{locale === 'vi' ? route.label.vi : route.label.en}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function AtumWorkspaceLauncher({ headingId, onOpenBrowser, scopeKey }: { headingId: string; onOpenBrowser: () => void; scopeKey: string }) {
  const { t } = useI18n()

  // The "+" tab is a surface picker, not a prompt menu: Files, Browser, and
  // the app launcher. Prompt-shaped starters live on the composer's intro
  // chips. Documents are not a surface of their own here — they are apps, and
  // the launcher (Công cụ) is where apps are opened from; listing "Tài liệu"
  // beside the surfaces made one app look like a fourth kind of panel.
  const actions = [
    { icon: Folder, label: t.atum.workspace.launcherFiles, run: () => openWorkbenchSingleton('files', scopeKey) },
    { icon: World, label: t.atum.workspace.launcherBrowser, run: onOpenBrowser },
    // The launcher wants the width: collapse the left sidebar so the panel
    // opens into a wide workspace instead of a column squeezed beside the roster.
    { icon: Apps, label: t.atum.workspace.launcherTools, run: () => { openWorkbenchSingleton('tools', scopeKey); setSidebarOpen(false) } }
  ]

  return (
    <div className="h-full overflow-y-auto px-5 py-7">
      <div className="mx-auto max-w-[30rem]">
        <h2 className="text-[length:var(--atum-t-title)] leading-(--atum-lh-title) font-semibold text-(--atum-ink)" id={headingId}>{t.atum.workspace.launcherTitle}</h2>
        <p className="mt-1 text-[length:var(--atum-t-body)] leading-(--atum-lh-body) text-(--atum-ink-muted)">{t.atum.workspace.launcherBody}</p>
        {/* One glass card, one row per surface: a sunk 32px glyph tile, the
            name, and a faint chevron — the same shape as a settings row, so
            the launcher reads as part of the shell rather than a list of
            loose icons. */}
        <div className="atum-glass-card mt-5 overflow-hidden rounded-[var(--atum-r-group)]">
          {actions.map(({ icon: Icon, label, run }) => (
            <button
              className="group/launch flex h-14 w-full items-center gap-3 px-3.5 text-left text-[length:var(--atum-t-title)] text-(--atum-ink) shadow-[inset_0_-1px_0_var(--atum-line)] last:shadow-none hover:bg-(--atum-hover)"
              key={label}
              onClick={() => void run()}
              type="button"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-[var(--atum-r-control)] bg-(--atum-sunk) text-(--atum-ink-soft)">
                <Icon aria-hidden className="size-[1.125rem]" />
              </span>
              <span className="min-w-0 flex-1 font-medium">{label}</span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-(--atum-ink-ghost) transition-colors group-hover/launch:text-(--atum-ink-faint)" />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function AtumConversationDetails({ conversationId }: { conversationId: null | string }) {
  const { locale, t } = useI18n()
  const roster = useStore($atumSortedRoster)
  const accountId = useStore($atumAccountScopeId)
  const catalogState = useStore($atumAppCatalog)
  const catalog = catalogState.accountId === accountId ? catalogState.apps : []
  const people = useStore($atumSocialRelationships)
  const conversation = roster.find(entry => entry.id === conversationId)

  if (!conversation) {
    return <div className="grid h-full place-items-center text-(--atum-ink-muted)">{t.atum.workspace.empty}</div>
  }

  const presentation = presentAtumConversation(conversation, locale, { accountId, people }, catalog)
  const activityMs = Date.parse(conversation.lastMessageAt ?? conversation.updatedAt)

  return (
    <div className="px-5 py-5">
      <div className="flex items-center gap-3">
        {presentation.avatarUrl ? (
          <img alt="" className="atum-avatar size-9 object-cover" src={presentation.avatarUrl} />
        ) : (
          <span className="atum-avatar grid size-9 place-items-center bg-(--atum-sunk)">
            {presentation.title.slice(0, 1).toLocaleUpperCase()}
          </span>
        )}
        <div>
          <div className="flex items-center gap-1.5 font-semibold">
            {presentation.title}
          </div>
          <div className="text-[length:var(--atum-t-caption)] text-(--atum-ink-muted)">{presentation.role}</div>
        </div>
      </div>
      {Number.isFinite(activityMs) && (
        <p className="mt-4 text-[length:var(--atum-t-body)] text-(--atum-ink-muted)">{relativeTime(activityMs)}</p>
      )}
    </div>
  )
}
