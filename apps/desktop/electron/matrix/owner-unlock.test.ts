import { describe, expect, it, vi } from 'vitest'

import type { MatrixOwnerStatus } from '../../shared/matrix-security'

import type { MatrixOwnerKey } from './owner-keys'
import { matrixMayAskOtherDevices, type MatrixOwnerUnlockPort, unlockMatrixOwner } from './owner-unlock'

const KEY = 'EsTc 1234 abcd EFGH ijkl MNOP qrst UVWX yz12 3456 789A BCDE'
const CLOUD = 'EsTd 9999 abcd EFGH ijkl MNOP qrst UVWX yz12 3456 789A BCDE'

/** The person's SDK, as security.ts answers: a recovery under `key-1` that `KEY` opens. */
function port(options: { status?: Partial<MatrixOwnerStatus>; kept?: MatrixOwnerKey; icloud?: string } = {}) {
  const lines: string[] = []

  const value = {
    status: vi.fn(async () => ({
      storage: 'present' as const,
      keyId: 'key-1',
      signing: false,
      deviceSigned: false,
      backup: false,
      ...options.status
    })),
    kept: vi.fn(() => options.kept),
    check: vi.fn(async (key: string) =>
      key === KEY || key === CLOUD ? { valid: true, keyId: 'key-1' } : { valid: false }
    ),
    restore: vi.fn(async () => ({ keyId: 'key-1', signed: true, backup: true })),
    retain: vi.fn(),
    assertCurrent: vi.fn(),
    log: (line: string) => lines.push(line),
    now: () => 0,
    ...(options.icloud !== undefined ? { icloud: vi.fn(async () => options.icloud) } : {})
  } satisfies MatrixOwnerUnlockPort

  return { port: value, lines }
}

const kept = (patch: Partial<MatrixOwnerKey> = {}): MatrixOwnerKey => ({
  key: KEY,
  source: 'typed',
  savedAt: 1,
  ...patch
})

describe('this Mac unlocking the person’s messages and assistants by itself', () => {
  it('never guesses before the first sync, and leaves a first Mac to make its key', async () => {
    expect(await unlockMatrixOwner(port({ status: { storage: undefined } }).port)).toEqual({ state: 'unknown' })
    expect(await unlockMatrixOwner(port({ status: { storage: 'absent' } }).port)).toEqual({ state: 'no_recovery' })
  })

  it('signs in again on the same Mac with nothing to type: kept key → complete unlock', async () => {
    const { port: sdk, lines } = port({ kept: kept() })

    expect(await unlockMatrixOwner(sdk)).toEqual({
      state: 'unlocked',
      key: KEY,
      source: 'typed',
      restored: true,
      signed: true,
      backup: true
    })
    expect(sdk.check).toHaveBeenCalledWith(KEY)
    expect(sdk.restore).toHaveBeenCalledWith(KEY)
    // The key id it opens is learned once, so later launches need no network check.
    expect(sdk.retain).toHaveBeenCalledWith(KEY, { source: 'typed', keyId: 'key-1' })
    expect(lines.join('\n')).toContain('owner unlock source=typed ok=true signed=true backup=true')
    expect(lines.join('\n')).not.toContain(KEY)
  })

  it('does nothing at all on a device that is already unlocked with the same key', async () => {
    const { port: sdk } = port({
      kept: kept({ keyId: 'key-1' }),
      status: { signing: true, deviceSigned: true, backup: true }
    })

    expect(await unlockMatrixOwner(sdk)).toMatchObject({ state: 'unlocked', restored: false })
    expect(sdk.check).not.toHaveBeenCalled()
    expect(sdk.restore).not.toHaveBeenCalled()
  })

  it('checks a key carried over from 0.18.1 once, even on an unlocked device', async () => {
    const { port: sdk } = port({
      kept: kept({ source: 'migrated' }),
      status: { signing: true, deviceSigned: true, backup: true }
    })

    expect(await unlockMatrixOwner(sdk)).toMatchObject({ state: 'unlocked', source: 'migrated', restored: false })
    expect(sdk.check).toHaveBeenCalledOnce()
    expect(sdk.restore).not.toHaveBeenCalled()
    expect(sdk.retain).toHaveBeenCalledWith(KEY, { source: 'migrated', keyId: 'key-1' })
  })

  it('finishes a half-unlocked device: signed but without the history’s backup key', async () => {
    const { port: sdk } = port({ kept: kept({ keyId: 'key-1' }), status: { signing: true, deviceSigned: true } })

    expect(await unlockMatrixOwner(sdk)).toMatchObject({ state: 'unlocked', restored: true, backup: true })
    expect(sdk.restore).toHaveBeenCalledOnce()
  })

  it('ignores a kept key the account no longer accepts, and says why', async () => {
    const { port: sdk, lines } = port({
      kept: kept({ key: 'EsTz 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000' })
    })

    const result = await unlockMatrixOwner(sdk)
    expect(result).toEqual({ state: 'needs_key', complete: false, reason: 'stale' })
    expect(sdk.restore).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('no longer opens')
    // Changed elsewhere: no other device is asked; the person types their key.
    expect(matrixMayAskOtherDevices(result)).toBe(false)
  })

  it('asks for the key only when nothing here has it; an approved-elsewhere device says so', async () => {
    const none = await unlockMatrixOwner(port().port)
    expect(none).toEqual({ state: 'needs_key', complete: false, reason: 'none' })
    expect(matrixMayAskOtherDevices(none)).toBe(true)
    expect(matrixMayAskOtherDevices({ state: 'no_recovery' })).toBe(false)
    expect(matrixMayAskOtherDevices(undefined)).toBe(false)
    expect(await unlockMatrixOwner(port({ status: { signing: true, deviceSigned: true, backup: true } }).port)).toEqual(
      { state: 'needs_key', complete: true, reason: 'none' }
    )
  })

  it('takes iCloud Keychain’s key when this Mac keeps none, checks it, and keeps it', async () => {
    const { port: sdk } = port({ icloud: CLOUD })

    expect(await unlockMatrixOwner(sdk)).toMatchObject({ state: 'unlocked', key: CLOUD, source: 'icloud' })
    expect(sdk.retain).toHaveBeenCalledWith(CLOUD, { source: 'icloud', keyId: 'key-1' })
  })

  it('never uses an iCloud key the account does not accept, nor a helper that fails', async () => {
    const wrong = port({ icloud: 'EsTz 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000' })
    expect(await unlockMatrixOwner(wrong.port)).toMatchObject({ state: 'needs_key' })
    expect(wrong.port.retain).not.toHaveBeenCalled()

    const failing = port()
    const sdk = { ...failing.port, icloud: vi.fn(async () => Promise.reject(new Error('unprovisioned'))) }
    expect(await unlockMatrixOwner(sdk)).toEqual({ state: 'needs_key', complete: false, reason: 'none' })
  })

  it('a kept key gone stale stays stale: iCloud Keychain is not even read, whatever it holds', async () => {
    // Another of the person's Macs mirrored a key that opens the recovery someone else made.
    const { port: sdk } = port({
      kept: kept({ key: 'EsTz 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000', keyId: 'old' }),
      icloud: CLOUD
    })

    const result = await unlockMatrixOwner(sdk)
    expect(result).toEqual({ state: 'needs_key', complete: false, reason: 'stale' })
    expect(matrixMayAskOtherDevices(result)).toBe(false)
    expect(sdk.icloud).not.toHaveBeenCalled()
    expect(sdk.retain).not.toHaveBeenCalled()
    expect(sdk.restore).not.toHaveBeenCalled()

    // A kept key that still opens the recovery needs no iCloud either.
    const valid = port({ kept: kept(), icloud: CLOUD })
    expect(await unlockMatrixOwner(valid.port)).toMatchObject({ state: 'unlocked', key: KEY, source: 'typed' })
    expect(valid.port.icloud).not.toHaveBeenCalled()
  })

  it('an iCloud key that no longer opens the recovery, on a Mac that keeps none, is stale too', async () => {
    const { port: sdk, lines } = port({ icloud: 'EsTz 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000' })

    const result = await unlockMatrixOwner(sdk)
    // Changed elsewhere: nobody is asked (an approval could only let this Mac into whatever
    // identity the server serves now), and iCloud is not polled again; the person types their key.
    expect(result).toEqual({ state: 'needs_key', complete: false, reason: 'stale' })
    expect(matrixMayAskOtherDevices(result)).toBe(false)
    expect(sdk.retain).not.toHaveBeenCalled()
    expect(sdk.restore).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('iCloud Keychain’s key no longer opens')
    expect(lines.join('\n')).not.toContain('EsTz')
  })

  it('stops when the account or device changed while it worked', async () => {
    const { port: sdk } = port({ kept: kept() })
    let calls = 0

    sdk.assertCurrent.mockImplementation(() => {
      if (++calls > 2) {
        throw new Error('matrix_recovery_stale')
      }
    })

    await expect(unlockMatrixOwner(sdk)).rejects.toThrow('matrix_recovery_stale')
    expect(sdk.restore).not.toHaveBeenCalled()
  })

  it('refuses malformed answers from the SDK', async () => {
    const { port: sdk } = port({ kept: kept() })
    sdk.status.mockResolvedValueOnce({ storage: 'present' } as never)
    await expect(unlockMatrixOwner(sdk)).rejects.toThrow('matrix_recovery_invalid')
  })

  it('does not cache a migrated-key restore with backup=true and signed=false as unlocked', async () => {
    const { port: sdk, lines } = port({ kept: kept({ source: 'migrated' }) })
    sdk.restore.mockResolvedValueOnce({ keyId: 'key-1', signed: false, backup: true })
    await expect(unlockMatrixOwner(sdk)).rejects.toThrow('matrix_owner_device_unsigned')
    expect(sdk.restore).toHaveBeenCalledExactlyOnceWith(KEY)
    expect(lines.join('\n')).toContain('source=migrated ok=false signed=false backup=true')
    expect(lines.join('\n')).not.toContain(KEY)
  })

  it('preserves signing for accounts without a history backup, while reporting backup=false', async () => {
    const { port: sdk } = port({ kept: kept() })
    sdk.restore.mockResolvedValueOnce({ keyId: 'key-1', signed: true, backup: false })
    await expect(unlockMatrixOwner(sdk)).resolves.toMatchObject({ state: 'unlocked', signed: true, backup: false })
  })
})
