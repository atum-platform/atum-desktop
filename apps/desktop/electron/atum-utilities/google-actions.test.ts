import { describe, expect, it, vi } from 'vitest'

import { decodeMime, decodeWords, parseUpload } from '../../shared/gmail-mime-test-utils'

import { UtilityFailure } from './google'
import { executeGoogleWrite, inspectGoogleEvent, parseUtilityWrite, prepareGoogleEmail } from './google-actions'

const operationId = '00000000-0000-1000-8000-986c0dc956dc'

/** The Gmail upload a mocked fetch received: its URL, how it was uploaded, its metadata and the RFC 822 message. */
function uploadOf(call: unknown[]) {
  const [url, init] = call as [string, RequestInit & { headers: Record<string, string> }]

  return { url, init, ...parseUpload(init.headers['content-type']!, init.body as Uint8Array) }
}

function failure(code: string) {
  return expect.objectContaining({ code })
}

describe('parseUtilityWrite', () => {
  it('normalizes offset calendar instants and preserves only the closed grammar', () => {
    expect(parseUtilityWrite({
      action: 'create-event', operationId, sourceId: 'calendar-source', title: 'Planning',
      start: '2026-09-10T09:00:00+07:00', end: '2026-09-10T10:00:00+07:00', location: '', description: ''
    })).toEqual({
      action: 'create-event', operationId, sourceId: 'calendar-source', title: 'Planning',
      start: '2026-09-10T02:00:00.000Z', end: '2026-09-10T03:00:00.000Z', location: '', description: ''
    })
  })

  it('keeps provider-owned update ids opaque until the provider adapter dispatches them', () => {
    expect(parseUtilityWrite({
      action: 'update-event', operationId, sourceId: 'apple-calendar', id: 'apple:calendar/opaque-id', title: 'Cuộc họp 👋',
      start: '2026-09-10T09:00:00+07:00', end: '2026-09-10T10:00:00+07:00'
    })).toMatchObject({ id: 'apple:calendar/opaque-id', title: 'Cuộc họp 👋' })
  })

  it.each([
    { action: 'send-email', operationId, sourceId: 'mail', to: ['Alice <alice@example.com>'], subject: 'Hi', body: '' },
    { action: 'send-email', operationId, sourceId: 'mail', to: ['alice@example.com'], subject: 'Hi\nBcc: hidden@example.com', body: '' },
    { action: 'send-email', operationId, sourceId: 'mail', to: ['alice@example.com'], subject: 'Hi', body: '', attachments: ['dropped'] },
    { action: 'create-event', operationId, sourceId: 'calendar', title: 'Bad', start: '2026-02-30T09:00:00Z', end: '2026-03-01T10:00:00Z' },
    { action: 'create-event', operationId, sourceId: 'calendar', title: 'Long', start: '2026-09-01T09:00:00Z', end: '2026-10-03T09:00:00Z' },
    { action: 'update-event', operationId, sourceId: 'calendar', title: 'No id', start: '2026-09-01T09:00:00Z', end: '2026-09-01T10:00:00Z' }
  ])('rejects unsafe or silently-droppable input', input => {
    expect(() => parseUtilityWrite(input)).toThrow(failure('invalid_input'))
  })
})

describe('Google write requests', () => {
  it('uses Gmail fixed send endpoint and a safe RFC 2822 message from the known mailbox', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: 'gmail-message' })) as unknown as typeof fetch
    const action = parseUtilityWrite({
      action: 'send-email', operationId, sourceId: 'mail', to: ['bob@example.com'], subject: 'Xin chào 👋', body: 'Nội dung ✓ 👋'
    })

    await expect(executeGoogleWrite(fetchImpl, 'access-token', 'owner@example.com', 'primary', action)).resolves.toEqual({ action: 'send-email', id: 'gmail-message' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const sent = uploadOf(vi.mocked(fetchImpl).mock.calls[0]!)

    // Gmail's media-upload endpoint: the JSON endpoint's `raw` field stops near 5 MB.
    expect(sent.url).toBe('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media')
    expect(sent.init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer access-token', 'content-type': 'message/rfc822' } })
    const message = sent.mime.toString('utf8')

    expect(message).toContain('From: owner@example.com\r\n')
    expect(message).toContain('To: bob@example.com\r\n')
    expect(message).toContain(`Subject: =?UTF-8?B?${Buffer.from('Xin chào 👋').toString('base64')}?=\r\n`)
    expect(message).toContain('Content-Transfer-Encoding: base64\r\n')
    expect(message).toContain(Buffer.from('Nội dung ✓ 👋').toString('base64'))
    expect(message).not.toContain('Bcc:')
  })

  it('keeps a reply in its Gmail conversation: the thread, and the message it answers', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: 'gmail-reply' })) as unknown as typeof fetch

    const action = parseUtilityWrite({
      action: 'send-email', operationId, sourceId: 'mail', to: ['lan@example.com'], subject: 'Re: Báo giá', body: 'Chào chị Lan',
      threadId: 'thread-1', inReplyTo: '<abc@mail.test>'
    })

    await executeGoogleWrite(fetchImpl, 'access-token', 'owner@example.com', 'primary', action)
    const sent = uploadOf(vi.mocked(fetchImpl).mock.calls[0]!)
    const message = sent.mime.toString('utf8')

    expect(sent.url).toBe('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart')
    expect(sent.metadata).toEqual({ threadId: 'thread-1' })
    expect(message).toContain('In-Reply-To: <abc@mail.test>\r\n')
    expect(message).toContain('References: <abc@mail.test>\r\n')
  })

  it.each([
    { threadId: 'thread-1' },
    { inReplyTo: '<abc@mail.test>' },
    { threadId: 'bad id!', inReplyTo: '<abc@mail.test>' },
    { threadId: 'thread-1', inReplyTo: '<abc@mail.test>\r\nBcc: hidden@example.com' },
    { threadId: 'thread-1', inReplyTo: 'not-a-message-id' }
  ])('refuses a reply that does not name both a sound thread and message: %o', reply => {
    expect(() => parseUtilityWrite({ action: 'send-email', operationId, sourceId: 'mail', to: ['lan@example.com'], subject: 'Re', body: '', ...reply }))
      .toThrow(failure('invalid_input'))
  })

  it('uses an operation-derived Calendar id on insert and a conditional patch on update', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: 'event-created', etag: '"v1"' }))
      .mockResolvedValueOnce(Response.json({ id: 'event-updated', etag: '"v2"' })) as unknown as typeof fetch
    const create = parseUtilityWrite({ action: 'create-event', operationId, sourceId: 'calendar', title: 'Planning', start: '2026-09-10T09:00:00+07:00', end: '2026-09-10T10:00:00+07:00' })
    const update = parseUtilityWrite({ action: 'update-event', operationId: '00000000-0000-1000-8000-d48df04d882b', sourceId: 'calendar', id: 'event-created', title: 'Moved', start: '2026-09-11T09:00:00+07:00', end: '2026-09-11T10:00:00+07:00', description: '' })

    await executeGoogleWrite(fetchImpl, 'token', 'owner@example.com', 'calendar/a', create)
    await executeGoogleWrite(fetchImpl, 'token', 'owner@example.com', 'calendar/a', update, {
      id: 'event-created', title: 'Planning', start: '2026-09-10T02:00:00.000Z', end: '2026-09-10T03:00:00.000Z', allDay: false, revision: '"v1"'
    })

    const [createUrl, createInit] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(createUrl).toBe('https://www.googleapis.com/calendar/v3/calendars/calendar%2Fa/events')
    expect(createInit).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(JSON.parse(String(createInit!.body))).toEqual({
      id: operationId.replaceAll('-', ''), summary: 'Planning',
      start: { dateTime: '2026-09-10T02:00:00.000Z' }, end: { dateTime: '2026-09-10T03:00:00.000Z' }
    })
    const [updateUrl, updateInit] = vi.mocked(fetchImpl).mock.calls[1]!
    expect(updateUrl).toBe('https://www.googleapis.com/calendar/v3/calendars/calendar%2Fa/events/event-created')
    expect(updateInit).toMatchObject({ method: 'PATCH', redirect: 'error', headers: { 'if-match': '"v1"' } })
    expect(JSON.parse(String(updateInit!.body))).toEqual({
      summary: 'Moved', start: { dateTime: '2026-09-11T02:00:00.000Z' }, end: { dateTime: '2026-09-11T03:00:00.000Z' }, description: ''
    })
  })

  it('never retries an uncertain mutation and does not send when already cancelled', async () => {
    const offline = vi.fn(async () => { throw new Error('socket closed') }) as unknown as typeof fetch
    const email = parseUtilityWrite({ action: 'send-email', operationId, sourceId: 'mail', to: ['bob@example.com'], subject: 'Hi', body: '' })

    await expect(executeGoogleWrite(offline, 'token', 'owner@example.com', 'primary', email)).rejects.toThrow(failure('outcome_unknown'))
    expect(offline).toHaveBeenCalledTimes(1)
    const controller = new AbortController()
    controller.abort()
    const noDispatch = vi.fn() as unknown as typeof fetch

    await expect(executeGoogleWrite(noDispatch, 'token', 'owner@example.com', 'primary', email, undefined, controller.signal)).rejects.toThrow(failure('cancelled'))
    expect(noDispatch).not.toHaveBeenCalled()
  })
})

describe('inspectGoogleEvent', () => {
  it('returns a bounded timed-event snapshot and refuses unsupported event shapes', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      id: 'instance', etag: '"v7"', summary: 'Standup', start: { dateTime: '2026-09-10T09:00:00+07:00' }, end: { dateTime: '2026-09-10T09:15:00+07:00' },
      recurringEventId: 'series', description: 'private'
    })) as unknown as typeof fetch

    await expect(inspectGoogleEvent(fetchImpl, 'token', 'primary', 'instance')).resolves.toEqual({
      id: 'instance', title: 'Standup', start: '2026-09-10T02:00:00.000Z', end: '2026-09-10T02:15:00.000Z', description: 'private', allDay: false, revision: '"v7"'
    })
    const unsafe = vi.fn(async () => Response.json({ id: 'all-day', etag: '"v1"', start: { date: '2026-09-10' }, end: { date: '2026-09-11' } })) as unknown as typeof fetch

    await expect(inspectGoogleEvent(unsafe, 'token', 'primary', 'all-day')).rejects.toThrow(failure('unsupported'))
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/events/instance?fields='), expect.objectContaining({ redirect: 'error' }))
  })
})

// Keep this import live so failures assert the adapter's public error boundary.
void UtilityFailure


describe('send-email with cc, bcc, reply, forward and attachments', () => {
  const base = { action: 'send-email', operationId, sourceId: 'mail' }
  const file = { filename: 'báo giá.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF canary \x00\xff').toString('base64') }

  it('keeps the closed grammar: cc, bcc, reply (no To), forward (with To) and attachments, nothing else', () => {
    expect(parseUtilityWrite({ ...base, to: ['a@example.com'], cc: ['b@example.com'], bcc: ['c@example.com'], subject: 'Hi', body: 'x', attachments: [file] }))
      .toMatchObject({ cc: ['b@example.com'], bcc: ['c@example.com'], attachments: [file] })
    expect(parseUtilityWrite({ ...base, to: [], body: 'x', reply: { messageId: 'm1', all: true } }))
      .toMatchObject({ to: [], subject: '', reply: { messageId: 'm1', all: true } })
    expect(parseUtilityWrite({ ...base, to: ['a@example.com'], body: 'x', forward: { messageId: 'm1', attachments: false } }))
      .toMatchObject({ forward: { messageId: 'm1', attachments: false } })

    for (const bad of [
      { to: ['a@example.com'], cc: ['x@example.com\r\nBcc: spy@example.com'], subject: 'Hi', body: '' },
      { to: ['a@example.com'], bcc: ['Alice <a@example.com>'], subject: 'Hi', body: '' },
      { to: ['a@example.com'], subject: 'Hi', body: '', reply: { messageId: 'm1' } },
      { to: [], body: '', reply: { messageId: 'm1' }, threadId: 'thread-1', inReplyTo: '<abc@mail.test>' },
      { to: ['a@example.com'], subject: 'Hi', body: '', attachments: [{ filename: 'a/b', data: 'aGk=' }] },
      { to: ['a@example.com'], subject: 'Hi', body: '', attachments: [{ filename: 'a', data: 'aGk=', path: '/etc/passwd' }] },
      { to: [], subject: 'Hi', body: '' }
    ]) {
      expect(() => parseUtilityWrite({ ...base, ...bad })).toThrow(failure('invalid_input'))
    }
  })

  it('sends one multipart message whose parts decode back to the approved text, recipients and file', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: 'gmail-message' })) as unknown as typeof fetch
    const action = parseUtilityWrite({ ...base, to: ['a@example.com'], cc: ['b@example.com'], bcc: ['c@example.com'], subject: 'Báo giá', body: 'Xin chào', attachments: [file] })

    await executeGoogleWrite(fetchImpl, 'access-token', 'owner@example.com', 'primary', action as any)
    const mail = decodeMime(uploadOf(vi.mocked(fetchImpl).mock.calls[0]!).mime)

    expect([mail.headers.from, mail.headers.to, mail.headers.cc, mail.headers.bcc]).toEqual(['owner@example.com', 'a@example.com', 'b@example.com', 'c@example.com'])
    expect(decodeWords(mail.headers.subject!)).toBe('Báo giá')
    expect(mail.text).toBe('Xin chào')
    expect(mail.files[0]!.params.filename).toBe('báo giá.pdf')
    expect(mail.files[0]!.bytes!.equals(Buffer.from(file.data, 'base64'))).toBe(true)
  })

  it('needs the original message for a reply or forward: without it nothing is sent', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const reply = parseUtilityWrite({ ...base, to: [], body: 'x', reply: { messageId: 'm1' } })

    await expect(executeGoogleWrite(fetchImpl, 'access-token', 'owner@example.com', 'primary', reply as any)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('builds a reply-all from the real original before dispatch, refusing an oversize message as a plain failure', async () => {
    const original = {
      id: 'm1', threadId: 't1', payload: { headers: [
        { name: 'From', value: 'Lan <lan@example.com>' }, { name: 'To', value: 'owner@example.com, Binh <binh@example.com>' },
        { name: 'Cc', value: 'boss@example.com' }, { name: 'Subject', value: 'Quote' }, { name: 'Message-ID', value: '<a@m.test>' }
      ] }
    }
    const api = { json: vi.fn(async () => original) }
    const action = parseUtilityWrite({ ...base, to: [], body: 'Thanks', reply: { messageId: 'm1', all: true } })
    const prepared = await prepareGoogleEmail(api as any, 'owner@example.com', action as any, ['owner@example.com'])
    const mail = decodeMime(prepared.mime)

    expect(prepared.threadId).toBe('t1')
    expect([mail.headers.to, mail.headers.cc]).toEqual(['lan@example.com', 'binh@example.com, boss@example.com'])
    expect(decodeWords(mail.headers.subject!)).toBe('Re: Quote')

    const big = parseUtilityWrite({ ...base, to: ['a@example.com'], subject: 'Big', body: '', attachments: [{ filename: 'big.bin', data: Buffer.alloc(20 * 1024 * 1024, 1).toString('base64') }] })
    await expect(prepareGoogleEmail({ json: vi.fn() } as any, 'owner@example.com', big as any, [])).rejects.toMatchObject({ code: 'message_too_large' })
  })
})
