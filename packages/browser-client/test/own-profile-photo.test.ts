import { afterEach, expect, it, vi } from 'vitest'

import { prepareBrowserOwnProfilePhoto } from '../src/own-profile-photo'

const sourcePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6])
const strippedPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 1, 1, 1])

afterEach(() => vi.unstubAllGlobals())

it('center-crops and re-encodes supported browser media instead of forwarding source metadata', async () => {
  const drawImage = vi.fn()
  const close = vi.fn()
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1600, height: 1000, close }))
  )
  vi.stubGlobal('document', {
    createElement: vi.fn(() => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob: (done: (blob: Blob) => void, type: string) => done(new Blob([strippedPng], { type }))
    }))
  })

  const result = await prepareBrowserOwnProfilePhoto(
    new File([sourcePng], 'private-metadata.png', { type: 'image/png' })
  )
  expect(result.type).toBe('image/png')
  expect(result.bytes).toEqual(strippedPng)
  expect(result.bytes).not.toEqual(sourcePng)
  expect(drawImage).toHaveBeenCalledWith(expect.anything(), 300, 0, 1000, 1000, 0, 0, 1000, 1000)
  expect(close).toHaveBeenCalledTimes(1)
})

it('rejects invalid declarations, invalid bytes, oversize input and cancellation before decoding', async () => {
  const decode = vi.fn()
  vi.stubGlobal('createImageBitmap', decode)
  await expect(
    prepareBrowserOwnProfilePhoto(new File([sourcePng], 'wrong.jpg', { type: 'image/jpeg' }))
  ).rejects.toThrow('matrix_profile_photo_type')
  await expect(
    prepareBrowserOwnProfilePhoto(new File([new Uint8Array([1, 2, 3])], 'not.png', { type: 'image/png' }))
  ).rejects.toThrow('matrix_profile_photo_type')
  await expect(
    prepareBrowserOwnProfilePhoto(new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }))
  ).rejects.toThrow('matrix_profile_photo_size')
  const abort = new AbortController()
  abort.abort()
  await expect(
    prepareBrowserOwnProfilePhoto(new File([sourcePng], 'cancel.png', { type: 'image/png' }), abort.signal)
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(decode).not.toHaveBeenCalled()
})
