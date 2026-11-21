import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session } from 'electron'

import { MATRIX_WORK_IPC, type MatrixWorkProjection } from '../../shared/matrix-work'
import type { ManagedModelAccessSnapshot } from '../../src/lib/atum-managed-model-access'
import type { SafeStorageLike } from '../encrypted-store'
import {
  createDeviceServicePlatform,
  type GateEvent,
  type OwnerEventVerifier,
  type WorkGateService
} from '../work/gate'
import {
  createOwnerEventVerifier,
  createSdkOwnerEventSource,
  createWorkGateService,
  type OwnerSdkHost,
  WorkMount,
  type WorkMountAccount
} from '../work/mount'
import { type PinRef, type UpdateOutcome, WorkSession, workSessionPaths } from '../work/session'
import { WorkHost } from '../work/sidecar/host'
import {
  createWorkViewFactory,
  type GateSurfaceState,
  registerMatrixWorkIpc,
  WorkSurface,
  type WorkSurfaceParts
} from '../work/surface'

import { MatrixWorkLifecycle, workAccountFor } from './work-lifecycle'

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

/** The model name Work's provider advertises; the proxy maps every Atum model name to the model the call should use. */
const WORK_DEFAULT_MODEL = 'binh-minh'

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
  /** The owner's platform principal (the enrollment's), the account id the platform keys Work by. */
  ownerPrincipal(): string | undefined
  deviceServiceId(): string | undefined
  /** The platform's `device-services` endpoint: `${resource}/device-services`. */
  deviceServicesEndpoint(): string | undefined
  /** The signed-in owner's current domain bearer. */
  bearer(): Promise<string>
  /** The owner's own SDK host (`hosts.get('human')`), for the verifier. */
  ownerHost(): OwnerSdkHost | undefined
  /** The Matrix user of the active agent with this principal (`account.agents()`), or null. */
  agentMatrixUser(principal: string): Promise<string | null>
  /** The account's own name for an agent, for "Started by …". */
  agentName(principal: string): string | undefined
  /** The owner's top-up page (what `openTopUp` opens). */
  openProtons(): Promise<void>
  publish(channel: string, payload: MatrixWorkProjection | null): void
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
  retire(): Promise<void>
  /** App quit: not a revocation. */
  quit(): Promise<void>
  /** The local keys Work's gateways present to the model proxy, in `MatrixManagedModel`'s `keys()` shape. */
  modelKeys(): [key: string, role: string][]
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
export function createGateDoor(mount: Pick<WorkMount, 'acceptWorkGrant' | 'onChange' | 'service' | 'setSwitch'>): NonNullable<WorkSurfaceParts['gate']> {
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
export async function readWorkAccess(model: MatrixWorkModelPort, wallet: MatrixWorkWalletPort): Promise<'allowed' | 'empty' | 'unavailable'> {
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

    this.bound ??= { key: randomBytes(32).toString('base64url'), accountKey: scope.accountKey, generation: scope.generation }

    return this.bound.key
  }

  keys(): [key: string, role: string][] {
    if (!this.bound) {
      return []
    }

    const scope = this.ports.scope()

    if (!scope || this.ports.closing() || scope.accountKey !== this.bound.accountKey || scope.generation !== this.bound.generation) {
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
    const raw = JSON.parse(readFileSync(join(resources, 'work-runtime', 'pin.json'), 'utf8')) as { version?: unknown; sha256?: unknown }

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

  const rootFor = (accountKey: string) => join(deps.userData, 'work-accounts', accountKey.slice(0, 32))

  const account = (): WorkMountAccount | undefined =>
    deps.closing()
      ? undefined
      : workAccountFor({
          scope: deps.scope(),
          ownerPrincipal: deps.ownerPrincipal(),
          deviceServiceId: deps.deviceServiceId(),
          rootFor
        })

  const host = new WorkHost({
    resources: deps.resources,
    account,
    gatewayEnvironment: () => {
      const baseUrl = deps.model.baseUrl()

      if (!baseUrl) {
        throw new Error('work_model_unavailable')
      }

      return {
        ATUM_MANAGED_MODEL_BASE_URL: baseUrl,
        ATUM_MANAGED_MODEL_DEFAULT: WORK_DEFAULT_MODEL,
        ATUM_MANAGED_MODEL_PROXY_TOKEN: modelKeys.mint()
      }
    },
    // A stopped or replaced server leaves no key the proxy would still answer to.
    revokeCredentials: () => modelKeys.forget(),
    // The one place the gate and the owner view read Work's balance: a free probe through the proxy.
    accessState: async () => {
      const access = await readWorkAccess(deps.model, deps.wallet)

      return access === 'allowed'
        ? ({ state: 'ready', access_alias: 'binh-minh' } as unknown as ManagedModelAccessSnapshot)
        : access === 'empty'
          ? ({ state: 'insufficient_funds', access_alias: 'binh-minh' } as unknown as ManagedModelAccessSnapshot)
          : { state: 'unavailable' }
    },
    openProtons: deps.openProtons
  })

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
      // An update does not start while any stop is owed. No running gate means no stop this run could owe.
      stopsOwed: () => (mount?.service()?.ledger.owedRows().length ?? 0) > 0,
      log: event => deps.log(`[atum-work] update ${event}`)
    }
  })

  // The gate's `restartWhenIdle`, the mount that builds the gate and the surface that holds the view need each other.
  let mount!: WorkMount
  let surface!: WorkSurface

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

  const verifier: OwnerEventVerifier = createOwnerEventVerifier(
    createSdkOwnerEventSource({ owner: () => deps.ownerHost(), agentMatrixUser: principal => deps.agentMatrixUser(principal) })
  )

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
        owner: verifier,
        incarnation: () => host.current(),
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
    createView: createWorkViewFactory({
      window: () => deps.ui() ?? null,
      preload: deps.workPreload,
      zoomFactor: deps.zoomFactor,
      radius: 14,
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
        await mount.workOn()
      } else {
        await mount.workOff()
      }
    }
  })

  registerMatrixWorkIpc(deps.ipcMain, surface, deps.requireUi)

  const door = createGateDoor(mount)

  const parts = (): WorkSurfaceParts => ({
    session,
    enabled: () => host.enabled(),
    gate: door,
    readAccess: () => readWorkAccess(deps.model, deps.wallet),
    wantServer: () => mount.wantServer()
  })

  const lifecycle = new MatrixWorkLifecycle({
    account,
    // A build without the staged runtime or the owner-view preload cannot run Work: draw nothing rather than an entry
    // that fails on click. The model proxy must be up for the same reason.
    prepare: async () => {
      if (!existsSync(join(deps.resources, 'work-runtime', 't3')) || !existsSync(deps.workPreload)) {
        throw new Error('work_not_in_this_build')
      }

      if (!deps.model.baseUrl()) {
        throw new Error('work_model_unavailable')
      }
    },
    // Retirement and quit drop the model key (and cancel its forwards) synchronously, before any await.
    mount: {
      setSurface: value => mount.setSurface(value),
      reconcile: () => mount.reconcile(),
      retire: account => {
        modelKeys.forget()

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
    activate: () => {
      // keys() drops a key whose account or generation is no longer the signed-in one, and cancels its forwards
      modelKeys.keys()

      return lifecycle.activate()
    },
    retire: async () => {
      modelKeys.forget()
      await lifecycle.retire()
    },
    quit: () => {
      modelKeys.forget()

      return lifecycle.quit()
    },
    update: target => session.update(target),
    modelKeys: () => modelKeys.keys()
  }
}
