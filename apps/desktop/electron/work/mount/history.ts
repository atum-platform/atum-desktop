import type { HistoricalMessage } from '../gate/handoff-helper.cjs'
import type { RelayHistory } from '../gate/relay'

import type { OwnerEventSource, OwnerSdkHost } from './owner-event'

/** Main resolves the canonical DM afresh, then pages the existing owner SDK host. */
export function createWorkHistory(source: OwnerEventSource, host: () => OwnerSdkHost | undefined): RelayHistory {
  return {
    async boundary(input) {
      const rows = await createWorkHistory(source, host).read({ ...input, before: '', after: null, floor: null, boundaryOnly: true } as Parameters<RelayHistory['read']>[0] & { boundaryOnly: boolean })
      const boundary = (rows as unknown as { boundary?: string }).boundary

      if (!boundary) {throw new Error('work_history_boundary_unavailable')}

      return boundary
    },
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
        ...((input as { boundaryOnly?: boolean }).boundaryOnly ? { boundaryOnly: true } : {}),
        roomId: input.roomId,
        before: input.before,
        after: input.after,
        floor: input.floor
      })

      if (source.ownerUserId() !== owner || host() !== sdk || (!Array.isArray(rows) && !(rows && typeof rows === 'object' && Array.isArray((rows as { messages?: unknown }).messages)))) {
        throw new Error('work_history_account_changed')
      }

      return rows as HistoricalMessage[] | { messages: HistoricalMessage[]; omittedMessages: number; omittedBytes: number; truncated: boolean }
    }
  }
}
