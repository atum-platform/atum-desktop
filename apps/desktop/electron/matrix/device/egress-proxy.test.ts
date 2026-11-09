import type { AddressInfo } from 'node:net'

import { createResolvedAddressGuard } from '@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js'
import { describe, expect, it } from 'vitest'

import { nullAuditWriter } from './audit'
import { decideEgress, DEFAULT_EGRESS_ALLOWLIST, EgressProxy, hostMatches, parseAuthority } from './egress-proxy'

// Trusted test-only address policy for our throwaway loopback upstream.
const testAddresses = createResolvedAddressGuard({ allowedDomains: ['127.0.0.1', '::1'] })

describe('hostMatches', () => {
  it('exact and subdomain patterns', () => {
    expect(hostMatches('github.com', 'github.com')).toBe(true)
    expect(hostMatches('api.github.com', '.github.com')).toBe(true)
    expect(hostMatches('github.com', '.github.com')).toBe(true)
    expect(hostMatches('evil.com', 'github.com')).toBe(false)
    expect(hostMatches('notgithub.com', '.github.com')).toBe(false)
  })
})

describe('decideEgress', () => {
  it('allows every host; the reason only labels the audit line', () => {
    const allowlist = DEFAULT_EGRESS_ALLOWLIST
    expect(decideEgress({ host: 'github.com', allowlist })).toEqual({ outcome: 'allow', reason: 'allowlist' })
    expect(decideEgress({ host: 'registry.npmjs.org', allowlist })).toEqual({ outcome: 'allow', reason: 'allowlist' })
    expect(decideEgress({ host: 'evil.example.com', allowlist })).toEqual({ outcome: 'allow', reason: 'open' })
  })
})

describe('EgressProxy end to end over loopback', () => {
  it('tunnels a CONNECT to any host with no prompt, and audits each new host', async () => {
    // A fake "upstream" the proxy will CONNECT to, standing in for a host that is on no list.
    const net = await import('node:net')

    const upstream = net.createServer(socket => {
      socket.on('data', () => socket.end('pong'))
    })

    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    const upstreamPort = (upstream.address() as AddressInfo).port
    const audited: string[] = []

    const proxy = new EgressProxy({
      addressGuard: testAddresses,
      active: () => true,
      audit: { ...nullAuditWriter, record: entry => void (entry.summary && audited.push(entry.summary)) },
      allowlist: []
    })

    const port = await proxy.start()

    // Owner decision 2026-10-20: a host that is on no allowlist is let through with no approval.
    const open = await connect(port, proxy.authToken, `127.0.0.1:${upstreamPort}`)
    expect(open.status).toContain('200')
    expect(audited).toContain('127.0.0.1 (open)')

    await proxy.stop()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  })
})

describe('EgressProxy authority and parsing', () => {
  it('proxies nothing while no grant is live, allowlisted or not', async () => {
    const net = await import('node:net')
    const upstream = net.createServer(socket => socket.on('data', () => socket.end('pong')))
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    const upstreamPort = (upstream.address() as AddressInfo).port
    let live = false

    const proxy = new EgressProxy({
      addressGuard: testAddresses,
      audit: nullAuditWriter,
      allowlist: ['127.0.0.1'],
      active: () => live
    })

    const port = await proxy.start()

    expect((await connect(port, proxy.authToken, `127.0.0.1:${upstreamPort}`)).status).toContain('403')
    expect((await connect(port, proxy.authToken, `localhost:${upstreamPort}`)).status).toContain('403')

    live = true
    expect((await connect(port, proxy.authToken, `localhost:${upstreamPort}`)).status).toContain('200')
    await proxy.stop()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  })

  it('reads a request head that arrives in pieces', async () => {
    const net = await import('node:net')
    const upstream = net.createServer(socket => socket.on('data', () => socket.end('pong')))
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    const upstreamPort = (upstream.address() as AddressInfo).port

    const proxy = new EgressProxy({
      addressGuard: testAddresses,
      active: () => true,
      audit: nullAuditWriter,
      allowlist: ['127.0.0.1']
    })

    const port = await proxy.start()

    const status = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`srt:${proxy.authToken}`).toString('base64')}\r\n`
        )
        setTimeout(() => socket.write(`Host: 127.0.0.1:${upstreamPort}\r\n\r\n`), 30)
      })

      let buffer = ''
      socket.on('data', chunk => {
        buffer += chunk.toString('latin1')

        if (buffer.includes('\r\n\r\n')) {
          socket.destroy()
          resolve(buffer.split('\r\n', 1)[0] ?? '')
        }
      })
      socket.on('error', reject)
    })

    expect(status).toContain('200')
    await proxy.stop()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  })

  it('parses CONNECT authorities, IPv6 literals included, and rejects garbage', () => {
    expect(parseAuthority('github.com:443', 443)).toEqual({ host: 'github.com', port: 443, path: '' })
    expect(parseAuthority('[::1]:8080', 443)).toEqual({ host: '::1', port: 8080, path: '' })
    expect(parseAuthority('Example.COM', 443)).toEqual({ host: 'example.com', port: 443, path: '' })
    expect(parseAuthority('a b:443', 443)).toBeNull()
    expect(parseAuthority('host:99999', 443)).toBeNull()
  })
})

/** Open a CONNECT to the proxy and return its status line. */
async function connect(proxyPort: number, token: string, target: string): Promise<{ status: string }> {
  const net = await import('node:net')

  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${Buffer.from(`srt:${token}`).toString('base64')}\r\n\r\n`
      )
    })

    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1')

      if (buffer.includes('\r\n\r\n') || buffer.includes('pong')) {
        const status = buffer.split('\r\n', 1)[0] ?? ''
        socket.destroy()
        resolve({ status })
      }
    })
    socket.on('error', reject)
    setTimeout(() => {
      socket.destroy()
      resolve({ status: buffer.split('\r\n', 1)[0] ?? '' })
    }, 2000)
  })
}
