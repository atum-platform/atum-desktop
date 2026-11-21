import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

export const ATUM_WORK_MODEL = 'atum-managed:binh-minh'
export const ATUM_WORK_PROVIDER = 'atum-managed'
export const ATUM_WORK_DELEGATED_PROVIDER = 'atum-managed-delegated'

interface WorkAccount {
  key: string
  generation: number
  root: string
}

interface WorkProcessOptions {
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
  takePairingUrl(): string | undefined
}

export interface WorkStartOptions {
  continuation: boolean
}

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
    environment: [{ name: 'HERMES_HOME', value: home }]
  }
}

async function startProcess(options: WorkProcessOptions, { continuation }: WorkStartOptions, signal: AbortSignal) {
  const { account, resources } = options
  const root = join(account.root, 'work')
  const home = join(root, 'server')
  const cwd = join(root, 'workspace')
  const osHome = join(root, 'environment')
  const source = join(resources, 'runtime', 'hermes-agent')
  const python = join(resources, 'runtime', 'python', 'bin', 'python3.14')
  const profileSource = join(source, 'acp_adapter', 'profiles')
  const profiles = BROKER_PROFILES.map(({ directory }) => join(root, directory))
  await Promise.all([join(home, 'userdata'), cwd, osHome, ...profiles].map(directory =>
    mkdir(directory, { recursive: true, mode: 0o700 })
  ))

  const environment = {
    HOME: osHome,
    TMPDIR: osHome,
    XDG_CONFIG_HOME: join(osHome, 'config'),
    XDG_CACHE_HOME: join(osHome, 'cache'),
    PATH: [join(resources, 'work-runtime'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    PYTHONPATH: source,
    LANG: 'en_US.UTF-8',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    T3CODE_HOME: home,
    T3CODE_TELEMETRY_ENABLED: 'false',
    OTEL_SDK_DISABLED: 'true'
  }

  const providerInstances = Object.fromEntries([
    ['codex', { driver: 'codex', enabled: false, config: {} }],
    ['claudeAgent', { driver: 'claudeAgent', enabled: false, config: {} }],
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
    stdio: ['pipe', 'pipe', 'ignore']
  })

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
      continueThreadsAfterServerUpdate: continuation,
      defaultModelSelection: { instanceId: ATUM_WORK_PROVIDER, model: ATUM_WORK_MODEL },
      providerInstances
    },
    profileSource,
    gateways: profiles.map(profile => ({ ...environment, ...credentials, HERMES_HOME: profile })),
    executable: join(resources, 'work-runtime', 't3'),
    environment,
    cwd
  }) + '\n')
  void exited.then(() => signal.removeEventListener('abort', stop))

  return { child, stop, exited, home }
}

async function readStartup(child: Awaited<ReturnType<typeof startProcess>>['child'], exited: Promise<void>, signal: AbortSignal) {
  const lines = createInterface({ input: child.stdout })

  let abort = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await new Promise<{ origin: string; pid: number; pairingUrl: string }>((resolve, reject) => {
      let pid: number | undefined
      abort = () => reject(new Error('work_start_failed'))
      timer = setTimeout(abort, 65_000)
      signal.addEventListener('abort', abort, { once: true })
      child.once('error', abort)
      void exited.then(abort)
      lines.on('line', line => {
        try {
          const event = JSON.parse(line)

          if (event.kind === 'spawned' && Number.isSafeInteger(event.pid) && event.pid > 0) {
            pid = event.pid
          }

          if (event.kind === 'pairing') {
            const origin = typeof event.url === 'string' ? workPairingOrigin(event.url) : undefined

            if (!origin || !pid) {
              abort()
            } else {
              resolve({ origin, pid, pairingUrl: event.url })
            }
          }
        } catch {
          abort()
        }
      })
    })
  } finally {
    lines.close()
    child.stdout.resume()
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
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
      const { child, exited, home, stop } = await startProcess(this.options, input, signal)
      this.teardown = exited
      const { origin, pid, pairingUrl } = await readStartup(child, exited, signal)
      await verifyListener(home, pid, origin, signal)

      if (signal.aborted || !this.options.current()) {
        await stop()
        throw new Error('work_identity_changed')
      }

      let grant: string | undefined = pairingUrl

      const incarnation: WorkIncarnation = {
        id: randomUUID(),
        accountKey: this.options.account.key,
        generation: this.options.account.generation,
        origin,
        home,
        pid,
        exited,
        takePairingUrl: () => {
          const url = this.current() === incarnation ? grant : undefined
          grant = undefined

          return url
        }
      }

      this.live = incarnation
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
