import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

import { protectedThreadsPath, protectedWorkRoute } from '../connector/protected-route'
import type { TrialContext, TrialHandle } from '../session/update'

export const ATUM_WORK_MODEL = 'atum-managed:binh-minh'
export const ATUM_WORK_PROVIDER = 'atum-managed'
export const ATUM_WORK_DELEGATED_PROVIDER = 'atum-managed-delegated'

interface WorkAccount {
  key: string
  generation: number
  root: string
}

interface WorkProcessOptions {
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
export const WORK_PLAN_CONNECT_SHIPPED = false

export const WORK_REQUIRED_SERVER_SETTINGS = { linkedEnvironmentsEnabled: true } as const

const BROKER_PROFILES = [
  { instance: ATUM_WORK_PROVIDER, directory: 'owner', label: 'Atum' },
  { instance: ATUM_WORK_DELEGATED_PROVIDER, directory: 'delegated', label: 'Atum (delegated)' }
]

export function workPairingOrigin(url: string): string | undefined {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/pair#token=[A-Za-z0-9_-]{1,512}$/u.exec(url)

  if (match && Number(match[1]) <= 65535) {
    return `http://127.0.0.1:${match[1]}`
  }
}

function provider(python: string, home: string, label: string) {
  return {
    driver: 'acpRegistry',
    displayName: label,
    enabled: true,
    config: {
      source: 'local',
      commandPath: python,
      commandArgs: ['-P', '-B', '-X', 'utf8', '-m', 'acp_adapter.managed']
    },
    environment: [{ name: 'HERMES_HOME', value: home, sensitive: false }]
  }
}

export function workRuntimeEnvironment(root: string, resources: string): Record<string, string> {
  const osHome = join(root, 'environment')

  return {
    HOME: osHome,
    TMPDIR: osHome,
    XDG_CONFIG_HOME: join(osHome, 'config'),
    XDG_CACHE_HOME: join(osHome, 'cache'),
    PATH: [join(resources, 'work-runtime'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    PYTHONPATH: join(resources, 'runtime', 'hermes-agent'),
    LANG: 'en_US.UTF-8',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    T3CODE_HOME: join(root, 'server'),
    T3CODE_TELEMETRY_ENABLED: 'false',
    OTEL_SDK_DISABLED: 'true'
  }
}

type Supervisor = ChildProcessByStdio<Writable, Readable, null>

// Match T3's native macOS managed-policy sources so Work cannot mask either.
async function nativePolicyPresent(): Promise<boolean> {
  const nativePolicyPaths = [
    '/Library/Application Support/T3Code/policy.json',
    '/Library/Managed Preferences/com.t3tools.t3code.plist',
    join('/Library/Managed Preferences', userInfo().username, 'com.t3tools.t3code.plist')
  ]
  const present = await Promise.all(
    nativePolicyPaths.map(path => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT'))
  )

  return present.some(Boolean)
}

async function startProcess(options: WorkProcessOptions, { continuation, trial }: WorkStartOptions, signal: AbortSignal) {
  const { account, resources } = options
  const root = join(account.root, 'work')
  const home = join(root, 'server')
  const cwd = join(root, 'workspace')
  const osHome = join(root, 'environment')
  const source = join(resources, 'runtime', 'hermes-agent')
  const python = join(resources, 'runtime', 'python', 'bin', 'python3.14')
  const profileSource = join(source, 'acp_adapter', 'profiles')

  const pin = await readFile(join(resources, 'work-runtime', 'pin.json'), 'utf8')
    .then(text => JSON.parse(text) as { protectedConnector?: boolean })
    .catch(() => undefined)

  const protectedConnector = pin?.protectedConnector === true && !(await nativePolicyPresent())

  // A previous runtime must never reopen a home whose provider fence it cannot enforce.
  if (!protectedConnector && protectedWorkRoute(account.root) !== 'open') {
    throw new Error('work_protected_runtime_required')
  }

  const profiles = BROKER_PROFILES.map(({ directory }) => join(root, directory))
  await Promise.all([join(home, 'userdata'), cwd, osHome, ...profiles].map(directory =>
    mkdir(directory, { recursive: true, mode: 0o700 })
  ))

  const environment = workRuntimeEnvironment(root, resources)
  const managedModel = { instanceId: ATUM_WORK_PROVIDER, model: ATUM_WORK_MODEL }

  const providerInstances = Object.fromEntries([
    ['codex', { driver: 'codex', enabled: false, config: { binaryPath: '/usr/bin/false' } }],
    ['claudeAgent', { driver: 'claudeAgent', enabled: false, config: { binaryPath: '/usr/bin/false' } }],
    ...BROKER_PROFILES.map(({ directory, instance, label }) => [
      instance, provider(python, join(root, directory), label)
    ])
  ])

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
    trial,
    profileSource,
    ...(protectedConnector
      ? {
          protectionPolicy: {
            path: join(root, 'provider-policy.json'),
            document: {
              schemaVersion: 1,
              organization: 'Atum',
              settings: {
                [`providerInstances.${ATUM_WORK_PROVIDER}`]: {
                  value: providerInstances[ATUM_WORK_PROVIDER],
                  locked: true
                }
              }
            }
          }
        }
      : {}),
    gateways: profiles.map(profile => ({ ...environment, ...Object.fromEntries(Object.entries(credentials).filter(([key]) => !key.startsWith('ATUM_WORK_CONNECTOR_'))), HERMES_HOME: profile })),
    connectorToken: credentials.ATUM_WORK_CONNECTOR_TOKEN,
    executable: join(resources, 'work-runtime', 't3'),
    environment: {
      ...environment,
      ...(credentials.ATUM_WORK_CONNECTOR_URL
      ? { ATUM_WORK_CONNECTOR_URL: credentials.ATUM_WORK_CONNECTOR_URL }
      : {}),
      ...(protectedConnector
        ? {
            ATUM_WORK_CONNECTOR_PROTECTED_DIR: protectedThreadsPath(account.root),
            ATUM_WORK_CONNECTOR_POLICY: join(root, 'provider-policy.json')
          }
        : {})
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

    const controller = new AbortController()
    this.controller = controller
    this.starting = this.launch(input, controller)

    return this.starting
  }

  async stop(): Promise<void> {
    const starting = this.starting
    this.live = undefined
    this.controller?.abort()
    await starting?.catch(() => undefined)
    await this.teardown
  }

  private teardown?: Promise<void>

  private async launch(input: WorkStartOptions, controller: AbortController): Promise<WorkIncarnation> {
    const signal = controller.signal

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
        this.live = incarnation
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
        this.clearRun()
      })

      return incarnation
    } catch (error) {
      controller.abort()
      await this.teardown
      this.clearRun()
      throw error
    }
  }

  private clearRun() {
    this.options.revokeCredentials()
    this.live = undefined
    this.starting = undefined
    this.controller = undefined
    this.teardown = undefined
  }
}
