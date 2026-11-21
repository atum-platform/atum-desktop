import { EventEmitter } from 'node:events'

import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workSessionPaths } from '../session/paths'

import { WORK_ACCESS_CHANNEL, WORK_OPEN_PROTONS_CHANNEL, WorkHost } from './host'
import type * as WorkProcess from './process'

const { handlers, starts } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent) => Promise<unknown>>(),
  starts: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent) => Promise<unknown>) => {
      if (handlers.has(channel)) {
        throw new Error('duplicate channel')
      }

      handlers.set(channel, handler)
    }
  }
}))

vi.mock('./process', async importOriginal => {
  const original = await importOriginal<typeof WorkProcess>()

  return {
    ...original,
    WorkSidecar: class {
      private live = false

      constructor(private options: { resources: string }) {}

      private incarnation = {
        origin: 'http://127.0.0.1:12345',
        exited: new Promise<void>(() => {})
      }

      current() {
        return this.live ? this.incarnation : undefined
      }

      async start() {
        starts(this.options.resources)
        this.live = true

        return this.incarnation
      }

      async stop() {
        this.live = false
      }
    }
  }
})

const account = { key: 'owner', generation: 1, root: '/account-fixture' }

function lab() {
  const openProtons = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

  const host = new WorkHost({
    resources: '/bundled',
    account: () => account,
    openProtons,
    accessState: async () => ({ state: 'unavailable' }),
    gatewayEnvironment: () => ({}),
    revokeCredentials: () => undefined
  })

  host.registerOwnerPreload()

  return { host, openProtons }
}

function sender() {
  return Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents
}

describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('Work owner preload', () => {
  beforeEach(() => {
    handlers.clear()
    starts.mockClear()
  })

  it('only opens top-up for the current bound top-level Work origin', async () => {
    const { host, openProtons } = lab()
    const incarnation = await host.start({ continuation: false })
    const contents = sender()
    host.bindOwnerView(incarnation, contents)
    const invoke = handlers.get(WORK_OPEN_PROTONS_CHANNEL)!
    const frame = { parent: null, detached: false, url: incarnation.origin + '/' }
    const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent

    expect(await invoke(event)).toBe(true)
    expect(await invoke({ ...event, sender: sender() })).toBe(false)

    frame.url = 'https://example.test'
    expect(await invoke(event)).toBe(false)
    frame.url = incarnation.origin + '/'
    frame.detached = true
    expect(await invoke(event)).toBe(false)
    frame.detached = false

    expect(await invoke({
      ...event,
      senderFrame: { ...frame, parent: {} } as unknown as IpcMainInvokeEvent['senderFrame']
    })).toBe(false)
    await host.stop()
    expect(await invoke(event)).toBe(false)
    expect(openProtons).toHaveBeenCalledOnce()
  })

  it('selects resources for each pin while keeping a single owner IPC registration', async () => {
    const { host } = lab()
    const packaged = host.forResources('/bundled')
    const target = host.forResources('/target')
    await packaged.start({ continuation: false })
    await expect(target.start({ continuation: false })).rejects.toThrow('work_pin_teardown_required')
    await packaged.stop()
    const started = await target.start({ continuation: false })

    expect(host.current()).toBe(started)
    expect(target.current()).toBe(started)
    expect(packaged.current()).toBeUndefined()
    expect(host.authTools(workSessionPaths(account))).toMatchObject({
      executable: '/target/work-runtime/t3',
      environment: { HOME: '/account-fixture/work/environment', T3CODE_HOME: '/account-fixture/work/server' }
    })
    await target.stop()
    await target.start({ continuation: false })

    expect(starts.mock.calls).toEqual([['/bundled'], ['/target'], ['/target']])
    expect([...handlers.keys()]).toEqual([WORK_ACCESS_CHANNEL, WORK_OPEN_PROTONS_CHANNEL])
  })
})
