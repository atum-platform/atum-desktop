import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as oidc from 'openid-client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { EncryptedStore } from '../encrypted-store'

import { MatrixAccount } from './account'
import { matrixConfigurationKey } from './config'
import { matrixDiskReserve } from './disk-reserve'

vi.mock('openid-client', () => ({
  discovery: vi.fn(async () => ({})),
  None: () => ({}),
  allowInsecureRequests: () => {},
  refreshTokenGrant: vi.fn(),
  tokenRevocation: vi.fn(async () => {}),
  ResponseBodyError: class extends Error {
    constructor(public error: string) {
      super(error)
    }
  }
}))

/**
 * The Mac mini on 2026-10-04 , on a real full
 * disk: this Mac's userData on a 1 MB disk image, filled until writes fail with ENOSPC, then the
 * routine token rotation that ended its session. macOS only; skipped where a disk image can't
 * be mounted.
 */
const HDIUTIL = '/usr/bin/hdiutil'
let root: string | undefined
let userData: string | undefined

beforeAll(() => {
  if (process.platform !== 'darwin' || !existsSync(HDIUTIL)) {
    return
  }

  root = mkdtempSync(path.join(tmpdir(), 'atum-disk-full-'))
  const image = path.join(root, 'userData.dmg')
  const mount = path.join(root, 'userData')

  try {
    execFileSync(HDIUTIL, ['create', '-size', '1m', '-fs', 'HFS+', '-volname', 'AtumFull', '-layout', 'NONE', image], {
      stdio: 'ignore',
      timeout: 30_000
    })
    execFileSync(HDIUTIL, ['attach', '-nobrowse', '-noverify', '-noautoopen', '-mountpoint', mount, image], {
      stdio: 'ignore',
      timeout: 30_000
    })
    userData = mount
  } catch {
    userData = undefined
  }
  // hdiutil can take well over vitest's 10 s hook default on a busy Mac.
}, 90_000)

afterAll(() => {
  if (userData) {
    try {
      execFileSync(HDIUTIL, ['detach', userData, '-force'], { stdio: 'ignore', timeout: 30_000 })
    } catch {
      // Detaching is best effort; the image goes with the temporary folder.
    }
  }

  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

const config = {
  issuer: 'https://id.test',
  server: 'https://matrix.test',
  nativeClientId: 'client',
  callbackPort: 21881
}

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString()
}

/** The vault in userData, as main makes it, holding the person's saved sign-in. */
function vault(directory: string, name: string) {
  const file = path.join(directory, `${name}.json`)
  const store = new EncryptedStore(file, safeStorage)

  store.setItem(
    'matrix-account',
    JSON.stringify({
      version: 1,
      configurationKey: matrixConfigurationKey(config),
      issuer: config.issuer,
      subject: 'subject',
      userId: '@owner:test',
      deviceId: 'MINI',
      storageKey: Buffer.alloc(32, 7).toString('base64'),
      accessToken: 'saved-access',
      refreshToken: 'saved-refresh'
    })
  )

  return { file, store, saved: () => JSON.parse(new EncryptedStore(file, safeStorage).getItem('matrix-account')!) }
}

/** Fills the volume until a write fails with ENOSPC; returns the filler to delete. */
function fill(directory: string): string {
  const filler = path.join(directory, `filler-${Date.now()}`)
  const fd = openSync(filler, 'w')
  const chunk = Buffer.alloc(4096, 1)

  try {
    for (;;) {
      writeSync(fd, chunk)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOSPC') {
      throw error
    }
  } finally {
    closeSync(fd)
  }

  return filler
}

describe('a full disk at the moment the sign-in server rotates the chat tokens', () => {
  it('holds the rotation (never revoked, never handed out) and saves it once there is room', async ctx => {
    if (!userData) {
      return ctx.skip()
    }

    const directory = userData
    const { store, saved } = vault(directory, 'rotation')
    const log = vi.fn()
    const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log)
    const owner = account.identity()
    const handle = account.sdkConfiguration().refreshToken
    vi.useFakeTimers()
    const filler = fill(directory)

    expect(() => writeFileSync(path.join(directory, 'probe'), Buffer.alloc(16_384))).toThrow(/ENOSPC/)
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({
      access_token: 'rotated-access',
      refresh_token: 'rotated-refresh',
      expires_in: 300
    } as never)

    expect(await account.refresh(handle)).toEqual({ ok: false, reauthenticate: false, cause: 'disk_full' })
    expect(log).toHaveBeenCalledWith({
      event: 'credential_save_failed',
      client: 'matrix',
      code: 'auth_storage_disk_full'
    })
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
    expect(account.identity()).toEqual(owner)
    expect(account.sessionEnded()).toBeNull()
    // The disk keeps the saved grant, still the one to rotate from after a crash; the new pair
    // waits in memory, handed to nobody, until it can be saved.
    expect(saved().refreshToken).toBe('saved-refresh')
    expect(account.sdkConfiguration().accessToken).toBe('saved-access')

    // Still full at the first retry: nothing changes, nothing is revoked.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(saved().refreshToken).toBe('saved-refresh')

    unlinkSync(filler)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(saved()).toMatchObject({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh' })
    expect(log).toHaveBeenCalledWith({ event: 'credential_saved', client: 'matrix' })
    expect(oidc.tokenRevocation).not.toHaveBeenCalled()
  })

  it('saves the rotation at once in the room kept for it, the chats never waiting', async ctx => {
    if (!userData) {
      return ctx.skip()
    }

    const directory = userData
    const { store, saved } = vault(directory, 'reserved')
    const log = vi.fn()
    // Main keeps 2 MB; this 1 MB disk gets a smaller one, made while there is room.
    const reserve = matrixDiskReserve(path.join(directory, 'credentials.reserve'), { bytes: 128 * 1024, minFreeBytes: 0 })
    reserve.ensure()
    expect(existsSync(path.join(directory, 'credentials.reserve'))).toBe(true)
    const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log, { reserve })
    const filler = fill(directory)

    try {
      expect(() => writeFileSync(path.join(directory, 'probe'), Buffer.alloc(16_384))).toThrow(/ENOSPC/)
      vi.mocked(oidc.refreshTokenGrant).mockResolvedValue({
        access_token: 'reserved-access',
        refresh_token: 'reserved-refresh',
        expires_in: 300
      } as never)

      expect(await account.refresh(account.sdkConfiguration().refreshToken)).toMatchObject({
        ok: true,
        accessToken: 'reserved-access'
      })
      expect(log).toHaveBeenCalledWith({ event: 'disk_reserve_used' })
      expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'credential_save_failed' }))
      expect(saved()).toMatchObject({ accessToken: 'reserved-access', refreshToken: 'reserved-refresh' })
      expect(existsSync(path.join(directory, 'credentials.reserve'))).toBe(false)
      expect(oidc.tokenRevocation).not.toHaveBeenCalled()
    } finally {
      unlinkSync(filler)
    }
  })

  it('refuses to start a sign-out it cannot record, revoking nothing, and logs why', async ctx => {
    if (!userData) {
      return ctx.skip()
    }

    const directory = userData
    const { store, saved } = vault(directory, 'sign-out')
    const log = vi.fn()
    const account = new MatrixAccount(config, store, async () => {}, undefined, undefined, log)
    const filler = fill(directory)

    try {
      await expect(account.signOut()).rejects.toThrow('auth_storage_disk_full')
      expect(oidc.tokenRevocation).not.toHaveBeenCalled()
      expect(saved().signingOut).toBeUndefined()
      expect(log).toHaveBeenCalledWith({ event: 'user_sign_out', result: 'pending', code: 'auth_storage_disk_full' })
    } finally {
      unlinkSync(filler)
    }
  })
})
