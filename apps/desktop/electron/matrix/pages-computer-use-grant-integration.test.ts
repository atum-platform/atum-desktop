import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHermesPagesTransport } from './hermes-pages-transport'
import type { MatrixHermesConnection } from './hermes-runtime'
import { createMatrixPagesComputerUseScope } from './pages-computer-use'
import { createMatrixPagesComputerUseGrantScope } from './pages-computer-use-grant'
import { MatrixPagesManagementTransport } from './pages-management-transport'
import { MatrixHermesTurnLock } from './turn-lock'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0)) {await dispose()}
})

async function fixture(options: { ambiguous?: boolean; holdPost?: boolean; conflict?: boolean } = {}) {
  const calls: Array<{ path: string; method: string; bearer: string | undefined }> = []
  const home = '/fixture/owned/profiles/agent-a'

  let action = {
    name: 'computer-use-grant',
    running: false,
    pid: null as number | null,
    exit_code: null as number | null
  }

  let postReply: ServerResponse | undefined

  const server = createServer((request, response) => {
    calls.push({ path: request.url!, method: request.method!, bearer: request.headers.authorization })
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
      response.end(
        JSON.stringify({
          platform: 'darwin',
          installed: true,
          accessibility: true,
          screen_recording: false,
          screen_recording_capturable: false,
          source: 'private diagnostic'
        })
      )
    } else if (request.url === '/api/actions/computer-use-grant/status?profile=agent-a&lines=1') {
      response.end(JSON.stringify({ ...action, lines: ['private action output'] }))
    } else if (
      request.url === '/api/tools/computer-use/permissions/grant?profile=agent-a' &&
      request.method === 'POST'
    ) {
      if (options.conflict) {response.writeHead(409).end(JSON.stringify({ detail: 'private conflict' }))}
      else {
        action = { ...action, running: true, pid: 123, exit_code: null }

        if (options.holdPost) {postReply = response}
        else
          {response.end(JSON.stringify({ ok: true, name: action.name, pid: action.pid, diagnostic: 'private response' }))}
      }
    } else {response.writeHead(404).end('{}')}
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  disposals.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const lifetime = new AbortController()

  const original = {
    signal: lifetime.signal,
    pages: createHermesPagesTransport(
      (server.address() as AddressInfo).port,
      'synthetic-grant-bearer',
      home,
      lifetime.signal
    )
  } as unknown as MatrixHermesConnection

  let connection = original
  const lock = new MatrixHermesTurnLock()

  const transport = new MatrixPagesManagementTransport({
    isCurrent: () => true,
    connection: () => connection,
    connect: vi.fn(),
    busy: () => false,
    lock
  })

  const passive = createMatrixPagesComputerUseScope({
    isCurrent: () => transport.current(),
    forward: value => transport.forward(value)
  })

  const confirm = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)

  const grant = createMatrixPagesComputerUseGrantScope({
    platform: 'darwin',
    isCurrent: () => transport.current(),
    status: () => passive.request({ path: '/api/tools/computer-use/status' }),
    confirm,
    forward: value => transport.forward(value)
  })

  return {
    calls,
    grant,
    passive,
    confirm,
    lock,
    start: () => grant.request({ path: '/api/tools/computer-use/permissions/grant', method: 'POST' }),
    poll: (id: string) => grant.request({ path: '/api/tools/computer-use/permissions/grants/' + id }),
    finish: () => {
      action = { ...action, running: false, exit_code: 0 }
    },
    foreign: () => {
      action = { ...action, running: false, pid: 999, exit_code: 0 }
    },
    replace: () => {
      connection = { ...original }
    },
    retire: () => transport.retire(),
    replyPost: () => postReply?.end(JSON.stringify({ ok: true, name: action.name, pid: action.pid }))
  }
}

describe('confirmed grant real loopback/profile/original backend integration', () => {
  it('proves the selected home before consent, posts once, and keeps process completion separate from facts', async () => {
    const f = await fixture()
    expect(f.calls).toHaveLength(0)
    f.confirm.mockImplementation(async () => {
      expect(f.calls.map(value => value.path)).toEqual([
        '/api/profiles',
        '/api/tools/computer-use/status?profile=agent-a',
        '/api/actions/computer-use-grant/status?profile=agent-a&lines=1'
      ])

      return true
    })
    const start = await f.start()

    if (start.status !== 'started') {throw new Error('Expected issued start')}
    expect(Object.keys(start)).toEqual(['status', 'operationId'])
    expect(await f.poll(start.operationId)).toEqual({ status: 'running' })
    expect(f.calls.filter(value => value.method === 'POST')).toHaveLength(1)
    expect(f.calls.every(value => value.bearer === 'Bearer synthetic-grant-bearer')).toBe(true)
    f.finish()
    expect(await f.poll(start.operationId)).toEqual({ status: 'completed' })
    const snapshot = await f.passive.request({ path: '/api/tools/computer-use/status' })
    expect(snapshot.ready).toBe(false)
    expect(snapshot.screenRecording).toBe(false)
    expect(JSON.stringify({ start, snapshot })).not.toMatch(/private|"pid"|Bearer/)
  })
  it('never prompts or posts for an ambiguous owned home', async () => {
    const f = await fixture({ ambiguous: true })
    expect(await f.start()).toEqual({ status: 'unknown' })
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.calls.map(value => value.path)).toEqual(['/api/profiles'])
  })
  it.each(['replace', 'retire'] as const)(
    'discards a late POST after %s without adopting/cancelling/retrying',
    async change => {
      const f = await fixture({ holdPost: true })
      const pending = f.start()
      await vi.waitFor(() => expect(f.calls.some(value => value.method === 'POST')).toBe(true))
      f[change]()
      f.replyPost()
      expect(await pending).toEqual({ status: 'unknown' })
      const before = f.calls.length
      expect(await f.start()).toEqual({ status: 'unknown' })
      expect(f.calls).toHaveLength(before)
      expect(f.calls.filter(value => value.method === 'POST')).toHaveLength(1)
    }
  )
  it('refuses to inherit another PID or a replacement connection', async () => {
    const f = await fixture()
    const start = await f.start()

    if (start.status !== 'started') {throw new Error('Expected issued start')}
    f.foreign()
    expect(await f.poll(start.operationId)).toEqual({ status: 'unknown' })
    f.replace()
    const before = f.calls.length
    expect(await f.poll(start.operationId)).toEqual({ status: 'unknown' })
    expect(f.calls).toHaveLength(before)
  })
  it('uses the shared turn lock only for POST and reports busy without writing behind an active turn', async () => {
    const f = await fixture()
    const release = await f.lock.acquire('room', 'turn')

    try {
      expect(await f.start()).toEqual({ status: 'blocked', reason: 'busy' })
      expect(f.confirm).toHaveBeenCalledOnce()
      expect(f.calls.some(value => value.method === 'POST')).toBe(false)
      expect(f.lock.holder?.label).toBe('turn')
      expect(f.lock.waiting).toBe(0)
    } finally {
      release()
    }
  })
  it('redacts a backend live-action conflict as unknown without retrying', async () => {
    const f = await fixture({ conflict: true })
    expect(await f.start()).toEqual({ status: 'unknown' })
    expect(f.calls.filter(value => value.method === 'POST')).toHaveLength(1)
  })
})
