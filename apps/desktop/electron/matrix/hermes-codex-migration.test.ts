import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { rememberMatrixAccountOnThisMac } from './codex-accounts'
import {
  MATRIX_CODEX_MIGRATION_MARKER,
  matrixLegacyCodexStore,
  migrateMatrixCodexAccounts
} from './hermes-codex-migration'
import { matrixAccountCodexScope, matrixHermesHome } from './hermes-runtime'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()

  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

function write(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** A Mac as 0.18.2 left it: a person's home (their own Codex CLI and Hermes CLI folders) and
 * Atum's userData with two accounts' assistants, each profile holding a copy of one ChatGPT
 * sign-in that went through the shared store. */
function mac(options: { pinned?: boolean; accounts?: number } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'atum-codex-migration-'))
  roots.push(root)
  const person = path.join(root, 'person')
  const userData = path.join(root, 'userData')
  const shared = path.join(person, '.hermes', 'shared')

  // The Atum accounts this Mac has held (codex-accounts.ts): two unless a test says otherwise.
  for (const key of ['a', 'b'].slice(0, options.accounts ?? 2)) {
    rememberMatrixAccountOnThisMac(userData, key.repeat(64))
  }

  const config = {
    python: '/fixture/python',
    source: '/fixture/source',
    profiles: path.join(userData, 'hermes'),
    ...(options.pinned === false
      ? {}
      : { bundled: { browserBin: '/b', nodeBin: '/n', chromium: '/c', sharedAuthDir: shared } })
  }

  const mine = matrixHermesHome(config, 'owner-a', 'executor-a')
  const theirs = matrixHermesHome(config, 'owner-b', 'executor-b')
  const tokens = { access_token: 'synthetic-access-a', refresh_token: 'synthetic-refresh-a' }

  for (const [home, active] of [
    [mine, 'openai-codex'],
    [theirs, 'nous']
  ] as const) {
    write(path.join(home, 'auth.json'), {
      version: 1,
      active_provider: active,
      providers: {
        'openai-codex': { tokens, last_refresh: '2026-10-01T00:00:00Z', auth_mode: 'chatgpt' },
        nous: { access_token: 'synthetic-nous' }
      },
      credential_pool: {
        'openai-codex': [{ id: 'one', access_token: tokens.access_token, refresh_token: tokens.refresh_token }],
        openrouter: [{ id: 'two', access_token: 'synthetic-openrouter' }]
      }
    })
  }

  // The store every assistant read before 0.18.3 (and Hermes's other shared sign-ins beside it).
  const legacy =
    options.pinned === false ? path.join(mine, 'shared', 'codex_auth.json') : path.join(shared, 'codex_auth.json')

  write(legacy, { _schema: 1, ...tokens })
  write(path.join(shared, 'nous_auth.json'), { access_token: 'synthetic-nous' })
  // The person's own Codex CLI sign-in.
  const cli = path.join(person, '.codex', 'auth.json')
  write(cli, { tokens: { access_token: 'cli-access', refresh_token: 'cli-refresh' } })
  // An account's own 0.18.3 sign-in, already in its folder.
  const own = path.join(matrixAccountCodexScope(config, 'owner-a').authDir, 'codex_auth.json')
  write(own, { _schema: 1, access_token: 'own-access', refresh_token: 'own-refresh' })

  return { config, person, userData, shared, mine, theirs, legacy, cli, own }
}

it("clears every assistant profile's ChatGPT copy and keeps the person's own Hermes CLI store", () => {
  const m = mac()
  const cliBefore = readFileSync(m.cli, 'utf8')
  const ownBefore = readFileSync(m.own, 'utf8')

  expect(migrateMatrixCodexAccounts(m.config, { userData: m.userData, env: {}, homeDir: m.person })).toBe('migrated')

  // Packaged 0.18.2 pinned the store to the person's own Hermes CLI folder: deleting it would
  // sign their Hermes CLI out, and 0.18.3 never reads it, so it stays (with its neighbours).
  expect(existsSync(m.legacy)).toBe(true)
  expect(existsSync(path.join(m.shared, 'nous_auth.json'))).toBe(true)

  for (const home of [m.mine, m.theirs]) {
    const store = json(path.join(home, 'auth.json'))
    expect(store.providers).toEqual({ nous: { access_token: 'synthetic-nous' } })
    expect(store.credential_pool).toEqual({ openrouter: [{ id: 'two', access_token: 'synthetic-openrouter' }] })
    expect(JSON.stringify(store)).not.toContain('synthetic-refresh-a')
    expect(statSync(path.join(home, 'auth.json')).mode & 0o777).toBe(0o600)
  }

  // A profile that answered with ChatGPT is left with no active sign-in; another keeps its own.
  expect(json(path.join(m.mine, 'auth.json')).active_provider).toBeNull()
  expect(json(path.join(m.theirs, 'auth.json')).active_provider).toBe('nous')

  // The person's Codex CLI and an account's own 0.18.3 sign-in are never touched.
  expect(readFileSync(m.cli, 'utf8')).toBe(cliBefore)
  expect(readFileSync(m.own, 'utf8')).toBe(ownBefore)
  expect(existsSync(path.join(m.userData, MATRIX_CODEX_MIGRATION_MARKER))).toBe(true)
})

it('runs once: a later start changes nothing, even a sign-in made since', () => {
  const m = mac()
  expect(migrateMatrixCodexAccounts(m.config, { userData: m.userData, env: {}, homeDir: m.person })).toBe('migrated')

  // The person signs in to ChatGPT again after the upgrade.
  const fresh = {
    providers: { 'openai-codex': { tokens: { refresh_token: 'fresh' } } },
    active_provider: 'openai-codex'
  }

  write(path.join(m.mine, 'auth.json'), fresh)
  write(m.legacy, { refresh_token: 'cli-later' })

  expect(migrateMatrixCodexAccounts(m.config, { userData: m.userData, env: {}, homeDir: m.person })).toBe('already')
  expect(json(path.join(m.mine, 'auth.json'))).toEqual(fresh)
  expect(existsSync(m.legacy)).toBe(true)
})

it("deletes the old store inside an assistant's home when the build did not pin the shared folder", () => {
  const m = mac({ pinned: false })
  expect(migrateMatrixCodexAccounts(m.config, { userData: m.userData, env: {}, homeDir: m.person })).toBe('migrated')
  expect(existsSync(m.legacy)).toBe(false)
  expect(json(path.join(m.theirs, 'auth.json')).providers['openai-codex']).toBeUndefined()
})

it('never fails startup: a profile it cannot read is logged without a path, the rest is done, and it tries again', () => {
  const m = mac({ pinned: false })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  // An auth store that cannot be read as a file.
  rmSync(path.join(m.theirs, 'auth.json'))
  mkdirSync(path.join(m.theirs, 'auth.json'))

  expect(migrateMatrixCodexAccounts(m.config, { userData: m.userData, env: {}, homeDir: m.person })).toBe('pending')
  expect(warn).toHaveBeenCalledWith('[Matrix] matrix_codex_migration_pending')
  expect(JSON.stringify(warn.mock.calls)).not.toContain(m.userData)
  expect(existsSync(m.legacy)).toBe(false)
  expect(json(path.join(m.mine, 'auth.json')).providers['openai-codex']).toBeUndefined()
  expect(existsSync(path.join(m.userData, MATRIX_CODEX_MIGRATION_MARKER))).toBe(false)

  // Fixed: the next start finishes.
  rmSync(path.join(m.theirs, 'auth.json'), { recursive: true })
  expect(migrateMatrixCodexAccounts(m.config, { userData: m.userData, env: {}, homeDir: m.person })).toBe('migrated')

  // No runtime folder yet (a first launch on a Mac that has held two accounts): nothing to do, done.
  const empty = mkdtempSync(path.join(os.tmpdir(), 'atum-codex-migration-'))
  roots.push(empty)
  rememberMatrixAccountOnThisMac(empty, 'c'.repeat(64))
  rememberMatrixAccountOnThisMac(empty, 'd'.repeat(64))

  expect(
    migrateMatrixCodexAccounts(
      { profiles: path.join(empty, 'hermes') },
      { userData: empty, env: {}, homeDir: path.join(empty, 'person') }
    )
  ).toBe('migrated')
})

it('is a no-op on a Mac with one Atum account, and migrates at the first start after a second one', () => {
  const m = mac({ accounts: 1 })
  const before = readFileSync(path.join(m.mine, 'auth.json'), 'utf8')

  expect(migrateMatrixCodexAccounts(m.config, { userData: m.userData, env: {}, homeDir: m.person })).toBe('single')
  // Nothing cleared, nothing marked: the account's assistants keep the sign-in they have.
  expect(readFileSync(path.join(m.mine, 'auth.json'), 'utf8')).toBe(before)
  expect(existsSync(m.legacy)).toBe(true)
  expect(existsSync(path.join(m.userData, MATRIX_CODEX_MIGRATION_MARKER))).toBe(false)
  // A fresh install has held no account yet: the same.
  expect(
    migrateMatrixCodexAccounts(m.config, { userData: path.join(m.userData, 'fresh'), env: {}, homeDir: m.person })
  ).toBe('single')

  // Another person signs in on this Mac: from the next start, accounts are kept apart.
  rememberMatrixAccountOnThisMac(m.userData, 'e'.repeat(64))
  expect(migrateMatrixCodexAccounts(m.config, { userData: m.userData, env: {}, homeDir: m.person })).toBe('migrated')
  expect(json(path.join(m.mine, 'auth.json')).providers['openai-codex']).toBeUndefined()
})

it("migrates at a second account's first start, before any of its assistants open", () => {
  // Account A's folder only; account B is signed in at this start and has never launched here.
  const m = mac({ accounts: 1 })
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)

  // A itself starting again changes nothing.
  expect(
    migrateMatrixCodexAccounts(m.config, { userData: m.userData, accountKey: A, env: {}, homeDir: m.person })
  ).toBe('single')
  expect(json(path.join(m.mine, 'auth.json')).providers['openai-codex']).toBeDefined()

  expect(
    migrateMatrixCodexAccounts(m.config, { userData: m.userData, accountKey: B, env: {}, homeDir: m.person })
  ).toBe('migrated')

  // Every profile forgot its ChatGPT copy, and B now counts as this Mac's second account.
  for (const home of [m.mine, m.theirs]) {
    expect(json(path.join(home, 'auth.json')).providers['openai-codex']).toBeUndefined()
  }

  expect(existsSync(path.join(m.userData, 'accounts', B))).toBe(true)
  expect(existsSync(path.join(m.userData, MATRIX_CODEX_MIGRATION_MARKER))).toBe(true)
})

it("never deletes from the person's Codex CLI folder, whatever their shell names as the shared folder", () => {
  const m = mac({ pinned: false })
  const inCli = path.join(m.person, '.codex', 'codex_auth.json')
  write(inCli, { refresh_token: 'cli' })

  expect(
    migrateMatrixCodexAccounts(m.config, {
      userData: m.userData,
      env: { HERMES_CODEX_SHARED_AUTH_DIR: path.join(m.person, '.codex') },
      homeDir: m.person
    })
  ).toBe('migrated')
  expect(existsSync(inCli)).toBe(true)
  expect(existsSync(m.cli)).toBe(true)
})

it('finds the old store where Hermes looked for it before 0.18.3', () => {
  const person = '/home/example'
  const atumHome = `/home/example/Library/Application Support/Atum/hermes/${'a'.repeat(64)}`

  const pinned = {
    bundled: { browserBin: '', nodeBin: '', chromium: '', sharedAuthDir: '/home/example/.hermes/shared' }
  }

  // The person's own setting first, then the packaged pin, then their other setting.
  expect(
    matrixLegacyCodexStore(pinned, atumHome, { HERMES_CODEX_SHARED_AUTH_DIR: '~/codex-store' }, person, 'darwin')
  ).toBe('/home/example/codex-store/codex_auth.json')
  expect(matrixLegacyCodexStore(pinned, atumHome, { HERMES_SHARED_AUTH_DIR: '/elsewhere' }, person, 'darwin')).toBe(
    '/home/example/.hermes/shared/codex_auth.json'
  )
  expect(matrixLegacyCodexStore({}, atumHome, { HERMES_SHARED_AUTH_DIR: ' /elsewhere ' }, person, 'darwin')).toBe(
    '/elsewhere/codex_auth.json'
  )

  // Unpinned, Hermes's own root for that home: the CLI's under ~/.hermes, a profiles folder's
  // parent, else the home itself.
  expect(matrixLegacyCodexStore({}, atumHome, {}, person, 'darwin')).toBe(`${atumHome}/shared/codex_auth.json`)
  expect(matrixLegacyCodexStore({}, `/home/example/.hermes/profiles/${'b'.repeat(64)}`, {}, person, 'darwin')).toBe(
    '/home/example/.hermes/shared/codex_auth.json'
  )
  expect(matrixLegacyCodexStore({}, `/data/profiles/${'c'.repeat(64)}`, {}, person, 'darwin')).toBe(
    '/data/shared/codex_auth.json'
  )

  // A folder it cannot place is left alone.
  expect(matrixLegacyCodexStore({}, atumHome, { HERMES_CODEX_SHARED_AUTH_DIR: 'relative' }, person, 'darwin')).toBe(
    undefined
  )
})
