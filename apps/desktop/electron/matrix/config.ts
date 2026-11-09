import { createHash } from 'node:crypto'

export interface MatrixConfig {
  issuer: string
  server: string
  nativeClientId: string
  callbackPort: number
  domain?: { nativeClientId: string; resource: string; callbackPort?: number }
  /** Default-off candidate gate; never enabled by a catalog response. */
  appWorkspace?: boolean
  /** Disabled rollout gate for the Company Workspace foundation. */
  companyWorkspace?: boolean
  /** Disabled independently until company-owned Drive transport and client acceptance pass. */
  companyDriveFiles?: boolean
  /** T3b1 source enrollment only; no reader or generated brief. */
  companyProjectSources?: boolean
  /** T3b2 receipt-derived hosted reader coverage; no evidence or brief surface. */
  companyProjectReader?: boolean
  /** Company funding controls are a separate, disabled rollout gate. */
  companyFunding?: boolean
  /** Atum's model through the gateway, reached by Hermes via a fixed loopback proxy. */
  managedModel?: { gateway: string; port: number }
  /** Which path the assistant composer takes: `local` talks to this Mac's Hermes directly
   * (plan 2026-09-26-reliable-local-first-chat); `server` keeps the per-message room path.
   * Read by main only; absent means `local`, the candidate default. */
  assistantPath?: 'local' | 'server'
  /** A named agent's typed messages on a Mac that holds a guest copy go to the Mac that
   * answers it (its home device). Absent means on; `false` keeps every turn on this Mac. */
  agentHandoff?: boolean
  /** Phase A: at most two synthetic homes; empty/absent keeps the fresh-home demo route. */
  cloudMigrationTestAgents?: string[]
  /** Google full power for the default assistant on this Mac (public-launch decision 2026-10-25):
   * on unless this is exactly `false`, so a config that never names it runs with full power. On,
   * main-google.ts grants the local Google broker without latching or fencing the assistant; its
   * own model, web, browser, MCP and memory sync remain available, and an existing sticky latch
   * stays in the encrypted store but restricts nothing. Only an explicit `false` brings the
   * protected design back. The parser carries only `false`; read it with `matrixGoogleFullPower`. */
  googleFullPower?: boolean
}

/** Whether the default assistant runs with Google full power (see `MatrixConfig.googleFullPower`). */
export function matrixGoogleFullPower(config: Pick<MatrixConfig, 'googleFullPower'>): boolean {
  return config.googleFullPower !== false
}

export function parseMatrixConfig(value: unknown): MatrixConfig {
  const input = value as Partial<MatrixConfig>

  const endpoint = (raw: unknown) => {
    if (typeof raw !== 'string') {
      throw new Error('matrix_configuration_invalid')
    }

    const url = new URL(raw)
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost'

    if (
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error('matrix_configuration_invalid')
    }

    return url.href
  }

  if (!input || typeof input.nativeClientId !== 'string' || !/^[\w.-]{1,200}$/.test(input.nativeClientId)) {
    throw new Error('matrix_configuration_invalid')
  }

  if (input.companyWorkspace !== undefined && typeof input.companyWorkspace !== 'boolean') {
    throw new Error('matrix_configuration_invalid')
  }

  if (input.companyDriveFiles !== undefined && typeof input.companyDriveFiles !== 'boolean') {
    throw new Error('matrix_configuration_invalid')
  }

  if (input.companyProjectSources !== undefined && typeof input.companyProjectSources !== 'boolean') {
    throw new Error('matrix_configuration_invalid')
  }

  if (input.companyProjectReader !== undefined && typeof input.companyProjectReader !== 'boolean') {
    throw new Error('matrix_configuration_invalid')
  }

  if (input.companyFunding !== undefined && typeof input.companyFunding !== 'boolean') {
    throw new Error('matrix_configuration_invalid')
  }

  if (input.appWorkspace !== undefined && typeof input.appWorkspace !== 'boolean') {
    throw new Error('matrix_configuration_invalid')
  }

  if (input.assistantPath !== undefined && input.assistantPath !== 'local' && input.assistantPath !== 'server') {
    throw new Error('matrix_configuration_invalid')
  }

  if (input.agentHandoff !== undefined && typeof input.agentHandoff !== 'boolean') {
    throw new Error('matrix_configuration_invalid')
  }

  if (input.googleFullPower !== undefined && typeof input.googleFullPower !== 'boolean') {
    throw new Error('matrix_configuration_invalid')
  }

  if (input.cloudMigrationTestAgents !== undefined && (!Array.isArray(input.cloudMigrationTestAgents) ||
      input.cloudMigrationTestAgents.length > 2 || new Set(input.cloudMigrationTestAgents).size !== input.cloudMigrationTestAgents.length ||
      input.cloudMigrationTestAgents.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)))) {
    throw new Error('matrix_configuration_invalid')
  }

  // The registered MAS client currently requires this exact loopback redirect.
  const port = input.callbackPort ?? 21881

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('matrix_configuration_invalid')
  }

  let domain: MatrixConfig['domain']

  if (input.domain !== undefined) {
    const domainPort = input.domain?.callbackPort ?? 21884

    if (
      !input.domain ||
      typeof input.domain.nativeClientId !== 'string' ||
      !/^[\w.-]{1,200}$/.test(input.domain.nativeClientId) ||
      input.domain.nativeClientId === input.nativeClientId ||
      !Number.isInteger(domainPort) ||
      domainPort < 1024 ||
      domainPort > 65535
    ) {
      throw new Error('matrix_configuration_invalid')
    }

    domain = {
      nativeClientId: input.domain.nativeClientId,
      resource: endpoint(input.domain.resource).replace(/\/$/, ''),
      callbackPort: domainPort
    }
  }

  let managedModel: MatrixConfig['managedModel']

  if (input.managedModel !== undefined) {
    const managedPort = input.managedModel?.port ?? 21890

    if (!input.managedModel || !domain || !Number.isInteger(managedPort) || managedPort < 1024 || managedPort > 65535) {
      throw new Error('matrix_configuration_invalid')
    }

    managedModel = { gateway: endpoint(input.managedModel!.gateway).replace(/\/$/, ''), port: managedPort }
  }

  return {
    issuer: endpoint(input.issuer),
    server: endpoint(input.server).replace(/\/$/, ''),
    nativeClientId: input.nativeClientId,
    callbackPort: port,
    ...(input.cloudMigrationTestAgents?.length && domain ? { cloudMigrationTestAgents: [...input.cloudMigrationTestAgents] } : {}),
    // Full power is the default; only an explicit `false` is carried, so the parsed shape of every
    // existing configuration is unchanged.
    ...(input.googleFullPower === false ? { googleFullPower: false } : {}),
    ...(input.appWorkspace === true && domain ? { appWorkspace: true } : {}),
    ...(input.companyWorkspace === true && domain ? { companyWorkspace: true } : {}),
    ...(input.companyWorkspace === true && input.companyDriveFiles === true && domain ? { companyDriveFiles: true } : {}),
    ...(input.companyWorkspace === true && input.companyProjectSources === true && domain ? { companyProjectSources: true } : {}),
    ...(input.companyWorkspace === true && input.companyProjectSources === true && input.companyProjectReader === true && domain
      ? { companyProjectReader: true } : {}),
    ...(input.companyWorkspace === true && input.companyFunding === true && domain ? { companyFunding: true } : {}),
    ...(domain ? { domain } : {}),
    ...(managedModel ? { managedModel } : {}),
    assistantPath: input.assistantPath ?? 'local',
    // Preserve user-visible identity, state and recovery behavior across connection changes.
    // sync, not to live on one home Mac; routing typed turns to another Mac stays off unless
    // a build turns it on explicitly.
    ...(input.agentHandoff === true ? { agentHandoff: true } : {})
  }
}

/** A profile/device store cannot be retargeted by changing public configuration. */
export function matrixConfigurationKey(config: MatrixConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.issuer,
        config.server,
        config.nativeClientId,
        ...(config.domain ? [config.domain.nativeClientId, config.domain.resource] : [])
      ])
    )
    .digest('hex')
}
