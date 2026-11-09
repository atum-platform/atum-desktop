import type { PreviewTarget } from './preview'
import { registerWorkbenchTabDisposer } from './workbench-tabs'

/** A consumer-file viewer target. The viewer itself is a main-owned view, so
 * the target carries only an opaque token — never a path or a loadable URL. */
export const ATUM_FILE_VIEW_URL_PREFIX = 'atum-file:'

export function atumFileViewTargetUrl(token: string): string {
  return `${ATUM_FILE_VIEW_URL_PREFIX}${token}`
}

export function isAtumFileViewTarget(target: PreviewTarget | null | undefined): target is PreviewTarget {
  return Boolean(
    target && target.kind === 'file' && target.previewKind === 'pdf' && target.url.startsWith(ATUM_FILE_VIEW_URL_PREFIX)
  )
}

export function atumFileViewToken(target: PreviewTarget): null | string {
  return isAtumFileViewTarget(target) ? target.url.slice(ATUM_FILE_VIEW_URL_PREFIX.length) || null : null
}

// Whatever removes a viewer tab — close, scope teardown, eviction, reset —
// takes the view away and hands the token back.
registerWorkbenchTabDisposer(tab => {
  if (tab.surface.kind !== 'preview') {
    return
  }

  const token = atumFileViewToken(tab.surface.target) ?? tab.surface.target.contextFile?.token

  if (token) {
    void window.hermesDesktop?.atumPdfView?.close(token).catch(() => undefined)
    void window.hermesDesktop?.consumerFiles?.releaseView(token).catch(() => undefined)
  }
})
