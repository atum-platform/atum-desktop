import { type AddressInfo, connect, createServer, type Socket } from 'node:net'

import { createResolvedAddressGuard } from '@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js'
import { describe, expect, it, vi } from 'vitest'

import { nullAuditWriter } from '../audit'

import { EgressProxy } from './egress'

async function request(port: number, token: string | null, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const auth =
        token === null ? '' : `Proxy-Authorization: Basic ${Buffer.from(`srt:${token}`).toString('base64')}\r\n`

      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`)
    })

    let output = ''
    socket.setTimeout(3000, () => socket.destroy(new Error('proxy_test_timeout')))
    socket.on('error', reject)
    socket.on('data', bytes => {
      output += bytes.toString()

      if (output.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(output.split('\r\n')[0])
      }
    })
    socket.on('close', () => resolve(output))
  })
}

describe('authenticated device proxy boundaries', () => {
  it('refuses absent and wrong credentials before anything is audited', async () => {
    const record = vi.fn()
    const proxy = new EgressProxy({ active: () => true, audit: { ...nullAuditWriter, record } })
    const port = await proxy.start()

    try {
      expect(await request(port, null, 'github.com:443')).toContain('407')
      expect(await request(port, 'wrong', 'github.com:443')).toContain('407')
      expect(record).not.toHaveBeenCalled()
    } finally {
      await proxy.stop()
    }
  })

  it.each([
    '127.0.0.1',
    '127.1',
    '0x7f000001',
    '2130706433',
    '0177.0.0.1',
    '0.0.0.0',
    '[::1]',
    '[::ffff:127.0.0.1]',
    'localhost',
    '169.254.169.254',
    '192.168.1.1'
  ])('refuses private/daemon destination %s even though every public host is open', async host => {
    const proxy = new EgressProxy({ active: () => true, audit: nullAuditWriter, allowlist: [host] })
    const port = await proxy.start()

    try {
      expect(await request(port, proxy.authToken, `${host}:443`)).toContain('403')
    } finally {
      await proxy.stop()
    }
  })

  it('blocks an allowlisted name resolving to a daemon with a single checked resolution', async () => {
    const resolve = vi.fn((_host, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]))

    const proxy = new EgressProxy({
      active: () => true,
      audit: nullAuditWriter,
      addressGuard: createResolvedAddressGuard({ resolve })
    })

    const port = await proxy.start()

    try {
      expect(await request(port, proxy.authToken, 'github.com:443')).toContain('403')
      expect(resolve).toHaveBeenCalledTimes(1)
    } finally {
      await proxy.stop()
    }
  })

  it('does not serve without an active-grant provider', async () => {
    const proxy = new EgressProxy({ audit: nullAuditWriter })

    const port = await proxy.start()

    try {
      expect(await request(port, proxy.authToken, 'github.com:443')).toContain('403')
    } finally {
      await proxy.stop()
    }
  })

  it('Stop closes both the client and an established CONNECT upstream', async () => {
    let upstreamSocket: Socket | undefined
    let closed!: () => void

    const upstreamClosed = new Promise<void>(resolve => {
      closed = resolve
    })

    const upstream = createServer(socket => {
      upstreamSocket = socket
      socket.on('error', () => {})
      socket.on('close', closed)
    })

    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as AddressInfo).port

    const proxy = new EgressProxy({
      active: () => true,
      audit: nullAuditWriter,
      allowlist: ['127.0.0.1'],
      addressGuard: createResolvedAddressGuard({ allowedDomains: ['127.0.0.1'] })
    })

    const port = await proxy.start()
    const client = connect(port, '127.0.0.1')
    client.on('error', () => {})

    try {
      const established = new Promise<string>(resolve => client.once('data', bytes => resolve(bytes.toString())))
      const auth = Buffer.from(`srt:${proxy.authToken}`).toString('base64')
      client.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`)
      expect(await established).toContain('200')
      proxy.closeAll()
      await upstreamClosed
      expect(upstreamSocket?.destroyed).toBe(true)
    } finally {
      client.destroy()
      upstreamSocket?.destroy()
      await proxy.stop()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  })

  it('Stop fences open tunnels and later grants can connect again', async () => {
    const upstream = createServer(socket => {
      socket.on('error', () => {})
      socket.end('pong')
    })

    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as AddressInfo).port
    let live = true

    const proxy = new EgressProxy({
      active: () => live,
      audit: nullAuditWriter,
      allowlist: ['127.0.0.1'],
      addressGuard: createResolvedAddressGuard({ allowedDomains: ['127.0.0.1'] })
    })

    const port = await proxy.start()

    try {
      live = false
      proxy.closeAll()
      expect(await request(port, proxy.authToken, `127.0.0.1:${upstreamPort}`)).not.toContain('200')
      live = true
      expect(await request(port, proxy.authToken, `127.0.0.1:${upstreamPort}`)).toContain('200')
    } finally {
      await proxy.stop()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  })
})
