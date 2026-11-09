import { atom } from 'nanostores'

import type { NativeAppEntry, NativeAppLaunchResult } from '../../shared/skills-launcher'

import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from './action-panel-owner'
import { recordNativeAppUse } from './native-app-recency'
import { associateNativeDocument, clearNativeDocument, startNativeDocumentLifecycle } from './native-document'
import { ownsActionPanel } from './windows'
import { $workbenchScope, ATUM_CHAT_WORKBENCH_SCOPE_PREFIX, resolveCaptureScope } from './workbench-tabs'

export interface NativeAppsState {
  apps: NativeAppEntry[]
  loading: boolean
  error: string | null
  result: NativeAppLaunchResult | null
  scopeKey: string
  /** Explicit main-authorized saved-file capture failure; the app itself remains open. */
  documentContextError?: string
  documentPath?: string
}
export const $nativeApps = atom<NativeAppsState>({ apps: [], loading: false, error: null, result: null, scopeKey: '' })
let generation = 0
let inventoryGeneration = 0
let pendingId: string | null = null
let unsubscribeEnded: (() => void) | null = null

const bridge = () => window.hermesDesktop?.nativeApps
const ownership = () => JSON.stringify([$actionPanelEpoch.get(), panelOwnerKey(), $actionPanelOwner.get()?.profile ?? null, resolveCaptureScope($workbenchScope.get())])
// This store owns the native-app lifecycle, so it also owns the one subscription
// that revokes saved-file grants when its panel identity changes.
startNativeDocumentLifecycle()

function listen() {
  unsubscribeEnded ??= bridge()?.onEnded(id => {
    if ($nativeApps.get().result?.id === id) {
      clearNativeDocument(id)
      $nativeApps.set({ ...$nativeApps.get(), documentContextError: undefined, result: null, documentPath: undefined })
    }
  }) ?? null
}

export async function refreshNativeApps(refresh = true, requestedScope = $workbenchScope.get()): Promise<void> {
  const request = ++inventoryGeneration
  const scopeKey = requestedScope
  const owner = ownership()
  lastOwner = owner
  $nativeApps.set({ ...$nativeApps.get(), scopeKey, loading: true, error: null })
  listen()

  try {
    const apps = await bridge()?.list(refresh) ?? []

    if (request === inventoryGeneration && owner === ownership()) {$nativeApps.set({ ...$nativeApps.get(), apps, loading: false, scopeKey })}
  } catch {
    if (request === inventoryGeneration && owner === ownership()) {$nativeApps.set({ ...$nativeApps.get(), loading: false, error: 'load' })}
  }
}

export function endNativeApp(): Promise<void> {
  generation += 1
  const id = pendingId ?? $nativeApps.get().result?.id
  pendingId = null
  clearNativeDocument(id)
  $nativeApps.set({ ...$nativeApps.get(), documentContextError: undefined, result: null, documentPath: undefined })

  return id ? bridge()?.end(id).catch(() => undefined) ?? Promise.resolve() : Promise.resolve()
}

async function launch(app: NativeAppEntry, scopeKey: string, options: { normal?: boolean; windowId?: number; documentPath?: string } = {}): Promise<NativeAppLaunchResult | null> {
  const candidate = bridge()

  if (!candidate || !ownsActionPanel() || !scopeKey.startsWith(ATUM_CHAT_WORKBENCH_SCOPE_PREFIX) ||
    resolveCaptureScope(scopeKey) !== resolveCaptureScope($workbenchScope.get())) {return null}

  listen()
  const previous = $nativeApps.get()

  // A new launch is a new file-context choice. The chooser continuation keeps
  // its request id and has not yet produced a terminal document association.
  if (options.windowId === undefined) {clearNativeDocument()}

  const requestId = options.windowId !== undefined && previous.result?.status === 'choose-window'
    ? previous.result.id : crypto.randomUUID()

  const documentPath = options.documentPath ?? (options.windowId !== undefined ? previous.documentPath : undefined)

  if (documentPath && !$actionPanelOwner.get()) {return null}
  const token = ++generation
  const owner = ownership()
  lastOwner = owner
  pendingId = requestId
  $nativeApps.set({ ...previous, documentContextError: undefined, scopeKey, error: null })

  try {
    const result = await candidate.launch({ appId: app.id, requestId, mode: options.normal ? 'normal' : 'beside',
      windowId: options.windowId, documentPath })

    if (token !== generation || owner !== ownership()) {
      await candidate.end(requestId).catch(() => undefined)

      return null
    }

    pendingId = null
    $nativeApps.set({ ...$nativeApps.get(), documentContextError: undefined, result, scopeKey, documentPath })

    // A window chooser is not a successful terminal launch. Its selected
    // continuation reuses this request id and mints the card grant only after
    // Electron has opened the document in the chosen native window.
    if (documentPath && result.status !== 'choose-window') {
      try {
        await associateNativeDocument(result.id, documentPath, scopeKey)
      } catch (error) {
        if (token === generation && owner === ownership()) {
          $nativeApps.set({ ...$nativeApps.get(), documentContextError: error instanceof Error ? error.message : 'NATIVE_DOCUMENT_UNAVAILABLE' })
        }
      }

      if (token !== generation || owner !== ownership()) {
        clearNativeDocument(result.id)
        await candidate.end(requestId).catch(() => undefined)

        return null
      }
    }

    if (result.status !== 'choose-window') {
      recordNativeAppUse(result.app.bundleId || result.app.id, $actionPanelOwner.get()?.accountId)
    }

    return result
  } catch {
    if (token === generation && owner === ownership()) {
      pendingId = null
      $nativeApps.set({ ...$nativeApps.get(), error: 'launch' })
    }

    return null
  }
}

export const launchNativeApp = (app: NativeAppEntry, scopeKey: string, options?: { normal?: boolean; windowId?: number; documentPath?: string }) => launch(app, scopeKey, options)
export const openNativeAppDocument = (app: NativeAppEntry, documentPath: string, scopeKey: string) => launch(app, scopeKey, { documentPath })

let lastOwner = ''

function reconcile(scopeTransition = false) {
  const next = ownership()
  const previousIdentity = lastOwner ? JSON.parse(lastOwner).slice(0, 3) : []
  const currentIdentity = JSON.parse(next).slice(0, 3)
  const state = $nativeApps.get()

  const promoted = scopeTransition && state.result &&
    JSON.stringify(previousIdentity) === JSON.stringify(currentIdentity) &&
    resolveCaptureScope(state.scopeKey) === resolveCaptureScope($workbenchScope.get())

  if (promoted) {
    $nativeApps.set({ ...state, scopeKey: $workbenchScope.get() })
    lastOwner = next

    return
  }

  if (lastOwner && next !== lastOwner) {
    const wasLoading = $nativeApps.get().loading

    inventoryGeneration += 1
    void endNativeApp()
    $nativeApps.set({ ...$nativeApps.get(), scopeKey: $workbenchScope.get(), loading: false, error: null, documentContextError: undefined })

    if (scopeTransition && wasLoading) {void refreshNativeApps(false)}
  }

  lastOwner = next
}

$actionPanelEpoch.listen(() => reconcile())
$actionPanelOwner.listen(() => reconcile())
$workbenchScope.listen(() => reconcile(true))
