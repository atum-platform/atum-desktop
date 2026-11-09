import type * as React from 'react'

import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Cloud, DeviceDesktop } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { ExecutionDestinationView, ExecutionStatusSnapshot } from '../../shared/execution-policy'
import { executionDestinationViews } from '../../shared/execution-policy'

import { executionMachineLabel, executionMachinesCopy, executionMachineWaitsForPlan } from './execution-machines-copy'

export interface MatrixExecutionMachinesProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  status: ExecutionStatusSnapshot
}

function tone(view: ExecutionDestinationView): string {
  if (view.state === 'working') {
    return 'text-(--atum-accent)'
  }

  // Held for the owner's plan (0238): waiting, not broken, so it is not painted as a fault.
  if (executionMachineWaitsForPlan(view)) {
    return 'text-(--atum-ink-muted)'
  }

  if (view.state === 'degraded') {
    return 'text-(--atum-danger)'
  }

  if (view.state === 'offline' || view.state === 'disabled') {
    return 'text-(--atum-ink-muted) opacity-50'
  }

  return view.desired ? 'text-(--atum-ink)' : 'text-(--atum-ink-soft)'
}

export interface MatrixExecutionDestinationMarkProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  view: ExecutionDestinationView
}

/**
 * One destination's icon with the working dot and the state colour. The every-destination strip and
 * the closed title-bar trigger (which shows exactly one) share it so the two can never drift.
 */
export function MatrixExecutionDestinationMark({ className, view, ...props }: MatrixExecutionDestinationMarkProps) {
  const { locale } = useI18n()
  const Icon = view.kind === 'cloud' ? Cloud : DeviceDesktop

  return (
    <span
      aria-label={executionMachineLabel(locale, view)}
      className={cn(
        'relative grid size-6 shrink-0 place-items-center rounded-md transition-colors motion-reduce:transition-none',
        tone(view),
        className
      )}
      data-current={view.current || undefined}
      data-desired={view.desired || undefined}
      data-destination-kind={view.kind}
      data-destination-state={view.state}
      data-destination-waiting={executionMachineWaitsForPlan(view) || undefined}
      data-enabled={view.enabled}
      role="img"
      {...props}
    >
      <Icon aria-hidden className="size-4" strokeWidth={1.7} />
      {view.state === 'working' && (
        <span
          aria-hidden
          className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-current motion-safe:animate-pulse"
          data-execution-working
        />
      )}
    </span>
  )
}

/**
 * Read-only U13-MACHINES projection. It renders only a provider-validated
 * `atum.execution-status/1` snapshot; it never infers policy from legacy cloud/local flags.
 * The adjacent control owns policy edits while this strip remains presentation-only.
 */
export function MatrixExecutionMachines({ className, status, ...props }: MatrixExecutionMachinesProps) {
  const { locale } = useI18n()
  const copy = executionMachinesCopy(locale)

  return (
    <div
      aria-label={copy.group}
      className={cn('flex shrink-0 items-center gap-1', className)}
      data-execution-machines
      data-execution-state={status.state}
      role="group"
      {...props}
    >
      {executionDestinationViews(status).map(view => (
        <Tip key={view.id} label={executionMachineLabel(locale, view)} side="bottom">
          <MatrixExecutionDestinationMark view={view} />
        </Tip>
      ))}
    </div>
  )
}
