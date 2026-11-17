import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

function mockSettings() {
  const values = new Map<string, string>()

  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    })
  }
}

function fixture(settings = mockSettings()) {
  let record = { ...enrollment, state: 'active' } as unknown as DeviceEnrollmentRecord
  let saved: string | null = null
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
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    keys: vi.fn(async keys => {
      disk = managedKeys(disk, keys)
    })
  }

  const http = vi.fn(async (_url: any, init: any) => {
    expect(init.headers.Authorization).toBe('Bearer owner-fixture-session')
    const body = JSON.parse(init.body)

    const answer = {
      ssh_prepare: {
        deviceServiceId: record.deviceServiceId,
        host: `${record.deviceServiceId}.mac.atumplatform.com`,
        tunnelToken: secret
      },
      ssh_authorized_keys: authorized,
      ssh_enroll: {
        ...enrolled,
        deviceServiceId: record.deviceServiceId,
        nativeSsh: {
          ...enrolled.nativeSsh,
          host: `${record.deviceServiceId}.mac.atumplatform.com`,
          epoch: record.enrollmentEpoch
        }
      },
      ssh_revoke: revoked
    }[body.operation as string]

    return Response.json(answer)
  })

  const service = new NativeMacSsh({
    enrollment: () => record,
    call: request =>
      requestS1(
        'https://example.com/api/matrix/v1',
        { kind: 'native-ssh', request },
        'owner-fixture-session',
        AbortSignal.timeout(1000),
        http
      ),
    system,
    settings
  })

  return {
    service,
    system,
    http,
    settings,
    setEnrollment: (next: DeviceEnrollmentRecord) => {
      record = next
    },
    disk: () => disk,
    saved: () => saved
  }
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
    expect(f.service.status().status).toBe('needs_full_disk_access_hint')
    expect(f.system.saveToken).toHaveBeenCalledWith(enrollment.deviceServiceId, secret)
    const requests = f.http.mock.calls.map(([, init]) => JSON.parse(init.body))
    expect(requests.filter(body => body.operation === 'ssh_prepare')).toHaveLength(1)
    expect(requests.find(body => body.operation === 'ssh_enroll')).toEqual({ ...enrollment, host })
    expect(JSON.stringify(requests)).not.toContain(secret)
    expect(JSON.stringify(f.service.status())).not.toContain(secret)
  })
  it('keeps the enrollment hint through minute refreshes until Settings is acknowledged', async () => {
    vi.useFakeTimers()
    const f = fixture()

    try {
      await f.service.start()
      expect(f.service.status().status).toBe('needs_full_disk_access_hint')
      await vi.advanceTimersByTimeAsync(120_000)
      expect(f.system.keys).toHaveBeenCalledTimes(3)
      await f.service.refresh()
      expect(f.service.status().status).toBe('needs_full_disk_access_hint')
      f.service.acknowledgeFullDiskAccessHint()
      expect(f.service.status().status).toBe('connected')
      await vi.advanceTimersByTimeAsync(60_000)
      await f.service.refresh()
      expect(f.service.status().status).toBe('connected')
    } finally {
      await f.service.disconnect()
      vi.useRealTimers()
    }
  })
  it('preserves the pending hint through failures and shows operational problems first', async () => {
    const f = fixture()
    await f.service.refresh()
    vi.mocked(f.system.ready).mockResolvedValueOnce({ remoteLogin: false, user: 'owner', hostKey: '' })
    await f.service.refresh()
    expect(f.service.status().status).toBe('needs_remote_login')
    await f.service.refresh()
    expect(f.service.status().status).toBe('needs_full_disk_access_hint')
    vi.mocked(f.system.ready).mockRejectedValueOnce(new Error('unavailable'))
    await f.service.refresh()
    expect(f.service.status().status).toBe('error')
    await f.service.refresh()
    expect(f.service.status().status).toBe('needs_full_disk_access_hint')
  })
  it('keeps acknowledgement across reconnect and explicit hint requests', async () => {
    const f = fixture()
    await f.service.refresh()
    f.service.acknowledgeFullDiskAccessHint()
    await f.service.disconnect()
    await f.service.refresh()
    expect(f.service.status().status).toBe('connected')
    expect(f.service.fullDiskAccessHint().status).toBe('connected')
    await f.service.refresh()
    expect(f.service.status().status).toBe('connected')
    f.service.acknowledgeFullDiskAccessHint()
    expect(f.service.status().status).toBe('connected')
  })
  it('restores acknowledgement from local settings after an app restart', async () => {
    const settings = mockSettings()
    const first = fixture(settings)
    await first.service.refresh()
    first.service.acknowledgeFullDiskAccessHint()
    expect(settings.setItem).toHaveBeenCalledExactlyOnceWith(
      `native-ssh:full-disk-access-hint:${enrollment.deviceServiceId}:${enrollment.enrollmentEpoch}`,
      'acknowledged'
    )
    const restarted = fixture(settings)
    await restarted.service.refresh()
    expect(restarted.service.status().status).toBe('connected')
    expect(restarted.service.fullDiskAccessHint().status).toBe('connected')
  })
  it('offers an unacknowledged hint again after restart', async () => {
    const settings = mockSettings()
    await fixture(settings).service.refresh()
    const restarted = fixture(settings)
    await restarted.service.refresh()
    expect(restarted.service.status().status).toBe('needs_full_disk_access_hint')
    expect(settings.setItem).not.toHaveBeenCalled()
  })
  it('offers a fresh hint for a new enrollment epoch or device and remembers each separately', async () => {
    const f = fixture()
    const original = { ...enrollment, state: 'active' } as unknown as DeviceEnrollmentRecord
    await f.service.refresh()
    f.service.acknowledgeFullDiskAccessHint()
    f.setEnrollment({ ...original, enrollmentEpoch: original.enrollmentEpoch + 1 })
    await f.service.refresh()
    expect(f.service.status().status).toBe('needs_full_disk_access_hint')
    f.service.acknowledgeFullDiskAccessHint()
    f.setEnrollment({ ...original, deviceServiceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })
    await f.service.refresh()
    expect(f.service.status().status).toBe('needs_full_disk_access_hint')
    f.setEnrollment(original)
    await f.service.refresh()
    expect(f.service.status().status).toBe('connected')
  })
  it('does not acknowledge a different enrollment if it changes while Settings opens', async () => {
    const f = fixture()
    await f.service.refresh()
    f.setEnrollment({
      ...enrollment,
      state: 'active',
      enrollmentEpoch: enrollment.enrollmentEpoch + 1
    } as unknown as DeviceEnrollmentRecord)
    f.service.acknowledgeFullDiskAccessHint()
    expect(f.settings.setItem).not.toHaveBeenCalled()
    await f.service.refresh()
    expect(f.service.status().status).toBe('needs_full_disk_access_hint')
  })
  it('keeps the reminder pending if the settings write fails and can retry', async () => {
    const f = fixture()
    await f.service.refresh()
    f.settings.setItem.mockImplementationOnce(() => {
      throw new Error(secret)
    })
    expect(() => f.service.acknowledgeFullDiskAccessHint()).toThrow('native_ssh_hint_save_failed')
    expect(f.service.status().status).toBe('needs_full_disk_access_hint')
    f.service.acknowledgeFullDiskAccessHint()
    expect(f.service.status().status).toBe('connected')
  })
  it('offers the reminder only after a successful enrollment', async () => {
    const f = fixture()
    f.http.mockImplementationOnce(async () => Response.json({}))
    await f.service.refresh()
    f.service.acknowledgeFullDiskAccessHint()
    expect(f.service.status().status).toBe('error')
    await f.service.refresh()
    expect(f.service.status().status).toBe('needs_full_disk_access_hint')
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
    helper: async () => '/test/cloudflared'
  })

  await system.keys([authorized[0].publicKey])
  await system.start(enrollment.deviceServiceId)
  run.mockClear()
  await system.start(enrollment.deviceServiceId)
  expect(run.mock.calls).toHaveLength(1)
  expect(run.mock.calls[0][1]).toEqual(['print', expect.stringContaining('com.atum.desktop.native-ssh')])
  const keyFile = path.join(home, '.ssh/authorized_keys')
  expect((await stat(keyFile)).mode & 0o777).toBe(0o600)
  expect((await stat(path.join(home, '.ssh'))).mode & 0o777).toBe(0o700)
  const root = path.join(home, 'Library/Application Support/Atum/native-ssh')
  const plist = await readFile(path.join(home, 'Library/LaunchAgents/com.atum.desktop.native-ssh.plist'), 'utf8')
  expect(plist).toContain('--token-file')
  expect(plist).toContain('<key>KeepAlive</key><true/>')
  expect(plist).not.toContain(secret)
  expect(JSON.stringify(run.mock.calls)).not.toContain(secret)
  await system.keys([])
  await system.stop()
  expect(await readFile(keyFile, 'utf8')).toBe('# user\n')
  await expect(stat(path.join(root, 'run.sh'))).rejects.toThrow()
  await system.enableRemoteLogin()
  expect(run.mock.calls.some((call: any[]) => call[0] === '/usr/bin/osascript')).toBe(true)
})

it('protects the token file and removes it on revoke without putting it in argv', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'atum-native-secret-'))
  homes.push(home)
  const run = vi.fn(async () => ({ stdout: '', stderr: '' }))
  const system = createNativeSshSystem({ home, run: run as any })
  await system.saveToken(enrollment.deviceServiceId, secret)
  expect(await system.token(enrollment.deviceServiceId)).toBe(secret)
  const file = path.join(home, 'Library/Application Support/Atum/native-ssh', `${enrollment.deviceServiceId}.token`)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700)
  await system.removeToken(enrollment.deviceServiceId)
  expect(await system.token(enrollment.deviceServiceId)).toBeNull()
  expect(JSON.stringify(run.mock.calls)).not.toContain(secret)
})
