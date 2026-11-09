import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { LookPackAssetVariant } from '../../shared/look-pack'

import { fetchLookAsset, LookAssetDiskCache, sanitiseLookSvg } from './look-asset'

const fixture = (name: string) =>
  readFileSync(resolve(process.cwd(), `shared/__fixtures__/look-pack-v1/assets/${name}`))
const variant = (bytes: Buffer, mime: LookPackAssetVariant['mime'] = 'image/svg+xml'): LookPackAssetVariant => ({
  mime,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.byteLength,
  width: 600,
  height: 600,
  use: 'full'
})

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atum-look-assets-'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

it('fetches, defensively sanitises, digest-verifies and reuses a cached look asset', async () => {
  const bytes = fixture('moon-gravity-well-atum.svg')
  const asset = variant(bytes)
  const cache = new LookAssetDiskCache(root).forAccount('a'.repeat(64))!
  const fetcher = vi.fn(async () => new Response(bytes, { headers: { 'content-type': asset.mime } }))
  vi.stubGlobal('fetch', fetcher)

  await expect(fetchLookAsset('https://api.atum.test/api/matrix/v1', asset, cache)).resolves.toEqual({
    mime: asset.mime,
    bytes
  })
  expect(fetcher).toHaveBeenCalledWith(
    `https://api.atum.test/api/matrix/v1/look-assets/${asset.sha256}`,
    expect.objectContaining({ credentials: 'omit', redirect: 'error' })
  )

  vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
  await expect(fetchLookAsset('https://api.atum.test/api/matrix/v1', asset, cache)).resolves.toEqual({
    mime: asset.mime,
    bytes
  })
})

it('refuses a digest mismatch without caching the bytes', async () => {
  const approved = fixture('moon-gravity-well-atum.svg')
  const asset = variant(approved)
  const cache = new LookAssetDiskCache(root).forAccount('a'.repeat(64))!
  const refused = Buffer.from(approved).fill(0, 100, 120)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(refused, { headers: { 'content-type': asset.mime } })))

  await expect(fetchLookAsset('https://api.atum.test/api/matrix/v1', asset, cache)).resolves.toBeNull()
  await expect(cache.read(asset.sha256)).resolves.toBeNull()
})

it('refuses script and external-reference SVGs even when their bytes match the pinned digest', async () => {
  expect(sanitiseLookSvg(fixture('script.svg'))).toBeNull()
  expect(sanitiseLookSvg(fixture('external.svg'))).toBeNull()

  for (const name of ['script.svg', 'external.svg']) {
    const bytes = fixture(name)
    const asset = variant(bytes)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { headers: { 'content-type': asset.mime } })))
    await expect(fetchLookAsset('https://api.atum.test/api/matrix/v1', asset)).resolves.toBeNull()
  }
})
