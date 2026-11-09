import { describe, expect, it } from 'vitest'

import { writeDraft } from './gmail-compose'
import { encodedSubject, type GmailApi, MESSAGE_PAGE_CHARS, readMessage } from './gmail-mail'
import { parseUpload } from './gmail-mime-test-utils'

const b64 = (value: string) => Buffer.from(value).toString('base64url')

function api(message: Record<string, unknown>, onSend?: (path: string, body: any) => void): GmailApi {
  return {
    async json(path) {
      return path === 'settings/sendAs' ? { sendAs: [] } : message
    },
    async upload(request) {
      // The saved message, as Gmail's `raw` form, for the assertions below.
      onSend?.(request.path, { message: { raw: parseUpload(request.contentType, request.body).mime.toString('base64url') } })

      return { id: 'd1', message: { id: 'dm', threadId: 't' } }
    }
  }
}

describe('read_message never drops content silently', () => {
  it('pages a message far past a million characters to its true end', async () => {
    // Distinct text per position so a skipped or repeated page cannot go unnoticed.
    const original = `${Array.from({ length: 300_000 }, (_, index) => `w${index.toString(36)} `).join('').slice(0, 1_234_567)}END`

    const message = { id: 'm1', threadId: 't1', payload: { mimeType: 'text/plain', headers: [], body: { data: b64(original) } } }
    let text = ''
    let offset = 0
    let pages = 0
    let last: any

    for (;;) {
      last = await readMessage(api(message), { action: 'read_message', sourceId: 's', messageId: 'm1', ...(offset ? { offset } : {}) })
      text += last.text
      pages += 1
      expect(last.textLength).toBe(original.length)

      if (!last.truncated) {
        break
      }

      expect(last.nextOffset).toBe(offset + MESSAGE_PAGE_CHARS)
      offset = last.nextOffset
    }

    // The final page is the real end: the whole original, nothing claimed complete early.
    expect(original.length).toBeGreaterThan(1_000_000)
    expect(text).toBe(original)
    expect(pages).toBe(Math.ceil(original.length / MESSAGE_PAGE_CHARS))
    expect(last.truncated).toBeUndefined()
    expect(last.text.length).toBeLessThanOrEqual(MESSAGE_PAGE_CHARS)
  })

  it('keeps every header it can and marks each cut: entries past the bound and values past the bound', async () => {
    const headers = [
      { name: 'From', value: 'Lan <lan@example.com>' },
      ...Array.from({ length: 400 }, (_, index) => ({ name: `X-Trace-${index}`, value: `v${index}` })),
      { name: 'Subject', value: 'late subject' }
    ]

    headers[3] = { name: 'X-Long', value: 'z'.repeat(5_000) }
    const message = { id: 'm1', threadId: 't1', payload: { mimeType: 'text/plain', headers, body: { data: b64('hi') } } }
    const read: any = await readMessage(api(message), { action: 'read_message', sourceId: 's', messageId: 'm1' })

    expect(read.headers).toHaveLength(300)
    expect(read.headersOmitted).toBe(102)
    expect(read.headersTruncated).toBe(true)
    expect(read.headers[3]).toMatchObject({ name: 'X-Long', truncated: true, length: 5_000 })
    expect(read.headers[3].value).toHaveLength(2_000)
    // The summary fields still see headers past the shown bound.
    expect(read.subject).toBe('late subject')
    expect(read.from).toBe('Lan <lan@example.com>')

    const small: any = await readMessage(api({ id: 'm', payload: { headers: headers.slice(0, 3), body: { data: b64('x') } } }), { action: 'read_message', sourceId: 's', messageId: 'm' })
    expect(small.headersTruncated).toBeUndefined()
    expect(small.headersOmitted).toBeUndefined()
  })
})

describe('draft subjects are RFC 2047 words that decode one by one', () => {
  const decode = (word: string) => {
    const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(word)

    expect(match, word).not.toBeNull()
    expect(word.length).toBeLessThanOrEqual(75)

    // fatal: any word that splits a UTF-8 sequence throws instead of decoding to U+FFFD.
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(match![1]!, 'base64'))
  }

  it.each([
    ['long Vietnamese', 'Báo cáo tổng kết quý ba: kế hoạch triển khai và phân công nhiệm vụ cho toàn bộ đội ngũ kỹ thuật Việt Nam'],
    ['emoji', '🎉🚀 Launch ✨ day 🇻🇳 is here 🧑‍🚀 and 👩‍👩‍👧‍👦 families 🎈🎈🎈🎈🎈🎈🎈🎈🎈🎈🎈🎈'],
    ['short', 'Hi']
  ])('%s', (_name, subject) => {
    const words = encodedSubject(subject).split('\r\n ')

    expect(words.map(decode).join('')).toBe(subject)

    if (subject.length > 40) {
      expect(words.length).toBeGreaterThan(1)
    }
  })

  it('reaches Gmail inside the saved draft', async () => {
    const subject = 'Cập nhật dự án 🚀 '.repeat(8).trim()
    let raw = ''

    await writeDraft(api({}, (_path, body) => { raw = Buffer.from(body.message.raw, 'base64url').toString('utf8') }), {
      action: 'create_draft', sourceId: 's', to: ['lan@example.com'], subject, body: 'Xin chào'
    }, true)

    const header = /^Subject: ([\s\S]*?)\r\nMIME-Version/m.exec(raw)![1]!
    expect(header.split('\r\n ').map(decode).join('')).toBe(subject)
  })
})
