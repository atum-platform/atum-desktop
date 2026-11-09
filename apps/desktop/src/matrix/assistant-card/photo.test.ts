import { afterEach, expect, it, vi } from 'vitest'

import { MATRIX_PROFILE_PHOTO_MAX_BYTES, matrixProfilePhoto } from '../../../shared/matrix-profile'

import { movePhotoFraming, photoCrop, photoFit, photoPreviewUrl, prepareBitmapPhoto } from './photo'

afterEach(() => vi.restoreAllMocks())

it.each([
  [1600, 900],
  [900, 1600],
  [1200, 1200],
  [32, 24]
])('keeps every crop inside a %s × %s image', (width, height) => {
  for (const zoom of [1, 1.5, 4]) {
    for (const x of [-1, 0, 0.5, 1, 2]) {
      for (const y of [-1, 0, 0.5, 1, 2]) {
        const crop = photoCrop(width, height, { x, y, zoom })
        expect(crop.x).toBeGreaterThanOrEqual(0)
        expect(crop.y).toBeGreaterThanOrEqual(0)
        expect(crop.x + crop.size).toBeLessThanOrEqual(width)
        expect(crop.y + crop.size).toBeLessThanOrEqual(height)
        expect(crop.size * zoom).toBeCloseTo(Math.min(width, height))
        const output = photoFit(crop.size, crop.size)
        expect(output.width).toBe(output.height)
        expect(output.width).toBeLessThanOrEqual(512)
      }
    }
  }
})

it('lets a drag reverse immediately after hitting an edge', () => {
  const edge = movePhotoFraming(1600, 900, { x: 0.5, y: 0.5, zoom: 2 }, 100, -100)
  const atEdge = photoCrop(1600, 900, edge)
  expect(atEdge.x).toBe(0)
  expect(atEdge.y + atEdge.size).toBe(900)
  const reversed = photoCrop(1600, 900, movePhotoFraming(1600, 900, edge, -0.1, 0.1))
  expect(reversed.x - atEdge.x).toBeCloseTo(atEdge.size * 0.1)
  expect(atEdge.y - reversed.y).toBeCloseTo(atEdge.size * 0.1)
})

it('encodes exactly the previewed square and falls back to bounded JPEG', async () => {
  const drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x01])
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done, type) => {
    if (type === 'image/webp') {return done(null)}
    const blob = new Blob([jpeg], { type })
    Object.defineProperty(blob, 'arrayBuffer', { value: async () => jpeg.slice().buffer })
    done(blob)
  })
  const bitmap = { width: 1600, height: 900 } as ImageBitmap
  const crop = photoCrop(bitmap.width, bitmap.height, { x: 0.4, y: 0.7, zoom: 1.5 })
  const photo = await prepareBitmapPhoto(bitmap, crop)
  expect(drawImage).toHaveBeenCalledExactlyOnceWith(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, 512, 512)
  expect(photo.bytes.byteLength).toBeLessThanOrEqual(MATRIX_PROFILE_PHOTO_MAX_BYTES)
  expect(matrixProfilePhoto(photo)).toEqual({ kind: 'replace', ...photo })
})

it('previews a prepared photo as a data: URL the Matrix window CSP allows (no blob:)', () => {
  const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251)
  const url = photoPreviewUrl({ bytes, type: 'image/webp' })

  expect(url.startsWith('data:image/webp;base64,')).toBe(true)
  expect(Uint8Array.from(atob(url.slice('data:image/webp;base64,'.length)), char => char.charCodeAt(0))).toEqual(bytes)
})
