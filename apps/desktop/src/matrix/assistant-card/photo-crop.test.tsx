import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import { PhotoCropDialog } from './photo-crop'

const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
let draw: ReturnType<typeof vi.fn>
let close: ReturnType<typeof vi.fn>

function encoded() {
  const blob = new Blob([webp], { type: 'image/webp' })
  Object.defineProperty(blob, 'arrayBuffer', { value: async () => webp.slice().buffer })
  return blob
}

beforeEach(() => {
  draw = vi.fn()
  close = vi.fn()
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1200, height: 800, close })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw, clearRect() {} } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(done => done(encoded()))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture(locale: Locale = 'en', round = false) {
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  const view = render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <PhotoCropDialog file={new Blob(['source'])} onCancel={onCancel} onConfirm={onConfirm} round={round} />
    </I18nProvider>
  )
  return { ...view, onCancel, onConfirm }
}

it('confirms only the visible crop after keyboard zoom and positioning', async () => {
  const f = fixture()
  const canvas = await screen.findByRole('img', { name: 'Photo position' })
  const initial = draw.mock.calls.at(-1)!
  fireEvent.keyDown(screen.getByRole('slider', { name: 'Zoom' }), { key: 'End' })
  await waitFor(() => expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('4'))
  fireEvent.keyDown(canvas, { key: 'ArrowLeft' })
  const shown = draw.mock.calls.at(-1)!
  expect(shown[3]).toBe(initial[3] / 4)
  fireEvent.click(screen.getByRole('button', { name: 'Use photo' }))
  await waitFor(() => expect(f.onConfirm).toHaveBeenCalledExactlyOnceWith({ type: 'image/webp', bytes: webp }))
  expect(draw.mock.calls.at(-1)!.slice(0, 7)).toEqual(shown.slice(0, 7))
})

it('closes without handing over bytes when encoding finishes late', async () => {
  let finish!: BlobCallback
  vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(done => { finish = done })
  const f = fixture()
  await screen.findByRole('img', { name: 'Photo position' })
  fireEvent.click(screen.getByRole('button', { name: 'Use photo' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  f.unmount()
  await act(async () => finish(encoded()))
  expect(f.onConfirm).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})

it('keeps an unreadable photo retryable', async () => {
  vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('unreadable'))
  const f = fixture()
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByRole('img', { name: 'Photo position' })
  expect(f.onConfirm).not.toHaveBeenCalled()
})

it.each([
  ['en', 'Crop photo', 'Use photo'], ['vi', 'Cắt ảnh', 'Dùng ảnh này'],
  ['ja', '写真を切り抜く', 'この写真を使う'], ['zh', '裁剪照片', '使用照片'],
  ['zh-hant', '裁切照片', '使用照片']
] as const)('localizes the framing dialog in %s', async (locale, title, use) => {
  fixture(locale, true)
  expect(screen.getByRole('dialog', { name: title })).toBeTruthy()
  expect((await screen.findByRole('img')).className).toContain('rounded-full')
  expect(screen.getByRole('button', { name: use })).toBeTruthy()
})
