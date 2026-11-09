// @vitest-environment node
import { createClient, MemoryStore } from 'matrix-js-sdk'
import { expect, it, vi } from 'vitest'

import { type MatrixProfileHost, MatrixProfiles } from '../../electron/matrix/profile'
import type { MatrixSdkCommand } from '../../shared/matrix'
import type { MatrixProfileSdkCommand, MatrixProfileTarget } from '../../shared/matrix-profile'

import { matrixProfile } from './profile'
import { connectMatrixSdk } from './sdk-host-queue'
import { serveMatrixSdk } from './sdk-host-serve'

const a = '00000000-0000-4000-8000-bd7662a5eeb4'
const b = '00000000-0000-4000-8000-b454f82c5857'
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const replacement = { kind: 'replace' as const, type: 'image/png' as const, bytes: png }

function deferred() {
  let resolve!: () => void

  return {
    promise: new Promise<void>(done => {
      resolve = done
    }),
    resolve: () => resolve()
  }
}

/** Real SDK HTTP plus the shipped copy/command/result seam; only the homeserver
 * transport and crypto/store startup are injected. No installed-app/account proof. */
function fixture() {
  const writes: string[] = []
  const uploads: string[] = []
  let held: Promise<void> | undefined
  let refuse = false
  const hosts = new Map<string, MatrixProfileHost>()
  const engines: Array<ReturnType<typeof connectMatrixSdk>> = []
  const active = new Set(['human', a, b])

  for (const key of active) {
    const userId = key === 'human' ? '@human:test' : key === a ? '@agent-a:test' : '@agent-b:test'
    const identity = { userId, deviceId: 'MAC' }
    let avatar = ''

    const client = createClient({
      baseUrl: 'https://matrix.test',
      ...identity,
      accessToken: `${key}-test-token`,
      store: new MemoryStore(),
      logger: {
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
        getChild() {
          return this
        }
      },
      fetchFn: async (input, init) => {
        const url = new URL(String(input))
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}-test-token`)

        if (url.pathname.endsWith('/upload')) {
          uploads.push(key)

          if (held) {
            await held
          }

          return Response.json({ content_uri: `mxc://matrix.test/${key}-photo` })
        }

        if (url.pathname.includes('/media/download/')) {
          return new Response(png)
        }

        if (init?.method === 'PUT') {
          if (refuse) {
            return Response.json({ errcode: 'M_UNKNOWN' }, { status: 500 })
          }

          avatar = JSON.parse(init.body as string).avatar_url
          writes.push(key)

          return Response.json({})
        }

        return Response.json({ displayname: key === 'human' ? 'Minh' : 'Atum', avatar_url: avatar })
      }
    })

    const profile = matrixProfile(
      client,
      () => active.has(key),
      () => {}
    )

    const engine = connectMatrixSdk({
      configuration: async () => ({
        ...identity,
        baseUrl: 'https://matrix.test',
        accessToken: `${key}-test-token`,
        storageKey: key
      }),
      refresh: async () => ({ ok: false, reauthenticate: true }),
      snapshot() {}
    })

    serveMatrixSdk(engine.port, async () => ({
      command: async (command: MatrixSdkCommand) => profile.command(command as MatrixProfileSdkCommand),
      renewed: async () => false,
      stop: async () => profile.stop()
    }))
    engines.push(engine)
    hosts.set(key, { identity, current: () => active.has(key), command: command => engine.queue.command(command) })
  }

  const resolve = vi.fn((target: MatrixProfileTarget) =>
    hosts.get(target.kind === 'human' ? 'human' : target.principal)
  )

  const changed = vi.fn()
  const controller = new MatrixProfiles({ resolve, changed })

  return {
    controller,
    active,
    writes,
    uploads,
    resolve,
    changed,
    hold(value?: Promise<void>) {
      held = value
    },
    refuse(value: boolean) {
      refuse = value
    },
    async stop() {
      controller.stop()
      await Promise.all(engines.map(engine => engine.queue.stop()))
    }
  }
}

it('binds human and each owned agent to its own SDK session and returns only authenticated safe image bytes', async () => {
  const f = fixture()

  try {
    for (const target of [
      { kind: 'human' },
      { kind: 'agent', principal: a },
      { kind: 'agent', principal: b }
    ] as const) {
      const { scope } = await f.controller.open(target)
      const before = await f.controller.read(target)
      expect(before.avatarUrl).toBeNull()
      const result = await f.controller.change(scope, replacement)
      expect(result.avatarUrl).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`)
      expect(result.userId).toBe(before.userId)
      expect((await f.controller.read(target)).avatarUrl).toBe(result.avatarUrl)
      await f.controller.change(scope, { kind: 'remove' })
    }

    expect(f.writes).toEqual(['human', 'human', a, a, b, b])
    expect(f.uploads).toEqual(['human', a, b])
  } finally {
    await f.stop()
  }
})

it.each(['close', 'switch', 'retire'] as const)(
  'prevents the final SDK write when upload finishes after %s',
  async ending => {
    const f = fixture(),
      held = deferred()

    try {
      const { scope } = await f.controller.open({ kind: 'agent', principal: a })
      f.hold(held.promise)
      const change = f.controller.change(scope, replacement)
      const rejected = expect(change).rejects.toThrow()
      await vi.waitFor(() => expect(f.uploads).toEqual([a]))

      if (ending === 'close') {
        await f.controller.close(scope)
      }

      if (ending === 'switch') {
        await f.controller.open({ kind: 'agent', principal: b })
        await f.controller.open({ kind: 'agent', principal: a })
      }

      if (ending === 'retire') {
        f.active.delete(a)
      }

      held.resolve()
      await rejected
      expect(f.writes).toEqual([])
    } finally {
      held.resolve()
      await f.stop()
    }
  }
)

it('rejects unknown/app targets, stale tokens and concurrent changes without choosing another identity', async () => {
  const f = fixture(),
    held = deferred()

  try {
    await expect(f.controller.open({ kind: 'app', principal: a })).rejects.toThrow('invalid')
    await expect(
      f.controller.open({ kind: 'agent', principal: '00000000-0000-4000-8000-f6222a1106ee' })
    ).rejects.toThrow('unavailable')
    const { scope } = await f.controller.open({ kind: 'human' })
    await expect(f.controller.change('not-the-scope', replacement)).rejects.toThrow('stale')
    f.hold(held.promise)
    const first = f.controller.change(scope, replacement)
    await expect(f.controller.change(scope, replacement)).rejects.toThrow('pending')
    held.resolve()
    await first
    expect(f.writes).toEqual(['human'])
  } finally {
    held.resolve()
    await f.stop()
  }
})

it('retries a staged failed commit in the same editor without upload or agent recreation', async () => {
  const f = fixture()

  try {
    const { scope } = await f.controller.open({ kind: 'agent', principal: a })
    f.refuse(true)
    await expect(f.controller.change(scope, replacement)).rejects.toThrow()
    f.refuse(false)
    await f.controller.change(scope, replacement)
    expect(f.uploads).toEqual([a])
    expect(f.writes).toEqual([a])
  } finally {
    await f.stop()
  }
})

it('rechecks account/host generation after a read, even if the same user returns', async () => {
  let generation = 0
  const held = deferred()

  const host = {
    identity: { userId: '@human:test', deviceId: 'MAC' },
    current: () => generation === 0,
    command: async () => {
      await held.promise

      return { profile: { userId: '@human:test', displayName: 'Minh', avatarMxc: null } }
    }
  }

  const controller = new MatrixProfiles({ resolve: () => host })
  const read = controller.read({ kind: 'human' })
  generation++
  held.resolve()
  await expect(read).rejects.toThrow('stale')
})
