/** Provider IDs for interactive Work sessions on this Mac. */
export const WORK_LOCAL_PLANS = {
  copilot: { title: 'GitHub Copilot', driver: 'acpRegistry' }
} as const

export type WorkLocalPlan = keyof typeof WORK_LOCAL_PLANS
export type WorkLocalPlanState = 'not_installed' | 'signed_out' | 'ready'
export type WorkLocalPlanStates = Partial<Record<WorkLocalPlan, WorkLocalPlanState>>

export function isWorkLocalPlan(value: unknown): value is WorkLocalPlan {
  return typeof value === 'string' && Object.hasOwn(WORK_LOCAL_PLANS, value)
}
