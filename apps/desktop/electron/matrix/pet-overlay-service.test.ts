import { EventEmitter } from 'node:events'

import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixPetChatInput, MatrixPetView } from '../../shared/matrix-pet'
import { MATRIX_PET_OVERLAY_IPC as IPC } from '../../shared/matrix-pet-overlay'

import { MatrixPetDisplay } from './pet-overlay-preferences'
import {
  type MatrixPetOverlayContext,
  type MatrixPetOverlayPorts,
  MatrixPetOverlayService
} from './pet-overlay-service'

const url = 'file:///app/matrix-pet.html'
const target = { scope: 'account:1', agent: 'agent-a' }

const view: MatrixPetView = {
  freshness: 'current',
  sprite: { enabled: true, spritesheetBase64: 'sprite', scale: 1 },
  selection: {
    owner: 'owner',
    agent: target.agent,
    revision: 1,
    pet: { ref: { kind: 'bundled', slug: 'gigi' }, enabled: true, scale: 1 },
    provenance: 'explicit',
    access: 'owned',
    visitEndsAt: null,
    serverTime: '2026-10-07T00:00:00Z'
  }
}

class WindowDouble extends EventEmitter {
  destroyed = false
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url },
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
  })
  bounds: { x: number; y: number; width: number; height: number }
  constructor(options: BrowserWindowConstructorOptions) {
    super()
    this.bounds = { x: options.x!, y: options.y!, width: options.width!, height: options.height! }
  }
  getBounds() {
    return { ...this.bounds }
  }
  setBounds(value: typeof this.bounds) {
    this.bounds = value
  }
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    this.destroyed = true
    this.emit('closed')
  }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setIgnoreMouseEvents() {}
  setFocusable() {}
  focus() {}
  showInactive() {}
  async loadURL() {}
}

function setup() {
  let context: MatrixPetOverlayContext | undefined = {
    scope: target.scope,
    accountKey: 'account',
    locale: 'en',
    reducedMotion: true,
    snapshot: {
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'MAC' },
      rooms: [],
      messages: [],
      roomId: '!private:test',
      error: null
    }
  }

  let room: string | undefined = '!private:test'
  const handlers = new Map<string, (event: IpcMainInvokeEvent, value?: unknown) => Promise<void>>()
  const windows: WindowDouble[] = []
  const values = new Map<string, string>()

  const ports = {
    context: () => context,
    read: vi.fn(async () => view),
    room: () => room,
    chat: vi.fn<MatrixPetOverlayPorts['chat']>(async (_input: MatrixPetChatInput) => ({
      ok: true as const,
      reply: {
        v: 1 as const,
        reply: 'Mình nghe nè.',
        action: null,
        recent: [
          { role: 'user' as const, text: 'Hello', at: '2026-10-27T02:00:00.000Z' },
          { role: 'pet' as const, text: 'Mình nghe nè.', at: '2026-10-27T02:00:01.000Z' }
        ],
        messages_today: 1,
        daily_cap: 200 as const
      }
    })),
    history: vi.fn<MatrixPetOverlayPorts['history']>(async () => ({
      ok: true as const,
      history: {
        v: 1 as const,
        pet_key: 'bundled:gigi',
        display_name: 'Gigi',
        personality: 'Poised.',
        memory_summary: '',
        recent: [{ role: 'pet' as const, text: 'Earlier.', at: '2026-10-27T01:00:00.000Z' }],
        messages_today: 0,
        daily_cap: 200 as const
      }
    })),
    action: vi.fn(async () => undefined)
  }

  const service = new MatrixPetOverlayService(
    ports,
    new MatrixPetDisplay({
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value)
      }
    }),
    {
      createWindow: options => {
        const window = new WindowDouble(options)
        windows.push(window)

        return window as never
      },
      ipc: {
        handle: (key, callback) => {
          handlers.set(key, callback as never)
        },
        removeHandler: key => {
          handlers.delete(key)
        }
      },
      screen: {
        getAllDisplays: () =>
          [
            { bounds: { x: 0, y: 0, width: 1200, height: 900 }, workArea: { x: 0, y: 24, width: 1200, height: 850 } }
          ] as never,
        getCursorScreenPoint: () => ({ x: 0, y: 0 })
      },
      url,
      preload: '/app/matrix-pet-preload.js',
      signed: true
    }
  )

  const receive = (channel: string, value?: unknown) => {
    const window = windows.at(-1)!

    return handlers.get(channel)!(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame } as never,
      value
    )
  }

  const open = async () => {
    await service.open(target)
    windows.at(-1)!.webContents.emit('did-finish-load')
  }

  return {
    service,
    ports,
    windows,
    handlers,
    receive,
    open,
    swap: () => {
      context = context && { ...context, scope: 'account:2' }
    },
    stop: () => {
      context = undefined
    },
    retire: () => {
      room = undefined
    }
  }
}

let current: ReturnType<typeof setup>
beforeEach(() => {
  vi.useFakeTimers()
  current = setup()
})
afterEach(() => {
  current.service.dispose()
  vi.useRealTimers()
})

describe('native overlay account and pet-scoped chat', () => {
  it('sends only the pet ref and text through companion chat, never a room', async () => {
    await current.open()
    expect(current.ports.read).toHaveBeenCalledWith(target)
    await current.receive(IPC.click)
    await current.receive(IPC.submit, 'Hello')
    expect(current.ports.chat).toHaveBeenCalledOnce()
    const input = current.ports.chat.mock.calls[0]![0]
    expect(input).toMatchObject({ ref: { kind: 'bundled', slug: 'gigi' }, message: 'Hello', locale: 'en' })
    expect(input.message_id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(current.ports.history).toHaveBeenCalledExactlyOnceWith({ kind: 'bundled', slug: 'gigi' })
    const snapshot = current.windows[0]!.webContents.send.mock.calls.at(-1)![1]
    expect(snapshot).not.toHaveProperty('roomId')
    expect(snapshot.recent.at(-1)).toMatchObject({ role: 'pet', text: 'Mình nghe nè.' })
  })

  it('shows the answer to the panel when the reply carries no history (a first chat, or the fallback)', async () => {
    await current.open()
    await current.receive(IPC.click)
    current.ports.chat.mockResolvedValueOnce({
      ok: true,
      reply: { v: 1, reply: 'Gâu! Mình ở đây.', action: null, recent: [], messages_today: 1, daily_cap: 200 }
    })
    await current.receive(IPC.submit, 'Hello')
    const snapshot = current.windows[0]!.webContents.send.mock.calls.at(-1)![1]
    expect(snapshot.recent).toEqual([])
    expect(snapshot.unsaved.map((turn: { role: string; text: string }) => [turn.role, turn.text])).toEqual([
      ['user', 'Hello'],
      ['pet', 'Gâu! Mình ở đây.']
    ])
  })

  it('shows the answer after the history could not load', async () => {
    current.ports.history.mockRejectedValueOnce(new Error('offline'))
    await current.open()
    await current.receive(IPC.click)
    current.ports.chat.mockResolvedValueOnce({
      ok: true,
      reply: { v: 1, reply: 'Mình nghe nè.', action: null, recent: [], messages_today: 1, daily_cap: 200 }
    })
    await current.receive(IPC.submit, 'are you there?')
    const snapshot = current.windows[0]!.webContents.send.mock.calls.at(-1)![1]
    expect(snapshot.unsaved.at(-1)).toMatchObject({ role: 'pet', text: 'Mình nghe nè.' })
  })

  it('keeps no unsaved copy of an answer the history holds', async () => {
    await current.open()
    await current.receive(IPC.click)
    await current.receive(IPC.submit, 'Hello')
    const snapshot = current.windows[0]!.webContents.send.mock.calls.at(-1)![1]
    expect(snapshot.recent.at(-1)).toMatchObject({ role: 'pet', text: 'Mình nghe nè.' })
    expect(snapshot.unsaved).toEqual([])
  })

  it('applies the returned pet action and keeps a typed refusal for the panel', async () => {
    await current.open()
    await current.receive(IPC.click)
    current.ports.chat.mockResolvedValueOnce({
      ok: true,
      reply: {
        v: 1,
        reply: 'Mình ngồi đây.',
        action: { action: 'sit' },
        recent: [{ role: 'pet', text: 'Mình ngồi đây.', at: '2026-10-27T02:00:01.000Z' }],
        messages_today: 2,
        daily_cap: 200
      }
    })
    const apply = vi.spyOn(current.service.windows, 'applyCommand')
    await current.receive(IPC.submit, 'sit')
    expect(apply).toHaveBeenCalledWith(expect.any(String), { action: 'sit' })

    current.ports.chat.mockResolvedValueOnce({ ok: false, code: 'insufficient_protons' })
    await expect(current.receive(IPC.submit, 'hello')).rejects.toThrow('insufficient_protons')
  })

  it('rejects stale scope and absent private agent before any pet read or window creation', async () => {
    await expect(current.service.open({ ...target, scope: 'other' })).rejects.toThrow('unavailable')
    current.retire()
    await expect(current.service.open(target)).rejects.toThrow('unavailable')
    expect(current.ports.read).not.toHaveBeenCalled()
    expect(current.windows).toHaveLength(0)
  })

  it.each(['account switch', 'runtime clear'] as const)('cannot resurrect a late open after %s', async reason => {
    let finish!: (value: MatrixPetView) => void
    current.ports.read.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const opening = current.service.open(target)

    if (reason === 'account switch') {
      current.swap()
    } else {
      current.service.clear()
    }

    finish(view)
    await expect(opening).rejects.toThrow('unavailable')
    expect(current.windows).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fences a pending submit before it can reach the new account', async () => {
    await current.open()
    await current.receive(IPC.click)
    let finish!: (value: Awaited<ReturnType<typeof current.ports.chat>>) => void
    current.ports.chat.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const sending = current.receive(IPC.submit, 'Old account draft')
    current.swap()
    finish({
      ok: true,
      reply: {
        v: 1,
        reply: 'Too late.',
        action: null,
        recent: [],
        messages_today: 1,
        daily_cap: 200
      }
    })
    await expect(sending).rejects.toThrow('matrix_pet_overlay_unavailable')
    current.service.observe()
    expect(current.windows.every(window => window.destroyed)).toBe(true)
  })

  it('closes on a withdrawn agent and never revives a pending refresh after teardown', async () => {
    await current.open()
    let finish!: (value: MatrixPetView) => void
    current.ports.read.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    vi.advanceTimersByTime(15_000)
    current.service.clear()
    finish(view)
    await Promise.resolve()
    expect(current.windows).toHaveLength(1)
    expect(current.windows[0]!.destroyed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await current.open()
    current.retire()
    current.service.observe()
    expect(current.windows.every(window => window.destroyed)).toBe(true)
  })

  it('refuses disabled selection and disposes every native channel on quit', async () => {
    current.ports.read.mockResolvedValueOnce({ ...view, sprite: { ...view.sprite!, enabled: false } })
    await expect(current.open()).rejects.toThrow('unavailable')
    await current.open()
    current.service.dispose()
    expect(current.handlers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await expect(current.service.open(target)).rejects.toThrow('unavailable')
  })
})
