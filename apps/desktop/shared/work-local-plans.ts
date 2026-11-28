/** Provider IDs for interactive Work sessions on this Mac. */
export const WORK_LOCAL_PLANS = {
  copilot: { title: 'GitHub Copilot', driver: 'acpRegistry' },
  kiro: { title: 'Kiro', driver: 'kiro' },
  'openrouter-free': { title: 'OpenRouter Free', driver: 'opencode' }
} as const

export type WorkLocalPlan = keyof typeof WORK_LOCAL_PLANS
export type WorkLocalPlanAuthAction = 'setup' | 'setup-google' | 'setup-github' | 'logout'
export type WorkLocalPlanAction = WorkLocalPlanAuthAction | 'manage'

export function isWorkLocalPlanAction(plan: WorkLocalPlan, action: unknown): action is WorkLocalPlanAction {
  return action === 'manage' || (plan === 'kiro'
    ? action === 'setup-google' || action === 'setup-github'
    : action === 'setup' || (plan === 'copilot' && action === 'logout'))
}

export type WorkLocalPlanState = 'not_installed' | 'signed_out' | 'ready'
export type WorkLocalPlanStates = Partial<Record<WorkLocalPlan, { state: WorkLocalPlanState; allowance?: string }>>

export function isWorkLocalPlan(value: unknown): value is WorkLocalPlan {
  return typeof value === 'string' && Object.hasOwn(WORK_LOCAL_PLANS, value)
}
