import { describe, expect, it, vi } from 'vitest'

import type { MatrixEnrollment, MatrixIdentity, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import type { MatrixProfileSdkCommand } from '../../shared/matrix-profile'

import { MatrixAgentRuntime } from './agent-runtime'
import {
  matrixMainProfileHost,
  type MatrixMainProfilesSource,
  matrixMemberAvatarRoom,
  registerMatrixMemberAvatarIpc,
  registerMatrixProfilesIpc
} from './main-profiles'
import { MatrixProfiles } from './profile'
import type { MatrixHostRole } from './sdk-host'

const principal = '00000000-0000-4000-8000-bd7662a5eeb4'
const target = { kind: 'agent' as const, principal }

const photo = {
  kind: 'replace' as const,
  type: 'image/png' as const,
  bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
}

function fixture() {
  const owner = { userId: '@person:test', deviceId: 'HUMAN' }
  const identity = { userId: '@assistant:test', deviceId: 'AGENT' }
  const state: Pick<MatrixSnapshot, 'state' | 'identity'> = { state: 'ready', identity: owner }
  let stored: MatrixIdentity | null = owner
  let scope: { accountKey: string; generation: number } | null = { accountKey: 'account', generation: 1 }

  let enrollment: MatrixEnrollment = {
    state: 'ready',
    identity: {
      ...identity,
      principal: 'owner',
      agentPrincipal: principal,
      executorId: 'executor',
      issuer: 'https://auth.test',
      subject: 'subject',
      expiresAt: Date.now() + 60_000
    }
  }

  const account = { identity: () => stored, appScope: () => scope }
  const runtime = new MatrixAgentRuntime(`agent:${principal}`, principal)
  runtime.identity = identity
  const rows = [runtime]

  const human = {
    identity: owner,
    queue: { command: vi.fn(async (_command: MatrixProfileSdkCommand, _timeout?: number) => null as unknown) }
  }

  const agent = {
    identity,
    ready: true,
    queue: { command: vi.fn(async (_command: MatrixProfileSdkCommand, _timeout?: number) => null as unknown) }
  }

  const hosts = new Map<MatrixHostRole, typeof human | typeof agent>([
    ['human', human],
    [runtime.role, agent]
  ])

  let closing = false
  let blocked = false

  const source: MatrixMainProfilesSource = {
    account: () => account,
    state: () => state,
    closing: () => closing,
    hosts,
    agents: () => rows,
    enrollment: () => enrollment,
    blocked: () => blocked
  }

  const profiles = new MatrixProfiles({ resolve: target => matrixMainProfileHost(source, target) })

  return {
    source,
    profiles,
    owner,
    identity,
    state,
    human,
    agent,
    hosts,
    rows,
    runtime,
    setStored: (value: MatrixIdentity | null) => {
      stored = value
    },
    setScope: (value: typeof scope) => {
      scope = value
    },
    setEnrollment: (value: MatrixEnrollment) => {
      enrollment = value
    },
    enrollment: () => enrollment,
    close: () => {
      closing = true
    },
    block: () => {
      blocked = true
    }
  }
}

describe('actual native own-profile binding', () => {
  it('keeps human photos independent of domain enrollment and withdrawn default agent', async () => {
    const f = fixture()
    f.setScope(null)
    f.setEnrollment({ state: 'withdrawn', identity: null })
    const host = matrixMainProfileHost(f.source, { kind: 'human' })!
    expect(host.current()).toBe(true)
    await host.command({ kind: 'profileRead' })
    expect(f.human.queue.command).toHaveBeenCalledWith({ kind: 'profileRead' }, 60_000)
    expect(f.agent.queue.command).not.toHaveBeenCalled()
    expect(matrixMainProfileHost(f.source, target)).toBeUndefined()
  })

  it('uses the existing agent own session without requiring a Hermes process or lease', async () => {
    const f = fixture()
    expect(f.runtime.executor).toBeUndefined()
    expect(f.runtime.lease).toBeUndefined()
    const host = matrixMainProfileHost(f.source, target)!
    expect(host.identity).toEqual(f.identity)
    await host.command({ kind: 'profileRead' })
    expect(f.agent.queue.command).toHaveBeenCalledWith({ kind: 'profileRead' }, 60_000)
    expect(f.human.queue.command).not.toHaveBeenCalled()
  })

  it.each(['absent', 'pending', 'expired', 'revoking', 'withdrawn'] as const)('refuses agent enrollment %s', state => {
    const f = fixture()
    f.setEnrollment({ ...f.enrollment(), state })
    expect(matrixMainProfileHost(f.source, target)).toBeUndefined()
  })

  const mutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ['sign out', f => f.setStored(null)],
    ['human device change', f => f.setStored({ ...f.owner, deviceId: 'NEW' })],
    [
      'human offline',
      f => {
        f.state.state = 'connecting'
      }
    ],
    [
      'human host replacement',
      f => {
        f.hosts.set('human', { ...f.human })
      }
    ],
    [
      'agent host replacement',
      f => {
        f.hosts.set(f.runtime.role, { ...f.agent })
      }
    ],
    [
      'agent offline',
      f => {
        f.agent.ready = false
      }
    ],
    [
      'roster removal',
      f => {
        f.rows.length = 0
      }
    ],
    [
      'closed runtime',
      f => {
        f.runtime.closed = true
      }
    ],
    ['retirement in progress', f => f.block()],
    ['account generation change', f => f.setScope({ accountKey: 'account', generation: 2 })],
    ['domain removed', f => f.setScope(null)],
    ['enrollment withdrawn', f => f.setEnrollment({ state: 'withdrawn', identity: null })],
    [
      'executor replaced',
      f => f.setEnrollment({ ...f.enrollment(), identity: { ...f.enrollment().identity!, executorId: 'new' } })
    ],
    ['app quitting', f => f.close()]
  ]

  it.each(mutations)('cuts a pending upload before profile commit after %s', async (_name, mutate) => {
    const f = fixture()
    let finish!: () => void

    const pending = new Promise<void>(resolve => {
      finish = resolve
    })

    f.agent.queue.command.mockImplementation(async command => (command.kind === 'profileUpload' ? pending : null))
    const editor = await f.profiles.open(target)
    const operation = f.profiles.change(editor.scope, photo)
    mutate(f)
    finish()
    await expect(operation).rejects.toThrow('matrix_profile_stale')
    expect(f.agent.queue.command.mock.calls.map(([command]) => command.kind)).not.toContain('profileCommit')
  })

  it('allows expiry-only renewal through the actual upload/commit controller', async () => {
    const f = fixture()
    f.agent.queue.command.mockImplementation(async command => {
      if (command.kind === 'profileUpload') {
        f.setEnrollment({
          ...f.enrollment(),
          identity: { ...f.enrollment().identity!, expiresAt: Date.now() + 120_000 }
        })
      }

      return command.kind === 'profileCommit'
        ? { profile: { userId: f.identity.userId, displayName: 'Assistant', avatarMxc: 'mxc://test/photo' }, photo }
        : null
    })
    const editor = await f.profiles.open(target)
    const result = await f.profiles.change(editor.scope, photo)
    expect(result.avatarUrl).toMatch(/^data:image\/png;base64,/)
    expect(f.agent.queue.command.mock.calls.map(([command]) => command.kind)).toEqual([
      'profileOpen',
      'profileUpload',
      'profileCommit'
    ])
  })

  it('rejects ambiguous roster principals and cross-session enrollment', () => {
    const f = fixture()
    f.rows.push(new MatrixAgentRuntime('agent', principal))
    expect(matrixMainProfileHost(f.source, target)).toBeUndefined()
    f.rows.pop()
    f.setEnrollment({ ...f.enrollment(), identity: { ...f.enrollment().identity!, userId: '@other:test' } })
    expect(matrixMainProfileHost(f.source, target)).toBeUndefined()
  })

  it('guards the open chat member avatar read before it reaches the SDK', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipc = { handle: vi.fn((name, fn) => handlers.set(name, fn)), removeHandler: vi.fn() }
    const read = vi.fn(async (userId: unknown) => ({ userId: String(userId), avatarUrl: null }))
    const guard = vi.fn()

    registerMatrixMemberAvatarIpc(ipc, read, guard)
    expect([...handlers.keys()]).toEqual(['matrix:profiles:member'])
    await expect(handlers.get('matrix:profiles:member')!({}, '@linh:test')).resolves.toEqual({
      userId: '@linh:test',
      avatarUrl: null
    })
    expect(guard).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledWith('@linh:test')
  })

  it('resolves a roster peer avatar from any joined room, preferring the open chat', () => {
    const room = (
      id: string,
      participants: MatrixRoom['participants'],
      membership: MatrixRoom['membership'] = 'join'
    ): MatrixRoom => ({ id, name: id, membership, encrypted: false, participants })
    const owner = { userId: '@person:test', membership: 'join' }
    const moon = { userId: '@app-moon:test', membership: 'join' }
    const andy = { userId: '@app-andy:test', membership: 'join' }
    const state = {
      roomId: '!open:test',
      rooms: [
        room('!open:test', [owner, moon]),
        room('!moon-old:test', [owner, moon]),
        room('!andy:test', [owner, andy]),
        room('!invite:test', [owner, { userId: '@elsewhere:test', membership: 'join' }], 'invite')
      ]
    }

    expect(matrixMemberAvatarRoom(state, '@app-moon:test')).toBe('!open:test')
    expect(matrixMemberAvatarRoom(state, '@app-andy:test')).toBe('!andy:test')
    expect(matrixMemberAvatarRoom(state, '@elsewhere:test')).toBeUndefined()
  })

  it('guards every real IPC operation before touching the controller', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipc = { handle: vi.fn((name, fn) => handlers.set(name, fn)), removeHandler: vi.fn() }
    const f = fixture()

    const guard = vi.fn(() => {
      throw new Error('foreign')
    })

    registerMatrixProfilesIpc(ipc, f.profiles, guard)
    expect([...handlers.keys()]).toEqual([
      'matrix:profiles:read',
      'matrix:profiles:open',
      'matrix:profiles:change',
      'matrix:profiles:close'
    ])

    for (const handler of handlers.values()) {
      expect(() => handler({}, target, photo)).toThrow('foreign')
    }

    expect(f.agent.queue.command).not.toHaveBeenCalled()
    expect(f.human.queue.command).not.toHaveBeenCalled()
  })
})
