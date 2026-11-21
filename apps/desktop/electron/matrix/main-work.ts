import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
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
import { WorkSession, workSessionPaths } from '../work/session'
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

/** The balance read, from a free probe through the model proxy. `out_of_protons` is the one answer that says "empty". */
export async function readWorkAccess(model: MatrixWorkModelPort): Promise<'allowed' | 'empty' | 'unavailable'> {
  try {
    const answer = await model.probe(MATRIX_WORK_MODEL_ROLE)

    if (answer.ok === true) {
      return 'allowed'
    }

    return answer.code === 'out_of_protons' ? 'empty' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

export function createMatrixWork(deps: MatrixWorkDeps): MatrixWork {
  let modelKey: string | undefined

  const mintKey = () => (modelKey ??= randomBytes(32).toString('base64url'))
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
        ATUM_MANAGED_MODEL_PROXY_TOKEN: mintKey()
      }
    },
    // A stopped or replaced server leaves no key the proxy would still answer to.
    revokeCredentials: () => {
      modelKey = undefined
    },
    // The one place the gate and the owner view read Work's balance: a free probe through the proxy.
    accessState: async () => {
      const access = await readWorkAccess(deps.model)

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
    readAccess: () => readWorkAccess(deps.model)
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
    mount,
    attach: value => surface.attach(value),
    parts,
    log: line => deps.log(line)
  })

  return {
    activate: () => lifecycle.activate(),
    retire: async () => {
      await lifecycle.retire()
    },
    quit: () => lifecycle.quit(),
    modelKeys: () => (modelKey ? [[modelKey, MATRIX_WORK_MODEL_ROLE]] : [])
  }
}
