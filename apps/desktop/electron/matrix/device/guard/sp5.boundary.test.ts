import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolveProtectedPaths } from '../protected-paths'

import { generateSeatbeltProfile, isDarwinUserTemporaryDirectory } from './profile'

const strict = process.env.ATUM_SEATBELT_PROOF === '1'

describe.skipIf(process.platform !== 'darwin')('SP-5 real Mac boundary regressions', () => {
  let root = ''
  let home = ''
  let daemon: Server
  let bystander: ReturnType<typeof spawn>

  const profile = (relax: Parameters<typeof generateSeatbeltProfile>[1]['relax'] = []) =>
    generateSeatbeltProfile(home, {
      paths: resolveProtectedPaths({
        home,
        runtime: { userData: `${home}/Atum[1]`, driveRoot: null, agentWorkingRoots: [] }
      }),
      runtime: {
        egressProxyPort: 50001,
        cuaDriverSocket: `${root}/daemon.sock`,
        sshAgentSocket: process.env.SSH_AUTH_SOCK
      },
      relax
    })

  const run = (script: string, relax: Parameters<typeof profile>[0] = []) =>
    spawnSync('/usr/bin/sandbox-exec', ['-p', profile(relax), '/bin/bash', '-c', script], {
      cwd: home,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'en_US.UTF-8' },
      encoding: 'utf8',
      timeout: 15000
    })

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atum-sp5-')))
    home = path.join(root, "home[1]*?'quote")

    for (const dir of ['.ssh', 'work/.git/hooks', 'Atum[1]', 'bin', 'Library/Preferences']) {
      mkdirSync(path.join(home, dir), { recursive: true })
    }

    writeFileSync(path.join(home, '.ssh', 'canary'), 'private-canary')
    daemon = createServer(socket => {
      socket.on('error', () => {})
      socket.end('daemon')
    })
    await new Promise<void>(resolve => daemon.listen(`${root}/daemon.sock`, resolve))
    bystander = spawn('/bin/sleep', ['180'], { stdio: 'ignore' })
  })
  afterAll(async () => {
    bystander?.kill('SIGKILL')

    if (daemon) {
      await new Promise<void>(resolve => daemon.close(() => resolve()))
    }

    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('denies a bracketed HOME secret while ordinary nested writes still work (#576)', () => {
    expect(run('cat "$HOME/.ssh/canary"').status).not.toBe(0)
    expect(run('printf useful > "$HOME/work/result"; cat "$HOME/work/result"').stdout).toBe('useful')
    expect(run('mv "$HOME/.ssh" "$HOME/work/renamed"').status).not.toBe(0)
    expect(readFileSync(path.join(home, '.ssh', 'canary'), 'utf8')).toBe('private-canary')
  })

  it('denies trust-handoff writes and renames until persistence is locally granted', () => {
    for (const target of ['.mcp.json', 'work/.git/hooks/pre-commit', 'work/.git/config', 'bin/next-command']) {
      const result = run(`printf planted > "$HOME/${target}"`)
      expect(result.status, target).not.toBe(0)
      expect(run(`printf approved > "$HOME/${target}"`, ['persistence']).status, target).toBe(0)
    }

    expect(run('mv "$HOME/work/.git" "$HOME/work/renamed-git"').status).not.toBe(0)
    expect(
      run('mkdir -p "$HOME/work/templates"; GIT_TEMPLATE_DIR="$HOME/work/templates" git init "$HOME/work/new-repo"', [
        'persistence'
      ]).status
    ).toBe(0)
  })

  it('pins every Drive root, keeps its engine state, and permits only this grant’s task copy besides the current Drive', () => {
    const drive = `${home}/parent/Drive`
    const second = `${home}/old-account/Drive`
    const tasks = `${home}/Atum Tasks`
    const own = `${tasks}/T/task`
    const other = `${tasks}/Other/task`

    for (const dir of [own, other, drive, second]) {mkdirSync(dir, { recursive: true })}
    writeFileSync(`${drive}/canary`, 'drive')
    writeFileSync(`${drive}/.atum-drive-journal.db`, 'journal')
    writeFileSync(`${second}/canary`, 'old drive')
    writeFileSync(`${other}/canary`, 'other agent')

    const sb = generateSeatbeltProfile(home, {
      paths: resolveProtectedPaths({ home, runtime: { userData: `${home}/Atum[1]`, driveRoot: drive,
        driveRoots: [drive, second], writableDriveRoots: [drive], agentWorkingRoots: [tasks] } }),
      runtime: { egressProxyPort: 50001, cuaDriverSocket: `${root}/daemon.sock`, ownWorkingRoot: own }
    })

    const execute = (argv: string[]) => spawnSync('/usr/bin/sandbox-exec', ['-p', sb, ...argv], { encoding: 'utf8' })
    expect(execute(['/bin/mv', `${home}/parent`, `${home}/moved-parent`]).status).not.toBe(0)
    const write = (file: string) => execute(['/bin/bash', '-c', 'echo useful > "$1"', '--', file])
    expect(write(`${own}/result`).status).toBe(0)

    // The owner's CURRENT Drive is written like their own folder; a past account's root stays denied.
    expect(write(`${drive}/canary`).status).toBe(0)
    for (const file of [`${second}/canary`, `${other}/canary`]) {expect(write(file).status, file).not.toBe(0)}
    expect(readFileSync(`${second}/canary`, 'utf8')).toBe('old drive')
    expect(write(`${drive}/.atum-drive-journal.db`).status).not.toBe(0)
    expect(execute(['/bin/rm', `${drive}/.atum-drive-journal.db`]).status).not.toBe(0)
    expect(execute(['/bin/mv', drive, `${drive}-moved`]).status).not.toBe(0)
    expect(execute(['/bin/cat', `${other}/canary`]).status).not.toBe(0)
    expect(execute(['/bin/mv', `${tasks}/T`, `${home}/moved-task`]).status).not.toBe(0)
    expect(execute(['/bin/cat', `${home}/.ssh/canary`]).status).not.toBe(0)
    expect(readFileSync(`${drive}/canary`, 'utf8')).toBe('useful\n')
    expect(readFileSync(`${drive}/.atum-drive-journal.db`, 'utf8')).toBe('journal')
  })

  it('with no Drive root, writes only to the own copy even with persistence approved', () => {
    const own = `${home}/Atum Tasks/T/read-only-fallback`
    mkdirSync(own, { recursive: true })

    const sb = generateSeatbeltProfile(home, {
      paths: resolveProtectedPaths({ home, runtime: { userData: `${home}/Atum[1]`, driveRoot: null, agentWorkingRoots: [`${home}/Atum Tasks`] } }),
      runtime: { egressProxyPort: 50001, cuaDriverSocket: `${root}/daemon.sock`, ownWorkingRoot: own, writeOutsideWorkingRoot: false },
      relax: ['persistence']
    })

    const execute = (file: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', sb, '/bin/bash', '-c', 'echo useful > "$1"', '--', file], { encoding: 'utf8' })
    expect(execute(`${own}/result`).status).toBe(0)
    expect(execute(`${home}/work/unknown-drive`).status).not.toBe(0)
    expect(execute(`${root}/outside-copy`).status).not.toBe(0)
  })

  it('refuses a task path swapped to another agent’s copy before profile generation', () => {
    const target = `${home}/Atum Tasks/Other/real`
    const swapped = `${home}/Atum Tasks/T/swapped`
    mkdirSync(target, { recursive: true })
    mkdirSync(path.dirname(swapped), { recursive: true })
    symlinkSync(target, swapped)
    expect(() => generateSeatbeltProfile(home, {
      paths: resolveProtectedPaths({ home, runtime: { userData: `${home}/Atum[1]`, driveRoot: null, agentWorkingRoots: [`${home}/Atum Tasks`] } }),
      runtime: { egressProxyPort: 50001, cuaDriverSocket: `${root}/daemon.sock`, ownWorkingRoot: swapped }
    })).toThrow('guard_working_copy_changed')
  })

  it('matches a /tmp protected path at its canonical /private/tmp location (#596)', () => {
    const dir = mkdtempSync('/private/tmp/atum-canonical-')
    const file = `${dir}/secret`
    writeFileSync(file, 'canary')

    try {
      const paths = resolveProtectedPaths({
        home,
        runtime: { userData: '/tmp' + dir.slice('/private/tmp'.length), driveRoot: null, agentWorkingRoots: [] }
      })

      const sb = generateSeatbeltProfile(home, {
        paths,
        runtime: { egressProxyPort: 50001, cuaDriverSocket: `${root}/daemon.sock` }
      })

      expect(spawnSync('/usr/bin/sandbox-exec', ['-p', sb, '/bin/cat', file]).status).not.toBe(0)
      expect(run(`printf ordinary > ${dir}/ordinary`).status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allows only the login session Darwin T root for ordinary temporary work, independent of TMPDIR', () => {
    const configuredTmpdir = process.env.TMPDIR
    process.env.TMPDIR = path.join(root, 'caller-selected-tmp')

    try {
      const reported = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).stdout.trim()
      const canonical = realpathSync.native(reported)
      expect(isDarwinUserTemporaryDirectory(reported)).toBe(true)

      const sb = profile()
      expect(sb).toContain(`(allow file-write* (subpath "${canonical}"))`)
      expect(sb).not.toContain(`(allow file-write* (subpath "${path.dirname(canonical)}"))`)
      expect(run('git --version >/dev/null && temp=$(mktemp -d) && rmdir "$temp"').status).toBe(0)
    } finally {
      if (configuredTmpdir === undefined) {
        delete process.env.TMPDIR
      } else {
        process.env.TMPDIR = configuredTmpdir
      }
    }
  })

  it('denies arbitrary Unix daemon sockets under all grants, not just known Docker/Cua paths', () => {
    const code = `import socket\ns=socket.socket(socket.AF_UNIX)\ns.connect(${JSON.stringify(`${root}/daemon.sock`)})`
    expect(spawnSync('/usr/bin/python3', ['-c', code]).status).toBe(0)

    const result = spawnSync(
      '/usr/bin/sandbox-exec',
      ['-p', profile(['ssh_agent', 'keychain', 'persistence', 'exec_downloaded']), '/usr/bin/python3', '-c', code],
      { encoding: 'utf8' }
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/Operation not permitted/)
  })

  it.each([2375, 2376, 9222, 9229, 9230])(
    'denies Docker/debugger loopback port %i while ordinary loopback stays usable',
    port => {
      const code = `import socket\ns=socket.socket()\ns.settimeout(.1)\ntry: s.connect(("127.0.0.1",${port}))\nexcept OSError as e: print(e.errno)`

      const result = spawnSync(
        '/usr/bin/sandbox-exec',
        ['-p', profile(['ssh_agent']), '/usr/bin/python3', '-c', code],
        { encoding: 'utf8' }
      )

      expect(result.stdout.trim()).toBe('1')
    }
  )

  it('denies devfs mount itself (Pillar), with a real allow-default control', () => {
    const point = path.join(root, 'devfs')
    mkdirSync(point)
    const code = `import ctypes, os\nl=ctypes.CDLL(None,use_errno=True)\nr=l.mount(b"devfs",os.fsencode(${JSON.stringify(point)}),0,None)\nprint(r,ctypes.get_errno())`

    const control = spawnSync(
      '/usr/bin/sandbox-exec',
      ['-p', '(version 1)(allow default)', '/usr/bin/python3', '-c', code],
      { encoding: 'utf8' }
    )

    try {
      if (control.stdout.trim() !== '0 0') {
        expect(strict, `devfs positive control failed: ${control.stdout} ${control.stderr}`).toBe(false)

        return
      }
    } finally {
      spawnSync('/sbin/umount', [point], { stdio: 'ignore' })
    }

    const blocked = spawnSync(
      '/usr/bin/sandbox-exec',
      ['-p', profile(['persistence']), '/usr/bin/python3', '-c', code],
      { encoding: 'utf8' }
    )

    try {
      expect(blocked.stdout.trim()).toBe('-1 1')
    } finally {
      spawnSync('/sbin/umount', [point], { stdio: 'ignore' })
    }
  })

  it('denies launchd job submission through a renamed launchctl (A2-12)', async () => {
    const binary = path.join(root, 'launch-probe')
    copyFileSync('/bin/launchctl', binary)
    expect(spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', binary], { stdio: 'ignore' }).status).toBe(0)
    const label = `dev.atum.guard.${process.pid}`
    const output = path.join(root, 'launch-output')
    const plist = path.join(root, 'job.plist')
    writeFileSync(
      plist,
      `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/touch</string><string>${output}</string></array><key>RunAtLoad</key><true/></dict></plist>`
    )
    const domain = `gui/${process.getuid!()}`
    const bootout = () => spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' })

    const wait = async () => {
      for (let i = 0; i < 20 && !existsSync(output); i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    try {
      const control = spawnSync(binary, ['bootstrap', domain, plist], { encoding: 'utf8' })
      spawnSync('/bin/launchctl', ['kickstart', `${domain}/${label}`], { stdio: 'ignore' })
      await wait()

      if (!existsSync(output)) {
        const detail = spawnSync('/bin/launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8' })
        expect(
          strict,
          `launchd control failed: ${control.status} ${control.signal} ${control.error} ${control.stderr} ${detail.stdout}`
        ).toBe(false)

        return
      }

      bootout()
      rmSync(output, { force: true })

      const blocked = spawnSync(
        '/usr/bin/sandbox-exec',
        ['-p', profile(['persistence']), binary, 'bootstrap', domain, plist],
        { encoding: 'utf8' }
      )

      await wait()
      expect(blocked.status).not.toBe(0)
      expect(existsSync(output)).toBe(false)
    } finally {
      bootout()
    }
  }, 15000)
})
