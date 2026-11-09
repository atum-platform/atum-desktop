/**
 * The Mac device runtime: WS-4's composition root (S1 build plan §4 WS-4, "the device-service
 * bootstrap"). It builds the device service and everything behind it — the durable ledger, the owner's
 * standing grants, the audit log, the egress proxy, the Python device host behind the disclaim
 * launcher, the GUI broker, the indicator, device-local sudo — from the few things only Electron main
 * knows (paths, the sealed store, the tray, native dialogs) and from WS-3b's identity (the Secure
 * Enclave signer, the enrollment, the connection). Nothing here imports Electron, so it is tested whole.
 *
 * Electron main (`main.ts`, the device-service section) creates it once, attaches `service` to WS-3b's
 * `DeviceConnection` (`connection.attach(runtime.service)`), reports `hello()` in the connection's Hello,
 * registers `fence` as the synchronous Stop fence for sign-out, account switch, sleep and quit, and
 * answers the Settings › Device bridge with `request`.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import path from 'node:path'

import {
  answerApproval,
  type ApprovalAnswer,
  type ApprovalChoice,
  approvalChoiceWords,
  approvalReasonText,
  type ApprovalSigner,
  requestApproval
} from './approvals'
import { type AuditWriter, FileAuditWriter } from './audit'
import { deviceMessageHash } from './canonical'
import { type ChatGptRelayCall, ChatGptRelayHandler, type ChatGptRelayRequestBody } from './chatgpt-relay'
import type {
  DeviceArtifact,
  DeviceExecutor,
  DeviceExecutorContext,
  DeviceProtectedCapability,
  ProgressOrReceipt,
  VerifiedExecute,
  WorkspaceCopies
} from './contracts'
import { EgressProxy } from './egress-proxy'
import { type ApprovalKeyRef, GrantsStore, type StandingGrant } from './grants-store'
import { GuiBroker } from './gui-broker'
import { DeviceHostSupervisor, HostDeviceExecutor } from './host'
import { DeviceIndicator, indicatorWords, type TrayLike } from './indicator'
import { DeviceLedger } from './ledger'
import { appBundleOf } from './protected-paths'
import { type DeviceIdentityFacts, type DeviceOutboundType, DeviceService, type OriginLogEntry } from './service'
import type { StopReason } from './stop'
import { runDeviceSudo, SudoPasswordWindow } from './sudo'
import { type ConflictCopyRelay, pruneWorkspaceCopies, workspaceCopyDigest } from './workspace'
import { DeviceWorkspaceLifecycle } from './workspace-lifecycle'

/** A string store sealed by safeStorage (an `EncryptedStore` scope). */
export interface DeviceRuntimeStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface DeviceRuntimeEnvironment {
  readonly platform: NodeJS.Platform
  /** Electron `userData` (agent commands can neither read nor write it). */
  readonly userData: string
  /** The owner's home. */
  readonly home: string
  /** `process.execPath`: Atum's own binary, exec-denied to device commands. */
  readonly appExecutable: string
  /** The staged disclaim launcher, or null when it is missing from this build. */
  readonly launcherPath: string | null
  /** The bundled Hermes runtime, or null when this build has none. */
  readonly hermes: { python: string; source: string } | null
  /** CuaDriver's control socket, denied to device commands. */
  readonly cuaDriverSocket: string
  /** Whether CuaDriver is installed here (the GUI broker needs it). */
  cuaDriverAvailable(): boolean
  readonly store: DeviceRuntimeStore
  locale(): string | undefined
  /** The owner's SSH agent socket, handed only to an approved `ssh_agent` command. */
  sshAuthSock(): string | undefined
  /** One native UI signal when macOS refuses Desktop, Documents or Downloads. */
  onProtectedFolderDenied?(): void
  /** The current account's closed Mac folders; the sandbox denies them on every command. */
  closedFolders?(): readonly string[]
  /** Folders the owner shared inside a closed one; the sandbox lets commands reach them. */
  sharedInsideClosedFolders?(): readonly string[]

  // ---- WS-3b: identity, enrollment and the connection (wired in A-2)
  identity(): DeviceIdentityFacts | null
  originLog(): readonly OriginLogEntry[]
  send(type: DeviceOutboundType, body: Record<string, unknown>): Promise<boolean>
  sendArtifact?(commandId: string, artifact: DeviceArtifact): Promise<boolean>
  accountEpoch?(): number
  /** The Secure Enclave approval signer (WS-3b `SecureEnclaveDeviceKeys`), or null before enrollment. */
  signer(): ApprovalSigner | null
  /** The enrolled approval key, for self-checking signatures and verifying standing grants. */
  approvalKey(): ApprovalKeyRef | null
  deviceServiceId(): string | null
  chatGptRelay?: {
    authority(): { ownerPrincipal: string; agentPrincipals: readonly string[]; deviceServiceId: string } | null
    call(input: { model: string; effort: 'low' | 'medium' | 'high'; request: Record<string, unknown> },
      signal: AbortSignal): Promise<ChatGptRelayCall>
    authorize?(request: ChatGptRelayRequestBody, signal: AbortSignal): Promise<boolean>
  }

  // ---- naming
  agentName(agentUserId: string): string
  /** This Mac's display name, or null for the generic words. */
  deviceName(): string | null

  // ---- native UI owned by main
  tray: {
    createTray(onStop: () => void): TrayLike
    buildStopMenu(status: string, stopLabel: string, onStop: () => void): unknown
    notify(title: string, body: string): void
  }
  /** The native password window for device-local sudo; null when cancelled. */
  promptPassword(command: string): Promise<Buffer | null>
  /**
   * The one-tap choice shown before a Touch ID for a capability that can be granted for good
   * (`GRANTABLE`): allow once, always allow this assistant, or don't. Absent in a build without native
   * UI, where the sheet is the Touch ID alone. A GUI-driving agent can press these buttons, but the
   * Touch ID that follows names exactly what was chosen, so only the owner can finish either path.
   */
  chooseApproval?(input: { message: string; words: { once: string; always: string; deny: string } }): Promise<ApprovalChoice>
  /** Atum's own windows and processes, which the agent may not drive. */
  ownApp(): { bundlePath?: string | null; bundleId?: string | null; pids?: readonly number[] }

  // ---- WS-5 (optional)
  driveRoot?(): string | null
  readonly workspaceCopies?: WorkspaceCopies
  readonly conflictCopies?: Pick<ConflictCopyRelay, 'scan' | 'confirm'>

  log(line: string): void
}

/** What an agent may be given a standing grant for in Settings: only the capabilities that still ask
 * (`ASKING_CAPABILITIES`). The ones that never ask (ssh_agent, persistence, exec_downloaded, gui_upload,
 * new hosts, other-agent writes: owner decision 2026-10-20) need no grant, and sudo and bulk deletes are
 * asked once per task window with no standing "always". */
export const GRANTABLE: readonly DeviceProtectedCapability[] = ['keychain', 'cloud_cli', 'browser_store']

export interface DeviceStatusView {
  readonly available: boolean
  readonly reason?: 'not_macos' | 'launcher_missing' | 'runtime_missing'
  readonly enrolled: boolean
  readonly deviceName: string | null
  readonly cloudAgents: readonly { userId: string; name: string }[]
  readonly grants: readonly (StandingGrant & { agentName: string | null })[]
  readonly grantable: readonly DeviceProtectedCapability[]
  readonly active: boolean
}

export interface DeviceRuntime {
  /** WS-3b's `DeviceFrameSink`: `connection.attach(runtime.service)`. */
  readonly service: DeviceService
  workspaceProtocol?(): 1 | undefined
  start(): Promise<void>
  /** The Stop fence. Synchronous before it returns; its async tail runs on its own. */
  fence(reason: StopReason): void
  stop(): Promise<void>
  /** What this Mac offers, for the connection's Hello. */
  hello(): { terminal: boolean; files: boolean; computer: { available: boolean; reason?: string } }
  /** The Settings › Device bridge. */
  request(input: unknown): Promise<unknown>
  configureChatGptRelay(enabled: boolean, models?: readonly string[]): void
}

class DeviceRequestError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'DeviceRequestError'
  }
}

export function createDeviceRuntime(env: DeviceRuntimeEnvironment): DeviceRuntime {
  const deviceDir = path.join(env.userData, 'device')
  const artifactsDir = path.join(deviceDir, 'artifacts')
  const audit: AuditWriter = new FileAuditWriter(path.join(deviceDir, 'audit'))
  const ledger = new DeviceLedger(env.store)
  const grants = new GrantsStore(env.store, () => env.approvalKey(), line => env.log(line))
  const relayKey = 'chatgpt-relay-v1'
  let relayEnabled = false
  let relayModels: string[] = []
  try {
    const saved = JSON.parse(env.store.getItem(relayKey) ?? 'null') as { enabled?: unknown; models?: unknown } | null
    relayEnabled = saved?.enabled === true
    relayModels = Array.isArray(saved?.models)
      ? saved.models.filter((model): model is string => typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(model)).slice(0, 64)
      : []
  } catch {
    relayEnabled = false
    relayModels = []
  }
  const relay = env.chatGptRelay ? new ChatGptRelayHandler({
    authority: () => {
      const base = env.chatGptRelay?.authority()
      return base ? { ...base, enabled: relayEnabled, models: relayModels } : null
    },
    call: (input, signal) => env.chatGptRelay!.call(input, signal),
    authorize: env.chatGptRelay.authorize
      ? (request, signal) => env.chatGptRelay!.authorize!(request, signal)
      : undefined,
    log: line => env.log(line)
  }) : undefined
  const tasksRoot = path.join(env.home, 'Atum Tasks')
  const savedKey = () => 'device-workspace-saved:' + env.deviceServiceId() + ':' + (env.accountEpoch?.() ?? 0)
  const savedCopies = (key = savedKey()): Record<string, { digest: string; resultHash: string }> => {
    try {
      const value = JSON.parse(env.store.getItem(key) ?? '{}')
      if (!value || typeof value !== 'object' || Array.isArray(value)) {return {}}
      return Object.fromEntries(Object.entries(value).filter(([copy, receipt]: [string, any]) =>
        copy.startsWith(tasksRoot + path.sep) && /^[0-9a-f]{64}$/.test(receipt?.digest)
          && /^[A-Za-z0-9_-]{43}$/.test(receipt?.resultHash))) as Record<string, { digest: string; resultHash: string }>
    } catch {return {}}
  }

  const unavailable: DeviceStatusView['reason'] | undefined =
    env.platform !== 'darwin'
      ? 'not_macos'
      : !env.launcherPath
        ? 'launcher_missing'
        : !env.hermes
          ? 'runtime_missing'
          : undefined

  // The signer, read live: enrollment (WS-3b) may complete after start.
  const signer: ApprovalSigner = {
    approve: (bytes, reason) => {
      const live = env.signer()

      if (!live) {
        return Promise.reject(
          Object.assign(new Error('device_key_approval_unavailable'), { code: 'approval_unavailable' })
        )
      }

      return live.approve(bytes, reason)
    }
  }

  const sudoPasswords = new SudoPasswordWindow()

  let workspaceLifecycle: DeviceWorkspaceLifecycle | undefined
  let supervisor: DeviceHostSupervisor | undefined
  let hostExecutor: HostDeviceExecutor | undefined
  let started: Promise<void> | undefined
  let ready = false
  let conflictTimer: ReturnType<typeof setInterval> | undefined
  const scanConflicts = () => {
    if (ready && env.identity()?.signedIn) {
      void env.conflictCopies?.scan().catch(() => env.log('[Device] conflict scan retained for retry'))
    }
  }
  /** A stop's teardown in flight; a start waits for it so it never returns a memo the stop is tearing down. */
  let stopping: Promise<void> | undefined

  const notRunning: DeviceExecutor = {
    async *run(command: VerifiedExecute): AsyncIterable<ProgressOrReceipt> {
      yield {
        kind: 'receipt',
        commandId: command.commandId,
        state: 'failed_no_effect',
        artifacts: [],
        result: { data: { error: 'The device runtime is not running on this Mac.' } }
      }
    }
  }

  const executor: DeviceExecutor = {
    run: (command: VerifiedExecute, context: DeviceExecutorContext) =>
      (hostExecutor ?? notRunning).run(command, context)
  }

  const approvalDeps = () => ({
    setPaused: (paused: boolean) => service.setPaused(paused),
    signer,
    approvalKey: () => env.approvalKey(),
    nonce: () => randomBytes(16).toString('base64url'),
    now: () => Date.now(),
    deviceServiceId: () => env.deviceServiceId() ?? '',
    accountEpoch: () => env.accountEpoch?.() ?? 0
  })

  const indicator = new DeviceIndicator(
    {
      createTray: onStop => env.tray.createTray(onStop),
      buildStopMenu: (status, stopLabel, onStop) => env.tray.buildStopMenu(status, stopLabel, onStop),
      notify: (title, body) => env.tray.notify(title, body),
      words: () => indicatorWords(env.locale()),
      agentName: agentUserId => env.agentName(agentUserId),
      deviceName: () => env.deviceName()
    },
    () => runtime.fence('local_stop')
  )

  /** One approval for one capability of one command (`answerApproval`: the Touch ID, or the one-tap choice first). */
  const approve = (input: {
    commandHash: string
    capability: DeviceProtectedCapability
    target: string
    agentUserId: string
  }): Promise<ApprovalAnswer> => {
    const { commandHash, capability, target, agentUserId } = input
    const agent = env.agentName(agentUserId)
    const locale = env.locale()

    return answerApproval({
      offersAlways:
        Boolean(env.chooseApproval) &&
        GRANTABLE.includes(capability) &&
        Boolean(env.approvalKey()) &&
        Boolean(env.identity()?.cloudAgents.includes(agentUserId)),
      once: () =>
        requestApproval(
          { commandHash, capability, target, reason: approvalReasonText(locale, { agent, capability, target }) },
          approvalDeps()
        ),
      choose: () =>
        env.chooseApproval!({
          message: approvalReasonText(locale, { agent, capability, target }),
          words: approvalChoiceWords(locale)
        }),
      grant: async () => {
        const sheet = approvalReasonText(locale, { agent, capability, always: true })

        const made = await grants.create(
          { id: randomUUID(), capability, target: '*', label: sheet, agent: agentUserId, reason: sheet },
          signer,
          Date.now()
        )

        audit.record({ decision: 'standing_grant_added', capabilities: [capability], summary: made.id })

        return { id: made.id, approvalHash: deviceMessageHash('StandingGrant', made) }
      },
      setPaused: paused => service.setPaused(paused),
      log: line => env.log(line)
    })
  }

  const service: DeviceService = new DeviceService({
    connected: scanConflicts,
    relay,
    ledger,
    executor,
    drive: () => {
      const roots = env.workspaceCopies?.driveRoots() ?? []

      return roots.length ? { home: env.home, roots } : null
    },
    standingGrants: grants,
    approve: ({ commandHash, capability, target, agentUserId }) =>
      approve({ commandHash, capability, target, agentUserId }),
    identity: () => env.identity(),
    originLog: () => env.originLog(),
    send: (type, body) => env.send(type, body),
    sendArtifact: env.sendArtifact ? (commandId, artifact) => env.sendArtifact!(commandId, artifact) : undefined,
    discardArtifact: artifact => rmSync(path.dirname(artifact.path), { recursive: true, force: true }),
    audit,
    indicator,
    killAllGroups: () => supervisor?.killAll(),
    afterFence: async () => {
      sudoPasswords.forget()
      egress.closeAll()
      await workspaceLifecycle?.clear()
      await supervisor?.sweepAndRestart()
    },
    accountEpoch: env.accountEpoch ? () => env.accountEpoch!() : undefined,
    workspace: {
      finalize: (request, session) => workspaceLifecycle?.finalize(request, session) ?? Promise.resolve(),
      confirm: (confirmation, session) => workspaceLifecycle?.confirm(confirmation, session) ?? Promise.resolve()
    },
    log: line => env.log(line)
  })

  if (env.workspaceCopies && env.sendArtifact) {
    workspaceLifecycle = new DeviceWorkspaceLifecycle({
      service, copies: env.workspaceCopies,
      quiesce: async () => {
        egress.closeAll()
        if (!supervisor) {throw Error('device_host_quiescence_unavailable')}
        await supervisor.quiesce()
      },
      send: (type, body) => env.send(type, body),
      sendArtifact: (requestId, artifact) => env.sendArtifact!(requestId, artifact),
      copyDigest: workspaceCopyDigest,
      conflicts: env.conflictCopies,
      saved: async (copy, digest, result) => {
        const key = savedKey()
        const generation = service.workspaceGeneration()
        if (await workspaceCopyDigest(copy) !== digest || key !== savedKey()
          || generation !== service.workspaceGeneration()) {return}
        const records = savedCopies(key)
        records[copy] = { digest, resultHash: result.resultHash }
        env.store.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(records).slice(-4000))))
      }
    })
  }

  const broker = new GuiBroker({
    authority: commandId => {
      const grantId = service.grantOf(commandId)

      return { live: Boolean(grantId && service.grantLive(grantId)), paused: service.paused() }
    },
    ownApp: () => env.ownApp(),
    // Owner decision 2026-10-20: an upload through an app never asks. The broker still checks authority,
    // security UI and Atum's own windows, and audits the upload as approved.
    requestUploadApproval: async () => 'approved',
    audit: (decision, summary) => audit.record({ decision, tool: 'computer_use', summary })
  })

  // Owner decision 2026-10-20: every public host is reachable through the proxy with no per-host prompt
  // (the proxy still blocks private, loopback and metadata destinations, and audits each new host).
  const egress = new EgressProxy({ audit, active: () => service.liveGrants() })

  function cleanArtifacts(): void {
    try {
      for (const entry of readdirSync(artifactsDir)) {
        rmSync(path.join(artifactsDir, entry), { recursive: true, force: true })
      }
    } catch {
      // Nothing staged.
    }
  }

  async function startNow(): Promise<void> {
    mkdirSync(deviceDir, { recursive: true, mode: 0o700 })
    mkdirSync(artifactsDir, { recursive: true, mode: 0o700 })
    cleanArtifacts()

    for (const record of ledger.load()) {
      audit.record({
        decision: 'stopped',
        commandHash: record.commandHash,
        grantId: record.grantId,
        summary: `reconciled:${record.state}`
      })
    }

    if (unavailable) {
      env.log(`[Device] runtime unavailable: ${unavailable}`)

      return
    }

    await env.workspaceCopies?.refresh()
    const pruneKey = savedKey()
    const pruneGeneration = service.workspaceGeneration()
    // Only sealed, byte-matching committed copies can leave the working-copy tree. An atomic
    // archive rename preserves even an owner's edit racing the check; nothing here deletes it.
    await pruneWorkspaceCopies({ tasksRoot, artifactsRoot: path.join(deviceDir, 'workspace-artifacts'),
      saved: async copy => {
        const receipt = savedCopies(pruneKey)[copy]

        return Boolean(receipt && await workspaceCopyDigest(copy) === receipt.digest
          && pruneKey === savedKey() && pruneGeneration === service.workspaceGeneration())
      },
      retire: async copy => {
        if (pruneKey !== savedKey() || pruneGeneration !== service.workspaceGeneration()) {return}
        const archive = path.join(env.home, 'Atum Tasks Archive')
        mkdirSync(archive, { recursive: true, mode: 0o700 })
        if (realpathSync.native(archive) !== archive) {throw Error('workspace_archive_symlink')}
        await rename(copy, path.join(archive, path.basename(copy) + '-' + randomUUID()))
        const records = savedCopies(pruneKey)
        delete records[copy]
        env.store.setItem(pruneKey, JSON.stringify(records))
      }
    })

    const port = await egress.start()
    const app = appBundleOf(env.appExecutable)

    supervisor = new DeviceHostSupervisor({
      launcherPath: env.launcherPath!,
      pythonPath: env.hermes!.python,
      hermesRoot: env.hermes!.source,
      hostHome: path.join(deviceDir, 'host-home'),
      egressProxyPort: port,
      egressProxyToken: egress.authToken,
      home: env.home,
      runtimeRoots: () => ({
        userData: env.userData,
        driveRoot: env.driveRoot?.() ?? null,
        driveRoots: env.workspaceCopies?.driveRoots() ?? [],
        writableDriveRoots: env.workspaceCopies?.writableDriveRoots?.() ?? [],
        writeOutsideWorkingRoot: Boolean(env.workspaceCopies?.driveRoots().length || env.driveRoot?.()),
        agentWorkingRoots: env.workspaceCopies?.agentWorkingRoots() ?? [],
        closedFolders: env.closedFolders?.() ?? [],
        sharedInsideClosedFolders: env.sharedInsideClosedFolders?.() ?? [],
        appExecutable: app ? env.appExecutable : null
      }),
      cuaDriverSocket: env.cuaDriverSocket,
      sshAuthSock: () => env.sshAuthSock(),
      authorizeGui: request => broker.authorize(request),
      realpath: file => realpathSync.native(file),
      log: code => env.log(`[Device] ${code}`)
    })

    const host = supervisor

    hostExecutor = new HostDeviceExecutor(host, {
      artifactsDir,
      onProtectedFolderDenied: env.onProtectedFolderDenied,
      cwdFor: async (_command, grant) => {
        const copies = env.workspaceCopies

        if (!copies) {
          return env.home
        }

        await copies.refresh()
        // A failed copy never grants a path. The home fallback remains read-only until
        // a Drive root is known; only the current account's identity-verified root is writable.
        const prepared = await copies.prepare(grant).catch(() => null)

        if (!prepared) {return env.home}
        const cwd = await copies.ownWorkingRoot(grant.grantId)

        if (!cwd || cwd !== prepared.cwd) {throw new Error('workspace_symlink')}

        return cwd
      },
      ownWorkingRootFor: grant => env.workspaceCopies?.ownWorkingRoot(grant.grantId) ?? Promise.resolve(null),
      runSudo: (command, cwd) => {
        const agent = service.workspaceGrant(command.grantId)?.agentUserId ?? command.grantId

        return runDeviceSudo(typeof command.args.command === 'string' ? command.args.command : '', {
          // The password is asked once per agent per task window (owner decision 2026-10-20).
          promptPassword: text => sudoPasswords.obtain(agent, () => env.promptPassword(text)),
          setPaused: paused => service.setPaused(paused),
          run: async (argv, password) => {
            const outcome = await host.sudo({ commandId: command.commandId, argv, password, cwd, timeoutMs: command.timeoutMs })
            const exit = (outcome.result as { exit_code?: unknown } | undefined)?.exit_code

            // A failed run may mean a wrong password: never replay it.
            if (outcome.state !== 'completed' || (typeof exit === 'number' && exit !== 0)) {
              sudoPasswords.forget()
            }

            return outcome
          }
        })
      }
    })
    ready = true
    if (env.conflictCopies && !conflictTimer) {
      conflictTimer = setInterval(scanConflicts, 5 * 60_000)
      conflictTimer.unref?.()
    }
  }

  function view(grant: StandingGrant) {
    return { ...grant, agentName: grant.agent ? env.agentName(grant.agent) : null }
  }

  const runtime: DeviceRuntime = {
    service,
    workspaceProtocol: () => ready && workspaceLifecycle?.available ? 1 : undefined,

    start() {
      if (!started) {
        const after = stopping

        const run: Promise<void> = (async () => {
          await after?.catch(() => undefined)
          await startNow()
        })().catch(error => {
          if (started === run) {
            started = undefined
          }

          throw error
        })

        started = run
      }

      return started
    },

    fence(reason) {
      sudoPasswords.forget()
      // The synchronous half runs inside `stop` before it returns.
      void service.stop(reason).catch(() => env.log('[Device] fence tail failed'))
    },

    stop() {
      clearInterval(conflictTimer)
      conflictTimer = undefined
      // Forget the start at once, not after the teardown: a start racing this stop (sign-out, then an
      // immediate sign-in) must run afresh after the teardown, never return the memo being torn down.
      const starting = started
      ready = false
      started = undefined
      runtime.fence('local_stop')
      const previous = stopping

      const run = (async () => {
        await previous?.catch(() => undefined)
        // A start still in flight finishes first, so its host is the one stopped here.
        await starting?.catch(() => undefined)
        indicator.dispose()
        const host = supervisor
        supervisor = undefined
        hostExecutor = undefined
        await host?.stop()
        egress.closeAll()
        await egress.stop()
        cleanArtifacts()
      })()

      const tracked: Promise<void> = run
        .then(
          () => undefined,
          () => undefined
        )
        .then(() => {
          if (stopping === tracked) {
            stopping = undefined
          }
        })

      stopping = tracked

      return run
    },

    hello() {
      if (unavailable) {
        return { terminal: false, files: false, computer: { available: false, reason: unavailable } }
      }

      if (!ready) {return { terminal: false, files: false, computer: { available: false, reason: 'not_running' } }}

      const computer = env.cuaDriverAvailable()
        ? { available: true }
        : { available: false, reason: 'cua_driver_missing' }

      return { terminal: true, files: true, computer }
    },

    configureChatGptRelay(enabled, models = []) {
      relayEnabled = enabled
      relayModels = enabled
        ? [...new Set(models)].filter(model => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(model)).slice(0, 64)
        : []
      env.store.setItem(relayKey, JSON.stringify({ enabled: relayEnabled, models: relayModels }))
      if (!enabled) {
        relay?.disable()
      }
    },

    async request(input) {
      const request = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const identity = env.identity()

      if (request.action === 'status') {
        const status: DeviceStatusView = {
          available: !unavailable,
          ...(unavailable ? { reason: unavailable } : {}),
          enrolled: Boolean(env.deviceServiceId() && env.approvalKey()),
          deviceName: env.deviceName(),
          cloudAgents: (identity?.cloudAgents ?? []).map(userId => ({ userId, name: env.agentName(userId) })),
          grants: grants.list().map(view),
          grantable: GRANTABLE,
          active: service.liveGrants()
        }

        return status
      }

      if (request.action === 'addGrant') {
        const capability = request.capability as DeviceProtectedCapability
        const agent = typeof request.agentUserId === 'string' ? request.agentUserId : ''

        // Settings › Advanced › Allow without asking: one line per outcome, closed codes only
        // (the capability is a fixed GRANTABLE code; no agent, name or grant id).
        if (!GRANTABLE.includes(capability) || !identity?.cloudAgents.includes(agent)) {
          env.log('[Device] standing permission not added: device_grant_invalid')
          throw new DeviceRequestError('device_grant_invalid')
        }

        if (!env.approvalKey()) {
          env.log('[Device] standing permission not added: device_not_enrolled')
          throw new DeviceRequestError('device_not_enrolled')
        }

        const name = env.agentName(agent)

        try {
          const grant = await grants.create(
            {
              id: randomUUID(),
              capability,
              target: '*',
              label: approvalReasonText(env.locale(), { agent: name, capability, always: true }),
              agent,
              reason: approvalReasonText(env.locale(), { agent: name, capability, always: true })
            },
            signer,
            Date.now()
          )

          audit.record({ decision: 'standing_grant_added', capabilities: [capability], summary: grant.id })
          env.log(`[Device] standing permission added capability=${capability}`)

          return view(grant)
        } catch (error) {
          const raw = (error as { code?: unknown }).code
          const code = typeof raw === 'string' && raw.startsWith('approval_') ? raw : 'approval_denied'

          env.log(`[Device] standing permission not added: ${code}`)
          throw new DeviceRequestError(code)
        }
      }

      if (request.action === 'revokeGrant' && typeof request.id === 'string') {
        grants.revoke(request.id)
        audit.record({ decision: 'standing_grant_revoked', summary: request.id })
        env.log('[Device] standing permission revoked')

        return { revoked: request.id }
      }

      if (request.action === 'stop') {
        runtime.fence('local_stop')

        return { stopped: true }
      }

      throw new DeviceRequestError('device_request_invalid')
    }
  }

  return runtime
}
