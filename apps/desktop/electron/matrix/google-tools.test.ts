import { request as httpRequest } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UtilityStatus } from '../../shared/atum-utilities'
import type { MatrixGoogleServices } from '../../shared/matrix-google-tools'

import type { MatrixGoogleToolOutcome } from './google-connections'
import {
  matrixGoogleAgendaRange,
  matrixGoogleToolResult,
  MatrixGoogleTools,
  type MatrixGoogleToolsExecutor,
  type MatrixGoogleToolsGate,
  matrixGoogleUtilityInput,
  parseMatrixGoogleToolRequest
} from './google-tools'
import { MatrixGoogleAssistant } from './main-google'

const brokers: MatrixGoogleTools[] = []

afterEach(async () => {
  await Promise.all(brokers.splice(0).map(broker => broker.stop()))
})

const STATUS: UtilityStatus = {
  accountId: 'a',
  generation: 1,
  available: { google: true, 'apple-calendar': false },
  sources: [
    { id: 's:mail', kind: 'email', provider: 'google', accountKey: 'g:1', label: 'minh@example.com', state: 'connected', enabled: true, writable: true },
    { id: 's:cal', kind: 'calendar', provider: 'google', accountKey: 'g:1', label: 'Work', detail: 'minh@example.com', primary: true, state: 'connected', enabled: true, writable: true }
  ]
}

const NO_SERVICES: MatrixGoogleServices = { gmail: false, send: false, calendar: false, drive: false }

function executor(overrides: Partial<Record<keyof MatrixGoogleToolsExecutor, (...args: any[]) => Promise<MatrixGoogleToolOutcome<any>>>> = {}) {
  return {
    toolRead: vi.fn(overrides.toolRead ?? (async () => ({ ok: true as const, value: { results: [] } }))),
    toolWrite: vi.fn(overrides.toolWrite ?? (async () => ({ ok: true as const, value: { id: 'sent-1', operationId: 'op' } }))),
    toolStatus: vi.fn(overrides.toolStatus ?? (async () => ({ ok: true as const, value: STATUS }))),
    toolMailbox: vi.fn(overrides.toolMailbox ?? (async (input: Record<string, unknown>) => ({ ok: true as const, value: { done: true, action: input.action, sourceId: input.sourceId } }))),
    toolAttachment: vi.fn(overrides.toolAttachment ?? (async () => ({ ok: true as const, value: { filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 canary') } })))
  }
}

async function broker(input: { gate?: (role: string) => MatrixGoogleToolsGate; connections?: ReturnType<typeof executor>; log?: (line: string) => void } = {}) {
  const connections = input.connections ?? executor()
  const log = input.log ?? vi.fn()

  const tools = new MatrixGoogleTools({
    gate: input.gate ?? (() => 'ok'),
    connections: () => connections,
    log,
    now: () => new Date(2026, 9, 4, 15, 30)
  })

  await tools.start()
  brokers.push(tools)

  return { tools, connections, log, key: tools.mint('agent'), port: Number(new URL(tools.url).port) }
}

function call(port: number, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'POST', path: '/v1/google', headers: { 'Content-Type': 'application/json', ...headers } },
      res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }))
      }
    )

    req.on('error', reject)
    req.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
}

async function composedBroker({
  fullPower,
  ownModel = false,
  proxy = 'http://127.0.0.1:43123/v1',
  served = true,
  services = NO_SERVICES
}: {
  fullPower: boolean
  ownModel?: boolean
  proxy?: string | undefined
  served?: boolean | null
  services?: MatrixGoogleServices
}) {
  const items = new Map<string, string>()

  const store = {
    getItem: vi.fn((key: string) => items.get(key) ?? null),
    setItems: vi.fn((entries: Record<string, string>) => {
      for (const [key, value] of Object.entries(entries)) {
        items.set(key, value)
      }
    }),
    failureCode: vi.fn(() => null as string | null)
  }

  const connections = Object.assign(executor(), {
    configured: true,
    services: vi.fn(() => services)
  })

  const servesProtected = vi.fn(async () => served)
  let tools: MatrixGoogleTools | undefined

  const google = new MatrixGoogleAssistant({
    store: () => store,
    agentPrincipal: () => 'agent-principal-1',
    executorId: () => 'exec-1',
    ownModel: () => ownModel,
    connections: () => connections,
    servesProtected,
    proxyBaseUrl: () => proxy,
    tools: () => tools,
    fullPower: () => fullPower
  })

  tools = new MatrixGoogleTools({
    gate: role => google.gate(role),
    connections: () => connections,
    log: vi.fn(),
    now: () => new Date(2026, 9, 4, 15, 30)
  })

  await tools.start()
  brokers.push(tools)

  return { connections, google, items, servesProtected, store, tools }
}

describe('the assistant request grammar', () => {
  it('accepts each action with its own arguments and refuses anything else', () => {
    expect(parseMatrixGoogleToolRequest({ action: 'agenda' })).toEqual({ action: 'agenda', when: 'today_and_tomorrow' })
    expect(parseMatrixGoogleToolRequest({ action: 'agenda', when: 'next_7d' })).toEqual({ action: 'agenda', when: 'next_7d' })
    expect(parseMatrixGoogleToolRequest({ action: 'agenda', when: 'past_30d' })).toEqual({ action: 'agenda', when: 'past_30d' })
    expect(parseMatrixGoogleToolRequest({ action: 'agenda', when: 'past_365d' })).toEqual({ action: 'agenda', when: 'past_365d' })
    expect(parseMatrixGoogleToolRequest({ action: 'search_drive', query: 'budget', sort: 'viewed', modifiedAfter: '2026-01-01' }))
      .toEqual({ action: 'search_drive', query: 'budget', sort: 'viewed', modifiedAfter: '2026-01-01' })
    expect(parseMatrixGoogleToolRequest({ action: 'search_drive', sort: 'recent' })).toBeNull()
    expect(parseMatrixGoogleToolRequest({ action: 'search_drive', modifiedAfter: '2026-02-31T99:00:00Z' })).toBeNull()
    expect(parseMatrixGoogleToolRequest({ action: 'search_drive', modifiedAfter: '2026-02-31' })).toBeNull()
    expect(parseMatrixGoogleToolRequest({ action: 'search_drive', modifiedAfter: '2026-02-29' })).toBeNull()
    expect(parseMatrixGoogleToolRequest({ action: 'read_thread', sourceId: 's:mail', threadId: 't1' })).toEqual({
      action: 'read_thread',
      sourceId: 's:mail',
      threadId: 't1'
    })
    expect(parseMatrixGoogleToolRequest({ action: 'delete_email', id: 'x' })).toBeNull()
    expect(parseMatrixGoogleToolRequest({ action: 'search_mail', query: 'x', url: 'https://evil.test' })).toBeNull()
    expect(parseMatrixGoogleToolRequest({ action: 'agenda', when: 'next_year' })).toBeNull()
    expect(parseMatrixGoogleToolRequest({ action: 'create_event', sourceId: 's', title: 't', start: 'a', end: 'b', eventId: 'e' })).toBeNull()
    expect(parseMatrixGoogleToolRequest({ action: 'update_event', sourceId: 's', title: 't', start: 'a', end: 'b' })).toBeNull()
    expect(parseMatrixGoogleToolRequest(['status'])).toBeNull()
  })

  it("bounds the agenda by this Mac's local days", () => {
    const now = new Date(2026, 9, 4, 23, 59)
    const midnight = (offset: number) => new Date(2026, 9, 4 + offset).toISOString()

    expect(matrixGoogleAgendaRange('today', now)).toEqual({ start: midnight(0), end: midnight(1) })
    expect(matrixGoogleAgendaRange('tomorrow', now)).toEqual({ start: midnight(1), end: midnight(2) })
    expect(matrixGoogleAgendaRange('today_and_tomorrow', now)).toEqual({ start: midnight(0), end: midnight(2) })
    expect(matrixGoogleAgendaRange('next_7d', now)).toEqual({ start: midnight(0), end: midnight(7) })
    expect(matrixGoogleAgendaRange('past_30d', now)).toEqual({ start: midnight(-30), end: midnight(1) })
    expect(matrixGoogleAgendaRange('past_365d', now)).toEqual({ start: midnight(-365), end: midnight(1) })
  })

  it('turns each request into the utility grammar, with a fresh operation for a send', () => {
    const now = new Date(2026, 9, 4)

    expect(matrixGoogleUtilityInput({ action: 'waiting' }, now)).toEqual({ read: { kind: 'email', action: 'waiting' } })
    expect(matrixGoogleUtilityInput({ action: 'read_file', sourceId: 's:d', fileId: 'f' }, now)).toEqual({
      read: { kind: 'drive', action: 'file', sources: ['s:d'], id: 'f' }
    })
    expect(matrixGoogleUtilityInput(
      { action: 'search_drive', query: 'budget', sort: 'viewed', modifiedAfter: '2026-01-01' }, now
    )).toEqual({
      read: { kind: 'drive', action: 'files', query: 'budget', sort: 'viewed', modifiedAfter: '2026-01-01' }
    })
    expect(matrixGoogleUtilityInput({ action: 'agenda', when: 'past_30d' }, now)).toMatchObject({
      read: { kind: 'calendar', action: 'events', limit: 250 }
    })
    expect(
      matrixGoogleUtilityInput(
        { action: 'send_email', sourceId: 's:mail', to: ['lan@example.com'], subject: 'Re: Quote', body: 'Hi', threadId: 't1', inReplyTo: '<m@x>' },
        now,
        () => 'fixed-uuid'
      )
    ).toEqual({
      write: {
        action: 'send-email',
        operationId: 'fixed-uuid',
        sourceId: 's:mail',
        to: ['lan@example.com'],
        subject: 'Re: Quote',
        body: 'Hi',
        threadId: 't1',
        inReplyTo: '<m@x>'
      }
    })
  })

  it('pages one mailbox at a time with a bounded cursor', () => {
    const now = new Date(2026, 9, 4)

    expect(parseMatrixGoogleToolRequest({ action: 'search_mail', query: 'after:2020/01/01', sourceId: 's:mail', pageToken: '09+/=&87' }))
      .toEqual({ action: 'search_mail', query: 'after:2020/01/01', sourceId: 's:mail', pageToken: '09+/=&87' })
    // A cursor without its mailbox, or one outside the bound, is refused rather than ignored.
    expect(parseMatrixGoogleToolRequest({ action: 'search_mail', query: 'x', pageToken: '0987' })).toBeNull()
    expect(parseMatrixGoogleToolRequest({ action: 'search_mail', query: 'x', sourceId: 's:mail', pageToken: 'a\nb' })).toBeNull()
    expect(parseMatrixGoogleToolRequest({ action: 'search_mail', query: 'x', sourceId: 's:mail', pageToken: '1'.repeat(513) }))
      .toBeNull()
    expect(matrixGoogleUtilityInput({ action: 'search_mail', query: 'x', sourceId: 's:mail', pageToken: '0987' }, now)).toEqual({
      read: { kind: 'email', action: 'inbox', query: 'x', sources: ['s:mail'], pageToken: '0987' }
    })
    expect(matrixGoogleUtilityInput({ action: 'search_mail', query: 'x' }, now)).toEqual({
      read: { kind: 'email', action: 'inbox', query: 'x' }
    })

    const result = matrixGoogleToolResult({ action: 'search_mail', query: 'x' }, {
      results: [
        { sourceId: 's:mail', label: 'minh@example.com', data: { messages: [{ id: 'm1' }], more: true, nextPageToken: '1111' } },
        { sourceId: 's:other', label: 'lan@example.com', data: { messages: [{ id: 'm2' }] } }
      ],
      truncated: true
    }) as Record<string, unknown>

    expect(result.nextPages).toEqual([{ sourceId: 's:mail', pageToken: '1111' }])
    expect(result.truncated).toBe(true)
    expect(matrixGoogleToolResult({ action: 'search_mail', query: 'x' }, { results: [] })).not.toHaveProperty('nextPages')
  })

  it('tells an unticked service from a missing connection', () => {
    const missing = { error: 'connection_required', kind: 'drive' }

    expect(matrixGoogleToolResult({ action: 'search_drive' }, missing, STATUS)).toMatchObject({ error: 'not_allowed', service: 'drive' })
    expect(matrixGoogleToolResult({ action: 'search_drive' }, missing, { ...STATUS, sources: [] })).toMatchObject({
      error: 'not_connected'
    })
  })

  it('names the source of every agenda item and keeps notes short', () => {
    const result = matrixGoogleToolResult(
      { action: 'agenda', when: 'today' },
      {
        results: [
          {
            sourceId: 's:cal',
            label: 'Work',
            account: 'minh@example.com',
            data: {
              events: [
                { id: 'e2', title: 'Later', start: { dateTime: '2026-10-04T16:00:00+07:00' }, end: { dateTime: '2026-10-04T17:00:00+07:00' } },
                { id: 'e1', title: 'Standup', start: { dateTime: '2026-10-04T09:00:00+07:00' }, end: { dateTime: '2026-10-04T09:15:00+07:00' }, description: 'x'.repeat(2000) }
              ]
            }
          }
        ]
      }
    ) as { events: Array<Record<string, unknown>> }

    expect(result.events.map(event => event.eventId)).toEqual(['e1', 'e2'])
    expect(result.events[0]).toMatchObject({ calendar: 'Work', account: 'minh@example.com', sourceId: 's:cal' })
    expect(String(result.events[0].notes).length).toBe(500)
  })
})

describe('the Google broker', () => {
  it('reads for the default assistant through the adapter and answers in its terms', async () => {
    const connections = executor({
      toolRead: async () => ({
        ok: true,
        value: {
          results: [{ sourceId: 's:mail', label: 'minh@example.com', data: { threads: [{ id: 't1', subject: 'Quote', from: { name: 'Lan', address: 'lan@example.com' }, waitingSince: '2026-10-01T02:00:00.000Z', snippet: 'Any news?', messageCount: 2 }] } }]
        }
      })
    })

    const { port, key } = await broker({ connections })
    const answer = await call(port, { action: 'waiting' }, { Authorization: `Bearer ${key}` })

    expect(answer.status).toBe(200)
    expect(answer.json.threads).toEqual([
      { account: 'minh@example.com', sourceId: 's:mail', threadId: 't1', subject: 'Quote', from: { name: 'Lan', address: 'lan@example.com' }, waitingSince: '2026-10-01T02:00:00.000Z', snippet: 'Any news?', messages: 2 }
    ])
    expect(connections.toolRead).toHaveBeenCalledWith({ kind: 'email', action: 'waiting' })
  })

  it('sends only through the adapter write, which waits for the owner, and reports a cancel as nothing done', async () => {
    const connections = executor({ toolWrite: async () => ({ ok: false, error: 'cancelled' }) })
    const { port, key } = await broker({ connections })

    const answer = await call(
      port,
      { action: 'send_email', sourceId: 's:mail', to: ['lan@example.com'], subject: 'Hi', body: 'Hello' },
      { Authorization: `Bearer ${key}` }
    )

    expect(answer.json).toMatchObject({ error: 'cancelled' })
    expect(answer.json.hint).toContain('Nothing was sent')
    expect(connections.toolWrite).toHaveBeenCalledTimes(1)
    expect(connections.toolWrite.mock.calls[0][0]).toMatchObject({ action: 'send-email', to: ['lan@example.com'] })
  })

  it('hands cc, bcc, a reply or forward and attachments to the adapter write exactly, over a body far past the old 64 KiB bound', async () => {
    const connections = executor({ toolWrite: async () => ({ ok: true, value: { id: 'sent-2', operationId: 'op' } }) })
    const { port, key } = await broker({ connections })
    const data = Buffer.alloc(300 * 1024, 4).toString('base64')

    const answer = await call(
      port,
      { action: 'send_email', sourceId: 's:mail', to: ['a@example.com'], cc: ['b@example.com'], bcc: ['c@example.com'], subject: 'Files', body: 'See', attachments: [{ filename: 'a.bin', data }] },
      { Authorization: `Bearer ${key}` }
    )
    await call(
      port,
      { action: 'send_email', sourceId: 's:mail', to: [], subject: '', body: 'Thanks', reply: { messageId: 'm1', all: true } },
      { Authorization: `Bearer ${key}` }
    )

    expect(answer.json).toMatchObject({ done: true, action: 'send_email' })
    expect(connections.toolWrite.mock.calls[0][0]).toMatchObject({ action: 'send-email', cc: ['b@example.com'], bcc: ['c@example.com'], attachments: [{ filename: 'a.bin', data }] })
    expect(connections.toolWrite.mock.calls[1][0]).toMatchObject({ action: 'send-email', to: [], reply: { messageId: 'm1', all: true } })
  })

  it('answers a message past Gmail’s limit with its own typed code and hint', async () => {
    const connections = executor({ toolWrite: async () => ({ ok: false, error: 'message_too_large' }) })
    const { port, key } = await broker({ connections })

    const answer = await call(port, { action: 'send_email', sourceId: 's:mail', to: ['a@example.com'], subject: 'x', body: 'y' }, { Authorization: `Bearer ${key}` })

    expect(answer.json).toMatchObject({ error: 'message_too_large' })
    expect(answer.json.hint).toContain('25 MB')
  })

  it('never asks the owner to confirm a send from a mailbox whose send permission they unticked', async () => {
    const readOnly: UtilityStatus = {
      ...STATUS,
      sources: STATUS.sources.map(source => (source.kind === 'email' ? { ...source, writable: false } : source))
    }

    const connections = executor({ toolStatus: async () => ({ ok: true, value: readOnly }) })
    const { port, key } = await broker({ connections })

    const answer = await call(
      port,
      { action: 'send_email', sourceId: 's:mail', to: ['lan@example.com'], subject: 'Hi', body: 'Hello' },
      { Authorization: `Bearer ${key}` }
    )

    expect(answer.json).toMatchObject({ error: 'not_allowed', service: 'gmail_send' })
    expect(answer.json.hint).toContain('do not ask again')
    expect(connections.toolWrite).not.toHaveBeenCalled()
  })

  it('says a write with no answer may already have happened', async () => {
    const connections = executor({ toolWrite: async () => ({ ok: false, error: 'outcome_unknown' }) })
    const { port, key } = await broker({ connections })

    const answer = await call(
      port,
      { action: 'create_event', sourceId: 's:cal', title: 'Call', start: '2026-10-05T09:00:00+07:00', end: '2026-10-05T09:30:00+07:00' },
      { Authorization: `Bearer ${key}` }
    )

    expect(answer.json.error).toBe('outcome_unknown')
    expect(answer.json.hint).toContain('Do not try again')
  })

  it.each([
    ['protected_route_unavailable', 'the protected model route is not served'],
    ['not_available', 'the caller is not the default assistant on Atum’s model'],
    ['fence', 'the Google latch could not be saved']
  ] as const)('refuses before reading anything from Google when %s (%s)', async (gate, _why) => {
    const connections = executor()
    const { port, key, log } = await broker({ gate: () => gate, connections })
    const answer = await call(port, { action: 'agenda' }, { Authorization: `Bearer ${key}` })

    expect(answer.json.error).toBe(gate)
    expect(connections.toolRead).not.toHaveBeenCalled()
    expect(connections.toolStatus).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(`[Matrix] google tool agenda ${gate}`)
  })

  it('refuses other agents, browsers, wrong hosts and revoked keys without touching the adapter', async () => {
    const connections = executor()
    // Main's gate: only the default assistant's role may use Google.
    const { tools, port, key } = await broker({ connections, gate: role => (role === 'agent' ? 'ok' : 'not_available') })
    const other = tools.mint('agent:alfred')

    expect((await call(port, { action: 'status' })).status).toBe(401)
    expect((await call(port, { action: 'status' }, { Authorization: `Bearer ${'f'.repeat(64)}` })).status).toBe(401)
    expect((await call(port, { action: 'status' }, { Authorization: `Bearer ${key}`, Origin: 'https://evil.test' })).status).toBe(403)
    expect((await call(port, { action: 'status' }, { Authorization: `Bearer ${key}`, Host: 'evil.test' })).status).toBe(403)
    expect((await call(port, { action: 'status' }, { Authorization: `Bearer ${other}` })).json.error).toBe('not_available')

    tools.revoke('agent')
    expect((await call(port, { action: 'status' }, { Authorization: `Bearer ${key}` })).status).toBe(401)
    expect(connections.toolStatus).not.toHaveBeenCalled()
    expect(connections.toolRead).not.toHaveBeenCalled()
  })

  it('refuses requests outside the grammar without calling the adapter', async () => {
    const connections = executor()
    const { port, key } = await broker({ connections })

    for (const body of ['not json', { action: 'forward_all_mail' }, { action: 'read_file', sourceId: 's', fileId: 'f', path: '/etc' }]) {
      expect((await call(port, body, { Authorization: `Bearer ${key}` })).json.error).toBe('invalid_input')
    }

    expect(connections.toolRead).not.toHaveBeenCalled()
  })

  it('waits briefly while Settings holds the connection, then answers', async () => {
    let busy = 2

    const connections = executor({
      toolRead: async () => (busy-- > 0 ? { ok: false, error: 'busy' } : { ok: true, value: { results: [] } })
    })

    const { port, key } = await broker({ connections })
    const answer = await call(port, { action: 'search_drive' }, { Authorization: `Bearer ${key}` })

    expect(answer.json).toEqual({ files: [] })
    expect(connections.toolRead).toHaveBeenCalledTimes(3)
  })

  it('asks the assistant to narrow an answer too large for its context', async () => {
    const connections = executor({
      toolRead: async () => ({ ok: true, value: { results: [{ sourceId: 's', label: 'a', data: { id: 't', messages: [{ text: 'x'.repeat(300_000) }] } }] } })
    })

    const { port, key } = await broker({ connections })

    expect((await call(port, { action: 'read_thread', sourceId: 's', threadId: 't' }, { Authorization: `Bearer ${key}` })).json.error).toBe('too_large')
  })

  it('judges size in bytes, as the tool reading it does: a long Vietnamese thread is narrowed too', async () => {
    // 180,000 characters (under the old character limit), 261,000 bytes in UTF-8.
    const connections = executor({
      toolRead: async () => ({ ok: true, value: { results: [{ sourceId: 's', label: 'a', data: { id: 't', messages: [{ text: 'Những điều cần biết '.repeat(9_000) }] } }] } })
    })

    const { port, key } = await broker({ connections })

    expect((await call(port, { action: 'read_thread', sourceId: 's', threadId: 't' }, { Authorization: `Bearer ${key}` })).json.error).toBe('too_large')
  })

  it('logs only the action and a closed code, never content', async () => {
    const log = vi.fn()

    const connections = executor({
      toolRead: async () => ({ ok: true, value: { results: [{ sourceId: 's:mail', label: 'secret@example.com', data: { messages: [{ id: 'm', snippet: 'very private words' }] } }] } })
    })

    const { port, key } = await broker({ connections, log })

    await call(port, { action: 'search_mail', query: 'private salary review' }, { Authorization: `Bearer ${key}` })

    const lines = log.mock.calls.map(callArgs => String(callArgs[0]))
    expect(lines).toEqual(['[Matrix] google tool search_mail ok'])
    expect(lines.join('\n')).not.toMatch(/private|secret|salary/)
  })
})

function callRaw(port: number, path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; type: string; headers: Record<string, any>; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'POST', path, headers: { 'Content-Type': 'application/json', ...headers } },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), headers: res.headers, bytes: Buffer.concat(chunks) }))
      }
    )

    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

describe('mailbox control through the broker', () => {
  const MAILBOX = { action: 'mailbox', sourceId: 's:mail', operation: 'archive', threadId: 't1' }

  it('accepts each new action with its own arguments and refuses everything else', () => {
    const ok = [
      { action: 'read_message', sourceId: 's', messageId: 'm1', offset: 20_000 },
      { action: 'download_attachment', sourceId: 's', messageId: 'm1', attachmentId: 'A'.repeat(900) },
      { action: 'list_labels', sourceId: 's' },
      { action: 'list_drafts', sourceId: 's', pageToken: 'next' },
      MAILBOX,
      { action: 'mailbox', sourceId: 's', operation: 'remove_labels', messageId: 'm1', labels: ['Receipts'] },
      { action: 'create_label', sourceId: 's', name: 'Clients' },
      { action: 'create_draft', sourceId: 's', to: [], subject: 'Hi', body: '' },
      { action: 'update_draft', sourceId: 's', draftId: 'r-123', to: ['a@example.com'], subject: 'Hi', body: 'x' }
    ]

    for (const request of ok) {
      expect(parseMatrixGoogleToolRequest(request)).toEqual(request)
    }

    const bad = [
      { action: 'read_message', sourceId: 's', messageId: 'a/b' },
      { action: 'read_message', sourceId: 's', messageId: 'm1', offset: -1 },
      { action: 'download_attachment', sourceId: 's', messageId: 'm1' },
      // exactly one target, labels only on the label operations, no unknown operation
      { action: 'mailbox', sourceId: 's', operation: 'archive' },
      { action: 'mailbox', sourceId: 's', operation: 'archive', threadId: 't', messageId: 'm' },
      { action: 'mailbox', sourceId: 's', operation: 'archive', threadId: 't', labels: ['x'] },
      { action: 'mailbox', sourceId: 's', operation: 'add_labels', threadId: 't' },
      { action: 'mailbox', sourceId: 's', operation: 'delete_forever', threadId: 't' },
      { action: 'create_draft', sourceId: 's', to: [], subject: 'x', body: 'y', draftId: 'd' },
      { action: 'create_draft', sourceId: 's', to: [], subject: 'x', body: 'y', threadId: 't1' },
      { action: 'update_draft', sourceId: 's', to: [], subject: 'x', body: 'y' },
      { action: 'create_draft', sourceId: 's', to: [], subject: 'x', body: 'y', carbon: ['c@example.com'] }
    ]

    for (const request of bad) {
      expect(parseMatrixGoogleToolRequest(request)).toBeNull()
    }
  })

  it('turns each new request into the utility grammar the Mac runs', () => {
    const at = new Date(2026, 9, 4)

    expect(matrixGoogleUtilityInput({ action: 'read_message', sourceId: 's', messageId: 'm1', offset: 5 }, at)).toEqual({
      read: { kind: 'email', action: 'message', sources: ['s'], id: 'm1', offset: 5 }
    })
    expect(matrixGoogleUtilityInput({ action: 'list_labels', sourceId: 's' }, at)).toEqual({ read: { kind: 'email', action: 'labels', sources: ['s'] } })
    expect(matrixGoogleUtilityInput({ action: 'list_drafts', sourceId: 's' }, at)).toEqual({ read: { kind: 'email', action: 'drafts', sources: ['s'] } })
    expect(matrixGoogleUtilityInput(MAILBOX as any, at)).toEqual({ mailbox: MAILBOX })
    // A mailbox change never carries an operation id: there is no dialog and no ledger to resume.
    expect(JSON.stringify(matrixGoogleUtilityInput(MAILBOX as any, at))).not.toContain('operationId')
  })

  it('changes the mailbox without asking the owner, and says when the grant cannot', async () => {
    const connections = executor()
    const { port, key } = await broker({ connections })
    const auth = { Authorization: `Bearer ${key}` }

    expect(await call(port, MAILBOX, auth)).toMatchObject({ status: 200, json: { done: true, action: 'mailbox' } })
    expect(connections.toolMailbox).toHaveBeenCalledWith(MAILBOX, expect.anything())
    expect(connections.toolWrite).not.toHaveBeenCalled()

    const scoped = executor({ toolMailbox: async () => ({ ok: false as const, error: 'scope_missing' }) })
    const again = await broker({ connections: scoped })
    const refused = (await call(again.port, MAILBOX, { Authorization: `Bearer ${again.key}` })).json

    expect(refused.error).toBe('scope_missing')
    expect(refused.hint).toContain('reconnected')
    // Reading and sending are unaffected by that refusal.
    expect((await call(again.port, { action: 'agenda' }, { Authorization: `Bearer ${again.key}` })).json.events).toEqual([])
  })

  it('answers read_message in the assistant\'s terms, with the truncation it was given', async () => {
    const data = { id: 'm1', threadId: 't1', headers: [{ name: 'X', value: 'y' }], subject: 'Invoice', text: 'abc', textLength: 9, truncated: true, nextOffset: 3, attachments: [{ attachmentId: 'A', filename: 'f.pdf', mimeType: 'application/pdf', size: 3 }] }
    const connections = executor({ toolRead: async () => ({ ok: true as const, value: { kind: 'email', results: [{ sourceId: 's:mail', provider: 'google', label: 'minh@example.com', account: undefined, data: { ...data, provider: 'x' } }], failures: [], partial: false } }) })
    const { port, key } = await broker({ connections })
    const answer = (await call(port, { action: 'read_message', sourceId: 's:mail', messageId: 'm1' }, { Authorization: `Bearer ${key}` })).json

    expect(answer).toMatchObject({ account: 'minh@example.com', id: 'm1', truncated: true, nextOffset: 3, attachments: [expect.objectContaining({ attachmentId: 'A' })] })
    expect(answer.provider).toBeUndefined()
  })

  it('serves an attachment as raw bytes on its own route, never inside JSON', async () => {
    const connections = executor()
    const { port, key } = await broker({ connections })
    const auth = { Authorization: `Bearer ${key}` }
    const request = { action: 'download_attachment', sourceId: 's:mail', messageId: 'm1', attachmentId: 'ATT-1' }

    const raw = await callRaw(port, '/v1/google/attachment', request, auth)

    expect(raw.status).toBe(200)
    expect(raw.type).toBe('application/octet-stream')
    expect(raw.bytes.toString()).toBe('%PDF-1.4 canary')
    expect(decodeURIComponent(raw.headers['x-atum-filename'])).toBe('invoice.pdf')
    expect(decodeURIComponent(raw.headers['x-atum-mime-type'])).toBe('application/pdf')
    expect(connections.toolAttachment).toHaveBeenCalledWith(request, expect.anything())

    // The JSON route and the raw route each refuse the other's actions.
    expect((await call(port, request, auth)).json.error).toBe('invalid_input')
    expect((await callRaw(port, '/v1/google/attachment', { action: 'agenda' }, auth)).bytes.toString()).toContain('invalid_input')
  })

  it('answers an attachment refusal as the typed JSON the tool understands', async () => {
    const connections = executor({ toolAttachment: async () => ({ ok: false as const, error: 'too_large' }) })
    const { port, key } = await broker({ connections })
    const raw = await callRaw(port, '/v1/google/attachment', { action: 'download_attachment', sourceId: 's:mail', messageId: 'm1', attachmentId: 'BIG' }, { Authorization: `Bearer ${key}` })

    expect(raw.type).toContain('application/json')
    expect(JSON.parse(raw.bytes.toString())).toMatchObject({ error: 'too_large' })
  })

  it('shows whether the grant can manage mail in status, so the assistant knows before it tries', async () => {
    const withManage: UtilityStatus = { ...STATUS, sources: STATUS.sources.map(source => (source.kind === 'email' ? { ...source, manageable: true } : source)) }
    const connections = executor({ toolStatus: async () => ({ ok: true as const, value: withManage }) })
    const { port, key } = await broker({ connections })
    const plain = await broker({})

    expect((await call(port, { action: 'status' }, { Authorization: `Bearer ${key}` })).json.accounts[0].manage).toBe(true)
    expect((await call(plain.port, { action: 'status' }, { Authorization: `Bearer ${plain.key}` })).json.accounts[0].manage).toBe(false)
  })
})

describe('the real Google policy composed with the real broker', () => {
  it('gives a person-brought model the unfenced full-power broker and keeps every protected-path side effect out', async () => {
    const { connections, google, items, servesProtected, store, tools } = await composedBroker({
      fullPower: true,
      ownModel: true,
      proxy: undefined,
      served: false
    })

    expect(google.wantsBroker()).toBe(true)
    expect(google.view()).toEqual({ state: 'connect' })

    const launch = await google.launch('agent')
    expect(launch).toMatchObject({ tools: true, fence: false })
    expect(Object.keys(launch.env).sort()).toEqual(['ATUM_GOOGLE_TOOLS_TOKEN', 'ATUM_GOOGLE_TOOLS_URL'])
    expect(launch.env.ATUM_GOOGLE_TOOLS_URL).toBe(tools.url)
    expect(launch.env.ATUM_GOOGLE_TOOLS_TOKEN).toMatch(/^[a-f0-9]{64}$/)
    expect(google.wantsTools()).toBe(launch.tools)

    const key = launch.env.ATUM_GOOGLE_TOOLS_TOKEN

    if (!key) {
      throw new Error('full-power launch did not mint a Google broker key')
    }

    const port = Number(new URL(tools.url).port)
    const auth = { Authorization: `Bearer ${key}` }
    const agenda = await call(port, { action: 'agenda' }, auth)

    expect(agenda).toMatchObject({ status: 200, json: { events: [] } })
    expect(connections.toolRead).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'calendar', action: 'events' })
    )

    const send = await call(
      port,
      { action: 'send_email', sourceId: 's:mail', to: ['lan@example.com'], subject: 'Hi', body: 'Hello' },
      auth
    )

    expect(send).toMatchObject({ status: 200, json: { done: true, action: 'send_email' } })
    expect(connections.toolWrite).toHaveBeenCalledTimes(1)
    expect(connections.toolWrite.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ action: 'send-email', sourceId: 's:mail', to: ['lan@example.com'] })
    )

    const adapterCalls = {
      read: connections.toolRead.mock.calls.length,
      status: connections.toolStatus.mock.calls.length,
      write: connections.toolWrite.mock.calls.length
    }

    // The person's other agents get the same capability under their own keys; app and human hosts never do.
    const alfred = tools.mint('agent:alfred')
    const app = tools.mint('app:demoza')
    const human = tools.mint('human')

    expect((await call(port, { action: 'status' }, { Authorization: `Bearer ${alfred}` })).json).toMatchObject({ accounts: expect.any(Array) })

    for (const refused of [app, human]) {
      expect((await call(port, { action: 'status' }, { Authorization: `Bearer ${refused}` })).json.error).toBe('not_available')
    }

    expect(connections.toolRead.mock.calls.length).toBe(adapterCalls.read)
    expect(connections.toolWrite.mock.calls.length).toBe(adapterCalls.write)
    // A relaunch of one agent revokes only that agent's key.
    tools.revoke('agent:alfred')
    expect((await call(port, { action: 'status' }, { Authorization: `Bearer ${alfred}` })).status).toBe(401)
    expect((await call(port, { action: 'status' }, auth)).status).toBe(200)
    tools.mint('agent')
    expect(store.setItems).not.toHaveBeenCalled()
    expect(items.size).toBe(0)
    expect(servesProtected).not.toHaveBeenCalled()
    expect(google.route('agent')).toBe('open')
    expect(google.marks('agent')).toBe(false)

    const relaunched = await google.launch('agent')
    const freshKey = relaunched.env.ATUM_GOOGLE_TOOLS_TOKEN

    if (!freshKey) {
      throw new Error('full-power relaunch did not mint a Google broker key')
    }

    expect((await call(port, { action: 'status' }, auth)).status).toBe(401)
    expect((await call(port, { action: 'status' }, { Authorization: `Bearer ${freshKey}` }))).toMatchObject({
      status: 200,
      json: expect.not.objectContaining({ error: expect.anything() })
    })
  })

  it('keeps the protected OFF path fenced and latches before the real broker reaches the adapter', async () => {
    const services: MatrixGoogleServices = { gmail: true, send: true, calendar: false, drive: false }
    const { google, items, store, tools } = await composedBroker({ fullPower: false, services })

    const launch = await google.launch('agent')
    expect(launch).toMatchObject({ tools: true, fence: true })
    expect(launch.env).toMatchObject({
      ATUM_GOOGLE_FENCE_ROUTE: 'http://127.0.0.1:43123/v1',
      ATUM_GOOGLE_TOOLS_URL: tools.url,
      ATUM_GOOGLE_TOOLS_TOKEN: expect.stringMatching(/^[a-f0-9]{64}$/)
    })

    const key = launch.env.ATUM_GOOGLE_TOOLS_TOKEN

    if (!key) {
      throw new Error('protected launch did not mint a Google broker key')
    }

    const answer = await call(Number(new URL(tools.url).port), { action: 'status' }, { Authorization: `Bearer ${key}` })

    expect(answer).toMatchObject({ status: 200 })
    expect(store.setItems).toHaveBeenCalledTimes(1)
    expect([...items.keys()].sort()).toEqual([
      'matrix-google-agent-latch:agent-principal-1',
      'matrix-google-latch:exec-1'
    ])
    expect(google.route('agent')).toBe('protected')
    expect(google.marks('agent')).toBe(true)
  })
})
