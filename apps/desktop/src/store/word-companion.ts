import { atom } from 'nanostores'

import { translateNow } from '@/i18n/runtime'

import { OFFICE_APPS } from '../../shared/skills-launcher'
import type { WordCompanionBridge, WordCompanionDescriptor } from '../../shared/word-companion'

import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from './action-panel-owner'
import { $atumShellEnabled } from './atum-shell'
import { recordNativeAppUse } from './native-app-recency'
import { clearNativeDocument } from './native-document'
import { notifyError } from './notifications'
import { ownsActionPanel } from './windows'
import { $workbenchScope, ATUM_CHAT_WORKBENCH_SCOPE_PREFIX, resolveCaptureScope } from './workbench-tabs'

export interface WordCompanionPair {
  descriptor: WordCompanionDescriptor
  /** The stable action-panel owner that was current when Word was paired. */
  ownerKey: string
  /** An owner can retain the same ids across a re-resolution, so pin its epoch too. */
  epoch: number
  /** The assistant chat (or provisional draft) that owns this external document. */
  scopeKey: string
}

/** Ephemeral renderer association; Electron remains authoritative for the native pair. */
export const $wordCompanion = atom<WordCompanionPair | null>(null)
export const $wordCompanionOpening = atom(false)
/** Native error codes are deliberately kept stable for the shell's presentation mapping. */
export const $wordCompanionError = atom<string | null>(null)

let requestGeneration = 0
let pendingRequestId: string | null = null
let pendingContext: CompanionContext | null = null

function bridge(): WordCompanionBridge | undefined {
  return window.hermesDesktop?.wordCompanion
}

function isAssistantScope(scopeKey: string): boolean {
  return scopeKey.startsWith(ATUM_CHAT_WORKBENCH_SCOPE_PREFIX)
}

interface CompanionContext {
  epoch: number
  ownerKey: string
  scopeKey: string
}

function currentContext(): CompanionContext | null {
  const owner = $actionPanelOwner.get()
  const scopeKey = $workbenchScope.get()

  if (!ownsActionPanel() || !$atumShellEnabled.get() || !owner || !isAssistantScope(scopeKey)) {
    return null
  }

  return { epoch: $actionPanelEpoch.get(), ownerKey: panelOwnerKey(owner), scopeKey }
}

export function canPairWordCompanion(scopeKey = $workbenchScope.get()): boolean {
  const context = currentContext()

  return Boolean(context && sameEffectiveScope(context.scopeKey, scopeKey))
}

export function wordCompanionErrorMessage(code: string): string {
  if (code === 'WORD_NOT_INSTALLED') {return translateNow('atum.workspace.wordMissing')}

  if (code === 'WORD_AUTOMATION_DENIED') {return translateNow('atum.workspace.wordPermission')}

  if (code === 'WORD_EXIT_FULLSCREEN') {return translateNow('atum.workspace.wordFullscreen')}

  if (code === 'WORD_SCREEN_TOO_SMALL') {return translateNow('atum.workspace.wordSmallScreen')}

  if (code === 'WORD_DOCUMENT_UNAVAILABLE') {return translateNow('atum.workspace.wordDocumentUnavailable')}

  return translateNow('atum.workspace.wordOpenError')
}

function sameEffectiveScope(left: string, right: string): boolean {
  return resolveCaptureScope(left) === resolveCaptureScope(right)
}

function contextStillMatches(pair: WordCompanionPair, context = currentContext()): boolean {
  return Boolean(context && pair.ownerKey === context.ownerKey && pair.epoch === context.epoch && sameEffectiveScope(pair.scopeKey, context.scopeKey))
}

function errorCode(error: unknown, fallback: string): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined

  if (typeof code === 'string' && /^[A-Z0-9_]{3,128}$/u.test(code)) {
    return code
  }

  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const stable = message.match(/\bWORD_[A-Z0-9_]+\b/u)?.[0]

  return stable ?? fallback
}

/** Native cleanup is best effort only after ownership has been revoked locally. */
function endNative(id: string, candidate = bridge()): Promise<void> {
  return candidate?.end(id).catch(() => undefined) ?? Promise.resolve()
}

/**
 * Detach synchronously, then tell native to cancel an opening request or end
 * the exact paired document. A request id is also the native descriptor id,
 * so a late open result cannot affect a newer pair.
 */
function detachCurrent(): Promise<void> {
  requestGeneration += 1
  const pair = $wordCompanion.get()
  const pending = pendingRequestId
  const candidate = bridge()

  $wordCompanion.set(null)
  $wordCompanionError.set(null)
  pendingRequestId = null
  pendingContext = null
  $wordCompanionOpening.set(false)

  const endings = [
    ...(pending ? [endNative(pending, candidate)] : []),
    ...(pair && pair.descriptor.id !== pending ? [endNative(pair.descriptor.id, candidate)] : [])
  ]

  return Promise.all(endings).then(() => undefined)
}

/** Opens a local .doc/.docx beside the currently active assistant conversation. */
export async function openWordCompanion(path: string, scopeKey = $workbenchScope.get(), opened?: (id: string) => void): Promise<void> {
  const context = currentContext()
  const candidate = bridge()

  if (!context || !sameEffectiveScope(context.scopeKey, scopeKey)) {
    $wordCompanionError.set('WORD_INVALID_CONTEXT')

    return
  }

  // Word owns a distinct live-text context. An explicit attempt to pair it
  // replaces any native saved-file selection before its native work begins.
  clearNativeDocument()

  if (!candidate) {
    $wordCompanionError.set('WORD_UNAVAILABLE')

    return
  }

  // One native pair at a time. Ending a pending request is prompt cancellation,
  // not a wait for its Apple Event operation to finish.
  void detachCurrent()
  const generation = ++requestGeneration
  const requestId = crypto.randomUUID()
  pendingRequestId = requestId
  pendingContext = context
  $wordCompanionOpening.set(true)
  $wordCompanionError.set(null)

  try {
    const descriptor = await candidate.open(path, requestId)
    const stillCurrent = generation === requestGeneration && pendingRequestId === requestId
    const latest = currentContext()

    if (!stillCurrent || !latest || latest.ownerKey !== context.ownerKey || latest.epoch !== context.epoch || !sameEffectiveScope(latest.scopeKey, context.scopeKey)) {
      // A cancelled request may still resolve after native work was already in
      // flight. End only its own id; never clear a pair opened since then.
      void endNative(descriptor.id, candidate)

      return
    }

    $wordCompanion.set({ descriptor, ownerKey: context.ownerKey, epoch: context.epoch, scopeKey: latest.scopeKey })
    opened?.(descriptor.id)
    recordNativeAppUse(OFFICE_APPS.word.bundleId, $actionPanelOwner.get()?.accountId)
  } catch (error) {
    if (generation === requestGeneration && pendingRequestId === requestId) {
      const code = errorCode(error, 'WORD_OPEN_FAILED')
      $wordCompanionError.set(code)
      // Errors must also be visible when a full-frame workspace covers chat.
      notifyError(null, wordCompanionErrorMessage(code))
    }
  } finally {
    if (generation === requestGeneration && pendingRequestId === requestId) {
      pendingRequestId = null
      pendingContext = null
      $wordCompanionOpening.set(false)
    }
  }
}

/** Ends the active pair and restores the native layout. Safe while opening. */
export async function endWordCompanion(): Promise<void> {
  await detachCurrent()
}

function reconcileLifecycle(): void {
  const pair = $wordCompanion.get()

  if (!pair) {
    // A scope/owner switch during native open must cancel immediately too.
    const context = currentContext()

    if (!pendingRequestId) {$wordCompanionError.set(null)}

    if (pendingRequestId && (!pendingContext || !context || pendingContext.ownerKey !== context.ownerKey || pendingContext.epoch !== context.epoch || !sameEffectiveScope(pendingContext.scopeKey, context.scopeKey))) {
      void detachCurrent()
    }

    return
  }

  const context = currentContext()

  if (!contextStillMatches(pair, context)) {
    void detachCurrent()

    return
  }

  // Draft adoption re-keys the active workbench scope. It is the one scope
  // transition allowed to carry a companion association forward.
  if (pair.scopeKey !== context!.scopeKey) {
    $wordCompanion.set({ ...pair, scopeKey: context!.scopeKey })
  }
}

/** Subscribe once from the Atum shell. The native ended event is authoritative. */
export function startWordCompanionLifecycle(): () => void {
  const candidate = bridge()

  const stopEnded = candidate?.onEnded(id => {
    const pair = $wordCompanion.get()

    if (pair?.descriptor.id === id) {
      requestGeneration += 1
      $wordCompanion.set(null)
      $wordCompanionOpening.set(false)

      return
    }

    if (pendingRequestId === id) {
      requestGeneration += 1
      pendingRequestId = null
      pendingContext = null
      $wordCompanionOpening.set(false)
    }
  }) ?? (() => undefined)

  const unsubs = [
    $actionPanelOwner.listen(reconcileLifecycle),
    $actionPanelEpoch.listen(reconcileLifecycle),
    $atumShellEnabled.listen(reconcileLifecycle),
    $workbenchScope.listen(reconcileLifecycle)
  ]

  reconcileLifecycle()

  return () => {
    unsubs.forEach(unsubscribe => unsubscribe())
    stopEnded()
    void detachCurrent()
  }
}

export function resetWordCompanionForTests(): void {
  requestGeneration += 1
  pendingRequestId = null
  pendingContext = null
  $wordCompanion.set(null)
  $wordCompanionOpening.set(false)
  $wordCompanionError.set(null)
}
