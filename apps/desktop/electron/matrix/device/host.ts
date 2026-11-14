/**
 * The Python device host supervisor and the `DeviceExecutor` (S1 build plan §4, WS-4 `device/host.ts`).
 *
 * Electron main spawns `hermes_cli/atum_device_host.py` **through the disclaim launcher**
 * (`launcher.ts`), in its own detached process group, with a constrained environment, and talks to it in
 * newline-delimited JSON over stdio. The host runs Hermes's own terminal/file tools inside a per-command
 * Seatbelt profile generated here from `protected-paths.ts` + `seatbelt.ts`; `computer_use` runs Hermes's
 * own tool in the host with every mutating action authorized by the GUI broker in main; `send_file`
 * reads inside the profile. The environment is an allowlist: it carries `HTTPS_PROXY`/`HTTP_PROXY`/
 * `ALL_PROXY` pointing at the device egress proxy and `GIT_SSH_COMMAND` with the CONNECT `ProxyCommand`,
 * and it never passes through `SSH_AUTH_SOCK`, `AWS_*` or tokens.
 *
 * The host reports `{commandId, pgid}` the moment it spawns anything. On Stop, main kills those process
 * groups itself, synchronously (a wedged host cannot hold a command alive), then sweeps every process
 * the host is responsible for (`atum-disclaim-launcher --sweep`): responsibility survives fork, exec and
 * `setsid`, so a daemon that left its process group is still found. (The plan's `ATUM_DEVICE_OP` marker
 * sweep through `KERN_PROCARGS2` cannot work: macOS hides an Apple platform binary's environment,
 * so a `bash` or `sleep` daemon would be invisible to it.) A survivor stays sandboxed regardless (the G0
 * double-fork probe and `seatbelt.boundary.test.ts`), so it cannot reach the protected set.
 */
import { type ChildProcess, execFile, spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

import { ownedBackgroundChildren } from '../../owned-background-children'
import { matrixJustInTimeFolderDenied } from '../just-in-time-folders'

import type { DeviceArtifact, DeviceExecutor, DeviceExecutorContext, DeviceGrant, ProgressOrReceipt, VerifiedExecute } from './contracts'
import { DriveLinkScanner } from './guard/drive-links'
import { sshProxyCommand } from './guard/ssh-proxy-command'
import type { GuiAuthorizeRequest, GuiAuthorizeVerdict } from './gui-broker'
import { disclaimArgv } from './launcher'
import { OWNER_DEFAULT_RELAXATIONS, type ProtectedRuntimeRoots, resolveProtectedPaths } from './protected-paths'
import { generateSeatbeltProfile, makeBestEffortResolver, type SeatbeltRuntime } from './seatbelt'

/**
 * Build the constrained child environment for the device host. An allowlist, plus the egress-proxy and
 * ssh ProxyCommand wiring and the host's own Hermes home. Pure: given a base env and the proxy port, it
 * returns exactly what the host may see — never the agent-relevant secrets.
 */
export function constrainedHostEnv(base: NodeJS.ProcessEnv, proxyPort: number, proxyToken: string, hostHome?: string, gitTemplate?: string, pythonPath = '/usr/bin/python3'): NodeJS.ProcessEnv {
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(proxyToken)) {throw new Error('device_proxy_token_invalid')}
  const proxy = `http://srt:${proxyToken}@127.0.0.1:${proxyPort}`
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

  const env: NodeJS.ProcessEnv = {
    PATH: base.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: base.HOME,
    USER: base.USER,
    LOGNAME: base.LOGNAME,
    SHELL: base.SHELL,
    LANG: base.LANG ?? 'en_US.UTF-8',
    TERM: base.TERM ?? 'xterm-256color',
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    ALL_PROXY: proxy,
    GIT_SSH_COMMAND: `/usr/bin/ssh -o ${quote(`ProxyCommand=${sshProxyCommand(pythonPath, proxyPort)}`)}`,
    ATUM_DEVICE_PROXY_TOKEN: proxyToken,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.proxyAuthMethod',
    GIT_CONFIG_VALUE_0: 'basic',
    ...(gitTemplate ? { GIT_TEMPLATE_DIR: gitTemplate } : {}),
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    ...(hostHome ? { HERMES_HOME: hostHome } : {})
  }

  // Never inherited: SSH_AUTH_SOCK, AWS_*/GOOGLE_*/GH_*/any token-bearing var, NODE_OPTIONS, PYTHONPATH.
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as NodeJS.ProcessEnv
}

/** The device tools the host runs under Seatbelt. computer_use and send_file have their own paths. */
const SANDBOXED_TOOLS = new Set(['terminal', 'read_file', 'write_file', 'patch', 'search_files'])
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024

export interface HostSupervisorOptions {
  /** Absolute path to the disclaim launcher binary. */
  readonly launcherPath: string
  /** Absolute path to the bundled python interpreter. */
  readonly pythonPath: string
  /** Absolute path to the Hermes source root the host runs from (`-m hermes_cli.atum_device_host`). */
  readonly hermesRoot: string
  /** The host's own Hermes home (under Atum's userData, which agent commands cannot read). */
  readonly hostHome?: string
  /** The device egress proxy port. */
  readonly egressProxyPort: number
  /** Ephemeral proxy credential, kept in host memory/environment only. */
  readonly egressProxyToken: string
  /** Where protected-path denies resolve against. */
  readonly home: string
  /** Where they are read live (the Drive root and working copies change at runtime). */
  readonly runtimeRoots: ProtectedRuntimeRoots | (() => ProtectedRuntimeRoots)
  readonly cuaDriverSocket: string
  readonly cuaDriverPath?: string
  /** The owner's SSH agent socket, handed only to a command whose grant covers `ssh_agent`. */
  readonly sshAuthSock?: () => string | undefined
  /** Answers the host's reverse request before each mutating GUI action (the GUI broker). */
  readonly authorizeGui?: (request: GuiAuthorizeRequest) => Promise<GuiAuthorizeVerdict>
  /** Test seam; production uses node:child_process.spawn. */
  readonly spawn?: typeof nodeSpawn
  /** Test seam; production signals the process group. */
  readonly killGroup?: (pgid: number) => void
  /** Test seam: runs `atum-disclaim-launcher --sweep <hostPid>`, resolving the pids it killed. */
  readonly sweepResponsible?: (hostPid: number) => Promise<number[]>
  /** Collection-only proof. Failure must reject; no copy may be frozen after a failed sweep. */
  readonly quiesceResponsible?: (hostPid: number) => Promise<void>
  /** Realpath for Seatbelt path predicates (G0 F5); defaults to identity. */
  readonly realpath?: (p: string) => string
  /** Test seam: the hard-link walk of the writable Drive roots (default: a fresh bounded scanner). */
  readonly driveLinks?: DriveLinkScanner
  readonly log?: (code: string) => void
}

interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
}

export interface HostExecResult {
  state: 'completed' | 'failed_no_effect' | 'unknown'
  result?: unknown
}

function defaultKillGroup(pgid: number): void {
  if (process.platform !== 'win32' && pgid > 1) {
    process.kill(-pgid, 'SIGKILL')
  }
}

function launcherSweep(launcher: string): (hostPid: number) => Promise<number[]> {
  return hostPid =>
    new Promise(resolve => {
      execFile(launcher, ['--sweep', String(hostPid)], { timeout: 10_000 }, (error, stdout) => {
        if (error) {
          resolve([])

          return
        }

        try {
          const killed = (JSON.parse(stdout) as { killed?: unknown }).killed

          resolve(Array.isArray(killed) ? killed.filter((pid): pid is number => Number.isSafeInteger(pid)) : [])
        } catch {
          resolve([])
        }
      })
    })
}

/** Supervises the Python device host process and its JSON-RPC transport. */
export class DeviceHostSupervisor {
  private child?: ChildProcess
  private quiescing?: Promise<void>
  private stdoutBuffer = ''
  /** The device host's own pid (the launcher is only its parent), from `device.ready`. */
  private hostPid?: number
  private nextId = 0
  private readonly pending = new Map<number, PendingCall>()
  private readonly groups = new Map<string, Set<number>>()
  private readonly spawn: typeof nodeSpawn
  private readonly killGroup: (pgid: number) => void
  private readonly log: (code: string) => void
  private readonly driveLinks: DriveLinkScanner

  constructor(private readonly options: HostSupervisorOptions) {
    this.driveLinks = options.driveLinks ?? new DriveLinkScanner()
    this.spawn = options.spawn ?? nodeSpawn
    this.killGroup = options.killGroup ?? defaultKillGroup
    this.log = options.log ?? (() => {})
  }

  private roots(): ProtectedRuntimeRoots {
    return typeof this.options.runtimeRoots === 'function' ? this.options.runtimeRoots() : this.options.runtimeRoots
  }

  start(): void {
    if (this.quiescing) {throw new Error('device_host_collecting')}

    if (this.child) {
      return
    }

    const argv = disclaimArgv(this.options.launcherPath, this.options.pythonPath, ['-m', 'hermes_cli.atum_device_host'])
    const [program, ...args] = argv
    const gitTemplate = path.join(this.options.hostHome ?? this.roots().userData, 'git-template')
    mkdirSync(gitTemplate, { recursive: true, mode: 0o700 })

    if (!lstatSync(gitTemplate).isDirectory() || readdirSync(gitTemplate).length) {throw new Error('device_git_template_invalid')}

    const child = ownedBackgroundChildren.track(this.spawn(program, args, {
      cwd: this.options.hermesRoot,
      env: { ...constrainedHostEnv(process.env, this.options.egressProxyPort, this.options.egressProxyToken, this.options.hostHome, gitTemplate, this.options.pythonPath),
        ...(this.options.cuaDriverPath ? { HERMES_CUA_DRIVER_CMD: this.options.cuaDriverPath } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true
    }), process.platform !== 'win32')

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', chunk => this.onStdout(chunk as string))
    child.stderr?.resume()
    child.once('exit', () => this.onExit(child))
    child.once('error', () => this.onExit(child))
    this.child = child
  }

  async stop(): Promise<void> {
    const child = this.child

    this.driveLinks.dispose?.()
    this.killAll()

    if (!child) {
      return
    }

    try {
      await Promise.race([this.call('device.shutdown', {}), new Promise(resolve => setTimeout(resolve, 2000))])
    } catch {
      // Already down.
    }

    if (this.child === child) {
      this.child = undefined
    }

    for (const pid of [this.hostPid, child.pid]) {
      if (pid && pid > 1 && pid !== process.pid) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Gone.
        }
      }
    }

    this.hostPid = undefined
    this.rejectPending('device_host_stopped')
  }

  /** The process groups device commands own right now. */
  ownedProcessGroups(): number[] {
    return [...this.groups.values()].flatMap(each => [...each])
  }

  /**
   * Kill one command's process groups now, synchronously, then tell the host (best effort). Main never
   * waits on the host to stop a command.
   */
  killCommand(commandId: string): void {
    for (const pgid of this.groups.get(commandId) ?? []) {
      try {
        this.killGroup(pgid)
      } catch {
        // Already gone.
      }
    }

    void this.call('device.stop', { commandId }).catch(() => this.log('device_host_stop_failed'))
  }

  /** The fence's floor: every group any device command owns, killed synchronously. */
  killAll(): void {
    for (const pgid of this.ownedProcessGroups()) {
      try {
        this.killGroup(pgid)
      } catch {
        // Already gone.
      }
    }
  }

  /** Stop every writer in the shared host's responsibility tree; never suppress a failed proof. */
  quiesce(): Promise<void> {
    if (this.quiescing) {return this.quiescing}
    const child = this.child
    const hostPid = this.hostPid

    const run = (async () => {
      if (!child) {return}

      if (!hostPid) {throw new Error('device_host_quiescence_unavailable')}

      if (this.options.quiesceResponsible) {await this.options.quiesceResponsible(hostPid)}
      else {
        await new Promise<void>((resolve, reject) => {
          execFile(this.options.launcherPath, ['--quiesce', String(hostPid)], { timeout: 5000 }, (error, stdout) => {
            if (error) {reject(new Error('device_host_quiescence_failed'));

 return}

            try {
              const result = JSON.parse(stdout) as { quiescent?: unknown }

              if (result.quiescent !== true) {throw new Error('device_host_quiescence_failed')}
              resolve()
            } catch {reject(new Error('device_host_quiescence_failed'))}
          })
        })
      }
    })().finally(() => {
      if (hostPid) {try {process.kill(hostPid, 'SIGKILL')} catch { /* Already gone. */ }}

      if (child?.pid) {try {process.kill(child.pid, 'SIGKILL')} catch { /* Already gone. */ }}

      if (this.child === child) {
        this.child = undefined
        this.hostPid = undefined
        this.groups.clear()
        this.rejectPending('device_host_stopped')
      }

      if (this.quiescing === run) {this.quiescing = undefined}
    })

    this.quiescing = run

    return run
  }

  /**
   * After a Stop: kill every process the device host is responsible for (its whole tree, daemons that
   * left their group included), then the host itself. The next command starts a fresh host. Async and
   * best effort; the synchronous group kill already ran.
   */
  async sweepAndRestart(): Promise<number[]> {
    const hostPid = this.hostPid
    const child = this.child
    const killed = hostPid ? await (this.options.sweepResponsible ?? launcherSweep(this.options.launcherPath))(hostPid) : []

    for (const pid of [hostPid, child?.pid]) {
      if (pid && pid > 1 && pid !== process.pid) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Gone.
        }
      }
    }

    if (this.child === child) {
      this.child = undefined
      this.hostPid = undefined
      this.groups.clear()
      this.rejectPending('device_host_stopped')
    }

    return killed
  }

  /** Generate the per-command Seatbelt profile for this Execute, folding in the granted relaxations. */
  profileFor(relax: VerifiedExecute['needs'], ownWorkingRoot?: string | null): string {
    const roots = this.roots()
    const resolved = resolveProtectedPaths({ home: this.options.home, runtime: roots })

    // A regular file in a writable Drive root that has another name (`nlink > 1`) is denied by its
    // Drive spelling: Seatbelt sees names, not inodes (see guard/drive-links.ts).
    const linked = this.driveLinks.step(resolved.writableDriveRoots ?? [])
    const paths = linked.length ? { ...resolved, readWriteDenied: [...resolved.readWriteDenied, ...linked] } : resolved

    const runtime: SeatbeltRuntime = {
      cuaDriverSocket: this.options.cuaDriverSocket,
      egressProxyPort: this.options.egressProxyPort,
      sshAgentSocket: this.options.sshAuthSock?.(),
      ownWorkingRoot: ownWorkingRoot === undefined ? roots.ownWorkingRoot ?? null : ownWorkingRoot,
      writeOutsideWorkingRoot: roots.writeOutsideWorkingRoot
    }

    const resolve = this.options.realpath ? makeBestEffortResolver(this.options.realpath) : undefined

    // The owner's agents get the default-open set on every command (`OWNER_DEFAULT_RELAXATIONS`).
    const lifted = [...new Set([...OWNER_DEFAULT_RELAXATIONS, ...relax])]

    return generateSeatbeltProfile(this.options.home, { paths, runtime, relax: lifted, resolve })
  }

  /** Run one admitted terminal/file command under its profile. */
  exec(input: {
    commandId: string
    tool: string
    args: Record<string, unknown>
    cwd: string
    timeoutMs: number
    relax: VerifiedExecute['needs']
    ownWorkingRoot?: string | null
  }): Promise<HostExecResult> {
    const sshAuthSock = input.relax.includes('ssh_agent') ? this.options.sshAuthSock?.() : undefined

    return this.call('device.exec', {
      commandId: input.commandId,
      tool: input.tool,
      args: input.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      profile: this.profileFor(input.relax, input.ownWorkingRoot),
      ...(sshAuthSock ? { env: { SSH_AUTH_SOCK: sshAuthSock } } : {})
    }) as Promise<HostExecResult>
  }

  /** `send_file`: the host copies the file into `dest` by reading it inside the profile. */
  readArtifact(input: {
    commandId: string
    path: string
    cwd: string
    dest: string
    relax: VerifiedExecute['needs']
    ownWorkingRoot?: string | null
  }): Promise<{ state: 'completed' | 'failed_no_effect'; size?: number; name?: string; error?: string }> {
    return this.call('device.read_artifact', {
      commandId: input.commandId,
      path: input.path,
      cwd: input.cwd,
      dest: input.dest,
      maxBytes: MAX_ARTIFACT_BYTES,
      profile: this.profileFor(input.relax, input.ownWorkingRoot)
    }) as Promise<{ state: 'completed' | 'failed_no_effect'; size?: number; name?: string; error?: string }>
  }

  computerUse(input: { grantId: string; commandId: string; args: Record<string, unknown>; timeoutMs: number }): Promise<HostExecResult> {
    return this.call('device.computer_use', input) as Promise<HostExecResult>
  }

  releaseGui(grantId: string): void {
    if (!this.child) {return}
    void this.call('device.release_gui', { grantId }).catch(() => this.log('device_host_gui_release_failed'))
  }

  /** Device-local sudo: the approved argv, the password once (never logged, never relayed). */
  sudo(input: { commandId: string; argv: string[]; password: string; cwd: string; timeoutMs: number }): Promise<HostExecResult> {
    return this.call('device.sudo', input) as Promise<HostExecResult>
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.start()
    const child = this.child

    if (!child?.stdin) {
      return Promise.reject(new Error('device_host_unavailable'))
    }

    const id = ++this.nextId
    const frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      child.stdin!.write(frame, error => {
        if (error) {
          this.pending.delete(id)
          reject(new Error('device_host_write_failed'))
        }
      })
    })
  }

  private respond(id: string, result: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let newline: number

    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)

      if (line) {
        this.onMessage(line)
      }
    }
  }

  private onMessage(line: string): void {
    let message: { id?: number | string; result?: unknown; error?: { code?: string }; method?: string; params?: Record<string, unknown> }

    try {
      message = JSON.parse(line)
    } catch {
      this.log('device_host_protocol_invalid')

      return
    }

    if (message.method === 'device.ready') {
      const pid = message.params?.pid

      this.hostPid = Number.isSafeInteger(pid) && (pid as number) > 1 ? (pid as number) : undefined

      return
    }

    if (message.method === 'device.spawned' && message.params) {
      const { commandId, pgid } = message.params

      if (typeof commandId === 'string' && Number.isSafeInteger(pgid) && (pgid as number) > 1) {
        const set = this.groups.get(commandId) ?? new Set<number>()
        set.add(pgid as number)
        this.groups.set(commandId, set)
      }

      return
    }

    if (message.method === 'device.gui_authorize' && typeof message.id === 'string') {
      const id = message.id
      const authorize = this.options.authorizeGui

      void (authorize ? authorize((message.params ?? {}) as unknown as GuiAuthorizeRequest) : Promise.resolve({ allow: false as const, reason: 'stopped' as const }))
        .catch(() => ({ allow: false as const, reason: 'stopped' as const }))
        .then(verdict => this.respond(id, verdict))

      return
    }

    if (typeof message.id !== 'number') {
      return
    }

    const call = this.pending.get(message.id)

    if (!call) {
      return
    }

    this.pending.delete(message.id)

    if (message.error) {
      call.reject(new Error(message.error.code ?? 'device_host_error'))
    } else {
      call.resolve(message.result)
    }
  }

  /** A command finished: its groups are no longer this host's to kill. */
  forget(commandId: string): void {
    this.groups.delete(commandId)
  }

  private rejectPending(code: string): void {
    for (const call of this.pending.values()) {
      call.reject(new Error(code))
    }

    this.pending.clear()
  }

  private onExit(child: ChildProcess): void {
    if (this.child === child) {
      this.child = undefined
      this.hostPid = undefined
    }

    // Commands the dead host spawned live in their own groups: they are still killable from here.
    this.rejectPending('device_host_exited')
  }
}

/** The sentence a command blocked by the sandbox gets, so the brain retries with `needs`. */
export const SANDBOX_HINT =
  "This Mac's sandbox blocked part of this command. If it needs startup files or a " +
  'downloaded program or the SSH agent, run it again with `needs` naming that ' +
  '(persistence, exec_downloaded, ssh_agent): ' +
  'the Mac allows those without asking. If it needs the Keychain or cloud credentials (keychain, cloud_cli), ' +
  'the owner approves once for the whole task on the Mac. Package-registry credentials (~/.npmrc, pip, ' +
  'cargo, gem) are already readable. The owner\'s Drive folder on this Mac (usually ~/Atum/Drive) is open to ' +
  'read and write like any other folder: edit the file there and Drive syncs it. What is blocked there: ' +
  'Drive\'s own bookkeeping files (.atum-drive-*), moving or removing the Drive folder itself, and running ' +
  'a program or script file directly from it (`./run.sh`; `python file.py` is fine). Deleting the whole ' +
  'Drive folder, everything at its top level or a parent of it takes the owner\'s Touch ID once per task. ' +
  'Only the Drive of the account signed in now is writable; an old account\'s folder is not.'

const SANDBOX_DENIAL = /operation not permitted|sandbox|deny\(/i

function withSandboxHint(tool: string, result: unknown): unknown {
  if (tool !== 'terminal' || !result || typeof result !== 'object') {
    return result
  }

  const record = result as Record<string, unknown>
  const failed = typeof record.exit_code === 'number' && record.exit_code !== 0
  const text = `${typeof record.output === 'string' ? record.output : ''}\n${typeof record.error === 'string' ? record.error : ''}`

  return failed && SANDBOX_DENIAL.test(text) ? { ...record, device_note: SANDBOX_HINT } : result
}

/** A file name a Receipt artifact may carry (no path, no control characters, ≤ 255). */
export function artifactName(file: string): string {
  const base = [...path.basename(file)].map(character =>
    character.charCodeAt(0) < 0x20 || character === '/' || character === '\\' ? '_' : character
  ).join('').slice(0, 255)

  return base && base !== '.' && base !== '..' ? base : 'file'
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('base64url')))
  })
}

export interface HostExecutorOptions {
  readonly openBrowser?: (url: string) => Promise<void>
  readonly computerReady?: (force?: boolean) => Promise<string | null>

  /** Where a command runs: the agent's task working copy (WS-5) or the owner's home. */
  readonly cwdFor?: (command: VerifiedExecute, grant: DeviceGrant) => string | Promise<string>
  /** Trusted local copy lookup, never a root supplied in Execute.args. */
  readonly ownWorkingRootFor?: (grant: DeviceGrant) => Promise<string | null>
  /** A Touch-ID-approved `sudo` terminal command: password window, then the argv as root
   * (`sudo.ts` `runDeviceSudo`). Absent: sudo commands have no effect. */
  readonly runSudo?: (command: VerifiedExecute, cwd: string) => Promise<HostExecResult>
  /** A private directory (under userData) for `send_file` bytes until they are transferred. */
  readonly artifactsDir: string
  /** Renderer-safe signal only; command arguments and results stay native. */
  readonly onProtectedFolderDenied?: () => void
  readonly now?: () => number
}

/**
 * The `DeviceExecutor` the device service drives for each admitted command. Terminal/file tools go to
 * the Python host under Seatbelt; `computer_use` to Hermes's tool in the host behind the GUI broker;
 * `send_file` reads inside the profile into a private file the connection streams. An abort (Stop,
 * Cancel, sign-out, sleep) kills the command's process groups at once; a command stopped while it ran
 * reports `unknown`, never `completed`.
 */
export class HostDeviceExecutor implements DeviceExecutor {
  constructor(
    private readonly supervisor: DeviceHostSupervisor,
    private readonly options: HostExecutorOptions
  ) {}

  releaseGrant(grantId: string): void {
    this.supervisor.releaseGui(grantId)
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  async *run(command: VerifiedExecute, context: DeviceExecutorContext): AsyncIterable<ProgressOrReceipt> {
    const startedAt = this.now()

    const receipt = (
      state: 'completed' | 'failed_no_effect' | 'unknown',
      result?: { exitCode?: number; output?: string; data?: unknown },
      artifacts: DeviceArtifact[] = []
    ): ProgressOrReceipt => ({ kind: 'receipt', commandId: command.commandId, state, artifacts, result, startedAt, endedAt: this.now() })

    if (context.signal.aborted) {
      yield receipt('failed_no_effect', { data: { error: 'Stopped before it started.' } })

      return
    }

    const onAbort = () => this.supervisor.killCommand(command.commandId)
    context.signal.addEventListener('abort', onAbort, { once: true })

    try {
      const cwd = await (this.options.cwdFor?.(command, context.grant) ?? process.env.HOME ?? '/')
      const ownWorkingRoot = await this.options.ownWorkingRootFor?.(context.grant)

      // Stop may arrive while Drive prepares the copy. Never start a command afterwards.
      if (context.signal.aborted) {
        yield receipt('failed_no_effect', { data: { error: 'Stopped before it started.' } })

        return
      }

      let out: HostExecResult

      if (command.tool === 'send_file') {
        yield await this.sendFile(command, context, cwd, receipt, ownWorkingRoot)

        return
      }

      if (command.tool === 'computer_use') {
        if (context.paused()) {
          yield receipt('failed_no_effect', { data: { error: 'This Mac is waiting for an approval; try again in a moment.' } })

          return
        }

        if (command.args.action === 'open_url') {
          const url = new URL(String(command.args.url ?? ''))
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { throw Error('browser_url_invalid') }
          if (!this.options.openBrowser) { throw Error('atum_browser_unavailable') }
          await this.options.openBrowser(url.href)
          yield receipt(context.signal.aborted ? 'unknown' : 'completed', { data: { opened: true, url: url.href } })
          return
        }
        const permission = await this.options.computerReady?.()
        if (permission) {
          yield receipt('failed_no_effect', { data: { error: permission, reason: 'needs_permission' } })
          return
        }
        // Stop/approval can arrive while macOS presents its permission request.
        if (context.signal.aborted || context.paused()) {
          yield receipt('failed_no_effect', { data: { error: 'Computer action stopped.' } })
          return
        }
        out = await this.supervisor.computerUse({ grantId: command.grantId, commandId: command.commandId, args: command.args, timeoutMs: command.timeoutMs })

        if (out.result && typeof out.result === 'object' && 'reason' in out.result && out.result.reason === 'needs_permission') {
          await this.options.computerReady?.(true)
        }
      } else if (command.tool === 'terminal' && command.needs.includes('sudo')) {
        // macOS refuses setuid binaries inside the sandbox (F6): the approved argv runs as root, outside.
        out = this.options.runSudo
          ? await this.options.runSudo(command, cwd)
          : { state: 'failed_no_effect', result: { output: '', exit_code: -1, error: 'sudo is not available on this Mac.' } }
      } else if (SANDBOXED_TOOLS.has(command.tool)) {
        out = await this.supervisor.exec({
          commandId: command.commandId,
          tool: command.tool,
          args: command.args,
          cwd,
          timeoutMs: command.timeoutMs,
          relax: command.needs,
          ownWorkingRoot
        })
      } else {
        yield receipt('failed_no_effect', { data: { error: `This Mac does not run ${command.tool}.` } })

        return
      }

      const result = withSandboxHint(command.tool, out.result)

      if (matrixJustInTimeFolderDenied(command.tool, { args: command.args, result })) {
        try {
          this.options.onProtectedFolderDenied?.()
        } catch {
          // Presentation never changes the device receipt.
        }
      }

      const exitCode =
        command.tool === 'terminal' && result && typeof result === 'object' && Number.isSafeInteger((result as { exit_code?: unknown }).exit_code)
          ? Math.max(-1000, Math.min(1000, (result as { exit_code: number }).exit_code))
          : undefined

      // Stopped while it ran: whatever it did may have partly happened.
      const state = context.signal.aborted && out.state !== 'failed_no_effect' ? 'unknown' : out.state

      yield receipt(state, { ...(exitCode === undefined ? {} : { exitCode }), ...(result === undefined ? {} : { data: result }) })
    } catch {
      // The host died or the pipe broke mid-command: the effect is uncertain.
      yield receipt('unknown', { data: { error: 'The command stopped unexpectedly on this Mac; it may have partly run.' } })
    } finally {
      context.signal.removeEventListener('abort', onAbort)
      this.supervisor.forget(command.commandId)
    }
  }

  private async sendFile(
    command: VerifiedExecute,
    context: DeviceExecutorContext,
    cwd: string,
    receipt: (state: 'completed' | 'failed_no_effect' | 'unknown', result?: { data?: unknown }, artifacts?: DeviceArtifact[]) => ProgressOrReceipt,
    ownWorkingRoot?: string | null
  ): Promise<ProgressOrReceipt> {
    const requested = typeof command.args.path === 'string' ? command.args.path : ''

    if (!requested) {
      return receipt('failed_no_effect', { data: { error: 'No file was named.' } })
    }

    const name = artifactName(requested)
    const directory = path.join(this.options.artifactsDir, command.commandId)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const dest = path.join(directory, name)

    const out = await this.supervisor.readArtifact({ commandId: command.commandId, path: requested, cwd, dest, relax: command.needs, ownWorkingRoot })

    if (out.state !== 'completed' || context.signal.aborted) {
      rmSync(directory, { recursive: true, force: true })

      const error =
        out.error === 'too_large'
          ? 'The file is over 8 MB: too large to send to chat from this Mac.'
          : out.error === 'stopped' || context.signal.aborted
            ? 'Stopped before the file was read.'
            : `This Mac could not read ${requested} (it is missing, not a file, or protected).`

      return receipt('failed_no_effect', { data: { error } })
    }

    const artifact: DeviceArtifact = { name, size: out.size ?? 0, sha256: await sha256File(dest), path: dest }

    return receipt('completed', { data: { name } }, [artifact])
  }
}
