import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from '@/store/action-panel-owner'
import { $atumShellEnabled } from '@/store/atum-shell'
import { openNativeAppDocument } from '@/store/native-apps'
import { ownsActionPanel } from '@/store/windows'
import { $workbenchScope, ATUM_CHAT_WORKBENCH_SCOPE_PREFIX, resolveCaptureScope } from '@/store/workbench-tabs'

import type { NativeAppEntry } from '../../shared/skills-launcher'
import { OFFICE_APPS, officeKindForPath } from '../../shared/skills-launcher'

import { isDesktopFsRemoteMode } from './desktop-fs'

export type NativeOfficeRouteResult = 'failed' | 'opened' | 'stale' | 'unavailable'

interface NativeOfficeContext {
  epoch: number
  ownerKey: string
  scopeKey: string
}

function currentContext(scopeKey: string): NativeOfficeContext | null {
  const owner = $actionPanelOwner.get()
  const currentScope = $workbenchScope.get()

  if (!ownsActionPanel() || !$atumShellEnabled.get() || !owner || !currentScope.startsWith(ATUM_CHAT_WORKBENCH_SCOPE_PREFIX) ||
    resolveCaptureScope(scopeKey) !== resolveCaptureScope(currentScope)) {
    return null
  }

  return { epoch: $actionPanelEpoch.get(), ownerKey: panelOwnerKey(owner), scopeKey: currentScope }
}

function stillCurrent(context: NativeOfficeContext): boolean {
  const current = currentContext(context.scopeKey)

  return Boolean(current && current.epoch === context.epoch && current.ownerKey === context.ownerKey &&
    resolveCaptureScope(current.scopeKey) === resolveCaptureScope(context.scopeKey))
}

export function nativeOfficeBundleForPath(filePath: string): string | null {
  const kind = officeKindForPath(filePath)

  return kind && kind !== 'word' ? OFFICE_APPS[kind].bundleId : null
}

/** Called only from an explicit local-file action, never while restoring a preview. */
export function routesToNativeOffice(filePath: string, knownLocalFile = false, scopeKey = $workbenchScope.get()): boolean {
  return Boolean(window.hermesDesktop?.nativeApps && currentContext(scopeKey) && nativeOfficeBundleForPath(filePath) &&
    (knownLocalFile || !isDesktopFsRemoteMode()) && filePath.startsWith('/'))
}

/**
 * Resolves the installed bundle immediately before an explicit launch. A stale
 * panel/scope can never turn a completed inventory read into a native launch.
 */
export async function tryOpenNativeOfficeDocument(filePath: string, knownLocalFile = false, scopeKey = $workbenchScope.get()): Promise<NativeOfficeRouteResult> {
  const bundleId = nativeOfficeBundleForPath(filePath)
  const context = currentContext(scopeKey)
  const bridge = window.hermesDesktop?.nativeApps

  if (!bundleId || !bridge || !context || !(knownLocalFile || !isDesktopFsRemoteMode()) || !filePath.startsWith('/')) {
    return 'unavailable'
  }

  let apps: NativeAppEntry[]

  try {
    apps = await bridge.list()
  } catch {
    return stillCurrent(context) ? 'unavailable' : 'stale'
  }

  if (!stillCurrent(context)) {return 'stale'}
  const app = apps.find(candidate => candidate.bundleId === bundleId)

  if (!app) {return 'unavailable'}

  let result

  try {
    result = await openNativeAppDocument(app, filePath, context.scopeKey)
  } catch {
    return stillCurrent(context) ? 'failed' : 'stale'
  }

  if (!stillCurrent(context)) {return 'stale'}

  return result ? 'opened' : 'failed'
}
