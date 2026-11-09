import { expect, it, vi } from 'vitest'

import { type MatrixProfileHost, MatrixProfiles } from './profile'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const replace = { kind: 'replace', type: 'image/png', bytes: png }
const profile = { userId: '@human:test', displayName: 'Minh', avatarMxc: 'mxc://matrix.test/photo' }

function fixture() {
  let current = true

  const command = vi.fn<MatrixProfileHost['command']>(async value =>
    value.kind === 'profileRead' || value.kind === 'profileCommit'
      ? { profile, photo: { type: 'image/png', bytes: png } }
      : null
  )

  const host = { identity: { userId: '@human:test', deviceId: 'MAC' }, current: () => current, command }
  const controller = new MatrixProfiles({ resolve: target => (target.kind === 'human' ? host : undefined) })

  return {
    controller,
    command,
    retire() {
      current = false
    }
  }
}

it('validates bytes and ownership before forwarding a native-owned scope', async () => {
  const f = fixture()
  await expect(f.controller.open({ kind: 'app', principal: 'app' })).rejects.toThrow('invalid')
  await expect(f.controller.open({ kind: 'agent', principal: '00000000-0000-4000-8000-bd7662a5eeb4' })).rejects.toThrow(
    'unavailable'
  )
  const { scope } = await f.controller.open({ kind: 'human', userId: '@other:test' })
  await expect(
    f.controller.change(scope, { kind: 'replace', type: 'image/png', bytes: new TextEncoder().encode('<svg/>') })
  ).rejects.toThrow('type')
  expect(f.command).toHaveBeenCalledExactlyOnceWith({ kind: 'profileOpen', scope })
  f.controller.stop()
})

it('only projects authenticated image bytes, never a different SDK user or arbitrary media URL', async () => {
  const f = fixture()
  expect((await f.controller.read({ kind: 'human' })).avatarUrl).toBe(
    `data:image/png;base64,${Buffer.from(png).toString('base64')}`
  )
  f.command.mockResolvedValueOnce({ profile: { ...profile, userId: '@other:test' } })
  await expect(f.controller.read({ kind: 'human' })).rejects.toThrow('invalid')
  f.command.mockResolvedValueOnce({ profile: { ...profile, avatarMxc: 'https://untrusted.test/image' } })
  await expect(f.controller.read({ kind: 'human' })).rejects.toThrow('invalid')
})

it('revokes the token synchronously even while SDK discard is awaiting acknowledgement', async () => {
  const f = fixture()
  const { scope } = await f.controller.open({ kind: 'human' })
  let release!: () => void
  f.command.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        release = resolve
      })
  )
  const close = f.controller.close(scope)
  await expect(f.controller.change(scope, replace)).rejects.toThrow('stale')
  release()
  await close
})

it('refuses a retired account host before SDK upload or commit', async () => {
  const f = fixture()
  const { scope } = await f.controller.open({ kind: 'human' })
  f.retire()
  await expect(f.controller.change(scope, replace)).rejects.toThrow('stale')
  expect(f.command).toHaveBeenCalledOnce()
  f.controller.stop()
})

it('changes the person’s own name through the bound SDK session, validated, and never an agent’s', async () => {
  const f = fixture()
  f.command.mockImplementation(async value =>
    value.kind === 'profileName' ? { profile: { ...profile, displayName: value.displayName } } : null
  )
  const changed = vi.fn()

  const agentHost = {
    identity: { userId: '@agent:test', deviceId: 'AGENT' },
    current: () => true,
    command: vi.fn(async () => null)
  }

  const controller = new MatrixProfiles({
    resolve: target => (target.kind === 'human' ? { ...agentHost, identity: { userId: '@human:test', deviceId: 'MAC' }, command: f.command } : agentHost),
    changed
  })

  const { scope } = await controller.open({ kind: 'human' })
  await expect(controller.change(scope, { kind: 'name', displayName: '   ' })).rejects.toThrow('name_invalid')
  await expect(controller.change(scope, { kind: 'name', displayName: 'x'.repeat(65) })).rejects.toThrow('name_invalid')
  const next = await controller.change(scope, { kind: 'name', displayName: '  An Example ' })
  expect(next.displayName).toBe('An Example')
  expect(f.command).toHaveBeenLastCalledWith({ kind: 'profileName', scope, displayName: 'An Example' })
  expect(changed).toHaveBeenCalledWith({ kind: 'human' }, expect.objectContaining({ displayName: 'An Example' }))

  const agent = await controller.open({ kind: 'agent', principal: '00000000-0000-4000-8000-bd7662a5eeb4' })
  await expect(controller.change(agent.scope, { kind: 'name', displayName: 'Renamed' })).rejects.toThrow(
    'name_unavailable'
  )
  expect(agentHost.command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'profileName' }))
  controller.stop()
})
