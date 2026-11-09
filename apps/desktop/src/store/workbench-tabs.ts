import { atom, computed } from 'nanostores'

import { revealTreePane } from '@/components/pane-shell/tree/store'
import { persistentAtom } from '@/lib/persisted'

import { type ActionPanelOwner, newPanelDraft, panelDraftKey, panelOwnerKey } from './action-panel-owner'
import { $atumShellEnabled, setWorkspaceOpen } from './atum-shell'
import type { PreviewTarget } from './preview'
import { ownsActionPanel } from './windows'

export type WorkbenchRestore = 'ephemeral' | 'persistent' | 'session'
export type WorkbenchSingleton = 'details' | 'files' | 'tools'
export type WorkbenchBrowserStatus = 'blocked' | 'error' | 'loading' | 'ready' | 'start'

/** A generic consumer-browser tab. App views are a separate surface (`app-view`) and never carry a URL. */
export interface WorkbenchBrowserTab {
  id: string
  partition: string
  status: WorkbenchBrowserStatus
  title: string
  url: string
}

export type WorkbenchSurface =
  | { kind: 'app-menu'; app: string }
  /** A main-owned app view opened from {app, route_id}; nothing else is ever persisted for it. */
  | { kind: 'app-view'; app: string; routeId: string }
  | { kind: 'artifact'; conversationId: string; resourceId: string }
  | { kind: 'browser'; browser: WorkbenchBrowserTab }
  | { kind: 'preview'; target: PreviewTarget }
  | { kind: WorkbenchSingleton }

export interface WorkbenchTabRegistration {
  /** Stable mount identity across provisional/draft scope adoption. */
  viewKey?: string
  id: string
  pinned?: boolean
  restore: WorkbenchRestore
  scopeKey: string
  surface: WorkbenchSurface
  title: string
}

const STORAGE_KEY = 'hermes.desktop.workbenchTabs.v3'
const RETIRED_STORAGE_KEYS = ['hermes.desktop.filePreviewTabs.v1', 'hermes.desktop.workbenchResourceTabs.v1', 'atum.desktop.workspaceTabs.v2']
const MAX_PERSISTED_TABS = 64
const MAX_TABS_PER_SCOPE = 32

type WorkbenchTabDisposer = (tab: WorkbenchTabRegistration) => void
type WorkbenchTabEvictionGuard = (tab: WorkbenchTabRegistration) => boolean

const disposers = new Set<WorkbenchTabDisposer>()
const evictionGuards = new Set<WorkbenchTabEvictionGuard>()

/** Called for every registration that leaves the strip by any path — an
 * explicit close, scope teardown, eviction, or reset — so main-owned
 * resources (a file lease, say) never outlive their tab. */
export function registerWorkbenchTabDisposer(disposer: WorkbenchTabDisposer): () => void {
  disposers.add(disposer)

  return () => disposers.delete(disposer)
}

/** Return false to keep a tab out of the oldest-first eviction that keeps a
 * scope under its tab limit (unsaved edits, for instance). */
export function registerWorkbenchTabEvictionGuard(guard: WorkbenchTabEvictionGuard): () => void {
  evictionGuards.add(guard)

  return () => evictionGuards.delete(guard)
}

function commitWorkbenchTabs(next: WorkbenchTabRegistration[]): void {
  const kept = new Set(next.map(tab => tab.id))
  const keptViews = new Set(next.map(tab => tab.viewKey).filter(Boolean))
  // Rehoming a draft changes its tab ID, but keeps the same mounted view and
  // native grant. Only a view that actually leaves the registry is disposed.
  const removed = $workbenchTabs.get().filter(tab => !kept.has(tab.id) && (!tab.viewKey || !keptViews.has(tab.viewKey)))
  $workbenchTabs.set(next)

  for (const tab of removed) {
    for (const dispose of disposers) {dispose(tab)}
  }
}

// Only draft adoption can authorize a frozen capture to follow its new chat.
const captureScopeAliases = new Map<string, string>()

export function resolveCaptureScope(scope: string): string {
  return captureScopeAliases.get(scope) ?? scope
}

const MAX_TEXT = 512
const APP_ID = /^[a-z][a-z0-9_-]{0,63}$/u
const ROUTE_ID = /^[a-z][a-z0-9_-]{0,63}$/u
const BROWSER_STATES = new Set<WorkbenchBrowserStatus>(['blocked', 'error', 'loading', 'ready', 'start'])
const SINGLETONS = new Set<WorkbenchSingleton>(['details', 'files', 'tools'])

export const SESSION_WORKBENCH_SCOPE = 'session'
export const ATUM_DM_WORKBENCH_SCOPE_PREFIX = 'atum-dm:'
export const ATUM_CHAT_WORKBENCH_SCOPE_PREFIX = 'atum-chat:'

export function workbenchScopeKey(conversationId: null | string | undefined): string {
  return conversationId ?? SESSION_WORKBENCH_SCOPE
}

export function atumDmWorkbenchScopeKey(
  accountId: null | string | undefined,
  conversationId: null | string | undefined
): string {
  const conversation = conversationId?.trim()

  if (!conversation) {return SESSION_WORKBENCH_SCOPE}
  const account = accountId?.trim() || 'pending'

  return `${ATUM_DM_WORKBENCH_SCOPE_PREFIX}${encodeURIComponent(account)}:${encodeURIComponent(conversation)}`
}

/**
 * One assistant chat owns one action-panel scope, keyed by the durable stored
 * session id (the lineage root, which survives auto-compression). A fresh
 * draft has no id yet and lives in the generic session scope until it becomes
 * a chat — see `adoptDraftWorkbenchScope`.
 */
export function assistantChatWorkbenchScopeKey(storedSessionId: null | string | undefined, owner?: ActionPanelOwner): string {
  const requested = storedSessionId?.trim()
  const id = requested ? (chatScopeAliases.get(`${panelOwnerKey(owner)}\0${requested}`) ?? requested) : ''

  return id ? `${ATUM_CHAT_WORKBENCH_SCOPE_PREFIX}${panelOwnerKey(owner)}:${encodeURIComponent(id)}` : panelDraftKey()
}

// Auto-compression rotates a chat's live id (root -> continuation tip) and
// navigates to the tip before `$sessions` carries the tip row. Until that
// refresh, nothing can map the routed tip back to the lineage root, so the
// rotation handler records the mapping here — the same gap the composer
// draft covers with `migrateSessionDraft`. In-memory only: after a restart
// the session list itself resolves the tip.
const MAX_CHAT_SCOPE_ALIASES = 64
const chatScopeAliases = new Map<string, string>()

export function aliasAssistantChatScope(storedSessionId: string, durableSessionId: string): void {
  const alias = storedSessionId.trim()
  const target = durableSessionId.trim()

  if (!alias || !target || alias === target) {return}
  const resolved = chatScopeAliases.get(`${panelOwnerKey()}\0${target}`) ?? target

  chatScopeAliases.delete(`${panelOwnerKey()}\0${alias}`)
  chatScopeAliases.set(`${panelOwnerKey()}\0${alias}`, resolved)

  while (chatScopeAliases.size > MAX_CHAT_SCOPE_ALIASES) {
    const oldest = chatScopeAliases.keys().next().value

    if (oldest === undefined) {break}
    chatScopeAliases.delete(oldest)
  }
}

// Tabs already in the generic session scope when the current draft began. A
// draft adopts only what was opened during it, so legacy single-conversation
// tabs (and tabs opened on non-chat routes, which also use the session scope)
// are never swept into whichever chat the user happens to create next.
let draftBaseline: null | Set<string> = null

export function markDraftWorkbenchBaseline(): void {
  if ($atumShellEnabled.get()) {newPanelDraft(); setWorkbenchScope(panelDraftKey())}
  draftBaseline = new Set($workbenchTabs.get().filter(tab => tab.scopeKey === panelDraftKey()).map(tab => tab.id))
}

function safeText(value: unknown, maximum = MAX_TEXT): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null
}

function safeBrowserUrl(value: unknown): string | null {
  const url = safeText(value, 4096)

  if (!url) {return null}

  try {
    const parsed = new URL(url)

    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
  } catch {
    return null
  }
}

function isPreviewTarget(value: unknown): value is PreviewTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return false}
  const source = value as Record<string, unknown>

  return source.kind === 'file' && typeof source.label === 'string' && typeof source.source === 'string' && typeof source.url === 'string' && source.dataUrl === undefined && source.partition === undefined && !source.workspaceTextFile && !source.contextFile
}

function sanitizeBrowser(value: unknown): WorkbenchBrowserTab | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return null}
  const source = value as Record<string, unknown>
  const id = safeText(source.id)
  const partition = safeText(source.partition)
  const title = safeText(source.title)
  const url = safeBrowserUrl(source.url)
  const status = source.status

  if (!id || !partition || !title || !url || typeof status !== 'string' || !BROWSER_STATES.has(status as WorkbenchBrowserStatus)) {return null}

  // Persisted app browser tabs from before slice 3 (`persist:atum-app-<app>`
  // with a URL) are dropped: an app view is re-opened from {app, route_id}.
  return partition === `atum-consumer-browser-${id}` ? { id, partition, status: status as WorkbenchBrowserStatus, title, url } : null
}

export function workspaceTabId(scope: string, id: string): string {
  return `workspace:${scope}:${id}`
}

function sanitizePersistentRegistration(value: unknown): WorkbenchTabRegistration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return null}
  const source = value as Record<string, unknown>
  const id = safeText(source.id)
  const scopeKey = safeText(source.scopeKey, 512)
  const title = safeText(source.title)
  const surface = source.surface as Record<string, unknown> | undefined

  if (!id || !scopeKey || !title || source.restore !== 'persistent' || !surface) {return null}

  if (surface.kind === 'preview' && isPreviewTarget(surface.target) && id === previewWorkbenchTabId(surface.target, scopeKey)) {
    return { id, restore: 'persistent', scopeKey, surface: { kind: 'preview', target: surface.target }, title }
  }

  if (surface.kind === 'browser') {
    const browser = sanitizeBrowser(surface.browser)
    const expected = browser ? workspaceTabId(scopeKey, `browser:${browser.id}`) : ''

    return browser && id === expected ? { id, restore: 'persistent', scopeKey, surface: { browser, kind: 'browser' }, title } : null
  }

  if (surface.kind === 'app-view') {
    const app = safeText(surface.app, 64)
    const routeId = safeText(surface.routeId, 64)
    const expected = app && routeId ? appViewWorkbenchTabId(scopeKey, app, routeId) : ''

    return app && routeId && APP_ID.test(app) && ROUTE_ID.test(routeId) && id === expected
      ? { id, restore: 'persistent', scopeKey, surface: { app, kind: 'app-view', routeId }, title }
      : null
  }

  if (surface.kind === 'app-menu') {
    const app = safeText(surface.app, 64)
    const expected = app ? workspaceTabId(scopeKey, `app-menu:${app}`) : ''

    return app && APP_ID.test(app) && id === expected ? { id, pinned: true, restore: 'persistent', scopeKey, surface: { app, kind: 'app-menu' }, title } : null
  }

  if (typeof surface.kind === 'string' && SINGLETONS.has(surface.kind as WorkbenchSingleton)) {
    const kind = surface.kind as WorkbenchSingleton

    return id === workspaceTabId(scopeKey, kind) ? { id, restore: 'persistent', scopeKey, surface: { kind }, title } : null
  }

  return null
}

function persistentTabs(tabs: readonly WorkbenchTabRegistration[]): WorkbenchTabRegistration[] {
  return tabs.filter(tab => !tab.scopeKey.includes('pending:') && !tab.scopeKey.includes(':draft:') && tab.restore === 'persistent' && tab.surface.kind !== 'artifact').slice(-MAX_PERSISTED_TABS)
}

const $persistedWorkbenchTabs = !ownsActionPanel() ? atom<WorkbenchTabRegistration[]>([]) : persistentAtom<WorkbenchTabRegistration[]>(STORAGE_KEY, [], {
  decode: raw => {
    try {
      const parsed = JSON.parse(raw) as unknown

      return Array.isArray(parsed) ? parsed.map(sanitizePersistentRegistration).filter((tab): tab is WorkbenchTabRegistration => Boolean(tab)).slice(-MAX_PERSISTED_TABS) : []
    } catch {
      return []
    }
  },
  encode: tabs => JSON.stringify(persistentTabs(tabs), (key, value) => key === 'dataUrl' || key === 'contextFile' ? undefined : value)
})

export const $workbenchTabs = atom<WorkbenchTabRegistration[]>(ownsActionPanel() ? $persistedWorkbenchTabs.get() : [])
export const $workbenchScope = atom<string>(SESSION_WORKBENCH_SCOPE)
export const $activeWorkbenchTabId = atom<null | string>(null)
export const $visibleWorkbenchTabs = computed([$workbenchTabs, $workbenchScope], (tabs, scope) => tabs.filter(tab => tab.scopeKey === scope))
const $activeWorkbenchTabByScope = atom<Record<string, null | string>>({})

if (typeof window !== 'undefined' && ownsActionPanel()) {
  for (const key of RETIRED_STORAGE_KEYS) {window.localStorage.removeItem(key)}
}

$workbenchTabs.subscribe(tabs => {if (ownsActionPanel()) {$persistedWorkbenchTabs.set(persistentTabs(tabs))}})

function rememberActive(scope: string, id: null | string): void {
  $activeWorkbenchTabByScope.set({ ...$activeWorkbenchTabByScope.get(), [scope]: id })

  if ($workbenchScope.get() === scope) {$activeWorkbenchTabId.set(id)}
}

function registrationIndex(id: string): number {
  return $workbenchTabs.get().findIndex(tab => tab.id === id)
}

function limitScopeTabs(tabs: WorkbenchTabRegistration[], scope: string): WorkbenchTabRegistration[] {
  const scoped = tabs.filter(tab => tab.scopeKey === scope)

  if (scoped.length <= MAX_TABS_PER_SCOPE) {return tabs}
  const removable = scoped.filter(tab => !tab.pinned && [...evictionGuards].every(guard => guard(tab))).slice(0, scoped.length - MAX_TABS_PER_SCOPE)
  const remove = new Set(removable.map(tab => tab.id))

  return tabs.filter(tab => !remove.has(tab.id))
}

export function previewWorkbenchTabId(target: PreviewTarget, scopeKey = $workbenchScope.get()): string {
  return workspaceTabId(scopeKey, `resource:${target.url}`)
}

export function artifactWorkbenchTabId(scopeKey: string, resourceId: string): string {
  return workspaceTabId(scopeKey, `artifact:${resourceId}`)
}

export function setWorkbenchScope(conversationId: null | string | undefined): void {
  const scope = workbenchScopeKey(conversationId)

  if ($workbenchScope.get() !== scope) {$workbenchScope.set(scope)}
  const requested = $activeWorkbenchTabByScope.get()[scope]
  const valid = requested && $workbenchTabs.get().some(tab => tab.id === requested && tab.scopeKey === scope) ? requested : null
  $activeWorkbenchTabId.set(valid)
}

export function openWorkbenchTab(input: WorkbenchTabRegistration): void {
  if (!ownsActionPanel()) {return}

  if (!input.id.trim() || !input.scopeKey.trim() || !input.title.trim()) {return}
  const tabs = $workbenchTabs.get()
  const index = registrationIndex(input.id)
  input = { ...input, viewKey: index < 0 ? crypto.randomUUID() : tabs[index].viewKey }
  const next = index < 0 ? [...tabs, input] : tabs.map((tab, current) => current === index ? input : tab)

  commitWorkbenchTabs(limitScopeTabs(next, input.scopeKey))
}

export function openPreviewWorkbenchTab(target: PreviewTarget, options: { restore: WorkbenchRestore; scopeKey: string; title?: string }): string {
  const id = previewWorkbenchTabId(target, options.scopeKey)

  openWorkbenchTab({ id, restore: options.restore, scopeKey: options.scopeKey, surface: { kind: 'preview', target }, title: options.title || target.label })

  return id
}

export function ensureWorkbenchAppMenu(scope: string, app: string): void {
  if (!safeText(scope, 512) || !APP_ID.test(app)) {return}
  const id = workspaceTabId(scope, `app-menu:${app}`)
  // One conversation owns one app. A scope holding another app's menu — a
  // stale pin from a build that could cross them, restored from storage —
  // gives it up here, so a panel never shows two apps at once. App menus are
  // pinned, so `closeWorkbenchTab` deliberately will not do this.
  const current = $workbenchTabs.get()
  const foreign = current.filter(tab => tab.scopeKey === scope && tab.surface.kind === 'app-menu' && tab.id !== id)

  if (foreign.length) {
    commitWorkbenchTabs(current.filter(tab => !foreign.some(stale => stale.id === tab.id)))

    if (foreign.some(stale => $activeWorkbenchTabByScope.get()[scope] === stale.id)) {rememberActive(scope, null)}
  }

  openWorkbenchTab({ id, pinned: true, restore: 'persistent', scopeKey: scope, surface: { app, kind: 'app-menu' }, title: app })

  if (!$activeWorkbenchTabByScope.get()[scope]) {rememberActive(scope, id)}
}

export function openWorkbenchSingleton(kind: WorkbenchSingleton, scope = $workbenchScope.get()): void {
  const id = workspaceTabId(scope, kind)

  openWorkbenchTab({ id, restore: 'persistent', scopeKey: scope, surface: { kind }, title: kind })
  revealWorkbenchTab(id)
}

export function appViewWorkbenchTabId(scope: string, app: string, routeId: string): string {
  return workspaceTabId(scope, `app-view:${app}:${routeId}`)
}

/** Open (or reveal) the app view for one declared route. Only `{app, routeId}` is remembered. */
export function openWorkbenchAppView(app: string, routeId: string, title: string, scope = $workbenchScope.get()): string | null {
  if (!APP_ID.test(app) || !ROUTE_ID.test(routeId)) {return null}
  const id = appViewWorkbenchTabId(scope, app, routeId)

  openWorkbenchTab({ id, restore: 'persistent', scopeKey: scope, surface: { app, kind: 'app-view', routeId }, title: safeText(title) || routeId })
  revealWorkbenchTab(id)

  return id
}

export function openWorkbenchBrowser(browser: WorkbenchBrowserTab, scope = $workbenchScope.get()): void {
  const id = workspaceTabId(scope, `browser:${browser.id}`)

  openWorkbenchTab({ id, restore: 'persistent', scopeKey: scope, surface: { browser, kind: 'browser' }, title: browser.title })
  revealWorkbenchTab(id)
}

export function updateWorkbenchBrowser(browser: WorkbenchBrowserTab, scope = $workbenchScope.get()): void {
  const current = $workbenchTabs.get().find(tab => tab.id === workspaceTabId(scope, `browser:${browser.id}`))

  if (!current || current.surface.kind !== 'browser') {return}
  openWorkbenchTab({ ...current, surface: { browser, kind: 'browser' }, title: browser.title })
}

export function showWorkbenchStart(scope = $workbenchScope.get()): void {
  rememberActive(scope, null)
}

export function revealWorkbenchTab(id: string): boolean {
  const registration = $workbenchTabs.get().find(tab => tab.id === id)

  if (!registration) {return false}
  rememberActive(registration.scopeKey, id)

  if ($atumShellEnabled.get()) {
    // Discover only suppresses presentation. Remember a foreground reveal so
    // returning to chat shows it without reopening merely because a tab exists.
    if (registration.scopeKey === $workbenchScope.get()) {setWorkspaceOpen(true)}
  } else {revealTreePane(id)}

  return true
}

export function selectWorkbenchTab(id: null | string): void {
  if (id === null) {showWorkbenchStart()} else {revealWorkbenchTab(id)}
}

export function closeWorkbenchTab(id: string): void {
  const current = $workbenchTabs.get()
  const index = current.findIndex(tab => tab.id === id)
  const registration = current[index]

  if (!registration || registration.pinned) {return}
  const next = current.filter(tab => tab.id !== id)
  commitWorkbenchTabs(next)

  if ($activeWorkbenchTabByScope.get()[registration.scopeKey] === id) {
    const scoped = next.filter(tab => tab.scopeKey === registration.scopeKey)
    const originalScopedIndex = current.filter(tab => tab.scopeKey === registration.scopeKey).findIndex(tab => tab.id === id)
    rememberActive(registration.scopeKey, scoped[originalScopedIndex]?.id ?? scoped[originalScopedIndex - 1]?.id ?? null)
  }
}

export function closePreviewWorkbenchTabs(target: PreviewTarget): void {
  const ids = $workbenchTabs.get().flatMap(tab =>
    tab.surface.kind === 'preview' && tab.surface.target.url === target.url ? [tab.id] : []
  )

  for (const id of ids) {closeWorkbenchTab(id)}
}

/**
 * Re-key every tab in `from` under `to`. Tab ids embed their scope, so ids are
 * rewritten too; a tab the target scope already holds wins over the migrating
 * duplicate. The active tab follows when the moving scope was visible.
 */
export function migrateWorkbenchScope(from: string, to: string, only?: (tab: WorkbenchTabRegistration) => boolean): void {
  if (!from || !to || from === to) {return}
  const tabs = $workbenchTabs.get()
  const moving = tabs.filter(tab => tab.scopeKey === from && (!only || only(tab)))

  if (moving.length === 0) {return}
  const fromPrefix = `workspace:${from}:`
  const toPrefix = `workspace:${to}:`
  const rekey = (id: string): string => id.startsWith(fromPrefix) ? `${toPrefix}${id.slice(fromPrefix.length)}` : id
  const existing = new Set(tabs.filter(tab => tab.scopeKey === to).map(tab => tab.id))
  const migrated = moving.map(tab => ({ ...tab, id: rekey(tab.id), scopeKey: to })).filter(tab => !existing.has(tab.id))

  const moved = new Set(moving.map(tab => tab.id))

  commitWorkbenchTabs(limitScopeTabs([...tabs.filter(tab => !moved.has(tab.id)), ...migrated], to))
  const active = { ...$activeWorkbenchTabByScope.get() }
  const previousActive = active[from]

  if (previousActive && moved.has(previousActive)) {
    delete active[from]
    // The target keeps its own remembered tab when it has one.
    active[to] ??= rekey(previousActive)
  }

  $activeWorkbenchTabByScope.set(active)

  if ($workbenchScope.get() === from && moving.length === tabs.filter(tab => tab.scopeKey === from).length) {setWorkbenchScope(to)}
}

/**
 * A fresh draft just became a real chat. In the Atum shell the panel the user
 * filled while drafting must follow the conversation it turned into; the
 * stock Hermes shell keeps everything in the one session scope, so this is a
 * no-op there.
 */
export function adoptDraftWorkbenchScope(storedSessionId: null | string | undefined): void {
  const baseline = draftBaseline

  draftBaseline = null

  if (!$atumShellEnabled.get() || !storedSessionId?.trim() || !baseline) {return}
  const from = panelDraftKey()
  const to = assistantChatWorkbenchScopeKey(storedSessionId)
  captureScopeAliases.set(from, to)
  migrateWorkbenchScope(from, to, tab => !baseline.has(tab.id))
}

export function closeWorkbenchScope(scopeKey: string): void {
  const next = $workbenchTabs.get().filter(tab => tab.scopeKey !== scopeKey)
  commitWorkbenchTabs(next)
  const active = { ...$activeWorkbenchTabByScope.get() }

  delete active[scopeKey]
  $activeWorkbenchTabByScope.set(active)

  if ($workbenchScope.get() === scopeKey) {$activeWorkbenchTabId.set(null)}
}

/**
 * A gateway switch replaces the whole session list, and session ids are only
 * unique within one backend. Chat scopes are keyed by session id, so they go
 * with the backend that minted them rather than surfacing under an unrelated
 * chat that happens to share an id.
 */
export function closeAssistantChatWorkbenchScopes(): void {
  captureScopeAliases.clear()
  chatScopeAliases.clear()
  draftBaseline = null
  closeWorkbenchScopesByPrefix(ATUM_CHAT_WORKBENCH_SCOPE_PREFIX)
}

export function closeWorkbenchScopesByPrefix(prefix: string): void {
  if (!prefix) {return}

  const scopes = new Set($workbenchTabs.get().filter(tab => tab.scopeKey.startsWith(prefix)).map(tab => tab.scopeKey))

  for (const scope of scopes) {closeWorkbenchScope(scope)}
}

export function clearWorkbenchTabs(kind?: WorkbenchSurface['kind']): void {
  const next = kind ? $workbenchTabs.get().filter(tab => tab.surface.kind !== kind) : []
  commitWorkbenchTabs(next)
  $activeWorkbenchTabByScope.set({})
  $activeWorkbenchTabId.set(null)
}

export function replaceWorkbenchTab(id: string, input: WorkbenchTabRegistration): void {
  if (id !== input.id || registrationIndex(id) < 0) {return}
  openWorkbenchTab(input)
}

export function resetWorkbenchTabs(): void {
  captureScopeAliases.clear()
  chatScopeAliases.clear()
  draftBaseline = null
  commitWorkbenchTabs([])
  $workbenchScope.set(SESSION_WORKBENCH_SCOPE)
  $activeWorkbenchTabByScope.set({})
  $activeWorkbenchTabId.set(null)
}

/** A provisional scope may be adopted only by the identity probe which owns
 * its generation. No legacy unscoped tabs are relabelled as current context. */
export function adoptProvisionalPanelOwner(previous: string, next: string): void {
  const prefix = `${ATUM_CHAT_WORKBENCH_SCOPE_PREFIX}${previous}:`
  const scopes = new Set($workbenchTabs.get().map(tab => tab.scopeKey).filter(scope => scope.startsWith(prefix)))

  for (const scope of scopes) {migrateWorkbenchScope(scope, `${ATUM_CHAT_WORKBENCH_SCOPE_PREFIX}${next}:${scope.slice(prefix.length)}`)}
}
