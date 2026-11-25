import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { removeDurably, writeFileDurably } from '../session/files'

// These are Shell routes. Shell decides which data and tools the account can access.
const SHELL_SERVERS = new Map([
  ['atum-google', '/api/mcp/google'],
  ['atum-owner-chats', '/api/mcp/owner-chats']
])
const MAX_BODY_BYTES = 4_000_000
const MCP_HEADERS = ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id'] as const

interface ShellMcpOptions {
  userdata: string
  resource: string
  current(): boolean
  matrixToken(): string
  refreshMatrixToken(refused: string): Promise<string>
  signal: AbortSignal
  fetch?: typeof fetch
}

/**
 * Work gets a revocable localhost credential. The Matrix token stays in Desktop main,
 * so live sessions use rotated tokens without restarting or serializing them into provider config.
 */
export async function startShellMcp(options: ShellMcpOptions): Promise<() => void> {
  const configPath = join(options.userdata, 'managed-mcp-servers.json')
  const shell = new URL(options.resource)
  const authorizationHeader = `Bearer ${randomBytes(32).toString('base64url')}`
  const secret = Buffer.from(authorizationHeader)
  const lifetime = new AbortController()
  const signal = AbortSignal.any([options.signal, lifetime.signal])
  const fetchShell = options.fetch ?? fetch
  const current = () => !signal.aborted && options.current()

  const server = createServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? '')
    const path = SHELL_SERVERS.get(req.url?.slice(1) ?? '')
    if (!current() || req.headers.origin || !path || auth.length !== secret.length || !timingSafeEqual(auth, secret)) {
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
        headers.set('Authorization', `Bearer ${token}`)
        return fetchShell(new URL(path, shell), { method: 'POST', headers, body, redirect: 'error', signal: requestSignal })
      }

      const token = options.matrixToken()
      let response = await send(token)
      if (response.status === 401 && current() && !requestSignal.aborted) {
        await response.body?.cancel()
        response = await send(await options.refreshMatrixToken(token))
      }

      requestSignal.throwIfAborted()
      if (!current()) {throw new Error('work_account_changed')}
      res.statusCode = response.status
      for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'retry-after']) {
        const value = response.headers.get(name)
        if (value) {res.setHeader(name, value)}
      }
      res.setHeader('cache-control', 'no-store')
      if (response.body) {await pipeline(response.body, res, { signal: requestSignal })}
      else {res.end()}
    } catch {
      if (res.headersSent || !current()) {res.destroy()}
      else {res.writeHead(502).end()}
    }
  })
  server.requestTimeout = 55_000
  server.headersTimeout = 10_000

  const close = () => {
    if (lifetime.signal.aborted) {return}
    lifetime.abort()
    options.signal.removeEventListener('abort', close)
    server.close()
    server.closeAllConnections()
    try {removeDurably(configPath)} catch { /* The local credential stopped working when the listener closed. */ }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!current() || !address || typeof address === 'string') {throw new Error('work_mcp_unavailable')}

    writeFileDurably(configPath, JSON.stringify(Array.from(SHELL_SERVERS.keys(), name => ({
      name, url: `http://127.0.0.1:${address.port}/${name}`, authorizationHeader
    }))))
    options.signal.addEventListener('abort', close, { once: true })
    return close
  } catch (error) {
    close()
    throw error
  }
}
