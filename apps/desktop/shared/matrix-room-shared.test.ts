import { describe, expect, it } from 'vitest'

import {
  matrixLinksInText,
  matrixRoomSharedFilter,
  matrixRoomSharedImageType,
  matrixRoomSharedItems,
  validMatrixRoomSharedToken
} from './matrix-room-shared'

const event = (content: unknown, plain = true) => ({ eventId: '$e', sender: '@a:test', at: 10, content, plain })

describe('links read out of message text', () => {
  it('finds http(s) addresses as written, without trailing punctuation or repeats', () => {
    expect(
      matrixLinksInText('See https://atum.chat/a?b=1, and (https://example.com/x_(y)). Again https://atum.chat/a?b=1!')
    ).toEqual(['https://atum.chat/a?b=1', 'https://example.com/x_(y)'])
  })

  it('reads markdown and angle-bracket links, and ignores other schemes', () => {
    expect(
      matrixLinksInText('[docs](https://docs.test/p) <http://old.test> ftp://no.test javascript:alert(1)')
    ).toEqual(['https://docs.test/p', 'http://old.test'])
  })

  it('keeps at most five per message', () => {
    const body = Array.from({ length: 8 }, (_, index) => `https://s${index}.test`).join(' ')

    expect(matrixLinksInText(body)).toHaveLength(5)
  })

  it('skips addresses inside inline code, double-backtick spans included', () => {
    expect(
      matrixLinksInText('run `curl https://api.test/v1` then read https://docs.test, or ``x ` https://tick.test``')
    ).toEqual(['https://docs.test'])
  })

  it('skips fenced code blocks of either fence, open to the end when never closed', () => {
    const body = [
      'Before https://before.test',
      '```bash',
      'curl https://in-fence.test',
      '```',
      'Between https://between.test',
      '~~~~',
      '~~~ https://still-inside.test',
      '~~~~',
      '  ```',
      'https://unclosed.test'
    ].join('\n')

    expect(matrixLinksInText(body)).toEqual(['https://before.test', 'https://between.test'])
  })

  it('treats a lone backtick as text, and still never lists javascript:, even next to code', () => {
    expect(matrixLinksInText("it's 5` past https://a.test")).toEqual(['https://a.test'])
    expect(matrixLinksInText('`https://code.test` javascript:alert(2) https://b.test')).toEqual(['https://b.test'])
  })
})

describe('what one message shares, per section', () => {
  it('lists a photo or video under media and a file or audio under files, with what its event says', () => {
    const image = { msgtype: 'm.image', body: 'a.jpg', url: 'mxc://s/a', info: { mimetype: 'image/jpeg', size: 12 } }

    expect(matrixRoomSharedItems('media', event(image))).toEqual([
      {
        id: '$e',
        eventId: '$e',
        sender: '@a:test',
        at: 10,
        kind: 'image',
        name: 'a.jpg',
        mimeType: 'image/jpeg',
        size: 12,
        preview: true
      }
    ])
    expect(matrixRoomSharedItems('files', event(image))).toEqual([])
    expect(
      matrixRoomSharedItems('files', event({ msgtype: 'm.file', body: 'b.pdf', url: 'mxc://s/b' }))[0]
    ).toMatchObject({
      kind: 'file',
      name: 'b.pdf'
    })
    expect(
      matrixRoomSharedItems('media', event({ msgtype: 'm.video', body: 'v.mp4', url: 'mxc://s/v' }))[0]
    ).not.toHaveProperty('preview')
  })

  it('never lists a plain media URL from an encrypted room (no downgrade), but does its encrypted file', () => {
    const plainUrl = { msgtype: 'm.file', body: 'x.txt', url: 'mxc://s/x' }
    const encrypted = { msgtype: 'm.file', body: 'x.txt', file: { url: 'mxc://s/x', v: 'v2' } }

    expect(matrixRoomSharedItems('files', event(plainUrl, false))).toEqual([])
    expect(matrixRoomSharedItems('files', event(encrypted, false))).toHaveLength(1)
  })

  it('takes links from text only, not from edits or the quoted part of a reply', () => {
    expect(
      matrixRoomSharedItems('links', event({ msgtype: 'm.text', body: 'a https://a.test b https://b.test' }))
    ).toEqual([
      { id: '$e', eventId: '$e', sender: '@a:test', at: 10, kind: 'link', url: 'https://a.test' },
      { id: '$e#1', eventId: '$e', sender: '@a:test', at: 10, kind: 'link', url: 'https://b.test' }
    ])
    expect(
      matrixRoomSharedItems(
        'links',
        event({
          msgtype: 'm.text',
          body: '* https://e.test',
          'm.relates_to': { rel_type: 'm.replace', event_id: '$o' }
        })
      )
    ).toEqual([])
    expect(
      matrixRoomSharedItems(
        'links',
        event({ msgtype: 'm.text', body: '> <@b:test> https://quoted.test\n\nmine https://mine.test' })
      ).map(item => item.url)
    ).toEqual(['https://mine.test'])
  })
})

describe('what the server can filter', () => {
  it('filters a plain room by contains_url and an encrypted one by type only', () => {
    expect(matrixRoomSharedFilter('media', false)).toMatchObject({ types: ['m.room.message'], contains_url: true })
    expect(matrixRoomSharedFilter('links', false)).toMatchObject({ types: ['m.room.message'], contains_url: false })
    expect(matrixRoomSharedFilter('files', true)).toEqual({ types: ['m.room.encrypted'], lazy_load_members: true })
  })

  it('accepts only opaque printable pagination tokens', () => {
    expect(validMatrixRoomSharedToken('t47-1_0_0')).toBe(true)
    expect(validMatrixRoomSharedToken('a b')).toBe(false)
    expect(validMatrixRoomSharedToken('')).toBe(false)
    expect(validMatrixRoomSharedToken('x'.repeat(4097))).toBe(false)
  })

  it('reads a picture type from its bytes', () => {
    expect(matrixRoomSharedImageType(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe('image/jpeg')
    expect(matrixRoomSharedImageType(new TextEncoder().encode('GIF89a'))).toBe('image/gif')
    expect(matrixRoomSharedImageType(new TextEncoder().encode('<svg'))).toBeUndefined()
  })
})
