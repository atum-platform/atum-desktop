import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import { parsePetBundle } from '../../shared/atum-account-pets'
import type { AtumSkillBundle } from '../../shared/atum-agent-content'
import { MATRIX_BUNDLED_PETS } from '../../shared/matrix-pet'
import { hasValidPetPresentationMetadata, type PetInfo } from '../../shared/pet'

import type { MatrixHermesRuntimeConfig } from './hermes-runtime'

/** Both the checked-out and packaged Hermes trees ship these same assets.
 * Read them in place: never install over a personal pet with the same slug. */
export function matrixBundledPetsRoot(runtime: Pick<MatrixHermesRuntimeConfig, 'source'>): string {
  return path.join(runtime.source, 'apps', 'desktop', 'assets', 'pets')
}

export function readMatrixBundledPet(
  runtime: MatrixHermesRuntimeConfig,
  slug: string,
  scale: number
): Promise<PetInfo> {
  if (
    !MATRIX_BUNDLED_PETS.includes(slug as (typeof MATRIX_BUNDLED_PETS)[number]) ||
    !Number.isFinite(scale) ||
    scale < 0.1 ||
    scale > 3
  ) {
    return Promise.reject(new Error('matrix_pet_asset_unavailable'))
  }

  return new Promise((resolve, reject) => {
    execFile(
      runtime.python,
      [
        '-B',
        '-m',
        'hermes_cli.atum_pet_sprite',
        '--root',
        matrixBundledPetsRoot(runtime),
        '--slug',
        slug,
        '--scale',
        String(scale)
      ],
      {
        cwd: runtime.source,
        // A cosmetic reader gets no model keys, profile/home selection or shell.
        env: { PATH: path.dirname(runtime.python), PYTHONPATH: runtime.source, PYTHONNOUSERSITE: '1' },
        timeout: 15_000,
        maxBuffer: 6 * 1024 * 1024,
        windowsHide: true
      },
      (error, stdout) => {
        try {
          if (error) {
            throw error
          }

          const value = JSON.parse(stdout) as PetInfo

          if (
            value.slug !== slug ||
            value.scale !== scale ||
            value.enabled !== true ||
            value.held ||
            !['image/png', 'image/webp'].includes(value.mime ?? '') ||
            typeof value.spritesheetBase64 !== 'string' ||
            !value.spritesheetBase64 ||
            !Number.isFinite(value.size) ||
            value.size! <= 0 ||
            value.size! > 4 ||
            value.frameW !== 192 ||
            value.frameH !== 208 ||
            !Array.isArray(value.stateRows) ||
            !hasValidPetPresentationMetadata(value)
          ) {
            throw new Error('invalid_sprite')
          }

          resolve(value)
        } catch {
          reject(new Error('matrix_pet_asset_unavailable'))
        }
      }
    )
  })
}

/**
 * The house dogs' sprites are fixed files inside one runtime, so each slug and size
 * is decoded once (one Python process) and served from memory after that. Failures
 * are dropped so the next read tries again; only the most recent `limit` stay.
 */
export function cachedBundledPetReader(
  read: (runtime: MatrixHermesRuntimeConfig, slug: string, scale: number) => Promise<PetInfo>,
  limit = 8
): (runtime: MatrixHermesRuntimeConfig, slug: string, scale: number) => Promise<PetInfo> {
  const kept = new Map<string, Promise<PetInfo>>()

  return (runtime, slug, scale) => {
    const key = JSON.stringify([runtime.source, runtime.python, slug, scale])
    let sprite = kept.get(key)

    if (sprite) {
      // Most recently used goes to the back of the line.
      kept.delete(key)
    } else {
      sprite = read(runtime, slug, scale)
      sprite.catch(() => {
        if (kept.get(key) === sprite) {
          kept.delete(key)
        }
      })
    }

    kept.set(key, sprite)

    for (const oldest of kept.keys()) {
      if (kept.size <= limit) {
        break
      }

      kept.delete(oldest)
    }

    return sprite
  }
}

/** A private, content-addressed materialisation of an account pet.  Main writes
 * it atomically and the renderer receives only the decoded sprite. */
export class MatrixPersonalPetCache {
  constructor(private readonly root: string) {}

  private directory(accountKey: string, sha256: string): string {
    if (!/^[a-f0-9]{64}$/u.test(accountKey) || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new Error('matrix_pet_asset_unavailable')
    }

    return path.join(this.root, accountKey, sha256)
  }

  /** Returns a cache entry only after checking the atomic receipt and every
   * cached content file. `sha256` is the platform's canonical bundle identity;
   * the receipt binds each on-disk byte sequence to that identity so a local
   * directory is never trusted merely because it exists. */
  cached(accountKey: string, sha256: string): { root: string; slug: string } | null {
    const root = this.directory(accountKey, sha256)
    const slug = `pet-${sha256.slice(0, 24)}`
    const destination = path.join(root, slug)

    return this.validReceipt(destination, sha256) ? { root, slug } : null
  }

  /** Resolve an account's last receipt-bound personal pet for conservative
   * offline rendering. The lookup never crosses account roots and validates
   * every cached byte before returning a sprite location. */
  cachedByPetId(accountKey: string, petId: string): { root: string; slug: string; sha256: string } | null {
    if (!/^[a-f0-9]{64}$/u.test(accountKey) || !validPetId(petId)) {
      throw new Error('matrix_pet_asset_unavailable')
    }

    const accountRoot = path.join(this.root, accountKey)

    try {
      for (const entry of readdirSync(accountRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) {
          continue
        }

        const root = path.join(accountRoot, entry.name)
        const slug = `pet-${entry.name.slice(0, 24)}`

        if (this.validReceipt(path.join(root, slug), entry.name, petId)) {
          return { root, slug, sha256: entry.name }
        }
      }
    } catch {
      return null
    }

    return null
  }

  materialize(accountKey: string, bundleInput: AtumSkillBundle, petId: string): { root: string; slug: string } {
    const bundle = parsePetBundle(bundleInput)

    if (!validPetId(petId)) {
      throw new Error('matrix_pet_asset_unavailable')
    }

    if (
      canonicalBundleDigest(
        bundle.files.map(file => ({ path: file.path, bytes: Buffer.from(file.content_base64, 'base64') }))
      ) !== bundle.sha256
    ) {
      throw new Error('matrix_pet_asset_unavailable')
    }

    const root = this.directory(accountKey, bundle.sha256)
    const slug = `pet-${bundle.sha256.slice(0, 24)}`
    const destination = path.join(root, slug)

    if (existsSync(destination)) {
      const cached = this.cached(accountKey, bundle.sha256)

      if (cached) {
        return cached
      }

      // `destination` is derived from two validated digests under the app's
      // private root. Remove only this invalid cache entry before rebuilding
      // it from freshly authorized content.
      rmSync(destination, { recursive: true, force: true })
    }

    const stage = `${destination}.${randomUUID()}.tmp`
    mkdirSync(stage, { recursive: true, mode: 0o700 })

    try {
      for (const file of bundle.files) {
        if (!['pet.json', 'spec.json', 'spritesheet.webp', 'spritesheet.png'].includes(file.path)) {
          throw new Error('matrix_pet_asset_unavailable')
        }

        const bytes = Buffer.from(file.content_base64, 'base64')

        if (!bytes.length || bytes.toString('base64').replace(/=+$/u, '') !== file.content_base64.replace(/=+$/u, '')) {
          throw new Error('matrix_pet_asset_unavailable')
        }

        const target = path.join(stage, file.path)
        const descriptor = openSync(target, 'wx', 0o600)

        try {
          writeFileSync(descriptor, bytes)
          fsyncSync(descriptor)
        } finally {
          closeSync(descriptor)
        }
      }

      // The record's sha256 is a server-verified canonical bundle digest.  Keep
      // a local receipt too, so a corrupted cache is never silently trusted.
      const receipt = JSON.stringify({
        version: 1,
        sha256: bundle.sha256,
        petId,
        bytes: bundle.files.reduce((total, file) => total + Buffer.byteLength(file.content_base64, 'base64'), 0),
        files: bundle.files
          .map(file => {
            const bytes = Buffer.from(file.content_base64, 'base64')

            return { path: file.path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
          })
          .sort((left, right) => left.path.localeCompare(right.path))
      })

      const receiptDescriptor = openSync(path.join(stage, '.matrix-pet-receipt.json'), 'wx', 0o600)

      try {
        writeFileSync(receiptDescriptor, receipt)
        fsyncSync(receiptDescriptor)
      } finally {
        closeSync(receiptDescriptor)
      }

      mkdirSync(root, { recursive: true, mode: 0o700 })

      try {
        renameSync(stage, destination)
      } catch (error) {
        if (!existsSync(destination)) {
          throw error
        }
      }
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }

    const cached = this.cached(accountKey, bundle.sha256)

    if (!cached) {
      throw new Error('matrix_pet_asset_unavailable')
    }

    return cached
  }

  /** A fresh library denial/reversal removes the old receipt binding so a
   * later offline selection cannot resurrect withdrawn authority. */
  invalidatePet(accountKey: string, petId: string): void {
    if (!/^[a-f0-9]{64}$/u.test(accountKey) || !validPetId(petId)) {
      return
    }

    const accountRoot = path.join(this.root, accountKey)

    try {
      for (const entry of readdirSync(accountRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) {
          continue
        }

        const root = path.join(accountRoot, entry.name)
        const destination = path.join(root, `pet-${entry.name.slice(0, 24)}`)

        if (this.validReceipt(destination, entry.name, petId)) {
          rmSync(root, { recursive: true, force: true })
        }
      }
    } catch {
      // Cache invalidation cannot turn an authoritative platform response into
      // an app lifecycle failure.
    }
  }

  private validReceipt(destination: string, expectedSha256: string, expectedPetId?: string): boolean {
    try {
      if (!lstatSync(destination).isDirectory()) {
        return false
      }

      const receiptPath = path.join(destination, '.matrix-pet-receipt.json')

      if (!lstatSync(receiptPath).isFile()) {
        return false
      }

      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
        version?: unknown
        sha256?: unknown
        petId?: unknown
        bytes?: unknown
        files?: unknown
      }

      const receiptBytes = receipt.bytes

      if (
        receipt.version !== 1 ||
        receipt.sha256 !== expectedSha256 ||
        !validPetId(receipt.petId) ||
        (expectedPetId !== undefined && receipt.petId !== expectedPetId) ||
        !Number.isSafeInteger(receiptBytes) ||
        typeof receiptBytes !== 'number' ||
        receiptBytes < 1 ||
        !Array.isArray(receipt.files) ||
        receipt.files.length < 2 ||
        receipt.files.length > 3
      ) {
        return false
      }

      const files = receipt.files.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('invalid_receipt')
        }

        const file = value as { path?: unknown; bytes?: unknown; sha256?: unknown }
        const fileBytes = file.bytes

        if (
          typeof file.path !== 'string' ||
          !['pet.json', 'spec.json', 'spritesheet.webp', 'spritesheet.png'].includes(file.path) ||
          !Number.isSafeInteger(fileBytes) ||
          typeof fileBytes !== 'number' ||
          fileBytes < 1 ||
          typeof file.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(file.sha256)
        ) {
          throw new Error('invalid_receipt')
        }

        return { path: file.path, bytes: fileBytes, sha256: file.sha256 }
      })

      const paths = files.map(file => file.path)

      if (
        new Set(paths).size !== paths.length ||
        !paths.includes('pet.json') ||
        paths.filter(file => file === 'spritesheet.webp' || file === 'spritesheet.png').length !== 1 ||
        paths.some(file => !['pet.json', 'spec.json', 'spritesheet.webp', 'spritesheet.png'].includes(file))
      ) {
        return false
      }

      const expectedEntries = [...paths, '.matrix-pet-receipt.json'].sort()

      if (JSON.stringify(readdirSync(destination).sort()) !== JSON.stringify(expectedEntries)) {
        return false
      }

      let total = 0
      const content: Array<{ path: string; bytes: Buffer }> = []

      for (const file of files) {
        const target = path.join(destination, file.path)

        if (!lstatSync(target).isFile()) {
          return false
        }

        const bytes = readFileSync(target)

        if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
          return false
        }

        total += bytes.length
        content.push({ path: file.path, bytes })
      }

      return total === receiptBytes && canonicalBundleDigest(content) === expectedSha256
    } catch {
      return false
    }
  }
}

export function readMatrixPersonalPet(
  runtime: MatrixHermesRuntimeConfig,
  cache: MatrixPersonalPetCache,
  accountKey: string,
  bundle: AtumSkillBundle,
  petId: string,
  scale: number
): Promise<PetInfo> {
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 3) {
    return Promise.reject(new Error('matrix_pet_asset_unavailable'))
  }

  let materialized: { root: string; slug: string }

  try {
    materialized = cache.materialize(accountKey, bundle, petId)
  } catch {
    return Promise.reject(new Error('matrix_pet_asset_unavailable'))
  }

  return readSprite(runtime, materialized.root, materialized.slug, scale, true)
}

/** Read a prior, receipt-verified materialisation without fetching the private
 * bundle again. Callers still need a fresh platform authorization before using
 * this online; this only avoids a redundant content transfer. */
export function readCachedMatrixPersonalPet(
  runtime: MatrixHermesRuntimeConfig,
  cache: MatrixPersonalPetCache,
  accountKey: string,
  sha256: string,
  scale: number
): Promise<PetInfo> {
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 3) {
    return Promise.reject(new Error('matrix_pet_asset_unavailable'))
  }

  let materialized: { root: string; slug: string } | null

  try {
    materialized = cache.cached(accountKey, sha256)
  } catch {
    return Promise.reject(new Error('matrix_pet_asset_unavailable'))
  }

  if (!materialized) {
    return Promise.reject(new Error('matrix_pet_asset_unavailable'))
  }

  return readSprite(runtime, materialized.root, materialized.slug, scale, true)
}

export function readCachedMatrixPersonalPetById(
  runtime: MatrixHermesRuntimeConfig,
  cache: MatrixPersonalPetCache,
  accountKey: string,
  petId: string,
  scale: number
): Promise<PetInfo> {
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 3) {
    return Promise.reject(new Error('matrix_pet_asset_unavailable'))
  }

  let materialized: { root: string; slug: string; sha256: string } | null

  try {
    materialized = cache.cachedByPetId(accountKey, petId)
  } catch {
    return Promise.reject(new Error('matrix_pet_asset_unavailable'))
  }

  if (!materialized) {
    return Promise.reject(new Error('matrix_pet_asset_unavailable'))
  }

  return readSprite(runtime, materialized.root, materialized.slug, scale, true)
}

function validPetId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
  )
}

/** Matches Hermes's canonical pet-bundle identity: UTF-8 path, NUL, raw bytes,
 * NUL for lexically sorted paths. This verifies the claimed content digest from
 * cached bytes instead of trusting receipt fields alone. */
function canonicalBundleDigest(files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): string {
  const digest = createHash('sha256')

  for (const file of [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))
  )) {
    digest.update(file.path, 'utf8')
    digest.update('\0')
    digest.update(file.bytes)
    digest.update('\0')
  }

  return digest.digest('hex')
}

function readSprite(
  runtime: MatrixHermesRuntimeConfig,
  root: string,
  slug: string,
  scale: number,
  personal = false
): Promise<PetInfo> {
  return new Promise((resolve, reject) => {
    execFile(
      runtime.python,
      [
        '-B',
        '-m',
        'hermes_cli.atum_pet_sprite',
        '--root',
        root,
        '--slug',
        slug,
        '--scale',
        String(scale),
        ...(personal ? ['--personal'] : [])
      ],
      {
        cwd: runtime.source,
        env: { PATH: path.dirname(runtime.python), PYTHONPATH: runtime.source, PYTHONNOUSERSITE: '1' },
        timeout: 15_000,
        maxBuffer: 6 * 1024 * 1024,
        windowsHide: true
      },
      (error, stdout) => {
        try {
          if (error) {
            throw error
          }

          const value = JSON.parse(stdout) as PetInfo

          if (
            value.slug !== slug ||
            value.scale !== scale ||
            value.enabled !== true ||
            value.held ||
            !['image/png', 'image/webp'].includes(value.mime ?? '') ||
            typeof value.spritesheetBase64 !== 'string' ||
            !value.spritesheetBase64 ||
            !Number.isFinite(value.size) ||
            value.size! <= 0 ||
            value.size! > 4 ||
            value.frameW !== 192 ||
            value.frameH !== 208 ||
            !Array.isArray(value.stateRows) ||
            !hasValidPetPresentationMetadata(value)
          ) {
            throw new Error('invalid_sprite')
          }

          resolve(value)
        } catch {
          reject(new Error('matrix_pet_asset_unavailable'))
        }
      }
    )
  })
}
