import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { MATRIX_MODEL_LINEUP, matrixCloudModelAlias } from '../../shared/matrix-models'
import type { MatrixGoogleRouteSwitch, MatrixSubscriptionFallback } from '../../shared/matrix-subscription-fallback'
import { matrixSubscriptionProviderLabel } from '../../shared/matrix-subscriptions'

import { useModelPickerCopy } from './model-picker-copy'

/** A fallback's reason as one of the four short phrases the reader sees. */
export const MATRIX_FALLBACK_WHY: Record<MatrixSubscriptionFallback['reason'], 'offline' | 'limit' | 'slow' | 'other'> = {
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
    <Tip label={words.fallbackWhy[MATRIX_FALLBACK_WHY[fallback.reason]](plan)}>
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

/**
 * The once-per-conversation Google switch (S2, owner 2026-11-14): one centred faint line, drawn
 * like a join or leave line, naming the Atum model that answers now. Never a bubble, a banner or a
 * cost; the transcript shows only the first one (`matrixFoldSubscriptionFallbacks`).
 */
export function GoogleSwitchLine({ switched, timestamp }: { switched: MatrixGoogleRouteSwitch; timestamp?: number }) {
  const words = useModelPickerCopy()
  const { locale } = useI18n()
  const model = matrixCloudModelAlias(switched.servedBy)
  const name = model ? MATRIX_MODEL_LINEUP.find(row => row.id === model)?.name : undefined

  const time =
    timestamp !== undefined && Number.isFinite(timestamp)
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
      : undefined

  return (
    <p
      className="py-1.5 text-center text-xs text-(--atum-ink-faint)"
      data-matrix-google-switch={model ?? 'atum'}
      role="note"
      title={time}
    >
      {words.googleSwitched(name)}
    </p>
  )
}
