import { useI18n } from '@/i18n'

import { agentConversationCopy } from '../../shared/agent-conversation/copy'
import type { MatrixConversationView } from '../../shared/agent-conversation/view'

/**
 * Only a move that stopped for good asks anything of the owner: an automatic pick that ran out
 * of quiet retries, or a rollback only Try again clears. A move whose markers are written is
 * resumed by the minute pass and stays silent.
 */
export function conversationNeedsRetry(view: MatrixConversationView | undefined): boolean {
  return Boolean(view && view.state === 'retry' && view.reason !== 'effects_pending')
}

/** One plain line in the agent's chat: what did not finish, and the one action that may fix it. */
export function ConversationRetryLine({
  onRetry,
  view
}: {
  onRetry(): void
  view: MatrixConversationView | undefined
}) {
  const { locale } = useI18n()

  if (!view || !conversationNeedsRetry(view)) {
    return null
  }

  const copy = agentConversationCopy(locale)

  return (
    <p
      className="flex flex-wrap items-center gap-x-2 py-1.5 text-[0.8125rem] text-(--atum-ink-muted)"
      data-matrix-conversation-retry={view.reason ?? true}
    >
      <span>{copy.stuck}</span>
      <button
        className="font-medium text-(--atum-ink) underline underline-offset-2"
        onClick={onRetry}
        type="button"
      >
        {copy.retry}
      </button>
    </p>
  )
}
