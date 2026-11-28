import { z } from 'zod'

import type { WorkAgentPlans } from '../../../shared/matrix-work'
import type { WorkRelayPlan } from '../../../shared/matrix-work-relay'

import { WorkRelaySelectionSchema } from './plan-contract'
import { deviceServiceCall, type DeviceServicePlatformOptions } from './platform'

const selectionSnapshot = z.object({
  revision: z.number().int().nonnegative(),
  selection: WorkRelaySelectionSchema.omit({ revision: true }).nullable()
}).strict()

/** The native plan catalog and the existing owner-scoped selection protocol. */
export function createOwnerRelay(
  readCatalog: () => Promise<Omit<WorkAgentPlans, 'selection'> | null>,
  platform: () => DeviceServicePlatformOptions
) {
  async function readSelection(call: ReturnType<typeof deviceServiceCall>, principal: string) {
    return selectionSnapshot.parse(await call('work_selection_read', { agentPrincipal: principal }))
  }

  return {
    async readPlans(principal: string): Promise<WorkAgentPlans | null> {
      const catalog = await readCatalog()

      if (!catalog) {return null}

      const { revision, selection } = await readSelection(deviceServiceCall(platform()), principal)

      return { ...catalog, selection: selection && { ...selection, revision } }
    },
    async select(principal: string, model: string, plan: WorkRelayPlan = 'codex') {
      const options = platform()
      // The read, write and possible retry all belong to the same signed-in owner.
      const bearer = await options.bearer()
      const call = deviceServiceCall({ ...options, bearer: async () => bearer })

      const write = async (expectedRevision: number) => WorkRelaySelectionSchema.parse(
        await call('work_selection_set', {
          agentPrincipal: principal, expectedRevision, selection: { provider: 'atum-work', plan, model }
        })
      )

      const { revision } = await readSelection(call, principal)

      try {
        return await write(revision)
      } catch (error) {
        // The selection write's only 409 is a revision conflict. A concurrent pick can win again.
        if (!(error instanceof Error && 'status' in error && error.status === 409)) {
          throw error
        }

        const latest = await readSelection(call, principal)

        if (latest.revision === revision) {
          throw error
        }

        return write(latest.revision)
      }
    }
  }
}
