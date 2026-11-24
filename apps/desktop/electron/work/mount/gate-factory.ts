import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { WORK_RELAY_PROVIDER } from '../../../shared/matrix-work-relay'
import type { SafeStorageLike } from '../../encrypted-store'
import { type GateAccount, WorkGateService, type WorkGateServiceOptions } from '../gate'
import { WORK_SOCKET_PATH_MAX_BYTES } from '../gate/contract'
import type { GateOptions } from '../gate/gate'
import type { ModelAccess, OwnerEventVerifier, T3Port, WorkPlatform } from '../gate/ports'
import type { RelayHistory } from '../gate/relay'
import { createT3PairingCodes, T3Sessions } from '../gate/sessions'
import { createT3Client } from '../gate/t3-client'
import { workSessionPaths } from '../session/paths'
import { createT3AuthCli } from '../session/t3-auth'
import { ATUM_WORK_DELEGATED_PROVIDER, ATUM_WORK_MODEL, type WorkIncarnation } from '../sidecar/process'

import { RelayAssembly, type RelayAssemblyOptions, relayProtectedRoots } from './relay-assembly'
import { createKeychainSecretStore } from './secret-store'

export interface WorkMountAccount extends GateAccount {
  /** The signed-in account's id (a UUID). The gate serves one account's home. */
  accountId: string
}

/**
 * The gate's socket: a SHORT path in a directory main creates for this enrollment (the platform writes it into the
 * tunnel's ingress; macOS allows about 104 bytes). One directory per account, so a sign-out removes one account's
 * address and a switch leaves none for the next account. The caller supplies `base` (a private, short, user-owned
 * directory such as `~/.atum/w`); the gate itself refuses a directory that is not owned by the user and 0700.
 */
export function workSocketPath(account: Pick<GateAccount, 'key'>, base: string): string {
  const path = join(base, createHash('sha256').update(account.key).digest('hex').slice(0, 12), 'g')

  if (Buffer.byteLength(path) > WORK_SOCKET_PATH_MAX_BYTES) {
    throw new Error('socket_path_too_long')
  }

  return path
}

export interface WorkGateFactoryInput {
  relayRuntimeReady?: GateOptions['relayRuntimeReady']
  relayLimit?: GateOptions['relayLimit']
  account: WorkMountAccount
  /** This Mac's device-service id (from device enrollment): where the platform knows this Mac. */
  deviceServiceId: string
  platform: WorkPlatform
  readPlanCapabilities?: WorkGateServiceOptions['readPlanCapabilities']
  /** Main's own Matrix check of the owner's request (K35). Until one is supplied every launch is `unavailable`. */
  relayHistory?: RelayHistory
  relaySelection?: GateOptions['relaySelection']
  relayAssistant?: Pick<RelayAssemblyOptions, 'assistantsRoot' | 'definition'>
  owner: OwnerEventVerifier
  /** The running session server, or undefined while none serves. Read on every call: an update changes it. */
  incarnation(): WorkIncarnation | undefined
  /** Lane S: `WorkHost.authTools(paths)`: the CURRENT pin's `t3` and the sidecar's environment. */
  authTools(paths: ReturnType<typeof workSessionPaths>): { executable: string; environment: Record<string, string> }
  /** The app's secure storage (Electron safeStorage, Keychain-held key). */
  safeStorage: SafeStorageLike
  /** Lane S: `WorkHost.readModelAccess(incarnation)`. */
  modelAccess(incarnation: WorkIncarnation): Promise<ModelAccess>
  /** Lane R: `WorkSession.held()`. */
  held(): boolean
  /** The name T3 shows on an assistant's threads ("Started by …"). */
  agentName?(principal: string): string
  socketBase: string
  restartWhenIdle?: T3Port['restartWhenIdle']
  fetchJwks?: WorkGateServiceOptions['fetchJwks']
  syncIntervalMs?: number
  log?: WorkGateServiceOptions['log']
  now?: () => number
  /** Tests only: replace the T3 client. */
  t3?: T3Port
}

/** One account's Work gate with every port main owns filled in. Built once per signed-in account. */
export function createWorkGateService(input: WorkGateFactoryInput): WorkGateService {
  const { account } = input
  const paths = workSessionPaths(account)
  const secrets = createKeychainSecretStore({ account, safeStorage: input.safeStorage, onFailure: code => input.log?.('secret_store_failure', { code }) })

  // Resolved on every call: after an update the pin's `t3` differs and the origin changes with every incarnation.
  const auth = () => {
    const tools = input.authTools(paths)

    return createT3AuthCli({ executable: tools.executable, home: paths.home, environment: tools.environment })
  }

  const t3 =
    input.t3 ??
    createT3Client({
      origin: () => input.incarnation()?.origin,
      incarnation: () => input.incarnation()?.id,
      settingsFile: join(paths.userdata, 'settings.json'),
      delegatedGatewayReady: () => {
        try {
          const pid = input.incarnation()?.pid

          return Boolean(pid && readFileSync(join(paths.userdata, 'delegated-gateway-ready'), 'ascii') === String(pid))
        } catch {
          return false
        }
      },
      delegated: { instanceId: ATUM_WORK_DELEGATED_PROVIDER, model: ATUM_WORK_MODEL },
      // Gate 4b-1: the Codex instance, compiled in for launch admission.
      plan: { instanceId: WORK_RELAY_PROVIDER.codex.instanceId },
      restartWhenIdle: input.restartWhenIdle
    })

  let assembly: RelayAssembly | undefined
  let ownerToken: (() => Promise<string>) | undefined

  const service = new WorkGateService({
    account,
    accountId: account.accountId,
    deviceServiceId: input.deviceServiceId,
    platform: input.platform,
    readPlanCapabilities: input.readPlanCapabilities,
    relayRuntimeReady: input.relayRuntimeReady,
    relayLimit: input.relayLimit,
    owner: input.owner,
    relayHistory: input.relayHistory,
    relaySelection: input.relaySelection ?? (principal => assembly?.selection(principal)),
    relayProvision: input.relayAssistant ? (principal, threadId) => {
      if (!assembly) {throw new Error('relay_unavailable')}

      return assembly.provision(principal, threadId)
    } : undefined,
    t3,
    delegated: { instanceId: ATUM_WORK_DELEGATED_PROVIDER, model: ATUM_WORK_MODEL },
    held: input.held,
    modelAccess: async () => {
      const incarnation = input.incarnation()

      return incarnation ? input.modelAccess(incarnation) : 'unavailable'
    },
    socketPath: workSocketPath(account, input.socketBase),
    sessions: ledger => {
      const sessions = new T3Sessions({
        origin: () => input.incarnation()?.origin,
        pairing: {
          create: label => {
            const tools = input.authTools(paths)

            return createT3PairingCodes({ executable: tools.executable, home: paths.home, environment: tools.environment }).create(label)
          }
        },
        auth: { sessionIds: () => auth().sessionIds(), revokeSession: id => auth().revokeSession(id) },
        store: secrets,
        agentName: input.agentName ?? (() => 'Assistant'),
        unfinished: principal => ledger.hasUnfinished(principal),
        knownAgents: () => ledger.agents().map(agent => agent.principal)
      })

      ownerToken = async () => (await sessions.owner()).token

      return sessions
    },
    fetchJwks: input.fetchJwks,
    syncIntervalMs: input.syncIntervalMs,
    log: input.log,
    now: input.now
  })

  if (input.relayAssistant) {
    assembly = new RelayAssembly({
      ...input.relayAssistant, ledger: service.ledger, t3,
      protectedRoots: relayProtectedRoots(homedir(), input.relayAssistant.assistantsRoot),
      ownerToken: () => {
        if (!ownerToken) {throw new Error('relay_unavailable')}

        return ownerToken()
      },
      fresh: () => service.gate.entitlementsFresh(),
      now: input.now
    })
  }

  return service
}
