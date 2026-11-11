import { useEffect, useState } from 'react'

import type { MatrixMessage } from '../../shared/matrix'
import type { MatrixCompanyTurnMemory } from '../../shared/matrix-company-presentation'
import { matrixCompanyLineExpiresAt } from '../../shared/matrix-transient-lines'

/** How old a channel's Chief of Staff binding may be while its thread shows company markers. */
export const COMPANY_CHANNEL_BINDING_MAX_AGE_MS = 60_000

/**
 * The clock company progress lines expire by (agent-turns/1.6 presentation expiry): the time of the
 * last expiry this chat reached, moved by one timeout set for the next live line's expiry, never by
 * polling. `messages` are the chat's admitted messages; `memory` is read, never extended, here.
 */
export function useCompanyLineClock(messages: readonly MatrixMessage[], memory: MatrixCompanyTurnMemory): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const at = matrixCompanyLineExpiresAt(messages, now, memory.ended)

    if (at === undefined) {
      return
    }

    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()))

    return () => clearTimeout(timer)
  }, [memory, messages, now])

  return now
}

/**
 * A change signal for a channel's Chief of Staff binding: it moves whenever a company marker arrives
 * from a sender no view of this company has named, so the view is read again at once and, until that
 * read answers, no company line or remark is drawn as one (`useCompanyAIStatus` `refreshKey`).
 * `agentUserId` is the cached view's agent. An agent a view once named is not a stranger: after a
 * reassignment its lines are plain under the new binding, and its return is picked up by the
 * bounded-age re-read.
 */
export function useCompanyStrangerSignal(
  messages: readonly Pick<MatrixMessage, 'company' | 'id' | 'own' | 'sender'>[],
  agentUserId: string | undefined
): number {
  const [state, setState] = useState(() => ({ named: new Set<string>(), seen: new Set<string>(), count: 0 }))

  useEffect(() => {
    setState(current => {
      const named = agentUserId && !current.named.has(agentUserId) ? new Set([...current.named, agentUserId]) : current.named

      const strangers = messages.filter(
        message => message.company && !message.own && !named.has(message.sender) && !current.seen.has(message.id)
      )

      if (strangers.length === 0) {
        return named === current.named ? current : { ...current, named }
      }

      return { named, seen: new Set([...current.seen, ...strangers.map(message => message.id)]), count: current.count + 1 }
    })
  }, [agentUserId, messages])

  return state.count
}
