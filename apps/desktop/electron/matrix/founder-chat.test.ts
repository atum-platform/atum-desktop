import { describe, expect, it, vi } from 'vitest'

import type { MatrixUiBridge } from '../../shared/matrix'
import type { MatrixFounderSdkCommand, MatrixOfficialAccounts } from '../../shared/matrix-founder'

import {
  createMatrixFounderChat,
  FOUNDER_CHAT_WAITING_RETRIES,
  handleMatrixFounderContact,
  matrixFounderView
} from './founder-chat'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener }
}))

const OWNER = '@owner:atumplatform.com'
const FOUNDER = '@synthetic-user-0017:atumplatform.com'

/** A world main would see: the platform's founder and the person's SDK host. */
function world(options: { founder?: string | null } = {}) {
  const state: {
    founder: string | null | undefined
    host: { token: object; ready: boolean }
    answer: unknown
  } = {
    founder: 'founder' in options ? options.founder : FOUNDER,
    host: { token: {}, ready: true },
    answer: { state: 'ready', roomId: '!founder:atumplatform.com' }
  }

  const commands: Array<{ token: object; command: MatrixFounderSdkCommand }> = []
  const selected: string[] = []

  const chat = createMatrixFounderChat({
    founder: () => state.founder,
    host: () => state.host,
    command: async (token, command) => {
      commands.push({ token, command })

      return state.answer
    },
    select: async (_token, roomId) => {
      selected.push(roomId)
    }
  })

  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

  return { state, chat, commands, selected, settle }
}

describe("main's Founder chat", () => {
  it('stays dark while the platform names no founder, or cannot be read', async () => {
    const unknown = world({ founder: undefined })
    unknown.chat.reconcile()
    await unknown.settle()
    expect(unknown.commands).toEqual([])

    const none = world({ founder: null })
    none.chat.reconcile()
    await none.settle()
    expect(none.commands).toEqual([])
  })

  it('waits for a ready host, then tells it who the founder is', async () => {
    const f = world()
    f.state.host = { ...f.state.host, ready: false }
    f.chat.reconcile()
    await f.settle()
    expect(f.commands).toEqual([])

    f.state.host = { ...f.state.host, ready: true }
    f.chat.reconcile()
    await f.settle()
    expect(f.commands.map(each => each.command)).toEqual([{ kind: 'founderChat', founder: FOUNDER, create: 'none' }])
  })

  it('never makes a chat on its own, and tells each host once', async () => {
    const f = world()

    for (let index = 0; index < 5; index += 1) {
      f.chat.reconcile()
    }

    await f.settle()
    f.chat.reconcile()
    await f.settle()

    // The host only learns the founder (trust, official marks, founder mode): no chat is made
    // when the platform is read, and there is no automatic creation to ask for at all.
    expect(f.commands.map(each => each.command)).toEqual([{ kind: 'founderChat', founder: FOUNDER, create: 'none' }])
    expect(f.selected).toEqual([])
  })

  it('queues no duplicate command while one is in flight', async () => {
    const f = world()
    let answer!: (value: unknown) => void
    f.state.answer = new Promise(resolve => (answer = resolve))

    f.chat.reconcile()
    f.chat.reconcile()
    expect(f.commands.map(each => each.command.create)).toEqual(['none'])

    answer({ state: 'declined' })
    await f.settle()
    await f.settle()
    expect(f.commands.map(each => each.command.create)).toEqual(['none'])
  })

  it('tells a restarted host again, and a new founder, but never repeats itself', async () => {
    const f = world()
    f.chat.reconcile()
    await f.settle()
    const first = f.commands[0]!.token

    f.state.host = { ...f.state.host, token: {} }
    f.chat.reconcile()
    await f.settle()
    f.state.founder = '@synthetic-user-0024:atumplatform.com'
    f.chat.reconcile()
    await f.settle()
    f.chat.reconcile()
    await f.settle()

    expect(f.commands).toHaveLength(3)
    expect(f.commands[1]!.token).not.toBe(first)
    expect(f.commands[2]!.command.founder).toBe('@synthetic-user-0024:atumplatform.com')

    // The platform withdraws its founder (the kill switch): the same host is told, once.
    f.state.founder = null
    f.chat.reconcile()
    await f.settle()
    f.chat.reconcile()
    await f.settle()
    expect(f.commands.slice(3).map(each => each.command)).toEqual([
      { kind: 'founderChat', founder: null, create: 'none' }
    ])
  })

  it('retries a waiting chat at the next read or reconnect, a bounded number of times', async () => {
    const f = world()
    f.state.answer = { state: 'waiting', reason: 'founder_not_ready' }
    f.chat.reconcile()
    await f.settle()
    expect(f.commands).toHaveLength(1)

    // Nothing new happened: no retry.
    f.chat.reconcile()
    await f.settle()
    expect(f.commands).toHaveLength(1)

    f.chat.refreshed()
    await f.settle()
    expect(f.commands).toHaveLength(2)

    // The host went offline and came back.
    f.state.host = { ...f.state.host, ready: false }
    f.chat.reconcile()
    f.state.host = { ...f.state.host, ready: true }
    f.chat.reconcile()
    await f.settle()
    expect(f.commands).toHaveLength(3)

    for (let index = 0; index < FOUNDER_CHAT_WAITING_RETRIES + 2; index += 1) {
      f.chat.refreshed()
      await f.settle()
    }

    expect(f.commands).toHaveLength(FOUNDER_CHAT_WAITING_RETRIES)
  })

  it('opens the chat for Contact us: made at the person request, then selected', async () => {
    const f = world()

    await expect(f.chat.contact()).resolves.toEqual({ roomId: '!founder:atumplatform.com' })
    expect(f.commands.map(each => each.command)).toEqual([
      { kind: 'founderChat', founder: FOUNDER, create: 'explicit' }
    ])
    expect(f.selected).toEqual(['!founder:atumplatform.com'])
  })

  it('honors the person\'s own first message whatever the roster presentation', async () => {
    const f = world()

    await expect(f.chat.contact()).resolves.toEqual({ roomId: '!founder:atumplatform.com' })
    expect(f.commands.map(each => each.command)).toEqual([
      { kind: 'founderChat', founder: FOUNDER, create: 'explicit' }
    ])
    expect(f.selected).toEqual(['!founder:atumplatform.com'])
  })

  it('has nothing to open without a founder, a ready host or a made chat (the window offers email)', async () => {
    await expect(world({ founder: null }).chat.contact()).resolves.toEqual({ unavailable: true })
    await expect(world({ founder: undefined }).chat.contact()).resolves.toEqual({ unavailable: true })

    const offline = world()
    offline.state.host = { ...offline.state.host, ready: false }
    await expect(offline.chat.contact()).resolves.toEqual({ unavailable: true })

    for (const answer of [
      { state: 'waiting', reason: 'founder_not_ready' },
      { state: 'founder_mode' },
      { state: 'declined' },
      { state: 'ready', roomId: 'not-a-room' },
      'garbage'
    ]) {
      const f = world()
      f.state.answer = answer
      await expect(f.chat.contact()).resolves.toEqual({ unavailable: true })
      expect(f.selected).toEqual([])
    }

    const failing = createMatrixFounderChat({
      founder: () => FOUNDER,
      host: () => ({ token: {}, ready: true, marker: { state: 'absent' } }),
      command: async () => {
        throw new Error('matrix_sdk_stopped')
      },
      select: async () => {}
    })

    await expect(failing.contact()).resolves.toEqual({ unavailable: true })
  })

  it('answers only the Matrix window', async () => {
    const ui = { mainFrame: { url: 'app://matrix/' } }
    const event = { sender: ui, senderFrame: ui.mainFrame }
    const contact = vi.fn(async () => ({ roomId: '!founder:atumplatform.com' }))

    await expect(
      handleMatrixFounderContact({ event, ui, uiUrl: 'app://matrix/', closing: false, contact } as never)
    ).resolves.toEqual({ roomId: '!founder:atumplatform.com' })
    await expect(
      handleMatrixFounderContact({
        event: { sender: {}, senderFrame: {} },
        ui,
        uiUrl: 'app://matrix/',
        closing: false,
        contact
      } as never)
    ).rejects.toThrow('matrix_ipc_denied')
    await expect(
      handleMatrixFounderContact({ event, ui, uiUrl: 'app://matrix/', closing: true, contact } as never)
    ).resolves.toEqual({ unavailable: true })
    await expect(
      handleMatrixFounderContact({
        event,
        ui,
        uiUrl: 'app://matrix/',
        closing: false,
        contact: () => undefined
      } as never)
    ).resolves.toEqual({ unavailable: true })
    expect(contact).toHaveBeenCalledTimes(1)
  })
})

describe('the founder the window sees', () => {
  const official: MatrixOfficialAccounts = {
    founder: { userId: FOUNDER },
    accounts: [{ userId: FOUNDER, tier: 'official', role: 'founder', handle: 'founder' }]
  }

  it('is always official, with the room only when the record names this founder', () => {
    expect(matrixFounderView(official, { state: 'absent' }, OWNER)).toEqual({
      userId: FOUNDER,
      verification: 'official',
      handle: 'founder',
      rosterDefault: true,
      rosterOrder: 0,
      rosterState: 'available',
      offer: true
    })
    expect(
      matrixFounderView(official, { state: 'present', founder: FOUNDER, roomId: '!chat:atumplatform.com' }, OWNER)
    ).toEqual({
      userId: FOUNDER,
      verification: 'official',
      handle: 'founder',
      rosterDefault: true,
      rosterOrder: 0,
      rosterState: 'available',
      roomId: '!chat:atumplatform.com'
    })
    // A record about an earlier founder, or one this build cannot read, lends no room.
    expect(
      matrixFounderView(
        official,
        {
          state: 'present',
          founder: '@user-old:atumplatform.com',
          roomId: '!old:atumplatform.com'
        },
        OWNER
      )
    ).not.toHaveProperty('roomId')
    expect(matrixFounderView(official, { state: 'present', founder: '', roomId: '' }, OWNER)).not.toHaveProperty(
      'roomId'
    )
  })

  it('offers a local draft until a chat exists, and never on the founder account', () => {
    expect(matrixFounderView(official, { state: 'absent' }, OWNER)).toMatchObject({ offer: true })
    // No identity yet, the founder's own account, or a platform that no longer suggests it.
    expect(matrixFounderView(official, { state: 'absent' })).not.toHaveProperty('offer')
    expect(matrixFounderView(official, { state: 'absent' }, FOUNDER)).not.toHaveProperty('offer')
    expect(matrixFounderView(official, { state: 'unknown' }, OWNER)).not.toHaveProperty('offer')
    expect(
      matrixFounderView(official, { state: 'present', founder: FOUNDER, roomId: '!chat:atumplatform.com' }, OWNER)
    ).not.toHaveProperty('offer')

    const off: MatrixOfficialAccounts = {
      founder: { userId: FOUNDER },
      accounts: [{ userId: FOUNDER, tier: 'official', role: 'founder', rosterDefault: false }]
    }

    const soon: MatrixOfficialAccounts = {
      founder: { userId: FOUNDER },
      accounts: [{ userId: FOUNDER, tier: 'official', role: 'founder', rosterState: 'coming_soon' }]
    }

    expect(matrixFounderView(off, { state: 'absent' }, OWNER)).not.toHaveProperty('offer')
    expect(matrixFounderView(soon, { state: 'absent' }, OWNER)).not.toHaveProperty('offer')
  })

  it('keeps an existing human DM verified and usable when the server default is off or coming soon', () => {
    const off: MatrixOfficialAccounts = {
      founder: { userId: FOUNDER },
      accounts: [
        {
          userId: FOUNDER,
          tier: 'official',
          role: 'founder',
          handle: 'founder',
          rosterDefault: false,
          rosterOrder: 4,
          rosterState: 'coming_soon'
        }
      ]
    }

    expect(
      matrixFounderView(
        off,
        {
          state: 'present',
          founder: FOUNDER,
          roomId: '!human:atumplatform.com'
        },
        OWNER
      )
    ).toEqual({
      userId: FOUNDER,
      verification: 'official',
      handle: 'founder',
      rosterDefault: false,
      rosterOrder: 4,
      rosterState: 'coming_soon',
      roomId: '!human:atumplatform.com'
    })
    // An absent legacy row projects the old default, not a hidden one.
    expect(matrixFounderView(official, { state: 'absent' }, OWNER)).toMatchObject({
      rosterDefault: true,
      rosterOrder: 0,
      rosterState: 'available'
    })
  })

  it('is absent when the platform names none or cannot be read', () => {
    expect(matrixFounderView(undefined, { state: 'absent' }, OWNER)).toBeUndefined()
    expect(matrixFounderView({ founder: null, accounts: [] }, undefined, OWNER)).toBeUndefined()
  })
})

describe('the window bridge', () => {
  it('exposes Contact us as one fixed request that takes nothing from the window', async () => {
    await import('./ui-preload')
    const bridge = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'atumMatrix')?.[1] as MatrixUiBridge
    const founder = bridge.founder!

    expect(Object.keys(founder)).toEqual(['contact'])
    electron.invoke.mockResolvedValueOnce({ unavailable: true })
    await expect(founder.contact()).resolves.toEqual({ unavailable: true })
    expect(electron.invoke).toHaveBeenLastCalledWith('matrix:ui', { kind: 'founder-contact' })
  })
})
