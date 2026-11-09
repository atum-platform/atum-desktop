import { atom, computed } from 'nanostores'

import { nativeOfficeBundleForPath, routesToNativeOffice, tryOpenNativeOfficeDocument } from '@/lib/native-office-routing'
import { normalize } from '@/lib/text'
import { tryOpenWordCompanion } from '@/lib/word-companion-routing'

import { $activeSessionId, $selectedStoredSessionId } from './session'
import {
  $workbenchScope,
  ATUM_DM_WORKBENCH_SCOPE_PREFIX,
  clearWorkbenchTabs,
  closePreviewWorkbenchTabs,
  closeWorkbenchTab,
  openPreviewWorkbenchTab,
  previewWorkbenchTabId,
  revealWorkbenchTab,
  SESSION_WORKBENCH_SCOPE
} from './workbench-tabs'
import {
  isWorkspaceTextFileTarget,
  openWorkspaceTextFileTab,
  registerWorkspaceTextFileTarget,
  type WorkspaceTextFileTab
} from './workspace-text-files'

export interface PreviewTarget {
  /** Ephemeral main-owned read capability, never a binary write lease. */
  contextFile?: { token: string; size?: number }
  binary?: boolean
  byteSize?: number
  /** Inline image bytes (a `data:` URL) when the renderer already holds them —
   * e.g. a pasted/dropped screenshot whose only on-disk copy is a transient
   * path the preview can't reliably re-read. Rendered directly and NOT
   * persisted to the session-preview registry (it would bloat localStorage). */
  dataUrl?: string
  kind: 'file' | 'url'
  label: string
  large?: boolean
  language?: string
  mimeType?: string
  path?: string
  /** Ephemeral Electron session partition. Omit for the ordinary persistent
   * preview session; hosted artifacts set a non-persistent value so cookies
   * cannot survive an account boundary or relaunch. */
  partition?: string
  previewKind?: 'binary' | 'docx' | 'html' | 'image' | 'pdf' | 'text' | 'card'
  renderMode?: 'preview' | 'source'
  source: string
  url: string
  /** Opaque main-owned lease descriptor for the pane-native text-file slice.
   * No raw local or remote path is persisted for these targets. */
  workspaceTextFile?: { fileRef: string; displayName: string; workspaceRelativePath?: string }
}

export interface PreviewServerRestart {
  message?: string
  status: 'complete' | 'error' | 'running'
  taskId: string
  url: string
}

export type PreviewRecordSource = 'explicit-link' | 'file-browser' | 'manual' | 'tool-result'

export interface SessionPreviewRecord {
  autoOpen?: boolean
  createdAt: number
  dismissedAt?: number
  id: string
  normalized: PreviewTarget
  sessionId: string
  source: PreviewRecordSource
  target: string
}

type SessionPreviewRegistry = Record<string, SessionPreviewRecord[]>

const LEGACY_REGISTRY_STORAGE_KEY = 'hermes.desktop.sessionPreviews.v1'
// v2 had no account boundary. Its opaque `atum-file:` targets can outlive a
// sign-out in localStorage, so v3 starts clean and is cleared on every Atum
// identity transition by the composition root.
const UNSCOPED_REGISTRY_STORAGE_KEY = 'hermes.desktop.sessionPreviews.v2'
const REGISTRY_STORAGE_KEY = 'hermes.desktop.sessionPreviews.v3'
const MAX_RECORDS_PER_SESSION = 1
const MAX_SESSIONS = 120
const nativeOfficePreviewAttempts = new Set<string>()

export const $previewTarget = atom<PreviewTarget | null>(null)
export const $previewReloadRequest = atom(0)
export const $previewServerRestart = atom<PreviewServerRestart | null>(null)
export const $previewServerRestartStatus = computed($previewServerRestart, restart => restart?.status ?? 'idle')
export const $sessionPreviewRegistry = atom<SessionPreviewRegistry>(loadSessionPreviewRegistry())

$sessionPreviewRegistry.subscribe(persistSessionPreviewRegistry)

// Pre-cutover builds could persist an opaque text target in the nested rail or
// session registry. Transfer those rows synchronously during store hydration so
// React can never mount a rail editor alongside the pane-native editor.
for (const target of Object.values($sessionPreviewRegistry.get()).flatMap(records =>
  records.map(record => record.normalized)
)) {
  transferWorkspaceTextFileTarget(target)
}

function isSamePreviewTarget(a: PreviewTarget | null, b: PreviewTarget | null): boolean {
  if (a === b) {
    return true
  }

  if (!a || !b) {
    return false
  }

  return (
    a.kind === b.kind &&
    a.label === b.label &&
    a.renderMode === b.renderMode &&
    a.source === b.source &&
    a.url === b.url
  )
}

export function setPreviewTarget(target: PreviewTarget | null) {
  if (target && transferWorkspaceTextFileTarget(target)) {
    return
  }

  if (target && routeLocalTextTargetToWorkspacePane(target)) {
    return
  }

  if (isSamePreviewTarget($previewTarget.get(), target)) {
    if (!target || revealWorkbenchTab(previewWorkbenchTabId(target, $workbenchScope.get()))) {
      return
    }
  }

  $previewTarget.set(target)

  if (target) {
    const id = openPreviewWorkbenchTab(target, {
      restore: 'session',
      scopeKey: $workbenchScope.get(),
      title: target.label
    })

    revealWorkbenchTab(id)
  }
}

function routeLocalTextTargetToWorkspacePane(target: PreviewTarget): boolean {
  if (!isLocalTextPreviewTarget(target)) {
    return false
  }

  void openWorkspaceTextFileTab()

  return true
}

function isLocalTextPreviewTarget(target: PreviewTarget): boolean {
  return !(
    target.kind !== 'file' ||
    target.previewKind !== 'text' ||
    target.binary ||
    target.large ||
    !target.url.startsWith('file:')
  )
}

function transferWorkspaceTextFileTarget(target: PreviewTarget): WorkspaceTextFileTab | null {
  if (!isWorkspaceTextFileTarget(target)) {
    return null
  }

  const tab = registerWorkspaceTextFileTarget(target)
  const registry = $sessionPreviewRegistry.get()

  closePreviewWorkbenchTabs(target)

  if ($previewTarget.get()?.url === target.url) {
    $previewTarget.set(null)
  }

  let changed = false
  const next: SessionPreviewRegistry = {}

  for (const [sessionId, records] of Object.entries(registry)) {
    const kept = records.filter(record => record.normalized.url !== target.url)
    changed ||= kept.length !== records.length

    if (kept.length > 0) {
      next[sessionId] = kept
    }
  }

  if (changed) {
    $sessionPreviewRegistry.set(next)
  }

  return tab
}

// Manual/file-browser opens are "peeking at a file" → source view in the file
// pane. Tool/explicit-link opens are runnable artifacts → live preview pane.
function isFilePreviewSource(source: PreviewRecordSource): boolean {
  return source === 'file-browser' || source === 'manual'
}

function previewTargetForSource(target: PreviewTarget, source: PreviewRecordSource): PreviewTarget {
  if (target.kind !== 'file' || target.previewKind !== 'html') {
    return target
  }

  return { ...target, renderMode: isFilePreviewSource(source) ? 'source' : 'preview' }
}

function tryOpenFilePreview(target: PreviewTarget, source: PreviewRecordSource): boolean {
  if (target.kind !== 'file' || !isFilePreviewSource(source)) {
    return false
  }

  const normalized = previewTargetForSource(target, source)

  const id = openPreviewWorkbenchTab(normalized, {
    restore: 'persistent',
    scopeKey: $workbenchScope.get(),
    title: normalized.label
  })

  revealWorkbenchTab(id)

  return true
}

function isPreviewTarget(value: unknown): value is PreviewTarget {
  if (!value || typeof value !== 'object') {
    return false
  }

  const r = value as Record<string, unknown>

  return (
    (r.kind === 'file' || r.kind === 'url') &&
    typeof r.label === 'string' &&
    typeof r.source === 'string' &&
    typeof r.url === 'string'
  )
}

function isPreviewRecord(value: unknown): value is SessionPreviewRecord {
  if (!value || typeof value !== 'object') {
    return false
  }

  const r = value as Record<string, unknown>

  return (
    typeof r.createdAt === 'number' &&
    typeof r.id === 'string' &&
    isPreviewTarget(r.normalized) &&
    typeof r.sessionId === 'string' &&
    ['explicit-link', 'file-browser', 'manual', 'tool-result'].includes(String(r.source)) &&
    typeof r.target === 'string' &&
    (r.dismissedAt === undefined || typeof r.dismissedAt === 'number')
  )
}

function loadSessionPreviewRegistry(): SessionPreviewRegistry {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    // v1 could contain short-lived hosted DM URLs, and v2 had no account key
    // for opaque local file-view targets. Neither can be safely assigned to
    // the current identity, so remove both once rather than restore stale UI.
    purgeLegacySessionPreviewStorage()
    const raw = window.localStorage.getItem(REGISTRY_STORAGE_KEY)

    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as unknown

    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    const out: SessionPreviewRegistry = {}

    for (const [sessionId, records] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(records)) {
        continue
      }

      const valid = records.filter(isPreviewRecord).slice(0, MAX_RECORDS_PER_SESSION)

      if (valid.length > 0) {
        out[sessionId] = valid
      }
    }

    return pruneRegistry(out)
  } catch {
    return {}
  }
}

export function purgeLegacySessionPreviewStorage(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(LEGACY_REGISTRY_STORAGE_KEY)
    window.localStorage.removeItem(UNSCOPED_REGISTRY_STORAGE_KEY)
  }
}

function persistSessionPreviewRegistry(registry: SessionPreviewRegistry) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    // Drop the inline image bytes before persisting — a screenshot data URL is
    // megabytes and would blow the localStorage quota. On reload the record
    // falls back to reading its `path`/`url`.
    const lean = JSON.stringify(pruneRegistry(registry), (key, value) => (key === 'dataUrl' ? undefined : value))
    window.localStorage.setItem(REGISTRY_STORAGE_KEY, lean)
  } catch {
    // Session previews are a desktop convenience; storage failures are nonfatal.
  }
}

function pruneRegistry(registry: SessionPreviewRegistry): SessionPreviewRegistry {
  const entries = Object.entries(registry)
    .map(
      ([sessionId, records]) =>
        [sessionId, [...records].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RECORDS_PER_SESSION)] as const
    )
    .filter(([, records]) => records.length > 0)
    .sort(([, a], [, b]) => (b[0]?.createdAt ?? 0) - (a[0]?.createdAt ?? 0))
    .slice(0, MAX_SESSIONS)

  return Object.fromEntries(entries)
}

function currentPreviewSessionId(): string {
  return $selectedStoredSessionId.get() || $activeSessionId.get() || ''
}

function recordId(sessionId: string, target: PreviewTarget): string {
  return `${sessionId}:${target.url}`
}

export function registerSessionPreview(
  sessionId: string | null | undefined,
  target: PreviewTarget,
  source: PreviewRecordSource,
  rawTarget = target.source
): SessionPreviewRecord | null {
  const id = sessionId?.trim()

  if (!id) {
    return null
  }

  const current = $sessionPreviewRegistry.get()
  const now = Date.now()
  const records = current[id] ?? []
  const existing = records.find(record => record.normalized.url === target.url)
  const normalized = previewTargetForSource(target, source)

  const nextRecord: SessionPreviewRecord = {
    autoOpen: true,
    createdAt: now,
    id: existing?.id || recordId(id, target),
    normalized,
    sessionId: id,
    source,
    target: rawTarget || target.source
  }

  $sessionPreviewRegistry.set(
    pruneRegistry({
      ...current,
      [id]: [nextRecord]
    })
  )

  return nextRecord
}

export function setSessionPreviewTarget(
  sessionId: string | null | undefined,
  target: PreviewTarget,
  source: PreviewRecordSource,
  rawTarget = target.source,
  allowNativeOfficeRoute = true,
  openedWord?: (id: string) => void
): SessionPreviewRecord | null {
  if ((!sessionId || sessionId === currentPreviewSessionId()) && tryOpenWordCompanion(target, openedWord)) {return null}

  if (allowNativeOfficeRoute && queueNativeOfficePreviewOpen(sessionId, target, source, rawTarget)) {return null}

  if (transferWorkspaceTextFileTarget(target)) {
    return null
  }

  if (routeLocalTextTargetToWorkspacePane(target)) {
    return null
  }

  if (tryOpenFilePreview(target, source)) {
    return null
  }

  const record = registerSessionPreview(sessionId, target, source, rawTarget)

  setPreviewTarget(record?.normalized ?? previewTargetForSource(target, source))

  return record
}

/**
 * Preview registration is synchronous, while native inventory is not. Queue
 * only an explicit foreground local-file request; a missing/unusable app comes
 * back through the normal preview path with this route disabled, so it cannot
 * recursively launch or schedule a second native attempt.
 */
function queueNativeOfficePreviewOpen(
  sessionId: string | null | undefined,
  target: PreviewTarget,
  source: PreviewRecordSource,
  rawTarget: string
): boolean {
  const path = target.path ?? target.source
  const currentSession = currentPreviewSessionId()
  const explicit = source === 'file-browser' || source === 'manual'
  const current = !sessionId || sessionId === currentSession

  if (!explicit || !current || target.kind !== 'file' || !target.url.startsWith('file:') || !nativeOfficeBundleForPath(path) ||
    !routesToNativeOffice(path, true)) {
    return false
  }

  const key = [currentSession, source, target.url].join('\0')

  if (nativeOfficePreviewAttempts.has(key)) {return true}
  nativeOfficePreviewAttempts.add(key)
  void tryOpenNativeOfficeDocument(path, true)
    .then(result => {
      if (result === 'unavailable' || result === 'failed') {
        setSessionPreviewTarget(sessionId, target, source, rawTarget, false)
      }
    })
    .finally(() => nativeOfficePreviewAttempts.delete(key))

  return true
}

export function setCurrentSessionPreviewTarget(
  target: PreviewTarget,
  source: PreviewRecordSource,
  rawTarget = target.source,
  openedWord?: (id: string) => void
): SessionPreviewRecord | null {
  return setSessionPreviewTarget(currentPreviewSessionId(), target, source, rawTarget, true, openedWord)
}

export function getSessionPreviewRecord(sessionId: string | null | undefined): SessionPreviewRecord | null {
  const id = sessionId?.trim()

  if (!id) {
    return null
  }

  return $sessionPreviewRegistry.get()[id]?.find(record => !record.dismissedAt && record.autoOpen !== false) ?? null
}

export function dismissSessionPreview(sessionId: string | null | undefined, url?: string) {
  const id = sessionId?.trim()

  if (!id) {
    return
  }

  const current = $sessionPreviewRegistry.get()
  const records = current[id]

  if (!records?.length) {
    return
  }

  const now = Date.now()
  const targetUrl = url || records.find(record => !record.dismissedAt)?.normalized.url

  if (!targetUrl) {
    return
  }

  // The preview rail is a single active file, not a back stack. Dismissing the
  // current preview should leave the rail closed instead of revealing an older
  // record for the same session.
  const dismissedRecords = records.map(record => ({
    ...record,
    autoOpen: false,
    dismissedAt: now
  }))

  $sessionPreviewRegistry.set({
    ...current,
    [id]: dismissedRecords
  })
}

export function dismissPreviewResource(workbenchScopeKey: string, target: PreviewTarget): void {
  if (!workbenchScopeKey.startsWith(ATUM_DM_WORKBENCH_SCOPE_PREFIX)) {
    dismissSessionPreview(currentPreviewSessionId(), target.url)
  }

  closeWorkbenchTab(previewWorkbenchTabId(target, workbenchScopeKey || SESSION_WORKBENCH_SCOPE))

  if ($previewTarget.get()?.url === target.url) {
    $previewTarget.set(null)
  }
}

/** User clicked the close X — clear the target and persist dismissal for the current session. */
export function dismissPreviewTarget() {
  const current = $previewTarget.get()

  if (current?.url) {
    dismissPreviewResource($workbenchScope.get(), current)
  }

  $previewTarget.set(null)
}

export function clearSessionPreviewRegistry() {
  $sessionPreviewRegistry.set({})
  $previewTarget.set(null)
  clearWorkbenchTabs('preview')
}

export function requestPreviewReload() {
  $previewReloadRequest.set($previewReloadRequest.get() + 1)
}

export function beginPreviewServerRestart(taskId: string, url: string) {
  $previewServerRestart.set({ status: 'running', taskId, url })
}

export function completePreviewServerRestart(taskId: string, text: string) {
  const current = $previewServerRestart.get()

  if (current?.taskId !== taskId) {
    return
  }

  $previewServerRestart.set({
    ...current,
    message: text,
    status: normalize(text).startsWith('error:') ? 'error' : 'complete'
  })
}

export function progressPreviewServerRestart(taskId: string, text: string) {
  const current = $previewServerRestart.get()

  if (current?.taskId !== taskId || current.status !== 'running') {
    return
  }

  $previewServerRestart.set({
    ...current,
    message: text
  })
}

export function failPreviewServerRestart(taskId: string, message: string) {
  const current = $previewServerRestart.get()

  if (current?.taskId !== taskId || current.status !== 'running') {
    return
  }

  $previewServerRestart.set({
    ...current,
    message,
    status: 'error'
  })
}
