import { useStore } from '@nanostores/react'
import { CloudIcon } from 'lucide-react'
import { useEffect } from 'react'

import { $work } from '@/app/work/store'
import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import type { MatrixAgentView } from '../../shared/matrix'
import { matrixAgentAnswersInCloud } from '../../shared/matrix-agent-actions'

import { type AgentPlace, agentPlace } from './agent-place'
import { useAgentPlaceLabel } from './agent-place-copy'
import {
  $agentPlans,
  agentPlansKey,
  agentPlansShownSelection,
  beginAgentPlansRead,
  failAgentPlansRead,
  settleAgentPlansRead
} from './agent-plans-store'
import { MachineIcon } from './machine-icon'

/** The scope every picker keys its plan read by (composer chip, card Model row, agent desk). */
export function agentPlacePlansKey(accountUserId: string | undefined, agentPrincipal: string): string {
  return agentPlansKey(`account:${accountUserId ?? 'signed-out'}`, agentPrincipal)
}

/** One read per agent per change of Work's plan facts, however many rows and headers show it. */
const asked = new Map<string, string>()

/** Tests only. */
export function resetAgentPlaceReadsForTests(): void {
  asked.clear()
}

/**
 * Where the agent is working, from the plan read the pickers already share (agent-plans-store.ts).
 * A cloud agent with no read yet gets one here, so a roster row for an agent whose chat was never
 * opened can still show its place; the read lands in the same entry the pickers use.
 */
export function useAgentPlace(
  agent: Pick<MatrixAgentView, 'answering' | 'home' | 'macRole' | 'principal'>,
  accountUserId: string | undefined
): AgentPlace | undefined {
  const key = agentPlacePlansKey(accountUserId, agent.principal)
  const entry = useStore($agentPlans)[key]
  const work = useStore($work)
  const read = window.atumMatrix?.work?.readAgentPlans
  const needsRead = Boolean(read && accountUserId && agent.home?.lives.kind !== 'mac' && matrixAgentAnswersInCloud(agent))
  const token = `${work?.planStatusRevision ?? ''}|${work?.view ?? ''}`

  useEffect(() => {
    if (!needsRead || !read || asked.get(key) === token) {
      return
    }

    asked.set(key, token)
    const started = beginAgentPlansRead(key)
    void read(agent.principal).then(
      value => settleAgentPlansRead(started, value),
      () => failAgentPlansRead(started)
    )
  }, [agent.principal, key, needsRead, read, token])

  return agentPlace({ agent, plans: entry?.value, selection: agentPlansShownSelection(entry) })
}

/**
 * The cloud or the Mac, drawn with the agent picker's machine icons (machine-icon.tsx) so both read
 * the same: muted ink, an offline Mac dimmed to 40%. Nothing at all while the place is unknown.
 */
export function AgentPlaceGlyph({ className, place }: { className?: string; place: AgentPlace }) {
  const shared = cn('size-3.5 shrink-0 text-(--atum-ink-muted)', place.kind === 'mac' && !place.online && 'opacity-40', className)

  return place.kind === 'cloud' ? (
    <CloudIcon aria-hidden className={shared} strokeWidth={1.75} />
  ) : (
    <MachineIcon aria-hidden className={shared} kind={place.machine} strokeWidth={1.75} />
  )
}

/**
 * The icon beside an assistant's name with its tooltip, and the same words in a hidden span: read
 * as text where the name is plain text, and named by `labelId` in the host's `aria-describedby`
 * where a button's own `aria-label` (the name) would hide it.
 */
export function AgentPlaceIcon({
  className,
  labelId,
  place
}: {
  className?: string
  labelId?: string
  place: AgentPlace | undefined
}) {
  const label = useAgentPlaceLabel(place)

  if (!place || !label) {
    return null
  }

  return (
    <>
      <Tip label={label}>
        <span
          className={cn('inline-flex shrink-0 items-center', className)}
          data-agent-place={place.kind}
          data-agent-place-machine={place.kind === 'mac' ? place.machine : undefined}
          data-agent-place-online={place.kind === 'mac' ? (place.online ? 'true' : 'false') : undefined}
        >
          <AgentPlaceGlyph place={place} />
        </span>
      </Tip>
      <span className="sr-only" id={labelId}>
        {label}
      </span>
    </>
  )
}

/** An assistant's place icon, read where it is drawn: a roster row, the chat header, the card. */
export function AgentPlaceFor({
  accountUserId,
  agent,
  className,
  labelId
}: {
  accountUserId: string | undefined
  agent: Pick<MatrixAgentView, 'answering' | 'home' | 'macRole' | 'principal'>
  className?: string
  labelId?: string
}) {
  return <AgentPlaceIcon className={className} labelId={labelId} place={useAgentPlace(agent, accountUserId)} />
}
