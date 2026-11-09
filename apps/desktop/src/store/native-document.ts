import { atom } from 'nanostores'

import { documentDisplayName, normalizeFsPath } from '@/lib/document-path'

import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from './action-panel-owner'
import { $atumShellEnabled } from './atum-shell'
import { ownsActionPanel } from './windows'
import { $workbenchScope, ATUM_CHAT_WORKBENCH_SCOPE_PREFIX, resolveCaptureScope } from './workbench-tabs'

export interface NativeDocumentAssociation {
  /** Canonicalized for renderer identity only; Electron re-proves it for every bridge call. */
  canonicalPath: string
  captureError?: string
  displayName: string
  epoch: number
  ownerKey: string
  pairingId: string
  /** Profile is a routing boundary even when its stable agent ids happen to match. */
  profile: string
  scopeKey: string
  /** Absent only when Electron explicitly refused a new card grant. */
  token: string | null
}

export interface NativeDocumentCapture {
  dataUrl: string
  revision: string
}

interface NativeDocumentContext {
  epoch: number
  ownerKey: string
  profile: string
  scopeKey: string
}

interface PendingAssociation extends NativeDocumentContext {
  pairingId: string
}

/** The one saved-file grant that may contribute native-app context to this panel. */
export const $nativeDocument = atom<NativeDocumentAssociation | null>(null)

let generation = 0
let pending: PendingAssociation | null = null
const releasedTokens = new Set<string>()

function currentContext(): NativeDocumentContext | null {
  const owner = $actionPanelOwner.get()
  const scopeKey = $workbenchScope.get()

  if (
    !ownsActionPanel() ||
    !$atumShellEnabled.get() ||
    !owner ||
    !scopeKey.startsWith(ATUM_CHAT_WORKBENCH_SCOPE_PREFIX)
  ) {
    return null
  }

  return { epoch: $actionPanelEpoch.get(), ownerKey: panelOwnerKey(owner), profile: owner.profile, scopeKey }
}

function sameEffectiveScope(left: string, right: string): boolean {
  return resolveCaptureScope(left) === resolveCaptureScope(right)
}

function associationMatches(
  association: NativeDocumentAssociation,
  context = currentContext(),
  scopeKey = context?.scopeKey
): boolean {
  return Boolean(
    context &&
    scopeKey &&
    association.ownerKey === context.ownerKey &&
    association.profile === context.profile &&
    association.epoch === context.epoch &&
    sameEffectiveScope(association.scopeKey, context.scopeKey) &&
    sameEffectiveScope(association.scopeKey, scopeKey)
  )
}

function releaseToken(token: string): void {
  if (releasedTokens.has(token)) {
    return
  }

  releasedTokens.add(token)
  void window.hermesDesktop?.consumerFiles?.releaseView(token).catch(() => undefined)
}

function errorCode(error: unknown, fallback: string): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined

  if (typeof code === 'string' && code) {
    return code
  }

  // Electron wraps main-process exceptions in an IPC invocation message and
  // does not preserve custom Error properties. Match only our fixed codes.
  return error instanceof Error
    ? (error.message.match(/\b(?:CONSUMER_FILES|NATIVE_DOCUMENT)_[A-Z_]+\b/u)?.[0] ?? fallback)
    : fallback
}

function captureNeedsRefresh(error: unknown): boolean {
  return new Set([
    'CONSUMER_FILES_MISSING',
    'CONSUMER_FILES_CAPTURE_CHANGED',
    'CONSUMER_FILES_CAPTURE_LIMIT_OR_CHANGED'
  ]).has(errorCode(error, ''))
}

function setCaptureError(association: NativeDocumentAssociation, code: string): void {
  if ($nativeDocument.get() === association) {
    $nativeDocument.set({ ...association, captureError: code })
  }
}

function reconcileLifecycle(): void {
  const association = $nativeDocument.get()
  const context = currentContext()

  if (association) {
    if (!associationMatches(association, context)) {
      clearNativeDocument()
    } else if (association.scopeKey !== context!.scopeKey) {
      // `resolveCaptureScope` only aliases a draft into the chat it created.
      $nativeDocument.set({ ...association, scopeKey: context!.scopeKey })
    }
  }

  if (
    pending &&
    (!context ||
      pending.ownerKey !== context.ownerKey ||
      pending.profile !== context.profile ||
      pending.epoch !== context.epoch ||
      !sameEffectiveScope(pending.scopeKey, context.scopeKey))
  ) {
    generation += 1
    pending = null
  }
}

/** Returns the active association only when this panel still owns its exact effective scope. */
export function currentNativeDocument(scopeKey = $workbenchScope.get()): NativeDocumentAssociation | null {
  const association = $nativeDocument.get()

  return association && associationMatches(association, undefined, scopeKey) ? association : null
}

/**
 * Replaces any prior native saved-file grant with an Electron-authorized card
 * grant. The renderer never reads the supplied path; every authorization stays
 * at the consumer-files bridge.
 */
export async function associateNativeDocument(
  pairingId: string,
  path: string,
  scopeKey = $workbenchScope.get()
): Promise<void> {
  const context = currentContext()
  const candidate = window.hermesDesktop?.consumerFiles

  if (!context || !sameEffectiveScope(context.scopeKey, scopeKey)) {
    throw new Error('NATIVE_DOCUMENT_INVALID_CONTEXT')
  }

  if (!candidate) {
    throw new Error('NATIVE_DOCUMENT_UNAVAILABLE')
  }

  clearNativeDocument()
  const requestGeneration = ++generation
  const request: PendingAssociation = { ...context, pairingId }
  pending = request

  let result: Awaited<ReturnType<typeof candidate.open>>

  try {
    result = await candidate.open(path)
  } catch (error) {
    const latest = currentContext()

    if (
      requestGeneration === generation &&
      pending === request &&
      latest &&
      latest.ownerKey === request.ownerKey &&
      latest.profile === request.profile &&
      latest.epoch === request.epoch &&
      sameEffectiveScope(latest.scopeKey, request.scopeKey)
    ) {
      const canonicalPath = normalizeFsPath(path)
      const captureError = errorCode(error, 'NATIVE_DOCUMENT_OPEN_FAILED')
      pending = null
      $nativeDocument.set({
        canonicalPath,
        captureError,
        displayName: documentDisplayName(canonicalPath),
        epoch: request.epoch,
        ownerKey: request.ownerKey,
        pairingId,
        profile: request.profile,
        scopeKey: latest.scopeKey,
        token: null
      })
    } else if (requestGeneration === generation && pending === request) {
      pending = null
    }

    throw error
  }

  const latest = currentContext()

  const current =
    requestGeneration === generation &&
    pending === request &&
    latest &&
    latest.ownerKey === request.ownerKey &&
    latest.profile === request.profile &&
    latest.epoch === request.epoch &&
    sameEffectiveScope(latest.scopeKey, request.scopeKey)

  if (!current) {
    if (result.kind === 'card') {
      releaseToken(result.token)
    }

    if (requestGeneration === generation && pending === request) {
      pending = null
    }

    return
  }

  pending = null

  if (result.kind !== 'card') {
    const canonicalPath = normalizeFsPath(path)
    const captureError = result.kind === 'error' ? result.code : 'NATIVE_DOCUMENT_NOT_CAPTURABLE'
    $nativeDocument.set({
      canonicalPath,
      captureError,
      displayName: documentDisplayName(canonicalPath),
      epoch: request.epoch,
      ownerKey: request.ownerKey,
      pairingId,
      profile: request.profile,
      scopeKey: latest.scopeKey,
      token: null
    })
    throw new Error(captureError)
  }

  const canonicalPath = normalizeFsPath(path)
  $nativeDocument.set({
    canonicalPath,
    displayName: documentDisplayName(canonicalPath),
    epoch: request.epoch,
    ownerKey: request.ownerKey,
    pairingId,
    profile: request.profile,
    scopeKey: latest.scopeKey,
    token: result.token
  })
}

/** Clears an active or in-flight association, releasing each issued grant exactly once. */
export function clearNativeDocument(pairingId?: string): void {
  const association = $nativeDocument.get()
  const pendingMatches = Boolean(pending && (!pairingId || pending.pairingId === pairingId))
  const associationMatchesPairing = Boolean(association && (!pairingId || association.pairingId === pairingId))

  if (!pendingMatches && !associationMatchesPairing) {
    return
  }

  generation += 1

  if (pendingMatches) {
    pending = null
  }

  if (associationMatchesPairing && association) {
    $nativeDocument.set(null)

    if (association.token) {
      releaseToken(association.token)
    }
  }
}

function currentAttempt(association: NativeDocumentAssociation, scopeKey: string, requestGeneration: number): boolean {
  return (
    generation === requestGeneration &&
    $nativeDocument.get() === association &&
    associationMatches(association, undefined, scopeKey)
  )
}

/**
 * Captures the last saved bytes. A dead inode-bound token receives one fresh
 * main-authorized grant for this same association; every other failure remains
 * explicit for the caller to present as unavailable/reselectable context.
 */
export async function captureNativeDocument(scopeKey = $workbenchScope.get()): Promise<NativeDocumentCapture | null> {
  const association = currentNativeDocument(scopeKey)
  const candidate = window.hermesDesktop?.consumerFiles

  if (!association) {
    return null
  }

  if (!candidate) {
    const error = new Error('NATIVE_DOCUMENT_UNAVAILABLE')
    setCaptureError(association, error.message)
    throw error
  }

  const requestGeneration = generation

  if (!association.token) {
    const error = new Error(association.captureError ?? 'NATIVE_DOCUMENT_UNAVAILABLE')
    setCaptureError(association, error.message)
    throw error
  }

  try {
    const capture = await candidate.capture(association.token)

    if (!currentAttempt(association, scopeKey, requestGeneration)) {
      return null
    }

    return capture
  } catch (error) {
    if (!currentAttempt(association, scopeKey, requestGeneration)) {
      return null
    }

    if (!captureNeedsRefresh(error)) {
      setCaptureError(association, errorCode(error, 'NATIVE_DOCUMENT_CAPTURE_FAILED'))
      throw error
    }
  }

  let refreshed: Awaited<ReturnType<typeof candidate.open>>

  try {
    refreshed = await candidate.open(association.canonicalPath)
  } catch (error) {
    if (currentAttempt(association, scopeKey, requestGeneration)) {
      setCaptureError(association, errorCode(error, 'NATIVE_DOCUMENT_REFRESH_FAILED'))
      throw error
    }

    return null
  }

  if (!currentAttempt(association, scopeKey, requestGeneration)) {
    if (refreshed.kind === 'card') {
      releaseToken(refreshed.token)
    }

    return null
  }

  if (refreshed.kind !== 'card') {
    const error = new Error(refreshed.kind === 'error' ? refreshed.code : 'NATIVE_DOCUMENT_NOT_CAPTURABLE')
    setCaptureError(association, error.message)
    throw error
  }

  const replacement: NativeDocumentAssociation = { ...association, captureError: undefined, token: refreshed.token }
  $nativeDocument.set(replacement)
  releaseToken(association.token)

  try {
    const capture = await candidate.capture(refreshed.token)

    if (!currentAttempt(replacement, scopeKey, requestGeneration)) {
      return null
    }

    return capture
  } catch (error) {
    if (!currentAttempt(replacement, scopeKey, requestGeneration)) {
      return null
    }

    setCaptureError(replacement, errorCode(error, 'NATIVE_DOCUMENT_CAPTURE_FAILED'))
    throw error
  }
}

/** Subscribe once from the Atum shell to revoke grants on every ownership transition. */
export function startNativeDocumentLifecycle(): () => void {
  const unsubs = [
    $actionPanelOwner.listen(reconcileLifecycle),
    $actionPanelEpoch.listen(reconcileLifecycle),
    $atumShellEnabled.listen(reconcileLifecycle),
    $workbenchScope.listen(reconcileLifecycle)
  ]

  reconcileLifecycle()

  return () => {
    unsubs.forEach(unsubscribe => unsubscribe())
    clearNativeDocument()
  }
}

export function resetNativeDocumentForTests(): void {
  generation += 1
  pending = null
  $nativeDocument.set(null)
  releasedTokens.clear()
}
