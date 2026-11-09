import { translateNow } from '@/i18n/runtime'

import type { WordCompanionBridge } from '../../shared/word-companion'

import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from './action-panel-owner'
import { captureLinkedSavedFile } from './context-link-actions'
import { contextLinkForScope, type ContextLinkTarget, linkedPanelTab } from './conversation-context-links'
import { documentContextForPanel, documentContextForScope, type DocumentContextItem, documentFingerprint } from './document-context'
import { captureNativeDocument, currentNativeDocument } from './native-document'
import { ownsActionPanel } from './windows'
import { $wordCompanion, type WordCompanionPair } from './word-companion'
import { $activeWorkbenchTabId, $visibleWorkbenchTabs, $workbenchScope, resolveCaptureScope, type WorkbenchTabRegistration } from './workbench-tabs'

export interface SurfacePayload {
  version: 1
  capture_id: string
  backend_id: string
  agent_id: string
  conversation_id: string
  kind: 'text' | 'image' | 'file'
  label: string
  text?: string
  image_data_url?: string
  file_data_url?: string
  resource_path?: string
  source_revision?: string
  provenance: 'unsaved-buffer' | 'saved-file' | 'visible-surface' | 'metadata-only'
  truncated: boolean
  selection?: { start_line: number; end_line: number }
}
/** Renderer-only intent. Persist only target metadata, never binding IDs or bytes. */
export interface SurfaceCaptureIntent {
  mode: 'automatic' | 'linked' | 'removed'
  revision: string
  target?: ContextLinkTarget
  wordBindingId?: string
}
export interface FrozenSurfaceCapture {
  intent?: SurfaceCaptureIntent
  ownerKey: string
  epoch: number
  scopeKey: string
  payload: Omit<SurfacePayload, 'conversation_id'>
}
export interface SurfaceReaderValue {
  excerpt?: string
  text?: string
  imageDataUrl?: string
  dirty?: boolean
  truncated?: boolean
  revision?: string
}
const readers = new Map<string, () => SurfaceReaderValue | null>()
const readerKey = (scope: string, path: string) => `${scope}\0${path}`

function wordBridge(): WordCompanionBridge | undefined {
  return window.hermesDesktop?.wordCompanion
}

function companionMatches(
  pair: WordCompanionPair | null,
  item: DocumentContextItem,
  scopeKey: string,
  ownerKey: string,
  epoch: number
): pair is WordCompanionPair {
  return Boolean(pair && pair.descriptor.path === item.identity.path && pair.ownerKey === ownerKey && pair.epoch === epoch &&
    resolveCaptureScope(pair.scopeKey) === resolveCaptureScope(scopeKey))
}

export function registerSurfaceReader(scope: string, path: string, read: () => SurfaceReaderValue | null): () => void {
  const key = readerKey(scope, path)
  readers.set(key, read)

  return () => {if (readers.get(key) === read) {readers.delete(key)}}
}

export function utf8CapturePrefix(value: string, max = 32768): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value)

  if (bytes.length <= max) {return { text: value, truncated: false }}

  // stream:true drops an incomplete UTF-8 suffix instead of inserting U+FFFD.
  return { text: new TextDecoder().decode(bytes.slice(0, max), { stream: true }), truncated: true }
}

function panelTarget(tab: WorkbenchTabRegistration | undefined, item: DocumentContextItem | null): ContextLinkTarget | undefined {
  return tab && item && tab.surface.kind === 'preview'
    ? { kind: 'panel', viewKey: tab.viewKey ?? tab.id, path: item.identity.path, name: item.identity.name } : undefined
}

/** Synchronous source resolution shared by capture, queue and turn authorization. */
function resolvePrimaryTarget(scopeKey: string, expected?: SurfaceCaptureIntent) {
  const link = contextLinkForScope(scopeKey)
  let item = documentContextForScope(scopeKey)

  let sourceTab = link.mode === 'linked' && link.target?.kind === 'panel' ? linkedPanelTab(link.target, scopeKey)
    : $visibleWorkbenchTabs.get().find(tab => tab.id === $activeWorkbenchTabId.get())

  const owner = $actionPanelOwner.get()
  const epoch = $actionPanelEpoch.get()
  const automaticPair = $wordCompanion.get()
  const nativeDocument = link.mode === 'automatic' ? currentNativeDocument(scopeKey) : null
  const manualWord = link.mode === 'linked' && link.target?.kind === 'word' ? link.binding?.word : undefined

  const automaticWord = item && owner && link.mode === 'automatic' && companionMatches(automaticPair, item, scopeKey, panelOwnerKey(owner), epoch)
    ? automaticPair.descriptor : undefined

  const word = manualWord ?? automaticWord

  const target = link.mode === 'linked' ? link.target : word
    ? { kind: 'word' as const, path: word.path, name: word.name } : nativeDocument && item
      ? { kind: 'saved-file' as const, path: nativeDocument.canonicalPath, name: nativeDocument.displayName,
          office: /\.pptx?$/iu.test(nativeDocument.canonicalPath) ? 'powerpoint' as const : 'excel' as const }
      : panelTarget(sourceTab, item)

  const intent: SurfaceCaptureIntent = { mode: link.mode, revision: link.revision, target, ...(word ? { wordBindingId: word.id } : {}) }

  if (expected) {
    // A restored queue may read its retained panel A while B is selected, but
    // must never substitute B's bytes or acquire B's native authority.
    if (expected.target?.kind === 'panel') {
      sourceTab = linkedPanelTab(expected.target, scopeKey)
      item = sourceTab ? documentContextForPanel(sourceTab, scopeKey, true) : null

      if (!item) {throw new Error(translateNow('composer.contextUnavailable'))}

      return { owner, epoch, item, sourceTab, link, nativeDocument: null, word: undefined,
        intent: { ...expected, wordBindingId: undefined } }
    }

    if (expected.mode === 'removed') {return { owner, epoch, item: null, sourceTab: undefined, link, nativeDocument: null, word: undefined, intent: expected }}

    if (JSON.stringify(expected.target ?? null) !== JSON.stringify(intent.target ?? null) ||
      (expected.mode === 'linked' && (intent.mode !== 'linked' || expected.revision !== intent.revision)) ||
      (expected.wordBindingId && expected.wordBindingId !== word?.id)) {
      throw new Error(translateNow('composer.contextOwnerChanged'))
    }
  }

  return { owner, epoch, item, sourceTab, link, nativeDocument, word, intent }
}

export function captureIntentForScope(scopeKey = $workbenchScope.get()): SurfaceCaptureIntent {
  if (!ownsActionPanel() || scopeKey.startsWith('atum-dm:')) {return { mode: 'removed', revision: 'unsupported' }}

  return resolvePrimaryTarget(scopeKey).intent
}

/** Reads the resolved source once, before any session creation or native await. */
export async function freezeSurfaceCapture(scopeKey = $workbenchScope.get(), expectedIntent?: SurfaceCaptureIntent): Promise<FrozenSurfaceCapture | null> {
  if (!ownsActionPanel() || scopeKey.startsWith('atum-dm:')) {return null}
  const resolved = resolvePrimaryTarget(scopeKey, expectedIntent)
  const { owner, epoch, item, sourceTab, word, nativeDocument, link, intent } = resolved

  if (!item) {
    if (intent.mode === 'linked') {throw new Error(translateNow('composer.contextUnavailable'))}

    return null
  }

  if (!owner || item.state === 'refused') {
    if (intent.mode === 'linked') {throw new Error(translateNow('composer.contextUnavailable'))}

    return null
  }

  const ownerKey = panelOwnerKey(owner)

  const current = () => epoch === $actionPanelEpoch.get() && ownerKey === panelOwnerKey() &&
    owner.profile === $actionPanelOwner.get()?.profile && resolveCaptureScope(scopeKey) === resolveCaptureScope($workbenchScope.get())

  if (!current()) {throw new Error(translateNow('composer.contextOwnerChanged'))}
  const frozen = (payload: FrozenSurfaceCapture['payload']): FrozenSurfaceCapture => ({ ownerKey, epoch, scopeKey, intent, payload })
  const base = { version: 1 as const, capture_id: crypto.randomUUID(), backend_id: owner.backend_id, agent_id: owner.agent_id }

  if (word) {
    const candidate = wordBridge()

    if (!candidate || item.state === 'unavailable') {throw new Error(translateNow('composer.contextUnavailable'))}
    let snapshot: Awaited<ReturnType<WordCompanionBridge['capture']>>

    try {snapshot = await candidate.capture(word.id)} catch {throw new Error(translateNow('composer.contextUnavailable'))}
    const latest = resolvePrimaryTarget(scopeKey)

    if (!current() || latest.word?.id !== word.id || latest.intent.revision !== intent.revision) {
      throw new Error(translateNow('composer.contextOwnerChanged'))
    }

    const selected = snapshot.selection
    const excerpt = utf8CapturePrefix(selected?.text ?? snapshot.text, selected ? 4096 : 32768)
    const startLine = selected ? snapshot.text.slice(0, selected.start).split(/\r\n|\r|\n/u).length : 1

    return frozen({ ...base, kind: 'text', label: `${word.name} (live Word main text)`,
      source_revision: snapshot.revision, provenance: 'unsaved-buffer', text: excerpt.text, truncated: excerpt.truncated,
      ...(selected ? { selection: { start_line: startLine, end_line: startLine + excerpt.text.split(/\r\n|\r|\n/u).length - 1 } } : {}) })
  }

  if (intent.mode === 'linked' && intent.target?.kind === 'saved-file' && link.target?.kind === 'saved-file') {
    if (!link.binding || link.state === 'unavailable') {throw new Error(translateNow('composer.contextUnavailable'))}
    let bytes: { dataUrl: string; revision: string } | null

    try {bytes = await captureLinkedSavedFile(link.binding, link.target)} catch (error) {
      throw Object.assign(new Error(translateNow('composer.contextUnavailable')), { detail: error instanceof Error ? error.message : undefined })
    }

    if (!bytes || !current() || contextLinkForScope(scopeKey).revision !== intent.revision) {throw new Error(translateNow('composer.contextOwnerChanged'))}

    return frozen({ ...base, kind: 'file', label: item.identity.name, file_data_url: bytes.dataUrl,
      source_revision: bytes.revision, provenance: 'saved-file', truncated: false })
  }

  if (nativeDocument) {
    if (item.state === 'unavailable') {throw Object.assign(new Error(translateNow('composer.contextUnavailable')), { detail: nativeDocument.captureError })}
    let bytes: Awaited<ReturnType<typeof captureNativeDocument>>

    try {bytes = await captureNativeDocument(scopeKey)} catch (error) {
      throw Object.assign(new Error(translateNow('composer.contextUnavailable')), { detail: error instanceof Error ? error.message : undefined })
    }

    const latest = currentNativeDocument(scopeKey)

    if (!bytes || !current() || latest?.pairingId !== nativeDocument.pairingId || latest.canonicalPath !== nativeDocument.canonicalPath ||
      contextLinkForScope(scopeKey).mode !== 'automatic') {throw new Error(translateNow('composer.contextOwnerChanged'))}

    return frozen({ ...base, kind: 'file', label: nativeDocument.displayName, file_data_url: bytes.dataUrl,
      source_revision: bytes.revision, provenance: 'saved-file', truncated: false })
  }

  if (item.state === 'unavailable') {
    if (intent.mode === 'linked' || expectedIntent) {throw new Error(translateNow('composer.contextUnavailable'))}

    return null
  }

  const path = item.identity.relativePath ?? item.identity.path

  // Scope aliases retain the mounted reader across draft adoption.
  const read = readers.get(readerKey(scopeKey, path)) ?? readers.get(readerKey(scopeKey, item.identity.path)) ??
    [...readers.entries()].find(([key]) => {
      const boundary = key.indexOf('\0')

      return resolveCaptureScope(key.slice(0, boundary)) === resolveCaptureScope(scopeKey) &&
        [path, item.identity.path].includes(key.slice(boundary + 1))
    })?.[1]

  const value = read?.()
  const target = sourceTab?.surface.kind === 'preview' ? sourceTab.surface.target : undefined
  const file = target?.contextFile
  const selected = item.selection

  if (selected && value?.text !== undefined && documentFingerprint(value.text) !== selected.fingerprint) {
    throw new Error(translateNow('composer.contextSelectionChanged'))
  }

  const text = selected ? { text: selected.text, truncated: selected.truncated } : value?.text !== undefined ? utf8CapturePrefix(value.excerpt || value.text) : null
  const image = value?.imageDataUrl

  const payload: FrozenSurfaceCapture['payload'] = {
    ...base, kind: image ? 'image' : text ? 'text' : 'file', label: item.identity.name,
    ...(text ? { text: text.text } : {}), ...(image ? { image_data_url: image } : {}),
    ...(item.identity.relativePath ? { resource_path: item.identity.relativePath } : {}),
    ...(selected ? { selection: { start_line: selected.startLine, end_line: selected.endLine } } : {}),
    ...(value?.revision ? { source_revision: value.revision } : {}),
    provenance: value?.dirty ? 'unsaved-buffer' : text ? 'saved-file' : image ? 'visible-surface' : 'metadata-only',
    truncated: Boolean(text?.truncated || value?.truncated || (!selected && value?.excerpt !== undefined && value.excerpt !== value.text))
  }

  if (!value && target && (target.workspaceTextFile || ['text', 'image'].includes(target.previewKind ?? ''))) {
    throw new Error(translateNow('composer.contextLoading'))
  }

  if (file) {
    const bytes = await window.hermesDesktop?.consumerFiles?.capture(file.token).catch(() => {throw new Error(translateNow('composer.contextUnavailable'))})

    if (!bytes) {throw new Error(translateNow('composer.contextUnavailable'))}
    payload.file_data_url = bytes.dataUrl
    payload.source_revision = bytes.revision
    delete payload.resource_path
  }

  if (intent.mode === 'linked' && !value && !file && !item.identity.relativePath) {throw new Error(translateNow('composer.contextUnavailable'))}

  if (!current()) {throw new Error(translateNow('composer.contextOwnerChanged'))}

  if (intent.target?.kind === 'panel' && !linkedPanelTab(intent.target, scopeKey)) {throw new Error(translateNow('composer.contextUnavailable'))}

  return frozen(payload)
}

/** Prepare the already-loaded image; no second read of the live file. */
export async function prepareSurfaceImage(dataUrl: string): Promise<string> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const ratio = Math.min(1, 1600 / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.width * ratio))
  canvas.height = Math.max(1, Math.round(img.height * ratio))
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  const png = canvas.toDataURL('image/png')
  const result = png.length <= 2 * 1024 * 1024 ? png : canvas.toDataURL('image/jpeg', 0.82)

  if (result.length > 2 * 1024 * 1024) {throw new Error(translateNow('composer.contextUnavailable'))}

  return result
}
