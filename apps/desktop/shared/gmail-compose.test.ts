import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  buildRawMessage,
  composeSummary,
  describeOutgoing,
  OwnerAddressCache,
  ownerAddresses,
  replyPlan,
  resolveCompose,
  sendMessage,
  writeDraft
} from './gmail-compose'
import { type GmailApi, GmailMailError } from './gmail-mail'
import { decodeMime, decodeRaw, decodeWords, parseUpload, pythonParse } from './gmail-mime-test-utils'
import { parseMatrixGoogleToolRequest } from './matrix-google-tool-request'

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url')
const OWNER = 'minh@example.com'
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0xfe, 0xff, 0x0d, 0x0a, 0x0a, 0x2d, 0x2d, 0x7e])

/** A fake Gmail with real state: messages by id, attachment bytes, and every call that changes something. */
function fakeGmail(extra: Record<string, unknown> = {}, sendAs: () => Array<Record<string, unknown>> = () => [{ sendAsEmail: OWNER, isPrimary: true }]) {
  const calls: Array<{ method: string; path: string; uploadType: string; metadata?: any; mime: Buffer; raw: string; threadId?: string }> = []
  const uploads: any[] = []
  const reads: string[] = []

  const headers = [
    { name: 'From', value: '"Lan Nguyen" <lan@example.com>' },
    { name: 'Reply-To', value: 'Support Team <support@example.com>' },
    { name: 'To', value: `Minh <${OWNER}>, "Pham, Binh" <binh@example.com>, ${OWNER.toUpperCase()}` },
    { name: 'Cc', value: 'boss@example.com, Binh@Example.com, "Chị Hoa" <hoa@example.com>' },
    { name: 'Subject', value: 'Quote for review' },
    { name: 'Date', value: 'Fri, 07 Nov 2026 10:00:00 +0700' },
    { name: 'Message-ID', value: '<m1@mail.test>' },
    { name: 'References', value: '<root@mail.test> <m0@mail.test>' },
    { name: 'Delivered-To', value: 'minh+work@example.com' }
  ]

  const message = {
    id: 'm1', threadId: 't1',
    payload: {
      mimeType: 'multipart/mixed',
      headers,
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Please review the quote.\nThanks, Lan') } },
        { mimeType: 'application/pdf', filename: 'báo giá.pdf', headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { attachmentId: 'ATT-1', size: PDF.length } },
        { mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-Disposition', value: 'inline' }], body: { attachmentId: 'ATT-LOGO', size: 10 } }
      ]
    },
    ...extra
  }

  const api: GmailApi = {
    async upload(request) {
      const upload = parseUpload(request.contentType, request.body)
      const metadata = upload.metadata as any

      uploads.push({ ...request, ...upload })
      calls.push({
        method: request.method, path: request.path, uploadType: upload.uploadType, metadata, mime: upload.mime,
        raw: upload.mime.toString('base64url'), threadId: metadata?.threadId ?? metadata?.message?.threadId
      })

      return { id: 'out-1', threadId: 'thread-out', message: { id: 'dm1', threadId: 'thread-out' } }
    },
    async json(path, init) {
      const method = init?.method ?? 'GET'

      if (method !== 'GET') {
        throw new Error(`a write must go through the media upload, not json ${method} ${path}`)
      }

      reads.push(path)

      if (path === 'settings/sendAs') {
        return { sendAs: sendAs() }
      }

      if (path.startsWith('messages/m1/attachments/ATT-1')) {
        return { size: PDF.length, data: b64(PDF) }
      }

      if (path.startsWith('messages/m1')) {
        return message
      }

      throw new GmailMailError('not_found')
    }
  }

  return { api, calls, uploads, reads, message }
}

const context = { owner: async () => [OWNER] }
const send = (api: GmailApi, request: Record<string, unknown>) =>
  sendMessage(api, { action: 'send_email', sourceId: 's', to: [], subject: '', body: 'Hello', ...request } as any, context, OWNER)

describe('CC and BCC', () => {
  it('writes To, Cc and Bcc headers, each address once, to wins over cc wins over bcc', async () => {
    const { api, calls } = fakeGmail()

    await send(api, {
      to: ['lan@example.com'], cc: ['boss@example.com', 'LAN@example.com'], bcc: ['quiet@example.com', 'boss@example.com'],
      subject: 'Hi'
    })

    const mail = decodeRaw(calls[0]!.raw)
    expect(mail.headers.from).toBe(OWNER)
    expect(mail.headers.to).toBe('lan@example.com')
    expect(mail.headers.cc).toBe('boss@example.com')
    expect(mail.headers.bcc).toBe('quiet@example.com')
    expect(decodeWords(mail.headers.subject!)).toBe('Hi')
    expect(mail.text).toBe('Hello')
    expect(calls[0]!.path).toBe('messages/send')
  })

  it('refuses header injection through any address, the subject or the reply headers, and sends nothing', async () => {
    const { api, calls } = fakeGmail()
    const evil = 'a@example.com\r\nBcc: spy@example.com'

    for (const request of [
      { to: [evil], subject: 'x' },
      { to: ['a@example.com'], cc: [evil], subject: 'x' },
      { to: ['a@example.com'], bcc: [evil], subject: 'x' },
      { to: ['Lan <lan@example.com>'], subject: 'x' },
      { to: ['a@example.com'], subject: 'x\r\nBcc: spy@example.com' },
      { to: ['a@example.com'], subject: 'x', threadId: 't', inReplyTo: '<a@b>\r\nBcc: spy@example.com' },
      { to: ['a@example.com'], cc: Array.from({ length: 21 }, (_, index) => `p${index}@example.com`), subject: 'x' }
    ]) {
      await expect(send(api, request)).rejects.toMatchObject({ code: 'invalid_input' })
    }

    // A send needs somebody; 51 people in all is too many even split across the lists.
    await expect(send(api, { subject: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
    const many = (name: string) => Array.from({ length: 20 }, (_, index) => `${name}${index}@example.com`)
    await expect(send(api, { to: many('a'), cc: many('b'), bcc: many('c'), subject: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(calls).toEqual([])
  })

  it('keeps cc and bcc on a saved draft, and a draft may have no recipient yet', async () => {
    const { api, calls } = fakeGmail()

    await writeDraft(api, { action: 'create_draft', sourceId: 's', to: [], cc: ['c@example.com'], bcc: ['b@example.com'], subject: 'Later', body: 'x' }, true, context)
    const mail = decodeRaw(calls[0]!.raw)

    expect(mail.headers.to).toBeUndefined()
    expect(mail.headers.cc).toBe('c@example.com')
    expect(mail.headers.bcc).toBe('b@example.com')
    expect(mail.headers.from).toBeUndefined()
    await expect(writeDraft(api, { action: 'create_draft', sourceId: 's', to: [], subject: 'x', body: 'y' }, false, context)).rejects.toMatchObject({ code: 'scope_missing' })
  })
})

describe('reply and reply-all', () => {
  it('replies to Reply-To (not From), keeps the thread, sets Re:, In-Reply-To and the References chain', async () => {
    const { api, calls } = fakeGmail()

    await send(api, { reply: { messageId: 'm1' }, body: 'Approved.' })

    const sent = calls[0]!
    const mail = decodeRaw(sent.raw)
    expect(sent.threadId).toBe('t1')
    expect(mail.headers.to).toBe('support@example.com')
    expect(mail.headers.cc).toBeUndefined()
    expect(decodeWords(mail.headers.subject!)).toBe('Re: Quote for review')
    expect(mail.headers['in-reply-to']).toBe('<m1@mail.test>')
    expect(mail.headers.references).toBe('<root@mail.test> <m0@mail.test> <m1@mail.test>')
    expect(mail.text).toBe('Approved.')
  })

  it('reply-all adds the other To and Cc people once each, never the owner (account, alias or delivered-to)', async () => {
    const { api, calls } = fakeGmail()

    await send(api, { reply: { messageId: 'm1', all: true }, cc: ['extra@example.com', 'HOA@example.com'], body: 'Thanks all.' })

    const mail = decodeRaw(calls[0]!.raw)
    expect(mail.headers.to).toBe('support@example.com')
    // original To (minus owner) + Cc, de-duplicated without regard to case, then the agent's extra cc.
    expect(mail.headers.cc).toBe('binh@example.com, boss@example.com, hoa@example.com, extra@example.com')
    expect(`${mail.headers.to} ${mail.headers.cc} ${mail.headers.bcc ?? ''}`.toLowerCase()).not.toContain('minh')
  })

  it('never doubles Re:, falls back to From without a Reply-To, and answers the recipients of a message the owner wrote', () => {
    const plan = (headers: Array<{ name: string; value: string }>, all = false) =>
      replyPlan({ id: 'x', threadId: 't9', payload: { headers } }, [OWNER], all)

    const inbound = plan([
      { name: 'From', value: 'Lan <lan@example.com>' }, { name: 'To', value: OWNER },
      { name: 'Subject', value: 'RE: Quote' }, { name: 'Message-ID', value: '<a@b.test>' }
    ])
    expect(inbound).toMatchObject({ to: ['lan@example.com'], cc: [], subject: 'RE: Quote', threadId: 't9', inReplyTo: '<a@b.test>' })

    const own = plan([
      { name: 'From', value: OWNER }, { name: 'To', value: 'a@example.com, b@example.com' },
      { name: 'Cc', value: 'c@example.com' }, { name: 'Subject', value: 'Plan' }
    ], true)
    expect(own).toMatchObject({ to: ['a@example.com', 'b@example.com'], cc: ['c@example.com'], subject: 'Re: Plan' })
    expect(own.inReplyTo).toBeUndefined()

    // A note to oneself still has someone to reply to.
    expect(plan([{ name: 'From', value: OWNER }, { name: 'To', value: OWNER }, { name: 'Subject', value: 's' }]).to).toEqual([OWNER])
  })

  it('fetches only the headers it needs, and an explicit subject wins over the derived one', async () => {
    const { api, reads } = fakeGmail()
    const message = await resolveCompose(api, { to: [], subject: 'Custom', body: 'x', reply: { messageId: 'm1' } }, context, { bytes: false, send: true })

    expect(message.subject).toBe('Custom')
    expect(reads[0]).toContain('format=metadata')
    expect(reads[0]).not.toContain('format=full')
  })
})

describe('forward', () => {
  it('quotes the original (headers block + body), is a new thread, and lists the original files for the confirmation without downloading them', async () => {
    const { api, reads } = fakeGmail()

    const message = await resolveCompose(api, { to: ['new@example.com'], subject: '', body: 'FYI', forward: { messageId: 'm1' } }, context, { bytes: false, send: true })

    expect(message.subject).toBe('Fwd: Quote for review')
    expect(message.threadId).toBeUndefined()
    expect(message.inReplyTo).toBeUndefined()
    expect(message.quote).toContain('---------- Forwarded message ---------')
    expect(message.quote).toContain('From: "Lan Nguyen" <lan@example.com>')
    expect(message.quote).toContain('Subject: Quote for review')
    expect(message.quote).toContain('Please review the quote.')
    // Files, not the signature's inline logo.
    expect(message.attachments.map(file => [file.filename, file.size, file.bytes])).toEqual([['báo giá.pdf', PDF.length, undefined]])
    expect(reads.some(path => path.includes('/attachments/'))).toBe(false)

    const summary = composeSummary(message) as any
    expect(summary.attachments).toEqual([{ filename: 'báo giá.pdf', mimeType: 'application/pdf', size: PDF.length }])
    expect(summary.forwarded).toMatchObject({ from: '"Lan Nguyen" <lan@example.com>', subject: 'Quote for review' })
    expect(summary.to).toEqual(['new@example.com'])
  })

  it('re-attaches the original file byte for byte, in a multipart message whose parts decode back', async () => {
    const { api, calls } = fakeGmail()

    await send(api, { to: ['new@example.com'], body: 'FYI', forward: { messageId: 'm1' } })

    const mail = decodeRaw(calls[0]!.raw)
    expect(mail.contentType).toBe('multipart/mixed')
    expect(mail.text.startsWith('FYI\n\n---------- Forwarded message ---------')).toBe(true)
    expect(mail.files).toHaveLength(1)
    expect(mail.files[0]!.params.filename).toBe('báo giá.pdf')
    expect(mail.files[0]!.params.name).toBe('báo giá.pdf')
    expect(mail.files[0]!.contentType).toBe('application/pdf')
    expect(mail.files[0]!.bytes!.equals(PDF)).toBe(true)
    expect(calls[0]!.threadId).toBeUndefined()
  })

  it('forwards without the original files when asked, as plain single-part text', async () => {
    const { api, calls, reads } = fakeGmail()

    await send(api, { to: ['new@example.com'], body: 'FYI', forward: { messageId: 'm1', attachments: false } })

    const mail = decodeRaw(calls[0]!.raw)
    expect(mail.contentType).toBe('text/plain')
    expect(mail.files).toEqual([])
    expect(reads.some(path => path.includes('/attachments/'))).toBe(false)
  })

  it('adds the agent’s own files to a forward, after the original’s', async () => {
    const { api, calls } = fakeGmail()
    const mine = Buffer.from('mine')

    await send(api, { to: ['new@example.com'], body: 'FYI', forward: { messageId: 'm1' }, attachments: [{ filename: 'note.txt', mimeType: 'text/plain', data: mine.toString('base64') }] })

    expect(decodeRaw(calls[0]!.raw).files.map(file => file.params.filename)).toEqual(['note.txt', 'báo giá.pdf'])
  })
})

describe('attachments on outgoing mail', () => {
  const upload = (filename: string, bytes: Buffer, mimeType = 'application/octet-stream') => ({ filename, mimeType, data: bytes.toString('base64') })

  it('builds multipart/mixed whose parts decode back byte for byte, with RFC 2231 names for non-ASCII', async () => {
    const { api, calls } = fakeGmail()
    const random = Buffer.from(Array.from({ length: 5000 }, (_, index) => (index * 37 + 11) % 256))

    await send(api, {
      to: ['a@example.com'], subject: 'Files', body: 'Có tệp đính kèm 📎',
      attachments: [upload('Báo cáo quý 3 — bản cuối 📎.pdf', random, 'application/pdf'), upload('plain.bin', PDF), upload('a "quoted" name.txt', Buffer.from('q'), 'text/plain')]
    })

    const mail = decodeRaw(calls[0]!.raw)
    expect(mail.contentType).toBe('multipart/mixed')
    expect(mail.text).toBe('Có tệp đính kèm 📎')
    expect(mail.files.map(file => file.params.filename)).toEqual(['Báo cáo quý 3 — bản cuối 📎.pdf', 'plain.bin', 'a "quoted" name.txt'])
    expect(mail.files[0]!.bytes!.equals(random)).toBe(true)
    expect(mail.files[1]!.bytes!.equals(PDF)).toBe(true)
    // No raw non-ASCII byte in any header line, and every encoded line is short.
    const head = mail.source.slice(0, mail.source.indexOf('\r\n\r\n'))
    expect(/^[\x20-\x7e\r\n]*$/.test(head)).toBe(true)
    expect(mail.source.split('\r\n').every(line => line.length <= 998)).toBe(true)
    // RFC 2231 extended parameters next to an escaped ASCII fallback; never RFC 2047 words inside a parameter (RFC 2047 section 5).
    expect(mail.source).toMatch(/filename\*(?:0\*)?=UTF-8''/)
    expect(mail.source).not.toMatch(/(?:file)?name="=\?UTF-8/)
    expect(mail.source).toContain('filename="a \\"quoted\\" name.txt"')
    // The boundary cannot be a substring of any base64 payload.
    expect(mail.headers['content-type']).toMatch(/boundary="atum_[0-9a-f]{36}"/)
  })

  it('shows names, types, sizes and a hash — never the bytes — in the summary and in the redacted request', async () => {
    const { api } = fakeGmail()
    const request = { to: ['a@example.com'], subject: 's', body: 'b', attachments: [upload('a.pdf', PDF, 'application/pdf')] }
    const message = await resolveCompose(api, request, context, { bytes: false, send: true })
    const summary = composeSummary(message) as any

    expect(summary.attachments).toEqual([{ filename: 'a.pdf', mimeType: 'application/pdf', size: PDF.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect(JSON.stringify(summary)).not.toContain(PDF.toString('base64'))

    const redacted = describeOutgoing(request)
    expect(JSON.stringify(redacted)).not.toContain(PDF.toString('base64'))
    // A changed file is a changed request.
    expect(describeOutgoing({ ...request, attachments: [upload('a.pdf', Buffer.from('other'), 'application/pdf')] })).not.toEqual(redacted)
  })

  it('refuses a message over Gmail’s 25 MB and too many files, before building or sending anything', async () => {
    const { api, calls } = fakeGmail()
    const big = Buffer.alloc(19 * 1024 * 1024, 7)

    await expect(send(api, { to: ['a@example.com'], subject: 's', attachments: [upload('big.bin', big)] })).rejects.toMatchObject({ code: 'message_too_large' })
    await expect(send(api, { to: ['a@example.com'], subject: 's', attachments: [upload('a.bin', Buffer.alloc(10 * 1024 * 1024, 1)), upload('b.bin', Buffer.alloc(10 * 1024 * 1024, 2))] })).rejects.toMatchObject({ code: 'message_too_large' })
    await expect(send(api, { to: ['a@example.com'], subject: 's', attachments: Array.from({ length: 11 }, (_, index) => upload(`f${index}`, Buffer.from('x'))) })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(calls).toEqual([])

    // Just inside the limit goes through whole.
    await send(api, { to: ['a@example.com'], subject: 's', attachments: [upload('ok.bin', Buffer.alloc(16 * 1024 * 1024, 9))] })
    expect(decodeRaw(calls[0]!.raw).files[0]!.bytes!.length).toBe(16 * 1024 * 1024)
  })

  it('refuses a forward whose original files would not fit, naming the way out', async () => {
    const { api, calls } = fakeGmail({})
    const huge = fakeGmail()
    // The original claims a 24 MB file: refused from its declared size, without downloading it.
    ;(huge.message.payload.parts[1] as any).body.size = 24 * 1024 * 1024

    await expect(sendMessage(huge.api, { action: 'send_email', sourceId: 's', to: ['a@example.com'], subject: '', body: 'x', forward: { messageId: 'm1' } } as any, context, OWNER)).rejects.toMatchObject({ code: 'message_too_large' })
    expect(huge.calls).toEqual([])
    expect(calls).toEqual([])
    // Without the originals it is fine.
    await sendMessage(huge.api, { action: 'send_email', sourceId: 's', to: ['a@example.com'], subject: '', body: 'x', forward: { messageId: 'm1', attachments: false } } as any, context, OWNER)
    expect(huge.calls).toHaveLength(1)
  })

  it('saves attachments on drafts too, and update_draft replaces the whole draft', async () => {
    const { api, calls } = fakeGmail()

    await writeDraft(api, { action: 'update_draft', sourceId: 's', draftId: 'd1', to: ['a@example.com'], subject: 'S', body: 'B', attachments: [upload('a.txt', Buffer.from('hello'), 'text/plain')] }, true, context)

    expect(calls[0]).toMatchObject({ method: 'PUT', path: 'drafts/d1' })
    expect(decodeRaw(calls[0]!.raw).files[0]!.bytes!.toString()).toBe('hello')
  })

  it('writes plain single-part mail exactly as before when there is nothing to attach', () => {
    const raw = buildRawMessage({ to: ['a@example.com'], cc: [], bcc: [], subject: 'Hi', body: 'Body', attachments: [] }, OWNER)
    const mail = decodeRaw(raw)

    expect(mail.contentType).toBe('text/plain')
    expect(mail.headers['content-transfer-encoding']).toBe('base64')
    expect(mail.text).toBe('Body')
  })
})

describe('attachment names are read the same by an independent MIME parser', () => {
  const upload = (filename: string, bytes: Buffer) => ({ filename, mimeType: 'application/pdf', data: bytes.toString('base64') })

  // [label, real name, what a reader that only knows the ASCII `filename="..."` sees]
  it.each([
    ['plain ASCII', 'report.pdf', 'report.pdf'],
    ['quotes and backslash', 'a "quoted" \\ name.pdf', 'a "quoted" \\ name.pdf'],
    ['Vietnamese', 'Báo cáo quý 3 — bản cuối.pdf', 'Bao cao quy 3 _ ban cuoi.pdf'],
    ['emoji', '📎 hợp đồng 🇻🇳.pdf', '_ hop dong __.pdf'],
    ['long enough to need RFC 2231 continuations', `${'Kế hoạch triển khai và phân công nhiệm vụ cho toàn bộ đội ngũ '.repeat(3)}.pdf`, `${'Ke hoach trien khai va phan cong nhiem vu cho toan bo doi ngu '.repeat(3)}.pdf`],
    ['CJK and percent signs', '請求書 100% 最終版.pdf', '___ 100% ___.pdf']
  ])('%s', async (_label, filename, fallback) => {
    const { api, calls } = fakeGmail()
    const bytes = Buffer.from(Array.from({ length: 777 }, (_unused, index) => (index * 13 + 5) % 256))

    await send(api, { to: ['a@example.com'], subject: 'Tên tệp', body: 'Nội dung', attachments: [upload(filename, bytes)] })
    const mime = calls[0]!.mime
    const sha256 = createHash('sha256').update(bytes).digest('hex')

    // Python's `email` package is not our code. Read as it is, it takes the first `filename=` (the ASCII fallback)...
    const asIs = pythonParse(mime)
    expect(asIs.attachments).toEqual([{ filename: fallback, contentType: 'application/pdf', name: fallback, size: bytes.length, sha256 }])
    // ...and with the fallback removed it decodes the RFC 2231 form (continuations included) to the exact name.
    if (filename !== fallback) {
      const extended = pythonParse(mime, { withoutAsciiFallback: true })
      expect(extended.attachments).toEqual([{ filename, contentType: 'application/pdf', name: filename, size: bytes.length, sha256 }])
    }

    expect(asIs.text.trim()).toBe('Nội dung')
    expect(asIs.subject).toBe('Tên tệp')
    expect(decodeMime(mime).files[0]!.params.filename).toBe(filename)

    // The header block is pure ASCII with short lines (the encoded parts are base64).
    const text = mime.toString('utf8')
    expect(text.split('\r\n').every(line => line.length <= 998)).toBe(true)
    expect(/^[\x20-\x7e\r\n]*$/.test(text.slice(0, text.indexOf('--atum_')))).toBe(true)
  })
})

describe('messages go to Gmail’s media-upload endpoint, not the metadata endpoint', () => {
  const upload = (filename: string, bytes: Buffer) => ({ filename, mimeType: 'application/octet-stream', data: bytes.toString('base64') })

  it('sends a small message as a plain media upload of the RFC 822 bytes (no JSON, no base64url wrapper)', async () => {
    const { api, uploads, calls } = fakeGmail()

    await send(api, { to: ['a@example.com'], subject: 'Hi' })

    expect(uploads[0]).toMatchObject({ method: 'POST', path: 'messages/send', uploadType: 'media', contentType: 'message/rfc822' })
    expect(Buffer.isBuffer(uploads[0].body)).toBe(true)
    expect(uploads[0].body.toString('utf8').startsWith(`From: ${OWNER}\r\n`)).toBe(true)
    expect(calls[0]!.threadId).toBeUndefined()
  })

  it('sends a 17 MB attachment whole through the upload endpoint, far past the ~5 MB metadata limit', async () => {
    const { api, uploads, calls } = fakeGmail()
    const big = Buffer.from(Array.from({ length: 17 * 1024 * 1024 }, (_unused, index) => (index * 31) % 251))

    await send(api, { to: ['a@example.com'], subject: 'Big', attachments: [upload('big.bin', big)] })

    expect(uploads[0].uploadType).toBe('media')
    // The request body is the MIME itself: about 4/3 of the file, not 4/3 of 4/3.
    expect(uploads[0].body.length).toBeGreaterThan(17 * 1024 * 1024 * 4 / 3)
    expect(uploads[0].body.length).toBeLessThan(25 * 1024 * 1024)
    expect(decodeMime(calls[0]!.mime).files[0]!.bytes!.equals(big)).toBe(true)
  })

  it('keeps the thread of a reply with a multipart upload: a JSON metadata part, then the message/rfc822 part', async () => {
    const { api, uploads, calls } = fakeGmail()

    await send(api, { reply: { messageId: 'm1' }, body: 'Approved.' })

    expect(uploads[0]).toMatchObject({ method: 'POST', path: 'messages/send', uploadType: 'multipart' })
    expect(uploads[0].contentType).toMatch(/^multipart\/related; boundary=atum_upload_[0-9a-f]{36}$/)
    expect(uploads[0].metadata).toEqual({ threadId: 't1' })
    expect(decodeMime(calls[0]!.mime).headers['in-reply-to']).toBe('<m1@mail.test>')
    expect(decodeMime(calls[0]!.mime).text).toBe('Approved.')
  })

  it('creates and updates drafts by upload: create is media (multipart with a thread), update is a PUT carrying the draft id', async () => {
    const { api, uploads } = fakeGmail()

    await writeDraft(api, { action: 'create_draft', sourceId: 's', to: ['a@example.com'], subject: 'S', body: 'B' }, true, context)
    await writeDraft(api, { action: 'create_draft', sourceId: 's', to: [], subject: '', body: 'B', reply: { messageId: 'm1' } }, true, context)
    await writeDraft(api, { action: 'update_draft', sourceId: 's', draftId: 'd9', to: ['a@example.com'], subject: 'S2', body: 'B2' }, true, context)
    await writeDraft(api, { action: 'update_draft', sourceId: 's', draftId: 'd9', to: [], subject: '', body: 'B3', reply: { messageId: 'm1' }, attachments: [upload('n.bin', Buffer.from('note'))] }, true, context)

    expect(uploads.map(entry => [entry.method, entry.path, entry.uploadType, entry.metadata])).toEqual([
      ['POST', 'drafts', 'media', undefined],
      ['POST', 'drafts', 'multipart', { message: { threadId: 't1' } }],
      ['PUT', 'drafts/d9', 'multipart', { id: 'd9' }],
      ['PUT', 'drafts/d9', 'multipart', { id: 'd9', message: { threadId: 't1' } }]
    ])
    expect(decodeMime(uploads[3].mime).files[0]!.bytes!.toString()).toBe('note')
  })
})

describe('the owner’s own addresses (send-as aliases)', () => {
  const ALIAS = 'minh.work@example.com'
  const aliases = () => [
    { sendAsEmail: OWNER, isPrimary: true, verificationStatus: 'accepted' },
    { sendAsEmail: ALIAS, verificationStatus: 'accepted' },
    { sendAsEmail: 'pending@example.com', verificationStatus: 'pending' }
  ]

  const replyTo = (headers: Array<{ name: string; value: string }>, sendAs = aliases) => {
    const gmail = fakeGmail({}, sendAs)
    gmail.message.payload.headers = headers as any

    return gmail
  }

  it('replies to the original recipients when the owner wrote the message from an alias without Delivered-To', async () => {
    const { api, calls } = replyTo([
      { name: 'From', value: `Minh <${ALIAS}>` }, { name: 'To', value: 'lan@example.com, binh@example.com' },
      { name: 'Subject', value: 'Plan' }, { name: 'Message-ID', value: '<m1@mail.test>' }
    ])

    await sendMessage(api, { action: 'send_email', sourceId: 's', to: [], subject: '', body: 'ok', reply: { messageId: 'm1', all: true } } as any, { owner: () => ownerAddresses(api, OWNER) }, OWNER)

    const mail = decodeRaw(calls[0]!.raw)
    expect(mail.headers.to).toBe('lan@example.com, binh@example.com')
    expect(mail.headers.cc).toBeUndefined()
  })

  it('leaves every owner alias out of a reply-all, whether it sits in To or Cc, and keeps the others', async () => {
    const { api, calls } = replyTo([
      { name: 'From', value: 'Lan <lan@example.com>' }, { name: 'To', value: `${ALIAS}, binh@example.com` },
      { name: 'Cc', value: `Minh <${OWNER}>, boss@example.com, PENDING@example.com` },
      { name: 'Subject', value: 'Plan' }, { name: 'Message-ID', value: '<m1@mail.test>' }
    ])

    await sendMessage(api, { action: 'send_email', sourceId: 's', to: [], subject: '', body: 'ok', reply: { messageId: 'm1', all: true } } as any, { owner: () => ownerAddresses(api, OWNER) }, OWNER)

    const mail = decodeRaw(calls[0]!.raw)
    expect(mail.headers.to).toBe('lan@example.com')
    // The pending (unverified) address is somebody else's as far as Atum can tell; both verified ones are the owner's.
    expect(mail.headers.cc).toBe('binh@example.com, boss@example.com, PENDING@example.com')
  })

  it('asks Gmail once per ten minutes, and falls back on the primary address when Gmail refuses the list', async () => {
    const { api, reads } = fakeGmail()
    let clock = 0
    const cache = new OwnerAddressCache(600_000, () => clock)

    expect(await ownerAddresses(api, OWNER, cache)).toEqual([OWNER])
    await ownerAddresses(api, OWNER, cache)
    expect(reads.filter(path => path === 'settings/sendAs')).toHaveLength(1)
    clock = 600_001
    await ownerAddresses(api, OWNER, cache)
    expect(reads.filter(path => path === 'settings/sendAs')).toHaveLength(2)

    const refused: GmailApi = { ...api, json: async () => { throw new GmailMailError('denied') } }
    expect(await ownerAddresses(refused, OWNER, new OwnerAddressCache())).toEqual([OWNER])
  })
})

describe('the closed request grammar for outgoing mail', () => {
  const base = { sourceId: 's', subject: 'x', body: 'y' }
  const file = { filename: 'a.txt', data: Buffer.from('hi').toString('base64') }

  it('accepts cc, bcc, reply, forward and attachments exactly, and nothing else', () => {
    for (const request of [
      { action: 'send_email', ...base, to: ['a@example.com'], cc: ['b@example.com'], bcc: ['c@example.com'] },
      { action: 'send_email', sourceId: 's', to: [], subject: '', body: 'y', reply: { messageId: 'm1', all: true }, cc: ['b@example.com'] },
      { action: 'send_email', sourceId: 's', to: ['a@example.com'], subject: '', body: 'y', forward: { messageId: 'm1', attachments: false } },
      { action: 'send_email', ...base, to: ['a@example.com'], attachments: [{ ...file, mimeType: 'text/plain' }] },
      { action: 'create_draft', ...base, to: [], cc: ['b@example.com'], attachments: [file] },
      { action: 'update_draft', sourceId: 's', subject: '', body: 'y', draftId: 'd1', to: [], reply: { messageId: 'm1' } }
    ]) {
      expect(parseMatrixGoogleToolRequest(request)).toEqual(request)
    }

    for (const bad of [
      { action: 'send_email', ...base, to: [] },
      { action: 'send_email', ...base, to: ['a@example.com'], reply: { messageId: 'm1' } },
      { action: 'send_email', sourceId: 's', to: [], body: 'y', reply: { messageId: 'm1' }, threadId: 't1', inReplyTo: '<a@b.c>' },
      { action: 'send_email', sourceId: 's', to: [], body: 'y', reply: { messageId: 'm1' }, forward: { messageId: 'm2' } },
      { action: 'send_email', sourceId: 's', to: [], body: 'y', reply: { messageId: 'a/b' } },
      { action: 'send_email', sourceId: 's', to: [], body: 'y', reply: { messageId: 'm1', cc: 'x' } },
      { action: 'send_email', ...base, to: ['a@example.com'], cc: Array.from({ length: 21 }, () => 'b@example.com') },
      { action: 'send_email', ...base, to: ['a@example.com'], attachments: [] },
      { action: 'send_email', ...base, to: ['a@example.com'], attachments: [{ filename: '../x', data: 'aGk=' }] },
      { action: 'send_email', ...base, to: ['a@example.com'], attachments: [{ filename: 'a\nb', data: 'aGk=' }] },
      { action: 'send_email', ...base, to: ['a@example.com'], attachments: [{ filename: 'a.txt', data: 'not base64!' }] },
      { action: 'send_email', ...base, to: ['a@example.com'], attachments: [{ filename: 'a.txt', data: 'aGk=', path: '/etc/passwd' }] },
      { action: 'send_email', ...base, to: ['a@example.com'], attachments: [{ filename: 'a.txt', mimeType: 'text/plain\r\nX: y', data: 'aGk=' }] },
      { action: 'send_email', ...base, to: ['a@example.com'], attachments: Array.from({ length: 11 }, () => file) },
      { action: 'create_draft', ...base, to: [], bcc: 'b@example.com' },
      { action: 'download_attachment', sourceId: 's', messageId: 'm1', attachmentId: 'A', attachments: [file] }
    ]) {
      expect(parseMatrixGoogleToolRequest(bad), JSON.stringify(bad).slice(0, 120)).toBeNull()
    }
  })
})
