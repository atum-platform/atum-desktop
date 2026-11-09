import { once } from 'node:events'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { connect, createServer, type Socket } from 'node:net'

import { afterEach, expect, test, vi } from 'vitest'

import { createConsumerBrowserEgress, type EgressSession } from './egress'

// 2026-11-06 audit lead atum-consumer-browser-unpinned-dns-public-check. A browser tab may visit any public
// host, so the destination list is open, but the address that is dialled must be the one that was vetted.

const PUBLIC = '93.184.216.34'
const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) {
    await close()
  }
})

async function harness(options: Parameters<typeof createConsumerBrowserEgress>[2] = {}) {
  let rules = ''
  let live = true

  const resolveProxy = vi.fn(async (_url: string) => `PROXY ${new URL(rules).host}`)

  const session: EgressSession = {
    setProxy: vi.fn(async config => {
      expect(config.mode).toBe('fixed_servers')
      expect(config.proxyBypassRules).toBe('<-loopback>')
      rules = config.proxyRules
    }),
    closeAllConnections: vi.fn(async () => undefined),
    resolveProxy
  }

  const boundary = createConsumerBrowserEgress(session, () => live, options)
  cleanups.push(boundary.close)
  await boundary.ready
  const port = () => Number(new URL(rules).port)

  const raw = async (request: string) => {
    const client = connect({ host: '127.0.0.1', port: port() })
    cleanups.push(() => {
      client.destroy()
    })
    let data = ''
    client.on('data', bytes => {
      data += bytes.toString()
    })
    client.on('error', () => undefined)
    await once(client, 'connect')
    const closed = new Promise<void>(resolve => client.once('close', () => resolve()))
    client.write(request)

    return { client, closed, data: () => data }
  }

  return { boundary, port, raw, resolveProxy, revoke: () => { live = false }, session }
}

/** A loopback "internet host": what the attacker wants Chromium to reach. */
async function loopbackServer(handler: Parameters<typeof createHttpServer>[1]) {
  const server = createHttpServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  return (server.address() as { port: number }).port
}

test('probes the proxy for both schemes before it is ready', async () => {
  const h = await harness()
  const probed = h.resolveProxy.mock.calls.map(([url]) => url)
  expect(probed.some(url => url.startsWith('https:'))).toBe(true)
  expect(probed.some(url => url.startsWith('http:'))).toBe(true)
})

test.each([
  'CONNECT localhost:443 HTTP/1.1\r\n\r\n',
  'CONNECT 127.0.0.1:8080 HTTP/1.1\r\n\r\n',
  'CONNECT [::1]:443 HTTP/1.1\r\n\r\n',
  'CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n',
  'CONNECT printer.local:443 HTTP/1.1\r\n\r\n',
  'CONNECT user@site.example:443 HTTP/1.1\r\n\r\n',
  'GET http://localhost:8080/ HTTP/1.1\r\nHost: localhost:8080\r\n\r\n',
  'GET http://192.168.1.10/ HTTP/1.1\r\nHost: 192.168.1.10\r\n\r\n',
  'GET http://user:pw@site.example/ HTTP/1.1\r\nHost: site.example\r\n\r\n',
  'GET /relative HTTP/1.1\r\nHost: site.example\r\n\r\n',
  'GET ftp://site.example/ HTTP/1.1\r\nHost: site.example\r\n\r\n'
])('refuses a private, credentialed or malformed target before any DNS: %s', async request => {
  const resolve = vi.fn(async () => [PUBLIC])
  const dial = vi.fn()
  const h = await harness({ resolve, dial })
  const client = await h.raw(request)
  await client.closed
  expect(client.data()).toBe('')
  expect(resolve).not.toHaveBeenCalled()
  expect(dial).not.toHaveBeenCalled()
})

test.each([[['127.0.0.1']], [['::1']], [['192.168.0.9']], [[PUBLIC, '10.0.0.1']], [[]]])(
  'never dials a name whose answer set is not wholly public: %j',
  async answers => {
    const dial = vi.fn()

    for (const request of [
      'CONNECT site.example:443 HTTP/1.1\r\n\r\n',
      'GET http://site.example/ HTTP/1.1\r\nHost: site.example\r\n\r\n'
    ]) {
      const h = await harness({ resolve: async () => answers, dial })
      const client = await h.raw(request)
      await client.closed
      expect(client.data()).toBe('')
    }

    expect(dial).not.toHaveBeenCalled()
  }
)

test('DNS rebinding: the proxy resolves once and dials only the vetted public address, never the second answer', async () => {
  // The attack: a TTL-0 name answers public to the first query and loopback to the next. Chromium used to do
  // the second query itself; here Chromium never resolves, and the one answer the proxy got is the one it dials.
  const answers = [[PUBLIC], ['127.0.0.1'], ['127.0.0.1']]
  const resolve = vi.fn(async () => answers.shift() ?? ['127.0.0.1'])
  const secret = vi.fn()

  const marker = await loopbackServer((_request, response) => {
    secret()
    response.end('LOOPBACK-MARKER')
  })

  const dialed: Array<{ port: number; addresses: readonly string[]; hostname: string }> = []

  const dial = vi.fn((port: number, addresses: readonly string[], hostname: string) => {
    dialed.push({ port, addresses, hostname })

    // The vetted address is not reachable in this offline fixture; connecting to it must not fall back to loopback.
    return connect({ host: '127.0.0.1', port: 1 })
  })

  const h = await harness({ resolve, dial })

  const plain = await h.raw(`GET http://rebind.test:${marker}/marker HTTP/1.1\r\nHost: rebind.test:${marker}\r\n\r\n`)
  await plain.closed
  const tunnel = await h.raw(`CONNECT rebind.test:${marker} HTTP/1.1\r\n\r\n`)
  await tunnel.closed

  expect(dialed).toEqual([{ port: marker, addresses: [PUBLIC], hostname: 'rebind.test' }])
  expect(resolve).toHaveBeenCalledTimes(2)
  expect(secret).not.toHaveBeenCalled()
  expect(plain.data()).not.toContain('LOOPBACK-MARKER')
  expect(tunnel.data()).not.toContain('LOOPBACK-MARKER')
})

test('tunnels CONNECT (https, wss, a custom port) to the vetted address', async () => {
  const peers = new Set<Socket>()

  const echo = createServer(socket => {
    peers.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => peers.delete(socket))
    socket.pipe(socket)
  })

  await new Promise<void>(resolve => echo.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    for (const peer of peers) {
      peer.destroy()
    }

    await new Promise<void>(resolve => echo.close(() => resolve()))
  })

  const dial = vi.fn((port: number, addresses: readonly string[], hostname: string) => {
    expect(port).toBe(8443)
    expect(addresses).toEqual([PUBLIC])
    expect(hostname).toBe('shop.example')

    return connect({ host: '127.0.0.1', port: (echo.address() as { port: number }).port })
  })

  const h = await harness({ resolve: async () => [PUBLIC], dial })
  const client = await h.raw('CONNECT shop.example:8443 HTTP/1.1\r\n\r\nopaque-bytes')
  await vi.waitFor(() => expect(client.data()).toContain('opaque-bytes'))
  expect(client.data()).toContain('200 Connection Established')
  expect(dial).toHaveBeenCalledOnce()
})

test('forwards a plain http request to the vetted address and relays the answer', async () => {
  let seen: { method?: string; url?: string; host?: string; connection?: string; proxyConnection?: string; cookie?: string; body: string } | undefined

  const port = await loopbackServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += chunk
    })
    request.on('end', () => {
      seen = {
        method: request.method,
        url: request.url,
        host: request.headers.host,
        connection: request.headers.connection,
        proxyConnection: request.headers['proxy-connection'] as string | undefined,
        cookie: request.headers.cookie,
        body
      }
      response.writeHead(201, { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'], connection: 'keep-alive' })
      response.end('hello from a public host')
    })
  })

  const dial = vi.fn((dialPort: number, addresses: readonly string[], hostname: string) => {
    expect(dialPort).toBe(80)
    expect(addresses).toEqual([PUBLIC])
    expect(hostname).toBe('news.example')

    return connect({ host: '127.0.0.1', port })
  })

  const h = await harness({ resolve: async () => [PUBLIC], dial })

  const answer = await new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    // How Chromium talks to an HTTP proxy: absolute-URI request line.
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: h.port(),
        method: 'POST',
        path: 'http://news.example/a/b?q=1',
        headers: { host: 'news.example', cookie: 'k=v', 'proxy-connection': 'keep-alive', 'content-type': 'text/plain' }
      },
      response => {
        let body = ''
        response.on('data', chunk => {
          body += chunk
        })
        response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }))
      }
    )

    request.on('error', reject)
    request.end('payload')
  })

  expect(answer.status).toBe(201)
  expect(answer.body).toBe('hello from a public host')
  expect(answer.headers['set-cookie']).toEqual(['a=1', 'b=2'])
  expect(seen).toEqual({
    method: 'POST',
    url: '/a/b?q=1',
    host: 'news.example',
    connection: 'close',
    proxyConnection: undefined,
    cookie: 'k=v',
    body: 'payload'
  })
})

test('a revoked boundary refuses new requests and cuts late DNS', async () => {
  let release!: (value: string[]) => void

  const resolve = vi.fn(
    () =>
      new Promise<string[]>(done => {
        release = done
      })
  )

  const dial = vi.fn()
  const h = await harness({ resolve, dial })
  const client = await h.raw('GET http://site.example/ HTTP/1.1\r\nHost: site.example\r\n\r\n')
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce())
  h.revoke()
  release([PUBLIC])
  await client.closed
  expect(dial).not.toHaveBeenCalled()

  const after = await h.raw('CONNECT site.example:443 HTTP/1.1\r\n\r\n')
  await after.closed
  expect(dial).not.toHaveBeenCalled()
})

// Review r1 of the same audit lead: DNS that finishes after the request ended must not dial.
function deferredDns() {
  let release!: (value: string[]) => void

  const resolve = vi.fn(
    () =>
      new Promise<string[]>(done => {
        release = done
      })
  )

  return { resolve, release: (value: string[]) => release(value) }
}

test('a plain request whose client left while DNS was pending never dials when DNS answers', async () => {
  const dns = deferredDns()
  const dial = vi.fn()
  const h = await harness({ resolve: dns.resolve, dial })
  const client = await h.raw('GET http://site.example/ HTTP/1.1\r\nHost: site.example\r\n\r\n')
  await vi.waitFor(() => expect(dns.resolve).toHaveBeenCalledOnce())
  client.client.destroy()
  await client.closed
  // Let the server observe the close before the answer arrives.
  await new Promise(resolve => setTimeout(resolve, 50))
  dns.release([PUBLIC])
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(dial).not.toHaveBeenCalled()
})

test('a plain request that timed out while DNS was pending never dials when DNS answers', async () => {
  const dns = deferredDns()
  const dial = vi.fn()
  const h = await harness({ resolve: dns.resolve, dial })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  try {
    const client = await h.raw('GET http://site.example/ HTTP/1.1\r\nHost: site.example\r\n\r\n')
    await vi.waitFor(() => expect(dns.resolve).toHaveBeenCalledOnce())
    // The forwarder's own 10 second limit fires and closes the client...
    vi.advanceTimersByTime(10_000)
    await client.closed
    // ...and only then does DNS answer.
    dns.release([PUBLIC])
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(dial).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

test('proxy setup failure fails closed', async () => {
  const boundary = createConsumerBrowserEgress(
    { setProxy: async () => { throw Error('unavailable') }, closeAllConnections: vi.fn(), resolveProxy: vi.fn() },
    () => true
  )

  cleanups.push(boundary.close)
  await expect(boundary.ready).rejects.toThrow('app_egress_unavailable')
})
