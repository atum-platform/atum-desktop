import { matrixHubSkillName, type MatrixPagesOpenInput } from '../../../shared/matrix-pages'
import type { MatrixStoreInstall, MatrixStoreItem } from '../../../shared/matrix-store'

/**
 * A free official Hermes skill (Store v1.1 `skills.hub.1`, plan D8). The Store only lists it:
 * the Skills Hub installs it, with its own scan and confirmation. It has no price, no grant
 * and no entitlement, so "installed" comes from the assistant's own skill list.
 */
export type MatrixStoreHubSkill = MatrixStoreItem & { install: MatrixStoreInstall }

export function isHubSkill(item: MatrixStoreItem): item is MatrixStoreHubSkill {
  return item.kind === 'skill' && item.offer === null && item.install?.source === 'hermes_hub'
}

/**
 * Whether an assistant's skill list (the names its definition carries) already has the skill.
 * A home holds one skill per name, and a listed name may carry its category
 * (`creative/pixel-art`), so the last segment is what is compared.
 */
export function hubSkillInstalled(install: MatrixStoreInstall, skills: readonly string[]): boolean {
  const name = matrixHubSkillName(install.id)

  return skills.some(skill => matrixHubSkillName(skill) === name)
}

/** Where a listing's "Install from Skills Hub" leads: that assistant's Skills page, on the Hub,
 * opened on this skill. The page asks before anything installs. */
export type MatrixStoreHubRequest = Required<Pick<MatrixPagesOpenInput, 'agentPrincipal' | 'hub'>> & {
  page: 'skills'
}

export function hubSkillRequest(install: MatrixStoreInstall, agentPrincipal: string): MatrixStoreHubRequest {
  return { page: 'skills', agentPrincipal, hub: install.id }
}
