import { AtumAtom } from '@/components/brand/atum-atom'
import { Check } from '@/lib/icons'

import type { MatrixAgentView, MatrixMessage } from '../../shared/matrix'

import { matrixProgressLineParts } from './agent-desk-model'

/**
 * Atum working in place: the animated atom owns the identity slot. A progress event's first line
 * is the current step; any remaining lines become the quiet step card. The line is the turn's
 * transient `io.atum.progress` notice, never a separate status message; the transcript hides it
 * as soon as the turn ends.
 */
export function MatrixAgentWorking({
  line,
  label,
  typing
}: {
  agent?: MatrixAgentView
  avatarMxc?: null | string
  id: string
  line?: MatrixMessage
  name: string
  label: string
  typing: boolean
}) {
  const { current, steps } = matrixProgressLineParts(line?.body)

  return (
    <div
      aria-label={label}
      className="flex items-start gap-(--ak-s2) py-(--ak-s2)"
      data-matrix-agent-typing={typing || undefined}
      data-matrix-agent-working
      role="status"
    >
      <span className="flex w-(--atum-avatar-md) shrink-0 justify-center pt-(--ak-s1)">
        <AtumAtom className="ak-icon text-(--ak-ink-2)" data-working />
      </span>
      {current && (
        <div className="grid max-w-(--composer-width) gap-(--ak-s1)" data-matrix-progress-line>
          <p className="whitespace-pre-wrap [font:var(--ak-t-body)] text-(--ak-ink-2)">{current}</p>
          {steps.length > 0 && (
            <ul className="grid gap-(--ak-s1) rounded-(--ak-r-lg) bg-(--ak-fill-quiet) p-(--ak-s2)" data-matrix-steps-list>
              {steps.map((step, index) => (
                <li className="flex items-center gap-(--ak-s2) [font:var(--ak-t-caption)] text-(--ak-ink-3)" key={`${step.text}:${index}`}>
                  {step.done ? (
                    <Check aria-hidden className="ak-icon ak-icon--sm" />
                  ) : (
                    <span aria-hidden className="size-(--ak-i-sm) rounded-full border border-dotted border-(--ak-ink-3)" />
                  )}
                  <span>{step.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
