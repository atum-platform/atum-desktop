// Pure host-backend ledger parsing shared by Desktop and install smoke tests.

export interface HostBackendRecord {
  createTime: number | null
  host: string
  pid: number
  port: number
  profile: string
  purpose: string
  registeredAt: number
}

export const SPAWN_LEDGER_FILENAME = 'spawn-ledger.json'

const ATTACHABLE_PURPOSES = new Set(['dashboard', 'serve'])
const LOOPBACK_DIALABLE = new Set(['', '0.0.0.0', '127.0.0.1', '::', '::1', 'localhost'])

function asInteger(value: unknown): number | null {
  return Number.isInteger(value) ? Number(value) : null
}

/**
 * Return attachable candidates from raw `spawn-ledger.json` contents.
 * The caller must still validate the live listener; a ledger is discovery
 * evidence, never proof that a backend is usable.
 */
export function parseSpawnLedger(contents: unknown): HostBackendRecord[] {
  let parsed: unknown

  try {
    parsed = JSON.parse(String(contents ?? ''))
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) {
    return []
  }

  const records: HostBackendRecord[] = []

  for (const value of parsed) {
    if (!value || typeof value !== 'object') {
      continue
    }

    const entry = value as Record<string, unknown>
    const pid = asInteger(entry.pid)
    const port = asInteger(entry.port)
    const purpose = String(entry.purpose ?? '')
    const host = String(entry.host ?? '')

    if (
      pid === null ||
      pid <= 0 ||
      port === null ||
      port <= 0 ||
      port > 65535 ||
      entry.isolated === true ||
      !ATTACHABLE_PURPOSES.has(purpose) ||
      !LOOPBACK_DIALABLE.has(host.toLowerCase())
    ) {
      continue
    }

    records.push({
      createTime: typeof entry.create_time === 'number' ? entry.create_time : null,
      host,
      pid,
      port,
      profile: String(entry.profile ?? ''),
      purpose,
      registeredAt: typeof entry.registered_at === 'number' ? entry.registered_at : 0
    })
  }

  return records
}
