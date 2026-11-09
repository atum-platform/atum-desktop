/**
 * Gigi, the master assistant's pet, seeded into the desktop-owned Hermes home.
 *
 * Every user meets Atum with a companion already there — a pet you have to go
 * and find is a pet nobody has. The sprite ships in the app bundle
 * (`assets/pets/gigi`, built by `scripts/build_default_pet.py`) and is copied
 * into the home's pet store on first boot, alongside a `display.pet` block
 * naming it.
 *
 * Seeded ONCE and never repaired. If the config already declares `display.pet`
 * in any form, this does nothing: that block is the user's answer — including
 * the answer "no pet", and including a pet they deleted. Re-copying a sprite
 * because its directory went missing would resurrect something they threw away.
 *
 * Same shape as electron/atum-approval-default.ts: injectable deps so the
 * decisions are unit-testable without touching a real home.
 */

import fs from 'node:fs'
import path from 'node:path'

import { load } from 'js-yaml'

/** Slug, directory name, and `display.pet.slug` value. */
export const DEFAULT_PET_SLUG = 'gigi'

/** Files the bundled pet package is made of. */
const PET_JSON = 'pet.json'
const PET_SPRITESHEET = 'spritesheet.webp'

/**
 * Inserted under an existing `display:` mapping. Two spaces of indent because
 * it becomes a child of `display`, not a top-level key.
 */
const PET_BLOCK_LINES = ['  pet:', '    enabled: true', `    slug: ${DEFAULT_PET_SLUG}`]

/** Appended whole when the config has no `display:` mapping at all. */
const DISPLAY_WITH_PET_BLOCK = `\ndisplay:\n${PET_BLOCK_LINES.join('\n')}\n`

export type AtumDefaultPetOutcome =
  /** Config had no `display:` at all; wrote one naming the pet. */
  | 'created'
  /** Inserted `pet:` under the existing `display:` mapping. */
  | 'inserted'
  /** Config already declares `display.pet` — the user's answer stands. */
  | 'kept'
  /** The bundled sprite is missing from this build. */
  | 'unavailable'
  /** The config's shape is one we cannot edit safely by text. */
  | 'skipped'

export interface AtumDefaultPetDeps {
  exists: (target: string) => boolean
  readFile: (target: string) => string
  readBinary: (target: string) => Buffer
  writeFile: (target: string, contents: string) => void
  writeBinary: (target: string, contents: Buffer) => void
  mkdirp: (target: string) => void
}

const nodeDeps: AtumDefaultPetDeps = {
  exists: target => fs.existsSync(target),
  readFile: target => fs.readFileSync(target, 'utf8'),
  readBinary: target => fs.readFileSync(target),
  writeFile: (target, contents) => fs.writeFileSync(target, contents, 'utf8'),
  writeBinary: (target, contents) => fs.writeFileSync(target, contents),
  mkdirp: target => fs.mkdirSync(target, { recursive: true })
}

/**
 * Does this config already say something about the pet?
 *
 * Anything unparseable counts as "yes" and is left alone: we cannot prove that
 * editing it would preserve the user's meaning, and a mangled config costs them
 * far more than a missing mascot.
 */
export function hasPetBlock(configText: string): boolean {
  let parsed: unknown

  try {
    parsed = load(configText)
  } catch {
    return true
  }

  if (parsed == null) {
    // js-yaml yields null for comment-only input as well as an explicit null.
    // Only blank/comment-only text is safe to write into.
    return configText.split(/\r?\n/u).some(line => !/^\s*(?:#.*)?$/u.test(line))
  }

  if (typeof parsed !== 'object') {
    return true
  }

  const display = (parsed as Record<string, unknown>).display

  if (display == null) {
    return false
  }

  if (typeof display !== 'object') {
    // `display: something-scalar` — not a shape we can add a child to.
    return true
  }

  return 'pet' in (display as Record<string, unknown>)
}

/**
 * Insert the pet block under `display:`, or append a whole `display:` mapping.
 *
 * Deliberately textual rather than parse-and-dump: this config is heavily
 * commented (every key carries an explanation) and round-tripping it through a
 * YAML serialiser would erase all of that. Returns null when the file's shape is
 * not one we can edit by text — a quoted or inline `display` key, an anchor —
 * in which case the caller leaves it alone.
 */
export function withPetBlock(configText: string): null | string {
  if (configText.trim() === '') {
    return DISPLAY_WITH_PET_BLOCK.trimStart()
  }

  const lines = configText.split(/\r?\n/u)
  const at = lines.findIndex(line => /^display:\s*$/u.test(line))

  if (at >= 0) {
    return [...lines.slice(0, at + 1), ...PET_BLOCK_LINES, ...lines.slice(at + 1)].join('\n')
  }

  // No plain `display:` line. Safe to append only when the parse agrees there is
  // no display mapping at all; otherwise it is written in a form we do not edit.
  try {
    const parsed = load(configText)

    if (parsed != null && typeof parsed === 'object' && 'display' in (parsed as Record<string, unknown>)) {
      return null
    }
  } catch {
    return null
  }

  const separator = configText.endsWith('\n') ? '' : '\n'

  return `${configText}${separator}${DISPLAY_WITH_PET_BLOCK}`
}

export interface EnsureDefaultPetInput {
  /** `<hermes home>/config.yaml`. */
  configPath: string
  /** `<hermes home>/pets`. */
  petsDir: string
  /** The bundled package: the directory holding pet.json + spritesheet.webp. */
  assetDir: string
}

/**
 * Give a fresh home its default pet. Returns what it did, for the boot log.
 */
export function ensureAtumDefaultPet(
  { configPath, petsDir, assetDir }: EnsureDefaultPetInput,
  deps: AtumDefaultPetDeps = nodeDeps
): AtumDefaultPetOutcome {
  const configText = deps.exists(configPath) ? deps.readFile(configPath) : ''

  if (hasPetBlock(configText)) {
    return 'kept'
  }

  const sourceSheet = path.join(assetDir, PET_SPRITESHEET)
  const sourceJson = path.join(assetDir, PET_JSON)

  if (!deps.exists(sourceSheet) || !deps.exists(sourceJson)) {
    return 'unavailable'
  }

  const next = withPetBlock(configText)

  if (next === null) {
    return 'skipped'
  }

  // Copy the package before naming it, so a config can never point at a pet
  // that is not on disk.
  const target = path.join(petsDir, DEFAULT_PET_SLUG)
  deps.mkdirp(target)
  deps.writeBinary(path.join(target, PET_SPRITESHEET), deps.readBinary(sourceSheet))
  deps.writeFile(path.join(target, PET_JSON), deps.readFile(sourceJson))

  deps.mkdirp(path.dirname(configPath))
  deps.writeFile(configPath, next)

  return configText.trim() === '' ? 'created' : 'inserted'
}

/**
 * The default applies only to the Hermes home the desktop owns. An explicit
 * `HERMES_HOME` points at a home the user (or a developer) manages elsewhere —
 * typically a CLI home whose pet, like its approval posture, is theirs to set.
 */
export function shouldApplyAtumDefaultPet(env: NodeJS.ProcessEnv = process.env): boolean {
  return !String(env.HERMES_HOME || '').trim()
}
