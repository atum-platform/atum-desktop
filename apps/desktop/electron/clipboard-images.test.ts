import assert from 'node:assert/strict'

import { test } from 'vitest'

import { readClipboardImage, writeClipboardImage } from './clipboard-images'

test('writes a native image through Electron 44 clipboard items', async () => {
  let written: unknown[] = []
  let payload: Record<string, Blob> | undefined

  await writeClipboardImage(
    { toPNG: () => Buffer.from('png-bytes') },
    {
      clipboard: {
        read: async () => [],
        write: async items => { written = items }
      },
      createItem: items => {
        payload = items

        return { types: Object.keys(items) } as never
      }
    }
  )

  assert.equal(written.length, 1)
  assert.deepEqual(Buffer.from(await payload!['image/png']!.arrayBuffer()), Buffer.from('png-bytes'))
})

test('reads PNG before JPEG and returns null when the clipboard has no image', async () => {
  const item = {
    types: ['image/jpeg', 'image/png'],
    getType: async (type: string) => new Blob([type === 'image/png' ? 'png' : 'jpeg'], { type })
  }

  assert.deepEqual(
    await readClipboardImage({ clipboard: { read: async () => [item as never], write: async () => {} } }),
    { data: Buffer.from('png'), extension: '.png' }
  )
  assert.equal(
    await readClipboardImage({ clipboard: { read: async () => [], write: async () => {} } }),
    null
  )
})

test('treats a rejected clipboard read or an unservable item as no image', async () => {
  assert.equal(
    await readClipboardImage({
      clipboard: { read: async () => { throw new Error('no display') }, write: async () => {} }
    }),
    null
  )

  const broken = { types: ['image/png'], getType: async () => { throw new Error('owner refused') } }
  const jpeg = { types: ['image/jpeg'], getType: async (type: string) => new Blob(['jpeg'], { type }) }

  assert.deepEqual(
    await readClipboardImage({
      clipboard: { read: async () => [broken as never, jpeg as never], write: async () => {} }
    }),
    { data: Buffer.from('jpeg'), extension: '.jpg' }
  )
})
