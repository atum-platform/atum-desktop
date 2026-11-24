import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_WORK_IPC } from '../../../shared/matrix-work'
import { workSessionPaths } from '../session/paths'

import { WORK_ACCESS_CHANNEL, WORK_ASSERTION_CHANNEL, WORK_OPEN_PROTONS_CHANNEL, WorkHost } from './host'
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
  const connectAssertion = vi.fn<() => Promise<string>>().mockResolvedValue('signed-assertion')
  const openProtons = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

  const surfaceModeChanged = vi.fn()
  const sidebarChanged = vi.fn()

  const log = vi.fn()

  const host = new WorkHost({
    connectAssertion,
    log,
    surfaceModeChanged,
    sidebarChanged,
    resources: '/bundled',
    account: () => account,
    openProtons,
    readAccess: async () => 'unavailable',
    gatewayEnvironment: () => ({}),
    revokeCredentials: () => undefined
  })

  host.registerOwnerPreload()

  return { host, log, openProtons, sidebarChanged, surfaceModeChanged, connectAssertion }
}

function sender() {
  return Object.assign(new EventEmitter(), { isDestroyed: () => false, setBackgroundThrottling: vi.fn() }) as unknown as WebContents
}

describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('Work owner preload', () => {
  it('fetches a fresh assertion only for the current owner frame and discards late replies', async () => {
    const { host, connectAssertion } = lab()
    const incarnation = await host.start({ continuation: false })
    const contents = sender()
    host.bindOwnerView(incarnation, contents)
    const event = { sender: contents, senderFrame: { parent: null, detached: false, url: incarnation.origin + '/' } } as unknown as IpcMainInvokeEvent
    const read = handlers.get(WORK_ASSERTION_CHANNEL)!
    await expect(read({ ...event, sender: sender() })).rejects.toThrow('work_unavailable')
    await expect(read({ ...event, senderFrame: { ...event.senderFrame, parent: {} } } as IpcMainInvokeEvent)).rejects.toThrow('work_unavailable')
    expect(connectAssertion).not.toHaveBeenCalled()
    await expect(read(event)).resolves.toBe('signed-assertion')
    await expect(read(event)).resolves.toBe('signed-assertion')
    expect(connectAssertion).toHaveBeenCalledTimes(2)
    let finish!: (assertion: string) => void
    connectAssertion.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = read(event)
    await host.stop()
    finish('old-owner-assertion')
    await expect(pending).rejects.toThrow('work_unavailable')
  })
  beforeEach(() => {
    handlers.clear()
    starts.mockClear()
  })

  it('accepts only fixed startup phases from the owner and reports each once', async () => {
    const { host, log } = lab()
    const incarnation = await host.start({ continuation: false })
    const contents = sender()
    host.bindOwnerView(incarnation, contents)
    const event = { sender: contents, senderFrame: { parent: null, detached: false, url: incarnation.origin + '/' } } as unknown as IpcMainInvokeEvent
    const report = handlers.get('atum:work:startup-phase')! as (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>
    await report({ ...event, sender: sender() }, 'ws-connected')
    await report(event, 'token=private')
    expect(log).not.toHaveBeenCalled()
    await report(event, 'ws-connected')
    await report(event, 'ws-connected')
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('ws-connected', expect.any(Number))
    await report(event, 'threads-painted')
    expect(contents.setBackgroundThrottling).toHaveBeenCalledWith(true)
    expect(log).toHaveBeenCalledTimes(2)
    await host.stop()
    await report(event, 'providers-ready')
    expect(log).toHaveBeenCalledTimes(2)
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

  it('keeps mode and thread-list reports inside the bound owner account and validates snapshots', async () => {
    const { host, sidebarChanged, surfaceModeChanged } = lab()
    const incarnation = await host.start({ continuation: false })
    const contents = sender()
    host.bindOwnerView(incarnation, contents)
    const invoke = handlers.get(MATRIX_WORK_IPC.surfaceModeChanged)! as (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>
    const event = { sender: contents, senderFrame: { parent: null, detached: false, url: incarnation.origin + '/' } } as unknown as IpcMainInvokeEvent
    const snapshot = { projectId: 'project-a', mode: 'work' }
    await invoke({ ...event, sender: sender() }, snapshot)
    expect(surfaceModeChanged).not.toHaveBeenCalled()
    await invoke(event, snapshot)
    expect(surfaceModeChanged).toHaveBeenLastCalledWith(snapshot)
    await invoke(event, { ...snapshot, mode: 'invalid' })
    expect(surfaceModeChanged).toHaveBeenLastCalledWith(null)

    const report = handlers.get(MATRIX_WORK_IPC.sidebarChanged)! as (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>
    await report({ ...event, sender: sender() }, { open: true, edge: 300 })
    expect(host.sidebar()).toBeNull()
    await report(event, { open: true, edge: 300.4 })
    expect(sidebarChanged).toHaveBeenLastCalledWith({ open: true, edge: 300 })
    expect(host.sidebar()).toEqual({ open: true, edge: 300 })
    await report(event, { open: true, edge: Number.NaN })
    expect(host.sidebar()).toEqual({ open: true, edge: 300 })
    await host.stop()
    expect(sidebarChanged).toHaveBeenLastCalledWith(null)
    expect(host.sidebar()).toBeNull()
    surfaceModeChanged.mockClear()
    await invoke(event, snapshot)
    expect(surfaceModeChanged).not.toHaveBeenCalled()
    expect(await host.getSurfaceMode()).toBeNull()
    await expect(host.setSurfaceMode('project-a', 'code')).rejects.toThrow('work_unavailable')
  })

  it('gives the owner view keyboard focus before New thread runs in it', async () => {
    const { host } = lab()
    const incarnation = await host.start({ continuation: false })
    const order: string[] = []

    const contents = Object.assign(sender(), {
      focus: vi.fn(() => order.push('focus')),
      executeJavaScript: vi.fn(async () => (order.push('run'), true))
    }) as unknown as WebContents

    host.bindOwnerView(incarnation, contents)

    expect(await host.runCommand('chat.new')).toBe(true)
    expect(order).toEqual(['focus', 'run'])
    expect(await host.runCommand('sidebar.toggle')).toBe(true)
    expect(order).toEqual(['focus', 'run', 'run'])
    await host.stop()
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
      environment: { T3CODE_HOME: '/account-fixture/work/server' }
    })
    await target.stop()
    await target.start({ continuation: false })

    expect(starts.mock.calls).toEqual([['/bundled'], ['/target'], ['/target']])
    expect([...handlers.keys()]).toEqual([WORK_ASSERTION_CHANNEL, 'atum:work:startup-phase', MATRIX_WORK_IPC.surfaceModeChanged, MATRIX_WORK_IPC.sidebarChanged, WORK_ACCESS_CHANNEL, WORK_OPEN_PROTONS_CHANNEL])
  })
})

describe('Work off marker', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { force: true, recursive: true })
    }
  })

  function hostFor(root: string | undefined) {
    return new WorkHost({
      resources: '/bundled',
      account: () => (root ? { key: 'owner', generation: 1, root } : undefined),
      openProtons: async () => undefined,
      readAccess: async () => 'unavailable',
      gatewayEnvironment: () => ({}),
      revokeCredentials: () => undefined
    })
  }

  it('reads the owner\'s switch: on by default, off after setEnabled(false), on again after setEnabled(true)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wh-'))
    roots.push(root)
    const host = hostFor(root)

    expect(host.enabled()).toBe(true)
    await host.setEnabled(false)
    expect(host.enabled()).toBe(false)
    await host.setEnabled(true)
    expect(host.enabled()).toBe(true)
  })

  it('is off with no signed-in account', () => {
    expect(hostFor(undefined).enabled()).toBe(false)
  })
})
