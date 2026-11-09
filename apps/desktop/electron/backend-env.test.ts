import assert from 'node:assert/strict'
import path from 'node:path'

import { test } from 'vitest'

import {
  appendUniquePathEntries,
  buildDesktopBackendEnv,
  buildDesktopBackendPath,
  normalizeHermesHomeRoot,
  pathEnvKey,
  POSIX_SANE_PATH_ENTRIES
} from './backend-env'

test('desktop backend PATH adds Hermes-managed bins and missing POSIX sane entries', () => {
  const result = buildDesktopBackendPath({
    hermesHome: '/home/example/.hermes',
    venvRoot: '/home/example/.hermes/hermes-agent/venv',
    currentPath: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
    platform: 'darwin',
    pathModule: path.posix
  })

  const entries = result.split(':')
  assert.equal(entries[0], '/home/example/.hermes/node/bin')
  assert.equal(entries[1], '/home/example/.hermes/hermes-agent/venv/bin')
  assert.ok(entries.includes('/opt/homebrew/bin'), 'Apple Silicon Homebrew bin is added')
  assert.ok(entries.includes('/opt/homebrew/sbin'), 'Apple Silicon Homebrew sbin is added')
  assert.ok(entries.includes('/usr/local/sbin'), 'missing standard sbin is added')

  for (const expected of POSIX_SANE_PATH_ENTRIES) {
    assert.ok(entries.includes(expected), `${expected} should be present`)
  }
})

test('desktop backend PATH preserves first occurrence and avoids duplicates', () => {
  const result = buildDesktopBackendPath({
    hermesHome: '/home/example/.hermes',
    venvRoot: '/home/example/.hermes/hermes-agent/venv',
    currentPath: '/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin:/bin',
    platform: 'darwin',
    pathModule: path.posix
  })

  const entries = result.split(':')
  assert.equal(entries.filter(entry => entry === '/opt/homebrew/bin').length, 1)
  assert.ok(
    entries.indexOf('/opt/homebrew/bin') < entries.indexOf('/opt/homebrew/sbin'),
    'existing Homebrew bin keeps its precedence over appended missing sane entries'
  )
})

test('buildDesktopBackendEnv extends PYTHONPATH and backend PATH together', () => {
  const env = buildDesktopBackendEnv({
    hermesHome: '/home/example/.hermes',
    pythonPathEntries: ['/repo/hermes-agent'],
    venvRoot: '/home/example/.hermes/hermes-agent/venv',
    currentEnv: {
      PATH: '/usr/bin:/bin',
      PYTHONPATH: '/existing/pythonpath'
    },
    platform: 'darwin',
    pathModule: path.posix
  })

  assert.equal(env.PYTHONPATH, '/repo/hermes-agent:/existing/pythonpath')
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1')
  assert.equal(env.ATUM_APPS_CATALOG, undefined)
  assert.ok(env.PATH.startsWith('/home/example/.hermes/node/bin:/home/example/.hermes/hermes-agent/venv/bin:'))
  assert.ok(env.PATH.includes('/opt/homebrew/bin'))
})

test('buildDesktopBackendEnv hands every backend the bundled pets directory when main has one', () => {
  const base = {
    hermesHome: '/home/example/.hermes',
    venvRoot: '/home/example/.hermes/hermes-agent/venv',
    platform: 'darwin',
    pathModule: path.posix
  }

  const withBundle = buildDesktopBackendEnv({ ...base, currentEnv: { PATH: '/usr/bin', ATUM_BUNDLED_PETS_DIR: '/Applications/Atum.app/Contents/Resources/app.asar.unpacked/assets/pets' } })
  assert.equal(withBundle.ATUM_BUNDLED_PETS_DIR, '/Applications/Atum.app/Contents/Resources/app.asar.unpacked/assets/pets')

  // No bundle (a CLI, a test): the variable is absent, not empty — the store
  // treats absence as "no bundled source", which is the truth.
  const without = buildDesktopBackendEnv({ ...base, currentEnv: { PATH: '/usr/bin' } })
  assert.equal('ATUM_BUNDLED_PETS_DIR' in without, false)
})

test('normalizeHermesHomeRoot maps profile homes back to the global Hermes root', () => {
  assert.equal(
    normalizeHermesHomeRoot('/home/example/.hermes/profiles/oracle', { pathModule: path.posix }),
    '/home/example/.hermes'
  )
  assert.equal(
    normalizeHermesHomeRoot('C:\\Users\\test\\AppData\\Local\\hermes\\profiles\\oracle', { pathModule: path.win32 }),
    'C:\\Users\\test\\AppData\\Local\\hermes'
  )
  assert.equal(normalizeHermesHomeRoot('/home/example/.hermes', { pathModule: path.posix }), '/home/example/.hermes')
})

test('Windows PATH casing and delimiter are preserved without POSIX sane entries', () => {
  const env = buildDesktopBackendEnv({
    hermesHome: 'C:\\Users\\test\\AppData\\Local\\hermes',
    pythonPathEntries: ['C:\\repo\\hermes-agent'],
    venvRoot: 'C:\\Users\\test\\AppData\\Local\\hermes\\hermes-agent\\venv',
    currentEnv: {
      Path: 'C:\\Windows\\System32;C:\\Windows',
      PYTHONPATH: 'C:\\existing\\pythonpath'
    },
    platform: 'win32',
    pathModule: path.win32
  })

  assert.equal(pathEnvKey({ Path: 'x' }, 'win32'), 'Path')
  assert.equal(env.PATH, undefined)
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1')
  assert.ok(env.Path.startsWith('C:\\Users\\test\\AppData\\Local\\hermes\\node\\bin;'))
  assert.ok(env.Path.includes('\\venv\\Scripts;'))
  assert.ok(env.Path.includes(';C:\\Windows\\System32;C:\\Windows'))
  assert.equal(env.Path.includes('/opt/homebrew/bin'), false)
})

test('appendUniquePathEntries drops empty entries and keeps first occurrence', () => {
  assert.equal(appendUniquePathEntries([':/a::/b', ['/a', '/c']], { delimiter: ':' }), '/a:/b:/c')
})
