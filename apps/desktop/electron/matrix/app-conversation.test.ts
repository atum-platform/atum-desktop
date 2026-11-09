import { expect, it, vi } from 'vitest'

import type { AppDescriptor } from '../../shared/app-catalog'
import type { MatrixSdkCommand } from '../../shared/matrix'
import { appChatCopy } from '../../shared/matrix-app-chat-copy'

import { connectAppRoom, createAppConversation } from './app-conversation'

function fixture() {
  let active = true
  const descriptor = { app: 'river', app_id: 'id', app_version_id: 'v1' } as AppDescriptor

  const host = (userId: string, deviceId: string) => ({
    identity: { userId, deviceId },
    queue: {
      command: vi.fn(
        async (value: MatrixSdkCommand): Promise<unknown> =>
          value.kind === 'create' || value.kind === 'createAppGroup'
            ? '!new:test'
            : value.kind === 'devices'
              ? [{ userId, deviceId, fingerprint: `${deviceId}-fingerprint`, verified: false }]
              : null
      )
    }
  })

  const human = host('@owner:test', 'OWNER')
  const app = host('@app:test', 'APP')

  const account = {
    identity: () => human.identity,
    appScope: () => ({ accountKey: 'owner', generation: 1 }),
    enrollApp: vi.fn(async () => ({
      state: 'ready' as const,
      identity: { ...app.identity, appId: descriptor.app_id, appVersionId: descriptor.app_version_id },
      selection: null
    }))
  }

  const deps = {
    descriptor: () => descriptor,
    account: account as unknown as Parameters<typeof createAppConversation>[0]['account'],
    human,
    start: vi.fn(async () => app),
    confirm: vi.fn(async () => true),
    active: () => active
  }

  return {
    deps,
    descriptor,
    human,
    app,
    account,
    deactivate: () => {
      active = false
    }
  }
}

it('discloses before enrollment, creates only a fresh encrypted DM and verifies native-owned devices', async () => {
  const f = fixture()
  expect(await createAppConversation(f.deps)).toBe('!new:test')
  expect(f.deps.confirm).toHaveBeenCalledWith(f.descriptor)
  expect(f.account.enrollApp).toHaveBeenCalledWith({ slug: 'river', appId: 'id', appVersionId: 'v1' }, true)
  expect(f.human.queue.command).toHaveBeenCalledWith({
    kind: 'create',
    name: '',
    direct: true,
    invite: ['@app:test'],
    appPair: true
  })
  expect(f.app.queue.command).toHaveBeenCalledWith({ kind: 'joinAgentRoom', roomId: '!new:test', ownerId: '@owner:test', scope: 'app' })
  expect(f.human.queue.command).toHaveBeenCalledWith({
    kind: 'verify',
    ...f.app.identity,
    fingerprint: 'APP-fingerprint',
    verified: false
  })
  expect(f.app.queue.command).toHaveBeenCalledWith({
    kind: 'verify',
    ...f.human.identity,
    fingerprint: 'OWNER-fingerprint',
    verified: false
  })
})

it('declining creates no credential, room or host', async () => {
  const f = fixture()
  f.deps.confirm.mockResolvedValue(false)
  expect(await createAppConversation(f.deps)).toBeNull()
  expect(f.account.enrollApp).not.toHaveBeenCalled()
  expect(f.deps.start).not.toHaveBeenCalled()
  expect(f.human.queue.command).not.toHaveBeenCalled()
})

it('uses a fresh trusted-only typed group creation after consent, initially inviting only the app', async () => {
  const f = fixture()
  expect(await createAppConversation({ ...f.deps, groupName: 'Team' })).toBe('!new:test')
  expect(f.human.queue.command).toHaveBeenCalledWith({ kind: 'createAppGroup', name: 'Team', app: '@app:test' })
  expect(f.deps.confirm.mock.invocationCallOrder[0]).toBeLessThan(f.account.enrollApp.mock.invocationCallOrder[0])
  expect(f.app.queue.command.mock.calls.filter(([c]) => c.kind === 'verify')).toHaveLength(1)
})

it('declining shared consent creates no enrollment, room or trust', async () => {
  const f = fixture()
  f.deps.confirm.mockResolvedValue(false)
  expect(await createAppConversation({ ...f.deps, groupName: 'Team' })).toBeNull()
  expect(f.account.enrollApp).not.toHaveBeenCalled()
  expect(f.human.queue.command).not.toHaveBeenCalled()
  expect(f.app.queue.command).not.toHaveBeenCalled()
})

it('rejects a stale enrolled version before starting a host or creating a room', async () => {
  const f = fixture()
  f.account.enrollApp.mockResolvedValue({
    state: 'ready',
    identity: { ...f.app.identity, appId: 'id', appVersionId: 'old' },
    selection: null
  })
  await expect(createAppConversation(f.deps)).rejects.toThrow('matrix_app_unavailable')
  expect(f.deps.start).not.toHaveBeenCalled()
  expect(f.human.queue.command).not.toHaveBeenCalled()
})

it.each(['owner', 'version'])('rejects a changed %s while disclosure is open', async mode => {
  const f = fixture()
  f.deps.confirm.mockImplementation(async () => {
    if (mode === 'owner') {
      f.deactivate()
    } else {
      f.descriptor.app_version_id = 'v2'
    }

    return true
  })
  await expect(createAppConversation(f.deps)).rejects.toThrow('matrix_app_cancelled')
  expect(f.account.enrollApp).not.toHaveBeenCalled()
})

it('does not join or verify an app into a rejected existing room', async () => {
  const f = fixture()
  f.human.queue.command.mockRejectedValueOnce(new Error('room denied'))
  await expect(connectAppRoom('!old:test', f.human, f.app, () => {})).rejects.toThrow('room denied')
  expect(f.app.queue.command).not.toHaveBeenCalled()
})

it('publication recovery only reads existing membership and never joins or verifies devices', async () => {
  const f = fixture()
  await connectAppRoom('!old:test', f.human, f.app, () => {}, true)

  for (const host of [f.human, f.app]) {
    expect(host.queue.command.mock.calls).toEqual([
      [
        {
          kind: 'readAppRoom',
          roomId: '!old:test',
          ownerId: f.human.identity.userId,
          agentId: f.app.identity.userId
        }
      ]
    ])
  }
})

it('normal sends require an already joined app and never accept a replacement invitation', async () => {
  const f = fixture()
  await connectAppRoom('!group:test', f.human, f.app, () => {})
  expect(f.human.queue.command).toHaveBeenCalledWith({
    kind: 'readAppRoom',
    roomId: '!group:test',
    ownerId: '@owner:test',
    agentId: '@app:test',
    allowInvite: false
  })
  expect(f.app.queue.command.mock.calls.some(([c]) => c.kind === 'joinAgentRoom')).toBe(false)
})

it.each(['__proto__', 'constructor', 'toString', 'unknown', undefined])(
  'uses complete English disclosure for unsupported locale %s',
  locale => {
    expect(appChatCopy(locale)).toBe(appChatCopy('en'))
    expect(appChatCopy(locale).disclosure).toBeTruthy()
  }
)

it('stops verification if the account changes during the device lookup', async () => {
  const f = fixture()
  let count = 0
  await expect(
    connectAppRoom('!new:test', f.human, f.app, () => {
      if (++count === 5) {
        throw Error('changed')
      }
    })
  ).rejects.toThrow('changed')
  expect(f.human.queue.command.mock.calls.some(([command]) => command.kind === 'verify')).toBe(false)
})
