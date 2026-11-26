import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { availableParallelism, loadavg } from 'node:os'
import { join } from 'node:path'

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session } from 'electron'

import type { WorkAttentionSnapshot, WorkSidebarSnapshot, WorkSurfaceModeSnapshot } from "../../shared/matrix-work"
import { MATRIX_WORK_IPC, type MatrixWorkProjection } from '../../shared/matrix-work'
import type { SafeStorageLike } from '../encrypted-store'
import { admitConnector } from '../work/connector/admission'
import { ConnectorHttp } from '../work/connector/http'
import { matrixConnector } from '../work/connector/matrix'
import { ConnectorService } from '../work/connector/service'
import type { ShellMcpOptions } from '../work/connector/shell-mcp'
import {
  createDeviceServicePlatform,
  createWorkConsentClient,
  type GateEvent,
  GateLedger,
  type OwnerEventVerifier,
  workGatePaths,
  type WorkGateService
} from '../work/gate'
import { deviceServiceCall } from '../work/gate/platform'
import { createT3PairingCodes } from '../work/gate/sessions'
import {
  createKeychainSecretStore,
  createOwnerEventVerifier,
  createSdkOwnerEventSource,
  createWorkGateService,
  type OwnerSdkHost,
  WorkMount,
  type WorkMountAccount
} from '../work/mount'
import { createWorkHistory } from '../work/mount/history'
import { homeRunningFromRuntimeFile, partitionFor, type PinRef, type UpdateOutcome, WorkSession, workSessionPaths } from '../work/session'
import { removeDurably } from '../work/session/files'
import { createT3AuthCli } from '../work/session/t3-auth'
import { type WorkAccess, WorkHost } from '../work/sidecar/host'
import { workRelayRuntimeReady } from '../work/sidecar/process'
import { T3McpWithdrawalError, WorkT3McpPublication } from '../work/sidecar/t3-mcp'
import {
  createWorkViewFactory,
  type GateSurfaceState,
  registerMatrixWorkIpc,
  WorkSurface,
  type WorkSurfaceParts
} from '../work/surface'
import { readAccountConnections } from '../work/surface/account-connections'
import { projectPlanCapabilities } from '../work/surface/plan-capabilities'
import { readPlanUsage } from '../work/surface/plan-usage'
import { readWorkProviders } from '../work/surface/provider-config'
import { createOwnerRelay } from '../work/surface/relay'

import type { MatrixAgentDefinitionSnapshot } from './agent-definition'
import { MatrixWorkLifecycle, workAccountFor } from './work-lifecycle'

/** Atum's panel radius (`--atum-r-panel`, styles.css): Work's native view is rounded to it. */
export const WORK_VIEW_RADIUS = 14

// The Matrix composition's Work (self-work slice A, lane W). Everything Work needs from the Matrix window is a port
// here, so this file holds no account logic of its own: it builds the app-wide objects once (host, session, mount,
// surface, IPC) and gives `MatrixWorkLifecycle` the account to bind them to.
//
// The model path is the Matrix managed-model loopback (`managed-model.ts`), not the retired desktop proxy: Work's
// Hermes gateways present a key this module mints, the proxy adds the person's domain bearer and the gateway holds
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
  /** The account's own name for an agent, for "Started by …". */
  agentName(principal: string): string | undefined
  /** The existing account agent-record/definition reader, fenced to the signed-in account. */
  agentDefinition?(principal: string): Promise<MatrixAgentDefinitionSnapshot>
  /** The owner's top-up page (what `openTopUp` opens). */
  openProtons(): Promise<void>
  publish(channel: string, payload: MatrixWorkProjection | WorkSurfaceModeSnapshot | WorkSidebarSnapshot | WorkAttentionSnapshot | null): void
  /** Main's `closing`: nothing starts while the app quits. */
  closing(): boolean
  log(line: string): void
}

export interface MatrixWork {
  /** Main-owned update of the pinned Work server (snapshot, trial, commit or rollback). Refused while a stop is owed. */
  update(target: PinRef): Promise<UpdateOutcome>
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

// What the page sees of a gate that has not started: nothing enrolled, so no Work entry for assistants.
const NO_GATE: GateSurfaceState = {
  phase: 'closed',
  workGrantAccepted: false,
  switchOn: true,
  enrolled: false,
  socket: 'unbound',
  agents: []
}

/**
 * The surface's gate door over a gate that is built later (the mount starts it after the session and the enrollment),
 * and rebuilt after a retire. State and events follow whichever service the mount holds now.
 */
export function createGateDoor(
  mount: Pick<WorkMount, 'acceptWorkGrant' | 'onChange' | 'service' | 'setPlanSwitch' | 'setSwitch'>
): NonNullable<WorkSurfaceParts['gate']> {
  return {
    state: () => {
      const service = mount.service()

      return service ? service.state() : NO_GATE
    },
    on(listener: (event: GateEvent) => void) {
      let followed: WorkGateService | undefined
      let unfollow: (() => void) | undefined

      const follow = () => {
        const service = mount.service()

        if (service === followed) {
          return
        }

        unfollow?.()
        followed = service
        unfollow = service?.on(listener)
      }

      follow()

      const stop = mount.onChange(() => {
        follow()
        listener({ type: 'change' })
      })

      return () => {
        stop()
        unfollow?.()
      }
    },
    acceptWorkGrant: () => mount.acceptWorkGrant(),
    setSwitch: on => mount.setSwitch(on),
    setPlanSwitch: on => mount.setPlanSwitch(on),
    async openRoute() {
      await mount.service()?.openRoute()
    },
    async closeRoute() {
      await mount.service()?.closeRoute()
    }
  }
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
  const modelKeys = new WorkModelKeys({
    scope: () => deps.scope(),
    closing: () => deps.closing(),
    abort: role => deps.model.abortRole?.(role)
  })

  const accountsDir = join(deps.userData, 'work-accounts')
  const rootFor = (accountKey: string) => join(accountsDir, accountKey.slice(0, 32))

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

  const account = (): WorkMountAccount | undefined =>
    deps.closing()
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

  const stopT3Mcp = () => {
    clearInterval(mcpTimer)
    mcpTimer = undefined
    t3Mcp.stop()
  }

  const deviceCall = (endpoint: string, scope: NonNullable<ReturnType<MatrixWorkDeps['scope']>>, current?: () => boolean) =>
    deviceServiceCall({
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
    revokedDeviceServiceId?: string
  ) => {
    const scope = deps.scope()
    const endpoint = deps.deviceServicesEndpoint()
    const call = scope?.accountKey === bound.key && scope.generation === bound.generation && endpoint
      ? deviceCall(endpoint, scope, () => !deviceServiceId || !revokedDevices.has(deviceServiceId))
      : undefined

    await t3Mcp.clear(mcpCustody(bound), {
      revokedDeviceServiceId,
      shell: deviceServiceId && call ? { deviceServiceId, call } : undefined
    }).catch(error => logMcpFailure(error, 't3_mcp_clear_failed'))
  }

  const refreshT3Mcp = () => {
    const running = host.current()
    const active = account()
    const scope = deps.scope()
    const deviceServiceId = deps.deviceServiceId()
    const endpoint = deps.deviceServicesEndpoint()

    if (!running || !active || !scope || !deviceServiceId || !endpoint || revokedDevices.has(deviceServiceId) ||
        running.accountKey !== scope.accountKey || running.generation !== scope.generation) {return}

    const current = () => {
      const present = deps.scope()

      return Boolean(mcpTimer) && !deps.closing() && host.current() === running &&
        present?.accountKey === scope.accountKey && present.generation === scope.generation &&
        deps.deviceServiceId() === deviceServiceId && !revokedDevices.has(deviceServiceId)
    }
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
    ready: () => {
      mcpTimer ??= setInterval(refreshT3Mcp, 60_000).unref()
      refreshT3Mcp()
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
    // The one place the gate and the owner view read Work's balance: a free probe through the proxy.
    readAccess: () => readWorkAccess(deps.model, deps.wallet),
    openProtons: deps.openProtons
  })

  const readNativePlanCapabilities = async (bound: WorkMountAccount) => {
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

  host.registerOwnerPreload()

  const session = new WorkSession({
    account,
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
      // An update does not start while any stop is owed: the running gate's, or (no gate this run, or none yet) the durable stop
      // ledger's. A stop owed only blocks the update while a server could still be holding the work: a home no server runs
      // (the app was quit and replaced) has nothing to protect, and the stop settles when the gate starts on the updated pin.
      stopsOwed: () => {
        if ((mount?.service()?.ledger.owedRows().length ?? 0) > 0) {
          return true
        }

        const current = account()

        if (!current || GateLedger.owedCountAt(workGatePaths(current).ledger) === 0) {
          return false
        }

        return host.current() !== undefined || homeRunningFromRuntimeFile(workSessionPaths(current))()
      },
      log: event => deps.log(`[atum-work] update ${event}`)
    }
  })

  // The gate's `restartWhenIdle`, the mount that builds the gate and the surface that holds the view need each other.
  let mount!: WorkMount
  let surface!: WorkSurface
  let planUsage: { incarnation: string; reports: Awaited<ReturnType<typeof readPlanUsage>> } | undefined

  const restartWhenIdle = async (): Promise<'restarted' | 'declined'> => {
    const gate = mount.service()?.gate

    if (!gate || !(await gate.ownerRunsIdle())) {
      return 'declined'
    }

    try {
      // Stop, reset auth, start: the one sanctioned restart. The page's view closes first and comes back after it.
      await surface.suspend(() => session.restart('pairing-failed'))

      return 'restarted'
    } catch {
      return 'declined'
    }
  }

  const ownerSource = createSdkOwnerEventSource({
    owner: () => deps.ownerHost(),
    agentMatrixUser: principal => deps.agentMatrixUser(principal)
  })

  const verifier: OwnerEventVerifier = createOwnerEventVerifier(ownerSource)
  const relayHistory = createWorkHistory(ownerSource, () => deps.ownerHost())

  mount = new WorkMount({
    account,
    session,
    host,
    homeExists: current => existsSync(workSessionPaths(current).home),
    createGate: (current): WorkGateService | undefined => {
      const deviceServiceId = deps.deviceServiceId()
      const endpoint = deps.deviceServicesEndpoint()

      // No device enrollment or no platform: Work still opens for the owner; the assistants' route does not exist.
      if (!deviceServiceId || !endpoint) {
        return undefined
      }

      return createWorkGateService({
        account: current,
        deviceServiceId,
        platform: createDeviceServicePlatform({ endpoint, bearer: () => deps.bearer() }),
        readPlanCapabilities: () => readNativePlanCapabilities(current),
        owner: verifier,
        relayHistory,
        relayAssistant: deps.agentDefinition
          ? {
              assistantsRoot: join(deps.home, 'Atum', 'Assistants'),
              definition: async principal => {
                const snapshot = await deps.agentDefinition!(principal)
                const active = account()

                if (
                  !active ||
                  active.key !== current.key ||
                  active.generation !== current.generation ||
                  deps.closing()
                ) {
                  throw new Error('relay_account_changed')
                }

                return snapshot
              }
            }
          : undefined,
        incarnation: () => host.current(),
        relayRuntimeReady: () => host.current()?.relayRuntimeReady === true,
        relayLimit: plan => {
          const usage = planUsage
          const report = usage?.incarnation === host.current()?.id && usage?.reports.find(each => each.plan === plan)

          return report && (report.resetsAt === undefined || report.resetsAt > Date.now())
            ? { state: report.state, resetAt: report.resetsAt }
            : { state: 'unknown' }
        },
        authTools: paths => host.authTools(paths),
        safeStorage: deps.safeStorage,
        modelAccess: incarnation => host.readModelAccess(incarnation),
        held: () => session.held(),
        agentName: principal => deps.agentName(principal) ?? 'Assistant',
        socketBase: join(deps.home, '.atum', 'w'),
        restartWhenIdle,
        log: (event, fields) => deps.log(`[atum-work] gate ${event} ${JSON.stringify(fields ?? {})}`)
      })
    },
    log: (event, fields) => deps.log(`[atum-work] ${event} ${JSON.stringify(fields ?? {})}`)
  })

  surface = new WorkSurface({
    canPrewarm: () => loadavg()[0] < availableParallelism(),
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
        await mount.workOn()
      } else {
        await mount.workOff()
      }
    }
  })

  registerMatrixWorkIpc(deps.ipcMain, surface, deps.requireUi)

  const door = createGateDoor(mount)

  // The endpoint is read on every call (it follows the signed-in account), like the gate's own platform client.
  const consentFor = () => {
    const endpoint = deps.deviceServicesEndpoint()

    if (!endpoint) {
      throw Object.assign(new Error('work_consent_unavailable'), { code: 'work_consent_unavailable' })
    }

    return createWorkConsentClient({ endpoint, bearer: () => deps.bearer() })
  }

  const consentClient: NonNullable<WorkSurfaceParts['consent']> = {
    read: plan => consentFor().read(plan),
    set: input => consentFor().set(input),
    revoke: plan => consentFor().revoke(plan)
  }

  const parts = (): WorkSurfaceParts => ({
    session: {
      async openOwnerView(createView) {
        const outcome = await session.openOwnerView(createView)

        // First launch needs the freshly paired owner cookie; the server-ready tick may have preceded it.
        if (outcome.state !== 'failed') {refreshT3Mcp()}

        return outcome
      }
    },
    enabled: () => host.enabled(),
    gate: door,
    readAccess: () => readWorkAccess(deps.model, deps.wallet),
    async readPlanUsage() {
      const running = host.current()
      const service = mount.service()

      if (!running || !host.enabled()) {return []}

      const reports = await readPlanUsage(running.origin, deps.sessionFromPartition(partitionFor(running.accountKey)))

      if (host.current()?.id !== running.id || mount.service() !== service) {return []}

      planUsage = { incarnation: running.id, reports }

      return reports.map(({ windowStart, ...limit }) => ({
        ...limit,
        ...(service && windowStart !== undefined
          ? { scheduledRuns: service.ledger.scheduledRuns(windowStart, limit.resetsAt, limit.plan) }
          : {})
      }))
    },
    wantServer: () => mount.wantServer(),
    prepareChatGptConnect: () => deps.prepareChatGptConnect(),
    readConnections: () => readAccountConnections({
      endpoint: () => deps.deviceServicesEndpoint(),
      bearer: () => deps.bearer(),
      thisDevice: () => deps.deviceServiceId(),
      localCapabilities: () => {
        const active = account()

        return active ? readNativePlanCapabilities(active) : Promise.resolve({})
      }
    }),
    // Work's own provider view owns the login. The staged T3 pin must enforce own-thread MCP scope.
    planConnectOpen: () => host.current()?.relayRuntimeReady ?? workRelayRuntimeReady(deps.resources),
    deviceServiceId: () => deps.deviceServiceId(),
    relay: createOwnerRelay(mount, async () => {
      const bound = account()
      const deviceServiceId = deps.deviceServiceId()

      if (!bound || !deviceServiceId || revokedDevices.has(deviceServiceId)) {return null}

      const observed = await readNativePlanCapabilities(bound)
      const active = account()

      if (active?.key !== bound.key || active.generation !== bound.generation ||
          deps.deviceServiceId() !== deviceServiceId || revokedDevices.has(deviceServiceId)) {return null}

      const store = mcpStore(bound)

      return {
        published: t3Mcp.isPublished(store, deviceServiceId),
        plans: t3Mcp.planCatalog(store, deviceServiceId, observed)
      }
    }, () => ({
      endpoint: deps.deviceServicesEndpoint() ?? '',
      bearer: () => deps.bearer()
    })),
    consent: consentClient
  })

  const lifecycle = new MatrixWorkLifecycle({
    account,
    // A build without the staged runtime or the owner-view preload cannot run Work: draw nothing rather than an entry
    // that fails on click. Proxy availability belongs to runtime startup, not discovery.
    prepare: async () => {
      if (!existsSync(join(deps.resources, 'work-runtime', 't3')) || !existsSync(deps.workPreload)) {
        throw new Error('work_not_in_this_build')
      }
    },
    // Retirement and quit drop the model key (and cancel its forwards) synchronously, before any await.
    mount: {
      setSurface: value => mount.setSurface(value),
      reconcile: () => mount.reconcile(),
      retire: async (account, deviceServiceId = deps.deviceServiceId()) => {
        stopT3Mcp()
        modelKeys.forget()

        await clearT3Mcp(account, deviceServiceId && !revokedDevices.has(deviceServiceId) ? deviceServiceId : undefined)

        return mount.retire(account)
      },
      quit: () => {
        modelKeys.forget()

        return mount.quit()
      },
      state: () => mount.state()
    },
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
    setMacPlanFactsEnabled: (deviceServiceId, enabled) => mount.setMacPlanFactsEnabled(deviceServiceId, enabled),
    update: target => session.update(target),
    modelKeys: () => modelKeys.keys(),
    modelRoute: () => account() ? 'open' : 'refused'
  }
}
