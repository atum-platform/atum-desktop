import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { decodeRaw, parseUpload } from '../../shared/gmail-mime-test-utils'
import { MATRIX_GOOGLE_ATTACHMENT_MAX_BYTES } from '../../shared/matrix-google-tools'

import { GOOGLE_SCOPES, MAIL_CALENDAR_SCOPES, ONE_CONSENT_SCOPES } from './google'

import { AtumUtilities, type UtilityAccount } from './index'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) { cleanup() } })

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url')
const PDF = Buffer.from('%PDF-1.4 canary bytes')

const idToken = (email: string) => {
  const part = (value: unknown) => b64(JSON.stringify(value))

  return `${part({ alg: 'RS256' })}.${part({ email, email_verified: true })}.sig`
}

/** A fake Gmail with real state: labels, a message with a PDF, drafts. It records every call that changes anything. */
function fakeGmail(grantModify: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'atum-mailbox-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const account: UtilityAccount = { accountId: 'account-a', generation: 1, root }
  const owner = 'minh@example.com'

  const state = {
    changes: [] as Array<{ method: string; path: string; body: any }>,
    gmailPaths: [] as string[],
    labels: [
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'Label_7', name: 'Receipts', type: 'user' }
    ],
    drafts: new Map<string, any>(),
    bigAttachment: false
  }

  const longBody = `${'x'.repeat(30_000)}END`

  const message = {
    id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], snippet: 'Invoice attached',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: '"Lan" <lan@example.com>' }, { name: 'To', value: owner },
        { name: 'Cc', value: 'boss@example.com' }, { name: 'Subject', value: 'Invoice' },
        { name: 'Date', value: 'Fri, 07 Nov 2026 10:00:00 +0700' }, { name: 'Message-ID', value: '<abc@mail.test>' },
        { name: 'X-Custom-Trace', value: 'trace-1' }
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64(longBody) } },
        { mimeType: 'application/pdf', filename: 'invoice.pdf', headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { attachmentId: 'ATT-1', size: PDF.length } },
        { mimeType: 'application/zip', filename: 'huge.zip', body: { attachmentId: 'ATT-BIG', size: MATRIX_GOOGLE_ATTACHMENT_MAX_BYTES + 1 } }
      ]
    }
  }

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const params = new URLSearchParams(String(init?.body ?? ''))
    const method = init?.method ?? 'GET'

    if (url.pathname === '/revoke') { return new Response(null, { status: 200 }) }

    if (url.pathname === '/token') {
      if (params.get('grant_type') === 'refresh_token') { return Response.json({ access_token: 'access' }) }

      return Response.json({
        access_token: 'first', refresh_token: `${owner}|1`, id_token: idToken(owner),
        scope: [...ONE_CONSENT_SCOPES, ...(grantModify ? [GOOGLE_SCOPES.gmailModify] : [])].join(' ')
      })
    }

    if (url.hostname === 'openidconnect.googleapis.com') { return Response.json({ email: owner, email_verified: true }) }

    if (url.pathname.includes('calendarList')) { return Response.json({ items: [{ id: 'primary-id', summary: owner, primary: true, accessRole: 'owner' }] }) }

    if (url.pathname.startsWith('/drive/')) { return Response.json({ user: { emailAddress: owner }, files: [] }) }

    if (url.pathname.endsWith('/events')) { return Response.json({ items: [] }) }

    const upload = url.pathname.startsWith('/upload/gmail/v1/users/me/')
    const path = upload ? url.pathname.slice('/upload/gmail/v1/users/me/'.length) : url.pathname.replace('/gmail/v1/users/me/', '')
    state.gmailPaths.push(`${method} ${upload ? 'upload ' : ''}${path}`)
    // A draft or send arrives as a media upload; the fake keeps it in the shape the assertions read.
    const read = upload ? parseUpload(new Headers(init!.headers).get('content-type')!, init!.body as Uint8Array) : undefined
    const threadId = (read?.metadata as any)?.threadId ?? (read?.metadata as any)?.message?.threadId

    const body = read
      ? { message: { raw: read.mime.toString('base64url'), ...(threadId ? { threadId } : {}) } }
      : init?.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : undefined

    if (!upload && method !== 'GET' && path.startsWith('drafts')) { throw new Error('a draft must be written by media upload') }

    if (path === 'profile') { return Response.json({ emailAddress: owner }) }

    if (method === 'GET' && path.startsWith('threads/t-long')) {
      return Response.json({ id: 't-long', messages: Array.from({ length: 23 }, (_, index) => ({
        id: `m${index}`, snippet: `s${index}`,
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'lan@example.com' }, { name: 'Date', value: `d${index}` }], body: { data: b64(index === 22 ? 'y'.repeat(14_000) : 'short') } }
      })) })
    }

    if (method === 'GET' && path === 'messages/m1') { return Response.json(message) }

    if (method === 'GET' && path === 'messages/m1/attachments/ATT-1') { return Response.json({ size: PDF.length, data: b64(PDF) }) }

    if (method === 'GET' && path === 'messages/m1/attachments/ATT-BIG') { state.bigAttachment = true; return Response.json({ size: 1, data: b64('x') }) }

    if (method === 'GET' && path === 'labels') { return Response.json({ labels: state.labels }) }

    if (method === 'GET' && path === 'drafts') { return Response.json({ drafts: [...state.drafts.keys()].map(id => ({ id })) }) }

    if (method === 'GET' && path.startsWith('drafts/')) { return Response.json(state.drafts.get(path.split('/')[1]!.split('?')[0]!)) }

    if (method !== 'GET') {
      state.changes.push({ method, path, body })

      if (path === 'labels') {
        const label = { id: 'Label_9', name: body.name, type: 'user' }
        state.labels.push(label)

        return Response.json(label)
      }

      if (path === 'drafts' || path.startsWith('drafts/')) {
        const id = path === 'drafts' ? 'd1' : path.split('/')[1]!

        const raw = Buffer.from(body.message.raw, 'base64url').toString('utf8')

        state.drafts.set(id, { id, message: { id: `${id}-m`, threadId: body.message.threadId ?? 'new', snippet: 'draft', payload: { headers: [
          { name: 'To', value: /^To: (.*)$/m.exec(raw)?.[1] ?? '' }, { name: 'Subject', value: 'Draft subject' }, { name: 'Date', value: 'now' }
        ] } } })

        return Response.json(state.drafts.get(id))
      }

      return Response.json({ id: path.split('/')[1], labelIds: ['INBOX'] })
    }

    return Response.json({}, { status: 404 })
  }) as unknown as typeof fetch

  const manager = new AtumUtilities({
    account: () => account,
    apple: { available: { calendar: false }, calendar: vi.fn(async () => ({ calendars: [] })) },
    google: { clientId: 'example.apps.googleusercontent.com' },
    fetchImpl,
    openExternal: vi.fn(async (value: string) => {
      const url = new URL(value)
      await fetch(`${url.searchParams.get('redirect_uri')}?state=${url.searchParams.get('state')}&code=code`)
    }),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value).reverse(), decryptString: (value: Buffer) => Buffer.from(value).reverse().toString() }
  })

  return { manager, account, state, fetchImpl }
}

/** The whole consent change that turns mailbox control on: one scope in the one-consent set. */
async function withModifyInConsent<T>(work: () => Promise<T>): Promise<T> {
  const consent = ONE_CONSENT_SCOPES as string[]
  consent.push(GOOGLE_SCOPES.gmailModify)

  try { return await work() } finally { consent.pop() }
}

async function connect(grantModify: boolean) {
  const fake = fakeGmail(grantModify)

  const connected = grantModify
    ? await withModifyInConsent(() => fake.manager.connect({ provider: 'google', service: 'google' }))
    : await fake.manager.connect({ provider: 'google', service: 'google' })

  const mail = connected.status!.sources.find(source => source.kind === 'email')!

  return { ...fake, mail, connected }
}

const manage = (f: Awaited<ReturnType<typeof connect>>, input: Record<string, unknown>) =>
  f.manager.manage(f.account.accountId, f.account.generation, { sourceId: f.mail.id, ...input }) as Promise<any>

describe('mailbox control on the Mac', () => {
  it('does not ask for gmail.modify yet: the new consent scope is one line, kept out of today\'s grants', () => {
    expect(MAIL_CALENDAR_SCOPES).not.toContain(GOOGLE_SCOPES.gmailModify)
    expect(ONE_CONSENT_SCOPES).not.toContain(GOOGLE_SCOPES.gmailModify)
    expect(GOOGLE_SCOPES.gmailModify).toBe('https://www.googleapis.com/auth/gmail.modify')
  })

  it('answers scope_missing without any Gmail call, keeps the mailbox connected and reading', async () => {
    const f = await connect(false)
    expect(f.mail).toMatchObject({ manageable: false })
    f.state.gmailPaths.length = 0

    for (const input of [
      { action: 'mailbox', operation: 'archive', threadId: 't1' },
      { action: 'create_label', name: 'Work' },
      { action: 'create_draft', to: ['a@example.com'], subject: 'Hi', body: 'Body' }
    ]) {
      await expect(manage(f, input)).rejects.toMatchObject({ code: 'scope_missing' })
    }

    expect(f.state.gmailPaths).toEqual([])
    expect(f.state.changes).toEqual([])

    const status = await f.manager.status()
    expect(status.status!.sources.find(source => source.kind === 'email')).toMatchObject({ state: 'connected', manageable: false })

    // Everything that does not need the scope keeps working.
    const read = await f.manager.read(f.account.accountId, f.account.generation, { kind: 'email', action: 'message', sources: [f.mail.id], id: 'm1' }) as any
    expect(read.results[0].data.subject).toBe('Invoice')
  })

  it('archives, reads, stars, labels and trashes through Gmail\'s own calls once the grant has gmail.modify', async () => {
    const f = await connect(true)
    expect(f.mail).toMatchObject({ manageable: true })

    expect(await manage(f, { action: 'mailbox', operation: 'archive', threadId: 't1' }))
      .toMatchObject({ done: true, operation: 'archive', target: 'thread', id: 't1', sourceId: f.mail.id })
    await manage(f, { action: 'mailbox', operation: 'mark_read', messageId: 'm1' })
    await manage(f, { action: 'mailbox', operation: 'star', messageId: 'm1' })
    await manage(f, { action: 'mailbox', operation: 'unarchive', threadId: 't1' })
    await manage(f, { action: 'mailbox', operation: 'add_labels', messageId: 'm1', labels: ['receipts'] })
    await manage(f, { action: 'mailbox', operation: 'trash', threadId: 't1' })
    await manage(f, { action: 'mailbox', operation: 'untrash', threadId: 't1' })

    expect(f.state.changes).toEqual([
      { method: 'POST', path: 'threads/t1/modify', body: { removeLabelIds: ['INBOX'] } },
      { method: 'POST', path: 'messages/m1/modify', body: { removeLabelIds: ['UNREAD'] } },
      { method: 'POST', path: 'messages/m1/modify', body: { addLabelIds: ['STARRED'] } },
      { method: 'POST', path: 'threads/t1/modify', body: { addLabelIds: ['INBOX'] } },
      { method: 'POST', path: 'messages/m1/modify', body: { addLabelIds: ['Label_7'] } },
      { method: 'POST', path: 'threads/t1/trash', body: undefined },
      { method: 'POST', path: 'threads/t1/untrash', body: undefined }
    ])
  })

  it('refuses a label that does not exist and the labels that are places, never touching Gmail', async () => {
    const f = await connect(true)
    f.state.changes.length = 0

    await expect(manage(f, { action: 'mailbox', operation: 'add_labels', messageId: 'm1', labels: ['No such label'] })).rejects.toMatchObject({ code: 'label_not_found' })
    await expect(manage(f, { action: 'mailbox', operation: 'add_labels', messageId: 'm1', labels: ['TRASH'] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(manage(f, { action: 'mailbox', operation: 'remove_labels', messageId: 'm1', labels: ['spam'] })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.state.changes).toEqual([])
  })

  it('lists and creates labels', async () => {
    const f = await connect(true)

    expect(await manage(f, { action: 'create_label', name: 'Clients' })).toMatchObject({ done: true, label: { labelId: 'Label_9', name: 'Clients' } })

    const read = await f.manager.read(f.account.accountId, f.account.generation, { kind: 'email', action: 'labels', sources: [f.mail.id] }) as any
    expect(read.results[0].data.labels.map((label: any) => label.name)).toEqual(['INBOX', 'Receipts', 'Clients'])
  })

  it('saves drafts without sending anything, and updates one in place', async () => {
    const f = await connect(true)

    const created = await manage(f, { action: 'create_draft', to: ['lan@example.com'], subject: 'Bản nháp 👋', body: 'Xin chào', threadId: 't1', inReplyTo: '<abc@mail.test>' })
    expect(created).toMatchObject({ done: true, sent: false, draftId: 'd1' })

    const raw = Buffer.from(f.state.changes[0]!.body.message.raw, 'base64url').toString('utf8')
    expect(raw).toContain('To: lan@example.com')
    expect(raw).toContain('In-Reply-To: <abc@mail.test>')
    expect(raw).toContain('Content-Transfer-Encoding: base64')
    expect(f.state.changes[0]!.body.message.threadId).toBe('t1')
    expect(f.state.gmailPaths.some(path => path.includes('messages/send'))).toBe(false)

    await manage(f, { action: 'update_draft', draftId: 'd1', to: ['lan@example.com'], subject: 'v2', body: 'Revised' })
    expect(f.state.changes[1]).toMatchObject({ method: 'PUT', path: 'drafts/d1' })
    // Both writes went to Gmail's media-upload endpoint (the JSON endpoint stops near 5 MB), never the ordinary one.
    expect(f.state.gmailPaths.filter(path => /^(POST|PUT) /.test(path))).toEqual(['POST upload drafts', 'PUT upload drafts/d1'])

    const listed = await f.manager.read(f.account.accountId, f.account.generation, { kind: 'email', action: 'drafts', sources: [f.mail.id] }) as any
    expect(listed.results[0].data.drafts).toEqual([expect.objectContaining({ draftId: 'd1', messageId: 'd1-m', subject: 'Draft subject' })])

    // A header-injection attempt is refused before it reaches Gmail.
    f.state.changes.length = 0
    await expect(manage(f, { action: 'create_draft', to: ['evil@example.com\r\nBcc: x@y.z'], subject: 'x', body: 'y' })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.state.changes).toEqual([])
  })

  it('saves a reply draft with Cc and a file, in the thread of the message it answers, and still sends nothing', async () => {
    const f = await connect(true)
    const note = Buffer.from('ghi chú')

    await manage(f, { action: 'create_draft', to: [], subject: '', body: 'Noted', cc: ['c@example.com'], reply: { messageId: 'm1', all: true }, attachments: [{ filename: 'ghi chú.txt', mimeType: 'text/plain', data: note.toString('base64') }] })

    const draft = f.state.changes.find(change => change.path === 'drafts')!
    const mail = decodeRaw(draft.body.message.raw)
    expect(draft.body.message.threadId).toBe('t1')
    expect(mail.headers.to).toBe('lan@example.com')
    // The owner (minh@example.com, an original To) is not on the reply-all; the original Cc and the agent's Cc are.
    expect(mail.headers.cc).toBe('boss@example.com, c@example.com')
    expect(mail.files[0]!.bytes!.equals(note)).toBe(true)
    expect(f.state.changes.some(change => change.path.includes('send'))).toBe(false)
  })

  it('respects the owner\'s switch for the mailbox', async () => {
    const f = await connect(true)
    await f.manager.setEnabled([{ id: f.mail.id, enabled: false }])

    await expect(manage(f, { action: 'mailbox', operation: 'archive', threadId: 't1' })).rejects.toMatchObject({ code: 'denied' })
    expect(f.state.changes).toEqual([])
  })

  it('reads one message in full: every header, a page of text with how to continue, and its files', async () => {
    const f = await connect(false)
    const ask = (offset?: number) => f.manager.read(f.account.accountId, f.account.generation, { kind: 'email', action: 'message', sources: [f.mail.id], id: 'm1', ...(offset ? { offset } : {}) }) as Promise<any>

    const first = (await ask()).results[0].data

    expect(first.headers.map((header: any) => header.name)).toContain('X-Custom-Trace')
    expect(first).toMatchObject({ from: '"Lan" <lan@example.com>', cc: 'boss@example.com', subject: 'Invoice', labelIds: ['INBOX', 'UNREAD'], textLength: 30_003, truncated: true, nextOffset: 20_000 })
    expect(first.text).toHaveLength(20_000)
    expect(first.continueWith).toMatchObject({ action: 'read_message', messageId: 'm1', offset: 20_000 })
    expect(first.attachments).toEqual([
      { attachmentId: 'ATT-1', filename: 'invoice.pdf', mimeType: 'application/pdf', size: PDF.length },
      { attachmentId: 'ATT-BIG', filename: 'huge.zip', mimeType: 'application/zip', size: MATRIX_GOOGLE_ATTACHMENT_MAX_BYTES + 1 }
    ])
    expect(first.reply).toMatchObject({ to: ['lan@example.com'], subject: 'Re: Invoice', inReplyTo: '<abc@mail.test>' })

    const last = (await ask(20_000)).results[0].data

    expect(last.text.endsWith('END')).toBe(true)
    expect(last.truncated).toBeUndefined()
    expect(last.offset).toBe(20_000)
  })

  it('says when a thread read left messages out or cut a body, and how to read them', async () => {
    const f = await connect(false)
    const read = await f.manager.read(f.account.accountId, f.account.generation, { kind: 'email', action: 'thread', sources: [f.mail.id], id: 't-long' }) as any
    const thread = read.results[0].data

    expect(thread.truncated).toBe(true)
    expect(thread.messages).toHaveLength(20)
    expect(thread.olderMessages.map((message: any) => message.id)).toEqual(['m0', 'm1', 'm2'])
    expect(thread.messages.at(-1)).toMatchObject({ truncated: true, textLength: 14_000 })
    expect(thread.hint).toContain('read_message')
    expect(thread.more).toBe(true)
  })

  it('hands over an attachment as bytes, only for that message, and refuses a file over the limit before fetching it', async () => {
    const f = await connect(false)
    const get = (attachmentId: string, messageId = 'm1') => f.manager.attachment(f.account.accountId, f.account.generation, { action: 'download_attachment', sourceId: f.mail.id, messageId, attachmentId })

    const file = await get('ATT-1')
    expect(file).toMatchObject({ filename: 'invoice.pdf', mimeType: 'application/pdf' })
    expect(file.bytes.equals(PDF)).toBe(true)

    await expect(get('ATT-BIG')).rejects.toMatchObject({ code: 'too_large' })
    expect(f.state.bigAttachment).toBe(false)
    await expect(get('ATT-OTHER')).rejects.toMatchObject({ code: 'not_found' })
  })
})
