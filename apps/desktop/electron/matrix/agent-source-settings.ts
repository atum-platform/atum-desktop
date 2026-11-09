import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import type { AgentSourceGate, AgentSourceGates } from '../../../../packages/device-protocol/agent-source-gates'
import {
  MATRIX_AGENT_SOURCE_GATES,
  MATRIX_AGENT_SOURCES_IPC,
  type MatrixAgentSourceAvailability,
  type MatrixAgentSourceGate,
  type MatrixAgentSourceStatus,
  type MatrixAgentSourcesView,
  type MatrixAgentSourceView
} from '../../shared/matrix-agent-sources'

const GATES = new Set<string>(MATRIX_AGENT_SOURCE_GATES)

export interface MatrixAgentSourceSettingsScope {
  accountKey: string
  generation: number
}

/** Account-level facts this Mac can prove now. None of them names an assistant. */
export interface MatrixAccountSourceFacts {
  /** This computer is a Mac, so the Mac sources can work here. */
  mac: boolean
  /** Full Disk Access for this app, which Messages and Browser history need. */
  fullDisk: 'granted' | 'not-granted' | 'unknown'
  /** The account has a working Google connection on this Mac. */
  googleConnected: boolean
}

export interface MatrixAgentSourceSettingsDependencies {
  /** The signed-in account. Settings never depends on the open chat or its assistant. */
  scope(): MatrixAgentSourceSettingsScope | null
  /** The account's saved switches, read from the encrypted record on every call. */
  gates(): AgentSourceGates
  facts(): MatrixAccountSourceFacts
  /** Commits the encrypted account choice and immediate native policy revocation. */
  commit(gate: AgentSourceGate, enabled: boolean): AgentSourceGates
  /** Starts the existing full-snapshot CAS reconciler after the local commit. */
  sync(): void
}

/** One representative descriptor kind per built-in switch; the renderer groups by gate. */
const KIND: Record<MatrixAgentSourceGate, string> = {
  google: 'google.mail',
  folders: 'mac.files',
  messages: 'mac.message-metadata',
  browser: 'mac.browser-history',
  location: 'mac.location',
  team_spaces: 'matrix.chats'
}

const AVAILABILITY: Record<MatrixAgentSourceStatus, MatrixAgentSourceAvailability> = {
  ready: 'available',
  mac_only: 'available',
  needs_permission: 'not_authorized',
  not_connected: 'not_configured',
  needs_mac: 'unavailable',
  unavailable: 'unavailable'
}

/**
 * What each source can do on this account today. This is the engine's truth, not a promise:
 * cloud assistants reach the owner's Mac for files and the terminal, but Messages, Browser
 * history and Location are structured reads that only an assistant running on this Mac makes.
 */
export function matrixAccountSourceStatus(
  gate: MatrixAgentSourceGate,
  facts: MatrixAccountSourceFacts
): Pick<MatrixAgentSourceView, 'status' | 'permission'> {
  switch (gate) {
    case 'google':
      return { status: facts.googleConnected ? 'ready' : 'not_connected' }

    case 'team_spaces':
      return { status: 'ready' }

    case 'folders':
      return { status: facts.mac ? 'ready' : 'needs_mac' }

    case 'messages':

    case 'browser':
      return !facts.mac
        ? { status: 'needs_mac' }
        : facts.fullDisk === 'not-granted'
          ? { status: 'needs_permission', permission: 'fullDisk' }
          : { status: 'mac_only' }

    case 'location':
      return { status: facts.mac ? 'mac_only' : 'needs_mac' }
  }
}

export function projectMatrixAccountSources(gates: AgentSourceGates, facts: MatrixAccountSourceFacts): MatrixAgentSourcesView {
  return {
    gates: { ...gates },
    sources: MATRIX_AGENT_SOURCE_GATES.map(gate => {
      const status = matrixAccountSourceStatus(gate, facts)

      return {
        kind: KIND[gate],
        optOutGate: gate,
        ...status,
        availability: AVAILABILITY[status.status],
        grantable: status.status !== 'needs_mac' && status.status !== 'unavailable'
      }
    })
  }
}

function sameScope(left: MatrixAgentSourceSettingsScope, right: MatrixAgentSourceSettingsScope | null): boolean {
  return right !== null && left.accountKey === right.accountKey && left.generation === right.generation
}

/**
 * Account-wide source switches for Settings. The switch is always the saved account choice;
 * status is reported beside it and never changes it. Only an account switch (sign-out, another
 * account) can fence a request: the open chat or assistant plays no part.
 */
export class MatrixAgentSourceSettings {
  constructor(private readonly dependencies: MatrixAgentSourceSettingsDependencies) {}

  async read(): Promise<MatrixAgentSourcesView> {
    const scope = this.requireScope()
    const view = projectMatrixAccountSources(this.dependencies.gates(), this.dependencies.facts())

    this.assertCurrent(scope)

    return view
  }

  async set(gate: MatrixAgentSourceGate, enabled: boolean): Promise<MatrixAgentSourcesView> {
    if (!GATES.has(gate) || typeof enabled !== 'boolean') {
      throw new Error('matrix_agent_sources_invalid_request')
    }

    const scope = this.requireScope()

    // This call closes the native policy before it persists an off transition. Only after that
    // succeeds may the existing background reconciler begin its complete CAS write. Turning a
    // switch on is the owner's account intent; it takes effect wherever the source can work.
    this.dependencies.commit(gate as AgentSourceGate, enabled)
    this.assertCurrent(scope)
    this.dependencies.sync()

    // Answer from the same authoritative record the commit wrote, never from a cache.
    return projectMatrixAccountSources(this.dependencies.gates(), this.dependencies.facts())
  }

  private requireScope(): MatrixAgentSourceSettingsScope {
    const scope = this.dependencies.scope()

    if (!scope) {
      throw new Error('matrix_agent_sources_unavailable')
    }

    return { accountKey: scope.accountKey, generation: scope.generation }
  }

  private assertCurrent(scope: MatrixAgentSourceSettingsScope): void {
    if (!sameScope(scope, this.dependencies.scope())) {
      throw new Error('matrix_agent_sources_stale')
    }
  }
}

export interface MatrixAgentSourcesIpcDependencies {
  assertTrusted(event: IpcMainInvokeEvent): void
  settings: Pick<MatrixAgentSourceSettings, 'read' | 'set'>
}

/** Trusted UI only. No account or assistant selector crosses IPC. */
export function registerMatrixAgentSourcesIpc(
  ipc: Pick<IpcMain, 'handle'>,
  dependencies: MatrixAgentSourcesIpcDependencies
): void {
  ipc.handle(MATRIX_AGENT_SOURCES_IPC.read, (event, ...args: unknown[]) => {
    dependencies.assertTrusted(event)

    if (args.length !== 0) {
      throw new Error('matrix_agent_sources_invalid_request')
    }

    return dependencies.settings.read()
  })

  ipc.handle(MATRIX_AGENT_SOURCES_IPC.set, (event, gate: unknown, enabled: unknown, ...args: unknown[]) => {
    dependencies.assertTrusted(event)

    if (args.length !== 0 || typeof gate !== 'string' || !GATES.has(gate) || typeof enabled !== 'boolean') {
      throw new Error('matrix_agent_sources_invalid_request')
    }

    return dependencies.settings.set(gate as MatrixAgentSourceGate, enabled)
  })
}
