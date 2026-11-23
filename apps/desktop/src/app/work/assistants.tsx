import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { Switch } from '@/components/ui/switch'
import { X } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixWorkAgentActivity, MatrixWorkAssistants, MatrixWorkBridge } from '../../../shared/matrix-work'

import type { WorkWords } from './copy'
import { $workBandOpen, $workEnrollmentDeferred, deferWorkEnrollment } from './store'

type Shown = Exclude<MatrixWorkAssistants, 'not_enrolled'>

/** Which states hold new work for a while (a soft dot), and which can be fixed from here. */
const DOT: Record<Shown, 'ink' | 'muted' | 'none'> = {
  needs_grant: 'none',
  on: 'ink',
  off: 'none',
  holding: 'muted',
  stale: 'muted',
  unreachable: 'muted'
}

export interface WorkAgentNames {
  name(principal: string): string
}

function namesOf(agents: MatrixWorkAgentActivity[], names: WorkAgentNames): string[] {
  return agents.filter(agent => agent.running > 0).map(agent => names.name(agent.principal))
}

/** The title bar's one Work control: a quiet state you can read at a glance. Opens the band below. */
export function WorkAssistantsPill({
  agents,
  copy,
  names,
  state
}: {
  agents: MatrixWorkAgentActivity[]
  copy: WorkWords
  names: WorkAgentNames
  state: MatrixWorkAssistants
}) {
  const open = useStore($workBandOpen)

  if (state === 'not_enrolled') {
    return null
  }

  const working = state === 'on' ? namesOf(agents, names) : []
  const label = working.length > 0 ? copy.pillWorking(working) : copy.pill[state]
  const dot = working.length > 0 ? 'ink' : DOT[state]

  return (
    <button
      aria-controls="atum-work-band"
      aria-expanded={open}
      className={cn('ak-btn ak-btn--sm ak-btn--plain max-w-72 gap-2', open && 'bg-(--ak-fill-press)')}
      data-atum-work-assistants={state}
      data-atum-work-busy={working.length > 0 ? true : undefined}
      onClick={() => $workBandOpen.set(!open)}
      type="button"
    >
      {dot !== 'none' && (
        <span
          aria-hidden
          className={cn('ak-dot size-1.5 shrink-0', dot === 'muted' && 'bg-(--ak-ink-3)', working.length > 0 && 'animate-pulse')}
        />
      )}
      <span className="truncate">{label}</span>
    </button>
  )
}

/** D9 / T13: the Work text, once, before assistants may start anything here. */
function EnrollmentAsk({ bridge, copy }: { bridge: Pick<MatrixWorkBridge, 'allowAssistants'>; copy: WorkWords }) {
  const [busy, setBusy] = useState(false)

  return (
    <div aria-labelledby="atum-work-enroll-title" className="ak-ask max-w-[38rem]" data-atum-work-enrollment role="group">
      <div>
        <div className="ak-ask-title" id="atum-work-enroll-title">
          {copy.enrollTitle}
        </div>
        <p className="ak-ask-body">{copy.enrollBody}</p>
      </div>
      <div className="flex gap-2">
        <button
          className="ak-btn ak-btn--sm ak-btn--primary"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void bridge
              .allowAssistants()
              .then(() => $workBandOpen.set(false))
              .catch(() => {})
              .finally(() => setBusy(false))
          }}
          type="button"
        >
          {copy.allow}
        </button>
        <button className="ak-btn ak-btn--sm ak-btn--plain" onClick={deferWorkEnrollment} type="button">
          {copy.notNow}
        </button>
      </div>
    </div>
  )
}

function AgentRows({ agents, copy, names }: { agents: MatrixWorkAgentActivity[]; copy: WorkWords; names: WorkAgentNames }) {
  if (agents.length === 0) {
    return null
  }

  return (
    <ul className="mt-3 flex max-w-[38rem] flex-col gap-2" data-atum-work-agents>
      {agents.map(agent => {
        const name = names.name(agent.principal)

        return (
          <li
            className="flex items-center gap-2.5 [font:var(--ak-t-body)] text-(--ak-ink)"
            data-atum-work-agent={agent.principal}
            key={agent.principal}
          >
            <AtumAssistantAvatar className="size-5 shrink-0 text-[0.625rem]" id={agent.principal} name={name} />
            <span className="min-w-0 truncate">{agent.stopping ? copy.stopping(name) : copy.working(name, agent.running)}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** The switch, one quiet line, and who is working: the band under the title. */
function AssistantsSettings({
  agents,
  bridge,
  copy,
  names,
  state
}: {
  agents: MatrixWorkAgentActivity[]
  bridge: Pick<MatrixWorkBridge, 'reconnectAssistants' | 'setAssistants'>
  copy: WorkWords
  names: WorkAgentNames
  state: Exclude<Shown, 'needs_grant'>
}) {
  const [busy, setBusy] = useState(false)

  const run = (action: () => Promise<void>) => {
    setBusy(true)
    void action()
      .catch(() => {})
      .finally(() => setBusy(false))
  }

  return (
    <div className="max-w-[38rem]">
      <label className="flex items-center justify-between gap-4" htmlFor="atum-work-switch">
        <span className="[font:var(--ak-t-body)] font-semibold text-(--ak-ink)">{copy.switchLabel}</span>
        <Switch
          checked={state !== 'off'}
          data-atum-work-switch
          disabled={busy}
          id="atum-work-switch"
          onCheckedChange={on => run(() => bridge.setAssistants(on))}
        />
      </label>
      <p className="mt-1 [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-atum-work-line={state}>
        {copy.line[state]}
      </p>
      {state === 'unreachable' && (
        <button
          className="ak-btn ak-btn--sm mt-2"
          disabled={busy}
          onClick={() => run(() => bridge.reconnectAssistants())}
          type="button"
        >
          {copy.reconnect}
        </button>
      )}
      {state !== 'off' && <AgentRows agents={agents} copy={copy} names={names} />}
    </div>
  )
}

/**
 * The inline band under the title. Inline, not a popover: the owner view is a native layer painted above
 * the page, so anything drawn over it would be hidden. The band pushes the view down instead.
 */
export function WorkAssistantsBand({
  agents,
  bridge,
  copy,
  names,
  state
}: {
  agents: MatrixWorkAgentActivity[]
  bridge: Pick<MatrixWorkBridge, 'allowAssistants' | 'reconnectAssistants' | 'setAssistants'>
  copy: WorkWords
  names: WorkAgentNames
  state: MatrixWorkAssistants
}) {
  const open = useStore($workBandOpen)
  const deferred = useStore($workEnrollmentDeferred)
  // The enrollment text shows itself once, until "Not now"; everything else waits for the pill.
  const shown = state !== 'not_enrolled' && (open || (state === 'needs_grant' && !deferred))

  if (!shown) {
    return null
  }

  return (
    <section
      aria-label={copy.switchLabel}
      className={cn(
        'relative mx-3 mb-3 shrink-0',
        // The enrollment is its own Kit ask card; the settings are a quiet strip.
        state !== 'needs_grant' && 'rounded-(--ak-r-lg) bg-(--ak-fill-quiet) px-4 py-3.5'
      )}
      data-atum-work-band={state}
      id="atum-work-band"
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          $workBandOpen.set(false)
        }
      }}
    >
      {open && state !== 'needs_grant' && (
        <button
          aria-label={copy.close}
          className="ak-iconbtn absolute end-2 top-2 size-7"
          onClick={() => $workBandOpen.set(false)}
          type="button"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
      {state === 'needs_grant' ? (
        <EnrollmentAsk bridge={bridge} copy={copy} />
      ) : (
        <AssistantsSettings agents={agents} bridge={bridge} copy={copy} names={names} state={state} />
      )}
    </section>
  )
}
