export interface AtumSkillBundle {
  schema_version: 1
  sha256: string
  files: Array<{ path: string; content_base64: string }>
}
export interface AtumMemorySnapshot {
  memory: string[]
  user: string[]
}
export interface AtumCloudMemory {
  assistantId: string
  revision: number
  enabled: boolean
  snapshot: AtumMemorySnapshot
}
export interface AtumAgentSyncStatus {
  assistantId: string
  skills: 'pending' | 'synced' | 'conflict' | 'error' | 'local_only'
  memory: 'disabled' | 'pending' | 'synced' | 'conflict' | 'error' | 'local_only'
  memoryEnabled: boolean
  workspaceProtected?: boolean
  pets?: 'pending' | 'synced' | 'error' | 'unavailable' | 'conflict' | 'local_only'
  lastSyncedAt: number | null
}
export function parseMemorySnapshot(value: unknown): AtumMemorySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_memory_snapshot')
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== 2 || !Array.isArray(row.memory) || !Array.isArray(row.user))
    throw new Error('invalid_memory_snapshot')
  let bytes = 0
  const encoder = new TextEncoder()
  for (const entries of [row.memory, row.user]) {
    if (entries.length > 512 || new Set(entries).size !== entries.length) throw new Error('invalid_memory_snapshot')
    bytes += Math.max(0, entries.length - 1) * 4
    for (const entry of entries) {
      if (typeof entry !== 'string' || !entry.trim() || entry !== entry.trim() || entry.includes('\0')) throw new Error('invalid_memory_snapshot')
      bytes += encoder.encode(entry).byteLength
      if (bytes > 65_536) throw new Error('invalid_memory_snapshot')
    }
  }
  return { memory: [...row.memory] as string[], user: [...row.user] as string[] }
}
export function parseCloudMemory(value: unknown): AtumCloudMemory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_cloud_memory')
  const row = value as Record<string, unknown>
  if (
    typeof row.assistant_id !== 'string' ||
    !/^[a-f0-9-]{36}$/iu.test(row.assistant_id) ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 0 ||
    typeof row.enabled !== 'boolean'
  )
    throw new Error('invalid_cloud_memory')
  return {
    assistantId: row.assistant_id,
    revision: Number(row.revision),
    enabled: row.enabled,
    snapshot: parseMemorySnapshot(row.snapshot)
  }
}
/** Python verifies canonical paths and integrity before writing any bytes. */
export function parseSkillBundle(value: unknown): AtumSkillBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_skill_bundle')
  const row = value as Record<string, unknown>
  if (
    row.schema_version !== 1 ||
    typeof row.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(row.sha256) ||
    !Array.isArray(row.files) ||
    row.files.length > 512
  )
    throw new Error('invalid_skill_bundle')
  const files = row.files.map(value => {
    if (!value || typeof value !== 'object') throw new Error('invalid_skill_bundle')
    const file = value as Record<string, unknown>
    if (typeof file.path !== 'string' || typeof file.content_base64 !== 'string')
      throw new Error('invalid_skill_bundle')
    return { path: file.path, content_base64: file.content_base64 }
  })
  return { schema_version: 1, sha256: row.sha256, files }
}

export interface AtumAgentSyncBridge {
  preferences: () => Promise<import('./atum-account-preferences').AtumPreferencesStatus>
  patchPreferences: (accountId: string, patch: import('./atum-account-preferences').AtumAccountPreferences) => Promise<void>
  seedPreferences: (accountId: string, snapshot: import('./atum-account-preferences').AtumAccountPreferences) => Promise<void>
  status: () => Promise<AtumAgentSyncStatus[]>
  sync: () => Promise<void>
  setMemoryEnabled: (id: string, enabled: boolean) => Promise<void>
  resolve: (id: string, kind: 'skills' | 'memory', choice: 'local' | 'cloud') => Promise<void>
  onChanged: (callback: () => void) => () => void
}
