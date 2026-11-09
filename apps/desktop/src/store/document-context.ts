import { atom, computed } from 'nanostores'

import {
  documentDisplayName,
  documentIdentity,
  type DocumentIdentity,
  fsPathFromSource,
  joinWorkspacePath,
  workspaceRelativePath
} from '@/lib/document-path'

import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from './action-panel-owner'
import { $atumShellEnabled, $railDestination, $workspaceOpen } from './atum-shell'
import { $conversationContextLink, contextLinkForScope, linkedPanelTab } from './conversation-context-links'
import { $nativeDocument, currentNativeDocument } from './native-document'
import type { PreviewTarget } from './preview'
import { $currentCwd } from './session'
import { ownsActionPanel } from './windows'
import { $wordCompanion } from './word-companion'
import { $activeWorkbenchTabId, $visibleWorkbenchTabs, $workbenchScope, resolveCaptureScope, type WorkbenchTabRegistration } from './workbench-tabs'

export type DocumentContextState = 'ready' | 'changed' | 'truncated' | 'unavailable' | 'refused'

export interface DocumentSelection {
  endLine: number
  fingerprint: string
  path: string
  startLine: number
  text: string
  truncated: boolean
}

export interface DocumentContextItem {
  identity: DocumentIdentity
  scopeKey: string
  selection: DocumentSelection | null
  state: DocumentContextState
  /** Lease-backed document inside the chat workspace (Atum Office Phase 0); referenced by workspace-relative path. */
  workspaceDocument: boolean
}

/**
 * The path document-context keys a preview tab by. Lease-backed workspace
 * documents resolve from their workspace-relative path (absolute only once the
 * session cwd is known); other local files from their source path.
 */
export function documentContextPathForTarget(target: PreviewTarget, cwd: null | string | undefined): string | null {
  const relative = target.workspaceTextFile?.workspaceRelativePath

  if (relative) {
    // Stable key regardless of whether the session cwd is known yet.
    void cwd

    return relative
  }

  if (target.workspaceTextFile) {return target.workspaceTextFile.fileRef}

  const source = target.path ?? (target.source ? fsPathFromSource(target.source) : '')

  return source ? documentIdentity(source, cwd).path : null
}

export interface DocumentSelectionInput {
  end: number
  path: string
  start: number
  text: string
}

const MAX_SELECTION_BYTES = 4 * 1024
const suppressed = new Map<string, Set<string>>()
const selections = new Map<string, DocumentSelection>()
const bufferFingerprints = new Map<string, string>()
const scopedItems = new Map<string, DocumentContextItem | null>()
const $revision = atom(0)

function touch() {
  $revision.set($revision.get() + 1)
}

/**
 * Selection, buffer and suppression memory are keyed by the workspace-relative
 * path whenever the file is inside the session workspace, so the key does not
 * drift when a fresh chat learns its cwd after the first send (a lease-backed
 * document is keyed by its relative path from the start).
 */
function keyPath(path: string): string {
  return workspaceRelativePath(path, $currentCwd.get()) ?? documentIdentity(path, null).path
}

function key(scopeKey: string, path: string) {
  return `${scopeKey}\0${keyPath(path)}`
}

function utf8Prefix(text: string, maximum: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text)

  return bytes.byteLength <= maximum ? { text, truncated: false }
    : { text: new TextDecoder().decode(bytes.slice(0, maximum), { stream: true }), truncated: true }
}

export function documentFingerprint(text: string): string {
  let hash = 0x811c9dc5

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return `${text.length.toString(16)}-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function lineAt(text: string, offset: number): number {
  let line = 1

  for (let index = 0; index < Math.min(offset, text.length); index += 1) {
    if (text[index] === '\n') {
      line += 1
    }
  }

  return line
}

export function setDocumentSelection(input: DocumentSelectionInput | null, scopeKey = $workbenchScope.get()): void {

  if (!input || input.start === input.end) {
    const current = scopedItems.get(scopeKey)

    if (current) {
      selections.delete(key(scopeKey, current.identity.path))
    }

    touch()

    return
  }

  const path = keyPath(input.path)
  const from = Math.min(input.start, input.end)
  const to = Math.max(input.start, input.end)
  const selected = input.text.slice(from, to)

  if (!selected) {
    return
  }

  const capped = utf8Prefix(selected, MAX_SELECTION_BYTES)
  selections.set(key(scopeKey, path), {
    endLine: lineAt(input.text, Math.max(from, to - 1)),
    fingerprint: documentFingerprint(input.text),
    path,
    startLine: lineAt(input.text, from),
    text: capped.text,
    truncated: capped.truncated
  })
  bufferFingerprints.set(key(scopeKey, path), documentFingerprint(input.text))
  touch()
}

export function updateDocumentBuffer(path: string, text: string, scopeKey = $workbenchScope.get()): void {
  // Typing publishes only when it invalidates an existing selection. Full
  // buffers stay in the editor and are pulled once when Send is accepted.
  const currentKey = key(scopeKey, path)

  if (!selections.has(currentKey)) {return}
  bufferFingerprints.set(currentKey, documentFingerprint(text))
  touch()
}

export function clearDocumentSelection(scopeKey = $workbenchScope.get(), path?: string): void {
  if (path) {
    selections.delete(key(scopeKey, path))
  } else {
    const prefix = `${scopeKey}\0`

    for (const selectionKey of selections.keys()) {
      if (selectionKey.startsWith(prefix)) {
        selections.delete(selectionKey)
      }
    }
  }

  touch()
}

export function suppressDocumentContext(scopeKey: string, path: string): void {
  const canonical = keyPath(path)
  const paths = suppressed.get(scopeKey) ?? new Set<string>()
  paths.add(canonical)
  suppressed.set(scopeKey, paths)
  touch()
}

export function restoreDocumentContext(scopeKey: string, path: string): void {
  suppressed.get(scopeKey)?.delete(keyPath(path))
  touch()
}

function deriveForeground(): DocumentContextItem | null {
  if (!ownsActionPanel()) {return null}
  const scopeKey = $workbenchScope.get()
  const link = contextLinkForScope(scopeKey)

  if ($atumShellEnabled.get() && link.mode === 'removed') {return null}

  if ($atumShellEnabled.get() && link.mode === 'linked' && link.target) {
    if (link.target.kind === 'panel') {
      const tab = linkedPanelTab(link.target, scopeKey)

      if (tab) {return documentContextForPanel(tab, scopeKey, true)}
    }

    return {
      identity: { ...documentIdentity(link.target.path, $currentCwd.get()), name: link.target.name },
      scopeKey, selection: null, state: link.state, workspaceDocument: false
    }
  }

  const companion = $wordCompanion.get()
  const nativeDocument = currentNativeDocument(scopeKey)
  const owner = $actionPanelOwner.get()

  // An external Word companion remains the foreground document while the
  // workspace is collapsed. Its bytes are captured through native Word-aware
  // IPC, never through a retained preview reader or an old editor selection.
  if ($atumShellEnabled.get() && companion && owner && companion.ownerKey === panelOwnerKey(owner) && companion.epoch === $actionPanelEpoch.get() &&
    resolveCaptureScope(companion.scopeKey) === resolveCaptureScope(scopeKey)) {
    const identity = documentIdentity(companion.descriptor.path, $currentCwd.get())

    if (suppressed.get(scopeKey)?.has(keyPath(identity.path))) {return null}

    return {
      identity: { ...identity, name: companion.descriptor.name },
      scopeKey,
      selection: null,
      state: 'ready',
      workspaceDocument: false
    }
  }

  // Excel/PowerPoint expose only their last saved file. The card grant is the
  // authority for bytes at Send; this identity branch exists before hidden
  // preview handling so an external native document never falls through to an
  // unrelated retained tab.
  if ($atumShellEnabled.get() && nativeDocument) {
    const identity = documentIdentity(nativeDocument.canonicalPath, $currentCwd.get())

    if (suppressed.get(scopeKey)?.has(keyPath(identity.path))) {return null}

    return {
      identity: { ...identity, name: nativeDocument.displayName },
      scopeKey,
      selection: null,
      state: nativeDocument.captureError ? 'unavailable' : 'ready',
      workspaceDocument: false
    }
  }

  // Retained tabs keep edits alive, but hidden surfaces do not grant new context.
  if ($atumShellEnabled.get() && (!$workspaceOpen.get() || $railDestination.get() === 'discover')) {return null}
  const activeId = $activeWorkbenchTabId.get()
  const tab = $visibleWorkbenchTabs.get().find(candidate => candidate.id === activeId)

  if (!tab || tab.surface.kind !== 'preview') {
    return null
  }

  return documentContextForPanel(tab, scopeKey)
}

/** Exact retained surface, shared by manual selection and queued recovery. */
export function documentContextForPanel(tab: WorkbenchTabRegistration, scopeKey: string, explicit = false): DocumentContextItem | null {
  if (tab.surface.kind !== 'preview' || resolveCaptureScope(tab.scopeKey) !== resolveCaptureScope(scopeKey)) {return null}
  const target = tab.surface.target
  const cwd = $currentCwd.get()
  const relative = target.workspaceTextFile?.workspaceRelativePath
  const path = documentContextPathForTarget(target, cwd)

  if (!path || target.kind !== 'file' || (!explicit && suppressed.get(scopeKey)?.has(keyPath(path)))) {
    return null
  }

  const identity: DocumentIdentity = relative
    ? {
        inWorkspace: true,
        name: documentDisplayName(relative),
        path: cwd ? joinWorkspacePath(cwd, relative) : relative,
        relativePath: relative
      }
    : target.workspaceTextFile ? {
        inWorkspace: false, name: target.workspaceTextFile.displayName, path, relativePath: null
      } : documentIdentity(path, cwd)

  const selection = selections.get(key(scopeKey, path)) ?? null
  const currentFingerprint = bufferFingerprints.get(key(scopeKey, path))

  const state: DocumentContextState = !identity.inWorkspace && !target.contextFile && !target.workspaceTextFile && !(target.previewKind === 'image' && target.dataUrl)
    ? 'unavailable'
    : selection && currentFingerprint && currentFingerprint !== selection.fingerprint
      ? 'changed'
      : selection?.truncated
        ? 'truncated'
        : 'ready'

  return { identity, scopeKey, selection, state, workspaceDocument: Boolean(relative) }
}

export const $documentContext = computed(
  [$conversationContextLink, $workbenchScope, $activeWorkbenchTabId, $visibleWorkbenchTabs, $currentCwd, $revision, $atumShellEnabled, $workspaceOpen, $railDestination, $wordCompanion, $nativeDocument, $actionPanelOwner, $actionPanelEpoch],
  () => {
    const item = deriveForeground()
    scopedItems.set($workbenchScope.get(), item)

    return item
  }
)

export function documentContextForScope(scopeKey: string): DocumentContextItem | null {
  if (scopeKey === $workbenchScope.get()) {
    return $documentContext.get()
  }

  return scopedItems.get(scopeKey) ?? null
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...Array.from(text.matchAll(/`+/gu), match => match[0].length))
}

export function documentContextBlocks(item: DocumentContextItem | null): string[] {
  const selection = item?.selection

  if (!item || !selection || !item.identity.relativePath || item.state === 'unavailable' || item.state === 'refused') {
    return []
  }

  const text = selection.text.replace(/\r\n?/gu, '\n')
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1))
  const truncated = selection.truncated ? ' truncated' : ''

  return [
    `${fence}document path=${JSON.stringify(item.identity.relativePath)} lines=${selection.startLine}-${selection.endLine} fingerprint=${selection.fingerprint}${truncated}\n${text}\n${fence}`
  ]
}

export function clearDocumentContext(): void {
  suppressed.clear()
  selections.clear()
  bufferFingerprints.clear()
  scopedItems.clear()
  touch()
}

export const resetDocumentContextForTests = clearDocumentContext
