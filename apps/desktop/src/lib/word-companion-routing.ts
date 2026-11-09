import type { PreviewTarget } from '@/store/preview'
import { canPairWordCompanion, openWordCompanion } from '@/store/word-companion'
import { $workbenchScope } from '@/store/workbench-tabs'

import { isDesktopFsRemoteMode } from './desktop-fs'

/** Called only by explicit open actions, never by restored tabs or file writes. */
export function routesToWordCompanion(path: string, knownLocalFile = false, scopeKey = $workbenchScope.get()): boolean {
  return Boolean(window.hermesDesktop?.wordCompanion && canPairWordCompanion(scopeKey) &&
    (knownLocalFile || !isDesktopFsRemoteMode()) &&
    path.startsWith('/') && /\.(doc|docx)$/iu.test(path))
}

export function tryOpenWordCompanion(target: PreviewTarget, opened?: (id: string) => void): boolean {
  const path = target.path ?? target.source

  if (target.kind !== 'file' || !routesToWordCompanion(path)) {return false}
  void openWordCompanion(path, undefined, opened)

  return true
}
