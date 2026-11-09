import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, test } from 'vitest'

import { ACCOUNT_ROOT_AT_REST_POSTURE, accountKeyFor, AccountRootAuthority } from './account-roots'

const ACCOUNT_A = '00000000-0000-4000-8000-303617b97302'
const directories: string[] = []

function userData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'atum-account-roots-'))
  directories.push(directory)

  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('account ids map to stable opaque roots with explicit private at-rest posture', () => {
  const root = userData()
  const authority = new AccountRootAuthority(root)
  const paths = authority.prepare(ACCOUNT_A)

  assert.equal(paths.accountKey, accountKeyFor(ACCOUNT_A))
  assert.equal(paths.root.includes(ACCOUNT_A), false)
  assert.equal(paths.authStorage.startsWith(`${paths.root}/`), true)
  assert.equal(paths.messagingDatabase.startsWith(`${paths.root}/`), true)
  assert.equal(statSync(paths.root).mode & 0o777, 0o700)
  assert.equal(statSync(dirname(paths.authStorage)).mode & 0o777, 0o700)
  assert.deepEqual(ACCOUNT_ROOT_AT_REST_POSTURE, {
    accountDirectories: '0700',
    credentialAndMarkerFiles: '0600',
    authCredentials: 'electron-safeStorage-encrypted',
    messagingProjection: 'plaintext-sqlite-private-account-root',
    legacyGlobalData: 'preserved-unclaimed'
  })
})

test('commit marker is atomic, private, and accepts only its committed account on restart', () => {
  const root = userData()
  const authority = new AccountRootAuthority(root)
  const marker = authority.commit(ACCOUNT_A, 7)
  const committed = authority.committed()!
  const markerPath = join(root, 'atum-account-context', 'active.json')

  assert.deepEqual(committed.marker, marker)
  assert.equal(statSync(markerPath).mode & 0o777, 0o600)
  assert.equal(readFileSync(markerPath, 'utf8').includes(ACCOUNT_A), false)
  assert.doesNotThrow(() => authority.assertCommittedAccount(ACCOUNT_A))
  assert.throws(
    () => authority.assertCommittedAccount('00000000-0000-4000-8000-00f765af1c54'),
    /account_context_mismatch/u
  )

  authority.clearCommit()
  assert.equal(authority.committed(), null)
  assert.equal(statSync(committed.paths.root).isDirectory(), true)
})

test('legacy global auth and messaging data are preserved and never claimed by a new account', () => {
  const root = userData()
  const authority = new AccountRootAuthority(root)
  const legacy = authority.legacyDisposition()

  mkdirSync(dirname(legacy.authStorage), { recursive: true })
  mkdirSync(dirname(legacy.messagingDatabase), { recursive: true })
  writeFileSync(legacy.authStorage, 'legacy-auth')
  writeFileSync(legacy.messagingDatabase, 'legacy-messaging')
  const paths = authority.prepare(ACCOUNT_A)

  assert.equal(legacy.disposition, 'preserved-unclaimed')
  assert.equal(readFileSync(legacy.authStorage, 'utf8'), 'legacy-auth')
  assert.equal(readFileSync(legacy.messagingDatabase, 'utf8'), 'legacy-messaging')
  assert.notEqual(paths.authStorage, legacy.authStorage)
  assert.notEqual(paths.messagingDatabase, legacy.messagingDatabase)
})

test('a malformed commit marker fails closed instead of selecting an account root', () => {
  const root = userData()
  const markerPath = join(root, 'atum-account-context', 'active.json')

  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileSync(markerPath, '{"version":1,"accountKey":"../../escape"}')
  const authority = new AccountRootAuthority(root)

  assert.throws(() => authority.committed(), /account_context_corrupt/u)
  assert.deepEqual(authority.recoverCommitted(), { committed: null, recoveredInvalidMarker: true })
  assert.equal(authority.committed(), null)
})
