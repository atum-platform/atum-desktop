import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { requestS1 } from './cloud-agent'
import type { DeviceEnrollmentRecord } from './enrollment'

import { managedKeys, NativeMacSsh, type NativeSshSystem } from './native-ssh'
import { createNativeSshSystem } from './native-ssh-system'

const packFixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./native-ssh-fixtures/${name}.json`, import.meta.url), 'utf8'))
const authorized = packFixture('native-authorized-positive')
const enrollment = packFixture('native-enroll-request')
const enrolled = packFixture('native-enroll-response')
const revoked = packFixture('native-revoke-response')
const host = `${enrollment.deviceServiceId}.mac.atumplatform.com`
const secret = 'test-only-token'
function fixture() {
  let saved: string | null = null
  let running = false
  let disk = 'ssh-ed25519 user-owned-line\n'
  const system: NativeSshSystem = {
    ready: vi.fn(async () => ({ remoteLogin: true, user: enrollment.user, hostKey: enrollment.hostKey })),
    enableRemoteLogin: vi.fn(async () => {}),
    token: vi.fn(async () => saved),
    saveToken: vi.fn(async (_id, token) => {
      saved = token
    }),
    removeToken: vi.fn(async () => {
      saved = null
    }),
    start: vi.fn(async () => {
      running = true
    }),
    stop: vi.fn(async () => {
      running = false
    }),
    healthy: vi.fn(async () => running),
    keys: vi.fn(async keys => {
      disk = managedKeys(disk, keys)
    })
  }
  const http = vi.fn(async (_url: any, init: any) => {
    expect(init.headers.Authorization).toBe('Bearer owner-fixture-session')
    const body = JSON.parse(init.body)
    const answer = {
      ssh_prepare: { deviceServiceId: enrollment.deviceServiceId, host, tunnelToken: secret },
      ssh_authorized_keys: authorized,
      ssh_enroll: { ...enrolled, nativeSsh: { ...enrolled.nativeSsh, host } },
      ssh_revoke: revoked
    }[body.operation as string]
    return Response.json(answer)
  })
  const service = new NativeMacSsh({
    enrollment: () => ({ ...enrollment, state: 'active' }) as unknown as DeviceEnrollmentRecord,
    call: request =>
      requestS1(
        'https://example.com/api/matrix/v1',
        { kind: 'native-ssh', request },
        'owner-fixture-session',
        AbortSignal.timeout(1000),
        http
      ),
    system
  })
  return { service, system, http, disk: () => disk, saved: () => saved }
}
const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})
describe('native SSH owner route', () => {
  it('prepares once, refreshes authorized keys, enrolls with the existing epoch and no secret in HTTP after prepare', async () => {
    const f = fixture()
    await f.service.refresh()
    await f.service.refresh()
    expect(f.service.status().status).toBe('connected')
    expect(f.system.saveToken).toHaveBeenCalledWith(enrollment.deviceServiceId, secret)
    const requests = f.http.mock.calls.map(([, init]) => JSON.parse(init.body))
    expect(requests.filter(body => body.operation === 'ssh_prepare')).toHaveLength(1)
    expect(requests.find(body => body.operation === 'ssh_enroll')).toEqual({ ...enrollment, host })
    expect(JSON.stringify(requests)).not.toContain(secret)
    expect(JSON.stringify(f.service.status())).not.toContain(secret)
  })
  it('does not prepare or enroll with Remote Login off; enabling requires the explicit action', async () => {
    const f = fixture()
    vi.mocked(f.system.ready).mockResolvedValue({ remoteLogin: false, user: 'owner', hostKey: '' })
    await f.service.refresh()
    expect(f.service.status().status).toBe('needs_remote_login')
    expect(f.http).not.toHaveBeenCalled()
    expect(f.system.enableRemoteLogin).not.toHaveBeenCalled()
    await f.service.enableRemoteLogin()
    expect(f.system.enableRemoteLogin).toHaveBeenCalledOnce()
    await f.service.disconnect()
  })
  it('revoke removes keys, token and agent; automatic reconciliation respects disconnect', async () => {
    const f = fixture()
    await f.service.refresh()
    await f.service.disconnect()
    await f.service.start()
    expect(f.disk()).toBe('ssh-ed25519 user-owned-line\n')
    expect(f.saved()).toBeNull()
    expect(f.system.stop).toHaveBeenCalled()
    expect(f.http.mock.calls.some(([, init]) => JSON.parse(init.body).operation === 'ssh_revoke')).toBe(true)
    expect(f.system.start).toHaveBeenCalledOnce()
  })
  it('cleans local access even when remote revoke fails', async () => {
    const f = fixture()
    await f.service.refresh()
    f.http.mockRejectedValue(new Error('offline'))
    await expect(f.service.disconnect()).rejects.toThrow('cleanup_pending')
    expect(f.saved()).toBeNull()
    expect(f.service.status().status).toBe('error')
    expect(f.disk()).toBe('ssh-ed25519 user-owned-line\n')
  })
  it('refuses malformed key responses and removes previous access without exposing errors', async () => {
    const f = fixture()
    await f.service.refresh()
    f.http.mockRejectedValue(new Error(secret))
    await f.service.refresh()
    expect(f.service.status().status).toBe('error')
    expect(f.disk()).not.toContain(authorized[0].publicKey)
    expect(JSON.stringify(f.service.status())).not.toContain(secret)
  })
})
it('managed block refresh/removal preserves surrounding user bytes', () => {
  const original = '# own key\nuser-key\n'
  const first = managedKeys(original, [authorized[0].publicKey]) + '# after\n'
  expect(first).toContain('no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519')
  expect(managedKeys(first, [])).toBe(original + '# after\n')
  const rotated = authorized[0].publicKey.slice(0, -1) + 'I'
  const updated = managedKeys(first, [rotated])
  expect(updated).toContain(rotated)
  expect(updated).not.toContain(authorized[0].publicKey)
  expect(managedKeys(updated, [])).toBe(original + '# after\n')
  expect(managedKeys(managedKeys(original, [authorized[0].publicKey]), [authorized[0].publicKey])).toBe(
    managedKeys(original, [authorized[0].publicKey])
  )
  expect(() => managedKeys('# BEGIN ATUM MANAGED SSH KEYS\n', [])).toThrow()
})
it('real temp filesystem keeps modes and user lines; mocked launchctl writes no token', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'atum-native-ssh-'))
  homes.push(home)
  await mkdir(path.join(home, '.ssh'))
  await writeFile(path.join(home, '.ssh/authorized_keys'), '# user\n')
  const run = vi.fn(async () => ({ stdout: '', stderr: '' })) as any
  const system = createNativeSshSystem({
    home,
    run,
    helper: async () => '/test/cloudflared',
    metricsPort: async () => 24193
  })
  await system.keys([authorized[0].publicKey])
  await system.start(enrollment.deviceServiceId)
  const keyFile = path.join(home, '.ssh/authorized_keys')
  expect((await stat(keyFile)).mode & 0o777).toBe(0o600)
  expect((await stat(path.join(home, '.ssh'))).mode & 0o777).toBe(0o700)
  const root = path.join(home, 'Library/Application Support/Atum/native-ssh')
  const wrapper = await readFile(path.join(root, 'run.sh'), 'utf8')
  expect(wrapper).toContain('find-generic-password')
  expect(wrapper).toContain('--token-file /dev/stdin')
  expect(wrapper).not.toContain(secret)
  const plist = await readFile(path.join(home, 'Library/LaunchAgents/com.atum.desktop.native-ssh.plist'), 'utf8')
  expect(plist).not.toContain(secret)
  expect(JSON.stringify(run.mock.calls)).not.toContain(secret)
  await system.keys([])
  await system.stop()
  expect(await readFile(keyFile, 'utf8')).toBe('# user\n')
  await expect(stat(path.join(root, 'run.sh'))).rejects.toThrow()
  await system.enableRemoteLogin()
  expect(run.mock.calls.some((call: any[]) => call[0] === '/usr/bin/osascript')).toBe(true)
})

it('writes the Keychain password through stdin only, never argv or disk', async () => {
  const { EventEmitter } = await import('node:events')
  const home = await mkdtemp(path.join(tmpdir(), 'atum-native-secret-'))
  homes.push(home)
  const stdin = { on: vi.fn(), end: vi.fn() }
  const launch = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdin, kill: vi.fn() })
    queueMicrotask(() => child.emit('close', 0))
    return child
  })
  const run = vi.fn(async () => ({ stdout: secret, stderr: '' }))
  const system = createNativeSshSystem({ home, run: run as any, spawnKeychain: launch as any })
  await system.saveToken(enrollment.deviceServiceId, secret)
  expect(stdin.end).toHaveBeenCalledWith(expect.stringContaining(secret))
  expect(JSON.stringify(launch.mock.calls)).not.toContain(secret)
  expect(JSON.stringify(run.mock.calls)).not.toContain(secret)
  const { readdir } = await import('node:fs/promises')
  expect(await readdir(home)).toEqual([])
})
