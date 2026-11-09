export interface ConversationAppVersion {
  v: 1
  version: string
  at: number
}

const versionPattern = /^[0-9]+[.][0-9]+[.][0-9]+$/
const devicePattern = /^[A-Za-z0-9_.:-]+$/

export function conversationAppVersionType(deviceServiceId: string): string {
  const value = `io.atum.app_version.${deviceServiceId}`

  if (!devicePattern.test(deviceServiceId) || value.length > 255) {
    throw new Error('matrix_invalid_conversation_device')
  }

  return value
}

export function parseConversationAppVersion(value: unknown): ConversationAppVersion | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>

  if (
    record.v !== 1 ||
    typeof record.version !== 'string' ||
    record.version.length > 100 ||
    !versionPattern.test(record.version) ||
    typeof record.at !== 'number' ||
    !Number.isSafeInteger(record.at) ||
    record.at < 0
  ) {
    return null
  }

  return { v: 1, version: record.version, at: record.at }
}

/** The floor every marker write needs (atum.agent-conversation/1). */
export const CONVERSATION_MARKER_FLOOR = [0, 19, 0] as const

/** The floor for replacing an encrypted main with a plain assistant room: a 0.19 desktop cannot
 * open a plain room (atum.agent-conversation/1.1 A1). */
export const CONVERSATION_PLAIN_FLOOR = [0, 20, 0] as const

/** The caller supplies one report for every Mac that holds or may take a lease.
 * Missing reports are explicit null entries, not filtered out. Every report must be at least
 * `floor` (numeric semver). */
export function conversationFleetReady(
  reports: readonly unknown[],
  floor: readonly [number, number, number] = CONVERSATION_MARKER_FLOOR
): boolean {
  const required = floor.map(part => BigInt(part))

  return reports.every(report => {
    const parsed = parseConversationAppVersion(report)

    if (!parsed) {
      return false
    }

    const parts = parsed.version.split('.').map(part => BigInt(part))

    for (let index = 0; index < required.length; index += 1) {
      if (parts[index] !== required[index]) {
        return parts[index] > required[index]
      }
    }

    return true
  })
}
