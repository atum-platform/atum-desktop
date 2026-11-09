import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHermesPagesTransport } from './hermes-pages-transport'
import type { MatrixHermesConnection } from './hermes-runtime'
import { createMatrixPagesComputerUseScope } from './pages-computer-use'
import { MatrixPagesManagementTransport } from './pages-management-transport'
import { MatrixHermesTurnLock } from './turn-lock'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0)) {
    await dispose()
  }
})

const rawStatus = {
  platform: 'darwin',
  installed: true,
  ready: false,
  accessibility: true,
  screen_recording: false,
  screen_recording_capturable: false,
  error: null,
  source: { path: '/private/fixture/driver' },
  checks: [{ label: 'private diagnostic', message: 'private output' }]
}

async function fixture(options: { ambiguous?: boolean; holdStatus?: boolean } = {}) {
  const calls: Array<{ path: string; bearer: string | undefined }> = []
  let reply: ServerResponse | undefined
  const home = '/fixture/owned/profiles/agent-a'

  const server = createServer((request, response) => {
    calls.push({ path: request.url!, bearer: request.headers.authorization })
    response.setHeader('Content-Type', 'application/json')

    if (request.url === '/api/profiles') {
      response.end(
        JSON.stringify({
          profiles: [
            { name: 'default', path: '/fixture/foreign' },
            { name: 'agent-a', path: home },
            ...(options.ambiguous ? [{ name: 'agent-b', path: home }] : [])
          ]
        })
      )
    } else if (request.url === '/api/tools/computer-use/status?profile=agent-a') {
      if (options.holdStatus) {
        reply = response
      } else {
        response.end(JSON.stringify(rawStatus))
      }
    } else {
      response.writeHead(404).end('{}')
    }
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  disposals.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  const lifetime = new AbortController()

  const pages = createHermesPagesTransport(
    (server.address() as AddressInfo).port,
    'synthetic-cua-bearer',
    home,
    lifetime.signal
  )

  const original = { signal: lifetime.signal, pages } as unknown as MatrixHermesConnection
  let connection = original
  let current = true
  const lock = new MatrixHermesTurnLock()

  const transport = new MatrixPagesManagementTransport({
    isCurrent: () => current,
    connection: () => connection,
    connect: vi.fn(),
    busy: () => true,
    lock
  })

  const scope = createMatrixPagesComputerUseScope({
    isCurrent: () => transport.current(),
    forward: request => transport.forward(request)
  })

  return {
    scope,
    calls,
    lock,
    transport,
    replace: () => {
      connection = { ...original }
    },
    retire: () => {
      current = false
      transport.retire()
    },
    finish: () => reply?.end(JSON.stringify(rawStatus))
  }
}

describe('selected-agent Computer Use actual HTTP/profile/process custody', () => {
  it('reads the proved selected home during a turn without taking its lock or exposing raw diagnostics', async () => {
    const f = await fixture()
    const release = await f.lock.acquire('room', 'turn')

    try {
      await expect(f.scope.request({ path: '/api/tools/computer-use/status' })).resolves.toEqual({
        platform: 'darwin',
        installed: true,
        ready: false,
        accessibility: true,
        screenRecording: false,
        screenRecordingCapturable: false
      })
      expect(f.calls).toEqual([
        { path: '/api/profiles', bearer: 'Bearer synthetic-cua-bearer' },
        { path: '/api/tools/computer-use/status?profile=agent-a', bearer: 'Bearer synthetic-cua-bearer' }
      ])
      expect(f.lock.holder?.label).toBe('turn')
      expect(f.lock.waiting).toBe(0)
    } finally {
      release()
    }
  })

  it('refuses an ambiguous owned home before any driver status read', async () => {
    const f = await fixture({ ambiguous: true })
    await expect(f.scope.request({ path: '/api/tools/computer-use/status' })).rejects.toThrow()
    expect(f.calls.map(value => value.path)).toEqual(['/api/profiles'])
  })

  it.each(['replace', 'retire'] as const)(
    'rejects late results after %s and never retargets the old view',
    async action => {
      const f = await fixture({ holdStatus: true })
      const pending = f.scope.request({ path: '/api/tools/computer-use/status' })
      const rejection = expect(pending).rejects.toThrow()
      await vi.waitFor(() => expect(f.calls).toHaveLength(2))
      f[action]()
      f.finish()
      await rejection
      await expect(f.scope.request({ path: '/api/tools/computer-use/status' })).rejects.toThrow()
      expect(f.calls).toHaveLength(2)
    }
  )
})
