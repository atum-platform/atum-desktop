import type { OwnerSdkHost } from '../mount/owner-event'

import type { Answer } from './contract'
import type { ConnectorPorts } from './service'

export function matrixConnector(input: {
  owner(): OwnerSdkHost | undefined
  agent(principal: string): Promise<string | null>
  current(): boolean
  admit: ConnectorPorts['admit']
}): ConnectorPorts {
  const host = () => {
    const owner = input.owner()

    if (!owner || !input.current()) {
      throw new Error('work_account_changed')
    }

    return owner
  }

  return {
    current: input.current,
    admit: input.admit,
    async resolve(principal, protectedInput) {
      // The roster currently attests ownership only. Require route certification
      // before allowing any protected question to leave Work.
      if (protectedInput) {
        return undefined
      }

      const owner = host()
      const agent = await input.agent(principal)

      if (!agent || !input.current()) {
        return undefined
      }

      const room = await owner.command({ kind: 'findAssistantRoom', ownerId: owner.userId, agentId: agent })

      return typeof room === 'string' && input.current() ? { room, agent } : undefined
    },
    async send(r) {
      if (r.protectedInput) {
        throw new Error('work_target_route_uncertified')
      }


      const event = await host().command({
        kind: 'sendWorkQuestion',
        roomId: r.room,
        agentId: r.agent,
        question: r.request.question!,
        requestId: r.request.request_id,
        threadId: r.thread,
        transactionId: r.transaction,
        protectedInput: r.protectedInput === true
      })

      if (typeof event !== 'string' || !event.startsWith('$')) {
        throw new Error('work_send_unavailable')
      }

      return event
    },
    async read(r) {
      return (await host().command({
        kind: 'readWorkAnswer',
        roomId: r.room,
        agentId: r.agent,
        eventId: r.event!,
        requestId: r.request.request_id
      })) as Answer | undefined
    }
  }
}
