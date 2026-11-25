import type { WorkAgentPlans } from '../../../shared/matrix-work'
import type { WorkRelayPlan, WorkRelaySelection } from '../../../shared/matrix-work-relay'
import { WorkRelaySelectionSchema } from '../gate/contract'
import { deviceServiceCall, type DeviceServicePlatformOptions } from '../gate/platform'
import type { WorkMount } from '../mount/mount'

/** The native plan catalog and the existing owner-scoped selection protocol. */
export function createOwnerRelay(
  mount: WorkMount,
  readCatalog: () => Promise<Omit<WorkAgentPlans, 'selection'> | null>,
  platform: () => DeviceServicePlatformOptions
) {
  const savedSelections = new Map<string, WorkRelaySelection>()

  return {
    async readPlans(principal: string): Promise<WorkAgentPlans | null> {
      const catalog = await readCatalog()

      if (!catalog) {return null}

      const rows = JSON.parse(mount.service()?.ledger.meta('relay_selections') ?? '[]') as {
        agentPrincipal: string
        selection: unknown
      }[]

      const synced = WorkRelaySelectionSchema.safeParse(rows.find(row => row.agentPrincipal === principal)?.selection)
      const saved = savedSelections.get(principal)

      if (synced.success && (!saved || synced.data.revision >= saved.revision)) {
        savedSelections.delete(principal)

        return { ...catalog, selection: synced.data }
      }

      // A successful selection is visible immediately, even before ledger sync catches up.
      return { ...catalog, selection: saved ?? null }
    },
    async select(principal: string, expectedRevision: number, model: string, plan: WorkRelayPlan = 'codex') {
      const saved = WorkRelaySelectionSchema.parse(await deviceServiceCall(platform())('work_selection_set', {
        agentPrincipal: principal, expectedRevision, selection: { provider: 'atum-work', plan, model }
      }))

      savedSelections.set(principal, saved)

      return saved
    },
    chats(): string[] {
      return [...new Set((mount.service()?.ledger.receipts('relay_json IS NOT NULL') ?? []).filter(row => Boolean(row.threadId)).map(row => row.principal))]
    }
  }
}
