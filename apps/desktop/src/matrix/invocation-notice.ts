import type { MatrixInvocationResult } from '../../shared/matrix'
import { matrixActionCopy } from '../../shared/matrix-action-copy'

/** What a run's outcome says, in the window's language. */
export function invocationCopy(result: MatrixInvocationResult, locale: keyof typeof matrixActionCopy): string {
  const copy = matrixActionCopy[locale]

  return {
    cancelled: copy.actionCancelled,
    ignored: copy.actionIgnored,
    expired: copy.actionExpired,
    unknown: copy.actionUnknown,
    publication_pending: copy.actionPending,
    published: copy.actionPublished,
    setup_required: copy.actionSetupRequired
  }[result.state]
}

/**
 * A reply that posted is already on screen: saying so again ("Reply posted.") is stray text
 * that never goes away. Only a screen reader hears it. Every other outcome (nothing ran, it
 * expired, it is still waiting to post) is news the chat does not show, so it stays visible.
 */
export function invocationNoticeVisible(state: MatrixInvocationResult['state']): boolean {
  return state !== 'published'
}
