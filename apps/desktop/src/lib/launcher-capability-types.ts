import type { AtumStoreSkillEntry } from '@/lib/atum-store-items'
import type { SkillInfo } from '@/types/hermes'

import type { LauncherOperation, LauncherOperationReadiness, LauncherSupportSnapshot } from '../../shared/hermes-skills'
import type { NativeAppEntry } from '../../shared/skills-launcher'

export type { LauncherOperation, LauncherOperationReadiness, LauncherSupportSnapshot } from '../../shared/hermes-skills'

export type LauncherTileStatus =
  | 'ready'
  | 'checking'
  | 'unavailable'
  | 'included'
  | 'disabled'
  | 'needs-setup'
  | 'acquire'
  | 'unsupported'
  | 'ambiguous'
export interface LauncherCapabilityTile {
  id: string
  label: string
  description: string
  app: NativeAppEntry
  skill: SkillInfo | null
  skillName: string | null
  status: LauncherTileStatus
  storeEntry: AtumStoreSkillEntry | null
  operations: Partial<Record<LauncherOperation, LauncherOperationReadiness>>
}

export interface LauncherCapabilityState {
  scopeKey: string | null
  profile: string | null
  skills: SkillInfo[]
  support: LauncherSupportSnapshot | null
  loading: boolean
  error: string | null
  busySkill: string | null
}
