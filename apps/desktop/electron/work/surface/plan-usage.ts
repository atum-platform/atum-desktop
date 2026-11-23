import { z } from 'zod'

import type { WorkRelayLimit } from '../../../shared/matrix-work-relay'

import { readWorkProviders } from './provider-config'

const usageWindow = z.object({
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.string().optional(),
  windowDurationMins: z.number().int().positive().optional(),
  modelIds: z.array(z.string()).optional(),
  providerIds: z.array(z.string()).optional()
})

const WORK_PLAN_BY_DRIVER = { codex: 'codex', claudeAgent: 'claude' } as const

const providerStatus = z.object({
  driver: z.enum(['codex', 'claudeAgent']),
  instanceId: z.string(),
  enabled: z.boolean(),
  usageLimits: z.object({
    checkedAt: z.string(),
    windows: z.array(z.unknown()),
    unavailable: z.unknown().optional()
  })
})

type Usage = WorkRelayLimit & { windowStart?: number }

/** Keep only the most used account-wide window on the default plan instance. */
export function projectPlanUsage(providers: unknown, now: number): Usage[] {
  if (!Array.isArray(providers)) {return []}

  return providers.flatMap(value => {
    const parsed = providerStatus.safeParse(value)

    if (!parsed.success) {return []}

    const { driver, instanceId, enabled, usageLimits } = parsed.data
    const observedAt = Date.parse(usageLimits.checkedAt)

    if (!enabled || instanceId !== driver || usageLimits.unavailable || !Number.isFinite(observedAt)) {return []}

    const windows = usageLimits.windows.flatMap(value => {
      const window = usageWindow.safeParse(value)

      if (!window.success || window.data.modelIds?.length || window.data.providerIds?.length) {return []}

      const reset = Date.parse(window.data.resetsAt ?? '')

      if (Number.isFinite(reset) && reset <= now) {return []}

      return [{ ...window.data, reset: Number.isFinite(reset) ? reset : undefined }]
    }).sort((a, b) => b.usedPercent - a.usedPercent || (a.reset ?? Infinity) - (b.reset ?? Infinity))

    const window = windows[0]

    if (!window) {return []}

    const { usedPercent, reset: resetsAt, windowDurationMins } = window
    const windowStart = resetsAt !== undefined && windowDurationMins ? resetsAt - windowDurationMins * 60_000 : undefined

    return [{
      plan: WORK_PLAN_BY_DRIVER[driver], state: usedPercent === 100 ? 'exhausted' : 'available',
      observedAt, usedPercent, resetsAt, windowStart: windowStart !== undefined && windowStart <= now ? windowStart : undefined
    }]
  })
}

export async function readPlanUsage(origin: string, owner: Parameters<typeof readWorkProviders>[1]): Promise<Usage[]> {
  return projectPlanUsage(await readWorkProviders(origin, owner), Date.now())
}
