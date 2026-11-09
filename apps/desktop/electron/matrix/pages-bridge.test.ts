import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixEnrollment } from '../../shared/matrix'

import {
  forwardMatrixPagesRequest,
  matrixPagesRequest,
  readMatrixPagesMedia,
  selectMatrixPagesAgent
} from './pages-bridge'

describe('installed roster selection', () => {
  const agents = ['default', 'alfred']

  const enrollment = (agent: string): MatrixEnrollment => ({
    state: 'ready',
    identity: {
      issuer: 'https://auth.example',
      subject: 'owner-subject',
      principal: 'owner-principal',
      agentPrincipal: `agent-${agent}`,
      executorId: `executor-${agent}`,
      userId: `@${agent}:example`,
      deviceId: `device-${agent}`,
      expiresAt: 9999999999999
    }
  })

  it('selects each agent by its distinct roster ID while retaining the shared owner for the home', () => {
    for (const agent of agents) {
      expect(selectMatrixPagesAgent(agents, enrollment, `agent-${agent}`)).toEqual({
        agent,
        identity: enrollment(agent).identity
      })
    }

    expect(selectMatrixPagesAgent(agents, enrollment).agent).toBe('default')
    expect(() => selectMatrixPagesAgent(agents, enrollment, 'owner-principal')).toThrow('pages_agent_unavailable')
  })

  it('refuses unknown, revoked and ambiguous agent selections', () => {
    expect(() => selectMatrixPagesAgent(agents, enrollment, 'unknown')).toThrow('pages_agent_unavailable')
    expect(() =>
      selectMatrixPagesAgent(agents, agent => ({ ...enrollment(agent), state: 'revoking' }), 'agent-alfred')
    ).toThrow('pages_agent_unavailable')
    expect(() => selectMatrixPagesAgent(['alfred', 'alfred'], enrollment, 'agent-alfred')).toThrow(
      'pages_agent_unavailable'
    )
  })
})

describe('native pages fixed per-agent API', () => {
  it('restricts learned skill reads, edits and recoverable archive to native-selected local skills', () => {
    expect(matrixPagesRequest({ path: '/api/learning/node?id=my-skill' })).toEqual({
      path: '/api/learning/node?id=my-skill&local_skill_only=true&profile=default',
      method: 'GET'
    })

    for (const [method, body] of [
      ['PUT', { id: 'my-skill', content: '---\nname: my-skill\n---\nUpdated' }],
      ['DELETE', { id: 'my-skill' }]
    ] as const) {
      expect(matrixPagesRequest({ path: '/api/learning/node', method, body })).toEqual({
        path: '/api/learning/node?local_skill_only=true&profile=default',
        method,
        body
      })
    }
  })

  it.each([
    { path: '/api/learning/node' },
    { path: '/api/learning/node?id=memory:memory:0' },
    { path: '/api/learning/node?id=../outside' },
    { path: '/api/learning/node?id=encoded%2Dskill' },
    { path: '/api/learning/node?id=my-skill&id=other' },
    { path: '/api/learning/node?id=my-skill&profile=other' },
    { path: '/api/learning/node?id=my-skill&local_skill_only=false' },
    { path: '/api/learning/node?id=my-skill', method: 'POST' },
    { path: '/api/learning/node', method: 'PUT', body: { id: 'my-skill', content: 'x', profile: 'other' } },
    { path: '/api/learning/node', method: 'PUT', body: { id: 'my-skill', content: 'x'.repeat(100_001) } },
    { path: '/api/learning/node', method: 'PUT', body: { id: 'memory:memory:0', content: 'x' } },
    { path: '/api/learning/node', method: 'DELETE', body: { id: 'my-skill', content: '' } },
    { path: '/api/learning/node?id=my-skill', method: 'DELETE', body: { id: 'other' } }
  ])('refuses caller-selected learned-skill authority %#', value => {
    expect(() => matrixPagesRequest(value)).toThrow('pages_request_forbidden')
  })

  it('forwards the four installed Skills and Toolsets routes with the native profile placeholder', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true })

    const requests = [
      { path: '/api/skills' },
      { path: '/api/skills/toggle', method: 'PUT' as const, body: { name: 'gif-search', enabled: false } },
      { path: '/api/tools/toolsets' },
      { path: '/api/tools/toolsets/image_gen', method: 'PUT' as const, body: { enabled: true } }
    ]

    for (const request of requests) {
      await forwardMatrixPagesRequest(request, call)
    }

    expect(call.mock.calls.map(([request]) => request)).toEqual([
      { path: '/api/skills?profile=default', method: 'GET' },
      {
        path: '/api/skills/toggle?profile=default',
        method: 'PUT',
        body: { name: 'gif-search', enabled: false }
      },
      { path: '/api/tools/toolsets?profile=default', method: 'GET' },
      {
        path: '/api/tools/toolsets/image_gen?profile=default',
        method: 'PUT',
        body: { enabled: true }
      }
    ])

    expect(
      matrixPagesRequest({ path: '/api/tools/toolsets/tool-set', method: 'PUT', body: { enabled: false } })
    ).toEqual({
      path: '/api/tools/toolsets/tool-set?profile=default',
      method: 'PUT',
      body: { enabled: false }
    })

    expect(
      matrixPagesRequest({
        path: '/api/skills/toggle',
        method: 'PUT',
        body: { name: 'Kỹ năng của tôi', enabled: true }
      })
    ).toEqual({
      path: '/api/skills/toggle?profile=default',
      method: 'PUT',
      body: { name: 'Kỹ năng của tôi', enabled: true }
    })
  })

  it('pins the native default profile placeholder on all accepted routes including the aggregate session route', () => {
    expect(matrixPagesRequest({ path: '/api/cron/jobs' })).toEqual({
      method: 'GET',
      path: '/api/cron/jobs?profile=default'
    })
    const sessions = matrixPagesRequest({ path: '/api/profiles/sessions?limit=999&offset=0&min_messages=1' })
    expect(sessions.path).toBe(
      '/api/profiles/sessions?limit=100&offset=0&min_messages=1&archived=exclude&order=recent&profile=default'
    )
    expect(matrixPagesRequest({ path: '/api/cron/jobs/abc_12/runs?limit=999' }).path).toBe(
      '/api/cron/jobs/abc_12/runs?limit=20&profile=default'
    )
    expect(matrixPagesRequest({ path: '/api/sessions/session-12/messages' }).path).toBe(
      '/api/sessions/session-12/messages?profile=default'
    )
  })

  it.each([
    '/api/config',
    '/api/env/reveal',
    '/api/skills?profile=all',
    '/api/skills?query=skills',
    '/api/skills?',
    '/api/skills?&',
    '/api/skills/%2e%2e',
    '/api/tools/toolsets?profile=all',
    '/api/tools/toolsets/image_gen?profile=all',
    '/api/tools/toolsets/image_gen%2fenv',
    '/api/tools/toolsets/../env',
    '/api/cron/jobs?profile=all',
    '/api/cron/jobs?profile=default',
    '/api/sessions/../secrets',
    '/api/sessions/%2e%2e/messages',
    '/api/sessions/a%2fb/messages',
    '/api/cron/jobs?limit=2',
    '//elsewhere/api/cron/jobs',
    'https://elsewhere/api/cron/jobs',
    '/api/cron/jobs/a/runs?limit=1&limit=2',
    '/api/profiles/sessions?full=true',
    '/api/sessions/a/messages?profile=other'
  ])('refuses %s before invoking a backend', async route => {
    const call = vi.fn()
    await expect(forwardMatrixPagesRequest({ path: route }, call)).rejects.toThrow('pages_request_forbidden')
    expect(call).not.toHaveBeenCalled()
  })

  it.each(['pause', 'resume', 'trigger'])(
    'forwards the existing %s action without extra execution machinery',
    action => {
      expect(matrixPagesRequest({ path: `/api/cron/jobs/fixture/${action}`, method: 'POST' })).toEqual({
        path: `/api/cron/jobs/fixture/${action}?profile=default`,
        method: 'POST'
      })
    }
  )

  it('accepts ordinary job CRUD and a script-only proof without provider/profile overrides', () => {
    const body = { schedule: '0 9 * * *', name: 'Fixture', prompt: 'Read local notes', deliver: 'local' }
    expect(matrixPagesRequest({ path: '/api/cron/jobs', method: 'POST', body }).body).toEqual(body)
    expect(
      matrixPagesRequest({
        path: '/api/cron/jobs',
        method: 'POST',
        body: {
          schedule: '2099-01-01T00:00:00',
          script: 'fixture.sh',
          no_agent: true,
          deliver: 'local'
        }
      }).body
    ).toMatchObject({ no_agent: true })
    expect(
      matrixPagesRequest({ path: '/api/cron/jobs/fixture', method: 'PUT', body: { updates: { name: 'Renamed' } } }).body
    ).toEqual({ updates: { name: 'Renamed' } })
    expect(matrixPagesRequest({ path: '/api/cron/jobs/fixture', method: 'DELETE' }).method).toBe('DELETE')
  })

  it.each([
    { profile: 'other' },
    { headers: {} },
    { url: 'https://elsewhere' },
    { body: { schedule: '* * * * *', profile: 'other' }, method: 'POST' },
    { body: { schedule: '* * * * *', base_url: 'https://elsewhere' }, method: 'POST' },
    { body: {}, method: 'GET' },
    { method: 'PATCH' }
  ])('rejects extra routing and unsupported fields %#', extra => {
    expect(() => matrixPagesRequest({ path: '/api/cron/jobs', ...extra })).toThrow('pages_request_forbidden')
  })

  it.each([
    { path: '/api/skills', method: 'POST' },
    { path: '/api/skills/toggle', method: 'GET' },
    { path: '/api/skills/toggle', method: 'PUT', body: { name: '', enabled: false } },
    { path: '/api/skills/toggle', method: 'PUT', body: { name: 'a'.repeat(65), enabled: false } },
    { path: '/api/skills/toggle', method: 'PUT', body: { name: 'bad\u0000name', enabled: false } },
    { path: '/api/skills/toggle', method: 'PUT', body: { name: 'gif-search', enabled: 'false' } },
    { path: '/api/skills/toggle', method: 'PUT', body: { name: 'gif-search', enabled: false, profile: 'other' } },
    { path: '/api/tools/toolsets', method: 'POST' },
    { path: '/api/tools/toolsets/image_gen', method: 'GET' },
    { path: '/api/tools/toolsets/image_gen', method: 'PUT', body: { enabled: 'true' } },
    { path: '/api/tools/toolsets/image_gen', method: 'PUT', body: { enabled: true, profile: 'other' } },
    { path: '/api/tools/toolsets/tool.set', method: 'PUT', body: { enabled: false } },
    { path: '/api/tools/toolsets/a/b', method: 'PUT', body: { enabled: false } }
  ])('refuses Skills and Toolsets mutations outside the exact contract %#', request => {
    expect(() => matrixPagesRequest(request)).toThrow('pages_request_forbidden')
  })
})

describe('scoped image preview', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })
  it('returns bounded image bytes, not arbitrary files or symlink escapes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'matrix-pages-media-'))
    roots.push(root)
    const home = path.join(root, 'agent')
    await mkdir(home)
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
    await writeFile(path.join(home, 'image.png'), image)
    await writeFile(path.join(root, 'outside.png'), image)
    await writeFile(path.join(home, 'not-image.png'), 'confidential configuration')
    await symlink(path.join(root, 'outside.png'), path.join(home, 'escape.png'))
    expect(await readMatrixPagesMedia(home, 'image.png')).toBe(`data:image/png;base64,${image.toString('base64')}`)

    for (const file of ['../outside.png', 'escape.png', 'not-image.png', 'https://example.com/image.png']) {
      await expect(readMatrixPagesMedia(home, file)).rejects.toThrow('pages_request_forbidden')
    }
  })
})
