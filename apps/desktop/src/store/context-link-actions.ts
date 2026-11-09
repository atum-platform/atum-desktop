import type { AtumConsumerFileOpenResult } from '@/global'
import { documentDisplayName, normalizeFsPath } from '@/lib/document-path'

import { type NativeAppEntry, OFFICE_APPS, type OfficeAppKind } from '../../shared/skills-launcher'
import type { WordCompanionDescriptor } from '../../shared/word-companion'

import { $actionPanelEpoch, $actionPanelOwner } from './action-panel-owner'
import { $atumShellEnabled, $workspaceOpen } from './atum-shell'
import {
  $contextLinkBinding,
  $contextLinkError,
  $contextLinkOperationEpoch,
  $contextLinkPending,
  $contextPickerOpen,
  $otherAppsLinkIntent,
  canLinkConversation,
  clearOtherAppsLinkIntent,
  type ContextLinkBinding,
  contextLinkFenceCurrent,
  contextLinkForScope,
  contextLinkOwnerFence,
  type ContextLinkTarget,
  disposeContextLinkBinding,
  invalidateContextLinkOperations,
  linkedPanelTab,
  openOtherAppsLinkIntent,
  publishContextLinkBinding,
  releaseContextLinkBinding,
  replaceContextLinkBinding,
  setContextLinkIntent,
  setContextLinkNotice
} from './conversation-context-links'
import { documentContextPathForTarget } from './document-context'
import { launchNativeApp } from './native-apps'
import { $currentCwd } from './session'
import { $wordCompanion } from './word-companion'
import { $workbenchScope, $workbenchTabs, ATUM_CHAT_WORKBENCH_SCOPE_PREFIX, openWorkbenchSingleton, resolveCaptureScope, revealWorkbenchTab, type WorkbenchTabRegistration } from './workbench-tabs'

export interface LinkPresentationOptions {
  /** Explicit links present beside chat by default. `false` only changes authority. */
  show?: boolean
  /** Internal reconnect path: a durable target keeps its queued-turn identity. */
  revision?: string
}

export interface LinkSavedDocumentInput {
  appId?: string
  name?: string
  office: OfficeAppKind
  path: string
}

export interface LinkWordDocumentInput {
  candidateId?: string
  name?: string
  path?: string
}

export interface LinkedSavedFileCapture {
  dataUrl: string
  revision: string
}

function errorCode(error: unknown, fallback: string): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined

  if (typeof code === 'string' && code) {return code}
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''

  return message.match(/\b(?:CONSUMER_FILES|CONTEXT_LINK|WORD|NATIVE_DOCUMENT)_[A-Z_]+\b/u)?.[0] ?? fallback
}

function captureNeedsRefresh(error: unknown): boolean {
  return new Set(['CONSUMER_FILES_MISSING', 'CONSUMER_FILES_CAPTURE_CHANGED', 'CONSUMER_FILES_CAPTURE_LIMIT_OR_CHANGED']).has(errorCode(error, ''))
}

function newRevision(): string {
  return crypto.randomUUID()
}

function pathTarget(path: string, name?: string): { name: string; path: string } | null {
  const normalized = normalizeFsPath(path)

  if (!normalized.startsWith('/') || normalized.length > 4096) {return null}
  const label = (name?.trim() || documentDisplayName(normalized)).slice(0, 512)

  return label ? { name: label, path: normalized } : null
}

function panelPathTarget(path: string, name?: string): { name: string; path: string } | null {
  const canonical = path.trim()
  const label = (name?.trim() || documentDisplayName(canonical)).slice(0, 512)

  return canonical && canonical.length <= 4096 && label ? { name: label, path: canonical } : null
}

function activeFence() {
  return contextLinkOwnerFence()
}

function bindingFor(fence: NonNullable<ReturnType<typeof activeFence>>, revision: string, values: Pick<ContextLinkBinding, 'fileToken' | 'word'>): ContextLinkBinding {
  return { ...fence, ...values, revision }
}

function sameLinkedBinding(binding: ContextLinkBinding, target: ContextLinkTarget): boolean {
  const current = contextLinkForScope()

  return current.mode === 'linked' && current.target?.kind === target.kind && current.target.path === target.path &&
    current.binding === binding && current.state === 'ready'
}

function releaseProvisional(binding: ContextLinkBinding | null): void {
  disposeContextLinkBinding(binding)
}

function operationCurrent(operation: number, fence: NonNullable<ReturnType<typeof activeFence>>): boolean {
  return operation === $contextLinkOperationEpoch.get() && contextLinkFenceCurrent(fence)
}

/** A failed persisted replacement must restore Word's one native binding. */
async function restorePreviousWordBinding(previous: ContextLinkBinding | null): Promise<void> {
  const current = $contextLinkBinding.get()

  if (!previous?.word || !current || current.revision !== previous.revision || !contextLinkFenceCurrent(previous)) {return}
  const bridge = wordBridge()

  if (!bridge) {return}

  try {
    const word = await bridge.bind!({ path: previous.word.path, requestId: newRevision() })

    if (!replaceContextLinkBinding(current, { ...previous, error: undefined, word })) {
      disposeContextLinkBinding({ ...previous, word })
    }
  } catch {
    // Keep the old persisted selection visible as unavailable; never replace
    // it with whichever document happens to be foreground now.
    replaceContextLinkBinding(current, { ...previous, error: 'WORD_DOCUMENT_UNAVAILABLE' })
  }
}

/** Opens the compose picker only in the owning main assistant conversation. */
export function openContextPicker(): boolean {
  if (!canLinkConversation()) {return false}
  $contextLinkError.set(null)
  $contextPickerOpen.set(true)

  return true
}

export function closeContextPicker(): void {
  invalidateContextLinkOperations()
  $contextPickerOpen.set(false)
}

/**
 * Commits the durable selection after a native/file authorization succeeded.
 * The previous selection is retained through the whole asynchronous operation.
 */
function commitLinkedTarget(target: ContextLinkTarget, fence: NonNullable<ReturnType<typeof activeFence>>, provisional: ContextLinkBinding): boolean {
  if (!contextLinkFenceCurrent(fence)) {return false}
  const previous = $contextLinkBinding.get()
  const previousIntent = contextLinkForScope(fence.scopeKey)

  try {
    setContextLinkIntent({ mode: 'linked', revision: provisional.revision, target }, fence.scopeKey)
  } catch (error) {
    setContextLinkNotice(errorCode(error, 'CONTEXT_LINK_PERSISTENCE_FAILED'))

    return false
  }

  if (!publishContextLinkBinding(provisional)) {
    // The synchronous local-storage write cannot itself yield, but retaining
    // this rollback protects future persistence implementations too.
    try {
      if (previousIntent.mode !== 'linked' || previousIntent.revision !== provisional.revision) {
        setContextLinkIntent(previousIntent.mode === 'automatic' ? null : {
          mode: previousIntent.mode,
          revision: previousIntent.revision,
          target: previousIntent.target
        }, fence.scopeKey)
      }
    } catch {/* old intent is still safest native state */}

    return false
  }

  if (previous && previous !== provisional) {disposeContextLinkBinding(previous)}
  $contextLinkError.set(null)

  return true
}

async function withPending<T>(work: (operation: number) => Promise<T>): Promise<T> {
  if ($contextLinkPending.get()) {throw new Error('CONTEXT_LINK_BUSY')}
  const operation = $contextLinkOperationEpoch.get() + 1
  $contextLinkOperationEpoch.set(operation)
  $contextLinkPending.set(true)
  $contextLinkError.set(null)

  try {return await work(operation)} finally {$contextLinkPending.set(false)}
}

/** Link a supported panel document by its stable tab/view identity. */
export async function linkPanelDocument(tab: WorkbenchTabRegistration, options: LinkPresentationOptions = {}): Promise<boolean> {
  return withPending(async operation => {
    const fence = activeFence()
    const preview = tab.surface.kind === 'preview' ? tab.surface.target : null
    const source = preview ? documentContextPathForTarget(preview, $currentCwd.get()) : null
    const normalized = source ? panelPathTarget(source, preview?.label ?? tab.title) : null

    const registered = $workbenchTabs.get().find(item => item.id === tab.id && item.surface.kind === 'preview' &&
      (item.viewKey ?? item.id) === (tab.viewKey ?? tab.id) && resolveCaptureScope(item.scopeKey) === resolveCaptureScope(fence?.scopeKey ?? ''))

    if (!fence || !preview || !normalized || !registered || !operationCurrent(operation, fence)) {
      setContextLinkNotice('CONTEXT_LINK_INVALID_TARGET')

      return false
    }

    const target: ContextLinkTarget = { kind: 'panel', ...normalized, viewKey: tab.viewKey ?? tab.id }
    const provisional = bindingFor(fence, options.revision ?? newRevision(), {})

    if (!commitLinkedTarget(target, fence, provisional)) {return false}

    if (options.show !== false && operationCurrent(operation, fence) && !revealWorkbenchTab(tab.id)) {setContextLinkNotice('CONTEXT_LINK_SHOW_FAILED')}

    if (operationCurrent(operation, fence)) {$contextPickerOpen.set(false)}

    return true
  }).catch(error => {
    setContextLinkNotice(errorCode(error, 'CONTEXT_LINK_FAILED'))

    return false
  })
}

function wordBridge() {
  const bridge = window.hermesDesktop?.wordCompanion

  return bridge?.linkingVersion === 1 && bridge.bind && bridge.unbind ? bridge : undefined
}

/** The layout descriptor is distinct from the persisted manual binding id. */
async function showWordBeside(binding: ContextLinkBinding, fence: NonNullable<ReturnType<typeof activeFence>>, operation?: number): Promise<boolean> {
  const bridge = wordBridge()

  if (!bridge?.showBeside || !binding.word) {
    setContextLinkNotice('CONTEXT_LINK_SHOW_FAILED:WORD_UNAVAILABLE')

    return false
  }

  let descriptor: WordCompanionDescriptor

  try {descriptor = await bridge.showBeside(binding.word.id)} catch (error) {
    setContextLinkNotice(`CONTEXT_LINK_SHOW_FAILED:${errorCode(error, 'UNAVAILABLE')}`)

    return false
  }

  const current = operation === undefined ? contextLinkFenceCurrent(fence) : operationCurrent(operation, fence)
  const link = contextLinkForScope(fence.scopeKey)

  if (!current || link.binding !== binding || link.target?.kind !== 'word' || link.binding.word?.id !== binding.word.id) {
    await bridge.end(descriptor.id).catch(() => undefined)

    return false
  }

  $contextLinkError.set(null)
  $wordCompanion.set({ descriptor, epoch: fence.epoch, ownerKey: fence.ownerKey, scopeKey: fence.scopeKey })

  return true
}

/**
 * A user-chosen Word file may not be running yet. Launch it normally first,
 * then use the exact binding path; this never borrows automatic companion
 * authority or guesses a document from a window title.
 */
export async function linkWordFile(path: string, options: LinkPresentationOptions = {}): Promise<boolean> {
  const fence = activeFence()
  const operation = $contextLinkOperationEpoch.get()
  const file = pathTarget(path)
  const native = window.hermesDesktop?.nativeApps

  if (!fence || !file || !native) {
    setContextLinkNotice('WORD_UNAVAILABLE')

    return false
  }

  // Link only must not launch or activate a closed file. An already-open
  // exact path can bind quietly; otherwise preserve the prior target.
  if (options.show === false) {return linkWordDocument({ path: file.path, name: file.name }, options)}

  let apps: NativeAppEntry[]

  try {apps = await native.list(false)} catch (error) {
    setContextLinkNotice(errorCode(error, 'NATIVE_APP_UNAVAILABLE'))

    return false
  }

  if (!operationCurrent(operation, fence)) {return false}
  const app = apps.find(candidate => candidate.bundleId === OFFICE_APPS.word.bundleId)

  if (!app) {setContextLinkNotice('WORD_NOT_INSTALLED');

 return false}

  const launched = await launchNativeApp(app, fence.scopeKey, { documentPath: file.path, normal: true })

  if (!launched || !operationCurrent(operation, fence)) {
    setContextLinkNotice('WORD_BIND_FAILED')

    return false
  }

  return linkWordDocument({ name: file.name, path: file.path }, options)
}

/** Bind a verified open Word document without activating or arranging it. */
export async function linkWordDocument(input: LinkWordDocumentInput, options: LinkPresentationOptions = {}): Promise<boolean> {
  return withPending(async operation => {
    const fence = activeFence()
    const bridge = wordBridge()
    const previousBinding = $contextLinkBinding.get()
    const hasCandidate = typeof input.candidateId === 'string' && input.candidateId.length > 0
    const path = input.path ? pathTarget(input.path, input.name) : null

    if (!fence || !bridge || (hasCandidate === Boolean(path))) {
      setContextLinkNotice(!bridge ? 'WORD_UNAVAILABLE' : 'CONTEXT_LINK_INVALID_TARGET')

      return false
    }

    let descriptor: WordCompanionDescriptor
    const requestId = newRevision()
    let cancelled = false

    const stopCancellation = $contextLinkOperationEpoch.listen(next => {
      if (next !== operation) {
        cancelled = true
        void bridge.unbind!(requestId).catch(() => undefined)
      }
    })

    try {
      descriptor = await bridge.bind!(hasCandidate
        ? { candidateId: input.candidateId!, requestId }
        : { path: path!.path, requestId })
    } catch (error) {
      setContextLinkNotice(errorCode(error, 'WORD_BIND_FAILED'))

      return false
    } finally {
      stopCancellation()
    }

    const targetPath = pathTarget(descriptor.path, input.name ?? descriptor.name)
    const provisional = targetPath ? bindingFor(fence, options.revision ?? newRevision(), { word: descriptor }) : null

    if (!targetPath || !provisional || cancelled || !operationCurrent(operation, fence)) {
      releaseProvisional(provisional)
      await restorePreviousWordBinding(previousBinding)

      return false
    }

    const target: ContextLinkTarget = { kind: 'word', ...targetPath }

    if (!commitLinkedTarget(target, fence, provisional)) {
      releaseProvisional(provisional)
      await restorePreviousWordBinding(previousBinding)

      return false
    }

    if (options.show !== false) {await showWordBeside(provisional, fence, operation)}

    if (operationCurrent(operation, fence)) {$contextPickerOpen.set(false)}

    return true
  }).catch(error => {
    setContextLinkNotice(errorCode(error, 'CONTEXT_LINK_FAILED'))

    return false
  })
}

async function openSavedFile(path: string): Promise<{ token: string } | null> {
  const result: AtumConsumerFileOpenResult | undefined = await window.hermesDesktop?.consumerFiles?.open(path)

  return result?.kind === 'card' ? { token: result.token } : null
}

/** Link a saved Office file through an independent consumer-files read grant. */
export async function linkSavedDocument(input: LinkSavedDocumentInput, options: LinkPresentationOptions = {}): Promise<boolean> {
  return withPending(async operation => {
    const fence = activeFence()
    const file = pathTarget(input.path, input.name)

    if (!fence || !file) {setContextLinkNotice('CONTEXT_LINK_INVALID_TARGET');

 return false}

    let opened: { token: string } | null

    try {opened = await openSavedFile(file.path)} catch (error) {setContextLinkNotice(errorCode(error, 'NATIVE_DOCUMENT_OPEN_FAILED'));

 return false}

    if (!opened || !operationCurrent(operation, fence)) {
      if (opened) {void window.hermesDesktop?.consumerFiles?.releaseView(opened.token).catch(() => undefined)}
      setContextLinkNotice('NATIVE_DOCUMENT_NOT_CAPTURABLE')

      return false
    }

    const target: ContextLinkTarget = { kind: 'saved-file', ...file, appId: input.appId, office: input.office }
    const provisional = bindingFor(fence, options.revision ?? newRevision(), { fileToken: opened.token })

    if (!commitLinkedTarget(target, fence, provisional)) {
      releaseProvisional(provisional)

      return false
    }

    if (options.show !== false) {
      try {await showSavedFile(target, fence, operation)} catch (error) {setContextLinkNotice(`CONTEXT_LINK_SHOW_FAILED:${errorCode(error, 'UNAVAILABLE')}`)}
    }

    if (operationCurrent(operation, fence)) {$contextPickerOpen.set(false)}

    return true
  }).catch(error => {
    setContextLinkNotice(errorCode(error, 'CONTEXT_LINK_FAILED'))

    return false
  })
}

async function showSavedFile(target: Extract<ContextLinkTarget, { kind: 'saved-file' }>, fence = activeFence(), operation?: number): Promise<void> {
  const bridge = window.hermesDesktop?.nativeApps
  const current = () => fence && (operation === undefined ? contextLinkFenceCurrent(fence) : operationCurrent(operation, fence))

  if (!bridge || !fence || !current()) {throw new Error('NATIVE_APP_UNAVAILABLE')}
  const apps = await bridge.list(false)

  if (!current()) {return}
  const bundleId = OFFICE_APPS[target.office].bundleId
  const app = apps.find(candidate => candidate.id === target.appId) ?? apps.find(candidate => candidate.bundleId === bundleId)

  if (!app) {throw new Error('NATIVE_APP_UNAVAILABLE')}
  const result = await launchNativeApp(app as NativeAppEntry, fence.scopeKey, { documentPath: target.path })

  if (!result || result.status !== 'beside') {throw new Error(result?.reason === 'permission' ? 'NATIVE_APP_PERMISSION_DENIED' : 'CONTEXT_LINK_SHOW_FAILED')}
}

/** Re-run only an explicit presentation request; it never changes the linked target. */
export async function showLinkedDocument(): Promise<boolean> {
  const link = contextLinkForScope()
  const fence = activeFence()

  if (link.mode !== 'linked' || !link.target || !fence) {return false}

  try {
    if (link.target.kind === 'panel') {return Boolean(linkedTabId(link.target) && revealWorkbenchTab(linkedTabId(link.target)!))}

    if (link.target.kind === 'word') {
      if (!link.binding?.word) {setContextLinkNotice('WORD_DOCUMENT_UNAVAILABLE');

 return false}

      return showWordBeside(link.binding, fence)
    }

    await showSavedFile(link.target, fence)
    $contextLinkError.set(null)

    return true
  } catch (error) {
    setContextLinkNotice(`CONTEXT_LINK_SHOW_FAILED:${errorCode(error, 'UNAVAILABLE')}`)

    return false
  }
}

function linkedTabId(target: Extract<ContextLinkTarget, { kind: 'panel' }>): string | undefined {
  return linkedPanelTab(target)?.id
}

export async function bringLinkedWordToFront(): Promise<boolean> {
  const link = contextLinkForScope()
  const bridge = wordBridge()

  if (link.mode !== 'linked' || link.target?.kind !== 'word' || !link.binding?.word || !bridge?.bringToFront) {return false}

  try {await bridge.bringToFront(link.binding.word.id);

 return true} catch (error) {setContextLinkNotice(errorCode(error, 'WORD_ACTIVATE_DOCUMENT'));

 return false}
}

/** Re-authorize the persisted manual selection without changing presentation. */
export async function reconnectContextLink(): Promise<boolean> {
  const link = contextLinkForScope()

  if (link.mode !== 'linked' || !link.target) {return false}

  if (link.target.kind === 'panel') {return Boolean(linkedTabId(link.target))}

  if (link.target.kind === 'word') {return linkWordDocument({ name: link.target.name, path: link.target.path }, { revision: link.revision, show: false })}

  return linkSavedDocument(link.target, { revision: link.revision, show: false })
}

/** Stop following the explicit target and restore the existing automatic resolver. */
export function useAutomaticContext(): boolean {
  invalidateContextLinkOperations()

  if (!canLinkConversation()) {return false}

  try {setContextLinkIntent(null)} catch (error) {setContextLinkNotice(errorCode(error, 'CONTEXT_LINK_PERSISTENCE_FAILED'));

 return false}

  releaseContextLinkBinding()
  $contextLinkError.set(null)

  return true
}

/** Remove a manual target and deliberately pause automatic primary context. */
export function removeContextLink(): boolean {
  invalidateContextLinkOperations()
  const fence = activeFence()

  if (!fence) {return false}

  try {setContextLinkIntent({ mode: 'removed', revision: newRevision() }, fence.scopeKey)} catch (error) {setContextLinkNotice(errorCode(error, 'CONTEXT_LINK_PERSISTENCE_FAILED'));

 return false}

  releaseContextLinkBinding()
  $contextLinkError.set(null)

  return true
}

/** Hand the current explicit-link presentation choice to the Skills launcher. */
export function beginOtherAppsLink(show = true): boolean {
  if (!openOtherAppsLinkIntent(show)) {return false}
  $contextPickerOpen.set(false)
  openWorkbenchSingleton('tools')

  return true
}

export function cancelOtherAppsLink(): void {
  invalidateContextLinkOperations()
  clearOtherAppsLinkIntent()
}

/** Capture a linked saved file with the same one-refresh semantics as automatic native context. */
export async function captureLinkedSavedFile(binding: ContextLinkBinding, target: Extract<ContextLinkTarget, { kind: 'saved-file' }>): Promise<LinkedSavedFileCapture | null> {
  const files = window.hermesDesktop?.consumerFiles

  if (!files || !binding.fileToken || !sameLinkedBinding(binding, target)) {throw new Error('NATIVE_DOCUMENT_UNAVAILABLE')}

  try {
    const capture = await files.capture(binding.fileToken)

    return sameLinkedBinding(binding, target) ? capture : null
  } catch (error) {
    if (!sameLinkedBinding(binding, target)) {return null}

    if (!captureNeedsRefresh(error)) {
      replaceContextLinkBinding(binding, { ...binding, error: errorCode(error, 'NATIVE_DOCUMENT_CAPTURE_FAILED') })
      throw error
    }
  }

  let refreshed: AtumConsumerFileOpenResult

  try {refreshed = await files.open(target.path)} catch (error) {
    if (sameLinkedBinding(binding, target)) {replaceContextLinkBinding(binding, { ...binding, error: errorCode(error, 'NATIVE_DOCUMENT_REFRESH_FAILED') })}
    throw error
  }

  if (refreshed.kind !== 'card') {
    const code = refreshed.kind === 'error' ? refreshed.code : 'NATIVE_DOCUMENT_NOT_CAPTURABLE'

    if (sameLinkedBinding(binding, target)) {replaceContextLinkBinding(binding, { ...binding, error: code })}
    throw new Error(code)
  }

  if (!sameLinkedBinding(binding, target)) {void files.releaseView(refreshed.token).catch(() => undefined);

 return null}

  const replacement = { ...binding, fileToken: refreshed.token }

  if (!replaceContextLinkBinding(binding, replacement)) {void files.releaseView(refreshed.token).catch(() => undefined);

 return null}

  void files.releaseView(binding.fileToken).catch(() => undefined)

  try {
    const capture = await files.capture(refreshed.token)

    if (!sameLinkedBinding(replacement, target)) {return null}

    return capture
  } catch (error) {
    if (sameLinkedBinding(replacement, target)) {replaceContextLinkBinding(replacement, { ...replacement, error: errorCode(error, 'NATIVE_DOCUMENT_CAPTURE_FAILED') })}
    throw error
  }
}

/** Exported for the launcher so it can validate one-shot ownership before using it. */
export { $otherAppsLinkIntent }

// Returning to a live conversation can re-prove its saved target without
// stealing focus or changing layout. Restart restoration remains unavailable
// until the person explicitly chooses Reconnect.
let scopeReturnGeneration = 0
$workbenchScope.listen((_, previousScope) => {
  invalidateContextLinkOperations()
  const generation = ++scopeReturnGeneration

  // Initial entry after restart restores intent, not native authority.
  if (!previousScope?.startsWith(ATUM_CHAT_WORKBENCH_SCOPE_PREFIX)) {return}
  // All synchronous lifecycle listeners must release the outgoing binding
  // before this return-to-conversation operation takes its own epoch.
  queueMicrotask(() => {
    if (generation !== scopeReturnGeneration || $contextLinkPending.get()) {return}
    const link = contextLinkForScope()

    if (!canLinkConversation() || link.mode !== 'linked' || link.state !== 'unavailable' || !link.target || link.target.kind === 'panel') {return}
    void reconnectContextLink()
  })
})
$actionPanelOwner.listen(invalidateContextLinkOperations)
$actionPanelEpoch.listen(invalidateContextLinkOperations)
$atumShellEnabled.listen(invalidateContextLinkOperations)

$workspaceOpen.listen(open => {
  if (!open && $otherAppsLinkIntent.get()) {cancelOtherAppsLink()}
})
