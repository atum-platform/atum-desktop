import type { NativeAppEntry } from '../../shared/skills-launcher'

import type { AtumStoreSkillEntry } from './atum-store-items'
import type { LauncherCapabilityState, LauncherCapabilityTile, LauncherTileStatus } from './launcher-capability-types'

/** Curated bundle identities, never display-name or keyword matching. */
export const OFFICE_SKILLS: Readonly<Record<string, string>> = {
  'com.microsoft.Word': 'docx',
  'com.microsoft.Excel': 'xlsx',
  'com.microsoft.Powerpoint': 'powerpoint'
}

export function projectLauncherTiles(
  apps: NativeAppEntry[],
  state: LauncherCapabilityState,
  storeEntries: AtumStoreSkillEntry[],
  lastUsed: Readonly<Record<string, number>> = {}
): LauncherCapabilityTile[] {
  const tileFor = (name: string | null, app: NativeAppEntry): LauncherCapabilityTile => {
    const matches = state.skills.filter(skill => skill.name === name)
    const skill = matches.length === 1 ? matches[0]! : null
    const bundled = state.support?.bundled.find(row => row.name === name)

    // Only a curated source identifier may join a store item. A matching title
    // or local folder name is neither provenance nor proof of an entitlement.
    const storeEntry = name
      ? (storeEntries.find(entry => entry.identifier === `official/productivity/${name}`) ?? null)
      : null

    const operations = name ? (state.support?.routes[name]?.operations ?? {}) : {}
    let status: LauncherTileStatus

    if (state.loading) {
      status = 'checking'
    } else if (state.error || !state.support) {
      status = 'unavailable'
    } else if (matches.length > 1) {
      status = 'ambiguous'
    } else if (skill && !skill.enabled) {
      status = 'disabled'
    } else if (skill && !state.support.verified_bundled.includes(name!)) {
      status = 'ambiguous'
    } else if (skill) {
      const read = operations.read
      const verifiedOffice = name !== null && state.support.verified_bundled.includes(name)
      status = (read && read.state !== 'ready') || (verifiedOffice && !read) ? 'needs-setup' : 'ready'
    } else if (bundled) {
      status = 'included'
    } else if (storeEntry) {
      status = storeEntry.offer || storeEntry.owned ? 'acquire' : 'unavailable'
    } else {
      status = 'unsupported'
    }

    return {
      id: `app:${app.id}`,
      label: app.name,
      description: skill?.description ?? bundled?.description ?? '',
      app,
      skill,
      skillName: name,
      status,
      storeEntry,
      operations
    }
  }

  const tiles = apps.map(app => {
    const name = app.bundleId ? (OFFICE_SKILLS[app.bundleId] ?? null) : null

    return tileFor(name, app)
  })

  return tiles.sort((left, right) =>
    Number(right.status === 'ready') - Number(left.status === 'ready') ||
    (lastUsed[right.app.bundleId || right.app.id] ?? 0) - (lastUsed[left.app.bundleId || left.app.id] ?? 0) ||
    left.label.localeCompare(right.label, undefined, { sensitivity: 'base', numeric: true }) ||
    left.id.localeCompare(right.id)
  )
}
