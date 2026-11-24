import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { managedKeys, type NativeSshSystem } from './native-ssh'
import { nativeSshSession } from './native-ssh-session'

const exec = promisify(execFile)
const LABEL = 'com.atum.desktop.native-ssh'
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

async function absent(error: unknown): Promise<string> {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    return ''
  }

  throw new Error('native_ssh_file_failed')
}

async function noSymlink(file: string): Promise<void> {
  const stat = await lstat(file).catch(error => {
    if (error.code !== 'ENOENT') {
      throw error
    }

    return null
  })

  if (stat?.isSymbolicLink()) {
    throw new Error('native_ssh_symlink')
  }
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
  /** Packaged helper path, overridden only in tests. */
  helper?: () => Promise<string>
}

export function createNativeSshSystem(options: NativeSshSystemOptions = {}): NativeSshSystem {
  const home = options.home ?? homedir(),
    run = options.run ?? exec

  const root = path.join(home, 'Library', 'Application Support', 'Atum', 'native-ssh')
  const markers = path.join(root, 'sessions')
  const sessionScript = path.join(root, 'session.pl')
  const quote = (value: string) => `'${value.replace(/'/g, "'\"'\"'")}'`

  const clearMarkers = async (keep = new Set<string>()) => {
    await noSymlink(root)
    await noSymlink(markers)

    for (const file of await readdir(markers).catch(error => {
      if (error.code === 'ENOENT') {
        return []
      }

      throw error
    })) {
      if (/^[a-f0-9]{64}$/.test(file) && !keep.has(file)) {
        await rm(path.join(markers, file), { force: true })
      }
    }
  }

  const plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
  const tokenFile = (id: string) => path.join(root, `${id}.token`)
  const domain = `gui/${process.getuid!()}`

  const command = async (file: string, args: string[]) =>
    (await run(file, args, { timeout: 15_000, maxBuffer: 65536 })).stdout.toString()

  const stopTunnel = async () => {
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

      if (present) {
        throw new Error('tunnel_stop_failed')
      }
    }

    await rm(plist, { force: true })
    await rm(path.join(root, 'run.sh'), { force: true })
  }

  return {
    async ready() {
      const remoteLogin = options.port22
        ? await options.port22()
        : await command('/usr/bin/nc', ['-z', '-w', '2', '127.0.0.1', '22']).then(
            () => true,
            () => false
          )

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
    token: id => readFile(tokenFile(id), 'utf8').catch(error => absent(error).then(() => null)),
    async saveToken(id, value) {
      await noSymlink(root)
      await mkdir(root, { recursive: true, mode: 0o700 })
      await chmod(root, 0o700)
      await atomic(tokenFile(id), value, 0o600)
    },
    async removeToken(id) {
      await rm(tokenFile(id), { force: true })
      // Remove tokens left by the previous Keychain-based adapter, too.
      await command('/usr/bin/security', ['delete-generic-password', '-s', LABEL, '-a', id]).catch(error => {
        if (error.code !== 44) {
          throw new Error('keychain_cleanup_failed')
        }
      })
    },
    async keys(keys) {
      const hashes = keys.map(key => createHash('sha256').update(key).digest('hex'))
      await clearMarkers(new Set(hashes))
      const commands = new Map<string, string>()

      if (keys.length) {
        await access('/usr/bin/perl')
        await noSymlink(root)
        await mkdir(root, { recursive: true, mode: 0o700 })
        await chmod(root, 0o700)
        await mkdir(markers, { recursive: true, mode: 0o700 })
        await chmod(markers, 0o700)
        await atomic(sessionScript, nativeSshSession, 0o600)

        for (const [index, key] of keys.entries()) {
          const marker = path.join(markers, hashes[index])
          await noSymlink(marker)
          const saved = await readFile(marker, 'utf8').catch(absent)
          const epoch = /^[a-f0-9-]{36}$/.test(saved) ? saved : randomUUID()

          if (saved !== epoch) {
            await atomic(marker, epoch, 0o600)
          }

          commands.set(key, `/usr/bin/perl ${quote(sessionScript)} ${quote(marker)} ${quote(epoch)}`)
        }
      }

      const dir = path.join(home, '.ssh'),
        file = path.join(dir, 'authorized_keys')

      await noSymlink(dir)
      await noSymlink(file)
      const current = await readFile(file, 'utf8').catch(absent)

      if (!keys.length && !current.includes('# BEGIN ATUM MANAGED SSH KEYS')) {
        return
      }

      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700)
      await atomic(
        file,
        managedKeys(current, keys, key => commands.get(key)!),
        0o600
      )
    },
    async start(id) {
      const binary = options.helper
        ? await options.helper()
        : path.join(process.resourcesPath, 'app.asar.unpacked', 'cloudflared')

      if (!options.helper) {
        await access(binary)
      }

      await noSymlink(root)
      await mkdir(root, { recursive: true, mode: 0o700 })
      await chmod(root, 0o700)
      await noSymlink(path.dirname(plist))
      await mkdir(path.dirname(plist), { recursive: true, mode: 0o700 })
      const content = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${[binary, 'tunnel', '--no-autoupdate', 'run', '--token-file', tokenFile(id), '--url', 'ssh://localhost:22'].map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`

      if ((await readFile(plist, 'utf8').catch(absent)) === content) {
        try {
          await command('/bin/launchctl', ['print', `${domain}/${LABEL}`])

          return
        } catch {
          await command('/bin/launchctl', ['bootstrap', domain, plist])

          return
        }
      }

      // Replacing a tunnel job is transport recovery, not an authority withdrawal.
      await stopTunnel()
      await atomic(plist, content, 0o600)
      await command('/bin/launchctl', ['bootstrap', domain, plist])
    },
    async stop() {
      const results = await Promise.allSettled([clearMarkers(), stopTunnel()])

      if (results.some(result => result.status === 'rejected')) {
        throw new Error('native_ssh_cleanup_pending')
      }
    }
  }
}
