import { once } from 'node:events'
import { connect, createServer, type Socket } from 'node:net'

import { afterEach, expect, test, vi } from 'vitest'

import { createAppViewEgress, type EgressSession } from './egress'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) {
    await close()
  }
})

async function harness(options: Parameters<typeof createAppViewEgress>[2] = {}, proxyOverride?: string) {
  let rules = ''
  let policy: ReadonlySet<string> | null = new Set(['https://app.example', 'https://data.example:8443'])

  const session: EgressSession = {
    setProxy: vi.fn(async config => {
      expect(config.mode).toBe('fixed_servers')
      expect(config.proxyBypassRules).toBe('<-loopback>')
      rules = config.proxyRules
    }),
    closeAllConnections: vi.fn(async () => undefined),
    resolveProxy: vi.fn(async () => proxyOverride ?? `PROXY ${new URL(rules).host}`)
  }

  const boundary = createAppViewEgress(session, () => policy, options)
  cleanups.push(boundary.close)
  await boundary.ready
  expect(session.closeAllConnections).toHaveBeenCalledOnce()

  const dial = async (request: string) => {
    const client = connect({ host: '127.0.0.1', port: Number(new URL(rules).port) })
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

  return {
    boundary,
    dial,
    session,
    revoke: () => {
      policy = null
      boundary.close()
    },
    replace: () => {
      policy = new Set(policy)
    }
  }
}

test.each([
  'GET http://app.example/ HTTP/1.1\r\nHost: app.example\r\n\r\n',
  'CONNECT other.example:443 HTTP/1.1\r\n\r\n',
  'CONNECT app.example:80 HTTP/1.1\r\n\r\n',
  'CONNECT user@app.example:443 HTTP/1.1\r\n\r\n',
  'CONNECT app.example:443/path HTTP/1.1\r\n\r\n',
  'CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n'
])('rejects undeclared/malformed/forward requests before DNS: %s', async request => {
  const resolve = vi.fn(),
    dial = vi.fn()

  const h = await harness({ resolve, dial })
  const client = await h.dial(request)
  await client.closed
  expect(client.data()).toBe('')
  expect(resolve).not.toHaveBeenCalled()
  expect(dial).not.toHaveBeenCalled()
})

test.each(
  [[], ['127.0.0.1'], ['::1'], ['192.168.1.2'], ['93.184.216.34', '10.0.0.1'], ['not-an-ip']].map(answers => ({
    answers
  }))
)('does not open a socket for private, mixed, invalid or empty DNS answers: $answers', async ({ answers }) => {
  const dial = vi.fn()
  const h = await harness({ resolve: async () => answers, dial })
  const client = await h.dial('CONNECT app.example:443 HTTP/1.1\r\n\r\n')
  await client.closed
  expect(client.data()).toBe('')
  expect(dial).not.toHaveBeenCalled()
})

test.each([0, 11_000])(
  'dials the vetted answer set, keeps an idle tunnel for %i ms and revokes it',
  async idleMs => {
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
      expect(addresses).toEqual(['93.184.216.34'])
      expect(hostname).toBe('data.example')

      return connect({ host: '127.0.0.1', port: (echo.address() as { port: number }).port })
    })

    const h = await harness({ resolve: async () => ['93.184.216.34'], dial })
    const client = await h.dial('CONNECT data.example:8443 HTTP/1.1\r\n\r\nopaque-test-bytes')
    await vi.waitFor(() => expect(client.data()).toContain('opaque-test-bytes'))
    expect(dial).toHaveBeenCalledOnce()

    if (idleMs) {
      await new Promise(resolve => setTimeout(resolve, idleMs))
      client.client.write('after-idle')
      await vi.waitFor(() => expect(client.data()).toContain('after-idle'))
    }

    h.revoke()
    await client.closed
  },
  14_000
)

test.each(['revoke', 'replace'] as const)('late DNS after %s cannot dial', async change => {
  let release!: (value: string[]) => void

  const resolve = vi.fn(
    () =>
      new Promise<string[]>(done => {
        release = done
      })
  )

  const dial = vi.fn()
  const h = await harness({ resolve, dial })
  const client = await h.dial('CONNECT app.example:443 HTTP/1.1\r\n\r\n')
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce())

  if (change === 'replace') {
    h.replace()
  } else {
    h.revoke()
  }

  release(['93.184.216.34'])
  await client.closed
  expect(dial).not.toHaveBeenCalled()
})

test('unanswered DNS is bounded without opening a socket', async () => {
  const dial = vi.fn()
  const h = await harness({ resolve: () => new Promise(() => undefined), dial })
  const client = await h.dial('CONNECT app.example:443 HTTP/1.1\r\n\r\n')
  await client.closed
  expect(dial).not.toHaveBeenCalled()
}, 7_000)

test('proxy setup failure fails closed', async () => {
  const boundary = createAppViewEgress(
    {
      setProxy: async () => {
        throw Error('unavailable')
      },
      closeAllConnections: vi.fn(),
      resolveProxy: vi.fn()
    },
    () => new Set()
  )

  cleanups.push(boundary.close)
  await expect(boundary.ready).rejects.toThrow('app_egress_unavailable')
})

test.each(['DIRECT', 'PROXY 127.0.0.1:1', 'PROXY 127.0.0.1:1; DIRECT'])(
  'does not become ready with an ineffective or stale proxy: %s',
  async value => {
    await expect(harness({}, value)).rejects.toThrow('app_egress_unavailable')
  }
)
