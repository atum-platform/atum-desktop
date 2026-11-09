/** Existing Hermes metadata/readiness contracts, shared by native and renderer. */
export interface SkillInfo {
  category: string
  description: string
  enabled: boolean
  name: string
  /** Total observed activity (use + view + patch). Absent on older backends. */
  usage?: number
  /** 'agent' = learned/local (editable), 'bundled' = ships with Hermes, 'hub' = installed. */
  provenance?: 'agent' | 'bundled' | 'hub'
}

export type LauncherOperation = 'read' | 'edit' | 'validate' | 'render-qa' | 'create' | 'file-visible'
export interface LauncherOperationReadiness {
  state: 'ready' | 'needs-setup' | 'unknown'
  reasons: string[]
}
/** Backend facts for one captured assistant; never a machine-wide permission. */
export interface LauncherSupportSnapshot {
  runtime: { kind: string; generation: string }
  commands: Record<string, string>
  bundled: Array<{ name: string; description: string; category: string }>
  verified_bundled: string[]
  routes: Record<string, { operations: Partial<Record<LauncherOperation, LauncherOperationReadiness>> }>
}
