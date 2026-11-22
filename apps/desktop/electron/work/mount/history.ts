import type { HistoricalMessage } from '../gate/handoff-helper.cjs'
import type { RelayHistory } from '../gate/relay'

import type { OwnerEventSource, OwnerSdkHost } from './owner-event'

/** Main resolves the canonical DM afresh, then pages the existing owner SDK host. */
export function createWorkHistory(source: OwnerEventSource, host: () => OwnerSdkHost | undefined): RelayHistory {
  return {
    async read(input) {
      const owner = source.ownerUserId()
      const agent = await source.agentUserId(input.agentPrincipal)

      if (!owner || !agent || (await source.assistantRoom({ ownerId: owner, agentId: agent })) !== input.roomId) {
        throw new Error('work_history_wrong_room')
      }

      const sdk = host()

      if (!sdk || sdk.userId !== owner) {
        throw new Error('work_history_account_changed')
      }

      const rows = await sdk.command({
        kind: 'readWorkHistory',
        roomId: input.roomId,
        before: input.before,
        after: input.after,
        floor: input.floor
      })

      if (source.ownerUserId() !== owner || host() !== sdk || !Array.isArray(rows)) {
        throw new Error('work_history_account_changed')
      }

      return rows as HistoricalMessage[]
    }
  }
}
