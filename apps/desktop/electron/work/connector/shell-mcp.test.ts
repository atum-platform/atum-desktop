import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

import { startShellMcp } from './shell-mcp'

it('gives Work both Shell servers, forwards rotated tokens, and revokes the list on sign-out', async () => {
  const userdata = await mkdtemp(join(tmpdir(), 'work-shell-mcp-'))
  const config = join(userdata, 'managed-mcp-servers.json')
  const session = new AbortController()
  let signedIn = true
  let token = 'matrix-initial-fixture'
  const calls: Array<{ path: string; bearer: string | null }> = []
  const refresh = vi.fn(async () => (token = 'matrix-recovered-fixture'))
  const shell = vi.fn<typeof fetch>(async (input, init) => {
    const headers = new Headers(init?.headers)
    const bearer = headers.get('authorization')
    calls.push({ path: new URL(String(input)).pathname, bearer })
    expect(init?.redirect).toBe('error')
    expect(headers.has('cookie')).toBe(false)
    return bearer === 'Bearer matrix-refused-fixture'
      ? new Response(null, { status: 401 })
      : Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
  })

  try {
    await startShellMcp({
      userdata, resource: 'https://shell.example.test/api/matrix/v1', current: () => signedIn,
      matrixToken: () => token, refreshMatrixToken: refresh, signal: session.signal, fetch: shell
    })
    const manifest = await readFile(config, 'utf8')
    expect(manifest).not.toContain(token)
    expect((await stat(config)).mode & 0o077).toBe(0)
    const servers = JSON.parse(manifest) as Array<{ name: string; url: string; authorizationHeader: string }>
    expect(servers.map(server => server.name)).toEqual(['atum-google', 'atum-owner-chats'])
    const call = (server: typeof servers[number], authorization = server.authorizationHeader) => fetch(server.url, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json', Cookie: 'fixture=not-forwarded' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })

    for (const server of servers) {
      expect((await call(server)).status).toBe(200)
    }
    expect((await call(servers[0], 'Bearer wrong-local-credential')).status).toBe(404)

    token = 'matrix-rotated-fixture'
    expect((await call(servers[0])).status).toBe(200)
    token = 'matrix-refused-fixture'
    expect((await call(servers[1])).status).toBe(200)
    expect(refresh).toHaveBeenCalledExactlyOnceWith('matrix-refused-fixture')
    expect(calls).toEqual([
      { path: '/api/mcp/google', bearer: 'Bearer matrix-initial-fixture' },
      { path: '/api/mcp/owner-chats', bearer: 'Bearer matrix-initial-fixture' },
      { path: '/api/mcp/google', bearer: 'Bearer matrix-rotated-fixture' },
      { path: '/api/mcp/owner-chats', bearer: 'Bearer matrix-refused-fixture' },
      { path: '/api/mcp/owner-chats', bearer: 'Bearer matrix-recovered-fixture' }
    ])

    signedIn = false
    expect((await call(servers[0])).status).toBe(404)
    session.abort()
    await expect(readFile(config)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(call(servers[0])).rejects.toThrow()
    expect(shell).toHaveBeenCalledTimes(5)
  } finally {
    session.abort()
    await rm(userdata, { recursive: true, force: true })
  }
})
