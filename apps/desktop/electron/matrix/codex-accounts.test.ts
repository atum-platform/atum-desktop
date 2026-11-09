import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import {
  matrixAccountsOnThisMac,
  matrixCodexStoreMode,
  matrixSharedCodexHere,
  rememberMatrixAccountOnThisMac
} from './codex-accounts'
import { matrixAccountCodexScope, matrixHermesEnvironment } from './hermes-runtime'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function userData() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'atum-codex-accounts-'))
  roots.push(root)

  return root
}

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

it('keeps the shared store for the one account a Mac has, and splits once a second account arrives', () => {
  const root = userData()

  // A fresh install, then its first account: one account, the store as 0.18.2 kept it.
  expect(matrixCodexStoreMode(root)).toBe('shared')
  expect(matrixCodexStoreMode(root, A)).toBe('shared')
  expect(matrixAccountsOnThisMac(root)).toEqual([A])
  // The same account again (a restart, signing out and back in) is still one.
  expect(matrixCodexStoreMode(root, A)).toBe('shared')

  // Another person signs in on this Mac: both accounts are kept apart from now on, also when
  // the first comes back.
  expect(matrixCodexStoreMode(root, B)).toBe('account')
  expect(matrixCodexStoreMode(root, A)).toBe('account')
  expect(matrixCodexStoreMode(root)).toBe('account')
})

it('counts the account folders the local brain already made, and only real folders named by a key', () => {
  const root = userData()
  // The local brain's folder for an account that used this Mac before 0.18.4.
  mkdirSync(path.join(root, 'accounts', A, 'local-brain'), { recursive: true })
  // Not accounts: a file, a link, a folder with another name.
  writeFileSync(path.join(root, 'accounts', 'c'.repeat(64)), '')
  symlinkSync(path.join(root, 'accounts', A), path.join(root, 'accounts', 'd'.repeat(64)))
  mkdirSync(path.join(root, 'accounts', 'not-a-key'))

  expect(matrixAccountsOnThisMac(root)).toEqual([A])
  expect(matrixCodexStoreMode(root, A)).toBe('shared')
  expect(matrixCodexStoreMode(root, B)).toBe('account')
})

it('keeps accounts apart when it cannot tell, and ignores a malformed account key', () => {
  const root = userData()
  // `accounts` is a file: unreadable as a folder.
  writeFileSync(path.join(root, 'accounts'), '')
  expect(matrixCodexStoreMode(root, A)).toBe('account')

  const other = userData()
  rememberMatrixAccountOnThisMac(other, '../escape')
  expect(matrixCodexStoreMode(other, 'NOT-HEX')).toBe('shared')
  expect(matrixAccountsOnThisMac(other)).toEqual([])
})

it('never opens the shared store for a launch whose account it cannot read', () => {
  const root = userData()
  // A Mac with account A only.
  rememberMatrixAccountOnThisMac(root, A)

  // Signed out, a vault that cannot be read, a launch for no account: kept apart.
  expect(matrixSharedCodexHere(root, () => undefined)).toBe(false)

  expect(
    matrixSharedCodexHere(root, () => {
      throw new Error('matrix_vault_invalid')
    })
  ).toBe(false)

  expect(matrixSharedCodexHere(root, () => 'NOT-HEX')).toBe(false)
  // None of them counts as an account.
  expect(matrixAccountsOnThisMac(root)).toEqual([A])

  // The one account itself keeps the shared store; a fresh install's first account too.
  expect(matrixSharedCodexHere(root, () => A)).toBe(true)
  expect(matrixSharedCodexHere(userData(), () => B)).toBe(true)
  // A second account is recorded and kept apart from its first launch.
  expect(matrixSharedCodexHere(root, () => B)).toBe(false)
  expect(matrixAccountsOnThisMac(root).sort()).toEqual([A, B])
})

it("never lets the person's shell choose a one-account launch's shared store", () => {
  const root = userData()
  const config = { python: '/fixture/python', source: '/fixture/source', profiles: path.join(root, 'hermes') }
  const home = path.join(config.profiles, 'e'.repeat(64))

  // A stale export after debugging 0.18.3, which Hermes would read before the pinned folder.
  const shell = {
    PATH: '/usr/bin',
    HERMES_CODEX_SHARED_AUTH_DIR: '/elsewhere',
    HERMES_SHARED_AUTH_DIR: '/elsewhere-too',
    CODEX_HOME: '/p/custom-codex'
  }

  const pinned = {
    ...config,
    bundled: { browserBin: '/b', nodeBin: '/n', chromium: '/c', sharedAuthDir: '/p/.hermes/shared' }
  }

  const packaged = matrixHermesEnvironment(pinned, home, home, shell, null)
  expect(packaged.HERMES_CODEX_SHARED_AUTH_DIR).toBeUndefined()
  // The bundled pin still applies.
  expect(packaged.HERMES_SHARED_AUTH_DIR).toBe('/p/.hermes/shared')
  // The person's own Codex CLI folder passes on a one-account Mac, as in 0.18.2.
  expect(packaged.CODEX_HOME).toBe('/p/custom-codex')

  // Development (no pin): Hermes's own default, not the shell's.
  const development = matrixHermesEnvironment(config, home, home, shell, null)
  expect(development.HERMES_CODEX_SHARED_AUTH_DIR).toBeUndefined()
  expect(development.HERMES_SHARED_AUTH_DIR).toBeUndefined()
})

it("leaves Hermes's own Codex store to a one-account launch and pins the account's folder otherwise", () => {
  const root = userData()
  const config = { python: '/fixture/python', source: '/fixture/source', profiles: path.join(root, 'hermes') }
  const home = path.join(config.profiles, 'e'.repeat(64))

  const pinned = {
    ...config,
    bundled: { browserBin: '/b', nodeBin: '/n', chromium: '/c', sharedAuthDir: '/p/.hermes/shared' }
  }

  // One account: exactly 0.18.2's environment, the person's own settings passing through.
  const single = matrixHermesEnvironment(pinned, home, home, { PATH: '/usr/bin', CODEX_HOME: '/p/custom-codex' }, null)
  expect(single.HERMES_SHARED_AUTH_DIR).toBe('/p/.hermes/shared')
  expect(single.HERMES_CODEX_SHARED_AUTH_DIR).toBeUndefined()
  expect(single.CODEX_HOME).toBe('/p/custom-codex')

  // Two accounts: the account's own folder, whatever the shell says.
  const scope = matrixAccountCodexScope(config, 'owner-a')

  const apart = matrixHermesEnvironment(
    pinned,
    home,
    home,
    {
      PATH: '/usr/bin',
      HERMES_CODEX_SHARED_AUTH_DIR: '/elsewhere',
      HERMES_SHARED_AUTH_DIR: '/elsewhere-too',
      CODEX_HOME: '/p/.codex'
    },
    scope
  )

  expect(apart.HERMES_CODEX_SHARED_AUTH_DIR).toBe(scope.authDir)
  expect(apart.CODEX_HOME).toBe(scope.codexHome)
  expect(apart.HERMES_SHARED_AUTH_DIR).toBe('/p/.hermes/shared')
})
