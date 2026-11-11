import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import type { MatrixSubscriptionFallback } from '../../shared/matrix-subscription-fallback'
import { matrixSubscriptionProviderLabel } from '../../shared/matrix-subscriptions'

import { useModelPickerCopy } from './model-picker-copy'

const WHY: Record<MatrixSubscriptionFallback['reason'], 'offline' | 'limit' | 'slow' | 'other'> = {
  offline: 'offline',
  rate_limited: 'limit',
  timeout: 'slow',
  refused: 'other',
  grant_invalid: 'other',
  unattended: 'other'
}

/**
 * The one faint line under an answer a fallback model gave (agent-turns/1.7): it says only that,
 * in the reader's words; the tooltip names which plan could not answer. Never a cost or a model
 * price: the owner's 2026-11-11 rule.
 */
export function SubscriptionFallbackLine({
  fallback,
  className
}: {
  fallback: MatrixSubscriptionFallback
  className?: string
}) {
  const words = useModelPickerCopy()
  const plan = matrixSubscriptionProviderLabel(fallback.plan === 'chatgpt' ? 'openai-codex' : 'opencode-go')

  return (
    <Tip label={words.fallbackWhy[WHY[fallback.reason]](plan)}>
      <span
        className={cn('w-fit text-xs text-(--atum-ink-faint)', className)}
        data-matrix-subscription-fallback={fallback.plan}
        tabIndex={0}
      >
        {words.fallbackAnswer}
      </span>
    </Tip>
  )
}
