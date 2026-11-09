import { EventEmitter } from 'node:events'
import os from 'node:os'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  read: vi.fn(),
  exists: vi.fn(() => false),
  mkdir: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(() => ({ isDirectory: () => true })),
  lstat: vi.fn(() => ({ isDirectory: (): boolean => true, isSymbolicLink: (): boolean => false })),
  realpath: vi.fn((value: string) => value),
  ready: vi.fn(),
  turn: vi.fn(),
  connect: vi.fn(),
  onState: vi.fn(),
  close: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFile: mocks.execFile }))
vi.mock('node:fs', () => ({
  existsSync: mocks.exists,
  readFileSync: mocks.read,
  mkdirSync: mocks.mkdir,
  rmSync: mocks.rm,
  statSync: mocks.stat,
  lstatSync: mocks.lstat,
  realpathSync: mocks.realpath
}))
vi.mock('../backend-ready', () => ({ waitForDashboardPort: mocks.ready }))
vi.mock('./hermes-turn', () => ({ runMatrixHermesTurn: mocks.turn }))
vi.mock('../../../shared/src/json-rpc-gateway', () => ({
  JsonRpcGatewayClient: class {
    connect = mocks.connect
    onState = mocks.onState
    close = mocks.close
  }
}))

import { matrixSubscriptionEnvironment } from './account-subscriptions'
import {
  clearMatrixAccountChatGpt,
  clearMatrixHermesCredentials,
  ensureMatrixAtumInstructions,
  executeMatrixHermes,
  matrixAccountCodexScope,
  matrixGoogleHermesEnvironment,
  type MatrixHermesConnection,
  matrixHermesEnvironment,
  matrixHermesHome,
  matrixHermesJobsEnvironment,
  matrixHermesWorkspace,
  openMatrixHermes,
  readMatrixHermesRuntime,
  withMatrixHermes
} from './hermes-runtime'
import { configureMatrixHermes, MATRIX_HERMES_ENDPOINT } from './hermes-setup'

const config = { python: '/fixture/python', source: '/fixture/source', profiles: '/fixture/profiles' }

it('repairs the imported aux interpreter via the native atomic YAML writer, without enabling instructions', async () => {
  mocks.read.mockReturnValue('mcp_servers:\n  atum-aux:\n    command: /removed/bin/python3.11\n    args: [server.py]\n')
  mocks.execFile.mockImplementation((_python, _args, _options, done) => { done(null); return {} })
  await ensureMatrixAtumInstructions(config, '/fixture/home', new AbortController().signal, false)
  const [python, args] = mocks.execFile.mock.calls[0]!
  expect(python).toBe(config.python)
  expect(args.slice(-3)).toEqual(['/fixture/home/config.yaml', '0', config.python])
  expect(args[4]).toContain('atomic_roundtrip_yaml_update')
  expect(args[4]).toContain('mcp_servers.atum-aux.command')
})

it('logs optional aux dependency failure once per interpreter without blocking Hermes launch', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  mocks.read.mockReturnValue('mcp_servers:\n  atum-aux:\n    command: /removed/bin/python3.11\n')
  mocks.execFile.mockImplementation((_python, _args, _options, done) => {
    done(null, 'atum_aux_dependencies_unavailable\n'); return {}
  })
  const selected = { ...config, python: '/fixture/python-without-mcp' }
  await ensureMatrixAtumInstructions(selected, '/fixture/home', new AbortController().signal, false)
  await ensureMatrixAtumInstructions(selected, '/fixture/other-home', new AbortController().signal, false)
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('optional atum-aux dependencies unavailable'))
})

it.each([undefined, 'off', 'reply'])('keeps the unconnected pet surface off despite inherited %s', inherited => {
  expect(
    matrixHermesEnvironment(config, '/fixture/home', '/fixture/work', { ATUM_PET_INTENTS: inherited }).ATUM_PET_INTENTS
  ).toBe('off')
})
const controller = () => new AbortController()

const input = (abort: AbortController) => ({
  owner: 'owner',
  executorId: 'executor',
  invocationId: 'turn',
  text: 'pwd',
  signal: abort.signal
})

function childFixture(exitOnTerm = true) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((signal: string) => {
      if (exitOnTerm || signal === 'SIGKILL') {
        queueMicrotask(() => child.emit('exit', null, signal))
      }

      return true
    })
  })

  mocks.spawn.mockReturnValue(child)

  return child
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.read.mockReturnValue('model: fixture')
  mocks.ready.mockResolvedValue(12345)
  mocks.connect.mockResolvedValue(undefined)
  mocks.onState.mockImplementation(handler => {
    handler('open')

    return () => {}
  })
  mocks.turn.mockResolvedValue({ text: 'done', storedSession: 'saved' })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('main-owned Hermes process', () => {
  it('keeps management REST native, authenticated and attached to runtime lifetime', async () => {
    childFixture()

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ profiles: [{ name: 'default', path: matrixHermesHome(config, 'owner', 'executor') }] })
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [] })))

    vi.stubGlobal('fetch', fetchMock)
    const connection = await openMatrixHermes(config, input(controller()))
    await expect(connection.pages!({ path: '/api/cron/jobs?profile=default', method: 'GET' })).resolves.toEqual({
      jobs: []
    })
    const [url, options] = fetchMock.mock.calls[1]
    expect(url).toBe('http://127.0.0.1:12345/api/cron/jobs?profile=default')
    expect(options.redirect).toBe('error')
    expect(options.headers.Authorization).toMatch(/^Bearer [a-f0-9]{64}$/)
    expect(options.signal.aborted).toBe(false)
    await connection.close()
    expect(options.signal.aborted).toBe(true)
  })
  it('does not expose failed backend response bodies through management pages', async () => {
    childFixture()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private provider details', { status: 500 })))
    const connection = await openMatrixHermes(config, input(controller()))

    try {
      await expect(connection.pages!({ path: '/api/cron/jobs?profile=default', method: 'GET' })).rejects.toThrow(
        'pages_request_failed'
      )
      expect(connection.signal.aborted).toBe(false)
    } finally {
      await connection.close()
    }
  })
  it('caps management response bytes without retiring the shared runtime', async () => {
    childFixture()
    const cancelled = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(reader) {
              reader.enqueue(new Uint8Array(8 * 1024 * 1024 + 1))
            },
            cancel: cancelled
          })
        )
      )
    )
    const connection = await openMatrixHermes(config, input(controller()))

    try {
      await expect(
        connection.pages!({ path: '/api/profiles/sessions?profile=default', method: 'GET' })
      ).rejects.toThrow('pages_response_too_large')
      expect(cancelled).toHaveBeenCalledOnce()
      expect(connection.signal.aborted).toBe(false)
    } finally {
      await connection.close()
    }
  })
  it.each(['transport', 'exit'])('retires a resident runtime after unexpected %s loss', async failure => {
    const child = childFixture()

    let state: (value: string) => void = () => {}
    const off = vi.fn()
    mocks.onState.mockImplementation(handler => {
      state = handler
      handler('open')

      return off
    })
    const connection = await openMatrixHermes(config, input(controller()))
    expect(connection.signal.aborted).toBe(false)

    if (failure === 'transport') {
      state('closed')
    } else {
      child.emit('exit', 1, null)
    }

    expect(connection.signal.aborted).toBe(true)
    await connection.close()
    expect(off).toHaveBeenCalledOnce()
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.turn).not.toHaveBeenCalled()
  })
  it('reports only closed lifecycle facts for an attempt-scoped backend', async () => {
    const child = childFixture()
    const diagnostics = { spawned: vi.fn(), portReady: vi.fn(), exit: vi.fn() }
    const connection = await openMatrixHermes(config, { ...input(controller()), diagnostics })
    expect(diagnostics.spawned).toHaveBeenCalledOnce()
    expect(diagnostics.portReady).toHaveBeenCalledWith(expect.any(Number))

    child.emit('exit', 17, null)
    expect(connection.signal.aborted).toBe(true)
    expect(diagnostics.exit).toHaveBeenCalledExactlyOnceWith({ code: 17, signal: null, intentional: false })
    await connection.close()
  })
  it('rejects a transport already closed when its lifecycle observer attaches', async () => {
    childFixture()
    const off = vi.fn()
    mocks.onState.mockImplementation(handler => {
      handler('closed')

      return off
    })
    await expect(openMatrixHermes(config, input(controller()))).rejects.toThrow('matrix_hermes_runtime_stopped')
    expect(off).toHaveBeenCalledOnce()
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it('settles a cancelled startup when the WebSocket connect promise ignores close', async () => {
    const child = childFixture()
    const abort = controller()
    mocks.connect.mockImplementation(() => new Promise<void>(() => {}))

    const pending = openMatrixHermes(config, input(abort))
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
    abort.abort()

    await expect(pending).rejects.toBeDefined()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(mocks.close).toHaveBeenCalled()
  })
  it('clears only the retained profile through offline Hermes', async () => {
    mocks.execFile.mockImplementation((_python, _args, _options, done) => done(null))
    await clearMatrixHermesCredentials(config, '/retained/profile')
    const [python, args, options] = mocks.execFile.mock.calls[0]!
    expect(python).toBe(config.python)
    expect(args.slice(0, 4)).toEqual(['-s', '-P', '-B', '-c'])
    const api = vi.fn(async (_route: string, _body: unknown) => {})
    await configureMatrixHermes(
      {
        api,
        gateway: { request: vi.fn(async () => ({ ok: true, ready: true })) }
      } as unknown as MatrixHermesConnection,
      { baseUrl: 'https://model.test', model: 'fixture', apiKey: '' },
      new AbortController().signal
    )
    expect(api.mock.calls[0]![1]).toMatchObject(MATRIX_HERMES_ENDPOINT)
    expect(args.slice(-2)).toEqual([MATRIX_HERMES_ENDPOINT.id, MATRIX_HERMES_ENDPOINT.name])
    expect(options).toMatchObject({ cwd: config.source, timeout: 60_000, env: { HERMES_HOME: '/retained/profile' } })
    // The profile's own ChatGPT sign-in goes too; the account's shared one is main's to forget.
    expect(args[4]).toContain('clear_provider_auth("openai-codex")')
    expect(options.env.HERMES_CODEX_SHARED_AUTH_DIR).toBe('/retained/profile/desktop-runtime/codex-auth')
    expect(mocks.spawn).not.toHaveBeenCalled()
    mocks.execFile.mockImplementation((_python, _args, _options, done) => done(new Error('secret file contents')))
    await expect(clearMatrixHermesCredentials(config, '/retained/profile')).rejects.toThrow(
      'matrix_local_cleanup_pending'
    )
    vi.unstubAllEnvs()
  })
  it('starts setup without a config and keeps native HTTP tokens private with redirects denied', async () => {
    const child = childFixture()
    const cancel = vi.fn(async () => {})
    const fetch = vi.fn(async () => ({ ok: true, body: { cancel } }))
    vi.stubGlobal('fetch', fetch)
    mocks.read.mockImplementation(() => {
      throw new Error('no config')
    })
    await withMatrixHermes(config, input(controller()), async connection => {
      expect(child.kill).not.toHaveBeenCalled()
      await connection.api('/api/config', { config: {} })
    })
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/api/config',
      expect.objectContaining({
        method: 'PUT',
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer [a-f0-9]{64}$/) })
      })
    )
    expect(cancel).toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(mocks.turn).not.toHaveBeenCalled()
  })
  it("runs another agent in its bound home, and only in a home folder of this runtime's profiles", async () => {
    const bound = `${config.profiles}/${'b'.repeat(64)}`
    childFixture()
    await withMatrixHermes(config, { ...input(controller()), home: bound }, async () => {})
    expect(mocks.spawn.mock.calls[0][2].env.HERMES_HOME).toBe(bound)
    expect(mocks.mkdir).toHaveBeenCalledWith(bound, expect.objectContaining({ recursive: true }))

    // Without one, the executor's own home, as the default agent has always run.
    childFixture()
    await withMatrixHermes(config, input(controller()), async () => {})
    expect(mocks.spawn.mock.calls[1][2].env.HERMES_HOME).toBe(matrixHermesHome(config, 'owner', 'executor'))

    for (const home of ['relative/home', `/elsewhere/${'b'.repeat(64)}`, `${config.profiles}/not-a-home`]) {
      await expect(withMatrixHermes(config, { ...input(controller()), home }, async () => {})).rejects.toThrow(
        'matrix_runtime_configuration_invalid'
      )
    }

    expect(mocks.spawn).toHaveBeenCalledTimes(2)
  })
  it('terminates only the dedicated POSIX process group, including helpers left after parent exit', async () => {
    if (process.platform === 'win32') {
      return
    }

    const child = Object.assign(childFixture(), { pid: 87654321 })

    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-87654321)

      if (signal === 'SIGTERM') {
        queueMicrotask(() => child.emit('exit', null, signal))
      }

      return true
    })

    await executeMatrixHermes(config, input(controller()))
    expect(mocks.spawn.mock.calls[0][2].detached).toBe(true)
    expect(kill).toHaveBeenCalledWith(-87654321, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(-87654321, 'SIGKILL')
    expect(child.kill).not.toHaveBeenCalled()
  })
  it("runs Hermes as the old app did: the person's environment and home, every toolset, one profile per account", async () => {
    vi.stubEnv('OPENAI_API_KEY', 'the-owners-key')
    vi.stubEnv('ATUM_FILESYSTEM_CAPABILITY_REQUIRED', '1')
    vi.stubEnv('HERMES_TUI_TOOLSETS', 'terminal')
    vi.stubEnv('HERMES_TUI_TOOL_PROGRESS', 'off')
    vi.stubEnv('HERMES_HOME', '/elsewhere')
    vi.stubEnv('PYTHONHOME', '/other/python')
    const child = childFixture()
    expect(matrixHermesHome(config, 'owner', 'executor')).not.toBe(matrixHermesHome(config, 'other', 'executor'))
    expect(await executeMatrixHermes(config, input(controller()))).toEqual({ text: 'done', storedSession: 'saved' })
    const [, args, options] = mocks.spawn.mock.calls[0]
    expect(args.slice(0, 5)).toEqual(['-s', '-P', '-B', '-m', 'hermes_cli.main'])
    // The person's own environment, home and working folder, as the old app's backend had.
    expect(options.env.OPENAI_API_KEY).toBe('the-owners-key')
    expect(options.env.HOME).toBe(process.env.HOME)
    // Spawn and tools share the resolver's private workspace projection.
    expect(options.cwd).toBe(matrixHermesWorkspace())
    expect(options.env.TERMINAL_CWD).toBe(options.cwd)
    expect(mocks.mkdir).toHaveBeenCalledWith(`${os.homedir()}/Atum/Workspace`, { mode: 0o700 })
    // Hermes's own toolsets and the desktop backend (cron ticker, checkpoints); its .env loads.
    expect(options.env.HERMES_TUI_TOOLSETS).toBeUndefined()
    expect(options.env.HERMES_DESKTOP).toBe('1')
    expect(options.env.HERMES_TUI_CHECKPOINTS).toBe('1')
    // Tool starts stay visible to the resume decision whatever the person's shell says (turn-effects.ts).
    expect(options.env.HERMES_TUI_TOOL_PROGRESS).toBe('all')
    expect(options.env.PYTHON_DOTENV_DISABLED).toBeUndefined()
    // This account's profile, the bundled runtime intact, and none of the app's private wiring.
    expect(options.env.HERMES_HOME).toMatch(/^\/fixture\/profiles\/[a-f0-9]{64}$/)
    expect(options.env.ATUM_FILESYSTEM_CAPABILITY_REQUIRED).toBeUndefined()
    expect(options.env.PYTHONHOME).toBeUndefined()
    expect(options.env.PYTHONNOUSERSITE).toBe('1')
    expect(options.env.PYTHONSAFEPATH).toBe('1')
    expect(options.env.HERMES_LAZY_INSTALL_TARGET).toMatch(
      /^\/fixture\/profiles\/[a-f0-9]{64}\/desktop-runtime\/lazy-packages$/
    )
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(mocks.close).toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
  it('hands a spawned assistant the account sign-in home as its auth root, never as an inherited value', async () => {
    childFixture()
    vi.stubEnv('ATUM_ACCOUNT_AUTH_HOME', '/untrusted/inherited')

    const connection = await openMatrixHermes(
      {
        ...config,
        subscriptionEnv: () => matrixSubscriptionEnvironment(undefined, '/fixture/profiles/account-home')
      },
      input(controller())
    )

    expect(mocks.spawn.mock.calls.at(-1)![2].env.ATUM_ACCOUNT_AUTH_HOME).toBe('/fixture/profiles/account-home')
    await connection.close()
    vi.unstubAllEnvs()
  })
  it('clears ChatGPT from the account home through Hermes’s own locked clear_provider_auth', async () => {
    const home = '/fixture/profiles/account-home'
    mocks.execFile.mockImplementation((_python, _args, _options, done) => done(null))

    // No store yet: nothing to clear and no process started.
    mocks.exists.mockReturnValueOnce(false)
    await clearMatrixAccountChatGpt(config, home)
    expect(mocks.execFile).not.toHaveBeenCalled()

    mocks.exists.mockReturnValue(true)
    await clearMatrixAccountChatGpt(config, home)
    expect(mocks.exists).toHaveBeenLastCalledWith('/fixture/profiles/account-home/auth.json')
    const [python, args, options] = mocks.execFile.mock.calls[0]!
    expect(python).toBe(config.python)
    expect(args).toEqual(['-s', '-P', '-B', '-c', 'from hermes_cli.auth import clear_provider_auth; clear_provider_auth("openai-codex")'])
    expect(options).toMatchObject({ cwd: config.source, env: { HERMES_HOME: home } })

    mocks.execFile.mockImplementation((_python, _args, _options, done) => done(new Error('secret file contents')))
    await expect(clearMatrixAccountChatGpt(config, home)).rejects.toThrow('matrix_subscriptions_unavailable')
    await expect(clearMatrixAccountChatGpt(config, 'relative/home')).rejects.toThrow('matrix_subscriptions_unavailable')
    mocks.exists.mockReturnValue(false)
  })
  it('pins one account source-policy path while stripping an inherited one', async () => {
    childFixture()
    vi.stubEnv('ATUM_SOURCE_POLICY_FILE', '/untrusted/inherited.json')

    const connection = await openMatrixHermes(config, {
      ...input(controller()),
      sourcePolicy: '/fixture/source-policy/account.json'
    })

    expect(mocks.spawn.mock.calls[0][2].env.ATUM_SOURCE_POLICY_FILE).toBe('/fixture/source-policy/account.json')
    await connection.close()
  })
  it("keeps each Atum account's ChatGPT sign-in to itself and never reaches the person's Codex CLI", async () => {
    childFixture()
    vi.stubEnv('CODEX_HOME', `${os.homedir()}/.codex`)
    vi.stubEnv('HERMES_CODEX_SHARED_AUTH_DIR', '/somewhere/shared')
    const connection = await openMatrixHermes(config, input(controller()))
    const env = mocks.spawn.mock.calls.at(-1)![2].env as NodeJS.ProcessEnv
    const own = matrixAccountCodexScope(config, 'owner')
    expect(env.HERMES_CODEX_SHARED_AUTH_DIR).toBe(own.authDir)
    expect(env.CODEX_HOME).toBe(own.codexHome)
    expect(own.authDir.startsWith('/fixture/profiles/accounts/')).toBe(true)
    // Another account on this Mac has its own folder; the person's ~/.codex is never one.
    expect(matrixAccountCodexScope(config, 'someone-else').authDir).not.toBe(own.authDir)
    expect(JSON.stringify(own)).not.toContain('.codex')
    expect(env.CODEX_HOME).not.toContain(`${os.homedir()}/.codex`)
    await connection.close()
  })
  it("never lets a stale shell export choose a one-account Mac's ChatGPT store", async () => {
    childFixture()
    vi.stubEnv('HERMES_CODEX_SHARED_AUTH_DIR', '/stale/codex-shared')
    vi.stubEnv('HERMES_SHARED_AUTH_DIR', '/stale/shared')
    const connection = await openMatrixHermes(config, { ...input(controller()), sharedCodex: true })
    const env = mocks.spawn.mock.calls.at(-1)![2].env as NodeJS.ProcessEnv
    // No override for the one account, and nothing the shell said: Hermes's own shared folder.
    expect(env.HERMES_CODEX_SHARED_AUTH_DIR).toBeUndefined()
    expect(env.HERMES_SHARED_AUTH_DIR).toBeUndefined()
    await connection.close()
    vi.unstubAllEnvs()
  })
  it("passes the person's environment except the app's own wiring, with the old app's PATH", () => {
    const venv = { ...config, python: '/fixture/venv/bin/python' }

    const env = matrixHermesEnvironment(venv, '/fixture/profiles/p', '/home/owner', {
      PATH: '/usr/bin:/bin',
      LANG: 'vi_VN.UTF-8',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      HERMES_MODEL: 'the-owners-choice',
      ATUM_BUNDLED_PETS_DIR: '/pets',
      PYTHONHOME: '/other/python',
      ATUM_FILESYSTEM_CAPABILITY_REQUIRED: '1',
      ATUM_MANAGED_MODEL_PROXY_TOKEN: 'old-app-proxy',
      HERMES_DASHBOARD_SESSION_TOKEN: 'someone-elses',
      HERMES_DESKTOP_READY_FILE: '/tmp/ready',
      MATRIX_HOME_ROOM: '!elsewhere:example',
      HERMES_DESKTOP_CRON: '1',
      HERMES_DESKTOP_CRON_HOLD: '/tmp/someone-elses-hold'
    })

    // The person's own settings pass, as in the old app.
    expect(env).toMatchObject({
      LANG: 'vi_VN.UTF-8',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      HERMES_MODEL: 'the-owners-choice',
      ATUM_BUNDLED_PETS_DIR: '/pets'
    })

    // Only the named wiring is held back.
    for (const key of [
      'PYTHONHOME',
      'ATUM_FILESYSTEM_CAPABILITY_REQUIRED',
      'ATUM_MANAGED_MODEL_PROXY_TOKEN',
      'HERMES_DASHBOARD_SESSION_TOKEN',
      'HERMES_DESKTOP_READY_FILE',
      'MATRIX_HOME_ROOM',
      'HERMES_DESKTOP_CRON',
      'HERMES_DESKTOP_CRON_HOLD'
    ]) {
      expect(env[key], key).toBeUndefined()
    }

    // Hermes's managed Node and the interpreter first, the person's PATH, then Homebrew and
    // the system folders a Finder launch lacks (backend-env.ts).
    const entries = env.PATH!.split(':')
    expect(entries.slice(0, 2)).toEqual(['/fixture/profiles/p/node/bin', '/fixture/venv/bin'])
    expect(entries).toEqual(expect.arrayContaining(['/usr/bin', '/bin', '/opt/homebrew/bin', '/usr/local/bin']))
    expect(entries.indexOf('/usr/bin')).toBeLessThan(entries.indexOf('/opt/homebrew/bin'))
  })
  it("never lets the person's shell grant Google tools or set the Google fence; only main's launch does", () => {
    const env = matrixHermesEnvironment(config, '/fixture/profiles/p', '/home/owner', {
      PATH: '/usr/bin',
      ATUM_GOOGLE_TOOLS_URL: 'http://127.0.0.1:1/',
      ATUM_GOOGLE_TOOLS_TOKEN: 'f'.repeat(64),
      ATUM_GOOGLE_FENCE_ROUTE: 'http://127.0.0.1:2/v1',
      ATUM_GOOGLE_LATCHED: '0'
    })

    expect(Object.keys(env).filter(key => key.startsWith('ATUM_GOOGLE_'))).toEqual([])
    expect(matrixGoogleHermesEnvironment({})).toEqual({})
    expect(matrixGoogleHermesEnvironment({ fence: 'http://127.0.0.1:43123/v1' })).toEqual({
      ATUM_GOOGLE_FENCE_ROUTE: 'http://127.0.0.1:43123/v1'
    })
    // The protected path still ignores tools without its fence.
    expect(matrixGoogleHermesEnvironment({ tools: { url: 'http://127.0.0.1:5', key: 'k' } })).toEqual({})
    expect(matrixGoogleHermesEnvironment({ latched: true })).toEqual({})
    expect(matrixGoogleHermesEnvironment({ fence: 'http://127.0.0.1:43123/v1', latched: true })).toEqual({
      ATUM_GOOGLE_FENCE_ROUTE: 'http://127.0.0.1:43123/v1',
      ATUM_GOOGLE_LATCHED: '1'
    })
    expect(
      matrixGoogleHermesEnvironment({
        fence: 'http://127.0.0.1:43123/v1',
        tools: { url: 'http://127.0.0.1:5', key: 'k' }
      })
    ).toEqual({
      ATUM_GOOGLE_FENCE_ROUTE: 'http://127.0.0.1:43123/v1',
      ATUM_GOOGLE_TOOLS_URL: 'http://127.0.0.1:5',
      ATUM_GOOGLE_TOOLS_TOKEN: 'k'
    })
    // Full power has one explicit tools-without-fence path; even a supplied latch cannot leak
    // either protected-path marker into that launch.
    expect(
      matrixGoogleHermesEnvironment({
        latched: true,
        unfencedTools: { url: 'http://127.0.0.1:6', key: 'full-power' }
      })
    ).toEqual({
      ATUM_GOOGLE_TOOLS_URL: 'http://127.0.0.1:6',
      ATUM_GOOGLE_TOOLS_TOKEN: 'full-power'
    })
  })
  it("posts scheduled jobs to the agent's room, and runs them only where the launch says so", () => {
    expect(matrixHermesJobsEnvironment({ homeRoom: '!alfred:atum.test', runJobs: true })).toEqual({
      HERMES_DESKTOP_CRON: '1',
      MATRIX_HOME_ROOM: '!alfred:atum.test'
    })
    expect(matrixHermesJobsEnvironment({ runJobs: false })).toEqual({ HERMES_DESKTOP_CRON: '0' })
    expect(matrixHermesJobsEnvironment({ homeRoom: 'not-a-room', runJobs: true })).toEqual({ HERMES_DESKTOP_CRON: '1' })
  })
  it('has no cron ticker unless the launch asks for it, so an unaware launch cannot fire the agent\'s jobs', () => {
    expect(matrixHermesJobsEnvironment({})).toEqual({ HERMES_DESKTOP_CRON: '0' })
    expect(matrixHermesJobsEnvironment({ homeRoom: '!alfred:atum.test' })).toEqual({
      HERMES_DESKTOP_CRON: '0',
      MATRIX_HOME_ROOM: '!alfred:atum.test'
    })
  })
  it("names the host's hold marker for the ticker only when it is an absolute path", () => {
    expect(matrixHermesJobsEnvironment({ runJobs: true, cronHold: '/fixture/holds/agent' })).toEqual({
      HERMES_DESKTOP_CRON: '1',
      HERMES_DESKTOP_CRON_HOLD: '/fixture/holds/agent'
    })
    expect(matrixHermesJobsEnvironment({ runJobs: true, cronHold: 'holds/agent' })).toEqual({ HERMES_DESKTOP_CRON: '1' })
    expect(matrixHermesJobsEnvironment({ runJobs: true })).toEqual({ HERMES_DESKTOP_CRON: '1' })
  })
  describe('which Hermes processes run the agent\'s cron ticker', () => {
    const tick = (index = 0) => {
      const env = mocks.spawn.mock.calls[index]![2].env as NodeJS.ProcessEnv

      return { cron: env.HERMES_DESKTOP_CRON, hold: env.HERMES_DESKTOP_CRON_HOLD, desktop: env.HERMES_DESKTOP }
    }

    it('never starts the ticker in a short-lived backend (setup, a model check, a sign-in, a pet), whatever the shell exports', async () => {
      vi.stubEnv('HERMES_DESKTOP_CRON', '1')
      vi.stubEnv('HERMES_DESKTOP_CRON_HOLD', '/tmp/someone-elses-hold')
      childFixture()
      const abort = controller()

      await withMatrixHermes(
        config,
        { owner: 'owner', executorId: 'executor', signal: abort.signal, sharedCodex: true },
        async () => {}
      )

      // The standby Mac's hold marker cannot reach this process, so it must not tick at all.
      expect(tick()).toEqual({ cron: '0', hold: undefined, desktop: '1' })
    })
    it('does not let a caller that widens the short-lived input turn the ticker back on', async () => {
      childFixture()
      const abort = controller()

      const widened = {
        owner: 'owner',
        executorId: 'executor',
        signal: abort.signal,
        runJobs: true,
        cronHold: '/fixture/holds/agent'
      }

      await withMatrixHermes(config, widened, async () => {})

      expect(tick()).toEqual({ cron: '0', hold: undefined, desktop: '1' })
    })
    it("starts it only in the assistant's own launch, with the host's hold marker", async () => {
      childFixture()
      const abort = controller()
      const base = { owner: 'owner', executorId: 'executor', signal: abort.signal }

      const own = await openMatrixHermes(config, { ...base, runJobs: true, cronHold: '/fixture/holds/agent' })
      await own.close()
      expect(tick(0)).toEqual({ cron: '1', hold: '/fixture/holds/agent', desktop: '1' })

      // A Mac that does not run the agent's jobs, and a caller that does not say, have none.
      childFixture()
      const off = await openMatrixHermes(config, { ...base, runJobs: false, cronHold: '/fixture/holds/agent' })
      await off.close()
      childFixture()
      const silent = await openMatrixHermes(config, base)
      await silent.close()
      expect(tick(1).cron).toBe('0')
      expect(tick(2).cron).toBe('0')
    })
    it('executes a turn without a ticker too', async () => {
      childFixture()
      await executeMatrixHermes(config, input(controller()))
      expect(tick().cron).toBe('0')
    })
  })
  it('starts in Workspace, an explicit project, or the home if the Atum parent is blocked', async () => {
    expect(matrixHermesWorkspace({}, '/home/example')).toBe('/home/example/Atum/Workspace')
    expect(matrixHermesWorkspace({ HERMES_DESKTOP_CWD: '/home/example/Projects' }, '/home/example')).toBe(
      '/home/example/Projects'
    )
    expect(matrixHermesWorkspace({ HERMES_DESKTOP_CWD: 'relative/path' }, '/home/example')).toBe(
      '/home/example/Atum/Workspace'
    )
    mocks.lstat.mockImplementationOnce(() => ({ isDirectory: () => false, isSymbolicLink: () => false }))
    childFixture()
    await executeMatrixHermes(config, input(controller()))
    expect(mocks.spawn.mock.calls.at(-1)![2].cwd).toBe(os.homedir())
  })
  it("gives a packaged build's Hermes the bundled browser and shared sign-ins, per profile", () => {
    const bundled = {
      browserBin: '/app/browser/bin',
      nodeBin: '/app/node/bin',
      chromium: '/app/chromium',
      toolBins: ['/app/tools/uv/bin'],
      sharedAuthDir: '/shared'
    }

    const env = matrixHermesEnvironment({ ...config, bundled }, '/fixture/profiles/p', '/home/owner', {
      PATH: '/usr/bin',
      AGENT_BROWSER_ARGS: '--steer'
    })

    // The bundle's browser, node (with npm/npx) and uv/uvx come before the person's PATH.
    expect(env.PATH!.split(':').slice(0, 3)).toEqual(['/app/browser/bin', '/app/node/bin', '/app/tools/uv/bin'])
    expect(env.PATH!.split(':')).toContain('/usr/bin')
    // Global npm installs land in the profile, never inside the signed app, and are on PATH.
    expect(env.NPM_CONFIG_PREFIX).toBe('/fixture/profiles/p/desktop-runtime/npm-global')
    expect(env.PATH!.split(':')).toContain('/fixture/profiles/p/desktop-runtime/npm-global/bin')
    expect(env).toMatchObject({
      AGENT_BROWSER_EXECUTABLE_PATH: '/app/chromium',
      AGENT_BROWSER_HOME: '/fixture/profiles/p/desktop-runtime/agent-browser',
      PLAYWRIGHT_BROWSERS_PATH: '/fixture/profiles/p/desktop-runtime/browser-cache',
      HERMES_SHARED_AUTH_DIR: '/shared'
    })
    // Steering the bundled browser from outside is refused, as the old app does.
    expect(env.AGENT_BROWSER_ARGS).toBeUndefined()

    // Without a bundle (development) nothing browser-specific is added.
    const plain = matrixHermesEnvironment(config, '/p', '/home/owner', {
      PATH: '/usr/bin',
      AGENT_BROWSER_ARGS: 'dev',
      HERMES_SHARED_AUTH_DIR: '/owners/override'
    })

    expect(plain.PATH!.split(':')).not.toContain('/app/browser/bin')
    expect(plain.NPM_CONFIG_PREFIX).toBeUndefined()
    expect(plain.AGENT_BROWSER_ARGS).toBe('dev')
    expect(plain.AGENT_BROWSER_EXECUTABLE_PATH).toBeUndefined()
    // Where sign-ins are shared is the launch's to decide, never the shell's (0.18.4): with no
    // bundled pin, Hermes's own default.
    expect(plain.HERMES_SHARED_AUTH_DIR).toBeUndefined()
  })
  it('aborts a starting runtime without ever dispatching a turn', async () => {
    const child = childFixture()
    mocks.ready.mockImplementation(
      () => new Promise((_resolve, reject) => child.once('exit', () => reject(new Error('stopped'))))
    )
    const abort = controller()
    const pending = executeMatrixHermes(config, input(abort))
    abort.abort()
    await expect(pending).rejects.toThrow('stopped')
    expect(mocks.turn).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
  it('escalates only its own unresponsive child and waits for exit', async () => {
    vi.useFakeTimers()
    const child = childFixture(false)
    const pending = executeMatrixHermes(config, input(controller()))
    await vi.advanceTimersByTimeAsync(0)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(2000)
    await pending
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
  it('missing explicit configuration never spawns a fallback runtime', async () => {
    mocks.read.mockImplementation(() => {
      throw new Error('missing profile')
    })
    await expect(executeMatrixHermes(config, input(controller()))).rejects.toThrow('missing profile')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})

it('the actual runtime cannot spawn until the shared startup barrier settles', async () => {
  let release!: () => void

  const barrier = new Promise<void>(resolve => {
    release = resolve
  })

  childFixture()
  const connection = openMatrixHermes({ ...config, beforeOpen: () => barrier }, input(controller()))
  await Promise.resolve()
  expect(mocks.spawn).not.toHaveBeenCalled()
  release()
  const opened = await connection
  expect(mocks.spawn.mock.calls[0][2].cwd).toBe(matrixHermesWorkspace())
  await opened.close()
})

it('cancellation while startup is pending cannot spawn a runtime after the barrier opens', async () => {
  let release!: () => void

  const barrier = new Promise<void>(resolve => {
    release = resolve
  })

  const abort = controller()
  const connection = openMatrixHermes({ ...config, beforeOpen: () => barrier }, input(abort))
  abort.abort()
  await expect(connection).rejects.toThrow()
  expect(mocks.spawn).not.toHaveBeenCalled()
  release()
})

it('native home binds runtime cwd, terminal cwd and the old default without trusting the shell home', async () => {
  childFixture()
  const workspaceHome = '/native/owned-home'
  const opened = await openMatrixHermes({ ...config, workspaceHome }, input(controller()))
  const options = mocks.spawn.mock.calls[0][2]
  expect(options.cwd).toBe(`${workspaceHome}/Atum/Workspace`)
  expect(options.env.TERMINAL_CWD).toBe(options.cwd)
  expect(opened.legacyWorkspace).toBe(`${workspaceHome}/Atum`)
  await opened.close()
})

it('unreadable protected roots reject the actual open path before any process or mkdir', async () => {
  const knownDriveRoots = () => {
    throw new Error('workspace_layout_deferred')
  }

  await expect(openMatrixHermes({ ...config, knownDriveRoots }, input(controller()))).rejects.toThrow(
    'workspace_layout_deferred'
  )
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(mocks.mkdir).not.toHaveBeenCalled()
})

it('a development JSON file cannot inject native workspace facts or startup callbacks', () => {
  mocks.read.mockReturnValue(JSON.stringify({ ...config, workspaceHome: '/untrusted/home', knownDriveRoots: [], beforeOpen: 'bypass' }))
  expect(readMatrixHermesRuntime('/fixture/runtime.json')).toEqual(config)
})
