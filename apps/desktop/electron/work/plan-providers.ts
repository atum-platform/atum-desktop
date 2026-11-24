export const PLAN_PROVIDER_DEFAULTS = {
  codex: { driver: 'codex', enabled: true, config: { setupMode: 'existing' } },
  claudeAgent: { driver: 'claudeAgent', enabled: true },
  antigravity: { driver: 'antigravity', enabled: true }
}

// The built-in T3 instances and the corresponding registry identifiers.
export const PLAN_PROVIDER_BY_INSTANCE = {
  codex: 'codex',
  claudeAgent: 'claude',
  antigravity: 'antigravity'
} as const satisfies Record<keyof typeof PLAN_PROVIDER_DEFAULTS, string>

export type AccountPlanProvider = (typeof PLAN_PROVIDER_BY_INSTANCE)[keyof typeof PLAN_PROVIDER_BY_INSTANCE]
export const ACCOUNT_PLAN_PROVIDERS = Object.values(PLAN_PROVIDER_BY_INSTANCE)
