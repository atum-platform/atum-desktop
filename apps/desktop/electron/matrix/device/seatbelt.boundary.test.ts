/**
 * The Seatbelt profile against the real macOS sandbox (S1 build plan §4 WS-4 "real-boundary" test;
 * `scripts/s1-acceptance/seatbelt-proof.sh` runs this file strictly on the Macs for acceptance test 5).
 *
 * Every profile here comes from the shipping generator (`protected-paths.ts` + `seatbelt.ts`), aimed
 * at canary files in a throwaway HOME, and every probe runs under `/usr/bin/sandbox-exec`. Outside the
 * temporary directory the probes touch only: the SSH-agent socket (asked to list keys) and the login
 * keychain's lock settings (read); a throwaway preferences domain `dev.atum.seatbelt-probe.*` (written by
 * the positive control, deleted afterwards); and Calculator, started in the background by the launch
 * control and quit again (only the instances this file started are signalled).
 *
 * macOS only; skipped elsewhere. A probe whose positive control cannot run here (no network, no SSH
 * agent) is skipped rather than passed, unless `ATUM_SEATBELT_PROOF=1` demands it.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DeviceProtectedCapability } from './contracts'
import { classifyCommand } from './policy'
import { resolveProtectedPaths } from './protected-paths'
import { generateSeatbeltProfile, makeBestEffortResolver } from './seatbelt'

const darwin = process.platform === 'darwin'
const strict = process.env.ATUM_SEATBELT_PROOF === '1'
const installedApp = process.env.ATUM_SEATBELT_APP || null
const launcher = process.env.ATUM_SEATBELT_LAUNCHER || null

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

describe.skipIf(!darwin)('the Seatbelt floor holds at the real sandbox boundary', () => {
  let root = ''
  let home = ''
  let userData = ''
  let driveRoot = ''
  let appExecutable = ''
  let copiedApp = ''
  const helpers: string[] = []
  let probeApp = ''
  let probeOut = ''
  let cuaSocket = ''
  let loopback: Server | undefined
  let loopbackPort = 0
  let cuaServer: Server | undefined
  let bystander: ReturnType<typeof spawn> | undefined
  const profiles = new Map<string, string>()

  function profile(relax: DeviceProtectedCapability[] = [], app: string = appExecutable): string {
    const key = `${relax.join(',')}|${app}`
    const existing = profiles.get(key)

    if (existing) {
      return existing
    }

    const paths = resolveProtectedPaths({
      home,
      runtime: { userData, driveRoot, writableDriveRoots: [driveRoot], agentWorkingRoots: [], appExecutable: app }
    })

    const text = generateSeatbeltProfile(home, {
      paths,
      runtime: { cuaDriverSocket: cuaSocket, egressProxyPort: loopbackPort, sshAgentSocket: process.env.SSH_AUTH_SOCK },
      relax,
      resolve: makeBestEffortResolver(p => realpathSync.native(p))
    })

    const file = path.join(root, `profile-${profiles.size}.sb`)
    writeFileSync(file, text)
    profiles.set(key, file)

    return file
  }

  /**
   * Run under the profile the way the device host does: in a new session and process group
   * (`start_new_session`), which is what makes everything else on the Mac an "other" process to the
   * signal and process-info denies.
   */
  function sandboxed(
    argv: string[],
    relax: DeviceProtectedCapability[] = [],
    env: NodeJS.ProcessEnv = {},
    app: string = appExecutable
  ): Run {
    const setsid = ['-c', 'import os, sys; os.setsid(); os.execv(sys.argv[1], sys.argv[1:])']

    const sandboxArgv = ['/usr/bin/sandbox-exec', '-f', profile(relax, app), ...argv]
    const launched = launcher ? [launcher, '--disclaim', '1', '--', ...sandboxArgv] : sandboxArgv

    const result = spawnSync('/usr/bin/python3', [...setsid, ...launched], {
      cwd: home,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'en_US.UTF-8', ...env },
      encoding: 'utf8',
      timeout: 20_000
    })

    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  const sh = (script: string, relax: DeviceProtectedCapability[] = [], env: NodeJS.ProcessEnv = {}) =>
    sandboxed(['/bin/bash', '-c', script], relax, env)

  const python = (code: string, relax: DeviceProtectedCapability[] = []) =>
    sandboxed(['/usr/bin/python3', '-c', code], relax)

  /** `errno N`, `ok`, or `gai N` from a one-line Python socket probe. */
  const connectProbe = (host: string, port: number, relax: DeviceProtectedCapability[] = []) =>
    python(
      `import socket\ns=socket.socket(); s.settimeout(2)\ntry:\n  s.connect((${JSON.stringify(host)},${port})); print("ok")\nexcept socket.timeout: print("timeout")\nexcept OSError as e: print("errno", e.errno)`,
      relax
    ).stdout.trim()

  const resolveProbe = (relax: DeviceProtectedCapability[] = []) =>
    python(
      'import socket\ntry:\n  socket.getaddrinfo("apple.com",443); print("resolved")\nexcept OSError as e: print("gai", e.errno)',
      relax
    ).stdout.trim()

  beforeAll(async () => {
    root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'atum-sb-')))
    home = path.join(root, 'home')
    userData = path.join(home, 'Library', 'Application Support', 'Atum')
    driveRoot = path.join(home, 'Atum Drive')

    for (const dir of ['.ssh', '.aws', 'Library/Keychains', 'Library/LaunchAgents', 'Downloads', 'work']) {
      mkdirSync(path.join(home, dir), { recursive: true })
    }

    mkdirSync(path.join(userData, 'device'), { recursive: true })
    mkdirSync(driveRoot, { recursive: true })
    writeFileSync(path.join(home, '.ssh', 'id_canary'), 'ssh-canary\n')
    writeFileSync(path.join(home, '.aws', 'credentials'), 'aws-canary\n')
    writeFileSync(path.join(home, 'Library', 'Keychains', 'canary.keychain-db'), 'keychain-canary\n')
    writeFileSync(path.join(userData, 'device', 'vault'), 'vault-canary\n')
    writeFileSync(path.join(home, '.zshrc'), '# rc\n')
    // The delete above may have emptied the root: put the fixtures back for the tests after this one.
    writeFileSync(path.join(driveRoot, 'notes.md'), 'drive\n')
    writeFileSync(path.join(driveRoot, 'run.sh'), '#!/bin/sh\necho ran\n')
    chmodSync(path.join(driveRoot, 'run.sh'), 0o755)
    writeFileSync(path.join(driveRoot, '.atum-drive-binding.json'), '{}\n')
    writeFileSync(path.join(driveRoot, '.atum-drive-journal.db'), 'journal\n')

    for (const script of [path.join(home, 'Downloads', 'run.sh'), path.join(driveRoot, 'run.sh')]) {
      writeFileSync(script, '#!/bin/sh\necho ran\n')
      chmodSync(script, 0o755)
    }

    // A stand-in for Atum's own bundle, and a copy of it elsewhere (a copy keeps its signature).
    for (const bundle of [path.join(root, 'Atum.app'), path.join(root, 'elsewhere', 'Copy.app')]) {
      const binary = path.join(bundle, 'Contents', 'MacOS', 'Atum')
      mkdirSync(path.dirname(binary), { recursive: true })
      writeFileSync(binary, '#!/bin/sh\necho ran\n')
      chmodSync(binary, 0o755)
    }

    appExecutable = path.join(root, 'Atum.app', 'Contents', 'MacOS', 'Atum')
    copiedApp = path.join(root, 'elsewhere', 'Copy.app', 'Contents', 'MacOS', 'Atum')

    // Electron's helpers, which honour ELECTRON_RUN_AS_NODE too: in place and in the copied bundle.
    for (const bundle of [path.join(root, 'Atum.app'), path.join(root, 'elsewhere', 'Copy.app')]) {
      for (const helper of ['Atum Helper', 'Atum Helper (Renderer)']) {
        const binary = path.join(bundle, 'Contents', 'Frameworks', `${helper}.app`, 'Contents', 'MacOS', helper)
        mkdirSync(path.dirname(binary), { recursive: true })
        writeFileSync(binary, '#!/bin/sh\necho ran\n')
        chmodSync(binary, 0o755)
        helpers.push(binary)
      }
    }

    symlinkSync(appExecutable, path.join(home, 'work', 'atum-link'))

    // An app LaunchServices can start: it reports whether it ran and whether it could read a canary.
    probeOut = path.join(root, 'probe-out')
    probeApp = path.join(root, 'probe', 'AtumSeatbeltProbe.app')
    mkdirSync(path.join(probeApp, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(
      path.join(probeApp, 'Contents', 'Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string>' +
        '<key>CFBundleIdentifier</key><string>dev.atum.seatbelt-probe</string>' +
        '<key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/>' +
        '<key>LSEnvironment</key><dict><key>ATUM_SEATBELT_CANARY</key><string>canary</string></dict></dict></plist>\n'
    )

    const buildProbe = spawnSync(
      '/usr/bin/xcrun',
      ['clang', '-x', 'c', '-o', path.join(probeApp, 'Contents', 'MacOS', 'probe'), '-'],
      {
        input:
          '#include <stdio.h>\nint main(void) {' +
          `FILE *in=fopen(${JSON.stringify(path.join(home, '.ssh', 'id_canary'))},"r"), *out=fopen(${JSON.stringify(probeOut)},"w");` +
          'if (!out) return 1; fputs("ran\\n",out); if(in){int c;while((c=fgetc(in))!=EOF)fputc(c,out);fclose(in);}fclose(out);return 0;}',
        encoding: 'utf8'
      }
    )

    expect(buildProbe.status, buildProbe.stderr).toBe(0)
    expect(spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', probeApp], { stdio: 'ignore' }).status).toBe(0)

    const answer = (socket: Socket) => {
      socket.on('error', () => {})
      socket.end('hi')
    }

    loopback = createServer(answer)
    await new Promise<void>(resolve => loopback!.listen(0, '127.0.0.1', resolve))
    loopbackPort = (loopback.address() as { port: number }).port

    cuaSocket = path.join(root, 'cua.sock')
    cuaServer = createServer(answer)
    await new Promise<void>(resolve => cuaServer!.listen(cuaSocket, resolve))

    bystander = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
  })

  afterAll(async () => {
    bystander?.kill('SIGKILL')
    await new Promise<void>(resolve => (loopback ? loopback.close(() => resolve()) : resolve()))
    await new Promise<void>(resolve => (cuaServer ? cuaServer.close(() => resolve()) : resolve()))

    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // ---------------------------------------------------------------- credential and secret stores

  it('† denies reading and writing ~/.ssh, the keychains, cloud credentials and Atum userData', () => {
    expect(sh('cat ~/.ssh/id_canary').status).not.toBe(0)
    expect(sh('echo x > ~/.ssh/new_key').status).not.toBe(0)
    expect(sh('cat ~/Library/Keychains/canary.keychain-db').status).not.toBe(0)
    expect(sh('cat ~/.aws/credentials').status).not.toBe(0)
    expect(sh(`cat "${userData}/device/vault"`).status).not.toBe(0)
    expect(sh(`echo x > "${userData}/device/planted"`).status).not.toBe(0)
  })

  it('† denies the Keychain through securityd (read-only probe of the login keychain settings)', () => {
    const login = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db')
    const outside = spawnSync('/usr/bin/security', ['show-keychain-info', login], { stdio: 'ignore' }).status

    if (outside !== 0 && !strict) {
      return
    }

    expect(sandboxed(['/usr/bin/security', 'show-keychain-info', login]).status).not.toBe(0)
    expect(sandboxed(['/usr/bin/security', 'show-keychain-info', login], ['keychain']).status).toBe(0)
  })

  // ---------------------------------------------------------------- persistence and synced roots

  it('† reads shell startup files but cannot write them, nor LaunchAgents, git config or login items', () => {
    expect(sh('cat ~/.zshrc').status).toBe(0)

    for (const target of [
      '~/.zshrc',
      '~/.bash_login',
      '~/.gitconfig',
      '~/Library/LaunchAgents/com.example.plist',
      '~/.config/fish/config.fish'
    ]) {
      expect(sh(`mkdir -p "$(dirname ${target})" 2>/dev/null; echo planted >> ${target}`).status, target).not.toBe(0)
    }

    expect(readFileSync(path.join(home, '.zshrc'), 'utf8')).toBe('# rc\n')
  })

  it('a persistence grant opens the startup files for that one command', () => {
    expect(sh('echo granted >> ~/.zshrc', ['persistence']).status).toBe(0)
    expect(readFileSync(path.join(home, '.zshrc'), 'utf8')).toContain('granted')
  })

  it("the owner's Drive is readable and writable like their own folder, but not executable", () => {
    expect(sh(`cat "${driveRoot}/notes.md"`).status).toBe(0)
    expect(sh(`echo edited > "${driveRoot}/notes.md" && cat "${driveRoot}/notes.md"`).stdout.trim()).toBe('edited')
    expect(sh(`mkdir -p "${driveRoot}/Q3" && echo deck > "${driveRoot}/Q3/deck.md" && mv "${driveRoot}/Q3/deck.md" "${driveRoot}/Q3/final.md"`).status).toBe(0)
    expect(readFileSync(path.join(driveRoot, 'Q3', 'final.md'), 'utf8')).toBe('deck\n')
    expect(sh(`rm "${driveRoot}/Q3/final.md"`).status).toBe(0)
    expect(sh(`"${driveRoot}/run.sh"`).status).not.toBe(0)
  })

  it("the Drive engine's own state and the root itself stay put", () => {
    expect(sh(`echo x >> "${driveRoot}/.atum-drive-binding.json"`).status).not.toBe(0)
    expect(sh(`echo x > "${driveRoot}/.atum-drive-journal.db"`).status).not.toBe(0)
    expect(sh(`rm "${driveRoot}/.atum-drive-journal.db"`).status).not.toBe(0)
    expect(sh(`echo x > "${driveRoot}/.atum-drive-owner.lock"`).status).not.toBe(0)
    expect(sh(`mv "${driveRoot}" "${driveRoot}-moved"`).status).not.toBe(0)
    expect(readFileSync(path.join(driveRoot, '.atum-drive-journal.db'), 'utf8')).toBe('journal\n')
  })

  it('the kernel alone does not save the Drive from a recursive delete: the classifier gates it', () => {
    // Honest about the floor: with a root like this one writable, `rm -rf` exits non-zero (the root
    // is pinned) but may already have removed ordinary files. That is why `rm -rf <Drive>` is
    // `bulk_destructive` (Touch ID, once per task window) before it can run at all.
    const context = { home, roots: [driveRoot] }

    for (const command of [`rm -rf "${driveRoot}"`, `rm -rf "${driveRoot}"/*`, `find "${driveRoot}" -delete`, `rm -rf ~/'Atum Drive'`]) {
      expect(classifyCommand(command, context).has('bulk_destructive'), command).toBe(true)
    }

    expect(classifyCommand(`rm -rf "${driveRoot}/Q3"`, context).has('bulk_destructive')).toBe(false)
    expect(classifyCommand(`rm "${driveRoot}/Q3/old.md"`, context).has('bulk_destructive')).toBe(false)

    // The pins and the engine's state hold at the kernel whatever the classifier decided.
    expect(sh(`rm -rf "${driveRoot}"`).status).not.toBe(0)
    expect(readFileSync(path.join(driveRoot, '.atum-drive-journal.db'), 'utf8')).toBe('journal\n')
    writeFileSync(path.join(driveRoot, 'notes.md'), 'drive\n')
  })

  it('ordinary work in the home and /tmp still runs', () => {
    expect(sh('echo hi > ~/work/out.txt && cat ~/work/out.txt').stdout.trim()).toBe('hi')
    expect(sh('git --version >/dev/null && mktemp -d >/dev/null').status).toBe(0)
  })

  it("a folder the owner kept closed is closed to device commands by any spelling (folder-access.ts)", () => {
    const closed = path.join(home, 'Desktop')
    mkdirSync(path.join(closed, 'notes'), { recursive: true })
    writeFileSync(path.join(closed, 'notes', 'plan.md'), 'desk-canary\n')
    symlinkSync(closed, path.join(home, 'work', 'desk-link'))

    const paths = resolveProtectedPaths({
      home,
      runtime: { userData, driveRoot, writableDriveRoots: [driveRoot], agentWorkingRoots: [], appExecutable, closedFolders: [closed] }
    })

    const file = path.join(root, 'profile-closed-folders.sb')
    writeFileSync(
      file,
      generateSeatbeltProfile(home, {
        paths,
        runtime: { cuaDriverSocket: cuaSocket, egressProxyPort: loopbackPort },
        relax: [],
        resolve: makeBestEffortResolver(p => realpathSync.native(p))
      })
    )

    const read = (target: string) =>
      spawnSync('/usr/bin/sandbox-exec', ['-f', file, '/bin/cat', target], {
        cwd: home,
        env: { PATH: '/usr/bin:/bin', HOME: home },
        encoding: 'utf8',
        timeout: 20_000
      })

    for (const target of [
      path.join(closed, 'notes', 'plan.md'),
      path.join(home, 'work', 'desk-link', 'notes', 'plan.md'),
      path.join(home, 'desktop', 'notes', 'plan.md'),
      path.join(home, 'work', '..', 'Desktop', 'notes', 'plan.md')
    ]) {
      const result = read(target)
      expect(result.status, target).not.toBe(0)
      expect(result.stdout, target).not.toContain('desk-canary')
    }

    writeFileSync(path.join(home, 'work', 'open.txt'), 'open\n')
    expect(read(path.join(home, 'work', 'open.txt')).stdout).toBe('open\n')
  })

  it('a folder the owner shared inside a closed one stays reachable; the rest stays closed', () => {
    const closed = path.join(home, 'Documents')
    const shared = path.join(closed, 'Shared Work')
    mkdirSync(shared, { recursive: true })
    mkdirSync(path.join(closed, 'Private'), { recursive: true })
    writeFileSync(path.join(shared, 'brief.md'), 'shared-canary\n')
    writeFileSync(path.join(closed, 'Private', 'tax.md'), 'private-canary\n')

    const paths = resolveProtectedPaths({
      home,
      runtime: {
        userData,
        driveRoot,
        writableDriveRoots: [driveRoot],
        agentWorkingRoots: [],
        appExecutable,
        closedFolders: [closed],
        sharedInsideClosedFolders: [shared]
      }
    })

    const file = path.join(root, 'profile-closed-shared-child.sb')
    writeFileSync(
      file,
      generateSeatbeltProfile(home, {
        paths,
        runtime: { cuaDriverSocket: cuaSocket, egressProxyPort: loopbackPort },
        relax: [],
        resolve: makeBestEffortResolver(p => realpathSync.native(p))
      })
    )

    const read = (target: string) =>
      spawnSync('/usr/bin/sandbox-exec', ['-f', file, '/bin/cat', target], {
        cwd: home,
        env: { PATH: '/usr/bin:/bin', HOME: home },
        encoding: 'utf8',
        timeout: 20_000
      })

    expect(read(path.join(shared, 'brief.md')).stdout).toBe('shared-canary\n')
    const denied = read(path.join(closed, 'Private', 'tax.md'))
    expect(denied.status).not.toBe(0)
    expect(denied.stdout).not.toContain('private-canary')
  })

  // ---------------------------------------------------------------- exec

  it('† denies running downloaded code, and an exec_downloaded grant lifts only that', () => {
    expect(sh('~/Downloads/run.sh').status).not.toBe(0)
    expect(sh('~/Downloads/run.sh', ['exec_downloaded']).stdout.trim()).toBe('ran')
    expect(sh('~/Downloads/run.sh', ['ssh_agent']).status).not.toBe(0)
  })

  it('† still denies the programs that hand work to an app outside the sandbox (Apple Events cannot be blocked by name)', () => {
    for (const program of ['/usr/bin/osascript', '/usr/bin/osacompile', '/usr/bin/automator', '/usr/bin/shortcuts']) {
      expect(sandboxed([program, '-h']).status, program).not.toBe(0)
      expect(sh(`${program} -h`).stderr, program).toMatch(/not permitted/i)
    }
  })

  it('launchctl and crontab start (owner 2026-10-20) but can neither submit a job nor write the cron spool', () => {
    expect(sh('/bin/launchctl list >/dev/null 2>&1; echo started').stdout.trim()).toBe('started')
    expect(sh('/usr/bin/crontab -l >/dev/null 2>&1; echo started').stdout.trim()).toBe('started')
    expect(sh('echo "* * * * * true" | /usr/bin/crontab - 2>/dev/null').status).not.toBe(0)
    expect(
      sh('/bin/launchctl submit -l atum.seatbelt.probe -- /usr/bin/true 2>/dev/null; /bin/launchctl list atum.seatbelt.probe >/dev/null 2>&1')
        .status
    ).not.toBe(0)
  })

  it("denies Atum's own binary, in place and in a copied bundle", () => {
    expect(sh(`"${appExecutable}"`).stderr).toMatch(/not permitted/i)
    expect(sh(`"${copiedApp}"`).stderr).toMatch(/not permitted/i)
  })

  it('the RunAsNode route stays closed: Atum and its helpers refuse to exec with ELECTRON_RUN_AS_NODE, in place, copied and through a symlink', () => {
    // The RunAsNode fuse stays on in S1 (local-brain.ts still needs it); this exec deny is the
    // compensating control, so it is proven here at the real boundary, with the attack's own env.
    const env = { ELECTRON_RUN_AS_NODE: '1' }

    for (const binary of [appExecutable, copiedApp, ...helpers, path.join(home, 'work', 'atum-link')]) {
      const run = sh(`"${binary}" -e 'console.log(1)'`, [], env)
      expect(run.stderr, binary).toMatch(/not permitted/i)
      expect(run.stdout, binary).not.toContain('ran')
    }

    // ... and under every grant the owner can give, not only the default profile.
    const granted = sh(
      `"${appExecutable}" -e 'console.log(1)'`,
      ['persistence', 'exec_downloaded', 'cloud_cli', 'keychain'],
      env
    )

    expect(granted.stderr).toMatch(/not permitted/i)
  })

  // On the Macs (seatbelt-proof.sh), the installed Atum itself: ATUM_SEATBELT_APP=<bundle>/Contents/MacOS/<name>.
  it.skipIf(!installedApp)('the installed Atum and its helpers refuse to exec with ELECTRON_RUN_AS_NODE', () => {
    const bundle = installedApp!.replace(/\/Contents\/MacOS\/[^/]+$/, '')
    const frameworks = path.join(bundle, 'Contents', 'Frameworks')

    const installedHelpers = readdirSync(frameworks)
      .filter(entry => / Helper( \(.+\))?\.app$/.test(entry))
      .map(entry => path.join(frameworks, entry, 'Contents', 'MacOS', entry.replace(/\.app$/, '')))

    expect(installedHelpers.length).toBeGreaterThan(0)

    for (const binary of [installedApp!, ...installedHelpers]) {
      const run = sandboxed(
        ['/bin/bash', '-c', `"${binary}" -e 'console.log("escaped")'`],
        [],
        { ELECTRON_RUN_AS_NODE: '1' },
        installedApp!
      )

      expect(run.stderr, binary).toMatch(/not permitted/i)
      expect(run.stdout, binary).not.toContain('escaped')
    }
  })

  it('cannot start an app outside the sandbox through LaunchServices (F9)', async () => {
    const waitForProbe = async () => {
      for (let tries = 0; tries < 100 && !existsSync(probeOut); tries++) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      return existsSync(probeOut) ? readFileSync(probeOut, 'utf8') : null
    }

    // Positive control, outside the sandbox: LaunchServices starts the probe and it reads the canary.
    // LaunchServices occasionally drops the first launch of a freshly registered bundle: one retry.
    let controlOut: string | null = null

    for (let attempt = 0; attempt < 2 && !controlOut?.includes('ssh-canary'); attempt++) {
      rmSync(probeOut, { force: true })
      const control = spawnSync('/usr/bin/open', ['-n', '-g', '-j', probeApp], { encoding: 'utf8', timeout: 10_000 })
      controlOut = control.status === 0 ? await waitForProbe() : null
    }

    if (!controlOut?.includes('ssh-canary')) {
      expect(strict, 'LaunchServices could not start the probe app outside the sandbox').toBe(false)

      return
    }

    rmSync(probeOut, { force: true })
    const run = sh(`/usr/bin/open -n -g -j "${probeApp}"; echo "open=$?"`)
    expect(await waitForProbe()).toBeNull()
    expect(run.stdout).not.toContain('open=0')

    // The same for Atum itself, the route around the exec deny above.
    const atum = sh(
      `/usr/bin/open -n -g -j --env ELECTRON_RUN_AS_NODE=1 "${path.join(root, 'Atum.app')}"; echo "open=$?"`
    )

    expect(atum.stdout).not.toContain('open=0')
  }, 60_000)

  /** Pids of a running executable, by exact process name. */
  const pidsOf = (name: string): Set<number> =>
    new Set(
      (spawnSync('/usr/bin/pgrep', ['-x', name], { encoding: 'utf8' }).stdout ?? '')
        .split('\n')
        .filter(Boolean)
        .map(Number)
    )

  /** Wait up to `ms` for a new pid of `name` that was not in `before`; returns the new pids. */
  const newPids = async (name: string, before: Set<number>, ms: number): Promise<number[]> => {
    for (let waited = 0; ; waited += 200) {
      const fresh = [...pidsOf(name)].filter(pid => !before.has(pid))

      if (fresh.length || waited >= ms) {
        return fresh
      }

      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  const killAll = (pids: number[]) => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
  }

  it('cannot start a signed, registered app outside the sandbox by bundle id or name (F9 follow-up B1)', async () => {
    // Positive control, outside the sandbox: LaunchServices starts a new Calculator.
    const before = pidsOf('Calculator')
    spawnSync('/usr/bin/open', ['-n', '-g', '-j', '-b', 'com.apple.calculator'], { timeout: 10_000 })
    const control = await newPids('Calculator', before, 10_000)
    killAll(control)

    if (!control.length) {
      expect(strict, 'LaunchServices could not start Calculator outside the sandbox').toBe(false)

      return
    }

    await new Promise(resolve => setTimeout(resolve, 500))

    for (const script of [
      '/usr/bin/open -n -g -j -b com.apple.calculator',
      '/usr/bin/open -n -g -j -a Calculator',
      '/usr/bin/open -g -a Calculator'
    ]) {
      const ahead = pidsOf('Calculator')
      sh(script)
      const escaped = await newPids('Calculator', ahead, 3_000)
      killAll(escaped)
      expect(escaped, script).toEqual([])
    }
  }, 60_000)

  // On the Macs: the installed Atum, launched by `open -n -a`, must not start (it would run unsandboxed).
  it.skipIf(!installedApp)(
    'cannot start the installed Atum through open -n -a (F9 follow-up B1)',
    async () => {
      const bundle = installedApp!.replace(/\/Contents\/MacOS\/[^/]+$/, '')
      const name = path.basename(installedApp!)
      const before = pidsOf(name)
      sandboxed(
        ['/usr/bin/open', '-n', '-g', '-j', '-a', bundle, '--env', 'ELECTRON_RUN_AS_NODE=1'],
        [],
        {},
        installedApp!
      )
      const escaped = await newPids(name, before, 5_000)
      killAll(escaped)
      expect(escaped).toEqual([])
    },
    30_000
  )

  it('cannot write any preferences, through cfprefsd or the files; a persistence grant opens both (B2)', () => {
    const domain = `dev.atum.seatbelt-probe.${process.pid}`
    const read = (key: string) => spawnSync('/usr/bin/defaults', ['read', domain, key], { encoding: 'utf8' })
    // cfprefsd writes the owner's REAL preferences whatever HOME says, so the domain is cleaned there.
    const realPlist = path.join(os.homedir(), 'Library', 'Preferences', `${domain}.plist`)

    try {
      // Positive control, outside the sandbox: the write lands.
      expect(spawnSync('/usr/bin/defaults', ['write', domain, 'control', 'yes']).status).toBe(0)
      expect(read('control').stdout.trim()).toBe('yes')

      expect(sh(`/usr/bin/defaults write ${domain} planted yes`).status).not.toBe(0)
      expect(read('planted').status).not.toBe(0)

      expect(
        sh(`mkdir -p ~/Library/Preferences 2>/dev/null; echo x > ~/Library/Preferences/${domain}.plist`).status
      ).not.toBe(0)

      // The owner's one-command persistence grant reopens both halves.
      // cfprefsd keys by the login user's real home. Exercise the production
      // profile with that home for the granted, throwaway preference domain.
      const granted = generateSeatbeltProfile(os.homedir(), {
        paths: resolveProtectedPaths({ home: os.homedir(), runtime: { userData, driveRoot, agentWorkingRoots: [] } }),
        runtime: { cuaDriverSocket: cuaSocket, egressProxyPort: loopbackPort },
        relax: ['persistence']
      })

      const result = spawnSync(
        '/usr/bin/sandbox-exec',
        ['-p', granted, '/usr/bin/defaults', 'write', domain, 'granted', 'yes'],
        {
          env: { PATH: '/usr/bin:/bin', HOME: os.homedir() },
          encoding: 'utf8'
        }
      )

      expect(result.status, result.stderr).toBe(0)
      expect(read('granted').stdout.trim()).toBe('yes')
      expect(
        sh(`mkdir -p ~/Library/Preferences && echo x > ~/Library/Preferences/${domain}.plist`, ['persistence']).status
      ).toBe(0)

      // Ordinary tools still run with cfprefsd and LaunchServices closed.
      expect(
        sh(
          'python3 -c "print(1)" >/dev/null && git --version >/dev/null && xcrun --find clang >/dev/null && echo tools-ok'
        ).stdout.trim()
      ).toBe('tools-ok')
    } finally {
      spawnSync('/usr/bin/defaults', ['delete', domain], { stdio: 'ignore' })
      rmSync(realPlist, { force: true })
    }
  })

  it('a setuid binary cannot run inside any sandbox (why device-local sudo runs outside the profile)', () => {
    const run = sh('/usr/bin/sudo -n true')
    expect(run.status).not.toBe(0)
    expect(sh('/bin/ps -p $$').stderr).toMatch(/not permitted/i)
  })

  // ---------------------------------------------------------------- sockets and egress

  it('† closes the SSH agent; an ssh_agent grant opens it while keeping key files denied', () => {
    const socket = process.env.SSH_AUTH_SOCK

    if (!socket) {
      if (strict) {
        throw new Error('SSH_AUTH_SOCK is not set: run the proof from a session with an SSH agent')
      }

      return
    }

    // `ssh-add -l` exits 2 when it cannot reach the agent, 0/1 when it can (keys / no keys).
    expect(sandboxed(['/usr/bin/ssh-add', '-l'], [], { SSH_AUTH_SOCK: socket }).status).toBe(2)
    expect([0, 1]).toContain(sandboxed(['/usr/bin/ssh-add', '-l'], ['ssh_agent'], { SSH_AUTH_SOCK: socket }).status)
    expect(sh('cat ~/.ssh/id_canary', ['ssh_agent']).stderr).toContain('Operation not permitted')
  })

  it('† keeps SSH keys and configuration writes denied under ssh_agent', () => {
    expect(sh('cat ~/.ssh/id_canary', ['ssh_agent']).stderr).toContain('Operation not permitted')
    expect(sh('echo poisoned > ~/.ssh/authorized_keys', ['ssh_agent']).stderr).toContain('Operation not permitted')
    expect(sh('echo poisoned > ~/.ssh/config', ['ssh_agent']).stderr).toContain('Operation not permitted')
  })

  it('† reads HOME-contained SSH client symlinks and keeps config read-only', () => {
    const dotfiles = path.join(home, 'dotfiles')
    mkdirSync(dotfiles, { recursive: true })
    writeFileSync(path.join(dotfiles, 'ssh-config'), '# canary config\n')
    writeFileSync(path.join(dotfiles, 'known_hosts'), '# canary hosts\n')
    symlinkSync(path.join(dotfiles, 'ssh-config'), path.join(home, '.ssh', 'config'))
    symlinkSync(path.join(dotfiles, 'known_hosts'), path.join(home, '.ssh', 'known_hosts'))
    profiles.clear()
    expect(sh('cat ~/.ssh/config', ['ssh_agent']).stdout).toContain('canary config')
    expect(sh('cat ~/.ssh/known_hosts', ['ssh_agent']).stdout).toContain('canary hosts')
    expect(sh('echo host >> ~/.ssh/known_hosts', ['ssh_agent']).status).toBe(0)
    expect(sh('echo poisoned > ~/.ssh/config', ['ssh_agent']).stderr).toContain('Operation not permitted')
    expect(sh('cat ~/.ssh/id_canary', ['ssh_agent']).stderr).toContain('Operation not permitted')
  })

  it('† denies all direct IP egress but loopback (the egress proxy), with port 22 lifted for ssh', () => {
    expect(connectProbe('127.0.0.1', loopbackPort)).toBe('ok')
    expect(connectProbe('192.0.2.1', 443)).toBe('errno 1')
    expect(connectProbe('192.0.2.1', 22)).toBe('errno 1')
    // TEST-NET is unroutable: lifted, the connect is attempted (and times out or is unreachable).
    expect(connectProbe('192.0.2.1', 22, ['ssh_agent'])).not.toBe('errno 1')
    expect(connectProbe('192.0.2.1', 443, ['ssh_agent'])).toBe('errno 1')
  })

  it('† closes DNS (the mDNSResponder socket, G0 F1); only an ssh_agent grant reopens it', () => {
    const outside = spawnSync(
      '/usr/bin/python3',
      [
        '-c',
        'import socket\ntry:\n  socket.getaddrinfo("apple.com",443); print("resolved")\nexcept OSError: print("no")'
      ],
      { encoding: 'utf8' }
    ).stdout.trim()

    if (outside !== 'resolved') {
      if (strict) {
        throw new Error('this Mac cannot resolve names at all, so the DNS deny cannot be told apart')
      }

      return
    }

    expect(resolveProbe()).toMatch(/^gai /)
    expect(resolveProbe(['keychain', 'exec_downloaded', 'persistence'])).toMatch(/^gai /)
    expect(resolveProbe(['ssh_agent'])).toBe('resolved')
  })

  it('† denies the CuaDriver broker socket to a shell command', () => {
    const code = `import socket\ns=socket.socket(socket.AF_UNIX)\ntry:\n  s.connect(${JSON.stringify(cuaSocket)}); print("ok")\nexcept OSError as e: print("errno", e.errno)`
    expect(spawnSync('/usr/bin/python3', ['-c', code], { encoding: 'utf8' }).stdout.trim()).toBe('ok')
    expect(python(code).stdout.trim()).toBe('errno 1')
  })

  // ---------------------------------------------------------------- processes

  it('cannot signal processes outside the sandbox, but can manage its own children', async () => {
    // A real signal (the null signal only probes existence and is not mediated).
    expect(sh(`kill -TERM ${bystander!.pid}`).stderr).toMatch(/not permitted/i)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(bystander!.exitCode).toBeNull()
    expect(bystander!.signalCode).toBeNull()
    expect(sh('sleep 30 & child=$!; kill $child && wait $child; echo done').stdout.trim()).toBe('done')
  })

  it('a double-forked, setsid daemon stays sandboxed', async () => {
    const out = path.join(home, 'work', 'daemon.txt')

    const daemon = [
      'import os, sys, time',
      'if os.fork() == 0:',
      '    os.setsid()',
      '    if os.fork() == 0:',
      '        time.sleep(0.3)',
      `        with open(${JSON.stringify(out)}, "w") as f:`,
      '            try:',
      `                f.write(open(${JSON.stringify(path.join(home, '.ssh', 'id_canary'))}).read())`,
      '            except OSError as e:',
      '                f.write("denied %d" % e.errno)',
      '    os._exit(0)'
    ].join('\n')

    expect(python(daemon).status).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 1500))
    const text = readFileSync(out, 'utf8')
    expect(text).not.toContain('ssh-canary')
    expect(text).toBe('denied 1')
  })

  it('a sandboxed process cannot apply a second sandbox to escape the first', () => {
    const run = sandboxed([
      '/usr/bin/sandbox-exec',
      '-p',
      '(version 1)(allow default)',
      '/bin/cat',
      path.join(home, '.ssh', 'id_canary')
    ])

    expect(run.status).not.toBe(0)
    expect(run.stdout).not.toContain('ssh-canary')
  })
})
