import type { ComponentProps } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import type { MatrixFundsKind } from '../../../shared/matrix-funds'
import { matrixFundsCopy } from '../../../shared/matrix-funds-copy'
import { openAssistantCard } from '../assistant-card/store'

import { openFundsTopUp } from './top-up-request'

export interface FundsLineProps extends Omit<ComponentProps<'span'>, 'children'> {
  /** The one short sentence; never a balance or a number on a chat line. */
  text: string
  /** The one action; absent when there is nothing the reader can do here. */
  action?: string
  onAction?: () => void
}

/**
 * Atum's one quiet line where a person runs into money: the sentence and one small capsule button
 * beside it (owner, 2026-11-11: pay in place, never "go to Protons to top up").
 */
export function FundsLine({ action, className, onAction, text, ...props }: FundsLineProps) {
  return (
    <span className={cn('inline', className)} data-funds-line {...props}>
      {text}
      {action && onAction && (
        <Button
          className="ms-2 rounded-full align-baseline"
          data-funds-action
          onClick={onAction}
          size="sm"
          type="button"
          variant="secondary"
        >
          {action}
        </Button>
      )}
    </span>
  )
}

/**
 * A room's agent notice about money, in the reader's language: out of Protons opens the top-up in
 * place; the assistant's own daily limit opens its card, where the limit is set.
 */
export function FundsNoticeLine({ agentPrincipal, kind }: { agentPrincipal?: string; kind: MatrixFundsKind }) {
  const { locale } = useI18n()
  const copy = matrixFundsCopy(locale)

  if (kind === 'daily_cap') {
    return (
      <FundsLine
        action={agentPrincipal ? copy.raiseLimit : undefined}
        data-funds-kind={kind}
        onAction={agentPrincipal ? () => openAssistantCard({ kind: 'agent', principal: agentPrincipal }) : undefined}
        text={copy.dailyCap}
      />
    )
  }

  return (
    <FundsLine action={copy.addProtons} data-funds-kind={kind} onAction={() => openFundsTopUp()} text={copy.outOfProtons} />
  )
}
