/**
 * Test support only: a `fetch`-shaped handler (the fake Shell, the fake object store) served on a real loopback socket.
 *
 * The in-memory tests call the handler directly. What only a real socket shows is what Node's fetch actually puts on the
 * wire (a body's `Content-Length`, a chunk's exact size, whether a redirect is followed, which headers leave), so the
 * HTTP tests put the same handlers behind `http.createServer` and let the client talk to them for real. A handler that
 * throws a `TypeError` (the fake store's way to say "the connection died") has its socket destroyed.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ServedFetch {
  /** `http://127.0.0.1:PORT`. */
  origin: string
  /** Every request that reached the socket, in order. */
  seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; bytes: number }>
  close(): Promise<void>
}

export async function serveFetch(handler: (request: Request) => Promise<Response>): Promise<ServedFetch> {
  const seen: ServedFetch['seen'] = []

  const server = http.createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', chunk => chunks.push(chunk as Buffer))
    incoming.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks)
        const method = incoming.method ?? 'GET'
        seen.push({ method, url: incoming.url ?? '', headers: incoming.headers, bytes: body.length })

        const headers = new Headers()

        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined && name !== 'host') {
            headers.set(name, Array.isArray(value) ? value.join(', ') : value)
          }
        }

        const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
          method,
          headers,
          ...(body.length > 0 && method !== 'GET' && method !== 'HEAD' ? { body: new Uint8Array(body) } : {})
        })

        try {
          const response = await handler(request)
          outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()))
          outgoing.end(Buffer.from(await response.arrayBuffer()))
        } catch {
          // The connection dies: the client sees a network failure, not an answer.
          incoming.socket.destroy()
        }
      })()
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
