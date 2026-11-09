/**
 * Tests for electron/atum-default-pet.ts — seeding Gigi into a fresh
 * desktop-owned Hermes home, and the rule that a config which already says
 * anything about the pet is left completely alone.
 *
 * Run with: npm run test:desktop:platforms (vitest project "electron").
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  type AtumDefaultPetDeps,
  DEFAULT_PET_SLUG,
  ensureAtumDefaultPet,
  hasPetBlock,
  shouldApplyAtumDefaultPet,
  withPetBlock
} from './atum-default-pet'

const ASSETS = '/app/assets/pets/gigi'

const INPUT = {
  assetDir: ASSETS,
  configPath: '/home/config.yaml',
  petsDir: '/home/pets'
}

function fakeDeps(files: Record<string, Buffer | string>) {
  const written: Record<string, Buffer | string> = {}
  const dirs: string[] = []

  const deps: AtumDefaultPetDeps = {
    exists: target => target in files || target in written,
    mkdirp: target => void dirs.push(target),
    readBinary: target => {
      const value = written[target] ?? files[target]

      return Buffer.isBuffer(value) ? value : Buffer.from(String(value))
    },
    readFile: target => String(written[target] ?? files[target]),
    writeBinary: (target, contents) => void (written[target] = contents),
    writeFile: (target, contents) => void (written[target] = contents)
  }

  return { deps, dirs, written }
}

const BUNDLED = {
  [`${ASSETS}/pet.json`]: '{"id":"gigi"}',
  [`${ASSETS}/spritesheet.webp`]: Buffer.from([1, 2, 3])
}

// ── hasPetBlock ──────────────────────────────────────────────────────────────

test('an empty or comment-only config says nothing about the pet', () => {
  assert.equal(hasPetBlock(''), false)
  assert.equal(hasPetBlock('# just a comment\n'), false)
})

test('a config with display but no pet says nothing about the pet', () => {
  assert.equal(hasPetBlock('display:\n  compact: false\n'), false)
})

test('a declared pet counts, including one that is turned off', () => {
  assert.equal(hasPetBlock('display:\n  pet:\n    enabled: true\n'), true)
  assert.equal(hasPetBlock('display:\n  pet:\n    enabled: false\n'), true)
})

test('an unparseable config is treated as protected', () => {
  // Better a user with no mascot than a user with a mangled config.
  assert.equal(hasPetBlock('display: [unclosed\n'), true)
})

test('a scalar display is protected — nothing can be nested under it', () => {
  assert.equal(hasPetBlock('display: compact\n'), true)
})

// ── withPetBlock ─────────────────────────────────────────────────────────────

test('an empty config gets a whole display mapping', () => {
  assert.equal(withPetBlock(''), `display:\n  pet:\n    enabled: true\n    slug: ${DEFAULT_PET_SLUG}\n`)
})

test('the pet is inserted under an existing display, not appended as a duplicate key', () => {
  // Appending a second top-level `display:` would make the document invalid or
  // silently drop the first one, depending on the parser.
  const next = withPetBlock('display:\n  compact: false\nstt:\n  enabled: true\n')

  assert.equal(next, 'display:\n  pet:\n    enabled: true\n    slug: gigi\n  compact: false\nstt:\n  enabled: true\n')
  assert.equal((next?.match(/^display:/gmu) ?? []).length, 1)
})

test('comments are preserved verbatim', () => {
  const original = '# Atum config\ndisplay:\n  # how compact the UI is\n  compact: false\n'
  const next = withPetBlock(original)

  assert.ok(next?.includes('# Atum config'))
  assert.ok(next?.includes('# how compact the UI is'))
})

test('a config with no display mapping has one appended', () => {
  const next = withPetBlock('stt:\n  enabled: true\n')

  assert.ok(next?.startsWith('stt:\n  enabled: true\n'))
  assert.ok(next?.includes('display:\n  pet:'))
})

test('a display we cannot edit by text is refused rather than guessed at', () => {
  // Inline and quoted forms parse as a display mapping but have no `display:`
  // line to insert beneath.
  assert.equal(withPetBlock('display: { compact: false }\n'), null)
  assert.equal(withPetBlock('"display":\n  compact: false\n'), null)
})

// ── ensureAtumDefaultPet ─────────────────────────────────────────────────────

test('a fresh home gets the sprite and a config naming it', () => {
  const { deps, written } = fakeDeps(BUNDLED)
  const outcome = ensureAtumDefaultPet(INPUT, deps)

  assert.equal(outcome, 'created')
  assert.deepEqual(written['/home/pets/gigi/spritesheet.webp'], Buffer.from([1, 2, 3]))
  assert.equal(written['/home/pets/gigi/pet.json'], '{"id":"gigi"}')
  assert.ok(String(written['/home/config.yaml']).includes('slug: gigi'))
})

test('an existing config has the pet inserted under its display', () => {
  const { deps, written } = fakeDeps({ ...BUNDLED, '/home/config.yaml': 'display:\n  compact: false\n' })

  assert.equal(ensureAtumDefaultPet(INPUT, deps), 'inserted')
  assert.ok(String(written['/home/config.yaml']).includes('compact: false'))
})

test('a user who already has a pet is not touched', () => {
  const { deps, written } = fakeDeps({
    ...BUNDLED,
    '/home/config.yaml': 'display:\n  pet:\n    enabled: true\n    slug: codex-frog\n'
  })

  assert.equal(ensureAtumDefaultPet(INPUT, deps), 'kept')
  assert.deepEqual(written, {})
})

test('a user who turned the pet off is not re-seeded', () => {
  // `enabled: false` is an answer, and re-seeding would overrule it every boot.
  const { deps, written } = fakeDeps({
    ...BUNDLED,
    '/home/config.yaml': 'display:\n  pet:\n    enabled: false\n'
  })

  assert.equal(ensureAtumDefaultPet(INPUT, deps), 'kept')
  assert.deepEqual(written, {})
})

test('a deleted pet is not resurrected', () => {
  // The sprite directory is gone but the config still names it: the user threw
  // it away, so leave both alone rather than copying it back.
  const { deps, written } = fakeDeps({
    ...BUNDLED,
    '/home/config.yaml': 'display:\n  pet:\n    enabled: true\n    slug: gigi\n'
  })

  assert.equal(ensureAtumDefaultPet(INPUT, deps), 'kept')
  assert.equal(written['/home/pets/gigi/spritesheet.webp'], undefined)
})

test('a build without the bundled sprite seeds nothing at all', () => {
  const { deps, written } = fakeDeps({})

  assert.equal(ensureAtumDefaultPet(INPUT, deps), 'unavailable')
  // Crucially the config is untouched: it must never name a pet that is absent.
  assert.deepEqual(written, {})
})

test('an unwritable config shape leaves the pet store alone too', () => {
  const { deps, written } = fakeDeps({ ...BUNDLED, '/home/config.yaml': 'display: { compact: false }\n' })

  assert.equal(ensureAtumDefaultPet(INPUT, deps), 'skipped')
  assert.deepEqual(written, {})
})

// ── gating ───────────────────────────────────────────────────────────────────

test('only the desktop-owned home is seeded', () => {
  assert.equal(shouldApplyAtumDefaultPet({}), true)
  assert.equal(shouldApplyAtumDefaultPet({ HERMES_HOME: '' }), true)
  assert.equal(shouldApplyAtumDefaultPet({ HERMES_HOME: '/home/example/.hermes' }), false)
})
