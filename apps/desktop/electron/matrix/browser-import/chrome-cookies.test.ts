import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import {
  chromeEnv,
  type ChromeFixture,
  chromeFixture,
  duplicateDatabase,
  encryptCookieValue,
  fakeSecurity,
  NOW,
  standardCookies,
  TEST_KEY,
  TEST_PASSWORD
} from './__fixtures__/chrome-fixture'
import {
  chooseChromeProfile,
  CHROME_KEYCHAIN_SERVICE,
  ChromeImportError,
  decryptCookieValue,
  deriveCookieKey,
  discoverChromeProfiles,
  listCookieHosts,
  readChromeCookies,
  readSafeStoragePassword
} from './chrome-cookies'

const cleanups: (() => void)[] = []

const fixture = (...args: Parameters<typeof chromeFixture>): ChromeFixture => {
  const made = chromeFixture(...args)
  cleanups.push(made.cleanup)

  return made
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

const acceptAll = () => true

describe('profile discovery', () => {
  it('lists profiles that have a cookie database in a stable order and marks the one Chrome last used', () => {
    const made = fixture(
      [
        { dir: 'Profile 10', cookies: [] },
        { dir: 'Profile 2', cookies: [] },
        { dir: 'Default', cookies: [] },
        { dir: 'Profile 1', cookies: [] }
      ],
      { lastUsed: 'Profile 2' }
    )

    const profiles = discoverChromeProfiles(chromeEnv(made))

    expect(profiles.map(({ dir, ordinal, lastUsed }) => [dir, ordinal, lastUsed])).toEqual([
      ['Default', 1, false],
      ['Profile 1', 2, false],
      ['Profile 2', 3, true],
      ['Profile 10', 4, false]
    ])
  })

  it('ignores folders that are not profiles and profiles that never browsed', () => {
    const made = fixture([{ dir: 'Default', cookies: [] }])
    const chrome = path.join(made.appSupportDir, 'Google', 'Chrome')

    for (const name of ['Guest Profile', 'System Profile', 'Profile ../x', 'Profile 1x', 'Crashpad', 'Profile 3']) {
      mkdirSync(path.join(chrome, name), { recursive: true })
    }

    expect(discoverChromeProfiles(chromeEnv(made)).map(({ dir }) => dir)).toEqual(['Default'])
  })

  it('finds a database in Network/ and prefers the newest of the two places', () => {
    const made = fixture([{ dir: 'Default', cookies: [] }], { mtimes: { Default: 1_700_000_000 } })
    const old = made.cookiesPath('Default')
    const network = path.join(path.dirname(old), 'Network', 'Cookies')
    duplicateDatabase(old, network)

    expect(discoverChromeProfiles(chromeEnv(made))[0]!.cookiesPath).toBe(network)

    const only = fixture([{ dir: 'Default', cookies: [], network: true }])

    expect(discoverChromeProfiles(chromeEnv(only))[0]!.cookiesPath).toMatch(/Default\/Network\/Cookies$/u)
  })

  it('finds no profile when Chrome is not installed, and refuses any platform but macOS', () => {
    const empty = fixture([])

    expect(discoverChromeProfiles(chromeEnv(empty))).toEqual([])
    expect(() => discoverChromeProfiles(chromeEnv(empty, { platform: 'linux' }))).toThrow(ChromeImportError)
  })

  it('picks one profile without asking: last used, else Default, else the first', () => {
    const profile = (dir: string, lastUsed: boolean) => ({ dir, ordinal: 1, cookiesPath: dir, lastUsed })

    expect(chooseChromeProfile([profile('Default', false), profile('Profile 1', true)])!.dir).toBe('Profile 1')
    expect(chooseChromeProfile([profile('Profile 1', false), profile('Default', false)])!.dir).toBe('Default')
    expect(chooseChromeProfile([profile('Profile 3', false), profile('Profile 4', false)])!.dir).toBe('Profile 3')
    expect(chooseChromeProfile([])).toBeNull()
  })
})

describe('listing hosts never decrypts', () => {
  it('counts live, unpartitioned cookies per host with their recency, and never asks the Keychain', () => {
    const made = fixture([{ dir: 'Default', cookies: standardCookies() }])
    const security = fakeSecurity()
    const env = chromeEnv(made, { runSecurity: security })
    const [profile] = discoverChromeProfiles(env)
    const hosts = Object.fromEntries(listCookieHosts(profile!, env).map(row => [row.host, row]))

    expect(hosts['.github.com']).toMatchObject({ cookies: 3 })
    expect(hosts['.mixed.com']).toMatchObject({ cookies: 2 })
    // The expired cookie and the partitioned twin are not counted.
    expect(hosts['.expired.com']).toBeUndefined()
    expect(hosts['.widget.example.net']).toMatchObject({ cookies: 1 })
    expect(hosts['.session.com']).toMatchObject({ cookies: 1 })
    expect(hosts['.github.com']!.lastAccess).toBe(Math.floor(NOW / 1000) - 3_600)
    expect(security.calls).toEqual([])
  })
})

describe('the Keychain secret', () => {
  const env = (run: ReturnType<typeof chromeEnv>['runSecurity']) => chromeEnv(fixture([]), { runSecurity: run })

  it('asks for exactly Chrome Safe Storage with a constant command and gives a person time to answer', async () => {
    const security = fakeSecurity('s3cret')

    await expect(readSafeStoragePassword(env(security))).resolves.toEqual(Buffer.from('s3cret'))
    expect(security.calls).toEqual([
      { args: ['find-generic-password', '-s', CHROME_KEYCHAIN_SERVICE, '-w'], timeoutMs: 120_000 }
    ])
  })

  it.each([
    [
      'the person declined the macOS dialog',
      { status: 128, stderr: 'security: SecKeychainSearchCopyNext: User canceled the operation.' },
      'keychain_denied'
    ],
    ['access was denied', { status: 51, stderr: 'security: ... denied' }, 'keychain_denied'],
    ['no interaction is possible', { status: 36, stderr: 'User interaction is not allowed.' }, 'keychain_denied'],
    [
      'Chrome has no entry',
      { status: 44, stderr: 'The specified item could not be found in the keychain.' },
      'keychain_not_found'
    ],
    ['security fails some other way', { status: 1, stderr: 'boom' }, 'keychain_error'],
    ['the dialog is never answered', { status: null, stderr: '', timedOut: true }, 'keychain_timeout'],
    ['the secret is empty', { status: 0, stdout: Buffer.from('\n'), stderr: '' }, 'keychain_error']
  ])('maps %s to a closed code', async (_name, result, code) => {
    const run = async () => ({ stdout: Buffer.alloc(0), timedOut: false, ...result })

    await expect(readSafeStoragePassword(env(run))).rejects.toMatchObject({ code })
  })
})

describe('decryption', () => {
  it('reads a Chrome 130+ value: v10, AES-128-CBC with a space IV, then the 32-byte domain hash', () => {
    const encrypted = encryptCookieValue('abc123', { hostKey: '.github.com' })

    expect(Buffer.from(encrypted).subarray(0, 3).toString()).toBe('v10')
    expect(decryptCookieValue(encrypted, TEST_KEY, true, '.github.com')).toBe('abc123')
  })

  it('reads an older value that has no hash, and an empty one', () => {
    expect(decryptCookieValue(encryptCookieValue('legacy', { legacy: true }), TEST_KEY, false, '.a.example')).toBe(
      'legacy'
    )
    expect(decryptCookieValue(encryptCookieValue('', { hostKey: '.a.example' }), TEST_KEY, true, '.a.example')).toBe('')
  })

  it('derives the macOS key as PBKDF2-SHA1 over the secret, salt saltysalt, 1003 rounds', () => {
    // Known answer from an independent implementation (the OpenSSL command line:
    // openssl kdf -keylen 16 -kdfopt digest:SHA1 -kdfopt pass:… -kdfopt salt:saltysalt -kdfopt iter:1003 PBKDF2).
    expect(deriveCookieKey(TEST_PASSWORD).toString('hex')).toBe('c3dd1efd46340ac8995877c669665157')
    expect(deriveCookieKey(TEST_PASSWORD).toString('hex')).toBe(TEST_KEY.toString('hex'))
  })

  it('refuses a value whose domain hash is for another host: Chrome binds each value to its host_key', () => {
    const forGithub = encryptCookieValue('abc123', { hostKey: '.github.com' })

    expect(() => decryptCookieValue(forGithub, TEST_KEY, true, '.attacker.example')).toThrow(
      expect.objectContaining({ code: 'domain_mismatch' })
    )
    // The hash is of host_key exactly, leading dot included.
    expect(() => decryptCookieValue(forGithub, TEST_KEY, true, 'github.com')).toThrow(ChromeImportError)
    // A database without the hash (version 23) has nothing to bind, so a host is not asked about.
    expect(
      decryptCookieValue(encryptCookieValue('legacy', { legacy: true }), TEST_KEY, false, '.anything.example')
    ).toBe('legacy')
  })

  it('refuses a wrong key, other encryption versions, a value without its hash, and non-UTF-8 bytes', () => {
    const encrypted = encryptCookieValue('abc123', { hostKey: '.github.com' })
    const wrong = deriveCookieKey('another-secret')

    expect(() => decryptCookieValue(encrypted, wrong, true, '.github.com')).toThrow()
    expect(() =>
      decryptCookieValue(Buffer.concat([Buffer.from('v11'), encrypted.subarray(3)]), TEST_KEY, true, '.github.com')
    ).toThrow()
    expect(() =>
      decryptCookieValue(Buffer.concat([Buffer.from('v20'), encrypted.subarray(3)]), TEST_KEY, true, '.github.com')
    ).toThrow()
    expect(() => decryptCookieValue(encryptCookieValue('', { legacy: true }), TEST_KEY, true, '.github.com')).toThrow(
      ChromeImportError
    )
    expect(() =>
      decryptCookieValue(encryptCookieValue('ÿ', { legacy: true, hostKey: '' }), TEST_KEY, false, '')
    ).not.toThrow()
  })
})

describe('reading cookies', () => {
  const read = async (cookies = standardCookies(), options: Parameters<typeof chromeFixture>[1] = {}) => {
    const made = fixture([{ dir: 'Default', cookies }], options)
    const env = chromeEnv(made)
    const [profile] = discoverChromeProfiles(env)

    return readChromeCookies(profile!, env, acceptAll)
  }

  const find = (cookies: { name: string; domain: string }[], domain: string, name: string) =>
    cookies.find(cookie => cookie.domain === domain && cookie.name === name)

  it('decrypts to the Playwright storageState shape: leading dot kept, expires in Unix seconds', async () => {
    const { cookies } = await read()
    const session = find(cookies, '.github.com', 'session_id')

    expect(session).toEqual({
      name: 'session_id',
      value: 'abc123',
      domain: '.github.com',
      path: '/',
      expires: Math.floor(NOW / 1000) + 365 * 86_400,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    })
  })

  it('maps SameSite from Chrome (-1 is Lax, as Chrome treats it), session cookies to -1, host-only to no dot', async () => {
    const { cookies } = await read()

    expect(find(cookies, '.github.com', 'user_token')).toMatchObject({ sameSite: 'None', secure: true })
    expect(find(cookies, '.github.com', 'theme')).toMatchObject({ sameSite: 'Strict', secure: false })
    expect(find(cookies, '.unspecified.example.org', 'u')).toMatchObject({ sameSite: 'Lax' })
    expect(find(cookies, '.session.com', 'sess')).toMatchObject({ expires: -1 })
    expect(find(cookies, 'host-only.example.org', 'sid')).toMatchObject({ domain: 'host-only.example.org' })
    expect(find(cookies, 'app.example.org', '__Host-session')).toBeDefined()
  })

  it('uses an unencrypted value column and keeps multi-byte values intact', async () => {
    const { cookies } = await read()

    expect(find(cookies, '.example.com', 'plain_cookie')).toMatchObject({ value: 'hello-world' })
    expect(find(cookies, '.emoji.example.org', 'greeting')).toMatchObject({ value: 'xin chào 🌏' })
  })

  it('leaves expired cookies, partitioned twins and unreadable rows behind and counts the drops', async () => {
    const { cookies, dropped } = await read()

    expect(cookies.some(cookie => cookie.domain === '.expired.com')).toBe(false)
    expect(find(cookies, '.widget.example.net', 'twin')).toMatchObject({ value: 'unpartitioned-twin' })
    expect(cookies.filter(cookie => cookie.name === 'twin')).toHaveLength(1)
    expect(find(cookies, '.mixed.com', 'good')).toMatchObject({ value: 'mixed-good' })
    expect(find(cookies, '.mixed.com', 'bad')).toBeUndefined()
    expect(find(cookies, '.corrupt.com', 'bad')).toBeUndefined()
    expect(dropped.decrypt).toBe(2)
  })

  it('drops a cookie the contract would refuse instead of failing the import', async () => {
    const { cookies, dropped } = await read()

    expect(find(cookies, '.huge.example.org', 'big')).toBeUndefined()
    expect(find(cookies, '.insecure-none.example.org', 'none_no_secure')).toBeUndefined()
    expect(find(cookies, '.fine.example.org', 'fine')).toBeDefined()
    expect(dropped.value_too_large).toBe(1)
    expect(dropped.samesite_none_insecure).toBe(1)
  })

  it('drops a host the contract bans (localhost, IP literals) as a domain violation', async () => {
    const { cookies, dropped } = await read()

    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(cookies.some(cookie => cookie.domain === host)).toBe(false)
    }

    // Internal names such as nas.local satisfy the contract's cookie regex; site selection (sites.ts) is what
    // keeps them from ever being chosen, so with no site filter they are still read here.
    expect(dropped.domain).toBe(3)
  })

  it('decrypts only the hosts the caller chose', async () => {
    const made = fixture([{ dir: 'Default', cookies: standardCookies() }])
    const env = chromeEnv(made)
    const [profile] = discoverChromeProfiles(env)
    const { cookies, dropped } = await readChromeCookies(profile!, env, host => host === '.github.com')

    expect(cookies.map(cookie => cookie.name).sort()).toEqual(['session_id', 'theme', 'user_token'])
    expect(dropped).toEqual({})
  })

  it('reads a version 23 database without removing a prefix that is not there', async () => {
    const made = fixture([
      { dir: 'Default', metaVersion: 23, cookies: [{ host: '.old.example.org', name: 'a', value: 'old-value' }] }
    ])

    const env = chromeEnv(made)
    const [profile] = discoverChromeProfiles(env)
    const { cookies } = await readChromeCookies(profile!, env, acceptAll)

    expect(cookies).toHaveLength(1)
    expect(cookies[0]!.value).toBe('old-value')
  })

  it('treats a database with no meta table as the current format', async () => {
    const made = fixture([
      { dir: 'Default', metaVersion: null, cookies: [{ host: '.new.example.org', name: 'a', value: 'new-value' }] }
    ])

    const env = chromeEnv(made)
    const [profile] = discoverChromeProfiles(env)

    expect((await readChromeCookies(profile!, env, acceptAll)).cookies[0]!.value).toBe('new-value')
  })

  it('drops a ciphertext transplanted into a row of another host, counts it, and imports nothing from it', async () => {
    const cookies = [
      { host: '.github.com', name: 'session_id', value: 'abc123' },
      // Made for .github.com, placed in a row whose host is the attacker's.
      {
        host: '.attacker.example',
        name: 'stolen',
        raw: encryptCookieValue('abc123-for-github', { hostKey: '.github.com' })
      },
      // Hashed for the host without its dot: not the host_key, so not the host's value either.
      { host: '.dotless.example', name: 'dotless', raw: encryptCookieValue('v', { hostKey: 'dotless.example' }) }
    ]

    const { cookies: kept, dropped } = await read(cookies)

    expect(kept.map(cookie => cookie.name)).toEqual(['session_id'])
    expect(dropped).toEqual({ domain_mismatch: 2 })
    expect(JSON.stringify(kept)).not.toContain('abc123-for-github')
  })

  it('imports nothing under a wrong Keychain secret', async () => {
    const made = fixture([{ dir: 'Default', cookies: standardCookies() }])
    const env = chromeEnv(made, { runSecurity: fakeSecurity('not-chromes-secret') })
    const [profile] = discoverChromeProfiles(env)
    const { cookies, dropped } = await readChromeCookies(profile!, env, acceptAll)

    // Plaintext cookies need no key; every encrypted row fails.
    expect(cookies.map(cookie => cookie.name)).toEqual(['plain_cookie'])
    expect(dropped.decrypt).toBeGreaterThan(10)
  })

  it('asks for the Keychain only when it reads values, and stops at a refusal before opening the database', async () => {
    const made = fixture([{ dir: 'Default', cookies: standardCookies() }])

    const denied = chromeEnv(made, {
      runSecurity: async () => ({
        status: 128,
        stdout: Buffer.alloc(0),
        stderr: 'User canceled the operation.',
        timedOut: false
      })
    })

    const [profile] = discoverChromeProfiles(denied)

    await expect(readChromeCookies(profile!, denied, acceptAll)).rejects.toMatchObject({ code: 'keychain_denied' })
  })

  it('reports a corrupt database as a closed error', async () => {
    const made = fixture([{ dir: 'Default', cookies: [] }])
    const env = chromeEnv(made)
    const [profile] = discoverChromeProfiles(env)
    writeFileSync(profile!.cookiesPath, Buffer.from('this is not a sqlite database at all'.repeat(40)))

    expect(() => listCookieHosts(profile!, env)).toThrow(/chrome_import_cookie_db_(corrupt|unreadable)/u)
  })
})

describe('a database in WAL mode', () => {
  it('is read in place, with the write-ahead log another connection holds, and no copy is made', async () => {
    const made = fixture([{ dir: 'Default', wal: true, cookies: standardCookies() }])
    const scratch = mkdtempSync(path.join(tmpdir(), 'atum-chrome-scratch-'))
    cleanups.push(() => rmSync(scratch, { recursive: true, force: true }))
    const env = chromeEnv(made, { tmpDir: () => scratch })
    const [profile] = discoverChromeProfiles(env)

    // Chrome's own connection, with a change not yet checkpointed into the main file.
    const holder = new DatabaseSync(profile!.cookiesPath)
    holder.exec(
      "INSERT INTO cookies (host_key, name, value, has_expires) VALUES ('.fresh.example.com', 'f', 'fresh-plain', 0)"
    )

    try {
      const { cookies } = await readChromeCookies(profile!, env, host => host === '.fresh.example.com')

      expect(cookies.map(cookie => cookie.value)).toEqual(['fresh-plain'])
      expect(readdirSync(scratch)).toEqual([])
    } finally {
      holder.close()
    }
  })
})

describe('a database Chrome holds locked', () => {
  it('is read from a private copy, and the copy is gone afterwards', async () => {
    const made = fixture([{ dir: 'Default', cookies: standardCookies() }])
    const scratch = mkdtempSync(path.join(tmpdir(), 'atum-chrome-scratch-'))
    cleanups.push(() => rmSync(scratch, { recursive: true, force: true }))
    const env = chromeEnv(made, { tmpDir: () => scratch })
    const [profile] = discoverChromeProfiles(env)

    // Chrome's own connection: an exclusive lock that makes every other reader see "database is locked".
    const holder = new DatabaseSync(profile!.cookiesPath)
    holder.exec('BEGIN EXCLUSIVE')

    try {
      const hosts = listCookieHosts(profile!, env)
      const { cookies } = await readChromeCookies(profile!, env, acceptAll)

      expect(hosts.length).toBeGreaterThan(10)
      expect(cookies.some(cookie => cookie.name === 'session_id' && cookie.value === 'abc123')).toBe(true)
      expect(readdirSync(scratch)).toEqual([])
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
  })
})
