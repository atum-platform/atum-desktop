export const MATRIX_SOURCE_SERVICE_UPDATE_REQUIRED = 'matrix_source_service_update_required'

/**
 * Trusted, account-wide Settings projection of the owner's source switches.
 *
 * The switches are the account's saved choices; they never depend on which chat or assistant is
 * open. Each source also carries one quiet status fact about where it works today (this Mac, a
 * missing macOS permission, a missing connection). Source IDs, connection/scope refs, operation
 * refs and credentials deliberately do not cross this bridge.
 */
export const MATRIX_AGENT_SOURCE_GATES = [
  'google',
  'folders',
  'messages',
  'browser',
  'location',
  'team_spaces'
] as const

export type MatrixAgentSourceGate = (typeof MATRIX_AGENT_SOURCE_GATES)[number]
export type MatrixAgentSourceGates = Record<MatrixAgentSourceGate, boolean>

export type MatrixAgentSourceAvailability =
  | 'available'
  | 'unreachable'
  | 'not_configured'
  | 'not_authorized'
  | 'unavailable'

/** Optional trusted integration/connection presentation. Unknown kinds work without it. */
export interface MatrixAgentSourcePresentation {
  label: string
  description?: string
  iconDataUrl?: string
}

const SAFE_AGENT_SOURCE_ICON_DATA_URL =
  /^data:image\/(?:png|jpeg|webp|gif);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/iu

const MAX_AGENT_SOURCE_ICON_URL_LENGTH = 16_384

/** Only inert raster data and authenticated remote images may reach an image element. */
export function safeMatrixAgentSourceIconDataUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_AGENT_SOURCE_ICON_URL_LENGTH) {
    return undefined
  }

  if (SAFE_AGENT_SOURCE_ICON_DATA_URL.test(value)) {
    return value
  }

  try {
    const url = new URL(value)

    return url.protocol === 'https:' && !url.username && !url.password ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Where a source works today, independent of its switch:
 * - `ready`: works for every assistant on the account.
 * - `needs_permission`: a macOS permission is missing; `permission` names the one-tap pane.
 * - `not_connected`: the account connection (Google) isn't made yet.
 * - `needs_mac`: this computer can't provide it.
 * - `unavailable`: nothing can provide it yet.
 */
export type MatrixAgentSourceStatus =
  | 'ready'
  | 'needs_permission'
  | 'not_connected'
  | 'needs_mac'
  | 'unavailable'
  | 'mac_offline' | 'update_mac' | 'this_mac_disconnected' | 'held_off_by_older_mac'

export interface MatrixAgentSourceView {
  kind: string
  optOutGate: string | null
  availability: MatrixAgentSourceAvailability
  status: MatrixAgentSourceStatus
  /** The macOS pane that unblocks a `needs_permission` source. */
  permission?: 'fullDisk'
  /** The source can work somewhere on this account once its switch is on. */
  grantable: boolean
  presentation?: MatrixAgentSourcePresentation
  statusMac?: string
  /** Server provenance names; an empty name means a confirmed anonymous legacy writer. */
  heldOffBy?: string[]
}

export type MatrixMacSourceState = 'ready' | 'needs_permission' | 'off'
export interface MatrixReachMac {
  id: string
  name: string
  thisMac: boolean
  state: 'ready' | 'needs_permission' | 'offline' | 'older' | 'not_connected'
  sources?: Record<'messages' | 'browser' | 'location' | 'folders', MatrixMacSourceState>
  lastSeenAt?: number
}

export interface MatrixAgentSourcesView {
  gates: MatrixAgentSourceGates
  sources: MatrixAgentSourceView[]
  macs: MatrixReachMac[]
  notice?: { sources: MatrixAgentSourceGate[] }
}

/** Shared precedence for Connections and reach-down reasons; heldOff is server evidence only. */
export function macSourceStatus(
  gateOn: boolean,
  heldOff: readonly string[],
  macs: readonly MatrixReachMac[],
  kind: 'messages' | 'browser' | 'location' | 'folders'
): Pick<MatrixAgentSourceView, 'status' | 'permission' | 'statusMac' | 'heldOffBy'> {
  if (!gateOn) {return heldOff.length ? { status: 'held_off_by_older_mac', heldOffBy: [...heldOff] } : { status: 'ready' }}
  const reachable = macs.filter(mac => mac.state === 'ready' || mac.state === 'needs_permission')

  if (reachable.some(mac => mac.sources?.[kind] === 'ready')) {return { status: 'ready' }}

  const permission = [...reachable].sort((a, b) => Number(b.thisMac) - Number(a.thisMac))
    .find(mac => mac.sources?.[kind] === 'needs_permission')

  if (permission) {return { status: 'needs_permission', statusMac: permission.name,
    ...((kind === 'messages' || kind === 'browser') ? { permission: 'fullDisk' as const } : {}) }}

  const older = macs.find(mac => mac.state === 'older')

  if (older) {return { status: 'update_mac', statusMac: older.name }}
  const offline = macs.filter(mac => mac.state === 'offline')

  if (offline.length && offline.length === macs.length) {return { status: 'mac_offline',
    ...(offline.length === 1 ? { statusMac: offline[0]!.name } : {}) }}

  if (macs.some(mac => mac.thisMac && mac.state === 'not_connected')) {return { status: 'this_mac_disconnected' }}

  if (!macs.length) {return { status: 'needs_mac' }}

  return { status: 'unavailable' }
}

export const MATRIX_AGENT_SOURCES_IPC = {
  read: 'matrix:agent-sources:read',
  set: 'matrix:agent-sources:set',
  changed: 'matrix:agent-sources:changed',
  presented: 'matrix:agent-sources:presented'
} as const

export interface MatrixAgentSourcesBridge {
  /** The account's saved switches plus this Mac's status facts. No assistant is involved. */
  read(): Promise<MatrixAgentSourcesView>
  presented?(): Promise<void>
  /** Saves one account switch and answers with the record just saved. */
  set(gate: MatrixAgentSourceGate, enabled: boolean): Promise<MatrixAgentSourcesView>
  /** Called whenever the saved switches change anywhere in this app (re-read on it). */
  subscribe?(listener: () => void): () => void
}
