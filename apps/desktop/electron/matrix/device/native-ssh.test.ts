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
const host = enrollment.host
const secret = 'test-only-token'

it('retries the legacy authorized-keys shape only on HTTP 400', async () => {
  const f = fixture()
  const original = f.http.getMockImplementation()!

  f.http.mockImplementation(async (url, init) => {
    const body = JSON.parse(init.body)

    if (body.operation === 'ssh_authorized_keys' && body.deviceServiceId) {
      return Response.json({ error: 'invalid' }, { status: 400 })
    }

    return original(url, init)
  })
  await f.service.start()
  expect(requests(f).filter(row => row.operation === 'ssh_authorized_keys')).toEqual([
    { operation: 'ssh_authorized_keys', deviceServiceId: enrollment.deviceServiceId, enrollmentEpoch: enrollment.enrollmentEpoch },
    { operation: 'ssh_authorized_keys' }
  ])
  expect(f.service.status().status).toBe('needs_full_disk_access_hint')
  await f.service.disconnect()
})

it.each([401, 403, 500])('does not retry authorized keys on HTTP %s', async status => {
  const f = fixture()
  const original = f.http.getMockImplementation()!

  f.http.mockImplementation(async (url, init) => {
    if (JSON.parse(init.body).operation === 'ssh_authorized_keys') {
      return Response.json({ error: 'denied' }, { status })
    }

    return original(url, init)
  })
  await f.service.refresh()
  expect(requests(f).filter(row => row.operation === 'ssh_authorized_keys')).toHaveLength(1)
  expect(f.service.status().status).toBe('error')
})

function mockSettings() {
  const values = new Map<string, string>()

  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    })
  }
}

function fixture(settings = mockSettings(), initialToken: string | null = null, log = vi.fn()) {
  const setPlanFactsEnabled = vi.fn(async (_deviceServiceId: string, _enabled: boolean) => {})
  let record = { ...enrollment, ownerUserId: '@owner:example.com', matrixDeviceId: 'MAC-FIXTURE', state: 'active' } as unknown as DeviceEnrollmentRecord
  let saved: string | null = initialToken
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
        host,
        tunnelToken: secret
      },
      ssh_authorized_keys: authorized,
      ssh_enroll: {
        ...enrolled,
        deviceServiceId: record.deviceServiceId,
        nativeSsh: {
          ...enrolled.nativeSsh,
          host,
          epoch: record.enrollmentEpoch
        }
      },
      ssh_revoke: revoked
    }[body.operation as string]

    return Response.json(answer)
  })

  const service = new NativeMacSsh({
    enrollment: () => record,
    setPlanFactsEnabled,
    call: request =>
      requestS1(
        'https://example.com/api/matrix/v1',
        { kind: 'native-ssh', request },
        'owner-fixture-session',
        AbortSignal.timeout(1000),
        http
      ),
    system,
    settings,
    log
  })

  return {
    service,
    system,
    http,
    settings,
    log,
    setPlanFactsEnabled,
    setEnrollment: (next: DeviceEnrollmentRecord) => {
      record = { ...record, ...next }
    },
    disk: () => disk,
    saved: () => saved
  }
}

const routeKey = `native-ssh:route:@owner:example.com:MAC-FIXTURE:${enrollment.deviceServiceId}`
const requests = (f: ReturnType<typeof fixture>) => f.http.mock.calls.map(([, init]) => JSON.parse(init.body))

it('reuses the prepared canonical route and credential after process restart and epoch rotation', async () => {
  const settings = mockSettings()
  const first = fixture(settings)
  await first.service.refresh()
  const restarted = fixture(settings, first.saved())
  await restarted.service.refresh()
  expect(requests(restarted).some(row => row.operation === 'ssh_prepare')).toBe(false)
  expect(requests(restarted).find(row => row.operation === 'ssh_enroll')).toMatchObject({ host, hostKey: enrollment.hostKey })
  restarted.setEnrollment({ ...enrollment, state: 'active', enrollmentEpoch: enrollment.enrollmentEpoch + 1 } as DeviceEnrollmentRecord)
  await restarted.service.refresh()
  expect(requests(restarted).filter(row => row.operation === 'ssh_enroll').map(row => row.enrollmentEpoch)).toEqual([3, 4])
  expect(requests(restarted).some(row => row.operation === 'ssh_prepare')).toBe(false)
  expect(restarted.system.saveToken).not.toHaveBeenCalled()
})

it.each(['NM', 'Nm_User-01', 'owner', '_service', 'N' + 'm'.repeat(31)])(
  'preserves the exact safe OS login %s through enrollment, refresh and restart', async user => {
    const settings = mockSettings()
    const first = fixture(settings)
    vi.mocked(first.system.ready).mockResolvedValue({ remoteLogin: true, user, hostKey: enrollment.hostKey })
    await first.service.refresh()
    await first.service.refresh()
    expect(first.service.status().status).toBe('needs_full_disk_access_hint')
    expect(requests(first).filter(row => row.operation === 'ssh_enroll')).toEqual([{ ...enrollment, host, user }])

    const restarted = fixture(settings, first.saved())
    vi.mocked(restarted.system.ready).mockResolvedValue({ remoteLogin: true, user, hostKey: enrollment.hostKey })
    await restarted.service.refresh()
    expect(requests(restarted).map(row => row.operation)).toEqual(['ssh_authorized_keys', 'ssh_enroll'])
    expect(requests(restarted).find(row => row.operation === 'ssh_enroll')).toEqual({ ...enrollment, host, user })
    expect(restarted.system.saveToken).not.toHaveBeenCalled()
  }
)

it('re-enrolls when OS login spelling changes without preparing another route', async () => {
  const f = fixture()
  vi.mocked(f.system.ready).mockResolvedValue({ remoteLogin: true, user: 'NM', hostKey: enrollment.hostKey })
  await f.service.refresh()
  vi.mocked(f.system.ready).mockResolvedValue({ remoteLogin: true, user: 'nm', hostKey: enrollment.hostKey })
  await f.service.refresh()
  expect(requests(f).filter(row => row.operation === 'ssh_enroll').map(row => row.user)).toEqual(['NM', 'nm'])
  expect(requests(f).filter(row => row.operation === 'ssh_prepare')).toHaveLength(1)
})

it.each([
  '', 'N'.repeat(33), '-NM', '1NM', ' NM', 'NM ', 'NM\n', 'owner\n', 'NM\r\n',
  'NM\0', 'NM\t', 'N M', 'NM@host', 'NM/other', 'NM:other', 'NM;id',
  'NM$(id)', 'NM`id`', 'NM"', "NM'", 'NM\\other', 'NΜ',
])('rejects unsafe OS login %j before prepare or enrollment', async user => {
  const f = fixture()
  vi.mocked(f.system.ready).mockResolvedValue({ remoteLogin: true, user, hostKey: enrollment.hostKey })
  await f.service.refresh()
  expect(f.service.status()).toMatchObject({ status: 'error', reason: 'native_ssh_setup_failed' })
  expect(f.http).not.toHaveBeenCalled()
  expect(f.system.saveToken).not.toHaveBeenCalled()
  expect(f.system.start).not.toHaveBeenCalled()
  expect(f.system.keys).toHaveBeenCalledWith([])
  expect(f.system.stop).toHaveBeenCalled()
})

it('still refuses an invalid host key with the uppercase OS login', async () => {
  const f = fixture()
  vi.mocked(f.system.ready).mockResolvedValue({ remoteLogin: true, user: 'NM', hostKey: 'invalid' })
  await f.service.refresh()
  expect(f.service.status().status).toBe('error')
  expect(f.http).not.toHaveBeenCalled()
  expect(f.system.start).not.toHaveBeenCalled()
})

it('retries authenticated prepare after relaunch with a legacy token and a transient registry failure', async () => {
  vi.useFakeTimers()
  const f = fixture(mockSettings(), secret)
  f.http.mockImplementationOnce(async () => Response.json({ details: { reason: 'mac_route_unavailable' } }, { status: 503 }))

  try {
    await f.service.start()
    expect(f.service.status()).toMatchObject({ status: 'error', code: 'device_registry_503_mac_route_unavailable' })
    expect(f.saved()).toBe(secret)
    expect(f.system.start).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.service.status().status).toBe('needs_full_disk_access_hint')
    expect(requests(f).map(row => row.operation)).toEqual(['ssh_prepare', 'ssh_prepare', 'ssh_authorized_keys', 'ssh_enroll'])
    expect(f.log).toHaveBeenCalledWith('native-ssh setup registered and tunnel job started')
  } finally {
    await f.service.disconnect()
    vi.useRealTimers()
  }
})

it('clears route metadata on revoke and prepares a fresh canonical route on reconnect', async () => {
  const f = fixture()
  await f.service.refresh()
  await f.service.disconnect()
  // The fixture enrollment only supplies the signed-in scope fields it needs.
  expect([...f.settings.setItem.mock.calls].at(-1)?.[1]).toBe('null')
  const nextHost = 'mac-fedcba9876543210fedcba9876543210.atumplatform.com'
  const original = f.http.getMockImplementation()!
  f.http.mockImplementation(async (url, init) => JSON.parse(init.body).operation === 'ssh_prepare'
    ? Response.json({ deviceServiceId: enrollment.deviceServiceId, host: nextHost, tunnelToken: secret }) : original(url, init))
  await f.service.start(true)
  expect(requests(f).filter(row => row.operation === 'ssh_enroll').at(-1)).toMatchObject({ host: nextHost })
  await f.service.disconnect()
})

it.each([null, {}, { deviceServiceId: 'foreign', host }, ...[
  'a.mac.atumplatform.com', 'mac-0123456789abcdef0123456789abcdef.atumplatform.com.evil.test',
  'mac-0123456789abcdef0123456789abcdef.atumplatform.com\n',
  'https://mac-0123456789abcdef0123456789abcdef.atumplatform.com',
  'mac-label.atumplatform.com', '127.0.0.1',
].map(host => ({ deviceServiceId: enrollment.deviceServiceId, host }))])('rejects malformed or foreign prepare response %# before saving or launching', async response => {
  const f = fixture()
  f.http.mockImplementationOnce(async () => Response.json(response && { ...response, tunnelToken: secret }))
  await f.service.refresh()
  expect(f.service.status().status).toBe('error')
  expect(f.system.saveToken).not.toHaveBeenCalled()
  expect(f.system.start).not.toHaveBeenCalled()
  expect(requests(f).some(row => row.operation === 'ssh_enroll')).toBe(false)
})

it('does not reuse metadata for another owner or a different credential', async () => {
  const settings = mockSettings()
  const first = fixture(settings)
  await first.service.refresh()
  const foreign = fixture(settings, first.saved())
  foreign.setEnrollment({ ...enrollment, ownerUserId: '@foreign:example.com', state: 'active' } as DeviceEnrollmentRecord)
  foreign.http.mockImplementationOnce(async () => Response.json({}, { status: 404 }))
  await foreign.service.refresh()
  expect(requests(foreign).map(row => row.operation)).toEqual(['ssh_prepare'])
  expect(foreign.system.start).not.toHaveBeenCalled()
  expect(foreign.saved()).toBe(secret)
  const rotated = fixture(settings, 'another-test-credential')
  await rotated.service.refresh()
  expect(requests(rotated)[0].operation).toBe('ssh_prepare')
  expect(rotated.system.removeToken).not.toHaveBeenCalled()
})

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
      expect(f.service.status().status).toBe('set_up')
      await vi.advanceTimersByTimeAsync(60_000)
      await f.service.refresh()
      expect(f.service.status().status).toBe('set_up')
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
    expect(f.log).toHaveBeenCalledWith('native-ssh setup waiting: remote_login_unavailable (localhost:22)')
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
    await f.service.start(true)
    expect(f.service.status().status).toBe('set_up')
    expect(f.service.fullDiskAccessHint().status).toBe('set_up')
    await f.service.refresh()
    expect(f.service.status().status).toBe('set_up')
    f.service.acknowledgeFullDiskAccessHint()
    expect(f.service.status().status).toBe('set_up')
    await f.service.disconnect()
  })
  it('restores acknowledgement from local settings after an app restart', async () => {
    const settings = mockSettings()
    const first = fixture(settings)
    await first.service.refresh()
    first.service.acknowledgeFullDiskAccessHint()
    expect(settings.setItem).toHaveBeenCalledWith(
      `native-ssh:full-disk-access-hint:${enrollment.deviceServiceId}:${enrollment.enrollmentEpoch}`,
      'acknowledged'
    )
    const restarted = fixture(settings)
    await restarted.service.refresh()
    expect(restarted.service.status().status).toBe('set_up')
    expect(restarted.service.fullDiskAccessHint().status).toBe('set_up')
  })
  it('offers an unacknowledged hint again after restart', async () => {
    const settings = mockSettings()
    await fixture(settings).service.refresh()
    const restarted = fixture(settings)
    await restarted.service.refresh()
    expect(restarted.service.status().status).toBe('needs_full_disk_access_hint')
    expect(settings.setItem.mock.calls.some(([key]) => key.includes('full-disk-access-hint'))).toBe(false)
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
    expect(f.service.status().status).toBe('set_up')
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
    expect(f.settings.setItem.mock.calls.some(([key]) => key.includes('full-disk-access-hint'))).toBe(false)
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
    expect(f.service.status().status).toBe('set_up')
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

it('ignores extra relay rows while retaining shell keys and the tunnel', async () => {
  const f = fixture()
  const original = f.http.getMockImplementation()!
  f.http.mockImplementation(async (url, init) => JSON.parse(init.body).operation === 'ssh_authorized_keys'
    ? Response.json([{ ...authorized[0], purpose: 'shell' }, { ...authorized[0], publicKey: authorized[0].publicKey.slice(0, -1) + 'I', purpose: 'relay' }])
    : original(url, init))
  await f.service.refresh()
  expect(f.service.status().status).toBe('needs_full_disk_access_hint')
  expect(f.system.stop).not.toHaveBeenCalled()
  expect(f.system.start).toHaveBeenCalled()
  expect(f.disk()).toContain(authorized[0].publicKey)
  expect(f.disk()).not.toContain('command=')
})

it('shell rows install as shell keys only, and an old relay block is replaced by them (no helper named anywhere)', () => {
  const key = authorized[0].publicKey
  const old = `# BEGIN ATUM MANAGED SSH KEYS\ncommand="'/x/atum-chatgpt-relay' a b 4",no-pty ${key}\n# END ATUM MANAGED SSH KEYS\n`

  expect(managedKeys(old, [key])).toBe(`# BEGIN ATUM MANAGED SSH KEYS\nno-agent-forwarding,no-port-forwarding,no-X11-forwarding ${key}\n# END ATUM MANAGED SSH KEYS\n`)
  expect(managedKeys(old, [])).toBe('')
  expect(() => managedKeys('', [{ purpose: 'relay', publicKey: key } as unknown as string])).toThrow()
})


it('requests the platform shell-only projection', async () => {
  const f = fixture()
  await f.service.refresh()
  const requests = f.http.mock.calls.map(([, init]) => JSON.parse(init.body))
  expect(requests).toContainEqual({ operation: 'ssh_authorized_keys', deviceServiceId: enrollment.deviceServiceId, enrollmentEpoch: enrollment.enrollmentEpoch })
  expect(f.disk()).toContain(`no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${authorized[0].publicKey}`)
})

it('ignores unknown purposes before installing authorized keys', async () => {
  const f = fixture()
  const original = f.http.getMockImplementation()!
  f.http.mockImplementation(async (url, init) => JSON.parse(init.body).operation === 'ssh_authorized_keys'
    ? Response.json([{ ...authorized[0], purpose: 'unknown' }])
    : original(url, init))
  await f.service.refresh()
  expect(f.service.status().status).toBe('needs_full_disk_access_hint')
  expect(f.system.stop).not.toHaveBeenCalled()
  expect(f.disk()).toBe('ssh-ed25519 user-owned-line\n')
})

it.each([
  null, {},
  { deviceServiceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', host, tunnelToken: secret },
  ...['a.mac.atumplatform.com', 'mac-0123456789abcdef0123456789abcdef.attacker.com',
    `${host}.attacker.com`, `${host}\n`, `ssh://${host}`, `${host}:22`,
    'mac-0123456789abcdef0123456789abcdef.atumplatform.com/path',
    'mac-not-an-opaque-label.atumplatform.com'].map(host => ({ deviceServiceId: enrollment.deviceServiceId, host, tunnelToken: secret }))
])('refuses malformed or foreign prepare metadata before saving or enrolling %#', async prepared => {
  const f = fixture()
  f.http.mockImplementationOnce(async () => Response.json(prepared))
  await f.service.refresh()
  expect(f.service.status().status).toBe('error')
  expect(f.system.saveToken).not.toHaveBeenCalled()
  expect(f.system.start).not.toHaveBeenCalled()
  expect(requests(f).map(row => row.operation)).toEqual(['ssh_prepare'])
})

it('prepares under the active device when the token or cached metadata was replaced', async () => {
  const settings = mockSettings()
  const first = fixture(settings)
  await first.service.refresh()
  const replaced = fixture(settings, 'different-test-credential')
  await replaced.service.refresh()
  expect(requests(replaced).map(row => row.operation)).toEqual(['ssh_prepare', 'ssh_authorized_keys', 'ssh_enroll'])
  expect(replaced.service.status().status).toBe('needs_full_disk_access_hint')
  settings.setItem(routeKey, '{')
  const corrupt = fixture(settings, first.saved())
  await corrupt.service.refresh()
  expect(requests(corrupt).map(row => row.operation)).toEqual(['ssh_prepare', 'ssh_authorized_keys', 'ssh_enroll'])
  expect(corrupt.service.status().status).toBe('needs_full_disk_access_hint')
})

it('does not reuse another owner or Matrix device route and clears metadata on enrollment revoke', async () => {
  const settings = mockSettings()
  const first = fixture(settings)
  await first.service.refresh()

  for (const scope of [{ ownerUserId: '@foreign:example.com' }, { matrixDeviceId: 'OTHER-MAC' }]) {
    const other = fixture(settings, first.saved())
    other.setEnrollment({ ...enrollment, state: 'active', ...scope } as DeviceEnrollmentRecord)
    await other.service.refresh()
    expect(requests(other)[0]).toMatchObject({ operation: 'ssh_prepare', deviceServiceId: enrollment.deviceServiceId })
  }

  first.setEnrollment({ ...enrollment, state: 'revoked' } as DeviceEnrollmentRecord)
  await first.service.refresh()
  expect(first.saved()).toBeNull()
  expect(settings.getItem(routeKey)).toBe('null')
  expect(first.disk()).toBe('ssh-ed25519 user-owned-line\n')
})

it('does not replace the token when metadata persistence fails and retries setup', async () => {
  const f = fixture()
  f.settings.setItem.mockImplementationOnce(() => { throw new Error('storage unavailable') })
  await f.service.refresh()
  expect(f.service.status().status).toBe('error')
  expect(f.saved()).toBeNull()
  await f.service.refresh()
  expect(requests(f).filter(row => row.operation === 'ssh_prepare')).toHaveLength(2)
  expect(f.service.status().status).toBe('needs_full_disk_access_hint')
})

it('re-prepares on the next reconciliation when the registry withdrew the cached host', async () => {
  const f = fixture()
  const original = f.http.getMockImplementation()!
  let reject = true

  f.http.mockImplementation(async (url, init) => JSON.parse(init.body).operation === 'ssh_enroll' && reject
    ? Response.json({ details: { reason: 'not_prepared' } }, { status: 403 })
    : original(url, init))
  await f.service.refresh()
  expect(f.service.status().code).toBe('device_registry_403_not_prepared')
  expect(f.settings.getItem(routeKey)).toBe('null')
  reject = false
  await f.service.refresh()
  expect(requests(f).filter(row => row.operation === 'ssh_prepare')).toHaveLength(2)
  expect(f.service.status().status).toBe('needs_full_disk_access_hint')
})

/** Answer one owner operation differently, leaving the rest of the fixture in place. */
function answer(f: ReturnType<typeof fixture>, operation: string, response: () => Response) {
  const original = f.http.getMockImplementation()!

  f.http.mockImplementation(async (url, init) =>
    JSON.parse(init.body).operation === operation ? response() : original(url, init)
  )
}

describe('native SSH setup failures name the step and a safe code', () => {
  it('names prepare and the refused status when the account will not prepare the route', async () => {
    const f = fixture()
    f.http.mockImplementationOnce(async () => Response.json({ details: { reason: 'mac_route_unavailable' } }, { status: 503 }))
    await f.service.refresh()
    expect(f.service.status()).toMatchObject({
      status: 'error',
      reason: 'native_ssh_setup_failed',
      step: 'prepare',
      code: 'device_registry_503_mac_route_unavailable'
    })
    expect(f.log).toHaveBeenCalledWith('native-ssh setup failed at prepare: device_registry_503_mac_route_unavailable')
    expect(f.system.start).not.toHaveBeenCalled()
  })

  it('names authorized_keys when the account refuses the key list for the purposes request', async () => {
    const f = fixture()
    answer(f, 'ssh_authorized_keys', () => Response.json({ details: { reason: 'invalid' } }, { status: 400 }))
    await f.service.refresh()
    expect(f.service.status()).toMatchObject({ step: 'authorized_keys', code: 'device_registry_400_invalid' })
    expect(f.log).toHaveBeenCalledWith('native-ssh setup failed at authorized_keys: device_registry_400_invalid')
    expect(f.system.start).not.toHaveBeenCalled()
    expect(requests(f).some(row => row.operation === 'ssh_enroll')).toBe(false)
  })

  it('names authorized_keys and the session code when the owner session is no longer authorised', async () => {
    const f = fixture()
    answer(f, 'ssh_authorized_keys', () => new Response('', { status: 401 }))
    await f.service.refresh()
    expect(f.service.status()).toMatchObject({ step: 'authorized_keys', code: 'matrix_s1_authentication' })
    expect(f.system.start).not.toHaveBeenCalled()
    expect(requests(f).some(row => row.operation === 'ssh_enroll')).toBe(false)
  })

  it('drops an unrecognized reason from the registry response', async () => {
    const f = fixture()
    const privateReason = 'fixture_secret_value'
    f.http.mockImplementationOnce(async () => Response.json({ details: { reason: privateReason } }, { status: 503 }))
    await f.service.refresh()
    expect(f.service.status()).toMatchObject({ step: 'prepare', code: 'device_registry_503' })
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(privateReason)
  })

  it('names write_keys when the SSH files cannot be written', async () => {
    const f = fixture()
    vi.mocked(f.system.keys).mockRejectedValueOnce(new Error('native_ssh_file_failed'))
    await f.service.refresh()
    expect(f.service.status()).toMatchObject({ step: 'write_keys', code: 'native_ssh_file_failed' })
    expect(f.log).toHaveBeenCalledWith('native-ssh setup failed at write_keys: native_ssh_file_failed')
    expect(f.system.start).not.toHaveBeenCalled()
    expect(f.disk()).toBe('ssh-ed25519 user-owned-line\n')
  })

  it('names start_tunnel and the OS error code when launchd setup fails', async () => {
    const f = fixture()
    vi.mocked(f.system.start).mockRejectedValueOnce(Object.assign(new Error(`launchctl ${host}`), { code: 'EACCES' }))
    await f.service.refresh()
    expect(f.service.status()).toMatchObject({ step: 'start_tunnel', code: 'EACCES' })
    expect(f.log).toHaveBeenCalledWith('native-ssh setup failed at start_tunnel: EACCES')
    expect(requests(f).some(row => row.operation === 'ssh_enroll')).toBe(false)
  })

  it('names enroll and the refused status when registration is refused', async () => {
    const f = fixture()
    answer(f, 'ssh_enroll', () => new Response('', { status: 500 }))
    await f.service.refresh()
    expect(f.service.status()).toMatchObject({ step: 'enroll', code: 'device_registry_500' })
    expect(f.log).toHaveBeenCalledWith('native-ssh setup failed at enroll: device_registry_500')
    // The failure still clears managed keys and stops the tunnel it just started.
    expect(f.disk()).toBe('ssh-ed25519 user-owned-line\n')
    expect(f.system.stop).toHaveBeenCalled()
  })

  it.each([
    [() => Object.assign(new Error(secret), { code: secret }), 'unknown'],
    [() => new Error(`GET https://${host}?token=${secret}`), 'unknown'],
    [() => Object.assign(new Error('fixture_secret_value'), { code: 'FIXTURE_SECRET_VALUE' }), 'unknown']
  ])('keeps credentials and process text out of the view and the log %#', async (thrown, code) => {
    const f = fixture()
    vi.mocked(f.system.start).mockRejectedValueOnce(thrown())
    await f.service.refresh()
    expect(f.service.status()).toMatchObject({ status: 'error', step: 'start_tunnel', code })
    expect(JSON.stringify(f.service.status())).not.toContain(secret)
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(host)
    expect(JSON.stringify(f.log.mock.calls).toLowerCase()).not.toContain('fixture_secret_value')
  })
})

describe('disconnect leaves this Mac ready to connect from scratch', () => {
  it('clears the token, the route metadata and the managed keys, then prepares a fresh route', async () => {
    const f = fixture()
    await f.service.refresh()
    expect(f.saved()).toBe(secret)
    await f.service.disconnect()
    expect(f.service.status()).toMatchObject({ status: 'not_connected' })
    expect(f.saved()).toBeNull()
    expect(f.settings.getItem(routeKey)).toBe('null')
    expect(f.disk()).toBe('ssh-ed25519 user-owned-line\n')
    expect(f.system.start).toHaveBeenCalledOnce()

    await f.service.start(true)
    expect(f.service.status().status).toBe('needs_full_disk_access_hint')
    expect(requests(f).filter(row => row.operation === 'ssh_prepare')).toHaveLength(2)
    expect(f.saved()).toBe(secret)
    await f.service.disconnect()
  })

  it('keeps the account connection off on passive refresh and after restarting', async () => {
    const f = fixture()
    await f.service.start()
    const disconnect = f.service.disconnect({ accountConnection: true })
    const focus = f.service.start()
    await Promise.all([disconnect, focus])
    expect(f.service.status().status).toBe('not_connected')
    expect(f.system.start).toHaveBeenCalledOnce()
    expect(f.setPlanFactsEnabled).toHaveBeenCalledWith(enrollment.deviceServiceId, false)

    const restarted = fixture(f.settings)
    await restarted.service.start()
    expect(restarted.service.status().status).toBe('not_connected')
    expect(restarted.http).not.toHaveBeenCalled()

    await restarted.service.start(true)
    expect(restarted.service.status().status).toBe('needs_full_disk_access_hint')
    expect(restarted.setPlanFactsEnabled).toHaveBeenCalledWith(enrollment.deviceServiceId, true)
    await restarted.service.disconnect()
  })

  it('lets a failed fact withdrawal retry without reopening native reach', async () => {
    const f = fixture()
    await f.service.start()
    f.setPlanFactsEnabled.mockRejectedValueOnce(new Error(secret))
    await expect(f.service.disconnect({ accountConnection: true })).rejects.toThrow('native_ssh_cleanup_pending')
    expect(f.saved()).toBeNull()
    await f.service.start()
    await f.service.start(true)
    expect(f.system.start).toHaveBeenCalledOnce()

    await f.service.disconnect({ accountConnection: true })
    expect(f.service.status().status).toBe('not_connected')
    expect(f.setPlanFactsEnabled).toHaveBeenCalledTimes(2)
  })

  it('keeps the reason when cleaning up is still pending, and can be retried', async () => {
    const f = fixture()
    await f.service.refresh()
    f.http.mockRejectedValueOnce(new Error(secret))
    await expect(f.service.disconnect()).rejects.toThrow('native_ssh_cleanup_pending')
    expect(f.service.status()).toMatchObject({ status: 'error', reason: 'native_ssh_cleanup_pending', code: 'native_ssh_cleanup_pending' })
    await f.service.disconnect()
    expect(f.service.status()).toMatchObject({ status: 'not_connected' })
  })
})
