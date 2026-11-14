/**
 * CONNECT-only transport for an app partition. Chromium still owns HTTPS, TLS
 * verification, cookies and HTTP semantics. The only extra responsibility here
 * is dialing only the public answer set we checked, without resolving again.
 * The controller's request filter continues to own URL/resource-type policy.
 */
import { lookup } from 'node:dns/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, isIP, type Socket } from 'node:net'

import { assertConsumerBrowserAddresses, assertPublicResolvedAddresses, assertSafeBrowserRequestUrl } from '../../shared/browser/policy'

export interface EgressSession {
  setProxy: (config: { mode: 'fixed_servers'; proxyRules: string; proxyBypassRules: string }) => Promise<void>
  closeAllConnections: () => Promise<void>
  resolveProxy: (url: string) => Promise<string>
}

export interface AppViewEgress {
  ready: Promise<void>
  /** Synchronously stops acceptance and destroys pending and established sockets. */
  close: () => void
}

interface EgressDeps {
  resolve?: (hostname: string) => Promise<string[]>
  /** Unit/native-fixture seam, never selected from app/renderer configuration. */
  dial?: (port: number, addresses: readonly string[], hostname: string) => Socket
}

/**
 * Who may be dialled. `current` returns an identity token while the boundary is live and null once it is
 * revoked; a different token than the one a request started under cancels it. `admit` is the destination
 * allow-list, `probes` the URLs whose proxy resolution must equal this server before the boundary is ready.
 */
interface EgressPolicy {
  current: () => object | null
  admit: (target: URL, policy: object) => boolean
  probes: (policy: object) => readonly string[]
  /** Also forward plain `http://` requests (a browser tab). Off for app partitions: HTTPS CONNECT only. */
  forwardHttp?: boolean
  tailnet?: (target: URL) => boolean
}

export function createAppViewEgress(
  session: EgressSession,
  origins: () => ReadonlySet<string> | null,
  deps: EgressDeps = {}
): AppViewEgress {
  return createPinnedEgress(
    session,
    {
      current: origins,
      admit: (target, policy) => (policy as ReadonlySet<string>).has(target.origin),
      probes: policy => [...(policy as ReadonlySet<string>)]
    },
    deps
  )
}

/**
 * The consumer browser's boundary: any public destination, but Chromium never resolves it. Chromium sends the
 * hostname to this proxy; the proxy resolves once, checks the whole answer set is public, and dials only those
 * addresses. A page cannot make Chromium and our check disagree by answering a second DNS query differently.
 */
export function createConsumerBrowserEgress(
  session: EgressSession,
  active: () => boolean,
  deps: EgressDeps = {},
  privateOrigins: () => ReadonlySet<string> = () => new Set()
): AppViewEgress {
  const token = {}

  return createPinnedEgress(
    session,
    {
      current: () => (active() ? token : null),
      admit: () => true,
      probes: () => ['https://probe.invalid', 'http://probe.invalid'],
      tailnet: target => privateOrigins().has(target.origin),
      forwardHttp: true
    },
    deps
  )
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect'
])

function forwardableHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const kept: IncomingHttpHeaders = {}

  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) {
      kept[name] = value
    }
  }

  return kept
}

function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, '')
}

function createPinnedEgress(session: EgressSession, egressPolicy: EgressPolicy, deps: EgressDeps): AppViewEgress {
  const origins = egressPolicy.current

  const resolve =
    deps.resolve ??
    (async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(value => value.address))

  const dial =
    deps.dial ??
    ((port, addresses, hostname) =>
      connect({
        host: hostname,
        port,
        autoSelectFamily: true,
        // Reuse Node's connection/family fallback, but never resolve again. Every
        // candidate here is from the one already-validated immutable answer set.
        lookup: (_hostname, options, callback) => {
          const records = addresses.map(address => ({ address, family: isIP(address) }))

          if (options.all) {
            callback(null, records)
          } else {
            callback(null, records[0]!.address, records[0]!.family)
          }
        }
      }))

  const sockets = new Set<Socket>()
  let closed = false

  // A plain http:// request. Same rule as CONNECT: resolve once, require a fully public answer set, dial only
  // those addresses (through `dial`, which cannot resolve again). Chromium owns redirects, caching and cookies.
  const forward = (request: IncomingMessage, response: ServerResponse): void => {
    const policy = origins()
    let upstream: ReturnType<typeof httpRequest> | undefined
    // Set once the request timed out, failed or the client went away. A DNS answer that arrives later
    // must not dial: nothing exists yet for the close handlers to destroy.
    let ended = false
    const timer = setTimeout(() => finish(), 10_000)

    const finish = () => {
      ended = true
      clearTimeout(timer)
      upstream?.destroy()
      response.destroy()
    }

    response.once('close', () => {
      ended = true
      clearTimeout(timer)
      upstream?.destroy()
    })

    void (async () => {
      try {
        const target = new URL(request.url ?? '')

        if (target.protocol !== 'http:' || target.username || target.password || !policy || closed || !egressPolicy.admit(target, policy)) {
          throw Error('app_egress_refused')
        }

        assertSafeBrowserRequestUrl(target.href)
        const hostname = bareHost(target.hostname)
        const addresses = await resolve(hostname)

        if (egressPolicy.tailnet?.(target)) {
          assertConsumerBrowserAddresses(target.hostname, addresses)
        } else {
          assertPublicResolvedAddresses(addresses)
        }

        if (ended || response.destroyed || request.socket.destroyed || closed || origins() !== policy) {
          throw Error('app_egress_revoked')
        }

        const port = Number(target.port || '80')

        upstream = httpRequest({
          method: request.method,
          path: `${target.pathname}${target.search}`,
          headers: { ...forwardableHeaders(request.headers), host: target.host, connection: 'close' },
          // No `agent`: with `agent: false` Node ignores `createConnection` and resolves the host itself,
          // which would void the pin (the same flaw as the app-bot webhook transport).
          createConnection: () => {
            const socket = dial(port, [...addresses], hostname)
            sockets.add(socket)
            socket.once('close', () => sockets.delete(socket))

            return socket
          }
        })
        upstream.on('error', finish)
        upstream.setTimeout(60_000, finish)
        upstream.once('response', answer => {
          clearTimeout(timer)
          const headers: IncomingHttpHeaders = {}

          for (const [name, value] of Object.entries(forwardableHeaders(answer.headers))) {
            headers[name] = value
          }

          response.writeHead(answer.statusCode ?? 502, headers)
          answer.on('error', finish)
          answer.pipe(response)
        })
        request.socket.setTimeout(60_000)
        request.pipe(upstream)
      } catch {
        finish()
      }
    })()
  }

  const forwardHttp = egressPolicy.forwardHttp === true

  // Node parses HTTP; do not invent an HTTP parser. No upgrade, PAC, credentials, TLS termination,
  // logging of URLs, or direct fallback. Forwarding plain http:// is on only for a browser tab.
  const server = createServer({ maxHeaderSize: forwardHttp ? 65_536 : 8_192 }, (request, response) => {
    if (forwardHttp) {
      forward(request, response)
    } else {
      response.destroy()
    }
  })

  server.maxConnections = forwardHttp ? 256 : 64
  server.headersTimeout = 4_000
  // A tunnel or a plain request may legitimately run long (an upload); idle time is bounded per socket.
  server.requestTimeout = forwardHttp ? 0 : 4_000
  server.on('upgrade', (_request, socket) => socket.destroy())
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.setTimeout(10_000, () => socket.destroy())

    if (closed) {
      socket.destroy()
    }
  })
  server.on('connect', (request, client, head) => {
    let upstream: Socket | undefined

    const finish = () => {
      client.destroy()
      upstream?.destroy()
    }

    client.once('close', () => upstream?.destroy())
    // Bound DNS to 4s and DNS + TCP to 10s. Late DNS cannot release bytes
    // after timeout, client close, policy replacement or partition revocation.
    const started = Date.now()
    let timer = setTimeout(finish, 4_000)
    const policy = origins()
    const current = () => !closed && !client.destroyed && policy !== null && origins() === policy

    void (async () => {
      try {
        const authority = request.url ?? ''
        const target = new URL(`https://${authority}`)

        if (
          request.method !== 'CONNECT' ||
          `${target.hostname}:${target.port || '443'}` !== authority ||
          !current() ||
          !policy ||
          !egressPolicy.admit(target, policy)
        ) {
          throw Error('app_egress_refused')
        }

        assertSafeBrowserRequestUrl(target.href)
        const addresses = await resolve(bareHost(target.hostname))

        if (egressPolicy.tailnet?.(target)) {
          assertConsumerBrowserAddresses(target.hostname, addresses)
        } else {
          assertPublicResolvedAddresses(addresses)
        }

        if (!current()) {
          throw Error('app_egress_revoked')
        }

        clearTimeout(timer)
        timer = setTimeout(finish, Math.max(1, 10_000 - (Date.now() - started)))
        upstream = dial(Number(target.port || '443'), [...addresses], bareHost(target.hostname))
        sockets.add(upstream)
        upstream.once('close', () => {
          sockets.delete(upstream!)
          client.destroy()
        })
        upstream.on('error', finish)
        upstream.once('connect', () => {
          if (!current()) {
            finish()

            return
          }

          clearTimeout(timer)
          ;(client as Socket).setTimeout(0)
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')

          if (head.length) {
            upstream!.write(head)
          }

          client.pipe(upstream!).pipe(client)
        })
      } catch {
        finish()
      }
    })()

    client.once('close', () => clearTimeout(timer))
  })

  const close = () => {
    closed = true
    server.close()

    for (const socket of sockets) {
      socket.destroy()
    }
  }

  // Retain a lifetime handler after readiness. A failed listener leaves the
  // session pointed at a closed port, never a direct route.
  server.on('error', close)

  const ready = (async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })

      if (closed) {
        throw Error('app_egress_closed')
      }

      const address = server.address()

      if (!address || typeof address === 'string') {
        throw Error('app_egress_unavailable')
      }

      await session.setProxy({
        mode: 'fixed_servers',
        proxyRules: `http://127.0.0.1:${address.port}`,
        proxyBypassRules: '<-loopback>'
      })
      // Do not reuse any direct socket created before the fixed proxy applied.
      await session.closeAllConnections()
      const configured = origins()
      const probes = configured ? egressPolicy.probes(configured) : []

      if (probes.length === 0) {
        throw Error('app_egress_closed')
      }

      const expectedProxy = `PROXY 127.0.0.1:${address.port}`
      const effective = await Promise.all(probes.map(url => session.resolveProxy(url)))

      if (effective.some(value => value !== expectedProxy)) {
        throw Error('app_egress_not_applied')
      }

      if (closed) {
        throw Error('app_egress_closed')
      }
    } catch {
      close()
      throw Error('app_egress_unavailable')
    }
  })()

  // A synchronous revoke can precede the caller awaiting readiness.
  void ready.catch(() => undefined)

  return { ready, close }
}
