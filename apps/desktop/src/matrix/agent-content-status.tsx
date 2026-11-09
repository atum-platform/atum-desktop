import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'

import type { MatrixAgentContentSkillState, MatrixAgentView } from '../../shared/matrix'

import { agentContentCopy } from './agent-content-copy'
import { focusDialogField, MatrixDialogHeader } from './dialog-header'

/** Read-only importer metadata, opened explicitly from the agent's action menu. */
export function AgentContentDetails({
  agent,
  name,
  onCloseAutoFocus,
  onOpenChange,
  open
}: {
  agent: MatrixAgentView
  name: string
  onCloseAutoFocus?(event: Event): void
  onOpenChange(open: boolean): void
  open: boolean
}) {
  const { locale } = useI18n()
  const copy = agentContentCopy[locale]
  const content = agent.content

  // Promoted primaries may have imported content too. Missing is not success.
  if (!content) {
    return null
  }

  const { state, skills, persona, checkedAt } = content
  const label = copy.title(name)

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        aria-describedby={undefined}
        className="atum-sheet max-w-sm text-(length:--atum-t-caption)"
        onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={focusDialogField}
        showCloseButton={false}
      >
        <MatrixDialogHeader title={label} />
        <p className="font-medium text-(--atum-ink)" role="status">
          {copy.states[state]}
        </p>
        <p className="mt-1 text-(--atum-ink-muted)">{copy.help}</p>
        {(state === 'checking' || state === 'error') && checkedAt !== undefined && (
          <p className="mt-2 text-(--atum-ink-muted)">{copy.lastCounts}</p>
        )}
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
          {persona && (
            <>
              <dt>{copy.persona}</dt>
              <dd className="max-w-36 text-right">{copy.personas[persona]}</dd>
            </>
          )}
          {skills && (
            <>
              <dt>{copy.skills}</dt>
              <dd>{skills.declared}</dd>
              {Object.entries(copy.counts).map(([key, title]) => {
                const count = skills[key as MatrixAgentContentSkillState]

                return count ? (
                  <div className="contents" key={key}>
                    <dt>{title}</dt>
                    <dd>{count}</dd>
                  </div>
                ) : null
              })}
              {skills.installedNow > 0 && (
                <>
                  <dt>{copy.newSkills}</dt>
                  <dd>{skills.installedNow}</dd>
                </>
              )}
            </>
          )}
        </dl>
        {skills?.receiptReset && <p className="mt-2 text-(--atum-ink-muted)">{copy.receiptReset}</p>}
        {checkedAt !== undefined && (
          <p className="mt-3 text-(--atum-ink-muted)">
            {copy.checked}:{' '}
            <time dateTime={new Date(checkedAt).toISOString()}>
              {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(checkedAt)}
            </time>
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The edit sheet's line about what this assistant has on this Mac (Advanced, launch night):
 * one sentence — ready, checking, or how many skills are not here yet — and Details.
 */
export function AgentContentSummary({ agent, name }: { agent: MatrixAgentView; name: string }) {
  const { locale } = useI18n()
  const copy = agentContentCopy[locale]
  const [open, setOpen] = useState(false)
  const content = agent.content

  if (!content) {
    return null
  }

  const missing = content.skills?.missing ?? 0
  const line = content.state === 'incomplete' && missing > 0 ? copy.missingSkills(missing) : copy.states[content.state]

  return (
    <div className="flex flex-wrap items-center gap-x-2 text-(length:--atum-t-caption) text-(--atum-ink-muted)" data-matrix-agent-content>
      <span role="status">{line}</span>
      <Button onClick={() => setOpen(true)} size="inline" variant="textStrong">
        {copy.details}
      </Button>
      <AgentContentDetails agent={agent} name={name} onOpenChange={setOpen} open={open} />
    </div>
  )
}
