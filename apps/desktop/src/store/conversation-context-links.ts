import { atom, computed } from 'nanostores'

import type { OfficeAppKind } from '../../shared/skills-launcher'
import type { WordCompanionDescriptor } from '../../shared/word-companion'

import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from './action-panel-owner'
import { $atumShellEnabled } from './atum-shell'
import { ownsActionPanel } from './windows'
import { $workbenchScope, $workbenchTabs, ATUM_CHAT_WORKBENCH_SCOPE_PREFIX, resolveCaptureScope, type WorkbenchTabRegistration } from './workbench-tabs'

export type ContextLinkTarget =
  | { kind: 'panel'; viewKey: string; path: string; name: string }
  | { kind: 'word'; path: string; name: string }
  | { kind: 'saved-file'; path: string; name: string; office: OfficeAppKind; appId?: string }

export interface ContextLinkIntent {
  revision: string
  mode: 'linked' | 'removed'
  target?: ContextLinkTarget
}

export interface ContextLinkBinding {
  revision: string
  ownerKey: string
  profile: string
  epoch: number
  scopeKey: string
  word?: WordCompanionDescriptor
  fileToken?: string
  error?: string
}

/** A one-shot handoff from the composer picker to the Skills launcher. */
export interface OtherAppsLinkIntent {
  epoch: number
  ownerKey: string
  profile: string
  scopeKey: string
  /** `true` is the explicit-link default; false preserves the current view. */
  show: boolean
}

export interface ConversationContextLink {
  mode: 'automatic' | 'linked' | 'removed'
  revision: string
  target?: ContextLinkTarget
  binding?: ContextLinkBinding
  state: 'ready' | 'unavailable'
}

const STORAGE_KEY = 'atum.desktop.conversationContextLinks.v1'
type LinkRecords = Record<string, ContextLinkIntent>

function validTarget(value: unknown): value is ContextLinkTarget {
  const target = value as Partial<ContextLinkTarget> | undefined

  if (!target || typeof target.path !== 'string' || !target.path || target.path.length > 4096 ||
    typeof target.name !== 'string' || !target.name || target.name.length > 512) {return false}

  if (target.kind === 'panel') {return typeof target.viewKey === 'string' && target.viewKey.length > 0 && target.viewKey.length <= 4096}

  if (!target.path.startsWith('/')) {return false}

  return target.kind === 'word' || (target.kind === 'saved-file' && ['word', 'excel', 'powerpoint'].includes(target.office ?? '') &&
    (target.appId === undefined || (typeof target.appId === 'string' && target.appId.length <= 4096)))
}

function readRecords(): LinkRecords {
  if (typeof window === 'undefined' || !ownsActionPanel()) {return {}}

  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')

    if (!data || typeof data !== 'object' || Array.isArray(data)) {return {}}

    return Object.fromEntries(Object.entries(data).filter(([key, value]) => {
      const intent = value as Partial<ContextLinkIntent> | undefined

      return key.length <= 8192 && intent && typeof intent.revision === 'string' && intent.revision.length <= 128 &&
        (intent.mode === 'removed' || (intent.mode === 'linked' && validTarget(intent.target)))
    }))
  } catch {return {}}
}

const $records = atom<LinkRecords>(readRecords())
export const $contextLinkBinding = atom<ContextLinkBinding | null>(null)
export const $contextLinkPending = atom(false)
export const $contextLinkError = atom<string | null>(null)
export const $contextPickerOpen = atom(false)
export const $otherAppsLinkIntent = atom<OtherAppsLinkIntent | null>(null)
/** Bumped on an ownership/scope or explicit-cancel transition. */
export const $contextLinkOperationEpoch = atom(0)

export function invalidateContextLinkOperations(): void {
  $contextLinkOperationEpoch.set($contextLinkOperationEpoch.get() + 1)
}

$contextPickerOpen.listen(open => {
  if (!open && $contextLinkPending.get()) {invalidateContextLinkOperations()}
})

export function canLinkConversation(scopeKey = $workbenchScope.get()): boolean {
  return ownsActionPanel() && $atumShellEnabled.get() && Boolean($actionPanelOwner.get()) &&
    scopeKey.startsWith(ATUM_CHAT_WORKBENCH_SCOPE_PREFIX) && resolveCaptureScope(scopeKey) === resolveCaptureScope($workbenchScope.get())
}

function recordKey(scopeKey: string): string {
  return JSON.stringify([panelOwnerKey(), $actionPanelOwner.get()?.profile ?? '', resolveCaptureScope(scopeKey)])
}

/** A fence for asynchronous renderer work. It carries no native authority. */
export function contextLinkOwnerFence(scopeKey = $workbenchScope.get()): Omit<ContextLinkBinding, 'revision'> | null {
  if (!canLinkConversation(scopeKey)) {return null}
  const owner = $actionPanelOwner.get()

  return owner ? {
    epoch: $actionPanelEpoch.get(),
    ownerKey: panelOwnerKey(owner),
    profile: owner.profile,
    scopeKey: $workbenchScope.get()
  } : null
}

export function contextLinkFenceCurrent(fence: Omit<ContextLinkBinding, 'revision'>): boolean {
  const current = contextLinkOwnerFence(fence.scopeKey)

  return Boolean(current && current.ownerKey === fence.ownerKey && current.profile === fence.profile &&
    current.epoch === fence.epoch && resolveCaptureScope(current.scopeKey) === resolveCaptureScope(fence.scopeKey))
}

function entryForScope(scopeKey: string): [string, ContextLinkIntent] | undefined {
  const exact = recordKey(scopeKey)
  const records = $records.get()

  if (records[exact]) {return [exact, records[exact]]}

  // A native-only draft may have no tabs to migrate; the capture alias still
  // authorizes its intent to follow the first durable conversation.
  return Object.entries(records).find(([key]) => {
    try {
      const [owner, profile, scope] = JSON.parse(key)

      return owner === panelOwnerKey() && profile === $actionPanelOwner.get()?.profile &&
        typeof scope === 'string' && resolveCaptureScope(scope) === resolveCaptureScope(scopeKey)
    } catch {return false}
  })
}

export function linkedPanelTab(target: ContextLinkTarget, scopeKey = $workbenchScope.get()): WorkbenchTabRegistration | undefined {
  if (target.kind !== 'panel') {return undefined}

  return $workbenchTabs.get().find(tab => resolveCaptureScope(tab.scopeKey) === resolveCaptureScope(scopeKey) &&
    (tab.viewKey ?? tab.id) === target.viewKey && tab.surface.kind === 'preview')
}

export function contextLinkForScope(scopeKey = $workbenchScope.get()): ConversationContextLink {
  const intent = entryForScope(scopeKey)?.[1]

  if (!intent) {return { mode: 'automatic', revision: 'automatic', state: 'ready' }}

  if (intent.mode === 'removed') {return { ...intent, state: 'ready' }}
  const binding = $contextLinkBinding.get()
  const owner = $actionPanelOwner.get()

  const currentBinding = binding && owner && binding.revision === intent.revision &&
    binding.ownerKey === panelOwnerKey(owner) && binding.profile === owner.profile && binding.epoch === $actionPanelEpoch.get() &&
    resolveCaptureScope(binding.scopeKey) === resolveCaptureScope(scopeKey) ? binding : undefined

  const ready = intent.target?.kind === 'panel' ? Boolean(linkedPanelTab(intent.target, scopeKey)) :
    Boolean(currentBinding && !currentBinding.error && (currentBinding.word || currentBinding.fileToken))

  return { ...intent, binding: currentBinding, state: ready ? 'ready' : 'unavailable' }
}

export const $conversationContextLink = computed(
  [$records, $contextLinkBinding, $actionPanelOwner, $actionPanelEpoch, $workbenchScope, $workbenchTabs],
  () => contextLinkForScope()
)

function saveRecords(records: LinkRecords): void {
  // Persist intent only. A quota failure leaves the previous selection visible.
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  $records.set(records)
}

export function setContextLinkIntent(intent: ContextLinkIntent | null, scopeKey = $workbenchScope.get()): void {
  if (!canLinkConversation(scopeKey)) {throw new Error('CONTEXT_LINK_OWNER_CHANGED')}

  if (intent?.mode === 'linked' && !validTarget(intent.target)) {throw new Error('CONTEXT_LINK_INVALID_TARGET')}
  const records = { ...$records.get() }
  const previousKey = entryForScope(scopeKey)?.[0]

  if (previousKey) {delete records[previousKey]}

  if (intent) {records[recordKey(scopeKey)] = intent}
  saveRecords(records)
}

/** Publish an already-authorized native/file binding only after its intent persisted. */
export function publishContextLinkBinding(binding: ContextLinkBinding): boolean {
  const intent = entryForScope(binding.scopeKey)?.[1]

  if (!intent || intent.mode !== 'linked' || intent.revision !== binding.revision || !contextLinkFenceCurrent(binding)) {
    return false
  }

  $contextLinkBinding.set(binding)

  return true
}

/** Replace a live handle after the same persisted intent was re-authorized. */
export function replaceContextLinkBinding(previous: ContextLinkBinding, next: ContextLinkBinding): boolean {
  if ($contextLinkBinding.get() !== previous || previous.revision !== next.revision || !contextLinkFenceCurrent(next)) {
    return false
  }

  $contextLinkBinding.set(next)

  return true
}

export function setContextLinkFailure(revision: string, error: string): void {
  const binding = $contextLinkBinding.get()

  if (binding?.revision === revision) {$contextLinkBinding.set({ ...binding, error })}
  $contextLinkError.set(error)
}

/** Presentation failures leave a successfully-linked document readable. */
export function setContextLinkNotice(error: string | null): void {
  $contextLinkError.set(error)
}

export function openOtherAppsLinkIntent(show: boolean, scopeKey = $workbenchScope.get()): boolean {
  const fence = contextLinkOwnerFence(scopeKey)

  if (!fence) {return false}
  $otherAppsLinkIntent.set({ ...fence, show })

  return true
}

export function clearOtherAppsLinkIntent(): void {
  $otherAppsLinkIntent.set(null)
}

export function otherAppsLinkIntentForScope(scopeKey = $workbenchScope.get()): OtherAppsLinkIntent | null {
  const intent = $otherAppsLinkIntent.get()

  return intent && contextLinkFenceCurrent(intent) && resolveCaptureScope(intent.scopeKey) === resolveCaptureScope(scopeKey) ? intent : null
}

/** Revocation happens locally before native cleanup; hidden panels do not revoke. */
export function disposeContextLinkBinding(binding: ContextLinkBinding | null | undefined): void {
  if (binding?.word) {void window.hermesDesktop?.wordCompanion?.unbind?.(binding.word.id).catch(() => undefined)}

  if (binding?.fileToken) {void window.hermesDesktop?.consumerFiles?.releaseView(binding.fileToken).catch(() => undefined)}
}

export function releaseContextLinkBinding(): void {
  const binding = $contextLinkBinding.get()
  $contextLinkBinding.set(null)
  disposeContextLinkBinding(binding)
}

export function startConversationContextLinks(): () => void {
  const reconcile = () => {
    invalidateContextLinkOperations()
    const binding = $contextLinkBinding.get()
    const owner = $actionPanelOwner.get()

    if (binding && (!canLinkConversation() || !owner || binding.ownerKey !== panelOwnerKey(owner) ||
      binding.profile !== owner.profile || binding.epoch !== $actionPanelEpoch.get() ||
      resolveCaptureScope(binding.scopeKey) !== resolveCaptureScope($workbenchScope.get()))) {releaseContextLinkBinding()}

    if (owner && canLinkConversation() && resolveCaptureScope($workbenchScope.get()) === resolveCaptureScope(binding?.scopeKey ?? $workbenchScope.get())) {
      // Persist the authorized draft alias so it survives a restart.
      const entry = entryForScope($workbenchScope.get())

      if (entry && entry[0] !== recordKey($workbenchScope.get())) {
        try {setContextLinkIntent(entry[1])} catch {
          $contextLinkError.set('CONTEXT_LINK_PERSISTENCE_FAILED')

          return
        }
      }
    }

    if ($otherAppsLinkIntent.get() && !$otherAppsLinkIntent.get()!.scopeKey.startsWith(ATUM_CHAT_WORKBENCH_SCOPE_PREFIX)) {clearOtherAppsLinkIntent()}

    if ($otherAppsLinkIntent.get() && !contextLinkFenceCurrent($otherAppsLinkIntent.get()!)) {clearOtherAppsLinkIntent()}
    $contextPickerOpen.set(false)

    if (!$contextLinkError.get()?.startsWith('CONTEXT_LINK_PERSISTENCE_')) {$contextLinkError.set(null)}
  }

  const unsubs = [$actionPanelOwner.listen(reconcile), $actionPanelEpoch.listen(reconcile), $atumShellEnabled.listen(reconcile), $workbenchScope.listen(reconcile)]

  const stopEnded = window.hermesDesktop?.wordCompanion?.onBindingEnded?.(id => {
    const binding = $contextLinkBinding.get()

    if (binding?.word?.id === id) {$contextLinkBinding.set({ ...binding, error: 'WORD_DOCUMENT_UNAVAILABLE' })}
  })

  return () => {unsubs.forEach(stop => stop()); stopEnded?.(); releaseContextLinkBinding()}
}

/** Use only on confirmed deletion, never for merely hiding a conversation. */
export function forgetConversationContextLink(scopeKey: string): void {
  const previousKey = entryForScope(scopeKey)?.[0]

  if (!previousKey) {return}
  const records = { ...$records.get() }
  delete records[previousKey]
  saveRecords(records)

  if (resolveCaptureScope(scopeKey) === resolveCaptureScope($workbenchScope.get())) {releaseContextLinkBinding()}
}

export function resetConversationContextLinksForTests(): void {
  $records.set({})
  $contextLinkBinding.set(null)
  $contextLinkPending.set(false)
  $contextLinkError.set(null)
  $contextPickerOpen.set(false)
  $otherAppsLinkIntent.set(null)
  $contextLinkOperationEpoch.set(0)
}
