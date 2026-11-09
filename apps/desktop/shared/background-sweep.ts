/** The desktop bridge for the platform-owned background follow-up setting. */

export const MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE = 'atum.agent-sweep-setting/1' as const

/** The platform's one system schedule: a standalone sweep offer carries this job marker. */
export const AGENT_SWEEP_SYSTEM_JOB_ID = 'sys_followup_sweep_v1' as const

export interface MatrixBackgroundSweepSetting {
  profile: typeof MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE
  assistantId: string
  enabled: boolean
  revision: number
  /** Rollout is active for this owner; independent of the per-agent switch. */
  activeForOwner: boolean
}

export interface MatrixBackgroundSweepSettingWrite {
  profile: typeof MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE
  requestId: string
  expectedRevision: number
  enabled: boolean
}

export type MatrixBackgroundSweepSaveResult =
  | { status: 'saved'; setting: MatrixBackgroundSweepSetting }
  | { status: 'conflict'; setting: MatrixBackgroundSweepSetting }

/** Main retains the bearer and resolves renderer principals to owned assistants. */
export interface MatrixBackgroundSweepBridge {
  read(agentPrincipal: string): Promise<MatrixBackgroundSweepSetting>
  save(agentPrincipal: string, write: MatrixBackgroundSweepSettingWrite): Promise<MatrixBackgroundSweepSaveResult>
}
