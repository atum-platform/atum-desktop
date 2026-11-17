import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { managedKeys, type NativeSshSystem } from './native-ssh'

const exec = promisify(execFile)
const SERVICE = 'com.atum.desktop.native-ssh'
const LABEL = 'com.atum.desktop.native-ssh'
const VERSION = '2026.11.0'
// GitHub Cloudflare release asset digests, Apache-2.0. No Homebrew prerequisite.
const DIGESTS: Record<string, string> = {
  arm64: '8c2f90277ef06a6080bb40b964d33f09f1188102f8798f2e344174b6cf41accf',
  x64: '8a59d51120cebbe902f0a8d6e1b7a7fd4f9a5bb4dcb3e0f05872483e75e7db6b'
}
const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const securityQuote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
async function absent(error: unknown): Promise<string> {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
  throw new Error('native_ssh_file_failed')
}
async function noSymlink(file: string): Promise<void> {
  const stat = await lstat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (stat?.isSymbolicLink()) throw new Error('native_ssh_symlink')
}
async function atomic(file: string, content: string, mode: number): Promise<void> {
  await noSymlink(file)
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, content, { mode, flag: 'wx' })
    await rename(temp, file)
    await chmod(file, mode)
  } finally {
    await rm(temp, { force: true })
  }
}
export interface NativeSshSystemOptions {
  home?: string
  run?: typeof exec
  port22?: () => Promise<boolean>
  /** Test seam. Production obtains and verifies the pinned public helper lazily. */
  helper?: () => Promise<string>
  spawnKeychain?: typeof spawn
  metricsPort?: () => Promise<number>
}
export function createNativeSshSystem(options: NativeSshSystemOptions = {}): NativeSshSystem {
  const home = options.home ?? homedir(),
    run = options.run ?? exec
  const root = path.join(home, 'Library', 'Application Support', 'Atum', 'native-ssh')
  const plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
  const pidfile = path.join(root, 'connected.pid')
  const domain = `gui/${process.getuid!()}`
  const command = async (file: string, args: string[]) =>
    (await run(file, args, { timeout: 15_000, maxBuffer: 65536 })).stdout.toString()
  const port22 =
    options.port22 ??
    (() =>
      new Promise<boolean>(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port: 22 })
        const finish = (value: boolean) => {
          socket.destroy()
          resolve(value)
        }
        socket.setTimeout(1500, () => finish(false))
        socket.once('connect', () => finish(true))
        socket.once('error', () => finish(false))
      }))
  const token = async (id: string): Promise<string | null> => {
    try {
      return (
        (await command('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', id, '-w'])).trim() || null
      )
    } catch (error) {
      if ((error as { code?: number }).code === 44) return null
      throw new Error('keychain_unavailable')
    }
  }
  const helper =
    options.helper ??
    (async () => {
      // Provision this exact verified release in user space, without a Homebrew dependency.
      const binary = path.join(root, `cloudflared-${VERSION}-${process.arch}`)
      try {
        await access(binary)
        return binary
      } catch {
        /* first run */
      }
      if (!DIGESTS[process.arch]) throw new Error('unsupported_mac_arch')
      await mkdir(root, { recursive: true, mode: 0o700 })
      const url = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-darwin-${process.arch === 'x64' ? 'amd64' : 'arm64'}.tgz`
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error('helper_download_failed')
      const archive = Buffer.from(await response.arrayBuffer())
      if (createHash('sha256').update(archive).digest('hex') !== DIGESTS[process.arch])
        throw new Error('helper_digest_failed')
      const stage = path.join(root, randomUUID())
      await mkdir(stage, { mode: 0o700 })
      try {
        await writeFile(path.join(stage, 'helper.tgz'), archive, { mode: 0o600 })
        await command('/usr/bin/tar', ['-xzf', path.join(stage, 'helper.tgz'), '-C', stage, 'cloudflared'])
        await chmod(path.join(stage, 'cloudflared'), 0o700)
        await rename(path.join(stage, 'cloudflared'), binary)
      } finally {
        await rm(stage, { recursive: true, force: true })
      }
      return binary
    })
  return {
    async ready() {
      if (process.platform !== 'darwin') throw new Error('macos_required')
      let disabled = false
      try {
        disabled = /"com\.openssh\.sshd"\s*=>\s*true/.test(
          await command('/bin/launchctl', ['print-disabled', 'system'])
        )
      } catch {
        /* port probe is authoritative fallback */
      }
      const remoteLogin = !disabled && (await port22())
      const hostKey = remoteLogin
        ? (await readFile('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ')
        : ''
      return { remoteLogin, user: userInfo().username, hostKey }
    },
    async enableRemoteLogin() {
      await command('/usr/bin/osascript', [
        '-e',
        'do shell script "/usr/sbin/systemsetup -setremotelogin on" with administrator privileges'
      ])
    },
    token,
    async saveToken(id, value) {
      // security's interactive command stdin avoids exposing the password in argv.
      await new Promise<void>((resolve, reject) => {
        const child = (options.spawnKeychain ?? spawn)('/usr/bin/security', ['-i'], {
          stdio: ['pipe', 'ignore', 'ignore']
        })
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error('keychain_failed'))
        }, 15000)
        child.once('error', () => {
          clearTimeout(timer)
          reject(new Error('keychain_failed'))
        })
        child.once('close', code => {
          clearTimeout(timer)
          code === 0 ? resolve() : reject(new Error('keychain_failed'))
        })
        child.stdin.on('error', () => {})
        child.stdin.end(
          `add-generic-password -U -s ${securityQuote(SERVICE)} -a ${securityQuote(id)} -w ${securityQuote(value)}\n`
        )
      })
      if ((await token(id)) !== value) throw new Error('keychain_failed')
    },
    async removeToken(id) {
      if ((await token(id)) !== null)
        await command('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', id])
    },
    async keys(keys) {
      const dir = path.join(home, '.ssh'),
        file = path.join(dir, 'authorized_keys')
      await noSymlink(dir)
      await noSymlink(file)
      const current = await readFile(file, 'utf8').catch(absent)
      if (!keys.length && !current.includes('# BEGIN ATUM MANAGED SSH KEYS')) return
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700)
      await atomic(file, managedKeys(current, keys), 0o600)
    },
    async start(id) {
      const binary = await helper()
      const metricsPort = await (
        options.metricsPort ??
        (() =>
          new Promise<number>((resolve, reject) => {
            const server = createServer()
            server.once('error', reject)
            server.listen(0, '127.0.0.1', () => {
              const address = server.address()
              if (!address || typeof address === 'string') {
                server.close()
                reject(new Error('metrics_port_failed'))
                return
              }
              server.close(error => (error ? reject(error) : resolve(address.port)))
            })
          }))
      )()
      await mkdir(root, { recursive: true, mode: 0o700 })
      await mkdir(path.dirname(plist), { recursive: true, mode: 0o700 })
      await atomic(path.join(root, 'metrics-port'), String(metricsPort), 0o600)
      const wrapper = path.join(root, 'run.sh')
      // Only public identifiers/paths on disk. Token travels Keychain -> pipe -> /dev/stdin.
      await atomic(
        wrapper,
        `#!/bin/bash\nset -eo pipefail\n/bin/rm -f ${quote(pidfile)}\n/usr/bin/security find-generic-password -s ${quote(SERVICE)} -a ${quote(id)} -w | ${quote(binary)} tunnel --no-autoupdate --metrics 127.0.0.1:${metricsPort} --pidfile ${quote(pidfile)} run --token-file /dev/stdin --url ssh://localhost:22 >/dev/null 2>&1\n`,
        0o700
      )
      await atomic(
        plist,
        `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>${xml(wrapper)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`,
        0o600
      )
      try {
        await command('/bin/launchctl', ['bootout', `${domain}/${LABEL}`])
      } catch {
        /* absent */
      }
      await rm(pidfile, { force: true })
      await command('/bin/launchctl', ['bootstrap', domain, plist])
    },
    async stop() {
      try {
        await command('/bin/launchctl', ['bootout', `${domain}/${LABEL}`])
      } catch {
        // An absent job is already stopped; a present job that cannot stop is an error.
        let present = false
        try {
          await command('/bin/launchctl', ['print', `${domain}/${LABEL}`])
          present = true
        } catch {
          /* absent */
        }
        if (present) throw new Error('tunnel_stop_failed')
      }
      await rm(plist, { force: true })
      await rm(path.join(root, 'run.sh'), { force: true })
      await rm(pidfile, { force: true })
      await rm(path.join(root, 'metrics-port'), { force: true })
    },
    async healthy() {
      try {
        const port = Number(await readFile(path.join(root, 'metrics-port'), 'utf8'))
        if (!Number.isInteger(port) || port < 1 || port > 65535) return false
        const ready = await fetch(`http://127.0.0.1:${port}/ready`, {
          signal: AbortSignal.timeout(1500),
          redirect: 'error'
        })
        await ready.body?.cancel()
        return (
          ready.ok &&
          /pid = \d+/.test(await command('/bin/launchctl', ['print', `${domain}/${LABEL}`])) &&
          /^\d+\s*$/.test(await readFile(pidfile, 'utf8'))
        )
      } catch {
        return false
      }
    }
  }
}
