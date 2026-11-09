import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { UtilitySource, UtilityStatus } from '../../shared/atum-utilities'
import { GMAIL_MAIL_HINTS } from '../../shared/gmail-mail'
import {
  type MatrixGoogleToolRequest,
  parseMatrixGoogleToolRequest,
  type MatrixGoogleAgendaWhen as When
} from '../../shared/matrix-google-tool-request'
import {
  MATRIX_GOOGLE_ATTACHMENT_PATH,
  MATRIX_GOOGLE_COMPOSE_REQUEST_MAX_BYTES,
  MATRIX_GOOGLE_MAILBOX_ACTIONS,
  MATRIX_GOOGLE_WRITE_ACTIONS,
  type MatrixGoogleToolAction
} from '../../shared/matrix-google-tools'

export { type MatrixGoogleToolRequest, parseMatrixGoogleToolRequest } from '../../shared/matrix-google-tool-request'

import type { MatrixGoogleToolOutcome } from './google-connections'

/** Every action is small except an outgoing message with attachments (base64 in the closed grammar). */
const MAX_REQUEST_BYTES = MATRIX_GOOGLE_COMPOSE_REQUEST_MAX_BYTES
/** What one answer may put in the assistant's context, in UTF-8 bytes (below the tool's own
 * 256 KiB read limit, so a Vietnamese thread is judged the same on both sides); a larger
 * one asks it to narrow. */
const MAX_RESPONSE_BYTES = 240 * 1024
const MAX_NOTE_CHARS = 500
const BUSY_RETRY_MS = 400
const BUSY_WAIT_MS = 8_000

/** Main's policy for one call, decided when it arrives (`fence`: the protected-path latch
 * couldn't be saved, so nothing is read; full power returns `ok` without that path). */
export type MatrixGoogleToolsGate = 'ok' | 'not_available' | 'protected_route_unavailable' | 'fence'

/** The adapter calls the broker uses (MatrixGoogleConnections). */
export interface MatrixGoogleToolsExecutor {
  toolRead(input: Record<string, unknown>): Promise<MatrixGoogleToolOutcome<unknown>>
  toolWrite(input: Record<string, unknown>, signal?: AbortSignal): Promise<MatrixGoogleToolOutcome<unknown>>
  toolStatus(): Promise<MatrixGoogleToolOutcome<UtilityStatus>>
  /** Reversible mailbox changes (labels, archive, read/star, trash, drafts): no owner dialog. */
  toolMailbox(input: Record<string, unknown>, signal?: AbortSignal): Promise<MatrixGoogleToolOutcome<unknown>>
  /** One attachment's bytes, for the raw route only. */
  toolAttachment(
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<MatrixGoogleToolOutcome<{ filename: string; mimeType: string; bytes: Buffer }>>
}

export interface MatrixGoogleToolsOptions {
  /** Main's policy gate for this call: the calling agent and its active Google mode. */
  gate(role: string): MatrixGoogleToolsGate
  connections(): MatrixGoogleToolsExecutor | undefined
  /** Payload-free diagnostics: the action and a closed code, never content. */
  log?(line: string): void
  now?(): Date
  /** Fixed loopback port; 0 picks one. */
  port?: number
}

/** Local days on this Mac: the named window, as calendar-read bounds. */
export function matrixGoogleAgendaRange(when: When, now: Date): { start: string; end: string } {
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  const bounds: Record<When, [number, number]> = {
    today: [0, 1],
    tomorrow: [1, 2],
    today_and_tomorrow: [0, 2],
    next_7d: [0, 7],
    past_30d: [-30, 1],
    past_365d: [-365, 1]
  }
  const [from, to] = bounds[when]

  return { start: day(from).toISOString(), end: day(to).toISOString() }
}

/** The utility input for a request: one read, one write, or the saved status. */
export function matrixGoogleUtilityInput(
  request: MatrixGoogleToolRequest,
  now: Date,
  uuid: () => string = randomUUID
):
  | { read: Record<string, unknown> }
  | { write: Record<string, unknown> }
  | { mailbox: Record<string, unknown> }
  | { attachment: Record<string, unknown> }
  | { status: true } {
  switch (request.action) {
    case 'status':
      return { status: true }

    case 'agenda':
      return {
        read: {
          kind: 'calendar',
          action: 'events',
          ...matrixGoogleAgendaRange(request.when, now),
          ...(request.when === 'past_30d' || request.when === 'past_365d' ? { limit: 250 } : {})
        }
      }

    case 'waiting':
      return { read: { kind: 'email', action: 'waiting' } }

    case 'search_mail':
      return {
        read: {
          kind: 'email',
          action: 'inbox',
          query: request.query,
          ...(request.sourceId ? { sources: [request.sourceId] } : {}),
          ...(request.pageToken ? { pageToken: request.pageToken } : {})
        }
      }

    case 'read_thread':
      return { read: { kind: 'email', action: 'thread', sources: [request.sourceId], id: request.threadId } }

    case 'read_message':
      return {
        read: {
          kind: 'email', action: 'message', sources: [request.sourceId], id: request.messageId,
          ...(request.offset ? { offset: request.offset } : {})
        }
      }

    case 'list_labels':
      return { read: { kind: 'email', action: 'labels', sources: [request.sourceId] } }

    case 'list_drafts':
      return {
        read: {
          kind: 'email', action: 'drafts', sources: [request.sourceId],
          ...(request.pageToken ? { pageToken: request.pageToken } : {})
        }
      }

    case 'download_attachment':
      return { attachment: { ...request } }

    case 'mailbox':
    case 'create_label':
    case 'create_draft':
    case 'update_draft':
      return { mailbox: { ...request } }

    case 'search_drive':
      return {
        read: {
          kind: 'drive',
          action: 'files',
          ...(request.query ? { query: request.query } : {}),
          ...(request.sort ? { sort: request.sort } : {}),
          ...(request.modifiedAfter ? { modifiedAfter: request.modifiedAfter } : {})
        }
      }

    case 'read_file':
      return { read: { kind: 'drive', action: 'file', sources: [request.sourceId], id: request.fileId } }

    case 'send_email':
      return {
        write: {
          action: 'send-email',
          operationId: request.operationId ?? uuid(),
          sourceId: request.sourceId,
          to: request.to,
          subject: request.subject,
          body: request.body,
          ...(request.cc ? { cc: request.cc } : {}),
          ...(request.bcc ? { bcc: request.bcc } : {}),
          ...(request.reply ? { reply: request.reply } : {}),
          ...(request.forward ? { forward: request.forward } : {}),
          ...(request.attachments ? { attachments: request.attachments } : {}),
          ...(request.threadId ? { threadId: request.threadId } : {}),
          ...(request.inReplyTo ? { inReplyTo: request.inReplyTo } : {})
        }
      }

    case 'create_event':

    case 'update_event':
      return {
        write: {
          action: request.action === 'create_event' ? 'create-event' : 'update-event',
          operationId: request.operationId ?? uuid(),
          sourceId: request.sourceId,
          ...(request.eventId ? { id: request.eventId } : {}),
          title: request.title,
          start: request.start,
          end: request.end,
          ...(request.location !== undefined ? { location: request.location } : {}),
          ...(request.description !== undefined ? { description: request.description } : {})
        }
      }
  }
}

/** One line per refusal for the assistant to act on; it tells the owner in its own words. */
const HINTS: Partial<Record<string, string>> = {
  not_connected:
    'Google is not connected. Mention once that the owner can connect it in Settings › Account › Google, then carry on without it.',
  not_allowed:
    'The owner chose not to share this with Atum. Say so once, carry on without it, and do not ask again in this conversation.',
  calendar_selection_required: 'The owner needs to choose their calendars again in Settings › Account › Google.',
  reconnect: 'Google needs the owner to reconnect this account in Settings › Account › Google.',
  denied: 'Google refused this for that account, or the owner turned this mailbox off in Settings.',
  scope_missing: GMAIL_MAIL_HINTS.scope_missing,
  label_not_found: GMAIL_MAIL_HINTS.label_not_found,
  not_found: GMAIL_MAIL_HINTS.not_found,
  message_too_large: GMAIL_MAIL_HINTS.message_too_large,
  response_invalid: 'Google sent an answer Atum could not use. Try again in a moment.',
  cancelled: 'The owner did not confirm. Nothing was sent or changed.',
  outcome_unknown:
    'It may already have happened. Do not try again; ask the owner to check Gmail or Calendar before doing anything else.',
  conflict: 'It changed since it was read. Read it again, then ask the owner to confirm the new version.',
  unsupported: 'Atum can only change personal timed events without guests or repeats.',
  invalid_input: 'A value was not accepted. Check the IDs from an earlier result, the dates (with a time zone) and, for mail, the addresses (plain name@example.com, at most 20 per list and 50 in all, at least one on a send) and the one-line subject.',
  busy: 'Google is busy with another request on this Mac. Try once more.',
  fence: 'Atum could not secure the Google connection right now. Try again shortly.',
  protected_route_unavailable:
    'Atum’s protected model is not available, so Google stays off. Tell the owner Google will work again when it is back.',
  not_available: 'Google is not available to this assistant.',
  too_large: 'That answer is too long. Narrow the search or read one item. (An attachment over 10 MB is not handed over: name it to the owner so they can open it in Gmail.)',
  network: 'Google could not be reached. Try again in a moment.',
  timeout: 'Google took too long to answer. Try again in a moment.',
  unavailable: 'Google is not set up in this build of Atum.',
  storage: 'Atum could not read its saved Google connection on this Mac.',
  account_changed: 'The Atum account changed. Nothing was done.'
}

function refusal(code: string, extra: Record<string, unknown> = {}) {
  return { error: code, ...(HINTS[code] ? { hint: HINTS[code] } : {}), ...extra }
}

interface Provenance {
  sourceId?: string
  label?: string
  account?: string
}

function grouped(sources: readonly UtilitySource[]) {
  const accounts = new Map<string, UtilitySource[]>()

  for (const source of sources) {
    if (source.provider !== 'google' || !source.accountKey) {
      continue
    }

    accounts.set(source.accountKey, [...(accounts.get(source.accountKey) ?? []), source])
  }

  return [...accounts.values()].map(group => {
    const named = group.find(source => source.kind !== 'calendar') ?? group[0]
    const account = named.kind === 'calendar' ? (named.detail ?? named.label) : named.label

    return {
      account,
      gmail: group.some(source => source.kind === 'email'),
      send: group.some(source => source.kind === 'email' && source.writable === true),
      // Labels, archive, read/star, trash and drafts: false means those actions answer scope_missing.
      manage: group.some(source => source.kind === 'email' && source.manageable === true),
      calendar: group.some(source => source.kind === 'calendar'),
      drive: group.some(source => source.kind === 'drive'),
      sources: group.map(source => ({
        sourceId: source.id,
        kind: source.kind,
        label: source.label,
        enabled: source.enabled,
        ...(source.state === 'reconnect' ? { needsReconnect: true } : {}),
        ...(source.kind === 'calendar' ? { writable: source.writable === true } : {})
      }))
    }
  })
}

const failuresOf = (value: Record<string, unknown>) =>
  (Array.isArray(value.failures) ? value.failures : []).map((failure: Provenance & { error?: unknown }) => ({
    source: failure.label,
    account: failure.account,
    error: failure.error
  }))

function when(value: unknown): { at?: string; allDay?: true } {
  const row = value as { dateTime?: unknown; date?: unknown } | undefined

  if (typeof row?.dateTime === 'string') {
    return { at: row.dateTime }
  }

  return typeof row?.date === 'string' ? { at: row.date, allDay: true } : {}
}

/** The result in the assistant's terms: who and where each item came from, the IDs a
 * follow-up needs, and nothing else. */
export function matrixGoogleToolResult(request: MatrixGoogleToolRequest, value: unknown, status?: UtilityStatus): unknown {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>

  if (row.error === 'connection_required') {
    const kind = row.kind
    const connected = (status?.sources ?? []).some(source => source.provider === 'google' && source.accountKey)

    return refusal(connected ? 'not_allowed' : 'not_connected', { service: kind === 'email' ? 'gmail' : kind })
  }

  if (row.error === 'calendar_selection_required') {
    return refusal('calendar_selection_required')
  }

  const results = (Array.isArray(row.results) ? row.results : []) as Array<Provenance & { data?: Record<string, any> }>

  const common = {
    ...(row.partial ? { partial: true, failures: failuresOf(row) } : {}),
    ...(row.truncated ? { truncated: true } : {})
  }

  switch (request.action) {
    case 'agenda': {
      const events = results.flatMap(result =>
        (Array.isArray(result.data?.events) ? result.data!.events : []).map((event: Record<string, any>) => {
          const start = when(event.start)

          return {
            title: event.title ?? '',
            start: start.at,
            end: when(event.end).at,
            ...(start.allDay ? { allDay: true } : {}),
            ...(event.location ? { location: String(event.location).slice(0, 300) } : {}),
            ...(event.description ? { notes: String(event.description).slice(0, MAX_NOTE_CHARS) } : {}),
            calendar: result.label,
            account: result.account,
            sourceId: result.sourceId,
            eventId: event.id
          }
        })
      )

      events.sort((left, right) => String(left.start ?? '').localeCompare(String(right.start ?? '')))

      return {
        when: request.when,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        events,
        ...(row.overlap ? { overlap: true } : {}),
        ...common
      }
    }

    case 'waiting':
      return {
        threads: results.flatMap(result =>
          (Array.isArray(result.data?.threads) ? result.data!.threads : []).map((thread: Record<string, any>) => ({
            account: result.label,
            sourceId: result.sourceId,
            threadId: thread.id,
            subject: thread.subject,
            from: thread.from,
            waitingSince: thread.waitingSince,
            snippet: thread.snippet,
            messages: thread.messageCount
          }))
        ),
        ...common
      }

    case 'search_mail': {
      // Gmail pages one mailbox at a time: each mailbox with more results names its own cursor.
      const nextPages = results.flatMap(result =>
        typeof result.data?.nextPageToken === 'string' && result.sourceId
          ? [{ sourceId: result.sourceId, pageToken: result.data.nextPageToken }]
          : []
      )

      return {
        messages: results.flatMap(result =>
          (Array.isArray(result.data?.messages) ? result.data!.messages : []).map((message: Record<string, any>) => {
            const headers = Object.fromEntries(
              (Array.isArray(message.headers) ? message.headers : []).map((header: { name?: unknown; value?: unknown }) => [
                String(header.name).toLowerCase(),
                header.value
              ])
            )

            return {
              account: result.label,
              sourceId: result.sourceId,
              messageId: message.id,
              ...(message.threadId ? { threadId: message.threadId } : {}),
              from: headers.from,
              to: headers.to,
              subject: headers.subject,
              date: headers.date,
              snippet: message.snippet
            }
          })
        ),
        ...(nextPages.length ? { nextPages } : {}),
        ...common
      }
    }

    case 'read_thread': {
      const thread = results[0]?.data ?? {}

      return {
        account: results[0]?.label,
        sourceId: results[0]?.sourceId,
        threadId: thread.id,
        subject: thread.subject,
        messages: thread.messages ?? [],
        reply: thread.reply,
        ...(thread.more ? { more: true } : {}),
        // Never silent: older messages and cut bodies are named, with how to read them.
        ...(thread.truncated ? { truncated: true, olderMessages: thread.olderMessages, hint: thread.hint } : {}),
        ...common
      }
    }

    case 'read_message': {
      const { provider: _provider, label: _label, account: _account, ...message } = (results[0]?.data ?? {}) as Record<string, any>

      return { account: results[0]?.label, ...message, ...common }
    }

    case 'list_labels':
      return { account: results[0]?.label, sourceId: results[0]?.sourceId, labels: results[0]?.data?.labels ?? [], ...common }

    case 'list_drafts':
      return {
        account: results[0]?.label,
        sourceId: results[0]?.sourceId,
        drafts: results[0]?.data?.drafts ?? [],
        ...(typeof results[0]?.data?.nextPageToken === 'string'
          ? { nextPages: [{ sourceId: results[0]!.sourceId, pageToken: results[0]!.data!.nextPageToken }] } : {}),
        ...common
      }

    case 'mailbox':
    case 'create_label':
    case 'create_draft':
    case 'update_draft':
      // The shared adapters' receipt: ids, label names, and `sent: false` for drafts.
      return row

    case 'search_drive':
      return {
        files: results.flatMap(result =>
          (Array.isArray(result.data?.files) ? result.data!.files : []).map((file: Record<string, any>) => ({
            account: result.label,
            sourceId: result.sourceId,
            fileId: file.id,
            name: file.name,
            type: file.mimeType,
            modified: file.modifiedTime,
            ...(file.viewedByMeTime ? { viewed: file.viewedByMeTime } : {})
          }))
        ),
        ...common
      }
    case 'read_file': {
      const data = results[0]?.data ?? {}
      const file = data.file ?? {}

      return {
        account: results[0]?.label,
        sourceId: results[0]?.sourceId,
        file: { fileId: file.id, name: file.name, type: file.mimeType, modified: file.modifiedTime },
        ...(typeof data.text === 'string' ? { text: data.text } : {}),
        ...(data.contentUnavailable ? { contentUnavailable: data.contentUnavailable } : {}),
        ...(data.contentNote ? { contentNote: data.contentNote } : {}),
        ...(data.more ? { more: true } : {}),
        ...common
      }
    }

    default: {
      const receipt = row as { id?: unknown; operationId?: unknown; replay?: unknown }

      return {
        done: true,
        action: request.action,
        id: receipt.id,
        operationId: receipt.operationId,
        ...(receipt.replay ? { alreadyDone: true } : {})
      }
    }
  }
}

/**
 * The assistant's way to Google (G2-08), behind the Google fence (G2-19). A loopback
 * server only the default assistant's Hermes holds a key for: main mints one per launch and
 * passes it in that process's environment alone. Every call is checked against main's
 * fence first (the calling agent, its model, the protected route), then runs through the
 * connection adapter under the owner's fence. Writes wait for the owner's native
 * confirmation of the exact content. Requests and answers are never logged; only the action
 * and a closed outcome code are.
 */
export class MatrixGoogleTools {
  private server: Server | undefined
  private port: number
  private readonly keys = new Map<string, string>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: MatrixGoogleToolsOptions) {
    this.port = options.port ?? 0
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get running(): boolean {
    return Boolean(this.server)
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }

    const server = createServer((request, response) => void this.handle(request, response))
    const listening = once(server, 'listening')
    server.listen(this.port, '127.0.0.1')
    await Promise.race([listening, once(server, 'error').then(([error]) => Promise.reject(error))])
    this.port = (server.address() as AddressInfo).port
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.keys.clear()

    if (server) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  /** A fresh key for one launch of an agent's Hermes; the previous one stops working. */
  mint(role: string): string {
    this.revoke(role)
    const key = randomBytes(32).toString('hex')
    this.keys.set(role, key)

    return key
  }

  revoke(role: string): void {
    this.keys.delete(role)
  }

  private roleOf(supplied: string): string | undefined {
    let role: string | undefined

    // Every key is compared in full, so the time taken never tells which one matched.
    for (const [owner, key] of this.keys) {
      if (supplied.length === key.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(key))) {
        role ??= owner
      }
    }

    return role
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, value: unknown) => {
      if (!response.headersSent) {
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      }

      response.end(JSON.stringify(value))
    }

    // Browsers cannot use this: no CORS answers, an exact Host (no DNS rebinding), a key.
    if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${this.port}`) {
      return reply(403, refusal('not_available'))
    }

    const role = this.roleOf(/^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '')

    if (role === undefined) {
      return reply(401, refusal('not_available'))
    }

    const path = (request.url ?? '').split('?')[0]

    if (request.method !== 'POST' || (path !== '/v1/google' && path !== MATRIX_GOOGLE_ATTACHMENT_PATH)) {
      return reply(404, refusal('not_available'))
    }

    // Attachment bytes have their own route; every other action stays JSON on /v1/google.
    const rawRoute = path === MATRIX_GOOGLE_ATTACHMENT_PATH

    const raw = await readBody(request, MAX_REQUEST_BYTES)
    let parsed: unknown

    try {
      parsed = raw ? JSON.parse(raw.toString('utf8')) : undefined
    } catch {
      parsed = undefined
    }

    const call = parseMatrixGoogleToolRequest(parsed)

    if (!call || (call.action === 'download_attachment') !== rawRoute) {
      return reply(200, refusal('invalid_input'))
    }

    // Main's policy first: nothing from Google is read unless the active mode admits this role.
    let gate: MatrixGoogleToolsGate = 'not_available'

    try {
      gate = this.options.gate(role)
    } catch {
      gate = 'not_available'
    }

    if (gate !== 'ok') {
      this.log(call.action, gate)

      return reply(200, refusal(gate))
    }

    const abort = new AbortController()
    response.on('close', () => abort.abort())

    if (rawRoute) {
      const run = this.queue.then(() => this.executeAttachment(call, abort.signal))
      this.queue = run.catch(() => {})
      const outcome = await run.catch(() => ({ refused: refusal('network') }))

      if ('refused' in outcome) {
        this.log(call.action, String((outcome.refused as { error?: unknown }).error ?? 'ok'))

        return reply(200, outcome.refused)
      }

      this.log(call.action, 'ok')
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': String(outcome.file.bytes.length),
        'X-Atum-Filename': encodeURIComponent(outcome.file.filename),
        'X-Atum-Mime-Type': encodeURIComponent(outcome.file.mimeType)
      })

      return void response.end(outcome.file.bytes)
    }

    // One Google call at a time from this broker, as the adapter itself allows.
    const run = this.queue.then(() => this.execute(call, abort.signal))
    this.queue = run.catch(() => {})
    const answer = await run.catch(() => refusal('network'))
    const body = JSON.stringify(answer)

    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
      this.log(call.action, 'too_large')

      return reply(200, refusal('too_large'))
    }

    this.log(call.action, (answer as { error?: unknown }).error ? String((answer as { error: unknown }).error) : 'ok')
    reply(200, answer)
  }

  /** One attachment's bytes (never JSON); a refusal comes back as the tool's own typed answer. */
  private async executeAttachment(
    call: MatrixGoogleToolRequest,
    signal: AbortSignal
  ): Promise<{ file: { filename: string; mimeType: string; bytes: Buffer } } | { refused: unknown }> {
    const connections = this.options.connections()

    if (!connections) {
      return { refused: refusal('unavailable') }
    }

    const input = matrixGoogleUtilityInput(call, this.options.now?.() ?? new Date())

    if (!('attachment' in input)) {
      return { refused: refusal('invalid_input') }
    }

    const outcome = await this.patiently(() => connections.toolAttachment(input.attachment, signal))

    return 'value' in outcome ? { file: outcome.value } : { refused: refusal(outcome.error) }
  }

  private async execute(call: MatrixGoogleToolRequest, signal: AbortSignal): Promise<unknown> {
    const connections = this.options.connections()

    if (!connections) {
      return refusal('unavailable')
    }

    const input = matrixGoogleUtilityInput(call, this.options.now?.() ?? new Date())

    if ('status' in input) {
      const status = await this.patiently(() => connections.toolStatus())

      return 'value' in status ? { accounts: grouped(status.value.sources) } : refusal(status.error)
    }

    if (('write' in input && !MATRIX_GOOGLE_WRITE_ACTIONS.has(call.action)) ||
        ('mailbox' in input && !MATRIX_GOOGLE_MAILBOX_ACTIONS.has(call.action)) || 'attachment' in input) {
      return refusal('invalid_input')
    }

    // Reversible mailbox changes: no dialog, a typed scope_missing when the grant cannot make them.
    if ('mailbox' in input) {
      const changed = await this.patiently(() => connections.toolMailbox(input.mailbox, signal))

      return 'value' in changed ? matrixGoogleToolResult(call, changed.value) : refusal(changed.error)
    }

    // Sending is its own permission in the one consent: a mailbox without it is the person's
    // choice, not a broken connection, so the owner is never asked to confirm a send that
    // can't happen (and is never told to reconnect).
    if (call.action === 'send_email') {
      const status = await this.patiently(() => connections.toolStatus())

      const mailbox =
        'value' in status
          ? status.value.sources.find(source => source.id === call.sourceId && source.kind === 'email')
          : undefined

      if (mailbox && mailbox.writable !== true) {
        return refusal('not_allowed', { service: 'gmail_send' })
      }
    }

    const outcome = await this.patiently(() =>
      'write' in input ? connections.toolWrite(input.write, signal) : connections.toolRead(input.read)
    )

    if (!('value' in outcome)) {
      // An email or event the owner cannot read in full in the confirmation is refused, not sent partly unseen.
      return 'write' in input && outcome.error === 'invalid_input'
        ? refusal(outcome.error, {
            hint: 'A value was not accepted. If the text is long, keep each text field (body, description, location) under about 4,000 characters and 60 lines, and the whole message or event under about 8,000 characters, with no long runs of blank lines or invisible characters, so the owner can read all of it before it is sent.'
          })
        : refusal(outcome.error)
    }

    // Only a missing service needs the saved status: unticked (not allowed) or never connected.
    const missing = (outcome.value as { error?: unknown } | null)?.error === 'connection_required'
    const status = missing ? await this.patiently(() => connections.toolStatus()) : undefined

    return matrixGoogleToolResult(call, outcome.value, status && 'value' in status ? status.value : undefined)
  }

  /** Settings may be mid-operation on the same adapter: wait briefly instead of failing. */
  private async patiently<T>(work: () => Promise<MatrixGoogleToolOutcome<T>>): Promise<MatrixGoogleToolOutcome<T>> {
    const deadline = Date.now() + BUSY_WAIT_MS

    for (;;) {
      const outcome = await work()

      if ('value' in outcome || outcome.error !== 'busy' || Date.now() >= deadline) {
        return outcome
      }

      await new Promise(resolve => setTimeout(resolve, BUSY_RETRY_MS))
    }
  }

  private log(action: MatrixGoogleToolAction, code: string) {
    this.options.log?.(`[Matrix] google tool ${action} ${/^[a-z_]{1,40}$/.test(code) ? code : 'unclassified'}`)
  }
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    size += (chunk as Buffer).length

    if (size > limit) {
      return undefined
    }

    chunks.push(chunk as Buffer)
  }

  return Buffer.concat(chunks)
}
