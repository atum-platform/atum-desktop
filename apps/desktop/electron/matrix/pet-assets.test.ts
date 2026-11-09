import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_BUNDLED_PETS } from '../../shared/matrix-pet'

import {
  cachedBundledPetReader,
  matrixBundledPetsRoot,
  MatrixPersonalPetCache,
  readCachedMatrixPersonalPetById,
  readMatrixBundledPet
} from './pet-assets'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

const runtime = {
  python: '/bundled/python/bin/python3',
  source: '/App/Resources/runtime/hermes-agent',
  profiles: '/private/profiles'
}

const sprite = {
  enabled: true,
  slug: 'gigi',
  scale: 1,
  size: 1,
  mime: 'image/webp',
  spritesheetBase64: 'data',
  frameW: 192,
  frameH: 208,
  stateRows: ['idle']
}

function returns(value: unknown, error: Error | null = null) {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void
    callback(error, JSON.stringify(value))

    return {} as ReturnType<typeof execFile>
  })
}

beforeEach(() => vi.resetAllMocks())

const cacheRoots: string[] = []
afterEach(() => cacheRoots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

describe('remembered house-dog sprites', () => {
  it('decodes each dog at each size once, retries a failure and keeps only the recent ones', async () => {
    const read = cachedBundledPetReader(readMatrixBundledPet, 2)
    returns(sprite)
    await expect(read(runtime, 'gigi', 1)).resolves.toEqual(sprite)
    await expect(read(runtime, 'gigi', 1)).resolves.toEqual(sprite)
    expect(execFile).toHaveBeenCalledOnce()

    // Another size is another picture.
    returns({ ...sprite, scale: 2 })
    await read(runtime, 'gigi', 2)
    expect(execFile).toHaveBeenCalledTimes(2)

    // A failed decode is not remembered: the next read tries again.
    returns(null, new Error('boom'))
    await expect(read(runtime, 'gigi', 0.5)).rejects.toThrow('matrix_pet_asset_unavailable')
    returns({ ...sprite, scale: 0.5 })
    await expect(read(runtime, 'gigi', 0.5)).resolves.toMatchObject({ scale: 0.5 })
    expect(execFile).toHaveBeenCalledTimes(4)

    // Two kept: 2 and 0.5. Size 1 was the least recent and is decoded again.
    returns(sprite)
    await read(runtime, 'gigi', 1)
    expect(execFile).toHaveBeenCalledTimes(5)
  })
})

describe('cold bundled pet assets', () => {
  it('loads valid v5 metadata and keeps the existing positive size-3 acceptance', async () => {
    const value = {
      ...sprite,
      size: 3,
      sizeClass: { naturalHeightPt: 210 },
      anchor: { footY: 195, centerX: 96 },
      bounds: { idle: { x: 32, y: 78, width: 127, height: 117 } },
      locomotion: 'walk'
    }

    returns(value)
    await expect(readMatrixBundledPet(runtime, 'gigi', 1)).resolves.toEqual(value)
  })
  it.each([
    { frameW: 193 },
    { sizeClass: { naturalHeightPt: 301 } },
    { sizeClass: { naturalHeightPt: 39 } },
    { sizeClass: { naturalHeightPt: true } },
    { sizeClass: { naturalHeightPt: 210, url: 'https://example.invalid' } },
    { anchor: { footY: 209, centerX: 96 } },
    { bounds: { idle: { x: 191, y: 0, width: 2, height: 208 } } },
    { locomotion: 'teleport' }
  ])('rejects malformed optional metadata while retaining the fixed cell check: %j', async change => {
    returns({ ...sprite, ...change })
    await expect(readMatrixBundledPet(runtime, 'gigi', 1)).rejects.toThrow('matrix_pet_asset_unavailable')
  })
  it('offers exactly the shipped asset directories (also checked by the Python reader)', () => {
    const shipped = readdirSync(new URL('../../assets/pets/', import.meta.url), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()

    expect([...MATRIX_BUNDLED_PETS].sort()).toEqual(shipped)
  })
  it.each([0.1, 3])('accepts the exact supported scale boundary %s', async scale => {
    returns({ ...sprite, scale })
    await expect(readMatrixBundledPet(runtime, 'gigi', scale)).resolves.toMatchObject({ scale })
  })
  it('uses the packaged Hermes assets and Python, without a shell, home or inherited credentials', async () => {
    returns(sprite)
    await expect(readMatrixBundledPet(runtime, 'gigi', 1)).resolves.toEqual(sprite)
    expect(execFile).toHaveBeenCalledWith(
      runtime.python,
      [
        '-B',
        '-m',
        'hermes_cli.atum_pet_sprite',
        '--root',
        '/App/Resources/runtime/hermes-agent/apps/desktop/assets/pets',
        '--slug',
        'gigi',
        '--scale',
        '1'
      ],
      {
        cwd: runtime.source,
        env: { PATH: '/bundled/python/bin', PYTHONPATH: runtime.source, PYTHONNOUSERSITE: '1' },
        timeout: 15000,
        maxBuffer: 6 * 1024 * 1024,
        windowsHide: true
      },
      expect.any(Function)
    )
    expect(matrixBundledPetsRoot({ source: '/checkout' })).toBe('/checkout/apps/desktop/assets/pets')
  })

  it('never spawns for arbitrary paths, references or out-of-range scales', async () => {
    for (const [slug, scale] of [
      ['../gigi', 1],
      ['personal:gigi', 1],
      ['gigi', NaN],
      ['gigi', 4]
    ] as const) {
      await expect(readMatrixBundledPet(runtime, slug, scale)).rejects.toThrow('matrix_pet_asset_unavailable')
    }

    expect(execFile).not.toHaveBeenCalled()
  })

  it('fails closed on a held, invalid, wrong-asset or timed-out response', async () => {
    for (const change of [{ held: true }, { slug: 'cookie' }, { scale: 2 }, { frameW: 1 }, { spritesheetBase64: '' }]) {
      returns({ ...sprite, ...change })
      await expect(readMatrixBundledPet(runtime, 'gigi', 1)).rejects.toThrow('matrix_pet_asset_unavailable')
    }

    returns(sprite, new Error('timeout'))
    await expect(readMatrixBundledPet(runtime, 'gigi', 1)).rejects.toThrow('matrix_pet_asset_unavailable')
  })
})

describe('private personal pet cache', () => {
  const accountKey = 'a'.repeat(64)
  const petId = '00000000-0000-4000-8000-b9c47b970683'

  const files = [
    { path: 'pet.json', content_base64: Buffer.from('{"name":"Little comet"}').toString('base64') },
    { path: 'spritesheet.webp', content_base64: Buffer.from('private pixels').toString('base64') }
  ]

  const sha256 = createHash('sha256')
    .update('pet.json\0')
    .update(Buffer.from(files[0]!.content_base64, 'base64'))
    .update('\0spritesheet.webp\0')
    .update(Buffer.from(files[1]!.content_base64, 'base64'))
    .update('\0')
    .digest('hex')

  const bundle = {
    schema_version: 1 as const,
    sha256,
    files
  }

  function cache() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'atum-pet-cache-'))
    cacheRoots.push(root)

    return new MatrixPersonalPetCache(root)
  }

  it('applies the same additive validation to a verified installed size-3 pet', async () => {
    const target = cache()
    const entry = target.materialize(accountKey, bundle, petId)
    const value = { ...sprite, slug: entry.slug, size: 3, sizeClass: { naturalHeightPt: 100 }, locomotion: 'hop' }
    returns(value)
    await expect(readCachedMatrixPersonalPetById(runtime, target, accountKey, petId, 1)).resolves.toEqual(value)
    returns({ ...value, anchor: { footY: 209, centerX: 96 } })
    await expect(readCachedMatrixPersonalPetById(runtime, target, accountKey, petId, 1)).rejects.toThrow(
      'matrix_pet_asset_unavailable'
    )
  })

  it('binds cached content to the same account and pet id through a verified receipt', () => {
    const target = cache()
    target.materialize(accountKey, bundle, petId)

    expect(target.cached(accountKey, sha256)).toMatchObject({ slug: `pet-${sha256.slice(0, 24)}` })
    expect(target.cachedByPetId(accountKey, petId)).toMatchObject({ sha256 })
    expect(target.cachedByPetId(accountKey, '00000000-0000-4000-8000-c4c55763870b')).toBeNull()
    expect(target.cachedByPetId('c'.repeat(64), petId)).toBeNull()
  })

  it('rejects a bundle whose claimed content digest does not match its raw files', () => {
    const target = cache()
    expect(() => target.materialize(accountKey, { ...bundle, sha256: 'c'.repeat(64) }, petId)).toThrow(
      'matrix_pet_asset_unavailable'
    )
    expect(target.cached(accountKey, 'c'.repeat(64))).toBeNull()
  })

  it('detects tampering, rebuilds only from a fresh bundle, and then permits the verified offline reader', async () => {
    const target = cache()
    const entry = target.materialize(accountKey, bundle, petId)
    writeFileSync(path.join(entry.root, entry.slug, 'pet.json'), 'tampered')
    expect(target.cached(accountKey, sha256)).toBeNull()
    expect(target.cachedByPetId(accountKey, petId)).toBeNull()

    target.materialize(accountKey, bundle, petId)
    returns({ ...sprite, slug: `pet-${sha256.slice(0, 24)}` })
    await expect(readCachedMatrixPersonalPetById(runtime, target, accountKey, petId, 1)).resolves.toMatchObject({
      slug: `pet-${sha256.slice(0, 24)}`
    })
  })

  it('withdraws a receipt binding after fresh authority removes the personal pet', () => {
    const target = cache()
    target.materialize(accountKey, bundle, petId)
    target.invalidatePet(accountKey, petId)
    expect(target.cachedByPetId(accountKey, petId)).toBeNull()
  })
})
