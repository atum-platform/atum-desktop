import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { availableParallelism, loadavg } from 'node:os'
import { join } from 'node:path'

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session } from 'electron'
import semver from 'semver'

import type { WorkAttentionSnapshot, WorkSidebarSnapshot, WorkSurfaceModeSnapshot } from "../../shared/matrix-work"
import { MATRIX_WORK_IPC, type MatrixWorkProjection } from '../../shared/matrix-work'
import type { StagedWorkUpdate } from '../atum-staged-swap/state'
import type { SafeStorageLike } from '../encrypted-store'
import { admitConnector } from '../work/connector/admission'
import { ConnectorHttp } from '../work/connector/http'
import { matrixConnector, type OwnerSdkHost } from '../work/connector/matrix'
import { ConnectorService } from '../work/connector/service'
import type { ShellMcpOptions } from '../work/connector/shell-mcp'
import { partitionFor, type PinRef, WorkSession, workSessionPaths } from '../work/session'
import { removeDurably } from '../work/session/files'
import { workAccountRoot } from '../work/session/paths'
import { createT3AuthCli } from '../work/session/t3-auth'
import { verifyPinDigest, type WorkUpdateSelection } from '../work/session/update'
import type { WorkDesktopUpdateHandler } from '../work/sidecar/desktop-control'
import { type WorkAccess, WorkHost } from '../work/sidecar/host'
import { workHasAttachedTerminal } from '../work/sidecar/process'
import { createKeychainSecretStore } from '../work/sidecar/secret-store'
import { T3McpWithdrawalError, WorkT3McpPublication } from '../work/sidecar/t3-mcp'
import { createT3PairingCodes } from '../work/sidecar/t3-mcp-session'
import {
  createWorkViewFactory,
  registerMatrixWorkIpc,
  WorkSurface,
  type WorkSurfaceParts
} from '../work/surface'
import { readAccountConnections } from '../work/surface/account-connections'
import { readLocalPlanStates, setupWorkLocalPlan } from '../work/surface/local-plans'
import { watchWorkModelDefault } from '../work/surface/model-default'
import { projectPlanCapabilities, projectPlanLabels } from '../work/surface/plan-capabilities'
import { WorkPlanFacts } from '../work/surface/plan-facts'
import { readPlanUsage } from '../work/surface/plan-usage'
import { createWorkConsentClient, deviceServiceCall } from '../work/surface/platform'
import { readWorkProviders } from '../work/surface/provider-config'
import { createOwnerRelay } from '../work/surface/relay'

import type { WorkDeliverables } from './work-deliverable'
import { WorkDeliverableHost } from './work-deliverable-host'
import { MatrixWorkLifecycle, type WorkAccount, workAccountFor } from './work-lifecycle'

/** Atum's panel radius (`--atum-r-panel`, styles.css): Work's native view is rounded to it. */
export const WORK_VIEW_RADIUS = 14

// The Matrix composition's Work (self-work slice A, lane W). Everything Work needs from the Matrix window is a port
// here, so this file holds no account logic of its own: it builds the app-wide objects once (host, session,
// surface, IPC) and gives `MatrixWorkLifecycle` the account to bind them to.
//
// The model path is the Matrix managed-model loopback (`managed-model.ts`): Work’s
// Hermes gateway presents a key this module mints, the proxy adds the person's domain bearer and the gateway holds
// and settles Protons as it does for every assistant. No broker environment is passed: the broker belongs to the
// retired composition, and Hermes runs without the filesystem-capability guard exactly as the assistants' do.

/** The role the proxy knows Work's key by. Not a host role: no agent runtime answers to it. */
export const MATRIX_WORK_MODEL_ROLE = 'work'

export interface MatrixWorkModelPort {
  /** The proxy's loopback base URL (`http://127.0.0.1:<port>/v1`), or undefined while it is not running. */
  baseUrl(): string | undefined
  /** `MatrixManagedModel.probe`: a free read through the proxy, the gateway and the platform identity. */
  probe(role: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; code: string }>
  /** `MatrixManagedModel.abortAgent`: cancel this role's forwards that are on their way to the gateway. */
  abortRole?(role: string): void
}

/** The owner's wallet, a real read of the platform ledger (the one the Matrix wallet shows): `account.wallet`. */
export interface MatrixWorkWalletPort {
  (signal: AbortSignal): Promise<{ balances: { available: number } }>
}

export interface MatrixWorkDeps {
  deliverables?: WorkDeliverables
  userData: string
  home: string
  /** `process.resourcesPath` of the app (the staged `work-runtime` and the Hermes runtime live under it). */
  resources: string
  /** The isolated preload for the owner view (`dist-matrix/matrix-work-preload.js`). */
  workPreload: string
  safeStorage: SafeStorageLike
  ui(): BrowserWindow | undefined
  ipcMain: Pick<IpcMain, 'handle'>
  /** Main's own check that a request comes from the Matrix UI frame. */
  requireUi(event: IpcMainInvokeEvent): void
  zoomFactor(): number
  sessionFromPartition(partition: string): Session
  model: MatrixWorkModelPort
  /** The owner's balance. `GET /v1/models` through the proxy proves catalog access, not that Protons exist. */
  wallet: MatrixWorkWalletPort
  /** `account.appScope()`. */
  scope(): { accountKey: string; generation: number } | null
  /* Verified account identity (/me), independent of any agent executor. */
  ownerPrincipal(): string | undefined | Promise<string | undefined>
  deviceServiceId(): string | undefined
  deviceEnrollmentEpoch(): number | undefined
  /** The local enrollment ID remains readable after its state is set to revoked. */
  localDeviceServiceId(): string | undefined
  /** The platform's `device-services` endpoint: `${resource}/device-services`. */
  deviceServicesEndpoint(): string | undefined
  /** The signed-in owner's current domain bearer. */
  bearer(): Promise<string>
  shellMcp: Omit<ShellMcpOptions, 'current' | 'signal'>
  connectAssertion?(): Promise<string>
  /** Retire the legacy cloud login before opening native Codex setup. */
  prepareChatGptConnect(): Promise<void>
  /** The owner's own SDK host (`hosts.get('human')`), for the verifier. */
  ownerHost(): OwnerSdkHost | undefined
  /** The Matrix user of the active agent with this principal (`account.agents()`), or null. */
  agentMatrixUser(principal: string): Promise<string | null>
  /** The signed-in owner’s active assistants, from the account roster. */
  eligiblePlanAgents(): Promise<string[]>
  /** The owner's top-up page (what `openTopUp` opens). */
  openProtons(): Promise<void>
  publish(channel: string, payload: MatrixWorkProjection | WorkSurfaceModeSnapshot | WorkSidebarSnapshot | WorkAttentionSnapshot | null): void
  desktopUpdate?(): WorkDesktopUpdateHandler | undefined
  plannedUpdate?: { work: StagedWorkUpdate | null; selection?: WorkUpdateSelection }
  /** Main's `closing`: nothing starts while the app quits. */
  closing(): boolean
  log(line: string): void
}

export interface MatrixWork {
  prepareUpdate(resources: string): Promise<StagedWorkUpdate | null>
  cancelPreparedUpdate(): void
  resumeUpdate(): Promise<void>
  /** The window may have become ready, or the account may have changed. Idempotent. */
  activate(): Promise<void>
  /** Sign-out, a session the server ended, an account switch: tear everything of this account down. */
  retire(deviceServiceId?: string): Promise<void>
  revokeT3Mcp(deviceServiceId: string): Promise<void>
  /** Withdraw or resume publication of this Mac's token-free plan facts. */
  setMacPlanFactsEnabled(deviceServiceId: string, enabled: boolean): Promise<void>
  /** App quit: not a revocation. */
  quit(): Promise<void>
  /** The local keys Work's gateways present to the model proxy, in `MatrixManagedModel`'s `keys()` shape. */
  modelKeys(): [key: string, role: string][]
  modelRoute(): 'open' | 'refused'
}

/**
 * Provisional floor for starting Work: one Proton (1,000,000 micro-Protons) available. The gateway's own completion
 * hold stays the final spending check on every model call; this only keeps a launch from being claimed (and the owner's
 * message used up) for an owner who plainly cannot pay.
 */
export const WORK_MIN_AVAILABLE_MICRO_PROTONS = 1_000_000

/**
 * Whether Work may start for the owner. The balance is the wallet's own read of the platform ledger; the free probe
 * through the proxy then confirms the model path (key, sign-in, gateway, catalog). Either can say "empty"; only both
 * saying yes is "allowed", and anything unreadable is "unavailable", never "allowed".
 */
export async function readWorkAccess(model: MatrixWorkModelPort, wallet: MatrixWorkWalletPort): Promise<WorkAccess> {
  try {
    const view = await wallet(AbortSignal.timeout(10_000))

    if (!Number.isSafeInteger(view?.balances?.available)) {
      return 'unavailable'
    }

    if (view.balances.available < WORK_MIN_AVAILABLE_MICRO_PROTONS) {
      return 'empty'
    }

    const answer = await model.probe(MATRIX_WORK_MODEL_ROLE)

    if (answer.ok === true) {
      return 'allowed'
    }

    return answer.code === 'out_of_protons' ? 'empty' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

export interface WorkModelKeysPorts {
  scope(): { accountKey: string; generation: number } | null
  closing(): boolean
  abort(role: string): void
}

/**
 * The one key Work's gateways present to the model proxy, bound to the account generation it was minted for. It is an
 * answer only while that account and generation are the signed-in ones; `forget` (called synchronously at the start of
 * every retirement) drops it and cancels the forwards already on their way, so no call finishes under another account.
 */
export class WorkModelKeys {
  private bound: { key: string; accountKey: string; generation: number } | undefined

  constructor(private readonly ports: WorkModelKeysPorts) {}

  mint(): string {
    const scope = this.ports.scope()

    if (!scope || this.ports.closing()) {
      throw new Error('work_model_unavailable')
    }

    if (this.bound && (this.bound.accountKey !== scope.accountKey || this.bound.generation !== scope.generation)) {
      this.forget()
    }

    this.bound ??= {
      key: randomBytes(32).toString('base64url'),
      accountKey: scope.accountKey,
      generation: scope.generation
    }

    return this.bound.key
  }

  keys(): [key: string, role: string][] {
    if (!this.bound) {
      return []
    }

    const scope = this.ports.scope()

    if (
      !scope ||
      this.ports.closing() ||
      scope.accountKey !== this.bound.accountKey ||
      scope.generation !== this.bound.generation
    ) {
      this.forget()

      return []
    }

    return [[this.bound.key, MATRIX_WORK_MODEL_ROLE]]
  }

  forget(): void {
    const had = this.bound !== undefined

    this.bound = undefined

    if (had) {
      this.ports.abort(MATRIX_WORK_MODEL_ROLE)
    }
  }
}

/** The pin this build ships: `work-runtime/pin.json`, written when the runtime is staged (version and `t3` digest). */
export function readShippedPin(resources: string): PinRef {
  try {
    const raw = JSON.parse(readFileSync(join(resources, 'work-runtime', 'pin.json'), 'utf8')) as {
      version?: unknown
      sha256?: unknown
    }

    if (typeof raw.version === 'string' && /^\d+\.\d+\.\d+$/u.test(raw.version)) {
      return { version: raw.version, resources, ...(typeof raw.sha256 === 'string' ? { sha256: raw.sha256 } : {}) }
    }
  } catch {
    // an older stage without a manifest
  }

  return { version: '0.0.0', resources }
}

export function createMatrixWork(deps: MatrixWorkDeps): MatrixWork {
  const deliverables = new WorkDeliverableHost(deps.deliverables, deps.eligiblePlanAgents)

  const modelKeys = new WorkModelKeys({
    scope: () => deps.scope(),
    closing: () => deps.closing(),
    abort: role => deps.model.abortRole?.(role)
  })

  const accountsDir = join(deps.userData, 'work-accounts')
  const rootFor = (accountKey: string) => workAccountRoot(deps.userData, accountKey)

  const removeLegacyMcpManifest = (root: string) => {
    try {
      const file = join(workSessionPaths({ root }).userdata, 'managed-mcp-servers.json')
      removeDurably(file)
      removeDurably(`${file}.next`)
    } catch {
      deps.log('[atum-work] legacy_mcp_manifest_cleanup_failed')
    }
  }

  try {
    for (const entry of readdirSync(accountsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[0-9a-f]{32}$/u.test(entry.name)) {
        removeLegacyMcpManifest(join(accountsDir, entry.name))
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      deps.log('[atum-work] legacy_mcp_manifest_cleanup_failed')
    }
  }

  // Resolve once per signed-in generation. A late /me answer cannot bind another account's Work.
  let owner: { accountKey: string; generation: number; principal: string } | undefined
  let resolving: Promise<void> | undefined
  let resumed = false
  let updatePrepared = false

  const sameScope = (scope: { accountKey: string; generation: number } | null) =>
    Boolean(scope && owner?.accountKey === scope.accountKey && owner.generation === scope.generation)

  const resolveOwner = async () => {
    const scope = deps.scope()

    if (!scope || deps.closing() || sameScope(scope)) {return}

    const principal = await deps.ownerPrincipal()
    const current = deps.scope()

    if (principal && !deps.closing() && current?.accountKey === scope.accountKey && current.generation === scope.generation) {
      owner = { ...scope, principal }
    }
  }

  let startingUpdate = Boolean(deps.plannedUpdate)
  const account = (): WorkAccount | undefined =>
    deps.closing() || (startingUpdate && deps.scope()?.accountKey !== deps.plannedUpdate?.work?.accountKey)
      ? undefined
      : workAccountFor({
          scope: deps.scope(),
          ownerPrincipal: sameScope(deps.scope()) ? owner?.principal : undefined,
          deviceServiceId: deps.deviceServiceId(),
          rootFor
        })

  let connector: ConnectorHttp | undefined
  let connectorLifetime: AbortController | undefined
  let connectorEnvironment: Record<string, string> = {}

  const closeConnector = () => {
    connectorLifetime?.abort()
    connectorLifetime = undefined
    const old = connector
    connector = undefined
    connectorEnvironment = {}
    void old?.close()
  }

  const prepareConnector = async (signal: AbortSignal) => {
    const bound = account()

    if (bound) {
      closeConnector()
      removeLegacyMcpManifest(bound.root)
      const lifetime = new AbortController()
      connectorLifetime = lifetime
      const connectorSignal = AbortSignal.any([signal, lifetime.signal])

      const current = () => {
        const active = account()

        return !connectorSignal.aborted && active?.key === bound.key && active.generation === bound.generation
      }

      const secret = randomBytes(32).toString('base64url')

      const service = new ConnectorService(
        join(bound.root, 'work', 'connector-receipts.json'),
        matrixConnector({
          owner: () => deps.ownerHost(),
          agent: principal => deps.agentMatrixUser(principal),
          current,
          admit: caller =>
            admitConnector(caller, {
              origin: () => host.current()?.origin,
              current,
              signal,
              secret
            })
        })
      )

      const candidate = new ConnectorHttp(service, secret, { ...deps.shellMcp, current, signal: connectorSignal })
      let endpoint: string

      try {
        endpoint = await candidate.start()
      } catch {
        const stillCurrent = current()

        lifetime.abort()
        await candidate.close()

        if (!stillCurrent || signal.aborted) {
          throw new Error('work_account_changed')
        }

        deps.log('[atum-work] connector_unavailable')

        return
      }

      if (!current()) {
        lifetime.abort()
        await candidate.close()
        throw new Error('work_account_changed')
      }

      connector = candidate
      connectorEnvironment = { ATUM_WORK_CONNECTOR_URL: endpoint, ATUM_WORK_CONNECTOR_TOKEN: secret }
    }
  }

  const t3Mcp = new WorkT3McpPublication()
  let mcpTimer: ReturnType<typeof setInterval> | undefined
  const revokedDevices = new Map<string, Promise<void>>()
  let workStopping = false
  let facts: { key: string; reporter: WorkPlanFacts } | undefined

  const stopT3Mcp = () => {
    clearInterval(mcpTimer)
    mcpTimer = undefined
    t3Mcp.stop()
  }

  const deviceOptions = (endpoint: string, scope: NonNullable<ReturnType<MatrixWorkDeps['scope']>>, current?: () => boolean) =>
    ({
      endpoint,
      bearer: async () => {
        const bearer = await deps.bearer()
        const active = deps.scope()

        if (active?.accountKey !== scope.accountKey || active.generation !== scope.generation || current?.() === false) {
          throw new Error('work_account_changed')
        }

        return bearer
      }
    })

  const deviceCall = (...args: Parameters<typeof deviceOptions>) => deviceServiceCall(deviceOptions(...args))

  const planFactTarget = (bound: WorkAccount, deviceServiceId: string, current?: () => boolean) => {
    const endpoint = deps.deviceServicesEndpoint()

    if (!endpoint) {throw new Error('work_plan_fact_unavailable')}
    const key = JSON.stringify([bound.key, bound.generation, deviceServiceId])

    if (facts?.key !== key) {facts = { key, reporter: new WorkPlanFacts(bound.root) }}

    const enrollmentEpoch = deps.deviceServiceId() === deviceServiceId ? deps.deviceEnrollmentEpoch() : undefined
    const eligible = () => current?.() !== false &&
      (enrollmentEpoch === undefined || (deps.deviceServiceId() === deviceServiceId && deps.deviceEnrollmentEpoch() === enrollmentEpoch))

    return {
      reporter: facts.reporter,
      target: {
        account: bound, deviceServiceId, enrollmentEpoch, home: deps.home,
        platform: deviceOptions(endpoint, { accountKey: bound.key, generation: bound.generation }, eligible)
      }
    }
  }

  const mcpStore = (bound: { root: string }) => createKeychainSecretStore({
    account: bound, safeStorage: deps.safeStorage,
    onFailure: () => {throw new Error('t3_mcp_store_unavailable')}
  })

  const logMcpFailure = (error: unknown, fallback: string) => {
    const failures = error instanceof T3McpWithdrawalError ? error.failures : [fallback]

    for (const code of failures) {deps.log(`[atum-work] ${code}`)}
  }

  const mcpCustody = (bound: { key: string; root: string }) => {
    const paths = workSessionPaths(bound)
    const cli = { ...host.authTools(paths), home: paths.home }

    return {
      accountKey: bound.key,
      store: mcpStore(bound),
      auth: createT3AuthCli(cli),
      pairing: createT3PairingCodes(cli)
    }
  }

  const clearT3Mcp = async (
    bound: { key: string; root: string; generation: number },
    deviceServiceId?: string,
    revokedDeviceServiceId?: string,
    strict = false
  ) => {
    const scope = deps.scope()
    const endpoint = deps.deviceServicesEndpoint()
    const call = scope?.accountKey === bound.key && scope.generation === bound.generation && endpoint
      ? deviceCall(endpoint, scope, () => !deviceServiceId || !revokedDevices.has(deviceServiceId))
      : undefined

    await t3Mcp.clear(mcpCustody(bound), {
      revokedDeviceServiceId,
      shell: deviceServiceId && call ? { deviceServiceId, call } : undefined
    }).catch(error => {
      logMcpFailure(error, 't3_mcp_clear_failed')
      if (strict) {throw error}
    })
  }

  const refreshT3Mcp = () => {
    const running = host.current()
    const active = account()
    const scope = deps.scope()
    const deviceServiceId = deps.deviceServiceId()
    const endpoint = deps.deviceServicesEndpoint()

    if (!running || !active || !scope || !deviceServiceId || !endpoint || workStopping || !host.enabled() || revokedDevices.has(deviceServiceId) ||
        running.accountKey !== scope.accountKey || running.generation !== scope.generation) {return}

    const current = () => {
      const present = deps.scope()

      return Boolean(mcpTimer) && !deps.closing() && host.current() === running &&
        present?.accountKey === scope.accountKey && present.generation === scope.generation &&
        deps.deviceServiceId() === deviceServiceId && !revokedDevices.has(deviceServiceId)
    }
    if (!planFactTarget(active, deviceServiceId).reporter.enabled()) {return}
    const ownerPartition = deps.sessionFromPartition(partitionFor(active.key))

    void t3Mcp.refresh({
      ...mcpCustody(active),
      deviceServiceId, workOrigin: running.origin, current,
      call: deviceCall(endpoint, scope, current),
      ownerFetch: ownerPartition.fetch.bind(ownerPartition),
      assertion: () => deps.connectAssertion?.() ?? Promise.reject(new Error('work_connect_unavailable'))
    }).catch(error => logMcpFailure(error, 't3_mcp_refresh_failed'))
  }

  const host = new WorkHost({
    canStart: () => !updatePrepared,
    desktopUpdate: deps.desktopUpdate,
    ready: () => {
      if (workStopping || deps.closing()) {return}
      mcpTimer ??= setInterval(refreshWorkPublication, 60_000).unref()
      refreshWorkPublication()
    },
    connectAssertion: () => deps.connectAssertion ? deps.connectAssertion() : Promise.reject(new Error('work_unavailable')),
    log: (phase, ms) => deps.log(`[atum-work] startup phase=${phase} ms=${ms} at=${Date.now()}`),
    surfaceModeChanged: snapshot => deps.publish(MATRIX_WORK_IPC.surfaceModeChanged, snapshot),
    sidebarChanged: snapshot => deps.publish(MATRIX_WORK_IPC.sidebarChanged, snapshot),
    attentionChanged: snapshot => deps.publish(MATRIX_WORK_IPC.attentionChanged, snapshot),
    prepare: prepareConnector,
    resources: deps.resources,
    account,
    gatewayEnvironment: () => {
      const baseUrl = deps.model.baseUrl()
      const active = account()

      if (!baseUrl || !active) {
        throw new Error('work_model_unavailable')
      }

      return {
        ...connectorEnvironment,
        ATUM_MANAGED_MODEL_BASE_URL: baseUrl,
        ATUM_MANAGED_MODEL_PROXY_TOKEN: modelKeys.mint()
      }
    },
    // A stopped or replaced server leaves no key the proxy would still answer to.
    revokeCredentials: () => {
      modelKeys.forget()
      closeConnector()
    },
    // The owner view reads Work’s balance through the model proxy.
    readAccess: () => readWorkAccess(deps.model, deps.wallet),
    openProtons: deps.openProtons,
    deliverableMessage: (owner, message, current, signal) => deliverables.message(owner, message, current, signal),
    deliverableStatus: (owner, identity) => deliverables.status(owner, identity),
    openDeliverable: (owner, identity, current) => deliverables.open(owner, identity, current)
  })

  const readNativePlanCapabilities = async (bound: WorkAccount) => {
    const running = host.current()

    if (!running || !host.enabled() || running.accountKey !== bound.key || running.generation !== bound.generation) {return {}}

    const providers = await readWorkProviders(running.origin, deps.sessionFromPartition(partitionFor(bound.key)))
    const active = account()

    if (host.current()?.id !== running.id || active?.key !== bound.key || active.generation !== bound.generation) {return {}}

    const observed = projectPlanCapabilities(providers)
    const deviceServiceId = deps.deviceServiceId()

    if (deviceServiceId && Object.keys(observed).length) {
      try {
        t3Mcp.planCatalog(mcpStore(bound), deviceServiceId, observed)
      } catch {
        deps.log('[atum-work] t3_mcp_plan_catalog_store_failed')
      }
    }

    return observed
  }

  const refreshPlanFacts = async () => {
    const running = host.current()
    const active = account()
    const deviceServiceId = deps.deviceServiceId()

    if (!running || !active || !deviceServiceId || !host.enabled() || workStopping || revokedDevices.has(deviceServiceId)) {return}

    const current = () => !workStopping && host.enabled() && host.current() === running &&
      deps.deviceServiceId() === deviceServiceId && !revokedDevices.has(deviceServiceId)
    const { reporter, target } = planFactTarget(active, deviceServiceId, current)

    await reporter.refresh(target, () => readNativePlanCapabilities(active))
  }

  const refreshWorkPublication = () => {
    void refreshPlanFacts().catch(() => deps.log('[atum-work] plan_fact_refresh_failed'))

    try {
      refreshT3Mcp()
    } catch {
      deps.log('[atum-work] t3_mcp_refresh_failed')
    }
  }

  const withdrawPlanFacts = async (bound: WorkAccount, deviceServiceId?: string) => {
    if (!deviceServiceId || revokedDevices.has(deviceServiceId) || !existsSync(workSessionPaths(bound).home)) {return}

    try {
      const { reporter, target } = planFactTarget(bound, deviceServiceId)
      await reporter.withdraw(target)
    } catch {
      deps.log('[atum-work] plan_fact_withdraw_failed')
    }
  }

  host.registerOwnerPreload()

  const session = new WorkSession({
    account,
    plannedUpdate: active => !resumed && active.key === deps.plannedUpdate?.work?.accountKey ? deps.plannedUpdate.selection : undefined,
    host: host.forResources(deps.resources),
    authTools: paths => host.authTools(paths),
    clearPartition: async partition => {
      const store = deps.sessionFromPartition(partition)

      await store.clearStorageData()
      await store.clearCache()
    },
    // The update driver is part of the installed composition: `WorkSession.start` runs its crash recovery (a restore
    // that was interrupted, a reset still owed) before any server opens the home, and `update` is the one door for
    // moving the pin. Without it a crash during a restore would leave the home half restored and start it anyway.
    update: {
      currentPin: () => readShippedPin(deps.resources),
      hostFor: pin => host.forResources(pin.resources),
      log: event => deps.log(`[atum-work] update ${event}`)
    }
  })

  const surface = new WorkSurface({
    canPrewarm: () => (!deps.plannedUpdate || Boolean(deps.plannedUpdate.work)) && loadavg()[0] < availableParallelism(),
    getSurfaceMode: () => host.getSurfaceMode(),
    getSidebar: () => host.sidebar(),
    getAttention: () => host.attention(),
    runCommand: command => host.runCommand(command),
    setSurfaceMode: (projectId, mode) => host.setSurfaceMode(projectId, mode),
    createView: createWorkViewFactory({
      window: () => deps.ui() ?? null,
      preload: deps.workPreload,
      zoomFactor: deps.zoomFactor,
      log: (phase, ms) => deps.log(`[atum-work] startup phase=${phase} ms=${ms} at=${Date.now()}`),
      // The panel radius (--atum-r-panel): the view sits in the shared panel frame like every screen.
      radius: WORK_VIEW_RADIUS,
      onBlocked: (kind, origin) => deps.log(`[atum-work] view_blocked ${kind} ${origin}`)
    }),
    publish: projection => {
      const window = deps.ui()

      if (window && !window.isDestroyed()) {
        deps.publish(MATRIX_WORK_IPC.changed, projection)
      }
    },
    log: line => deps.log(line),
    setWork: async on => {
      if (on) {
        const bound = account()

        if (bound && !host.enabled()) {t3Mcp.allowConnectLink(bound.key, mcpStore(bound))}
        await host.setEnabled(true)
      } else {
        const bound = account()
        const deviceServiceId = deps.deviceServiceId()
        workStopping = true
        stopT3Mcp()

        const stopping = host.setEnabled(false)

        try {
          await Promise.all([
            stopping,
            bound && clearT3Mcp(bound, deviceServiceId),
            bound && withdrawPlanFacts(bound, deviceServiceId)
          ])
        } finally {
          workStopping = false
        }
      }
    }
  })

  registerMatrixWorkIpc(deps.ipcMain, surface, deps.requireUi)

  const parts = (bound: WorkAccount): WorkSurfaceParts => {
    let modelDefault: { incarnation: string; ready: Promise<void> } | undefined

    const options = () => {
      const endpoint = deps.deviceServicesEndpoint()

      if (!endpoint) {throw new Error('work_device_services_unavailable')}

      return deviceOptions(endpoint, { accountKey: bound.key, generation: bound.generation })
    }
    const consentFor = () => createWorkConsentClient(options())

    return {
      session: {
        async openOwnerView(createView) {
          const outcome = await session.openOwnerView(createView)

          // First launch needs the freshly paired owner cookie; the server-ready tick may have preceded it.
          if (outcome.state !== 'failed') {
            refreshWorkPublication()
            const running = outcome.incarnation

            if (modelDefault?.incarnation !== running.id) {
              const scope = new AbortController()
              void running.exited.then(() => scope.abort())
              modelDefault = {
                incarnation: running.id,
                ready: watchWorkModelDefault(running.origin, deps.sessionFromPartition(partitionFor(bound.key)), scope.signal,
                  () => !deps.closing() && host.current() === running && host.enabled())
              }
            }

            await modelDefault.ready
          }

          return outcome
        }
      },
      enabled: () => !workStopping && host.enabled(),
      readAccess: () => readWorkAccess(deps.model, deps.wallet),
      async readPlanUsage() {
        const running = host.current()

        if (!running || !host.enabled()) {return []}

        const reports = await readPlanUsage(running.origin, deps.sessionFromPartition(partitionFor(running.accountKey)))

        return host.current() === running ? reports : []
      },
      prepareChatGptConnect: () => deps.prepareChatGptConnect(),
      readConnections: () => readAccountConnections({
        endpoint: () => deps.deviceServicesEndpoint(),
        bearer: () => options().bearer(),
        thisDevice: () => deps.deviceServiceId(),
        localCapabilities: () => {
          const active = account()

          return active?.key === bound.key && active.generation === bound.generation
            ? readNativePlanCapabilities(bound) : Promise.resolve({})
        }
      }),
      // First run: the four connections and T3's plan names. Local to this Mac; never reported to the account.
      async readPlanLabels() {
        const running = host.current()
        const active = account()

        if (!running || !host.enabled() || active?.key !== bound.key || active.generation !== bound.generation ||
            running.accountKey !== bound.key) {return {}}

        const providers = await readWorkProviders(running.origin, deps.sessionFromPartition(partitionFor(bound.key)))

        return host.current() === running ? projectPlanLabels(providers) : {}
      },
      readLocalPlans: () => readLocalPlanStates(
        host.current(), bound, deps.sessionFromPartition(partitionFor(bound.key)), () => host.current()
      ),
      async setupLocalPlan(plan) {
        const running = host.current()

        if (!running || !host.enabled() || running.accountKey !== bound.key || running.generation !== bound.generation) {
          throw new Error('work_setup_unavailable')
        }

        const scope = new AbortController()
        void running.exited.then(() => scope.abort())
        await setupWorkLocalPlan(running.origin, deps.sessionFromPartition(partitionFor(bound.key)), plan, scope.signal)
      },
      deviceServiceId: () => deps.deviceServiceId(),
      relay: createOwnerRelay(async () => {
        const deviceServiceId = deps.deviceServiceId()

        if (!deviceServiceId || revokedDevices.has(deviceServiceId)) {return null}

        const observed = await readNativePlanCapabilities(bound)
        const active = account()

        if (active?.key !== bound.key || active.generation !== bound.generation ||
            deps.deviceServiceId() !== deviceServiceId || revokedDevices.has(deviceServiceId)) {return null}

        const store = mcpStore(bound)

        return {
          published: host.enabled() && !workStopping && planFactTarget(bound, deviceServiceId).reporter.enabled() &&
            t3Mcp.isPublished(store, deviceServiceId),
          plans: t3Mcp.planCatalog(store, deviceServiceId, observed)
        }
      }, options),
      async eligiblePlanAgents() {
        const agents = await deps.eligiblePlanAgents()
        const active = account()

        return active?.key === bound.key && active.generation === bound.generation ? agents : []
      },
      consent: {
        read: plan => consentFor().read(plan),
        async set(input) {
          await refreshPlanFacts().catch(() => deps.log('[atum-work] plan_fact_refresh_failed'))

          return consentFor().set(input)
        },
        revoke: plan => consentFor().revoke(plan)
      }
    }
  }

  const lifecycle = new MatrixWorkLifecycle({
    account,
    // A build without the staged runtime or the owner-view preload cannot run Work: draw nothing rather than an entry
    // that fails on click. Proxy availability belongs to runtime startup, not discovery.
    prepare: async () => {
      if (!existsSync(join(deps.resources, 'work-runtime', 't3')) || !existsSync(deps.workPreload)) {
        throw new Error('work_not_in_this_build')
      }
      if (host.enabled() && session.held()) {
        await session.start().catch(() => deps.log('[atum-work] recovery_pending'))
      }
    },
    // Retirement and quit drop the model key (and cancel its forwards) synchronously, before any await.
    async retire(bound, deviceServiceId = deps.deviceServiceId()) {
      stopT3Mcp()
      modelKeys.forget()

      await Promise.all([
        clearT3Mcp(bound, deviceServiceId && !revokedDevices.has(deviceServiceId) ? deviceServiceId : undefined),
        withdrawPlanFacts(bound, deviceServiceId)
      ])
      if (existsSync(workSessionPaths(bound).home)) {
        await session.retire(bound, 'sign-out')
      } else {
        await host.stop()
      }
    },
    quit: () => host.stop(),
    attach: value => surface.attach(value),
    parts,
    log: line => deps.log(line)
  })

  return {
    activate: async () => {
      // keys() drops a key whose account or generation is no longer the signed-in one, and cancels its forwards
      modelKeys.keys()

      resolving ??= resolveOwner().catch(() => {
        deps.log('[atum-work] account_identity_unavailable')
      }).finally(() => { resolving = undefined })
      await resolving

      await lifecycle.activate()

      // WorkSurface preloads one hidden view after launch, through WorkSession's recovery door.
    },
    retire: async (deviceServiceId = deps.deviceServiceId()) => {
      stopT3Mcp()
      modelKeys.forget()
      closeConnector()
      const scope = deps.scope() ?? owner

      if (!(await lifecycle.retire(deviceServiceId)) && scope) {
        await clearT3Mcp(
          { key: scope.accountKey, generation: scope.generation, root: rootFor(scope.accountKey) },
          deviceServiceId && !revokedDevices.has(deviceServiceId) ? deviceServiceId : undefined
        )
      }
    },
    revokeT3Mcp(deviceServiceId) {
      if (deviceServiceId !== deps.localDeviceServiceId()) {return Promise.resolve()}

      const pending = revokedDevices.get(deviceServiceId)

      if (pending) {return pending}
      const scope = deps.scope() ?? owner
      const bound = lifecycle.boundAccount() ?? (scope && {
        key: scope.accountKey, generation: scope.generation, root: rootFor(scope.accountKey)
      })
      const revoke = Promise.resolve().then(() => bound ? clearT3Mcp(bound, undefined, deviceServiceId) : undefined)
      revokedDevices.set(deviceServiceId, revoke)

      return revoke
    },
    quit: () => {
      stopT3Mcp()
      closeConnector()
      modelKeys.forget()

      return lifecycle.quit()
    },
    async setMacPlanFactsEnabled(deviceServiceId, enabled) {
      const bound = account()

      if (!bound || deviceServiceId !== deps.deviceServiceId()) {return}

      const { reporter, target } = planFactTarget(bound, deviceServiceId, () => deps.deviceServiceId() === deviceServiceId)
      reporter.setEnabled(enabled)

      if (enabled) {
        refreshWorkPublication()
      } else if (existsSync(workSessionPaths(bound).home)) {
        t3Mcp.stop()
        await Promise.all([reporter.withdraw(target), clearT3Mcp(bound, deviceServiceId, undefined, true)])
      }
    },
    async prepareUpdate(resources) {
      const live = host.current()
      if (host.pendingStart() || session.held()) {throw new Error('work_update_owner_busy')}
      if (!live) {
        updatePrepared = true
        return null
      }
      const current = readShippedPin(deps.resources)
      const target = readShippedPin(resources)
      if (semver.lt(target.version, current.version) ||
          (target.version === current.version && current.sha256 !== target.sha256)) {
        throw new Error('work_update_pin_incompatible')
      }
      const [, terminal] = await Promise.all([verifyPinDigest(target), workHasAttachedTerminal(live.pid)])
      if (terminal) {throw new Error('work_update_terminal_active')}
      if (host.current() !== live || session.held()) {throw new Error('work_update_owner_changed')}

      updatePrepared = true

      return { id: randomUUID(), accountKey: live.accountKey, pin: target.version }
    },
    cancelPreparedUpdate() {updatePrepared = false},
    async resumeUpdate() {
      const expected = deps.plannedUpdate?.work
      if (!expected || resumed) {
        startingUpdate = false
        return
      }
      await resolveOwner()
      if (account()?.key !== expected.accountKey || !host.enabled() || readShippedPin(deps.resources).version !== expected.pin) {
        throw new Error('work_update_owner_unavailable')
      }
      const live = host.current() ?? await session.start()
      if (live.accountKey !== expected.accountKey) {throw new Error('work_update_owner_changed')}
      resumed = true
      startingUpdate = false
    },
    modelKeys: () => modelKeys.keys(),
    modelRoute: () => account() ? 'open' : 'refused'
  }
}
