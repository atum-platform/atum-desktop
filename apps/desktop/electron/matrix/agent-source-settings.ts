import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import type { AgentSourceGate, AgentSourceGates } from '../../../../packages/device-protocol/agent-source-gates'
import {
  macSourceStatus,
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
  location?: 'granted' | 'not-determined' | 'denied' | 'unknown'
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
  macs?(): MatrixAgentSourcesView['macs'] | Promise<MatrixAgentSourcesView['macs']>
  heldOff?(gate: AgentSourceGate): string[]
  refresh?(): Promise<void>
  notice?(): MatrixAgentSourcesView['notice']
  presented?(): void
  save?(gate: AgentSourceGate, enabled: boolean): Promise<void>
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
  mac_offline: 'unreachable',
  update_mac: 'unavailable',
  this_mac_disconnected: 'unreachable',
  held_off_by_older_mac: 'unavailable',
  needs_permission: 'not_authorized',
  not_connected: 'not_configured',
  needs_mac: 'unavailable',
  unavailable: 'unavailable'
}

/**
 * Non-Mac connection facts stay local; all Mac status precedence uses macSourceStatus.
 * Main supplies authenticated fleet facts when available.
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

    case 'messages':

    case 'browser':
    case 'location': {
      const fullDisk = facts.fullDisk === 'granted' ? 'ready' : 'needs_permission'

      return macSourceStatus(true, [], facts.mac ? [{ id: 'this-mac', name: 'This Mac', thisMac: true,
        state: 'ready', sources: { messages: fullDisk, browser: fullDisk, folders: 'ready',
          location: facts.location === 'granted' ? 'ready' : 'needs_permission' } }] : [], gate)
    }
  }
}

export function projectMatrixAccountSources(gates: AgentSourceGates, facts: MatrixAccountSourceFacts): MatrixAgentSourcesView {
  return {
    gates: { ...gates },
    macs: [],
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
    const view = await this.view()

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
    if (this.dependencies.save) {
      await this.dependencies.save(gate as AgentSourceGate, enabled)
      this.assertCurrent(scope)

      return this.view()
    }

    this.dependencies.commit(gate as AgentSourceGate, enabled)
    this.assertCurrent(scope)
    this.dependencies.sync()

    // Answer from the same authoritative record the commit wrote, never from a cache.
    return this.view()
  }

  async presented(): Promise<void> {
    const scope = this.requireScope()
    this.dependencies.presented?.()
    this.assertCurrent(scope)
  }

  private async view(): Promise<MatrixAgentSourcesView> {
    const scope = this.requireScope()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = Promise.resolve().then(() => this.dependencies.refresh?.()).catch(() => {})
    let macs: MatrixAgentSourcesView['macs'] | undefined
    try {
      ;[macs] = await Promise.all([this.dependencies.macs?.(), Promise.race([refresh,
        new Promise<void>(resolve => { timer = setTimeout(resolve, 3_000) })])])
    } finally { clearTimeout(timer) }
    this.assertCurrent(scope)
    // Capture gates/notice after network work, so a switch changed during the fetch wins.
    const view = projectMatrixAccountSources(this.dependencies.gates(), this.dependencies.facts())
    const notice = this.dependencies.notice?.()

    if (macs) {
      view.macs = macs
      view.sources = view.sources.map(source => {
        const gate = source.optOutGate as AgentSourceGate

        if (!['messages', 'browser', 'location', 'folders'].includes(gate)) {return source}
        const { permission: _permission, ...rest } = source

        const status = macSourceStatus(view.gates[gate], this.dependencies.heldOff?.(gate) ?? [], macs,
          gate as 'messages' | 'browser' | 'location' | 'folders')

        return { ...rest, ...status, availability: AVAILABILITY[status.status] }
      })
    }

    return { ...view, ...(notice ? { notice } : {}) }
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
  settings: Pick<MatrixAgentSourceSettings, 'read' | 'set'> & Partial<Pick<MatrixAgentSourceSettings, 'presented'>>
}

/** Trusted UI only. No account or assistant selector crosses IPC. */
export function registerMatrixAgentSourcesIpc(
  ipc: Pick<IpcMain, 'handle'>,
  dependencies: MatrixAgentSourcesIpcDependencies
): void {
  ipc.handle(MATRIX_AGENT_SOURCES_IPC.presented, (event, ...args: unknown[]) => {
    dependencies.assertTrusted(event)

    if (args.length !== 0) {throw new Error('matrix_agent_sources_invalid_request')}

    return dependencies.settings.presented?.()
  })
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
