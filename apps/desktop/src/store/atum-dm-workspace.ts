import { atom, computed } from 'nanostores'

import { type AtumArtifactRef, parseAtumArtifactRefs } from '@/lib/atum-artifacts'
import { atumMessagingClient } from '@/lib/atum-messaging-client'
import { persistentAtom } from '@/lib/persisted'

import { setWorkspaceOpen } from './atum-shell'
import type { PreviewTarget } from './preview'
import {
  artifactWorkbenchTabId,
  ATUM_DM_WORKBENCH_SCOPE_PREFIX,
  atumDmWorkbenchScopeKey,
  closeWorkbenchScopesByPrefix,
  closeWorkbenchTab,
  openPreviewWorkbenchTab,
  openWorkbenchTab,
  revealWorkbenchTab
} from './workbench-tabs'

export type AtumArtifactPanelState =
  | 'idle'
  | 'loading'
  | 'waiting'
  | 'ready'
  | 'missing'
  | 'denied'
  | 'offline'
  | 'unsupported'
  | 'error'

export interface AtumDmArtifactTab {
  attention?: AtumArtifactAttention | null
  ref: AtumArtifactRef
  state: AtumArtifactPanelState
  target: PreviewTarget | null
  targetExpiresAt: number | null
}

export type AtumArtifactAttention = 'complete' | 'failed'

export interface AtumDmArtifactWorkspace {
  activeResourceId: string | null
  /** Absent on legacy/runtime-only fixtures; persisted workspaces normalize it. */
  activeSurface?: 'artifact' | 'launcher' | null
  closedRefs: AtumArtifactRef[]
  launcherIndex?: number | null
  launcherOpen?: boolean
  tabs: AtumDmArtifactTab[]
}

interface PersistedConversationArtifacts {
  activeResourceId: string | null
  activeSurface: 'artifact' | 'launcher' | null
  attention: Record<string, AtumArtifactAttention>
  closedRefs: AtumArtifactRef[]
  launcherIndex: number | null
  launcherOpen: boolean
  refs: AtumArtifactRef[]
}

type PersistedArtifacts = Record<string, Record<string, PersistedConversationArtifacts>>
const MAX_PERSISTED_ACCOUNTS = 20
const MAX_PERSISTED_CONVERSATIONS = 200
export const ATUM_DM_MAX_ARTIFACT_TABS = 16
const MAX_CLOSED_ARTIFACT_TABS = 16
const PERSISTED_REF_KEYS = new Set(['kind', 'resourceId', 'type', 'title', 'status', 'presentation'])

function keepNewest<T>(record: Record<string, T>, maximum: number): Record<string, T> {
  return Object.fromEntries(Object.entries(record).slice(-maximum))
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key))
}

function serializedRef(raw: unknown): unknown {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null

  if (source && Object.keys(source).some(key => !PERSISTED_REF_KEYS.has(key))) {
    return null
  }

  return source
    ? {
        kind: source.kind,
        resource_id: source.resourceId,
        type: source.type,
        title: source.title,
        status: source.status,
        ...(source.presentation ? { presentation: source.presentation } : {})
      }
    : null
}

function sanitizeConversationArtifacts(raw: unknown): PersistedConversationArtifacts | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const source = raw as Record<string, unknown>

  // The resolver checkpoint stored one ref directly. Accept it as a one-tab
  // workspace so upgrading never loses the user's selected object.
  const legacy = parseAtumArtifactRefs([serializedRef(source)])[0]

  if (legacy) {
    return {
      activeResourceId: legacy.resourceId,
      activeSurface: 'artifact',
      attention: {},
      closedRefs: [],
      launcherIndex: null,
      launcherOpen: false,
      refs: [legacy]
    }
  }

  const refs = parseAtumArtifactRefs(Array.isArray(source.refs) ? source.refs.map(serializedRef) : source.refs)
  const openIds = new Set(refs.map(ref => ref.resourceId))

  const closedRefs = parseAtumArtifactRefs(
    Array.isArray(source.closedRefs) ? source.closedRefs.map(serializedRef) : source.closedRefs
  ).filter(ref => !openIds.has(ref.resourceId))

  const activeResourceId = typeof source.activeResourceId === 'string' ? source.activeResourceId : null
  const fallbackResourceId = openIds.has(activeResourceId ?? '') ? activeResourceId : (refs[0]?.resourceId ?? null)

  const rawAttention =
    source.attention && typeof source.attention === 'object' && !Array.isArray(source.attention)
      ? (source.attention as Record<string, unknown>)
      : {}

  const attention: Record<string, AtumArtifactAttention> = {}

  for (const ref of refs) {
    const value = rawAttention[ref.resourceId]

    if (value === 'complete' || value === 'failed') {
      attention[ref.resourceId] = value
    }
  }

  const launcherOpen = source.launcherOpen === true

  const launcherIndex =
    launcherOpen && Number.isInteger(source.launcherIndex)
      ? Math.max(0, Math.min(source.launcherIndex as number, refs.length))
      : launcherOpen
        ? refs.length
        : null

  const requestedSurface = source.activeSurface

  const activeSurface =
    requestedSurface === 'launcher' && launcherOpen
      ? 'launcher'
      : fallbackResourceId
        ? 'artifact'
        : launcherOpen
          ? 'launcher'
          : null

  if (refs.length === 0 && closedRefs.length === 0 && !launcherOpen) {
    return null
  }

  return {
    activeResourceId: activeSurface === 'artifact' ? fallbackResourceId : null,
    activeSurface,
    attention,
    closedRefs,
    launcherIndex,
    launcherOpen,
    refs
  }
}

function sanitizePersistedArtifacts(value: unknown): PersistedArtifacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const accounts: PersistedArtifacts = {}

  for (const [accountId, conversations] of Object.entries(value).slice(-MAX_PERSISTED_ACCOUNTS)) {
    if (
      !accountId ||
      accountId.length > 256 ||
      !conversations ||
      typeof conversations !== 'object' ||
      Array.isArray(conversations)
    ) {
      continue
    }

    const projected: Record<string, PersistedConversationArtifacts> = {}

    for (const [conversationId, raw] of Object.entries(conversations).slice(-MAX_PERSISTED_CONVERSATIONS)) {
      const artifacts = conversationId && conversationId.length <= 256 ? sanitizeConversationArtifacts(raw) : null

      if (artifacts) {
        projected[conversationId] = artifacts
      }
    }

    if (Object.keys(projected).length > 0) {
      accounts[accountId] = projected
    }
  }

  return accounts
}

const $persistedArtifacts = persistentAtom<PersistedArtifacts>(
  'hermes.desktop.atum.dmArtifactRefs.v1',
  {},
  {
    decode: raw => sanitizePersistedArtifacts(JSON.parse(raw)),
    encode: value => JSON.stringify(value)
  }
)

export const $atumDmPreviewByConversation = atom<Record<string, PreviewTarget>>({})
export const $atumDmArtifactByConversation = atom<Record<string, AtumDmArtifactWorkspace>>({})
export const $atumDmAttentionByConversation = computed($atumDmArtifactByConversation, workspaces => {
  const attentionByConversation: Record<string, AtumArtifactAttention> = {}

  for (const [conversationId, workspace] of Object.entries(workspaces)) {
    if (workspace.tabs.some(tab => tab.attention === 'failed')) {
      attentionByConversation[conversationId] = 'failed'
    } else if (workspace.tabs.some(tab => tab.attention === 'complete')) {
      attentionByConversation[conversationId] = 'complete'
    }
  }

  return attentionByConversation
})

let activeAccountId: string | null = null
let accountGeneration = 0
let foregroundConversationId: string | null = null
const requestGenerationByArtifact = new Map<string, number>()

function requestKey(conversationId: string, resourceId: string): string {
  return `${conversationId}\u0000${resourceId}`
}

function dmScopeKey(accountId: string | null, conversationId: string): string {
  return atumDmWorkbenchScopeKey(accountId, conversationId)
}

function artifactTabId(conversationId: string, resourceId: string): string {
  return artifactWorkbenchTabId(dmScopeKey(activeAccountId, conversationId), resourceId)
}

function registerArtifact(accountId: string, conversationId: string, ref: AtumArtifactRef): string {
  const scopeKey = dmScopeKey(accountId, conversationId)
  const id = artifactWorkbenchTabId(scopeKey, ref.resourceId)

  openWorkbenchTab({
    id,
    restore: 'session',
    scopeKey,
    surface: { kind: 'artifact', conversationId, resourceId: ref.resourceId },
    title: ref.title
  })

  return id
}

function activeTab(workspace: AtumDmArtifactWorkspace | null | undefined): AtumDmArtifactTab | null {
  return workspace?.tabs.find(tab => tab.ref.resourceId === workspace.activeResourceId) ?? null
}

function clearTabAttention(tabs: AtumDmArtifactTab[], resourceId: string | null): AtumDmArtifactTab[] {
  return resourceId
    ? tabs.map(tab => (tab.ref.resourceId === resourceId ? { ...tab, attention: null } : tab))
    : tabs
}

function hasReusableTarget(tab: AtumDmArtifactTab): boolean {
  return Boolean(
    tab.state === 'ready' && tab.target && (tab.targetExpiresAt === null || tab.targetExpiresAt > Date.now())
  )
}

function artifactIsVisible(conversationId: string, resourceId: string, workspace: AtumDmArtifactWorkspace): boolean {
  return Boolean(
    foregroundConversationId === conversationId &&
      workspace.activeSurface !== 'launcher' &&
      workspace.activeResourceId === resourceId
  )
}

function terminalAttention(
  conversationId: string,
  resourceId: string,
  workspace: AtumDmArtifactWorkspace,
  attention: AtumArtifactAttention
): AtumArtifactAttention | null {
  if (!artifactIsVisible(conversationId, resourceId, workspace)) {
    return attention
  }

  return workspace.tabs.some(tab => tab.ref.resourceId === resourceId && tab.attention) ? attention : null
}

function persistWorkspace(conversationId: string, workspace: AtumDmArtifactWorkspace | null): void {
  if (!activeAccountId) {
    return
  }

  const account = $persistedArtifacts.get()[activeAccountId] ?? {}

  const nextAccount = workspace
    ? keepNewest(
        {
          ...withoutKey(account, conversationId),
          [conversationId]: {
            activeResourceId: workspace.activeResourceId,
            activeSurface: workspace.activeSurface ?? (workspace.activeResourceId ? 'artifact' : null),
            attention: Object.fromEntries(
              workspace.tabs.flatMap(tab => (tab.attention ? [[tab.ref.resourceId, tab.attention]] : []))
            ),
            closedRefs: workspace.closedRefs,
            launcherIndex: workspace.launcherOpen
              ? Math.max(0, Math.min(workspace.launcherIndex ?? workspace.tabs.length, workspace.tabs.length))
              : null,
            launcherOpen: workspace.launcherOpen === true,
            refs: workspace.tabs.map(tab => tab.ref)
          }
        },
        MAX_PERSISTED_CONVERSATIONS
      )
    : withoutKey(account, conversationId)

  const all = withoutKey($persistedArtifacts.get(), activeAccountId)
  $persistedArtifacts.set(
    keepNewest(
      Object.keys(nextAccount).length > 0 ? { ...all, [activeAccountId]: nextAccount } : all,
      MAX_PERSISTED_ACCOUNTS
    )
  )
}

function projectPersistedWorkspace(value: PersistedConversationArtifacts): AtumDmArtifactWorkspace {
  return {
    activeResourceId: value.activeResourceId,
    activeSurface: value.activeSurface,
    closedRefs: value.closedRefs,
    launcherIndex: value.launcherIndex,
    launcherOpen: value.launcherOpen,
    tabs: value.refs.map(ref => ({
      attention: value.attention[ref.resourceId] ?? null,
      ref,
      state: 'idle',
      target: null,
      targetExpiresAt: null
    }))
  }
}

export function setAtumDmForegroundConversation(conversationId: string | null): void {
  foregroundConversationId = conversationId?.trim() || null
}

export type AtumDmWorkspaceTab = { kind: 'artifact'; resourceId: string } | { kind: 'launcher' }

export function atumDmWorkspaceTabs(workspace: AtumDmArtifactWorkspace | null): AtumDmWorkspaceTab[] {
  if (!workspace) {
    return []
  }

  const tabs: AtumDmWorkspaceTab[] = workspace.tabs.map(tab => ({
    kind: 'artifact',
    resourceId: tab.ref.resourceId
  }))

  if (workspace.launcherOpen) {
    tabs.splice(Math.max(0, Math.min(workspace.launcherIndex ?? tabs.length, tabs.length)), 0, { kind: 'launcher' })
  }

  return tabs
}

export function isAtumDmLauncherActive(workspace: AtumDmArtifactWorkspace | null): boolean {
  return Boolean(workspace?.launcherOpen && workspace.activeSurface === 'launcher')
}

function appendClosedRef(closedRefs: AtumArtifactRef[], ref: AtumArtifactRef): AtumArtifactRef[] {
  return [...closedRefs.filter(candidate => candidate.resourceId !== ref.resourceId), ref].slice(
    -MAX_CLOSED_ARTIFACT_TABS
  )
}

export function setAtumDmWorkspaceAccount(accountId: string | null): void {
  if (activeAccountId === accountId) {
    return
  }

  // Account transitions discard all persisted and pending DM surface
  // registrations. Local Hermes session tabs live outside this prefix.
  closeWorkbenchScopesByPrefix(ATUM_DM_WORKBENCH_SCOPE_PREFIX)

  activeAccountId = accountId
  accountGeneration += 1
  requestGenerationByArtifact.clear()
  $atumDmPreviewByConversation.set({})
  const workspaces = accountId ? ($persistedArtifacts.get()[accountId] ?? {}) : {}

  const projected = Object.fromEntries(
    Object.entries(workspaces).map(([conversationId, artifacts]) => [conversationId, projectPersistedWorkspace(artifacts)])
  )

  $atumDmArtifactByConversation.set(projected)

  if (accountId) {
    for (const [conversationId, workspace] of Object.entries(projected)) {
      for (const tab of workspace.tabs) {
        registerArtifact(accountId, conversationId, tab.ref)
      }
    }
  }
}

export function setAtumDmConversationPreviewTarget(conversationId: string, target: PreviewTarget): void {
  const id = conversationId.trim()

  if (!id) {
    return
  }

  $atumDmPreviewByConversation.set({ ...$atumDmPreviewByConversation.get(), [id]: target })
  const accountId = activeAccountId

  if (accountId) {
    const paneId = openPreviewWorkbenchTab(target, {
      restore: 'session',
      scopeKey: dmScopeKey(accountId, id)
    })

    revealWorkbenchTab(paneId)
  }
}

export function selectAtumDmArtifact(conversationId: string, ref: AtumArtifactRef): void {
  if (!activeAccountId || !conversationId.trim()) {
    return
  }

  const current = $atumDmArtifactByConversation.get()[conversationId]
  const selected: AtumDmArtifactTab = { ref, state: 'idle', target: null, targetExpiresAt: null }
  const existingIndex = current?.tabs.findIndex(tab => tab.ref.resourceId === ref.resourceId) ?? -1
  const currentTabs = current?.tabs ?? []
  const evictedRef = existingIndex < 0 && currentTabs.length >= ATUM_DM_MAX_ARTIFACT_TABS ? currentTabs[0]?.ref : null
  const closedRefs = (current?.closedRefs ?? []).filter(candidate => candidate.resourceId !== ref.resourceId)

  if (evictedRef) {
    const evictedKey = requestKey(conversationId, evictedRef.resourceId)
    requestGenerationByArtifact.set(evictedKey, (requestGenerationByArtifact.get(evictedKey) ?? 0) + 1)
  }

  const tabs =
    current && existingIndex >= 0
      ? current.tabs.map((tab, index) => (index === existingIndex ? selected : tab))
      : [...currentTabs, selected].slice(-ATUM_DM_MAX_ARTIFACT_TABS)

  const launcherIndex = current?.launcherOpen
    ? evictedRef && (current.launcherIndex ?? currentTabs.length) > 0
      ? Math.max(0, (current.launcherIndex ?? currentTabs.length) - 1)
      : current.launcherIndex
    : null

  const workspace: AtumDmArtifactWorkspace = {
    activeResourceId: ref.resourceId,
    activeSurface: 'artifact',
    closedRefs: evictedRef ? appendClosedRef(closedRefs, evictedRef) : closedRefs,
    launcherIndex,
    launcherOpen: current?.launcherOpen,
    tabs
  }

  persistWorkspace(conversationId, workspace)
  $atumDmArtifactByConversation.set({ ...$atumDmArtifactByConversation.get(), [conversationId]: workspace })

  if (evictedRef) {
    closeWorkbenchTab(artifactTabId(conversationId, evictedRef.resourceId))
  }

  revealWorkbenchTab(registerArtifact(activeAccountId, conversationId, ref))
  void resolveAtumDmArtifact(conversationId, ref.resourceId)
}

/**
 * Consume the provider-owned presentation hint for the conversation currently
 * in front of the user. Message reconciliation owns replay detection; this
 * final guard lives beside the presentation authority so a background caller
 * can never open the panel by accident.
 */
export function presentAtumDmArtifactIntent(conversationId: string, ref: AtumArtifactRef): boolean {
  if (foregroundConversationId !== conversationId || ref.presentation?.intent !== 'open') {
    return false
  }

  selectAtumDmArtifact(conversationId, ref)
  setWorkspaceOpen(true)

  return true
}

export function activateAtumDmArtifact(conversationId: string, resourceId: string): void {
  const workspace = $atumDmArtifactByConversation.get()[conversationId]
  const tab = workspace?.tabs.find(candidate => candidate.ref.resourceId === resourceId)

  if (!workspace || !tab) {
    return
  }

  const changesWorkspace =
    workspace.activeResourceId !== resourceId || workspace.activeSurface === 'launcher' || Boolean(tab.attention)

  const next: AtumDmArtifactWorkspace = changesWorkspace
    ? {
        ...workspace,
        activeResourceId: resourceId,
        activeSurface: 'artifact',
        tabs: clearTabAttention(workspace.tabs, resourceId)
      }
    : workspace

  const nextTab = next.tabs.find(candidate => candidate.ref.resourceId === resourceId)!

  if (changesWorkspace) {
    persistWorkspace(conversationId, next)
    $atumDmArtifactByConversation.set({ ...$atumDmArtifactByConversation.get(), [conversationId]: next })
  }

  revealWorkbenchTab(artifactTabId(conversationId, resourceId))

  if (workspace.activeResourceId === resourceId && workspace.activeSurface !== 'launcher') {
    if (nextTab.state === 'ready' && !hasReusableTarget(nextTab)) {
      void resolveAtumDmArtifact(conversationId, resourceId)
    }

    return
  }

  $atumDmPreviewByConversation.set(
    hasReusableTarget(nextTab)
      ? { ...$atumDmPreviewByConversation.get(), [conversationId]: nextTab.target! }
      : withoutKey($atumDmPreviewByConversation.get(), conversationId)
  )

  if (!hasReusableTarget(nextTab)) {
    void resolveAtumDmArtifact(conversationId, resourceId)
  }
}

export function closeAtumDmArtifact(conversationId: string, resourceId: string): string | null {
  const workspace = $atumDmArtifactByConversation.get()[conversationId]

  if (!workspace) {
    return null
  }

  const closedIndex = workspace.tabs.findIndex(tab => tab.ref.resourceId === resourceId)

  if (closedIndex < 0) {
    return null
  }

  const closedKey = requestKey(conversationId, resourceId)
  closeWorkbenchTab(artifactTabId(conversationId, resourceId))
  requestGenerationByArtifact.set(closedKey, (requestGenerationByArtifact.get(closedKey) ?? 0) + 1)
  const closedRef = workspace.tabs[closedIndex]!.ref
  const tabs = workspace.tabs.filter(tab => tab.ref.resourceId !== resourceId)
  const displayedBefore = atumDmWorkspaceTabs(workspace)
  const closedDisplayIndex = displayedBefore.findIndex(tab => tab.kind === 'artifact' && tab.resourceId === resourceId)

  const launcherIndex = workspace.launcherOpen
    ? closedDisplayIndex < (workspace.launcherIndex ?? workspace.tabs.length)
      ? Math.max(0, (workspace.launcherIndex ?? workspace.tabs.length) - 1)
      : workspace.launcherIndex
    : null

  if (tabs.length === 0) {
    const next: AtumDmArtifactWorkspace = {
      activeResourceId: null,
      activeSurface: workspace.launcherOpen ? 'launcher' : null,
      closedRefs: appendClosedRef(workspace.closedRefs, closedRef),
      launcherIndex: workspace.launcherOpen ? 0 : null,
      launcherOpen: workspace.launcherOpen,
      tabs: []
    }

    persistWorkspace(conversationId, next)
    $atumDmArtifactByConversation.set({ ...$atumDmArtifactByConversation.get(), [conversationId]: next })
    $atumDmPreviewByConversation.set(withoutKey($atumDmPreviewByConversation.get(), conversationId))

    return null
  }

  const nextActiveId =
    workspace.activeSurface !== 'launcher' && (workspace.activeResourceId === resourceId || !workspace.activeResourceId)
      ? tabs[Math.min(closedIndex, tabs.length - 1)]!.ref.resourceId
      : workspace.activeResourceId

  const next: AtumDmArtifactWorkspace = {
    activeResourceId: nextActiveId,
    activeSurface: workspace.activeSurface === 'launcher' ? 'launcher' : 'artifact',
    closedRefs: appendClosedRef(workspace.closedRefs, closedRef),
    launcherIndex,
    launcherOpen: workspace.launcherOpen,
    tabs:
      workspace.activeSurface !== 'launcher' && workspace.activeResourceId === resourceId
        ? clearTabAttention(tabs, nextActiveId)
        : tabs
  }

  persistWorkspace(conversationId, next)
  $atumDmArtifactByConversation.set({ ...$atumDmArtifactByConversation.get(), [conversationId]: next })

  if (workspace.activeResourceId === resourceId) {
    const nextTab = activeTab(next)!
    $atumDmPreviewByConversation.set(
      hasReusableTarget(nextTab)
        ? { ...$atumDmPreviewByConversation.get(), [conversationId]: nextTab.target! }
        : withoutKey($atumDmPreviewByConversation.get(), conversationId)
    )

    if (!hasReusableTarget(nextTab)) {
      void resolveAtumDmArtifact(conversationId, nextActiveId!)
    }
  }

  return nextActiveId
}

export function moveAtumDmArtifact(conversationId: string, resourceId: string, toIndex: number): void {
  const workspace = $atumDmArtifactByConversation.get()[conversationId]
  const displayed = atumDmWorkspaceTabs(workspace ?? null)
  const fromIndex = displayed.findIndex(tab => tab.kind === 'artifact' && tab.resourceId === resourceId)

  if (!workspace || fromIndex < 0 || !Number.isFinite(toIndex)) {
    return
  }

  const boundedIndex = Math.max(0, Math.min(Math.trunc(toIndex), displayed.length - 1))

  if (fromIndex === boundedIndex) {
    return
  }

  const [moved] = displayed.splice(fromIndex, 1)
  displayed.splice(boundedIndex, 0, moved!)
  const byId = new Map(workspace.tabs.map(tab => [tab.ref.resourceId, tab]))
  const tabs = displayed.flatMap(tab => (tab.kind === 'artifact' ? [byId.get(tab.resourceId)!] : []))

  const next = {
    ...workspace,
    launcherIndex: workspace.launcherOpen ? displayed.findIndex(tab => tab.kind === 'launcher') : null,
    tabs
  }

  persistWorkspace(conversationId, next)
  $atumDmArtifactByConversation.set({ ...$atumDmArtifactByConversation.get(), [conversationId]: next })
}

export function openAtumDmLauncher(conversationId: string): void {
  if (!activeAccountId || !conversationId.trim()) {
    return
  }

  const current = $atumDmArtifactByConversation.get()[conversationId]

  const next: AtumDmArtifactWorkspace = current
    ? {
        ...current,
        activeResourceId: null,
        activeSurface: 'launcher',
        launcherIndex: current.launcherOpen ? current.launcherIndex : current.tabs.length,
        launcherOpen: true
      }
    : {
        activeResourceId: null,
        activeSurface: 'launcher',
        closedRefs: [],
        launcherIndex: 0,
        launcherOpen: true,
        tabs: []
      }

  persistWorkspace(conversationId, next)
  $atumDmArtifactByConversation.set({ ...$atumDmArtifactByConversation.get(), [conversationId]: next })
  $atumDmPreviewByConversation.set(withoutKey($atumDmPreviewByConversation.get(), conversationId))
}

export function activateAtumDmLauncher(conversationId: string): void {
  const workspace = $atumDmArtifactByConversation.get()[conversationId]

  if (!workspace?.launcherOpen || workspace.activeSurface === 'launcher') {
    return
  }

  const next: AtumDmArtifactWorkspace = { ...workspace, activeResourceId: null, activeSurface: 'launcher' }
  persistWorkspace(conversationId, next)
  $atumDmArtifactByConversation.set({ ...$atumDmArtifactByConversation.get(), [conversationId]: next })
  $atumDmPreviewByConversation.set(withoutKey($atumDmPreviewByConversation.get(), conversationId))
}

export function closeAtumDmLauncher(conversationId: string): string | null {
  const workspace = $atumDmArtifactByConversation.get()[conversationId]

  if (!workspace?.launcherOpen) {
    return null
  }

  const nextActiveId =
    workspace.activeSurface === 'launcher'
      ? (workspace.tabs[Math.min(workspace.launcherIndex ?? workspace.tabs.length, workspace.tabs.length - 1)]?.ref
          .resourceId ?? null)
      : workspace.activeResourceId

  const next: AtumDmArtifactWorkspace = {
    ...workspace,
    activeResourceId: nextActiveId,
    activeSurface: nextActiveId ? 'artifact' : null,
    launcherIndex: null,
    launcherOpen: false,
    tabs:
      workspace.activeSurface === 'launcher' ? clearTabAttention(workspace.tabs, nextActiveId) : workspace.tabs
  }

  persistWorkspace(conversationId, next)
  $atumDmArtifactByConversation.set({ ...$atumDmArtifactByConversation.get(), [conversationId]: next })

  const nextTab = activeTab(next)

  if (nextTab && hasReusableTarget(nextTab)) {
    $atumDmPreviewByConversation.set({ ...$atumDmPreviewByConversation.get(), [conversationId]: nextTab.target! })
  } else {
    $atumDmPreviewByConversation.set(withoutKey($atumDmPreviewByConversation.get(), conversationId))

    if (nextActiveId) {
      void resolveAtumDmArtifact(conversationId, nextActiveId)
    }
  }

  return nextActiveId
}

export function moveAtumDmLauncher(conversationId: string, toIndex: number): void {
  const workspace = $atumDmArtifactByConversation.get()[conversationId]
  const displayed = atumDmWorkspaceTabs(workspace ?? null)
  const fromIndex = displayed.findIndex(tab => tab.kind === 'launcher')

  if (!workspace?.launcherOpen || fromIndex < 0 || !Number.isFinite(toIndex)) {
    return
  }

  const boundedIndex = Math.max(0, Math.min(Math.trunc(toIndex), displayed.length - 1))

  if (fromIndex === boundedIndex) {
    return
  }

  const [moved] = displayed.splice(fromIndex, 1)
  displayed.splice(boundedIndex, 0, moved!)
  const next = { ...workspace, launcherIndex: displayed.findIndex(tab => tab.kind === 'launcher') }
  persistWorkspace(conversationId, next)
  $atumDmArtifactByConversation.set({ ...$atumDmArtifactByConversation.get(), [conversationId]: next })
}

export function reopenLastClosedAtumDmArtifact(conversationId: string): string | null {
  const workspace = $atumDmArtifactByConversation.get()[conversationId]

  if (!activeAccountId || !workspace || workspace.closedRefs.length === 0 || workspace.tabs.length >= ATUM_DM_MAX_ARTIFACT_TABS) {
    return null
  }

  const openIds = new Set(workspace.tabs.map(tab => tab.ref.resourceId))
  const closedRefs = workspace.closedRefs.filter(ref => !openIds.has(ref.resourceId))
  const ref = closedRefs.at(-1)

  if (!ref) {
    const next = { ...workspace, closedRefs: [] }
    persistWorkspace(conversationId, next)
    $atumDmArtifactByConversation.set({ ...$atumDmArtifactByConversation.get(), [conversationId]: next })

    return null
  }

  const reopened: AtumDmArtifactTab = { ref, state: 'idle', target: null, targetExpiresAt: null }

  const next: AtumDmArtifactWorkspace = {
    activeResourceId: ref.resourceId,
    activeSurface: 'artifact',
    closedRefs: closedRefs.slice(0, -1),
    launcherIndex: workspace.launcherIndex,
    launcherOpen: workspace.launcherOpen,
    tabs: [...workspace.tabs, reopened]
  }

  persistWorkspace(conversationId, next)
  $atumDmArtifactByConversation.set({ ...$atumDmArtifactByConversation.get(), [conversationId]: next })
  $atumDmPreviewByConversation.set(withoutKey($atumDmPreviewByConversation.get(), conversationId))
  revealWorkbenchTab(registerArtifact(activeAccountId, conversationId, ref))
  void resolveAtumDmArtifact(conversationId, ref.resourceId)

  return ref.resourceId
}

export async function resolveAtumDmArtifact(conversationId: string, resourceId?: string): Promise<void> {
  const accountId = activeAccountId
  const workspace = $atumDmArtifactByConversation.get()[conversationId]
  const selectedResourceId = resourceId ?? workspace?.activeResourceId
  const current = workspace?.tabs.find(tab => tab.ref.resourceId === selectedResourceId)

  if (!accountId || !workspace || !selectedResourceId || !current || current.state === 'loading') {
    return
  }

  const accountEpoch = accountGeneration
  const key = requestKey(conversationId, selectedResourceId)
  const generation = (requestGenerationByArtifact.get(key) ?? 0) + 1
  requestGenerationByArtifact.set(key, generation)

  const loading: AtumDmArtifactWorkspace = {
    ...workspace,
    tabs: workspace.tabs.map(tab =>
      tab.ref.resourceId === selectedResourceId
        ? { ...tab, state: 'loading', target: null, targetExpiresAt: null }
        : tab
    )
  }

  $atumDmArtifactByConversation.set({ ...$atumDmArtifactByConversation.get(), [conversationId]: loading })

  if (workspace.activeSurface !== 'launcher' && workspace.activeResourceId === selectedResourceId) {
    $atumDmPreviewByConversation.set(withoutKey($atumDmPreviewByConversation.get(), conversationId))
  }

  let result

  try {
    result = await atumMessagingClient().artifact(conversationId, current.ref.resourceId)
  } catch {
    result = { state: 'error' as const, artifact: null }
  }

  const latestWorkspace = $atumDmArtifactByConversation.get()[conversationId]
  const latest = latestWorkspace?.tabs.find(tab => tab.ref.resourceId === selectedResourceId)

  if (
    activeAccountId !== accountId ||
    accountEpoch !== accountGeneration ||
    generation !== requestGenerationByArtifact.get(key) ||
    latest?.ref.resourceId !== current.ref.resourceId ||
    !latestWorkspace
  ) {
    return
  }

  if (result.state !== 'ready') {
    const failed: AtumDmArtifactWorkspace = {
      ...latestWorkspace,
      tabs: latestWorkspace.tabs.map(tab =>
        tab.ref.resourceId === selectedResourceId
          ? {
              ...latest,
              attention: terminalAttention(conversationId, selectedResourceId, latestWorkspace, 'failed'),
              state: result.state,
              target: null,
              targetExpiresAt: null
            }
          : tab
      )
    }

    persistWorkspace(conversationId, failed)
    $atumDmArtifactByConversation.set({ ...$atumDmArtifactByConversation.get(), [conversationId]: failed })

    return
  }

  if (result.artifact.status === 'generating') {
    $atumDmArtifactByConversation.set({
      ...$atumDmArtifactByConversation.get(),
      [conversationId]: {
        ...latestWorkspace,
        tabs: latestWorkspace.tabs.map(tab =>
          tab.ref.resourceId === selectedResourceId
            ? { ...latest, state: 'waiting', target: null, targetExpiresAt: null }
            : tab
        )
      }
    })

    return
  }

  const embedExpiresAt = result.artifact.embed ? Date.parse(result.artifact.embed.expiresAt) : Number.NaN

  const usesEmbed = Boolean(result.artifact.embed && Number.isFinite(embedExpiresAt) && embedExpiresAt > Date.now())
  const url = usesEmbed ? result.artifact.embed!.url : result.artifact.url
  const targetExpiresAt = usesEmbed ? embedExpiresAt : null

  const target: PreviewTarget = {
    kind: 'url',
    label: result.artifact.title,
    partition: `atum-artifact-${accountEpoch}-${generation}-${Date.now()}`,
    source: url,
    url
  }

  const ready: AtumDmArtifactWorkspace = {
    ...latestWorkspace,
    tabs: latestWorkspace.tabs.map(tab =>
      tab.ref.resourceId === selectedResourceId
        ? {
            ...latest,
            attention: terminalAttention(conversationId, selectedResourceId, latestWorkspace, 'complete'),
            state: 'ready',
            target,
            targetExpiresAt
          }
        : tab
    )
  }

  persistWorkspace(conversationId, ready)
  $atumDmArtifactByConversation.set({ ...$atumDmArtifactByConversation.get(), [conversationId]: ready })

  if (ready.activeSurface !== 'launcher' && ready.activeResourceId === selectedResourceId) {
    $atumDmPreviewByConversation.set({ ...$atumDmPreviewByConversation.get(), [conversationId]: target })
  }
}

export function clearAtumDmWorkspace(): void {
  closeWorkbenchScopesByPrefix(ATUM_DM_WORKBENCH_SCOPE_PREFIX)

  activeAccountId = null
  accountGeneration += 1
  requestGenerationByArtifact.clear()
  $atumDmPreviewByConversation.set({})
  $atumDmArtifactByConversation.set({})
}
