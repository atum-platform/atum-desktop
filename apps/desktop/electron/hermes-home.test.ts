/**
 * Tests for electron/hermes-home.ts — the packaged/dev/platform precedence
 * ladder for the desktop's HERMES_HOME and the shared-credential pin.
 *
 * Run with: npm run test:desktop:platforms (vitest project "electron").
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  nativeHermesProductHome,
  resolveCliHomeForSeed,
  resolveDesktopHermesHome,
  resolveSharedAuthDirEnv,
  sharedAuthDirCandidates
} from './hermes-home'

const POSIX = 'darwin'
const WIN = 'win32'

const baseDeps = {
  platform: POSIX,
  env: {} as Record<string, string>,
  userDataPath: '/home/example/Library/Application Support/Atum',
  homeDir: '/home/example',
  directoryExists: () => false
}

// --- packaged ladder ---

test('packaged default: userData/hermes-home, never the CLI home', () => {
  const home = resolveDesktopHermesHome({ ...baseDeps, isPackaged: true })

  assert.equal(home, '/home/example/Library/Application Support/Atum/hermes-home')
  assert.ok(!home.includes('.hermes'))
})

test('packaged ignores an inherited HERMES_HOME', () => {
  const home = resolveDesktopHermesHome({
    ...baseDeps,
    isPackaged: true,
    env: { HERMES_HOME: '/home/example/.hermes' }
  })

  assert.equal(home, '/home/example/Library/Application Support/Atum/hermes-home')
})

test('packaged ignores the Windows registry HERMES_HOME', () => {
  const home = resolveDesktopHermesHome({
    ...baseDeps,
    isPackaged: true,
    platform: WIN,
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    userDataPath: 'C:\\Users\\u\\AppData\\Roaming\\Atum',
    homeDir: 'C:\\Users\\u',
    readWindowsUserEnvVar: () => 'F:\\Hermes\\data'
  })

  assert.equal(home, 'C:\\Users\\u\\AppData\\Roaming\\Atum\\hermes-home')
})

test('packaged honors the explicit product-scoped support override', () => {
  const home = resolveDesktopHermesHome({
    ...baseDeps,
    isPackaged: true,
    env: { HERMES_DESKTOP_HERMES_HOME: '/Volumes/support/atum-home' }
  })

  assert.equal(home, '/Volumes/support/atum-home')
})

test('packaged support override is normalized through the profiles-root rule', () => {
  const home = resolveDesktopHermesHome({
    ...baseDeps,
    isPackaged: true,
    env: { HERMES_DESKTOP_HERMES_HOME: '/Volumes/support/atum-home/profiles/coder' }
  })

  assert.equal(home, '/Volumes/support/atum-home')
})

test('packaged test sandbox keeps precedence over everything, honoring its pinned HERMES_HOME', () => {
  const home = resolveDesktopHermesHome({
    ...baseDeps,
    isPackaged: true,
    env: {
      HERMES_DESKTOP_USER_DATA_DIR: '/tmp/sandbox/electron-user-data',
      HERMES_HOME: '/tmp/sandbox/hermes-home',
      HERMES_DESKTOP_HERMES_HOME: '/Volumes/support/atum-home'
    }
  })

  assert.equal(home, '/tmp/sandbox/hermes-home')
})

test('packaged test sandbox without a pinned HERMES_HOME derives hermes-home under the sandbox', () => {
  const home = resolveDesktopHermesHome({
    ...baseDeps,
    isPackaged: true,
    env: { HERMES_DESKTOP_USER_DATA_DIR: '/tmp/sandbox/electron-user-data' }
  })

  assert.equal(home, '/tmp/sandbox/electron-user-data/hermes-home')
})

// --- development ladder (historical behavior preserved) ---

test('dev honors HERMES_HOME first, exactly like the historical resolver', () => {
  const home = resolveDesktopHermesHome({
    ...baseDeps,
    isPackaged: false,
    env: { HERMES_HOME: '/custom/home' }
  })

  assert.equal(home, '/custom/home')
})

test('dev sandbox derives hermes-home under the override when HERMES_HOME is unset', () => {
  const home = resolveDesktopHermesHome({
    ...baseDeps,
    isPackaged: false,
    env: { HERMES_DESKTOP_USER_DATA_DIR: '/tmp/sandbox/user-data' }
  })

  assert.equal(home, '/tmp/sandbox/user-data/hermes-home')
})

test('dev on Windows consults the User-scoped registry before defaults', () => {
  const home = resolveDesktopHermesHome({
    ...baseDeps,
    isPackaged: false,
    platform: WIN,
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    homeDir: 'C:\\Users\\u',
    readWindowsUserEnvVar: () => 'F:\\Hermes\\data'
  })

  assert.equal(home, 'F:\\Hermes\\data')
})

test('dev on Windows prefers legacy ~/.hermes only when LOCALAPPDATA is absent', () => {
  const deps = {
    ...baseDeps,
    isPackaged: false,
    platform: WIN,
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    homeDir: 'C:\\Users\\u',
    readWindowsUserEnvVar: () => null
  }

  assert.equal(
    resolveDesktopHermesHome({ ...deps, directoryExists: p => p.endsWith('.hermes') }),
    'C:\\Users\\u\\.hermes'
  )
  assert.equal(
    resolveDesktopHermesHome({ ...deps, directoryExists: () => true }),
    'C:\\Users\\u\\AppData\\Local\\hermes'
  )
})

test('dev POSIX default is ~/.hermes', () => {
  assert.equal(resolveDesktopHermesHome({ ...baseDeps, isPackaged: false }), '/home/example/.hermes')
})

// --- native CLI home mirror ---

test('nativeHermesProductHome mirrors hermes_constants._get_platform_default_hermes_home', () => {
  assert.equal(nativeHermesProductHome({ platform: POSIX, env: {}, homeDir: '/home/example' }), '/home/example/.hermes')
  assert.equal(
    nativeHermesProductHome({
      platform: WIN,
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      homeDir: 'C:\\Users\\u'
    }),
    'C:\\Users\\u\\AppData\\Local\\hermes'
  )
  // LOCALAPPDATA missing → ~\AppData\Local fallback, same as Python.
  assert.equal(
    nativeHermesProductHome({ platform: WIN, env: {}, homeDir: 'C:\\Users\\u' }),
    'C:\\Users\\u\\AppData\\Local\\hermes'
  )
})

// --- shared credential plane ---

test('packaged pins HERMES_SHARED_AUTH_DIR to the CLI native shared dir', () => {
  const pin = resolveSharedAuthDirEnv({ ...baseDeps, isPackaged: true })

  assert.deepEqual(pin, { HERMES_SHARED_AUTH_DIR: '/home/example/.hermes/shared' })
})

test('packaged Windows falls back to the legacy ~/.hermes/shared when it exists', () => {
  const deps = {
    isPackaged: true,
    platform: WIN,
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    homeDir: 'C:\\Users\\u'
  }

  // Neither exists → native default wins.
  assert.deepEqual(resolveSharedAuthDirEnv({ ...deps, directoryExists: () => false }), {
    HERMES_SHARED_AUTH_DIR: 'C:\\Users\\u\\AppData\\Local\\hermes\\shared'
  })
  // Legacy store present → share the credential the CLI actually has.
  assert.deepEqual(resolveSharedAuthDirEnv({ ...deps, directoryExists: p => p === 'C:\\Users\\u\\.hermes\\shared' }), {
    HERMES_SHARED_AUTH_DIR: 'C:\\Users\\u\\.hermes\\shared'
  })
})

test('shared pin is a no-op in dev, in sandboxes, and under explicit user overrides', () => {
  assert.deepEqual(resolveSharedAuthDirEnv({ ...baseDeps, isPackaged: false }), {})
  assert.deepEqual(
    resolveSharedAuthDirEnv({ ...baseDeps, isPackaged: true, env: { HERMES_DESKTOP_USER_DATA_DIR: '/tmp/sb' } }),
    {}
  )
  assert.deepEqual(
    resolveSharedAuthDirEnv({ ...baseDeps, isPackaged: true, env: { HERMES_SHARED_AUTH_DIR: '/x/shared' } }),
    {}
  )
  assert.deepEqual(
    resolveSharedAuthDirEnv({ ...baseDeps, isPackaged: true, env: { HERMES_CODEX_SHARED_AUTH_DIR: '/x/codex' } }),
    {}
  )
})

test('shared candidates only ever point at CLI credential dirs, never at the Atum home', () => {
  const atumHome = resolveDesktopHermesHome({ ...baseDeps, isPackaged: true })

  for (const candidate of sharedAuthDirCandidates(baseDeps)) {
    assert.ok(!candidate.startsWith(atumHome), `${candidate} must not live under the Atum home`)
  }
})

test('resolveCliHomeForSeed prefers a legacy-only Windows ~/.hermes over an absent LOCALAPPDATA home', () => {
  const deps = { platform: WIN, env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, homeDir: 'C:\\Users\\u' }

  assert.equal(
    resolveCliHomeForSeed({ ...deps, directoryExists: p => p === 'C:\\Users\\u\\.hermes' }),
    'C:\\Users\\u\\.hermes'
  )
  assert.equal(resolveCliHomeForSeed({ ...deps, directoryExists: () => true }), 'C:\\Users\\u\\AppData\\Local\\hermes')
  assert.equal(resolveCliHomeForSeed({ platform: POSIX, env: {}, homeDir: '/home/example' }), '/home/example/.hermes')
})
