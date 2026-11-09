import type { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { b64uSha256 } from './canonical'
import type { DeviceExecutorContext, ProgressOrReceipt, VerifiedExecute } from './contracts'
import { artifactName, constrainedHostEnv, DeviceHostSupervisor, HostDeviceExecutor, SANDBOX_HINT } from './host'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) {rmSync(directory, { recursive: true, force: true })} })
const proxyToken = 'synthetic_test_proxy_token_0123456789'

describe('constrainedHostEnv', () => {
  it('sets the egress proxy, the ssh ProxyCommand and the host home, and never leaks agent secrets', () => {
    const env = constrainedHostEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/fixture',
        SSH_AUTH_SOCK: '/private/tmp/agent.sock',
        AWS_ACCESS_KEY_ID: 'AKIA',
        GH_TOKEN: 'ghp_x',
        NODE_OPTIONS: '--inspect',
        PYTHONPATH: '/elsewhere'
      },
      51515,
      proxyToken,
      '/Users/fixture/Library/Application Support/Atum/device/host-home',
      '/trusted/git-template'
    )

    expect(env.HTTPS_PROXY).toBe(`http://srt:${proxyToken}@127.0.0.1:51515`)
    expect(env.ALL_PROXY).toBe(env.HTTPS_PROXY)
    expect(env.GIT_SSH_COMMAND).toContain('ProxyCommand')
    expect(env.GIT_SSH_COMMAND).toMatch(/^\/usr\/bin\/ssh /)
    expect(env.GIT_SSH_COMMAND).not.toContain(proxyToken)
    expect(env.ATUM_DEVICE_PROXY_TOKEN).toBe(proxyToken)
    expect(env.GIT_TEMPLATE_DIR).toBe('/trusted/git-template')
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('http.proxyAuthMethod')
    expect(env.GIT_CONFIG_VALUE_0).toBe('basic')
    expect(env.HERMES_HOME).toBe('/Users/fixture/Library/Application Support/Atum/device/host-home')

    for (const secret of ['SSH_AUTH_SOCK', 'AWS_ACCESS_KEY_ID', 'GH_TOKEN', 'NODE_OPTIONS', 'PYTHONPATH']) {
      expect(env[secret], secret).toBeUndefined()
    }
  })
})

/** A fake child process whose stdin captures frames and whose stdout we can push onto. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: (f: string, cb?: (e?: Error) => void) => void }
    stdout: EventEmitter & { setEncoding: () => void }
    stderr: EventEmitter & { resume: () => void }
    pid: number
  }

  const writes: string[] = []
  child.stdin = {
    write(frame, cb) {
      writes.push(frame)
      cb?.()
    }
  }
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} })
  child.stderr = Object.assign(new EventEmitter(), { resume: () => {} })
  child.pid = 4242

  const say = (message: Record<string, unknown>) => child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

  return { child, writes, say }
}

function supervisor(over: Partial<ConstructorParameters<typeof DeviceHostSupervisor>[0]> = {}) {
  const hostHome = mkdtempSync(path.join(os.tmpdir(), 'atum-device-host-'))
  directories.push(hostHome)
  const { child, writes, say } = fakeChild()
  const spawn = vi.fn(() => child) as unknown as typeof nodeSpawn
  const killed: number[] = []

  const sup = new DeviceHostSupervisor({
    launcherPath: '/res/atum-disclaim-launcher',
    pythonPath: '/res/python',
    hermesRoot: '/res/hermes',
    hostHome,
    egressProxyPort: 51515,
    egressProxyToken: proxyToken,
    home: '/Users/fixture',
    runtimeRoots: { userData: '/Users/fixture/Library/Application Support/Atum', driveRoot: null, agentWorkingRoots: [] },
    cuaDriverSocket: '/Users/fixture/Library/Caches/cua-driver/cua-driver.sock',
    sshAuthSock: () => '/private/tmp/com.apple.launchd.x/Listeners',
    spawn,
    killGroup: pgid => void killed.push(pgid),
    ...over
  })

  const last = () => JSON.parse(writes[writes.length - 1])

  return { sup, child, writes, say, spawn, killed, last, hostHome }
}

describe('DeviceHostSupervisor', () => {
  it('spawns the host through the disclaim launcher, in its own group, with the constrained env', () => {
    const { sup, spawn, hostHome } = supervisor()
    sup.start()
    const [program, args, options] = (spawn as unknown as { mock: { calls: [string, string[], { detached: boolean; env: NodeJS.ProcessEnv }][] } }).mock.calls[0]
    expect(program).toBe('/res/atum-disclaim-launcher')
    expect(args).toEqual(['--disclaim', '1', '--', '/res/python', '-m', 'hermes_cli.atum_device_host'])
    expect(options.detached).toBe(true)
    expect(options.env.HERMES_HOME).toBe(hostHome)
    expect(readdirSync(options.env.GIT_TEMPLATE_DIR!)).toEqual([])
    expect(options.env.SSH_AUTH_SOCK).toBeUndefined()
  })

  it('hands the SSH agent socket only to a command whose grant covers ssh_agent, with the lifted profile', () => {
    const { sup, last } = supervisor()
    void sup.exec({ commandId: 'c1', tool: 'terminal', args: { command: 'echo hi' }, cwd: '/Users/fixture', timeoutMs: 60_000, relax: [] })
    expect(last().params.env).toBeUndefined()
    expect(last().params.profile).toContain('(deny file-read* file-write* (subpath "/Users/fixture/.ssh"))')

    void sup.exec({ commandId: 'c2', tool: 'terminal', args: { command: 'ssh -T git@github.com' }, cwd: '/Users/fixture', timeoutMs: 60_000, relax: ['ssh_agent'] })
    expect(last().params.env).toEqual({ SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.x/Listeners' })
    expect(last().params.profile).toContain('(deny file-read* file-write* (subpath "/Users/fixture/.ssh"))')
  })

  it("every command's profile is the owner's default-open one: startup files, git config and downloaded programs, with secrets still closed", () => {
    const { sup, last } = supervisor()
    void sup.exec({ commandId: 'c1', tool: 'terminal', args: { command: 'git clone x' }, cwd: '/Users/fixture', timeoutMs: 60_000, relax: [] })
    const profile = last().params.profile as string

    expect(profile).not.toContain('(deny file-write* (subpath "/Users/fixture/.gitconfig"))')
    expect(profile).not.toContain('(deny file-write* (subpath "/Users/fixture/.zshrc"))')
    expect(profile).not.toContain('(deny process-exec* (subpath "/Users/fixture/Downloads"))')
    expect(profile).toContain('(deny file-read* file-write* (subpath "/Users/fixture/.ssh"))')
    expect(profile).toContain('(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))')
  })

  it('exec round-trips over JSON-RPC', async () => {
    const { sup, say, last } = supervisor()
    const promise = sup.exec({ commandId: 'c1', tool: 'terminal', args: { command: 'echo hi' }, cwd: '/Users/fixture', timeoutMs: 60_000, relax: [] })
    expect(last().method).toBe('device.exec')
    say({ id: last().id, result: { state: 'completed', result: { exit_code: 0 } } })
    await expect(promise).resolves.toMatchObject({ state: 'completed' })
  })

  it('kills a command’s reported process groups itself, synchronously, without waiting on the host', () => {
    const { sup, say, killed, last } = supervisor()
    sup.start()
    say({ method: 'device.ready', params: { pid: 5000 } })
    say({ method: 'device.spawned', params: { commandId: 'c1', pgid: 7001 } })
    say({ method: 'device.spawned', params: { commandId: 'c1', pgid: 7002 } })
    say({ method: 'device.spawned', params: { commandId: 'c2', pgid: 7003 } })

    expect(sup.ownedProcessGroups().sort()).toEqual([7001, 7002, 7003])
    sup.killCommand('c1')
    expect(killed).toEqual([7001, 7002])
    // ... and the host is told too, best effort.
    expect(last()).toMatchObject({ method: 'device.stop', params: { commandId: 'c1' } })

    sup.killAll()
    expect(killed).toEqual([7001, 7002, 7001, 7002, 7003])
  })

  it('answers the host’s GUI authorization request through the broker', async () => {
    const authorizeGui = vi.fn(async () => ({ allow: false as const, reason: 'security_ui' as const }))
    const { sup, say, writes } = supervisor({ authorizeGui })
    sup.start()
    say({ id: 'h1', method: 'device.gui_authorize', params: { commandId: 'c1', action: 'click', target: { pid: 9 } } })
    await vi.waitFor(() => expect(writes.some(line => JSON.parse(line).id === 'h1')).toBe(true))
    expect(authorizeGui).toHaveBeenCalledWith({ commandId: 'c1', action: 'click', target: { pid: 9 } })
    expect(JSON.parse(writes.find(line => JSON.parse(line).id === 'h1')!)).toEqual({ jsonrpc: '2.0', id: 'h1', result: { allow: false, reason: 'security_ui' } })
  })

  it('after a Stop, sweeps everything the host is responsible for, then starts a fresh host', async () => {
    const sweepResponsible = vi.fn(async () => [8001, 8002])
    const { sup, say, spawn } = supervisor({ sweepResponsible })
    sup.start()
    say({ method: 'device.ready', params: { pid: 5000 } })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      expect(await sup.sweepAndRestart()).toEqual([8001, 8002])
      expect(sweepResponsible).toHaveBeenCalledWith(5000)
      expect(kill).toHaveBeenCalledWith(5000, 'SIGKILL')
    } finally {
      kill.mockRestore()
    }

    sup.start()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('cannot start a host while the responsibility proof is pending, and propagates failure', async () => {
    let finish!: () => void
    const quiesceResponsible = vi.fn(() => new Promise<void>(resolve => {finish = resolve}))
    const { sup, say, spawn } = supervisor({ quiesceResponsible })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      sup.start()
      say({ method: 'device.ready', params: { pid: 5000 } })
      const pending = sup.quiesce()
      expect(sup.quiesce()).toBe(pending)
      expect(() => sup.start()).toThrow('device_host_collecting')
      finish()
      await pending
      sup.start()
      expect(spawn).toHaveBeenCalledTimes(2)
      say({ method: 'device.ready', params: { pid: 5001 } })
      quiesceResponsible.mockImplementation(async () => {throw new Error('proof failed')})
      await expect(sup.quiesce()).rejects.toThrow('proof failed')
      sup.start()
      expect(spawn).toHaveBeenCalledTimes(3)
    } finally {kill.mockRestore()}
  })
})

describe('HostDeviceExecutor', () => {
  let artifactsDir = ''

  afterEach(() => {
    if (artifactsDir) {
      rmSync(artifactsDir, { recursive: true, force: true })
      artifactsDir = ''
    }
  })

  const command = (over: Partial<VerifiedExecute> = {}): VerifiedExecute => ({
    commandId: '00000000-0000-4000-8000-38e4e4acfa60',
    grantId: 'g1',
    seq: 1,
    tool: 'terminal',
    args: { command: 'echo hi' },
    argsHash: 'x',
    inputManifestHash: null,
    needs: [],
    proposedEffect: 'ordinary',
    timeoutMs: 60_000,
    ...over
  })

  function context(controller = new AbortController(), paused = false): DeviceExecutorContext {
    return { grant: { agentUserId: '@t:x' } as never, paused: () => paused, signal: controller.signal }
  }

  async function collect(iterable: AsyncIterable<ProgressOrReceipt>) {
    const out: ProgressOrReceipt[] = []

    for await (const each of iterable) {
      out.push(each)
    }

    return out
  }

  function stubSupervisor(over: Record<string, unknown> = {}) {
    return {
      exec: vi.fn(async () => ({ state: 'completed', result: { output: 'hi', exit_code: 0 } })),
      releaseGui: vi.fn(),
      computerUse: vi.fn(async () => ({ state: 'completed', result: { ok: true } })),
      readArtifact: vi.fn(),
      killCommand: vi.fn(),
      forget: vi.fn(),
      ...over
    }
  }

  it('returns the Hermes tool result as data, with the exit code', async () => {
    const sup = stubSupervisor()
    const [receipt] = await collect(new HostDeviceExecutor(sup as never, { artifactsDir: '/tmp' }).run(command(), context()))
    expect(receipt).toMatchObject({ kind: 'receipt', state: 'completed', result: { exitCode: 0, data: { output: 'hi', exit_code: 0 } } })
  })

  it('never starts a command after Stop while its working copy is being prepared', async () => {
    const controller = new AbortController()
    let ready!: (cwd: string) => void
    const sup = stubSupervisor()

    const executor = new HostDeviceExecutor(sup as never, {
      artifactsDir: '/tmp', cwdFor: () => new Promise<string>(resolve => {ready = resolve})
    })

    const pending = collect(executor.run(command(), context(controller)))
    await vi.waitFor(() => expect(ready).toBeTypeOf('function'))
    controller.abort()
    ready('/Users/fixture/Atum Tasks/T/task')
    expect(await pending).toMatchObject([{ state: 'failed_no_effect' }])
    expect(sup.exec).not.toHaveBeenCalled()
    expect(sup.computerUse).not.toHaveBeenCalled()
  })

  it('tells the brain to retry with `needs` when the sandbox blocked the command', async () => {
    const sup = stubSupervisor({ exec: vi.fn(async () => ({ state: 'completed', result: { output: 'cat: /Users/fixture/.ssh/id_ed25519: Operation not permitted', exit_code: 1 } })) })
    const [receipt] = await collect(new HostDeviceExecutor(sup as never, { artifactsDir: '/tmp' }).run(command(), context()))
    expect((receipt as { result: { data: { device_note: string } } }).result.data.device_note).toBe(SANDBOX_HINT)
  })

  it('signals a protected-folder denial from a cloud-routed Mac without changing the receipt', async () => {
    const denied = vi.fn()
    const result = { error: "EPERM: operation not permitted, open '/Users/fixture/Downloads/brief.pdf'" }
    const sup = stubSupervisor({ exec: vi.fn(async () => ({ state: 'failed_no_effect', result })) })

    const [receipt] = await collect(
      new HostDeviceExecutor(sup as never, { artifactsDir: '/tmp', onProtectedFolderDenied: denied }).run(
        command({ tool: 'read_file', args: { path: '/Users/fixture/Downloads/brief.pdf' } }),
        context()
      )
    )

    expect(denied).toHaveBeenCalledOnce()
    expect(receipt).toMatchObject({ state: 'failed_no_effect', result: { data: result } })
  })

  it('a Stop during the command kills its groups at once and reports unknown, never completed', async () => {
    const controller = new AbortController()
    let finish!: () => void

    const sup = stubSupervisor({
      exec: vi.fn(
        () =>
          new Promise(resolve => {
            finish = () => resolve({ state: 'completed', result: { output: '', exit_code: -9 } })
          })
      )
    })

    const pending = collect(new HostDeviceExecutor(sup as never, { artifactsDir: '/tmp' }).run(command(), context(controller)))
    await vi.waitFor(() => expect(sup.exec).toHaveBeenCalled())
    controller.abort()
    expect(sup.killCommand).toHaveBeenCalledWith(command().commandId)
    finish()
    const [receipt] = await pending
    expect(receipt).toMatchObject({ state: 'unknown' })
  })

  it('an aborted turn runs nothing; a host that dies mid-command is unknown', async () => {
    const controller = new AbortController()
    controller.abort()
    const idle = stubSupervisor()
    expect((await collect(new HostDeviceExecutor(idle as never, { artifactsDir: '/tmp' }).run(command(), context(controller))))[0]).toMatchObject({ state: 'failed_no_effect' })
    expect(idle.exec).not.toHaveBeenCalled()

    const dying = stubSupervisor({ exec: vi.fn(async () => Promise.reject(new Error('device_host_exited'))) })
    expect((await collect(new HostDeviceExecutor(dying as never, { artifactsDir: '/tmp' }).run(command(), context())))[0]).toMatchObject({ state: 'unknown' })
  })

  it('releases the host GUI session when its grant ends', () => {
    const sup = stubSupervisor()
    new HostDeviceExecutor(sup as never, { artifactsDir: '/tmp' }).releaseGrant('g1')
    expect(sup.releaseGui).toHaveBeenCalledWith('g1')
  })

  it('computer_use goes to the host (behind the broker) and is refused while an approval sheet is up', async () => {
    const sup = stubSupervisor()
    const executor = new HostDeviceExecutor(sup as never, { artifactsDir: '/tmp' })
    const gui = command({ tool: 'computer_use', args: { action: 'click', element: 2 } })

    expect((await collect(executor.run(gui, context())))[0]).toMatchObject({ state: 'completed' })
    expect(sup.computerUse).toHaveBeenCalledWith({ grantId: gui.grantId, commandId: gui.commandId, args: gui.args, timeoutMs: gui.timeoutMs })

    expect((await collect(executor.run(gui, context(new AbortController(), true))))[0]).toMatchObject({ state: 'failed_no_effect' })
    expect(sup.computerUse).toHaveBeenCalledTimes(1)
  })

  it('send_file: the bytes the host read inside the profile become one hashed artifact', async () => {
    artifactsDir = mkdtempSync(path.join(os.tmpdir(), 'atum-artifacts-'))

    const sup = stubSupervisor({
      readArtifact: vi.fn(async (input: { dest: string }) => {
        writeFileSync(input.dest, 'hello world')

        return { state: 'completed', size: 11, name: 'hello.txt' }
      })
    })

    const send = command({ tool: 'send_file', args: { path: '~/Desktop/s1-demo/hello.txt' } })
    const [receipt] = await collect(new HostDeviceExecutor(sup as never, { artifactsDir }).run(send, context()))

    expect(receipt).toMatchObject({
      state: 'completed',
      result: { data: { name: 'hello.txt' } },
      artifacts: [{ name: 'hello.txt', size: 11, sha256: b64uSha256('hello world'), path: path.join(artifactsDir, send.commandId, 'hello.txt') }]
    })
  })

  it('send_file of a protected, missing or oversized file has no effect and leaves nothing behind', async () => {
    artifactsDir = mkdtempSync(path.join(os.tmpdir(), 'atum-artifacts-'))

    for (const error of ['unreadable', 'too_large']) {
      const sup = stubSupervisor({ readArtifact: vi.fn(async () => ({ state: 'failed_no_effect', error })) })
      const send = command({ tool: 'send_file', args: { path: '~/.ssh/id_ed25519' }, commandId: `0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4${error.length % 10}` })
      const [receipt] = await collect(new HostDeviceExecutor(sup as never, { artifactsDir }).run(send, context()))
      expect(receipt).toMatchObject({ state: 'failed_no_effect', artifacts: [] })
    }

    expect(readdirSync(artifactsDir)).toEqual([])
  })

  it('artifact names carry no path and no control characters', () => {
    expect(artifactName('~/Desktop/s1-demo/hello.txt')).toBe('hello.txt')
    expect(artifactName('/tmp/a\u0007b.txt')).toBe('a_b.txt')
    expect(artifactName('/')).toBe('file')
  })
})

describe('HostDeviceExecutor sudo', () => {
  const sudoCommand: VerifiedExecute = {
    commandId: '00000000-0000-4000-8000-1c6c6d482d36',
    grantId: 'g1',
    seq: 1,
    tool: 'terminal',
    args: { command: 'sudo launchctl list' },
    argsHash: 'x',
    inputManifestHash: null,
    needs: ['sudo'],
    proposedEffect: 'sudo',
    timeoutMs: 60_000
  }

  const context = (): DeviceExecutorContext => ({ grant: {} as never, paused: () => false, signal: new AbortController().signal })

  it('a sudo command never goes to the sandboxed terminal: it takes the device-local sudo path', async () => {
    const supervisor = { exec: vi.fn(), killCommand: vi.fn(), forget: vi.fn() }
    const runSudo = vi.fn(async () => ({ state: 'completed' as const, result: { output: 'ok', exit_code: 0 } }))
    const receipts: ProgressOrReceipt[] = []

    for await (const each of new HostDeviceExecutor(supervisor as never, { artifactsDir: '/tmp', runSudo }).run(sudoCommand, context())) {
      receipts.push(each)
    }

    expect(runSudo).toHaveBeenCalledWith(sudoCommand, expect.any(String))
    expect(supervisor.exec).not.toHaveBeenCalled()
    expect(receipts[0]).toMatchObject({ state: 'completed', result: { exitCode: 0 } })
  })

  it('without a sudo path, a sudo command has no effect', async () => {
    const supervisor = { exec: vi.fn(), killCommand: vi.fn(), forget: vi.fn() }
    const receipts: ProgressOrReceipt[] = []

    for await (const each of new HostDeviceExecutor(supervisor as never, { artifactsDir: '/tmp' }).run(sudoCommand, context())) {
      receipts.push(each)
    }

    expect(receipts[0]).toMatchObject({ state: 'failed_no_effect' })
    expect(supervisor.exec).not.toHaveBeenCalled()
  })
})
