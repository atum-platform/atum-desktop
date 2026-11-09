import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { nullAuditWriter } from '../audit'
import { resolveProtectedPaths } from '../protected-paths'

import { EgressProxy } from './egress'
import { generateSeatbeltProfile } from './profile'
import { sshProxyCommand } from './ssh-proxy-command'

describe.skipIf(process.platform !== 'darwin' || process.env.ATUM_SEATBELT_PROOF !== '1')(
  'SP-5 real public package/SSH proxy path (strict proof)',
  () => {
    let root = ''
    let home = ''
    let port = 0
    const destinations: string[] = []

    const proxy = new EgressProxy({
      active: () => true,
      audit: {
        ...nullAuditWriter,
        record: entry => {
          if (entry.tool === 'egress' && entry.summary) {
            destinations.push(entry.summary)
          }
        }
      }
    })

    const profile = (relax: Parameters<typeof generateSeatbeltProfile>[1]['relax'] = []) =>
      generateSeatbeltProfile(home, {
        paths: resolveProtectedPaths({
          home,
          runtime: { userData: `${home}/Atum`, driveRoot: null, agentWorkingRoots: [] }
        }),
        runtime: { egressProxyPort: port, cuaDriverSocket: `${root}/cua.sock` },
        relax
      })

    const env = (): NodeJS.ProcessEnv => {
      const url = `http://srt:${proxy.authToken}@127.0.0.1:${port}`

      return {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home,
        TMPDIR: root,
        LANG: 'en_US.UTF-8',
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
        ALL_PROXY: url,
        http_proxy: url,
        https_proxy: url,
        all_proxy: url,
        ATUM_DEVICE_PROXY_TOKEN: proxy.authToken,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TEMPLATE_DIR: `${root}/templates`,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.proxyAuthMethod',
        GIT_CONFIG_VALUE_0: 'basic',
        PIP_CONFIG_FILE: '/dev/null',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        PYTHONDONTWRITEBYTECODE: '1'
      }
    }

    async function run(argv: string[], relax: Parameters<typeof profile>[0] = []) {
      return new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
        const child = spawn('/usr/bin/sandbox-exec', ['-p', profile(relax), ...argv], {
          cwd: home,
          env: env(),
          stdio: ['ignore', 'pipe', 'pipe']
        })

        let stdout = ''
        let stderr = ''
        child.stdout.on('data', bytes => {
          stdout = (stdout + bytes).slice(-16384)
        })
        child.stderr.on('data', bytes => {
          stderr = (stderr + bytes).slice(-16384)
        })
        const timeout = setTimeout(() => child.kill('SIGKILL'), 60000)
        child.on('close', status => {
          clearTimeout(timeout)
          resolve({
            status,
            stdout: stdout.replaceAll(proxy.authToken, '[session-token]'),
            stderr: stderr.replaceAll(proxy.authToken, '[session-token]')
          })
        })
      })
    }

    beforeAll(async () => {
      root = mkdtempSync(path.join(os.tmpdir(), 'atum-package-proof-'))
      home = path.join(root, 'home')
      mkdirSync(home)
      mkdirSync(`${root}/templates`)
      port = await proxy.start()
    })
    afterAll(async () => {
      await proxy.stop()

      if (root) {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('OpenSSH refuses hostile destination expansion before ProxyCommand can run a shell canary', () => {
      const marker = `${root}/ssh-injection-canary`
      const command = sshProxyCommand('/usr/bin/python3', port)

      for (const host of [
        `bad;/usr/bin/touch ${marker}`,
        `bad' ; /usr/bin/touch '${marker}'; #`,
        `bad$(/usr/bin/touch ${marker})`
      ]) {
        for (const argv of [[host], ['-o', `HostName=${host}`, 'alias.invalid']]) {
          const result = spawnSync(
            '/usr/bin/ssh',
            [
              '-F',
              '/dev/null',
              '-o',
              'BatchMode=yes',
              '-o',
              'ConnectTimeout=2',
              '-o',
              `ProxyCommand=${command}`,
              ...argv
            ],
            {
              env: { ...env(), ATUM_DEVICE_PROXY_TOKEN: '' },
              encoding: 'utf8',
              timeout: 5000
            }
          )

          expect(result.status, result.stderr).not.toBe(0)
          expect(existsSync(marker), result.stderr).toBe(false)
        }
      }
    })

    it('git fetches a public repository through the authenticated proxy', async () => {
      // A clone writes trust-handoff .git/config: a persistence approval is
      // deliberate. Read-only ls-remote needs no relaxation.
      const remote = await run(['/usr/bin/git', 'ls-remote', 'https://github.com/octocat/Hello-World.git', 'HEAD'])
      expect(remote.status, remote.stderr).toBe(0)
      expect(remote.stdout).toMatch(/^[a-f0-9]{40}\s+HEAD/)

      const clone = await run(
        ['/usr/bin/git', 'clone', '--depth=1', 'https://github.com/octocat/Hello-World.git', `${home}/repo`],
        ['persistence']
      )

      expect(clone.status, clone.stderr).toBe(0)
      expect(readFileSync(`${home}/repo/README`, 'utf8').length).toBeGreaterThan(0)
      expect(destinations.some(host => host.startsWith('github.com'))).toBe(true)
    }, 120000)

    it('npm installs a public package through the authenticated proxy', async () => {
      const npm = realpathSync(spawnSync('/usr/bin/which', ['npm'], { env: env(), encoding: 'utf8' }).stdout.trim())

      const result = await run([
        process.execPath,
        npm,
        'install',
        '--prefix',
        home,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        'is-number@7.0.0'
      ])

      // npm may be supplied by the selected Node runtime rather than root npm.
      expect(result.status, result.stderr).toBe(0)

      const check = await run([
        process.execPath,
        '-e',
        "if (require('./node_modules/is-number')('2') !== true) process.exit(1)"
      ])

      expect(check.status, check.stderr).toBe(0)
      expect(destinations.some(host => host.startsWith('registry.npmjs.org'))).toBe(true)
    }, 90000)

    it('pip installs a public wheel through the authenticated proxy', async () => {
      const result = await run([
        '/usr/bin/python3',
        '-m',
        'pip',
        'install',
        '--no-compile',
        '--no-deps',
        '--target',
        `${home}/python`,
        'six==1.17.0'
      ])

      expect(result.status, result.stderr).toBe(0)

      const check = await run([
        '/usr/bin/python3',
        '-I',
        '-c',
        `import sys; sys.path.insert(0,${JSON.stringify(`${home}/python`)}); import six; assert six.__version__ == "1.17.0"`
      ])

      expect(check.status, check.stderr).toBe(0)
      expect(destinations.some(host => host.startsWith('pypi.org'))).toBe(true)
      expect(destinations.some(host => host.startsWith('files.pythonhosted.org'))).toBe(true)
    }, 90000)

    it('OpenSSH negotiates with GitHub over authenticated CONNECT without any owner keys', async () => {
      const result = await run([
        '/usr/bin/ssh',
        '-F',
        '/dev/null',
        '-T',
        '-p',
        '443',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=20',
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-o',
        'GlobalKnownHostsFile=/dev/null',
        '-o',
        'IdentityFile=/dev/null',
        '-o',
        'IdentityAgent=none',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        `ProxyCommand=${sshProxyCommand('/usr/bin/python3', port)}`,
        'fixture-caca56e22a@example.invalid'
      ])

      expect(result.status).toBe(255)
      expect(result.stderr).toMatch(/Permission denied \(publickey\)/)
      expect(destinations.some(host => host.startsWith('ssh.github.com'))).toBe(true)
    }, 90000)
  }
)
