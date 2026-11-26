import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'

// These are Shell routes. Shell decides which data and tools the account can access.
const SHELL_SERVERS = new Map([
  ['/mcp/google', '/api/mcp/google'],
  ['/mcp/owner-chats', '/api/mcp/owner-chats']
])

const MAX_BODY_BYTES = 4_000_000
const MCP_HEADERS = ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id'] as const

export interface ShellMcpOptions {
  resource: string
  current(): boolean
  matrixToken(): string
  refreshMatrixToken(refused: string): Promise<string>
  signal: AbortSignal
  fetch?: typeof fetch
}

export function shellMcpPath(url: string | undefined): string | undefined {
  return SHELL_SERVERS.get(url ?? '')
}

export async function forwardShellMcp(
  options: ShellMcpOptions,
  path: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const signal = options.signal
  const current = () => !signal.aborted && options.current()

  if (!current()) {
    res.writeHead(404).end()

    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end()

    return
  }

  const client = new AbortController()
  res.once('close', () => client.abort())
  const requestSignal = AbortSignal.any([signal, client.signal])
  const headers = new Headers()

  for (const name of MCP_HEADERS) {
    const value = req.headers[name]

    if (typeof value === 'string') {headers.set(name, value)}
  }

  try {
    const chunks: Buffer[] = []
    let bytes = 0

    for await (const chunk of req) {
      const data = Buffer.from(chunk)
      bytes += data.length

      if (bytes > MAX_BODY_BYTES) {
        res.writeHead(413).end()

        return
      }

      chunks.push(data)
    }

    const body = Buffer.concat(chunks)

    const send = (token: string) => {
      if (!current()) {throw new Error('work_account_changed')}
      requestSignal.throwIfAborted()
      const authorizedHeaders = new Headers(headers)
      authorizedHeaders.set('Authorization', `Bearer ${token}`)

      return (options.fetch ?? fetch)(new URL(path, options.resource), {
        method: 'POST', headers: authorizedHeaders, body, redirect: 'error', signal: requestSignal
      })
    }

    const token = options.matrixToken()
    let response = await send(token)

    if (response.status === 401 && current() && !requestSignal.aborted) {
      await response.body?.cancel()

      if (!current()) {throw new Error('work_account_changed')}
      response = await send(await options.refreshMatrixToken(token))
    }

    requestSignal.throwIfAborted()

    if (!current()) {throw new Error('work_account_changed')}
    res.statusCode = response.status

    for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'retry-after']) {
      const value = response.headers.get(name)

      if (value) {res.setHeader(name, value)}
    }

    if (response.body) {await pipeline(response.body, res, { signal: requestSignal })}
    else {res.end()}
  } catch {
    if (res.headersSent || !current()) {res.destroy()}
    else {res.writeHead(502).end()}
  }
}
