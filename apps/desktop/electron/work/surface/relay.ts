import { WORK_RELAY_PLANS, workRelayPlan, type WorkRelayPlan, type WorkRelayReceipt, type WorkRelayRoomView, type WorkRelayStatus } from '../../../shared/matrix-work-relay'
import { WorkRelaySelectionSchema } from '../gate/contract'
import { deviceServiceCall, type DeviceServicePlatformOptions, type WorkConsentClient } from '../gate/platform'
import type { WorkMount } from '../mount/mount'

/** Owner-only adapter on the existing Work IPC. No cloud grant or T3 token crosses. */
export function createOwnerRelay(mount: WorkMount, consent: Pick<WorkConsentClient, 'read'> & Partial<Pick<WorkConsentClient, 'set'>>, platform: () => DeviceServicePlatformOptions) {
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

      const [account, ...others] = await Promise.all(WORK_RELAY_PLANS.map(plan =>
        consent.read(plan).catch(error => {
          if (plan === 'codex') {return consent.read()}

          if ([400, 404].includes((error as { status?: number }).status ?? 0)) {return null}
          throw error
        })))

      if (!account) {throw new Error('work_relay_account_unavailable')}
      if (mount.service() !== s) {throw new Error('work_relay_account_changed')}
      // C5 bridge: extend active UUID-scoped grants as Work learns owner agents.
      // Never revive a revoked grant or re-enable the local switch here.
      const eligible = s?.gate.state().agents.filter(agent => agent.entitled).map(agent => agent.principal) ?? []

      for (const state of [account, ...others]) {
        if (!state || state.consent.state !== 'on' || state.consent.agents === 'all' || !consent.set) {continue}
        const agents = [...new Set([...state.consent.agents, ...eligible])]

        if (agents.length === state.consent.agents.length) {continue}

        try {
          state.consent = await consent.set({ provider: state.consent.provider, agents,
            devices: [...state.consent.devices], alsoWhenScheduled: state.consent.alsoWhenScheduled })
        } catch { /* Keep availability readable; the next read retries consent sync. */ }
      }

      account.facts = [account, ...others].flatMap(state => state?.facts ?? [])
      // Zod's union inference marks this key optional under the Electron compiler;
      // the strict record parser above has already required and validated it.
      const accountView = { ...account, consent: { ...account.consent, agents: account.consent.agents! } }

      // Account-wide model availability does not depend on this Mac enrolling this agent.
      if (!s || !s.ledger.agent(principal)?.entitled) {return { account: accountView, status: null, turns: [] }}
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
        turns.push({ eventId: frozen.input.event_id as string, plan: workRelayPlan(frozen.selection.instanceId), sentAt: row.createdAt, receipt: await s.gate.relay.request(ctx, row.requestId) as unknown as WorkRelayReceipt })
      }

      if (mount.service() !== s) {throw new Error('work_relay_account_changed')}

      return { account: accountView, status, turns }
    },
    async select(principal: string, expectedRevision: number, model: string, plan: WorkRelayPlan = 'codex') {
      const saved = WorkRelaySelectionSchema.parse(await deviceServiceCall(platform())('work_selection_set', {
        agentPrincipal: principal, expectedRevision, selection: { provider: 'atum-work', plan, model }
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
