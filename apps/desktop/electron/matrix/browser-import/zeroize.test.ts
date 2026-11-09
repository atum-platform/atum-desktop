/**
 * Best-effort zeroization of the secrets this import handles: the Keychain secret, the derived key, every decrypted
 * plaintext and the HPKE plaintext. The Buffers are captured as they are created and inspected after the call, so
 * a regression that forgets a `fill(0)` fails here. (A cookie value that became a JavaScript string cannot be
 * wiped; the README says so. These tests cover only what can be.)
 */
import type * as CryptoModule from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  chromeEnv,
  chromeFixture,
  type ChromeFixture,
  fakeSecurity,
  standardCookies,
  TEST_PASSWORD
} from './__fixtures__/chrome-fixture'
import { softwareRecipient } from './__fixtures__/software-keys'
import { discoverChromeProfiles, readChromeCookies, type SecurityRunner } from './chrome-cookies'
import type * as ContractModule from './contract'
import { type BrowserCookie, browserImportBundleBytes, type BrowserStorageStateBundle } from './contract'
import { sealBrowserImport } from './envelope'

const captured = vi.hoisted(() => ({ keys: [] as Buffer[], plaintexts: [] as Uint8Array[], capture: false }))

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof CryptoModule>()

  return {
    ...actual,
    pbkdf2Sync: (...args: Parameters<typeof actual.pbkdf2Sync>) => {
      const key = actual.pbkdf2Sync(...args)

      if (captured.capture) {
        captured.keys.push(key)
      }

      return key
    }
  }
})

vi.mock('./contract', async importOriginal => {
  const actual = await importOriginal<typeof ContractModule>()

  return {
    ...actual,
    browserImportBundleBytes: (...args: Parameters<typeof actual.browserImportBundleBytes>) => {
      const bytes = actual.browserImportBundleBytes(...args)

      if (captured.capture) {
        captured.plaintexts.push(bytes)
      }

      return bytes
    }
  }
})

const cleanups: (() => void)[] = []

afterEach(() => {
  captured.capture = false
  captured.keys.length = 0
  captured.plaintexts.length = 0
  vi.restoreAllMocks()

  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

const isZero = (bytes: Uint8Array) => bytes.every(byte => byte === 0)

const fixture = (...args: Parameters<typeof chromeFixture>): ChromeFixture => {
  const made = chromeFixture(...args)
  cleanups.push(made.cleanup)

  return made
}

describe('reading Chrome zeroes what it held', () => {
  it('zeroes the Keychain answer, the derived key and every decrypted plaintext, and still imports', async () => {
    const made = fixture([{ dir: 'Default', cookies: standardCookies() }])
    const answer = Buffer.from(`${TEST_PASSWORD}\n`)

    const runSecurity: SecurityRunner = async () => ({ status: 0, stdout: answer, stderr: '', timedOut: false })
    const env = chromeEnv(made, { runSecurity })
    const [profile] = discoverChromeProfiles(env)

    const concat = Buffer.concat.bind(Buffer)
    const plaintexts: Buffer[] = []

    vi.spyOn(Buffer, 'concat').mockImplementation((...args: Parameters<typeof Buffer.concat>) => {
      const joined = concat(...args)
      plaintexts.push(joined)

      return joined
    })

    captured.capture = true
    const read = await readChromeCookies(profile!, env, () => true)
    captured.capture = false

    expect(read.cookies.length).toBeGreaterThan(10)

    // The secret came in as bytes, was used once and is gone.
    // (The newline around it is not part of the secret and is left as it was.)
    expect(answer.length).toBeGreaterThan(0)
    expect(answer.every(byte => byte === 0 || byte === 0x0a)).toBe(true)
    expect(answer.includes(Buffer.from('keychain'))).toBe(false)

    expect(captured.keys).toHaveLength(1)
    expect(captured.keys[0]!.length).toBe(16)
    expect(isZero(captured.keys[0]!)).toBe(true)

    // One concatenated plaintext per encrypted row, each overwritten before the call returned.
    expect(plaintexts.length).toBeGreaterThan(10)

    for (const plaintext of plaintexts) {
      expect(isZero(plaintext)).toBe(true)
    }
  })

  it('zeroes the Keychain answer on a refusal and on an empty secret too', async () => {
    const made = fixture([{ dir: 'Default', cookies: standardCookies() }])
    const refusal = Buffer.from('should-not-be-here')
    const empty = Buffer.from(' \n')

    for (const [stdout, status] of [
      [refusal, 128],
      [empty, 0]
    ] as const) {
      const env = chromeEnv(made, {
        runSecurity: async () => ({ status, stdout, stderr: 'User canceled the operation.', timedOut: false })
      })

      const [profile] = discoverChromeProfiles(env)
      await expect(readChromeCookies(profile!, env, () => true)).rejects.toMatchObject({ code: expect.any(String) })
      expect(isZero(stdout)).toBe(true)
    }
  })

  it('does not keep the Keychain answer between reads: each read asks again', async () => {
    const made = fixture([{ dir: 'Default', cookies: standardCookies() }])
    const security = fakeSecurity()
    const env = chromeEnv(made, { runSecurity: security })
    const [profile] = discoverChromeProfiles(env)

    await readChromeCookies(profile!, env, () => true)
    await readChromeCookies(profile!, env, () => true)

    expect(security.calls).toHaveLength(2)
  })
})

describe('sealing zeroes the HPKE plaintext', () => {
  const cookie = (name: string, value: string): BrowserCookie => ({
    name,
    value,
    domain: '.github.com',
    path: '/',
    expires: 1_900_000_000,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax'
  })

  const bundle = (): BrowserStorageStateBundle => ({
    siteSelections: [{ domain: 'github.com', category: 'standard', disposition: 'included', ownerOverride: false }],
    cookies: [cookie('session_id', 'super-secret-session'), cookie('theme', 'dark')],
    origins: []
  })

  it('overwrites the bytes it handed to seal', async () => {
    const recipient = await softwareRecipient()
    const request = bundle()

    captured.capture = true

    const sealed = await sealBrowserImport({
      bundle: request,
      source: { browser: 'chrome', profileOrdinal: 1 },
      ownerUserId: '@owner:atum.example',
      agentPrincipal: '00000000-0000-4000-8000-bd7662a5eeb4',
      recipient: {
        computerId: '00000000-0000-4000-8000-b454f82c5857',
        attachmentEpoch: 7,
        hpkePublicKey: recipient.hpkePublicKey,
        hpkeKeyId: recipient.hpkeKeyId
      },
      importId: '00000000-0000-4000-8000-cd2a20671fb6',
      approvedAt: 1_799_999_995_000,
      createdAt: 1_800_000_000_000
    })

    captured.capture = false

    expect(sealed.counts.cookieCount).toBe(2)

    // Sealing parsed the bundle for its own bytes; whatever it handed to HPKE is zero now.
    expect(captured.plaintexts.length).toBeGreaterThan(0)

    for (const bytes of captured.plaintexts) {
      expect(bytes.length).toBeGreaterThan(0)
      expect(isZero(bytes)).toBe(true)
    }

    // A fresh encoding is what the contract produces, so the zeroed ones were the real plaintext, not a stub.
    expect(browserImportBundleBytes(bundle()).some(byte => byte !== 0)).toBe(true)
  })

  it('zeroes them when sealing fails', async () => {
    const recipient = await softwareRecipient()
    captured.capture = true

    await expect(
      sealBrowserImport({
        bundle: bundle(),
        source: { browser: 'chrome', profileOrdinal: 1 },
        ownerUserId: '@owner:atum.example',
        agentPrincipal: '00000000-0000-4000-8000-bd7662a5eeb4',
        recipient: {
          computerId: '00000000-0000-4000-8000-b454f82c5857',
          attachmentEpoch: 7,
          // Not an X25519 key: HPKE refuses it after the plaintext was built.
          hpkePublicKey: 'A'.repeat(43),
          hpkeKeyId: recipient.hpkeKeyId
        },
        importId: '00000000-0000-4000-8000-cd2a20671fb6',
        approvedAt: 1_799_999_995_000,
        createdAt: 1_800_000_000_000
      })
    ).rejects.toThrow()

    captured.capture = false

    for (const bytes of captured.plaintexts) {
      expect(isZero(bytes)).toBe(true)
    }
  })
})
