import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

import semver from 'semver'

import { MATRIX_DEFAULT_MODEL } from '../../../shared/matrix-models'
import { PLAN_PROVIDER_DEFAULTS } from '../plan-providers'
import type { TrialContext, TrialHandle } from '../session/update'

import { loginShellPath } from './shell-environment'

export const ATUM_WORK_PROVIDER = 'atum-managed'
export const ATUM_WORK_DEFAULT_ALIAS = MATRIX_DEFAULT_MODEL
export const ATUM_WORK_MODEL = `${ATUM_WORK_PROVIDER}:${ATUM_WORK_DEFAULT_ALIAS}`
export const ATUM_WORK_DELEGATED_PROVIDER = 'atum-managed-delegated'

interface WorkAccount {
  key: string
  generation: number
  root: string
}

interface WorkProcessOptions {
  log?(phase: string, ms: number): void
  ready?(): void
  prepare?(signal: AbortSignal): Promise<void>
  account: WorkAccount
  resources: string
  gatewayEnvironment: () => Record<string, string>
  revokeCredentials: () => void
  current: () => boolean
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
  relayRuntimeReady?: boolean
  trial?: TrialHandle
  takePairingUrl(): string | undefined
}

export interface WorkStartOptions {
  continuation: boolean
  resources?: string
  trial?: TrialContext
}

/**
 * Server settings the assistants' route cannot work without. T3 refuses to register a peer-link OAuth client
 * (HTTP 400 at `/oauth/mcp/register`) unless linked environments are on, so a fresh install would never get an
 * agent session. Written before the server opens the home (supervisor.py merges `settings` first).
 */
/**
 * Gate 4a-2 (plan §10.2): this build ships the maker's own Codex client, unmodified, as an enabled T3 instance. False while the
 * instance below is disabled (`/usr/bin/false`): the Connect step and row stay hidden for every account. The Connect lane flips
 * both together, after 4a-2, 4a-4 and 4a-6 are proven on the pin.
 */
export function workRelayRuntimeReady(resources: string): boolean {
  try {
    const pin = JSON.parse(readFileSync(join(resources, 'work-runtime', 'pin.json'), 'utf8')) as { version?: string }

    return Boolean(pin.version && semver.valid(pin.version) && semver.gte(pin.version, '0.1.12'))
  } catch {
    return false
  }
}

export const WORK_REQUIRED_SERVER_SETTINGS = { linkedEnvironmentsEnabled: true } as const

const BROKER_PROFILES = [
  { instance: ATUM_WORK_PROVIDER, directory: 'owner', label: 'Atum', showInPicker: true },
  { instance: ATUM_WORK_DELEGATED_PROVIDER, directory: 'delegated', label: 'Atum (delegated)', showInPicker: false }
]

export function workPairingOrigin(url: string): string | undefined {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/pair#token=[A-Za-z0-9_-]{1,512}$/u.exec(url)

  if (match && Number(match[1]) <= 65535) {
    return `http://127.0.0.1:${match[1]}`
  }
}

export function workProvider(python: string, home: string, label: string, showInPicker: boolean, delegated = false) {
  return {
    driver: 'acpRegistry',
    displayName: label,
    enabled: true,
    showInPicker,
    config: {
      source: 'local',
      commandPath: python,
      commandArgs: ['-P', '-B', '-X', 'utf8', '-m', 'acp_adapter.managed']
    },
    environment: [
      { name: 'HERMES_HOME', value: home, sensitive: false },
      ...(delegated ? Object.entries(workDelegatedEnvironment(home)).map(([name, value]) => ({ name, value, sensitive: false })) : [])
    ]
  }
}

// Cloud-initiated tools retain their account home, including explicit config roots.
export function workDelegatedEnvironment(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude')
  }
}

export function workRuntimeEnvironment(root: string, resources: string, shellPath = ''): Record<string, string> {
  return {
    HOME: homedir(),
    TMPDIR: tmpdir(),
    ...(process.env.USER ? { USER: process.env.USER } : {}),
    ...(process.env.LOGNAME ? { LOGNAME: process.env.LOGNAME } : {}),
    ...(process.env.SHELL ? { SHELL: process.env.SHELL } : {}),
    ...Object.fromEntries(['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : [])),
    PATH: [join(resources, 'work-runtime'), shellPath, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':'),
    PYTHONPATH: join(resources, 'runtime', 'hermes-agent'),
    LANG: 'en_US.UTF-8',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    T3CODE_HOME: join(root, 'server'),
    T3CODE_TELEMETRY_ENABLED: 'false',
    OTEL_SDK_DISABLED: 'true'
  }
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

  const profiles = BROKER_PROFILES.map(({ directory }) => join(root, directory))
  await Promise.all([join(home, 'userdata'), cwd, ...profiles].map(directory =>
    mkdir(directory, { recursive: true, mode: 0o700 })
  ))

  const shellStarted = Date.now()
  const environment = workRuntimeEnvironment(root, resources, await loginShellPath())
  options.log?.('shell', Date.now() - shellStarted)
  const managedModel = { instanceId: ATUM_WORK_PROVIDER, model: ATUM_WORK_MODEL }

  const providerInstances = Object.fromEntries(BROKER_PROFILES.map(({ directory, instance, label, showInPicker }) => [
    instance, workProvider(python, join(root, directory), label, showInPicker, instance === ATUM_WORK_DELEGATED_PROVIDER)
  ]))

  if (signal.aborted || !options.current()) {
    throw new Error('work_account_changed')
  }

  const credentials = options.gatewayEnvironment()

  const child = spawn(python, ['-P', '-B', '-X', 'utf8', join(resources, 'work-runtime', 'supervisor.py')], {
    env: environment,
    cwd,
    detached: true,
    stdio: trial ? ['pipe', 'pipe', 'ignore', 'ipc'] : ['pipe', 'pipe', 'ignore']
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
      continueThreadsAfterServerUpdate: continuation,
      defaultModelSelection: managedModel,
      // ACP has no text-generation runner. Keep the selection on Atum so
      // titles keep their local fallback instead of invoking a subscription.
      textGenerationModelSelection: managedModel,
      providerInstances
    },
    planProviderDefaults: { ...PLAN_PROVIDER_DEFAULTS, opencode: { driver: 'opencode', enabled: true } },
    trial,
    profileSource,
    managedModelAlias: ATUM_WORK_DEFAULT_ALIAS,
    managedProvider: ATUM_WORK_PROVIDER,
    gateways: profiles.map((profile, index) => ({
      ...environment,
      ...(index === 1 ? workDelegatedEnvironment(profile) : {}),
      ...Object.fromEntries(Object.entries(credentials).filter(([key]) => !key.startsWith('ATUM_WORK_'))),
      ATUM_MANAGED_MODEL_DEFAULT: ATUM_WORK_DEFAULT_ALIAS,
      HERMES_HOME: profile
    })),
    connectorToken: credentials.ATUM_WORK_CONNECTOR_TOKEN,
    executable: join(resources, 'work-runtime', 't3'),
    environment: {
      ...environment,
      ...(credentials.ATUM_WORK_CONNECTOR_URL
      ? { ATUM_WORK_CONNECTOR_URL: credentials.ATUM_WORK_CONNECTOR_URL }
      : {}),

    },
    cwd
  }) + '\n')
  void exited.then(() => signal.removeEventListener('abort', stop))

  return { child, stop, exited, home }
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

async function verifyListener(home: string, pid: number, origin: string, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    signal.throwIfAborted()

    const runtime = await readFile(join(home, 'userdata', 'server-runtime.json'), 'utf8')
      .then(value => JSON.parse(value), () => undefined)

    if (runtime?.pid === pid && runtime.origin === origin) {
      const listener = await fetch(origin, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(600)]) })
        .catch(() => undefined)

      if (listener?.ok) {
        await listener.body?.cancel()

        return
      }
    }

    await delay(100, undefined, { signal })
  }

  throw new Error('work_listener_unavailable')
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
      const { child, exited, home, stop } = await startProcess(this.options, input, signal)
      this.teardown = exited
      const startup = readStartup(child, exited, signal)
      let origin: string | undefined
      let grant: string | undefined

      const activate = async () => {
        const paired = await startup.pairing
        await verifyListener(home, incarnation.pid, paired.origin, signal)

        if (signal.aborted || !this.options.current()) {
          await stop()
          throw new Error('work_identity_changed')
        }

        origin = paired.origin
        grant = paired.url
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
        relayRuntimeReady: workRelayRuntimeReady(input.resources ?? this.options.resources),
        exited,
        unexpectedExit: exited.then(() => !signal.aborted && this.options.current()),
        trial,
        takePairingUrl: () => {
          const url = this.current() === incarnation ? grant : undefined
          grant = undefined

          return url
        }
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
