/**
 * Tests for electron/hermes-home-seed.ts — the seed-once migration from the
 * CLI product home into the packaged Atum engine home.
 *
 * Run with: npm run test:desktop:platforms (vitest project "electron").
 */

import assert from 'node:assert/strict'
import path from 'node:path'

import { test } from 'vitest'

import { SEED_MARKER_NAME, seedHermesHomeOnce, shouldSeedPackagedHome } from './hermes-home-seed'

// --- in-memory filesystem ---------------------------------------------------
// node: { type: 'file' | 'dir' | 'symlink' } — directories are implicit
// prefixes, files/symlinks are explicit keys. Enough to prove the copy
// boundaries without touching a real disk.

function makeFakeFs(files: Record<string, 'file' | 'symlink'> = {}) {
  const nodes = new Map(Object.entries(files))

  const normalize = p => path.resolve(p)

  const api = {
    nodes,
    exists: p => {
      const target = normalize(p)

      if (nodes.has(target)) {
        return true
      }

      for (const key of nodes.keys()) {
        if (key.startsWith(target + path.sep)) {
          return true
        }
      }

      return false
    },
    isDirectory: p => {
      if (nodes.has(normalize(p))) {
        return false
      }

      return api.exists(p)
    },
    isSymbolicLink: p => nodes.get(normalize(p)) === 'symlink',
    copyEntry: (source, target) => {
      const src = normalize(source)
      const dst = normalize(target)

      if (nodes.has(src)) {
        nodes.set(dst, nodes.get(src))

        return
      }

      for (const [key, value] of [...nodes.entries()]) {
        if (key.startsWith(src + path.sep)) {
          nodes.set(dst + key.slice(src.length), value)
        }
      }
    },
    mkdirp: () => {},
    rename: (source, target) => {
      api.copyEntry(source, target)
      api.remove(source)
    },
    remove: target => {
      const prefix = normalize(target)

      for (const key of [...nodes.keys()]) {
        if (key === prefix || key.startsWith(prefix + path.sep)) {
          nodes.delete(key)
        }
      }
    },
    writeFile: (target, _contents) => {
      nodes.set(normalize(target), 'file')
    },
    now: () => '2026-08-12T00:00:00.000Z',
    pathsUnder: root =>
      [...nodes.keys()]
        .filter(key => key.startsWith(normalize(root) + path.sep))
        .map(key => path.relative(normalize(root), key))
        .sort()
  }

  return api
}

const SOURCE = '/cli-home'
const TARGET = '/atum-home'

function seedWith(fake, overrides: any = {}) {
  return seedHermesHomeOnce({
    sourceHome: SOURCE,
    targetHome: TARGET,
    deps: {
      exists: fake.exists,
      isDirectory: fake.isDirectory,
      isSymbolicLink: fake.isSymbolicLink,
      copyEntry: fake.copyEntry,
      mkdirp: fake.mkdirp,
      rename: fake.rename,
      remove: fake.remove,
      writeFile: fake.writeFile,
      now: fake.now,
      ...overrides
    }
  })
}

// --- skip states ---

test('source absent: no home is created, nothing is copied', () => {
  const fake = makeFakeFs()

  const result = seedWith(fake)

  assert.equal(result.status, 'skipped')
  assert.equal(result.reason, 'source-absent')
  assert.ok(!fake.exists(TARGET))
  assert.ok(!fake.exists(`${TARGET}.seed-in-progress`))
})

test('target exists: seed never runs, even with a rich source', () => {
  const fake = makeFakeFs({
    [`${SOURCE}/config.yaml`]: 'file',
    [`${TARGET}/config.yaml`]: 'file',
    [`${TARGET}/sessions/x.db`]: 'file'
  })

  const result = seedWith(fake)

  assert.equal(result.status, 'skipped')
  assert.equal(result.reason, 'target-exists')
  assert.deepEqual(fake.pathsUnder(TARGET), ['config.yaml', 'sessions/x.db'])
})

test('source and target resolving to the same directory is a no-op', () => {
  const fake = makeFakeFs({ [`${SOURCE}/config.yaml`]: 'file' })

  const result = seedHermesHomeOnce({
    sourceHome: SOURCE,
    targetHome: `${SOURCE}/.`,
    deps: fake
  } as any)

  assert.equal(result.status, 'skipped')
  assert.equal(result.reason, 'same-home')
})

test('a source with no allowlisted files seeds nothing and writes no marker', () => {
  const fake = makeFakeFs({
    [`${SOURCE}/sessions/x.db`]: 'file',
    [`${SOURCE}/logs/agent.log`]: 'file'
  })

  const result = seedWith(fake)

  assert.equal(result.status, 'skipped')
  assert.equal(result.reason, 'nothing-to-seed')
  assert.ok(!fake.exists(TARGET))
  assert.ok(fake.exists(`${SOURCE}/sessions/x.db`))
  assert.ok(fake.exists(`${SOURCE}/logs/agent.log`))
})

// --- copy boundaries ---

test('seeds exactly the allowlist; forbidden product state is never copied', () => {
  const fake = makeFakeFs({
    // allowlisted
    [`${SOURCE}/config.yaml`]: 'file',
    [`${SOURCE}/.env`]: 'file',
    [`${SOURCE}/auth.json`]: 'file',
    [`${SOURCE}/SOUL.md`]: 'file',
    [`${SOURCE}/skins/ares.yaml`]: 'file',
    // forbidden — sessions, profiles, memory, plugins, cron, cache, logs,
    // source checkout, node runtime, locks, shared refresh-token store
    [`${SOURCE}/sessions/state.db`]: 'file',
    [`${SOURCE}/profiles/coder/config.yaml`]: 'file',
    [`${SOURCE}/memory/honcho.db`]: 'file',
    [`${SOURCE}/plugins/kanban/plugin.yaml`]: 'file',
    [`${SOURCE}/cron/jobs.json`]: 'file',
    [`${SOURCE}/cache/index.bin`]: 'file',
    [`${SOURCE}/logs/agent.log`]: 'file',
    [`${SOURCE}/hermes-agent/run_agent.py`]: 'file',
    [`${SOURCE}/node/bin/node`]: 'file',
    [`${SOURCE}/cron/.tick.lock`]: 'file',
    [`${SOURCE}/shared/codex_auth.json`]: 'file',
    [`${SOURCE}/shared/codex_auth.lock`]: 'file'
  })

  const result = seedWith(fake)

  assert.equal(result.status, 'seeded')
  assert.deepEqual(
    fake.pathsUnder(TARGET),
    ['.env', SEED_MARKER_NAME, 'SOUL.md', 'auth.json', 'config.yaml', 'skins/ares.yaml'].sort()
  )

  // The source is never moved, deleted, or re-synced — every original entry
  // is still exactly where the CLI left it.
  for (const forbidden of ['sessions/state.db', 'profiles/coder/config.yaml', 'shared/codex_auth.json']) {
    assert.ok(fake.exists(path.join(SOURCE, forbidden)), `source must keep ${forbidden}`)
  }
})

test('the shared credential store is never seeded — it stays cross-process shared in place', () => {
  const fake = makeFakeFs({
    [`${SOURCE}/config.yaml`]: 'file',
    [`${SOURCE}/shared/codex_auth.json`]: 'file',
    [`${SOURCE}/shared/nous_auth.json`]: 'file'
  })

  seedWith(fake)

  assert.ok(!fake.exists(`${TARGET}/shared/codex_auth.json`))
  assert.ok(!fake.exists(`${TARGET}/shared/nous_auth.json`))
  assert.ok(fake.exists(`${SOURCE}/shared/codex_auth.json`))
})

test('symlinked entries are skipped so the Atum home can never alias the CLI home', () => {
  const fake = makeFakeFs({
    [`${SOURCE}/config.yaml`]: 'symlink',
    [`${SOURCE}/auth.json`]: 'file'
  })

  const result = seedWith(fake)

  assert.equal(result.status, 'seeded')
  assert.deepEqual(result.entries, ['auth.json'])
  assert.deepEqual(result.skipped, ['config.yaml'])
  assert.ok(!fake.exists(`${TARGET}/config.yaml`))
})

// --- marker honesty / atomicity ---

test('a completed seed always carries its marker with entry names only', () => {
  const writes: Record<string, string> = {}
  const fake = makeFakeFs({ [`${SOURCE}/config.yaml`]: 'file' })

  const result = seedWith(fake, {
    writeFile: (target, contents) => {
      writes[path.basename(target)] = contents
      fake.writeFile(target, contents)
    }
  })

  assert.equal(result.status, 'seeded')
  assert.ok(fake.exists(`${TARGET}/${SEED_MARKER_NAME}`))

  const marker = JSON.parse(writes[SEED_MARKER_NAME])

  assert.equal(marker.schemaVersion, 1)
  assert.deepEqual(marker.entries, ['config.yaml'])
  assert.equal(marker.sourceHome, SOURCE)
})

test('second launch skips: the seed is strictly once', () => {
  const fake = makeFakeFs({ [`${SOURCE}/config.yaml`]: 'file' })

  assert.equal(seedWith(fake).status, 'seeded')

  // Source gains a new file after the seed — it must NOT be re-synced.
  fake.nodes.set(path.resolve(`${SOURCE}/auth.json`), 'file')
  const second = seedWith(fake)

  assert.equal(second.status, 'skipped')
  assert.equal(second.reason, 'target-exists')
  assert.ok(!fake.exists(`${TARGET}/auth.json`))
})

test('crash residue staging dir is cleaned and the seed retried', () => {
  const fake = makeFakeFs({
    [`${SOURCE}/config.yaml`]: 'file',
    [`${TARGET}.seed-in-progress/.env`]: 'file'
  })

  const result = seedWith(fake)

  assert.equal(result.status, 'seeded')
  assert.ok(!fake.exists(`${TARGET}.seed-in-progress`))
  assert.deepEqual(fake.pathsUnder(TARGET), [SEED_MARKER_NAME, 'config.yaml'])
})

test('if the target appears mid-seed the race loser cleans up and stands down', () => {
  const fake = makeFakeFs({ [`${SOURCE}/config.yaml`]: 'file' })

  const result = seedWith(fake, {
    writeFile: (target, contents) => {
      fake.writeFile(target, contents)
      // Another window finishes its own seed between our copy and rename.
      fake.nodes.set(path.resolve(`${TARGET}/config.yaml`), 'file')
    }
  })

  assert.equal(result.status, 'skipped')
  assert.equal(result.reason, 'target-appeared')
  assert.ok(!fake.exists(`${TARGET}.seed-in-progress`))
})

// --- entry gate ---

test('shouldSeedPackagedHome: packaged only, never inside a managed sandbox', () => {
  assert.equal(shouldSeedPackagedHome({ isPackaged: false, env: {} }), false)
  assert.equal(shouldSeedPackagedHome({ isPackaged: true, env: {} }), true)
  assert.equal(
    shouldSeedPackagedHome({ isPackaged: true, env: { HERMES_DESKTOP_USER_DATA_DIR: '/tmp/sandbox' } }),
    false
  )
})
