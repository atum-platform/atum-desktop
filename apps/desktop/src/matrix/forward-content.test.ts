import { expect, it } from 'vitest'

import { matrixForwardContent, matrixForwardTransactionId } from './forward-content'

it('keeps only forwardable content and protected provenance', () => {
  const result = matrixForwardContent({
    msgtype: 'm.text',
    body: 'Now',
    format: 'org.matrix.custom.html',
    formatted_body: '<strong>Now</strong>',
    'm.relates_to': { rel_type: 'm.replace' },
    'm.mentions': { user_ids: ['@agent:test'] },
    'io.atum.turn': 'drop',
    'io.atum.bot_api': { keyboard: [] },
    'io.atum.provenance': { v: 1, google: true }
  })

  expect(result).toEqual({
    msgtype: 'm.text',
    body: 'Now',
    format: 'org.matrix.custom.html',
    formatted_body: '<strong>Now</strong>',
    'io.atum.forwarded': true,
    'io.atum.provenance': { v: 1, google: true }
  })
  expect(Object.keys(result).filter(key => key.startsWith('io.atum.') && key !== 'io.atum.provenance'))
    .toEqual(['io.atum.forwarded'])
})

it('keeps only the thumbnail whose encryption matches the attachment', () => {
  const encrypted = matrixForwardContent({
    msgtype: 'm.image', body: 'photo', file: { url: 'mxc://test/encrypted', key: {} },
    info: {
      mimetype: 'image/png', size: 5, w: 10, h: 20,
      thumbnail_url: 'mxc://test/plain-thumb', thumbnail_file: { url: 'mxc://test/encrypted-thumb' },
      thumbnail_info: { mimetype: 'image/png', size: 2, w: 4, h: 8, secret: true }
    }
  })

  expect(encrypted.info).toEqual({
    mimetype: 'image/png', size: 5, w: 10, h: 20,
    thumbnail_file: { url: 'mxc://test/encrypted-thumb' },
    thumbnail_info: { mimetype: 'image/png', size: 2, w: 4, h: 8 }
  })
})

it('uses a bounded stable transaction id for a dialog send and retry', async () => {
  const first = await matrixForwardTransactionId('!source:test', '$event', '!target:test', 'dialog')
  const retry = await matrixForwardTransactionId('!source:test', '$event', '!target:test', 'dialog')

  expect(first).toBe(retry)
  expect(first).toMatch(/^atum-fw-[A-Za-z0-9_-]{32}$/u)
})

it('refuses non-text media instead of emitting a broken event', () => {
  expect(() => matrixForwardContent({ msgtype: 'm.video', body: 'clip', url: 'mxc://test/video' }))
    .toThrow('matrix_forward_invalid')
})
