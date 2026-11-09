import { markAppViewAttached, setAppViewRect } from './app-view-overlay'

/**
 * Attachment bookkeeping for `$attachedAppViews`, gated on main's answer.
 *
 * Main paints a `WebContentsView` until it processes the visibility IPC, so
 * the renderer must not count a view as detached before that answer. An
 * attach counts immediately (overcounting only keeps floating surfaces away
 * a little longer); a detach counts only once the request settles, and a
 * per-view generation makes a late answer to an older request harmless:
 * only the newest request for a view may clear it.
 */
const generations = new Map<string, number>()

export function trackAppViewAttachment(viewId: string, attached: boolean, request: () => Promise<unknown>): Promise<void> {
  const generation = (generations.get(viewId) ?? 0) + 1

  generations.set(viewId, generation)

  if (attached) {markAppViewAttached(viewId, true)}

  const current = () => generations.get(viewId) === generation

  return request().then(
    result => {
      // An `{error}` answer means main has no such view (closed, revoked, or
      // never opened): nothing is painted for it, whichever way we asked.
      const missing = typeof result === 'object' && result !== null && 'error' in result

      if (current() && (!attached || missing)) {markAppViewAttached(viewId, false)}

      if (current() && missing) {setAppViewRect(viewId, null)}
    },
    () => {
      // A transport failure is ambiguous for an attach (main may have painted
      // the view), so it stays counted; a detach that failed to reach main is
      // answered by the next request or the unmount.
      if (current() && !attached) {markAppViewAttached(viewId, false)}
    })
}

export function resetAppViewAttachmentForTests(): void {
  generations.clear()
}
