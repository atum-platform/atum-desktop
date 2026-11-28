import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Duplex, Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { MATRIX_DEFAULT_MODEL } from '../../../shared/matrix-models'
import { PLAN_PROVIDER_DEFAULTS } from '../plan-providers'
import type { TrialContext, TrialHandle } from '../session/update'

import type { WorkDeliverableReply } from './deliverable-contract'
import { bindWorkDesktopControl, type WorkDesktopUpdateHandler } from './desktop-control'
import { loginShellPath } from './shell-environment'

export const ATUM_WORK_PROVIDER = 'atum-managed'
export const ATUM_WORK_DEFAULT_ALIAS = MATRIX_DEFAULT_MODEL
export const ATUM_WORK_MODEL = `${ATUM_WORK_PROVIDER}:${ATUM_WORK_DEFAULT_ALIAS}`

interface WorkAccount {
  key: string
  generation: number
  root: string
}

interface WorkProcessOptions {
  log?(phase: string, ms: number): void
  ready?(): void
  desktopUpdate?: WorkDesktopUpdateHandler
  prepare?(signal: AbortSignal): Promise<void>
  account: WorkAccount
  resources: string
  gatewayEnvironment: () => Record<string, string>
  revokeCredentials: () => void
  current: () => boolean
  deliverableMessage?(message: unknown, current: () => boolean, signal: AbortSignal): Promise<WorkDeliverableReply | undefined>
}

export interface WorkIncarnation {
  id: string
  accountKey: string
  generation: number
  origin: string
  home: string
  pid: number
  exited: Promise<void>
  unexpectedExit?: Promise<boolean>
  trial?: TrialHandle
  takePairingUrl(): string | undefined
}

export interface WorkStartOptions {
  continuation: boolean
  resources?: string
  trial?: TrialContext
}

const WORK_REQUIRED_SERVER_SETTINGS = { linkedEnvironmentsEnabled: true } as const

const WORK_THREAD_MCP_ORIGINS = ['https://modeb-ta.atumplatform.com'] as const

export function workPairingOrigin(url: string): string | undefined {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/pair#token=[A-Za-z0-9_-]{1,512}$/u.exec(url)

  if (match && Number(match[1]) <= 65535) {
    return `http://127.0.0.1:${match[1]}`
  }
}

export function workProvider(python: string, home: string) {
  return {
    driver: 'acpRegistry',
    displayName: 'Atum',
    enabled: true,
    showInPicker: true,
    config: {
      source: 'local',
      commandPath: python,
      commandArgs: ['-P', '-B', '-X', 'utf8', '-m', 'acp_adapter.managed', '--wait-for-gateway']
    },
    environment: [{ name: 'HERMES_HOME', value: home, sensitive: false }]
  }
}

export function workRuntimeEnvironment(root: string, resources: string, shellPath = ''): Record<string, string> {
  const macPath = process.platform === 'darwin' ? [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'] : []

  return {
    HOME: homedir(),
    TMPDIR: tmpdir(),
    ...(process.env.USER ? { USER: process.env.USER } : {}),
    ...(process.env.LOGNAME ? { LOGNAME: process.env.LOGNAME } : {}),
    ...(process.env.SHELL ? { SHELL: process.env.SHELL } : {}),
    ...Object.fromEntries(['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : [])),
    PATH: [...new Set([join(resources, 'work-runtime'), ...shellPath.split(':'), ...macPath, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean))].join(':'),
    PYTHONPATH: join(resources, 'runtime', 'hermes-agent'),
    LANG: 'en_US.UTF-8',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    T3CODE_HOME: join(root, 'server'),
    T3CODE_TELEMETRY_ENABLED: 'false',
    OTEL_SDK_DISABLED: 'true'
  }
}

export function workThreadMcpEnvironment(origins: readonly string[]): Record<string, string> {
  const allowed = origins.filter(origin => {
    const url = URL.parse(origin)

    return url?.protocol === 'https:' && url.origin === origin && !url.port &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+atumplatform\.com$/u.test(url.hostname)
  })

  return allowed.length ? { T3CODE_THREAD_MCP_ORIGIN: allowed.join(',') } : {}
}

type Supervisor = ChildProcessByStdio<Writable, Readable, null>

async function startProcess(options: WorkProcessOptions, { continuation, trial }: WorkStartOptions, signal: AbortSignal) {
  const { account, resources } = options
  const root = join(account.root, 'work')
  const home = join(root, 'server')
  const cwd = join(root, 'workspace')
  const source = join(resources, 'runtime', 'hermes-agent')
  const python = join(resources, 'runtime', 'python', 'bin', 'python3.14')
  const profileSource = join(source, 'acp_adapter', 'profiles')

  const profile = join(root, 'owner')
  await Promise.all([join(home, 'userdata'), cwd, profile].map(directory =>
    mkdir(directory, { recursive: true, mode: 0o700 })
  ))

  const shellStarted = Date.now()
  const environment = workRuntimeEnvironment(root, resources, await loginShellPath())
  options.log?.('shell', Date.now() - shellStarted)
  const managedModel = { instanceId: ATUM_WORK_PROVIDER, model: ATUM_WORK_MODEL }

  if (signal.aborted || !options.current()) {
    throw new Error('work_account_changed')
  }

  const credentials = options.gatewayEnvironment()
  const secret = options.desktopUpdate ? randomBytes(32).toString('base64url') : undefined
  const desktop = secret ? {
    mode: 'desktop', noBrowser: true, host: '127.0.0.1', t3Home: home, shellEnvironmentPrepared: true,
    tailscaleServeEnabled: false, tailscaleServePort: 443,
    desktopBootstrapSecret: secret, desktopBootstrapToken: desktopToken(secret),
    desktopTelemetryFd: 4, desktopTelemetryControlFd: 5, desktopAppUpdate: false
  } : undefined
  // Keep Node IPC in slot 3 so the desktop control pipes remain on fds 4 and 5.
  const nodeIpc = trial || options.deliverableMessage ? 'ipc' : 'ignore'
  const designSkill = join(resources, 'runtime', 'work-authoring', 'work-design', 'SKILL.md')

  const child = spawn(python, ['-P', '-B', '-X', 'utf8', join(resources, 'work-runtime', 'supervisor.py')], {
    env: environment,
    cwd,
    detached: true,
    stdio: desktop ? ['pipe', 'pipe', 'ignore', nodeIpc, 'pipe', 'pipe']
      : nodeIpc === 'ipc' ? ['pipe', 'pipe', 'ignore', 'ipc'] : ['pipe', 'pipe', 'ignore']
  }) as Supervisor

  const exited = new Promise<void>(resolve => {
    child.once('error', () => undefined)
    child.once('close', () => resolve())
  })

  const stop = () => {
    child.stdin.end()

    return exited
  }

  child.stdin.on('error', () => undefined)
  signal.addEventListener('abort', stop, { once: true })
  child.stdin.write(JSON.stringify({
    lock: join(root, 'sidecar.lock'),
    settingsPath: join(home, 'userdata', 'settings.json'),
    settings: {
      ...WORK_REQUIRED_SERVER_SETTINGS,
      defaultModelSelection: managedModel,
      // ACP has no text-generation runner. Keep the selection on Atum so
      // titles keep their local fallback instead of invoking a subscription.
      textGenerationModelSelection: managedModel,
      providerInstances: { [ATUM_WORK_PROVIDER]: workProvider(python, profile) }
    },
    planProviderDefaults: { ...PLAN_PROVIDER_DEFAULTS, opencode: { driver: 'opencode', enabled: true } },
    trial,
    continuation,
    desktop,
    profileSource,
    managedModelAlias: ATUM_WORK_DEFAULT_ALIAS,
    managedProvider: ATUM_WORK_PROVIDER,
    gateway: {
      ...environment,
      ...Object.fromEntries(Object.entries(credentials).filter(([key]) => !key.startsWith('ATUM_WORK_'))),
      ATUM_MANAGED_MODEL_DEFAULT: ATUM_WORK_DEFAULT_ALIAS,
      HERMES_HOME: profile
    },
    connectorToken: credentials.ATUM_WORK_CONNECTOR_TOKEN,
    executable: join(resources, 'work-runtime', 't3'),
    environment: {
      ...environment,
      ...workThreadMcpEnvironment(WORK_THREAD_MCP_ORIGINS),
      ...(options.deliverableMessage ? {
        ATUM_WORK_MEMO_PYTHON: python,
        ATUM_WORK_MEMO_SCRIPT: join(resources, 'runtime', 'work-authoring', 'memo.py'),
        ...(existsSync(designSkill) ? { ATUM_WORK_DESIGN_SKILL: designSkill } : {})
      } : {}),
      ...(credentials.ATUM_WORK_CONNECTOR_URL
      ? { ATUM_WORK_CONNECTOR_URL: credentials.ATUM_WORK_CONNECTOR_URL }
      : {}),

    },
    cwd
  }) + '\n')
  void exited.then(() => signal.removeEventListener('abort', stop))

  return { child, stop, exited, home, secret }
}

function desktopToken(secret: string): string {
  const window = Math.floor(Date.now() / (12 * 60 * 60 * 1000))

  return createHmac('sha256', secret).update(`t3-desktop-bootstrap:${window}`).digest('hex')
}

function startupEvent<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void

  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })

  void promise.catch(() => undefined)

  return { promise, resolve, reject }
}

function readStartup(child: Supervisor, exited: Promise<void>, signal: AbortSignal) {
  const lines = createInterface({ input: child.stdout })
  const pid = startupEvent<number>()
  const pairing = startupEvent<{ origin: string; url: string }>()
  let spawned = false

  const cleanup = () => {
    clearTimeout(timer)
    signal.removeEventListener('abort', fail)
    lines.close()
    child.stdout.resume()
  }

  const fail = () => {
    const error = new Error('work_start_failed')
    pid.reject(error)
    pairing.reject(error)
    cleanup()
  }

  const timer = setTimeout(fail, 80_000)
  signal.addEventListener('abort', fail, { once: true })
  void exited.then(fail)

  lines.on('line', line => {
    try {
      const event = JSON.parse(line)

      if (event.kind === 'spawned' && Number.isSafeInteger(event.pid) && event.pid > 0) {
        spawned = true
        pid.resolve(event.pid)
      } else if (event.kind === 'pairing') {
        const origin = typeof event.url === 'string' ? workPairingOrigin(event.url) : undefined

        if (!origin || !spawned) {
          fail()
        } else {
          pairing.resolve({ origin, url: event.url })
          cleanup()
        }
      }
    } catch {
      fail()
    }
  })

  return { pid: pid.promise, pairing: pairing.promise }
}

function nativeTrial(
  child: Supervisor,
  updateId: string,
  exited: Promise<void>,
  stillOwned: () => boolean,
  activate: () => Promise<void>
): TrialHandle {
  const prepared = startupEvent<void>()

  const receive = (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'prepared' &&
      'updateId' in message && message.updateId === updateId) {
      prepared.resolve()
      child.off('message', receive)
    }
  }

  child.on('message', receive)
  void exited.then(() => {
    child.off('message', receive)
    prepared.reject(new Error('work_trial_exited'))
  })

  let committing: Promise<void> | undefined

  return {
    prepared: prepared.promise,
    commit: () => committing ??= prepared.promise.then(async () => {
      if (!stillOwned()) {
        throw new Error('work_identity_changed')
      }

      await new Promise<void>((resolve, reject) => {
        child.send({ type: 'committed', updateId }, error => {
          if (error) {
            reject(new Error('work_trial_commit_failed'))
          } else {
            resolve()
          }
        })
      })
      // Native startup only creates the grant and publishes runtime state
      // after accepting the commit. Both are needed before exposing the view.
      await activate()
    })
  }
}

async function verifyListener(home: string, pid: number, expected: string | undefined, signal: AbortSignal): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    signal.throwIfAborted()

    const runtime = await readFile(join(home, 'userdata', 'server-runtime.json'), 'utf8')
      .then(value => JSON.parse(value), () => undefined)

    const origin = typeof runtime?.origin === 'string' && workPairingOrigin(`${runtime.origin}/pair#token=probe`)
    if (origin && runtime.pid === pid && (!expected || expected === origin)) {
      const listener = await fetch(origin, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(600)]) })
        .catch(() => undefined)

      if (listener?.ok) {
        await listener.body?.cancel()

        return origin
      }
    }

    await delay(100, undefined, { signal })
  }

  throw new Error('work_listener_unavailable')
}

/** Node PTY gives its live local shell a controlling terminal. A detached process
 * without a controlling terminal can reconnect through its own persistence. */
export async function workHasAttachedTerminal(serverPid: number): Promise<boolean> {
  const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,tty='], { timeout: 2_000 })
  const rows = stdout.trim().split('\n').map(row => row.trim().split(/\s+/u))
  const descendants = new Set([serverPid])
  for (let prior = 0; descendants.size !== prior;) {
    prior = descendants.size
    for (const [pid, parent] of rows) {
      if (descendants.has(Number(parent))) {descendants.add(Number(pid))}
    }
  }

  return rows.some(([pid, , terminal]) => Number(pid) !== serverPid && descendants.has(Number(pid)) &&
    typeof terminal === 'string' && !/^\?+$/u.test(terminal) && terminal !== '-')
}

export class WorkSidecar {
  private controller?: AbortController
  private starting?: Promise<WorkIncarnation>
  private live?: WorkIncarnation
  private desired?: WorkStartOptions
  private retryTimer?: ReturnType<typeof setTimeout>
  private failures = 0
  private readyAt = 0

  constructor(private readonly options: WorkProcessOptions) {}

  current(): WorkIncarnation | undefined {
    return this.options.current() ? this.live : undefined
  }

  pendingStart(): boolean {
    return Boolean(this.starting && !this.live)
  }

  start(input: WorkStartOptions): Promise<WorkIncarnation> {
    if (!this.options.current()) {
      return Promise.reject(new Error('work_unavailable'))
    }

    if (this.starting) {
      return this.starting
    }

    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const controller = new AbortController()
    this.controller = controller
    this.starting = this.launch(input, controller)

    return this.starting
  }

  async stop(): Promise<void> {
    this.desired = undefined
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const starting = this.starting
    this.live = undefined
    this.controller?.abort()
    await starting?.catch(() => undefined)
    await this.teardown
  }

  private teardown?: Promise<void>

  private async launch(input: WorkStartOptions, controller: AbortController): Promise<WorkIncarnation> {
    const signal = controller.signal
    const startedAt = Date.now()

    try {
      await this.options.prepare?.(signal)
      signal.throwIfAborted()
      const { child, exited, home, stop, secret } = await startProcess(this.options, input, signal)
      this.teardown = exited
      const startup = readStartup(child, exited, signal)
      let origin: string | undefined
      let grant: (() => string) | undefined
      const pipes: readonly (Readable | Writable | null | undefined)[] = child.stdio
      const control = secret && this.options.desktopUpdate && bindWorkDesktopControl({
        reports: pipes[4] as Duplex,
        controls: pipes[5] as Duplex,
        signal,
        exited,
        handler: this.options.desktopUpdate,
        current: () => this.current() === incarnation
      })

      const activate = async () => {
        const paired = control ? await control.ready.then(() => undefined) : await startup.pairing
        const verifiedOrigin = await verifyListener(home, incarnation.pid, paired?.origin, signal)

        if (signal.aborted || !this.options.current()) {
          await stop()
          throw new Error('work_identity_changed')
        }

        origin = verifiedOrigin
        grant = secret ? () => `${verifiedOrigin}/pair#token=${desktopToken(secret)}` : () => paired!.url
        this.options.log?.('ready', Date.now() - startedAt)
        this.live = incarnation
        this.readyAt = Date.now()
        // A committed trial recovers as an ordinary run, never replays a trial.
        this.desired = { continuation: false, resources: input.resources }
        this.options.ready?.()
      }

      const trial = input.trial ? nativeTrial(child, input.trial.update.id, exited, () => !signal.aborted && this.options.current(), activate) : undefined

      const incarnation: WorkIncarnation = {
        id: randomUUID(),
        accountKey: this.options.account.key,
        generation: this.options.account.generation,
        get origin() {
          if (!origin) {
            throw new Error('work_trial_not_committed')
          }

          return origin
        },
        home,
        pid: await startup.pid,
        exited,
        unexpectedExit: exited.then(() => !signal.aborted && this.options.current()),
        trial,
        takePairingUrl: () => {
          const url = this.current() === incarnation ? grant?.() : undefined
          grant = undefined

          return url
        }
      }

      const deliverableMessage = this.options.deliverableMessage

      if (deliverableMessage) {
        const lifetime = new AbortController()
        const current = () => !lifetime.signal.aborted && child.connected && this.live === incarnation && this.options.current()
        const receive = (message: unknown) => {
          if (!current()) {return}

          void deliverableMessage(message, current, lifetime.signal).then(reply => {
            if (reply && current()) {child.send(reply, () => {})}
          }).catch(() => undefined)
        }
        const close = () => {
          lifetime.abort()
          child.off('message', receive)
          signal.removeEventListener('abort', close)
        }

        signal.addEventListener('abort', close, { once: true })
        child.on('message', receive)
        void exited.then(close)
      }

      if (!trial) {
        await activate()
      }

      void exited.then(() => {
        grant = undefined
        const recover = !signal.aborted && this.options.current()

        if (Date.now() - this.readyAt >= 60_000) {this.failures = 0}
        this.clearRun()

        if (recover) {this.scheduleRecovery()}
      })

      return incarnation
    } catch (error) {
      controller.abort()
      await this.teardown
      this.clearRun()
      this.scheduleRecovery()
      throw error
    }
  }

  private scheduleRecovery() {
    if (!this.desired || !this.options.current() || this.retryTimer) {return}
    const wait = Math.min(30_000, 1_000 * 2 ** Math.min(this.failures++, 5))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined

      if (this.desired && this.options.current()) {
        void this.start(this.desired).catch(() => undefined)
      }
    }, wait)
    this.retryTimer.unref()
  }

  private clearRun() {
    this.options.revokeCredentials()
    this.live = undefined
    this.starting = undefined
    this.controller = undefined
    this.teardown = undefined
  }
}
