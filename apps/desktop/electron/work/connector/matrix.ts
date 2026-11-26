import type { MatrixSdkCommand } from '../../../shared/matrix'

import type { Answer } from './contract'
import type { ConnectorPorts } from './service'

/** The owner's SDK host: the existing `human` host of the Matrix composition (`host.queue.command`). */
export interface OwnerSdkHost {
  userId: string
  command(command: MatrixSdkCommand): Promise<unknown>
}

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
    async resolve(principal) {
      const owner = host()
      const agent = await input.agent(principal)

      if (!agent || !input.current()) {
        return undefined
      }

      const room = await owner.command({ kind: 'findAssistantRoom', ownerId: owner.userId, agentId: agent })

      return typeof room === 'string' && input.current() ? { room, agent } : undefined
    },
    async send(r) {
      const event = await host().command({
        kind: 'sendWorkQuestion',
        roomId: r.room,
        agentId: r.agent,
        question: r.request.question!,
        requestId: r.request.request_id,
        threadId: r.thread,
        transactionId: r.transaction
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
