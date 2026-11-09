import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppBotDescriptor, AppDescriptor } from '../../../shared/app-catalog'
import { ACME, ACME_GUEST, botAppWire, botUserOf } from '../../../shared/app-catalog.test-support'
import type { AppBotDmOpened } from '../../../shared/matrix-app-bot-dm'
import { createMatrixApps } from '../app-workspace'

import {
  appBotChatHiddenLine,
  appBotChatHideFailedLine,
  appBotChatSelectedLine,
  localAppChatRoom,
  logAppChatFailures,
  type ResolveAppChatRoom,
  startAppChat
} from './open-chat'

const bytes = Buffer.from('signed bot portrait')

const avatar = {
  url: 'https://deployment.example.invalid/specialists/moon.png',
  sha256: createHash('sha256').update(bytes).digest('hex')
}

const bot: AppBotDescriptor = {
  v: 1,
  user_id: '@app-moon:atumplatform.com',
  handle: 'moon_bot',
  display_name: 'Moon',
  avatar,
  device_generation: 1,
  device: { device_id: 'MOON_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
  state: 'active',
  groups: true,
  consent: 'required',
  disclosure_version: 1,
  open_route_id: 'chat',
  open_shared_memory: true,
  purchase_route_id: 'chat'
}

const app: AppDescriptor = {
  app: 'moon',
  app_id: '00000000-0000-4000-8000-e79acd97ac88',
  app_version_id: '00000000-0000-4000-8000-5ba39b7cfa53',
  name: { en: 'Moon' },
  subtitle: null,
  description: null,
  icon: null,
  accent: null,
  affiliation: 'first_party',
  verified: true,
  availability: 'available',
  roster_default: true,
  roster_order: 1,
  supported_modes: [],
  matrix_room_context: 'addressed_only',
  has_surface: true,
  link: { mode: 'external_account', state: 'never_linked' },
  bot
}

afterEach(() => vi.unstubAllGlobals())

async function fixture(descriptor: AppDescriptor = app) {
  let scope: { accountKey: string; generation: number } | null = { accountKey: 'owner', generation: 1 }
  let current = descriptor
  const appRequest = vi.fn(async () => ({ profile: 'atum.app-catalog/1', apps: [current] }))
  const fetcher = vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))
  vi.stubGlobal('fetch', fetcher)

  const apps = createMatrixApps({
    account: { readDomain: async () => {}, appScope: () => scope, appRequest } as never,
    views: () => ({ revokeApp: async () => {}, revokeAccount: async () => {} }) as never,
    resource: 'https://api.atumplatform.com/api/matrix/v1',
    openExternal: async () => {},
    changed: () => {},
    catalogChanged: async () => {}
  })

  await apps.refresh()

  const command = vi.fn(async (request: { kind: string }): Promise<unknown> =>
    request.kind === 'openAppBotDm'
      ? { roomId: '!moon:test', outcome: 'reused', reason: 'pointer', joined: 1, left: 3, pointer: 'kept', shown: 'none' }
      : null
  )

  const log = vi.fn<(line: string) => void>()

  const port = {
    descriptor: () => apps.botChat(app.app_id),
    current: () => true,
    resolveRoom: localAppChatRoom(command),
    slug: 'moon',
    log
  }

  return {
    apps,
    port,
    command,
    log,
    appRequest,
    fetcher,
    switchAccount: () => {
      scope = { accountKey: 'other', generation: 2 }
    },
    refresh: async (next: AppDescriptor) => {
      current = next
      await apps.refresh()
    }
  }
}

describe('official bot first use through the native catalog authority', () => {
  it.each(['never_linked', 'unlinked'] as const)(
    'opens setup for a %s account without authorizing a turn',
    async state => {
      const f = await fixture({ ...app, link: { ...app.link, state } })
      expect(() => f.apps.participant(app.app_id)).toThrow('matrix_app_unavailable')
      expect(await startAppChat(f.port)).toBe('!moon:test')
      expect(f.command.mock.calls.map(([request]) => request.kind)).toEqual(['openAppBotDm'])
      expect(f.apps.botChat(app.app_id).bot?.consent).toBe('required')
      expect(f.apps.botChat(app.app_id).link.state).toBe(state)
      expect(f.appRequest).toHaveBeenCalledTimes(1) // catalog only: no consent, link, provider turn or send
      expect(() => f.apps.participant(app.app_id)).toThrow('matrix_app_unavailable')
    }
  )

  it.each([
    ['paused', 'matrix_app_bot_paused'],
    ['starting', 'matrix_app_bot_starting'],
    ['unavailable', 'matrix_app_bot_resting']
  ] as const)('does not pin or open a %s bot, and says why (%s)', async (state, code) => {
    const f = await fixture({ ...app, bot: { ...bot, state, ...(state === 'starting' ? { device: null } : {}) } })
    await expect(startAppChat(f.port)).rejects.toThrow(code)
    expect(f.command).not.toHaveBeenCalled()
  })

  // Production served Moon and Andy with `apps.room_context_profile` = `atum.turn-room/2`, so the
  // catalog said no room context, and every official DM refused with a bare "that didn't work".
  // The bot's own row carries its group profile (atum-app-bots v1 §6.2).
  it.each([null, undefined])('opens the official DM whatever the operator-set room context (%s)', async context => {
    const f = await fixture({ ...app, matrix_room_context: context })
    expect(await startAppChat(f.port)).toBe('!moon:test')
    expect(f.command.mock.calls.map(([request]) => request.kind)).toEqual(['openAppBotDm'])
    // The per-person participant path keeps its room-context gate: this bot is not linked yet.
    expect(() => f.apps.participant(app.app_id)).toThrow('matrix_app_unavailable')
  })

  it('refuses unavailable apps and legacy participants', async () => {
    for (const descriptor of [
      { ...app, availability: 'unavailable' as const },
      { ...app, bot: null }
    ]) {
      const f = await fixture(descriptor)
      await expect(startAppChat(f.port)).rejects.toThrow('matrix_app_bot_unavailable')
      expect(f.command).not.toHaveBeenCalled()
    }
  })

  // 0.20: the chat it opens is plain, so opening never waits on the bot's device being pinned,
  // and a device this Mac could not verify no longer stops it.
  it('opens without a device check, even for a device this Mac never verified', async () => {
    const f = await fixture({
      ...app,
      bot: { ...bot, device_generation: 7, device: { ...bot.device!, device_id: 'MOON_NEW' } }
    })

    f.command.mockImplementation(async request => {
      if (request.kind === 'verify') {
        throw new Error('matrix_app_bot_untrusted')
      }

      const opened = { roomId: '!moon:test', outcome: 'reused', reason: 'pointer', joined: 1, left: 0 }

      return request.kind === 'openAppBotDm' ? { ...opened, pointer: 'kept', shown: 'none' } : null
    })
    expect(await startAppChat(f.port)).toBe('!moon:test')
    expect(f.command.mock.calls.map(([request]) => request.kind)).toEqual(['openAppBotDm'])
  })

  it('opens nothing once the account changed or the app quit', async () => {
    const f = await fixture()
    f.port.current = () => false
    await expect(startAppChat(f.port)).rejects.toThrow('matrix_not_ready')
    expect(f.command).not.toHaveBeenCalled()
  })

  it('projects a digest-checked bot portrait without leaking its remote URL into the renderer snapshot', async () => {
    const f = await fixture()
    await vi.waitFor(() =>
      expect(f.apps.snapshot().apps[0].bot?.avatar.url).toBe(`data:image/png;base64,${bytes.toString('base64')}`)
    )
    expect(f.apps.botChat(app.app_id).bot?.avatar.url).toBe(avatar.url)
    expect(f.fetcher).toHaveBeenCalledWith(
      avatar.url,
      expect.objectContaining({ redirect: 'error', credentials: 'omit' })
    )
    f.switchAccount()
    expect(f.apps.snapshot().apps).toEqual([])
  })
})

describe('the one main.log line each open writes', () => {
  const hash = (roomId: string) => createHash('sha256').update(roomId).digest('hex').slice(0, 12)

  it('names the outcome with closed codes and a room hash, never the room id', async () => {
    const f = await fixture()
    expect(await startAppChat(f.port)).toBe('!moon:test')
    expect(f.log.mock.calls).toEqual([
      [`[Matrix] app bot open app=moon outcome=reused reason=pointer room=${hash('!moon:test')} joined=1 left=3 pointer=kept shown=none`]
    ])
    expect(f.log.mock.calls.flat().join('\n')).not.toContain('!moon:test')
  })

  it('logs a refused open with its closed code', async () => {
    const f = await fixture({ ...app, bot: { ...bot, state: 'paused' } })
    await expect(startAppChat(f.port)).rejects.toThrow('matrix_app_bot_paused')
    expect(f.log.mock.calls).toEqual([['[Matrix] app bot open app=moon outcome=failed code=matrix_app_bot_paused']])
  })

  it('never writes raw error text', async () => {
    const f = await fixture()
    f.command.mockRejectedValueOnce(new Error('M_FORBIDDEN: @owner:test cannot join !old:test'))
    await expect(startAppChat(f.port)).rejects.toThrow()
    expect(f.log.mock.calls).toEqual([['[Matrix] app bot open app=moon outcome=failed code=matrix_operation_failed']])
  })

  it('opens nothing on an answer that is not one', async () => {
    const f = await fixture()
    f.command.mockImplementation(async request => (request.kind === 'openAppBotDm' ? '!moon:test' : null))
    await expect(startAppChat(f.port)).rejects.toThrow('matrix_app_bot_dm_invalid')
    expect(f.log.mock.calls).toEqual([['[Matrix] app bot open app=moon outcome=failed code=matrix_app_bot_dm_invalid']])
  })

  // The wait for the room holds nothing up, so the person can sign out meanwhile. The open that ends
  // because of that opened nothing, and the window is on the sign-in screen: nothing to tell it.
  describe('when the account it was for is gone', () => {
    it('ends with nothing opened and no error, and still writes its one line with the closed code', async () => {
      const f = await fixture()
      f.command.mockRejectedValueOnce(new Error('matrix_sdk_stopped'))

      await expect(startAppChat({ ...f.port, ended: () => true })).resolves.toBeNull()
      expect(f.log.mock.calls).toEqual([['[Matrix] app bot open app=moon outcome=failed code=matrix_sdk_stopped']])
    })

    it('reports a failure as before while the account is the same', async () => {
      const f = await fixture()
      f.command.mockRejectedValueOnce(new Error('matrix_app_bot_syncing'))

      await expect(startAppChat({ ...f.port, ended: () => false })).rejects.toThrow('matrix_app_bot_syncing')
      expect(f.log.mock.calls).toEqual([['[Matrix] app bot open app=moon outcome=failed code=matrix_app_bot_syncing']])
    })

    it('is asked only when the open failed: an open that opened is not second-guessed', async () => {
      const f = await fixture()
      const ended = vi.fn(() => true)

      await expect(startAppChat({ ...f.port, ended })).resolves.toBe('!moon:test')
      expect(ended).not.toHaveBeenCalled()
    })

    it('does not let the wrapper write the failure a second time, since nothing is thrown', async () => {
      const f = await fixture()
      f.command.mockRejectedValueOnce(new Error('matrix_sdk_stopped'))

      const w = logAppChatFailures(async (_event: unknown, _request: { kind?: string; appId?: unknown }) =>
        startAppChat({ ...f.port, ended: () => true })
      , { slug: () => 'moon', log: f.log })

      await expect(w({}, { kind: 'appChat', appId: app.app_id })).resolves.toBeNull()
      expect(f.log).toHaveBeenCalledOnce()
    })
  })

  it('writes Delete chat on a bot chat as kept, and nothing for any other chat', () => {
    expect(appBotChatHiddenLine({ outcome: 'hidden', appId: app.app_id }, '!moon:test', () => 'moon')).toBe(
      `[Matrix] app bot chat hidden app=moon room=${hash('!moon:test')}`
    )
    expect(appBotChatHiddenLine(null, '!friends:test', () => 'moon')).toBeNull()
  })

  it('writes a failed Delete chat on a bot chat with its closed code only, and nothing for any other chat', () => {
    const raw = new Error('M_UNKNOWN: !moon:test account data refused')

    expect(appBotChatHideFailedLine({ appId: app.app_id }, () => 'moon', raw)).toBe(
      '[Matrix] app bot chat hide failed app=moon code=matrix_operation_failed'
    )
    expect(appBotChatHideFailedLine({ appId: app.app_id }, () => 'moon', new Error('matrix_membership_required'))).toBe(
      '[Matrix] app bot chat hide failed app=moon code=matrix_membership_required'
    )
    expect(appBotChatHideFailedLine(undefined, () => 'moon', raw)).toBeNull()
  })

  it('writes a bot chat opened as a plain chat with the bot state and a room hash, and nothing for any other chat', () => {
    const line = appBotChatSelectedLine({ appId: app.app_id }, '!moon:test', () => ({ slug: 'moon', bot: 'paused' }))

    expect(line).toBe(`[Matrix] app bot chat selected app=moon bot=paused room=${hash('!moon:test')}`)
    expect(appBotChatSelectedLine({ appId: app.app_id }, '!moon:test', () => undefined)).toBe(
      `[Matrix] app bot chat selected app=unknown bot=unknown room=${hash('!moon:test')}`
    )
    expect(appBotChatSelectedLine(undefined, '!friends:test', () => ({ slug: 'moon', bot: 'active' }))).toBeNull()
  })
})

// A click that reports nothing is the worst failure: main writes a line for an app's chat that fails
// anywhere, including before `startAppChat` is reached.
describe('the line a failed app chat leaves wherever it failed', () => {
  type Request = { kind?: string; appId?: unknown }
  const slugs = new Map([[app.app_id, 'moon']])

  function wrapped(handler: (request: Request) => Promise<unknown>, slug = (id: string) => slugs.get(id)) {
    const log = vi.fn<(line: string) => void>()
    const handle = logAppChatFailures(async (_event: unknown, request: Request) => handler(request), { slug, log })

    return { log, run: (request: Request) => handle({}, request) }
  }

  it('writes the app and the closed code for a failure that never reached the open', async () => {
    const refusal = new Error('matrix_not_ready')

    const w = wrapped(async () => {
      throw refusal
    })

    // The failure is rethrown as it was.
    await expect(w.run({ kind: 'appChat', appId: app.app_id })).rejects.toBe(refusal)
    expect(w.log.mock.calls).toEqual([['[Matrix] app bot open app=moon outcome=failed code=matrix_not_ready']])
  })

  it('says "unknown" for an id main has no app for, and for a request with no id at all', async () => {
    const w = wrapped(async () => {
      throw new Error('matrix_app_bot_unavailable')
    })

    await expect(w.run({ kind: 'appChat', appId: '00000000-0000-4000-8000-312b5144c37f' })).rejects.toThrow()
    await expect(w.run({ kind: 'appChat' })).rejects.toThrow()
    await expect(w.run({ kind: 'appChat', appId: 42 })).rejects.toThrow()
    expect(w.log.mock.calls).toEqual([
      ['[Matrix] app bot open app=unknown outcome=failed code=matrix_app_bot_unavailable'],
      ['[Matrix] app bot open app=unknown outcome=failed code=matrix_app_bot_unavailable'],
      ['[Matrix] app bot open app=unknown outcome=failed code=matrix_app_bot_unavailable']
    ])
  })

  it('names any app by what the catalog says, with no list of apps of its own', async () => {
    const acme = botAppWire(ACME) as { app: string; app_id: string }

    const w = wrapped(
      async () => {
        throw new Error('matrix_app_bot_syncing')
      },
      id => (id === acme.app_id ? acme.app : undefined)
    )

    await expect(w.run({ kind: 'appChat', appId: acme.app_id })).rejects.toThrow('matrix_app_bot_syncing')
    expect(w.log.mock.calls).toEqual([['[Matrix] app bot open app=acme outcome=failed code=matrix_app_bot_syncing']])
  })

  it('writes one line, not two, for a failure `startAppChat` has already written', async () => {
    const f = await fixture({ ...app, bot: { ...bot, state: 'paused' } })

    const w = logAppChatFailures(async (_event: unknown, _request: Request) => startAppChat(f.port), {
      slug: id => slugs.get(id),
      log: f.log
    })

    await expect(w({}, { kind: 'appChat', appId: app.app_id })).rejects.toThrow('matrix_app_bot_paused')
    expect(f.log.mock.calls).toEqual([['[Matrix] app bot open app=moon outcome=failed code=matrix_app_bot_paused']])
  })

  it('never writes raw error text, for an error or for anything else thrown', async () => {
    for (const thrown of [new Error('M_FORBIDDEN: @owner:test cannot join !old:test'), 'raw string', undefined, 7]) {
      const w = wrapped(async () => {
        throw thrown
      })

      await expect(w.run({ kind: 'appChat', appId: app.app_id })).rejects.toBe(thrown)
      expect(w.log.mock.calls).toEqual([['[Matrix] app bot open app=moon outcome=failed code=matrix_operation_failed']])
    }
  })

  it('writes nothing for a request that is not an app chat, or one that opened', async () => {
    const failing = wrapped(async () => {
      throw new Error('matrix_not_ready')
    })

    await expect(failing.run({ kind: 'appBotStatus', appId: app.app_id })).rejects.toThrow()
    await expect(failing.run({ kind: 'snapshot' })).rejects.toThrow()
    expect(failing.log).not.toHaveBeenCalled()

    const opened = wrapped(async () => '!moon:test')
    await expect(opened.run({ kind: 'appChat', appId: app.app_id })).resolves.toBe('!moon:test')
    expect(opened.log).not.toHaveBeenCalled()
  })

  it('does not let a catalog that cannot answer hide the failure it records', async () => {
    const refusal = new Error('matrix_not_ready')

    const w = wrapped(
      async () => {
        throw refusal
      },
      () => {
        throw new Error('catalog gone')
      }
    )

    await expect(w.run({ kind: 'appChat', appId: app.app_id })).rejects.toBe(refusal)
    expect(w.log.mock.calls).toEqual([['[Matrix] app bot open app=unknown outcome=failed code=matrix_not_ready']])
  })
})

describe('an app this client has no code for', () => {
  /** The real path: the platform's catalog bytes, the strict parse, the workspace, then the open. */
  async function acme(seed = ACME_GUEST, overrides: Record<string, unknown> = {}, bot: Record<string, unknown> = {}) {
    const scope = { accountKey: 'owner', generation: 1 }
    const wire = botAppWire(seed, overrides, bot)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))

    const apps = createMatrixApps({
      account: {
        readDomain: async () => {},
        appScope: () => scope,
        appRequest: async () => ({ profile: 'atum.app-catalog/1', apps: [wire] })
      } as never,
      views: () => ({ revokeApp: async () => {}, revokeAccount: async () => {} }) as never,
      resource: 'https://api.atumplatform.com/api/matrix/v1',
      openExternal: async () => {},
      changed: () => {},
      catalogChanged: async () => {}
    })

    await apps.refresh()

    const command = vi.fn(async (request: { kind: string }): Promise<unknown> =>
      request.kind === 'openAppBotDm'
        ? { roomId: '!acme:test', outcome: 'created', reason: 'first_use', joined: 1, left: 0, pointer: 'written', shown: 'none' }
        : null
    )

    const log = vi.fn<(line: string) => void>()

    // main passes the catalog's slug beside the descriptor, so even a refused open names its app.
    const port = {
      descriptor: () => apps.botChat(seed.appId),
      current: () => true,
      resolveRoom: localAppChatRoom(command),
      slug: seed.slug,
      log
    }

    return { apps, command, log, port }
  }

  it.each([
    ['linked-only', ACME],
    ['guest-enabled', ACME_GUEST]
  ])('opens the chat with a %s bot from the catalog alone, naming the app by slug in main.log', async (_label, seed) => {
    const f = await acme(seed)

    expect(await startAppChat(f.port)).toBe('!acme:test')
    expect(f.command).toHaveBeenCalledExactlyOnceWith({
      kind: 'openAppBotDm',
      appId: seed.appId,
      botUserId: botUserOf(seed)
    })
    expect(f.log.mock.calls).toEqual([
      [expect.stringMatching(/^\[Matrix\] app bot open app=acme outcome=created reason=first_use room=[0-9a-f]{12} /u)]
    ])
    // Opening is not consent, a link or a turn: the bot is still waiting to be agreed to.
    expect(f.apps.botChat(seed.appId).bot?.consent).toBe('required')
    expect(() => f.apps.participant(seed.appId)).toThrow('matrix_app_unavailable')
  })

  it.each([
    ['paused', 'matrix_app_bot_paused', {}],
    ['starting', 'matrix_app_bot_starting', { device: null }],
    ['unavailable', 'matrix_app_bot_resting', {}]
  ] as const)('does not open a %s bot, and says why', async (state, code, extra) => {
    const f = await acme(ACME_GUEST, {}, { state, ...extra })

    await expect(startAppChat(f.port)).rejects.toThrow(code)
    expect(f.command).not.toHaveBeenCalled()
    expect(f.log.mock.calls).toEqual([[`[Matrix] app bot open app=acme outcome=failed code=${code}`]])
  })

  it('refuses an app the catalog calls unavailable, with no chat made', async () => {
    const f = await acme(ACME_GUEST, { availability: 'unavailable' })

    await expect(startAppChat(f.port)).rejects.toThrow('matrix_app_bot_unavailable')
    expect(f.command).not.toHaveBeenCalled()
  })
})

// Which room a chat opens in is decided by one injectable step. Today it is this device's own view
// of its rooms and account (the SDK: `localAppChatRoom`); the platform will name the room first, and
// only that step changes then (see the header of open-chat.ts).
describe('the one step that names the room', () => {
  const hash = (roomId: string) => createHash('sha256').update(roomId).digest('hex').slice(0, 12)

  const opened = (roomId: string, extra: Partial<AppBotDmOpened> = {}): AppBotDmOpened => ({
    roomId,
    outcome: 'created',
    reason: 'first_use',
    joined: 1,
    left: 0,
    pointer: 'written',
    shown: 'none',
    ...extra
  })

  it('opens the room the resolver names, and writes what it says in the one line', async () => {
    const f = await fixture()

    const resolveRoom = vi.fn<ResolveAppChatRoom>(async () =>
      opened('!canonical:test', { outcome: 'recovered', reason: 'pointer', pointer: 'kept', left: 1 })
    )

    expect(await startAppChat({ ...f.port, resolveRoom })).toBe('!canonical:test')
    // It is handed the catalog's app with its bot, once; the module itself never touches the SDK.
    expect(resolveRoom).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ app: 'moon', app_id: app.app_id, bot: expect.objectContaining({ user_id: bot.user_id }) })
    )
    expect(f.command).not.toHaveBeenCalled()
    expect(f.log.mock.calls).toEqual([
      [
        `[Matrix] app bot open app=moon outcome=recovered reason=pointer room=${hash('!canonical:test')} joined=1 left=1 pointer=kept shown=none`
      ]
    ])
  })

  it.each([
    ['paused', { state: 'paused' as const }, 'matrix_app_bot_paused'],
    ['starting', { state: 'starting' as const, device: null }, 'matrix_app_bot_starting'],
    ['resting', { state: 'unavailable' as const }, 'matrix_app_bot_resting'],
    ['unlisted', null, 'matrix_app_bot_unavailable']
  ])('asks no resolver about a bot that is %s', async (_label, change, code) => {
    const f = await fixture()
    const resolveRoom = vi.fn<ResolveAppChatRoom>(async () => opened('!never:test'))
    // The catalog already refuses these in `botChat`; the action does not lean on that.
    const descriptor = () => (change === null ? { ...app, bot: null } : { ...app, bot: { ...bot, ...change } })

    await expect(startAppChat({ ...f.port, descriptor, resolveRoom })).rejects.toThrow(code)
    expect(resolveRoom).not.toHaveBeenCalled()
  })

  it('asks no resolver once the account changed or the app quit', async () => {
    const f = await fixture()
    const resolveRoom = vi.fn<ResolveAppChatRoom>(async () => opened('!never:test'))

    await expect(startAppChat({ ...f.port, current: () => false, resolveRoom })).rejects.toThrow('matrix_not_ready')
    expect(resolveRoom).not.toHaveBeenCalled()
  })

  it('refuses with the resolver’s closed code, and writes no raw text', async () => {
    const f = await fixture()

    await expect(
      startAppChat({
        ...f.port,
        resolveRoom: async () => {
          throw new Error('matrix_app_bot_unavailable')
        }
      })
    ).rejects.toThrow('matrix_app_bot_unavailable')
    expect(f.log.mock.calls).toEqual([['[Matrix] app bot open app=moon outcome=failed code=matrix_app_bot_unavailable']])
    f.log.mockClear()

    await expect(
      startAppChat({
        ...f.port,
        resolveRoom: async () => {
          throw new Error('M_FORBIDDEN: @owner:test cannot join !old:test')
        }
      })
    ).rejects.toThrow()
    expect(f.log.mock.calls).toEqual([['[Matrix] app bot open app=moon outcome=failed code=matrix_operation_failed']])
  })

  it('has the SDK do it today: one openAppBotDm command for the catalog’s app and bot, and nothing else', async () => {
    const f = await fixture()
    const resolve = localAppChatRoom(f.command)

    await expect(resolve({ ...f.apps.botChat(app.app_id), bot })).resolves.toMatchObject({
      roomId: '!moon:test',
      outcome: 'reused'
    })
    expect(f.command).toHaveBeenCalledExactlyOnceWith({
      kind: 'openAppBotDm',
      appId: app.app_id,
      botUserId: bot.user_id
    })

    const none = localAppChatRoom(async () => '!moon:test')
    await expect(none({ ...f.apps.botChat(app.app_id), bot })).rejects.toThrow('matrix_app_bot_dm_invalid')
  })
})
