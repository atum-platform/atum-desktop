import type { WorkRelayReceipt, WorkRelayRoomView, WorkRelayStatus } from '../../../shared/matrix-work-relay'
import { WorkRelaySelectionSchema } from '../gate/contract'
import { deviceServiceCall, type DeviceServicePlatformOptions, type WorkConsentClient } from '../gate/platform'
import type { WorkMount } from '../mount/mount'

/** Owner-only adapter on the existing Work IPC. No cloud grant or T3 token crosses. */
export function createOwnerRelay(mount: WorkMount, consent: Pick<WorkConsentClient, 'read'>, platform: () => DeviceServicePlatformOptions) {
  const service = () => {
    const value = mount.service()

    if (!value) {throw new Error('work_relay_unavailable')}

    return value
  }

  const context = (principal: string) => {
    const s = service(), agent = s.ledger.agent(principal)

    if (!agent?.entitled) {throw new Error('work_relay_not_entitled')}

    return { principal, routeEpoch: s.ledger.routeEpoch(), generation: agent.generation }
  }

  return {
    async read(principal: string, roomId: string): Promise<WorkRelayRoomView> {
      const s = mount.service()
      const account = await consent.read()

      if (!s) {return { account, status: null, turns: [] }}
      const ctx = context(principal)
      const status = await s.gate.relay.status(ctx, roomId) as unknown as WorkRelayStatus
      // Display keeps the last synced selection even when admission is fenced/offline.
      const selections = JSON.parse(s.ledger.meta('relay_selections') ?? '[]') as { agentPrincipal: string; selection: unknown }[]
      const selected = WorkRelaySelectionSchema.safeParse(selections.find(each => each.agentPrincipal === principal)?.selection)
      if (selected.success) {status.selection = selected.data}
      const turns = []

      for (const row of s.ledger.receipts('principal = ? AND relay_json IS NOT NULL', principal)) {
        const frozen = JSON.parse(row.relayJson!)

        if (frozen.input.room_id !== roomId) {continue}
        turns.push({ eventId: frozen.input.event_id as string, sentAt: row.createdAt, receipt: await s.gate.relay.request(ctx, row.requestId) as unknown as WorkRelayReceipt })
      }

      if (mount.service() !== s) {throw new Error('work_relay_account_changed')}

      return { account, status, turns }
    },
    async select(principal: string, expectedRevision: number, model: string) {
      const saved = WorkRelaySelectionSchema.parse(await deviceServiceCall(platform())('work_selection_set', {
        agentPrincipal: principal, expectedRevision, selection: { provider: 'atum-work', plan: 'codex', model }
      }))

      return saved
    },
    async stop(roomId: string, eventId: string) {
      const s = service()
      const rows = s.ledger.receipts('event_id = ? AND relay_json IS NOT NULL', eventId)

      for (const row of rows) {
        const frozen = JSON.parse(row.relayJson!)

        if (frozen.input.room_id !== roomId) {continue}
        const ctx = context(row.principal)
        const status = await s.gate.relay.status(ctx, roomId) as unknown as WorkRelayStatus

        if (status.openOperation?.eventId !== eventId) {continue}
        await s.gate.relay.stop(ctx, roomId, eventId)

        return
      }

      throw new Error('work_relay_stop_target_unavailable')
    },
    chats(): string[] {
      return [...new Set((mount.service()?.ledger.receipts('relay_json IS NOT NULL') ?? []).filter(row => Boolean(row.threadId)).map(row => row.principal))]
    }
  }
}
